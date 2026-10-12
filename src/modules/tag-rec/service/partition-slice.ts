import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import { fetchVideoPartition, fetchVideoTags, hasCompleteTagIds, type ViewDetailTagItem } from '../api/endpoints'
import { getCachedTagRecPartition } from '../api/partition-cache'
import { fetchTagRecVideoEvidence, getCachedTagRecVideoEvidence, mergeTagRecVideoEvidence } from '../api/video-evidence'
import { getPersistedVideoTags } from '../api/video-tags-store'
import {
  evalTagRecItem,
  TAG_REC_VERIFY_CANDIDATES,
  TAG_REC_VERIFY_MS,
  TAG_REC_VERIFY_REQUESTS,
  tagRecChainKeysOf,
  tagRecPoolsForChain,
  type TagRecFilterCtx,
  type TagRecFilterRoundStats,
  type TagRecScopeResolve,
} from '../model/filter-engine'
import { mergeTagRecPartitionFields } from '../model/partition'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'

export function hasTagRecPartitionRules(
  items: readonly RecItemTypeOrSeparator[],
  resolve: TagRecScopeResolve,
): boolean {
  return items.some(
    (item) =>
      item.api === EApiType.TagRec &&
      tagRecChainKeysOf(item).some((key) =>
        tagRecPoolsForChain(item, key).some((pool) => {
          const eff = resolve(key, pool)
          return (
            !!eff.combination ||
            !!eff.globalExclusions?.length ||
            !!eff.globalExclusionsInvalid ||
            (eff.cfg.enabled && (eff.neg.partitionBlock.length > 0 || !!eff.neg.partitionAllow?.list.length))
          )
        }),
      ),
  )
}

/** 先处理尚未核验的库存；都处理过后再重试待检，不让排序反复推回失败条目。 */
export function tagRecPartitionWorkQueue(
  queue: readonly RecItemTypeOrSeparator[],
  held: { has: (bvid: string) => boolean },
  /**
   * 票 004: 旧语境判定 —— 存货条归因于已被删的条件原子且当前原子全不命中时返回 true。
   *   旧语境条不进入本轮取条分区, 只在"队列里没有能参与取条的货"时随兜底返回
   *   (与 held 同一哲学: 留存货不丢付费页, 但不霸首屏)。
   */
  isStaleContext?: (item: TagRecItemExtend) => boolean,
  /**
   * 票 005: 每轮允许轮转进取条分区的停牌条数 (0 = 旧语义: 只在新货耗尽时重试)。
   *   轮转条排在 fresh 之后 —— 新货优先, 停牌补位, 不吃满整轮核查额度。
   */
  heldRetryQuota = 0,
  /**
   * 票 005: 停牌条是否还有重试资格 (尝试数到上限 => 不再轮转, 停吃补查额度)。
   *   封顶条不进 fresh 也不进 heldRetry —— 停在本函数外的那份账目里等缓存自愈;
   *   只有"队列里完全没有能参与取条的货"的兜底返回才仍带上它 (罕见出口: 证据
   *   后来补齐时 cached-mismatch 自查会先把它放回 fresh, 兜底是最后一层)。
   */
  canRetryHeld?: (bvid: string) => boolean,
): RecItemTypeOrSeparator[] {
  const fresh: RecItemTypeOrSeparator[] = []
  const heldRetry: RecItemTypeOrSeparator[] = []
  for (const item of queue) {
    if (item.api !== EApiType.TagRec) {
      fresh.push(item)
      continue
    }
    if (isStaleContext?.(item)) continue
    if (!held.has(item.bvid)) {
      fresh.push(item)
      continue
    }
    const cached = getCachedTagRecPartition(item.bvid)
    if (
      (cached?.tidv2 !== undefined && cached.tidv2 !== item.tidv2) ||
      (cached?.pid_v2 !== undefined && cached.pid_v2 !== item.pid_v2)
    )
      fresh.push(item)
    else if (canRetryHeld?.(item.bvid) !== false) heldRetry.push(item)
  }
  if (!fresh.length) {
    // 兜底只在"队列里没有能参与取条的货"时触发: 封顶停牌条已被「放弃」,
    //   不随兜底再烧请求 (每次「重试核实」后又白烧一轮 —— 审计发现);
    //   canRetryHeld 缺省 (fav 侧无尝试账) 保持旧语义全量兜底。
    // 旧语境条同样不进兜底 —— 残留会在"鲜货空窗"(删原子后新原子尚未取回) 反复占屏;
    //   队列本体仍留条等翻案: 同 bvid 再到达时 mergeQueued 并集证据 / completeDiscoveryTags
    //   补全 / 原子加回摘帽 —— 纯残留不经过 cached-mismatch 通道 (那只在 held 分支内)。
    const rest = isStaleContext ? queue.filter((item) => item.api !== EApiType.TagRec || !isStaleContext(item)) : queue
    if (canRetryHeld)
      return rest.filter((item) => item.api !== EApiType.TagRec || !held.has(item.bvid) || canRetryHeld(item.bvid))
    return [...rest]
  }
  if (heldRetryQuota > 0) fresh.push(...heldRetry.slice(0, heldRetryQuota))
  return fresh
}

/**
 * 票 005: 停牌账目推进 —— 本轮被暂停且**真核查过**的条目尝试数 +1 (封顶钳在上限)。
 *   `attempted` = 本切片真发过请求的 bvid (checkTagRecPartitionSlice 经 budget 记账回传):
 *   闸挡/skipLookup 根本没查的条目 +0 —— "连扑"只算真烧过请求的轮次, 不冤枉等待位。
 *   返回的是全量当前账目 (rePended 之外仍活着的条目原数携带)。
 */
export function tagRecPartitionHeldNext(
  prev: ReadonlyMap<string, number>,
  rePended: readonly TagRecItemExtend[],
  remaining: ReadonlySet<string>,
  maxAttempts: number,
  attempted: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map<string, number>()
  for (const [bvid, attempts] of prev) if (remaining.has(bvid)) next.set(bvid, attempts)
  for (const item of rePended) {
    if (item.api !== EApiType.TagRec) continue
    const cur = next.get(item.bvid) ?? prev.get(item.bvid) ?? 0
    next.set(item.bvid, attempted.has(item.bvid) ? Math.min(cur + 1, maxAttempts) : cur)
  }
  return next
}

/** 同一次刷新补足、切片补位共用预算，避免外层循环不断重新取得预算。 */
export class TagRecPartitionBudget {
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  /** 去重表: 同 BV 并发/跨 pass 复用同一承诺; 条目留存与「是否付费」无关 (spent 单独记账) */
  private requests = new Map<string, Promise<Awaited<ReturnType<typeof fetchVideoPartition>>>>()
  private evidenceRequests = new Map<string, ReturnType<typeof fetchTagRecVideoEvidence>>()
  private tagRequests = new Map<string, Promise<ViewDetailTagItem[] | undefined>>()
  /** 已实际发出的取数承诺数 —— 三种核验通道共用同一额度 (审计 §1); 持久/会话命中不计 */
  private spent = 0
  private checked = 0
  private onAbort = () => this.controller.abort()

  constructor(
    private signal: AbortSignal,
    private limits = {
      requests: TAG_REC_VERIFY_REQUESTS,
      candidates: TAG_REC_VERIFY_CANDIDATES,
      ms: TAG_REC_VERIFY_MS,
    },
  ) {
    if (signal.aborted) this.controller.abort()
    else signal.addEventListener('abort', this.onAbort, { once: true })
  }

  get exhausted() {
    return (
      this.controller.signal.aborted || this.spent >= this.limits.requests || this.checked >= this.limits.candidates
    )
  }

  countCandidate() {
    this.checked++
  }

  lookup(bvid: string): ReturnType<typeof fetchVideoPartition> {
    const known = getCachedTagRecPartition(bvid)
    if (known?.tidv2 !== undefined) return Promise.resolve(known)
    const shared = this.requests.get(bvid)
    if (shared) return shared
    if (this.exhausted || tagRecBackoff.currentIntervalMs > 0) return Promise.resolve(undefined)
    this.timer ??= setTimeout(this.onAbort, this.limits.ms)
    this.spent++
    const request = fetchVideoPartition(bvid, { signal: this.controller.signal }).catch(() => undefined)
    this.requests.set(bvid, request)
    return request
  }
  lookupEvidence(bvid: string): ReturnType<typeof fetchTagRecVideoEvidence> {
    const known = getCachedTagRecVideoEvidence(bvid)
    if (known) return Promise.resolve(known)
    const shared = this.evidenceRequests.get(bvid)
    if (shared) return shared
    if (this.exhausted || tagRecBackoff.currentIntervalMs > 0) return Promise.resolve(undefined)
    this.timer ??= setTimeout(this.onAbort, this.limits.ms)
    this.spent++
    const request = fetchTagRecVideoEvidence(bvid, this.controller.signal).catch(() => undefined)
    this.evidenceRequests.set(bvid, request)
    return request
  }
  /**
   * 严格标签核查的逐视频 tag 名单拉取 —— 与分区/素材核验共享整次刷新请求预算 (审计 §1):
   *   持久层完整命中免费; 预算耗尽/退避态 => undefined (调用侧按未校验 fail-open)。
   *   同步占位 + spent 记账: 同 BV 并发只发一次, 免费命中不烧额度。
   *   传输层经整包 /view/detail 共享在途 (§8-2): 与分区/证据补查同 BV 在途合一,
   *   严格核查自己付费的那次也把分区字段+简介证据一并入库。
   */
  lookupTags(bvid: string): Promise<ViewDetailTagItem[] | undefined> {
    const shared = this.tagRequests.get(bvid)
    if (shared) return shared
    const request = (async () => {
      // 持久层完整命中免费 —— 不占用整次刷新的请求额度
      const persisted = await getPersistedVideoTags(bvid).catch(() => undefined)
      if (persisted !== undefined && hasCompleteTagIds(persisted)) return persisted
      if (this.exhausted || tagRecBackoff.currentIntervalMs > 0) return undefined
      this.timer ??= setTimeout(this.onAbort, this.limits.ms)
      this.spent++
      return fetchVideoTags(bvid, { signal: this.controller.signal }).catch(() => undefined)
    })()
    this.tagRequests.set(bvid, request)
    return request
  }

  dispose() {
    clearTimeout(this.timer)
    this.signal.removeEventListener('abort', this.onAbort)
  }
  /** 票 005: 本预算生命周期内真发过请求的 bvid (闸挡/缓存命中不进) —— 持账"真尝试"判据 */
  requestedBvids(): Set<string> {
    return new Set([...this.requests.keys(), ...this.evidenceRequests.keys(), ...this.tagRequests.keys()])
  }
}

/** 分区是三态：命中交付，不符滤除，未知留在库存；不占公平调度的交付名额。 */
export async function checkTagRecPartitionSlice(
  items: RecItemTypeOrSeparator[],
  resolve: TagRecScopeResolve,
  budget: TagRecPartitionBudget,
  ctx: TagRecFilterCtx = {},
) {
  const stats: TagRecFilterRoundStats = { dropped: 0, byDim: {}, byScope: {}, degraded: false }
  const requestedBefore = budget.requestedBvids()
  const results = new Map<
    RecItemTypeOrSeparator,
    { item: RecItemTypeOrSeparator; state: 'pass' | 'reject' | 'pending' }
  >()
  const evaluate = (item: TagRecItemExtend) => {
    const context = { ...ctx, poolSize: item.filterPoolSize, poolSizes: item.filterPoolSizes }
    const possible = evalTagRecItem(item, resolve, { ...context, deferPartitions: true })
    if (!possible.pass) return { state: 'reject' as const, drop: possible.drop }
    const confirmed = evalTagRecItem(item, resolve, { ...context, deferPartitions: false, confirmPartitions: true })
    if (confirmed.pass) {
      if (
        tagRecChainKeysOf(item).some((key) =>
          tagRecPoolsForChain(item, key).some((pool) => resolve(key, pool).allowUnverified),
        )
      ) {
        const verified = evalTagRecItem(item, (key, pool) => ({ ...resolve(key, pool), allowUnverified: false }), {
          ...context,
          deferPartitions: false,
          confirmPartitions: true,
        })
        if (!verified.pass && verified.drop?.dim === 'combination') item.combinationUnverified = true
        else delete item.combinationUnverified
        evalTagRecItem(item, resolve, { ...context, deferPartitions: false, confirmPartitions: true })
      } else delete item.combinationUnverified
      return { state: 'pass' as const }
    }
    // 留待下一次核验的库存仍保留潜在允许归属，不能被调度器误当作已拒绝。
    evalTagRecItem(item, resolve, { ...context, deferPartitions: true })
    return { state: 'pending' as const }
  }
  const videos = items.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
  let cursor = 0
  // 两个工人按需取条目，退避或预算截止后不再发起新的补查。
  await Promise.all(
    Array.from({ length: Math.min(2, videos.length) }, async () => {
      while (cursor < videos.length) {
        const original = videos[cursor++]
        let item = mergeTagRecVideoEvidence(
          mergeTagRecPartitionFields(original, getCachedTagRecPartition(original.bvid) ?? {}),
          getCachedTagRecVideoEvidence(original.bvid),
        )
        let verdict = evaluate(item)
        if (verdict.state === 'pending') {
          const cells = tagRecChainKeysOf(item).flatMap((key) =>
            tagRecPoolsForChain(item, key).map((pool) => resolve(key, pool)),
          )
          const combination = cells.some((eff) => !!eff.combination || !!eff.globalExclusions?.length)
          // 交集收窄 (Q9): 相关路由条目在「认领链全为交集」下不逐条补证据 ——
          //   名单补回只能把它从待核实升格 (恰是火力反集中), 兜底放行本就不需要名单
          const skipLookup =
            item.source.via === 'archive-related' && cells.length > 0 && cells.every((eff) => eff.intersection)
          const fields = skipLookup
            ? undefined
            : combination
              ? await budget.lookupEvidence(item.bvid)
              : await budget.lookup(item.bvid)
          if (fields) {
            item = combination ? mergeTagRecVideoEvidence(item, fields) : mergeTagRecPartitionFields(item, fields)
            verdict = evaluate(item)
          }
        }
        const partitionActive = hasTagRecPartitionRules([item], resolve)
        if (partitionActive) budget.countCandidate()
        if (verdict.state === 'reject' && verdict.drop) {
          stats.dropped++
          const { dim, scope } = verdict.drop
          stats.byDim[dim] = (stats.byDim[dim] ?? 0) + 1
          const key = `${dim}@${scope}`
          stats.byScope![key] = (stats.byScope![key] ?? 0) + 1
        }
        results.set(original, { item, state: verdict.state })
      }
    }),
  )
  // 票 005: 本切片**真发过请求**的 bvid (budget 记账差集) —— 持账"真尝试"只算它,
  //   闸挡/skipLookup 的 pending 不计尝试数 (根本没烧请求, 不该吃"连扑"额度)
  const attempted = new Set<string>()
  for (const bvid of budget.requestedBvids()) if (!requestedBefore.has(bvid)) attempted.add(bvid)
  return {
    items: items.flatMap((original) => {
      const result = results.get(original)
      return !result ? [original] : result.state === 'pass' ? [result.item] : []
    }),
    pending: new Map(
      [...results]
        .filter(([, result]) => result.state === 'pending')
        .map(([original, result]) => [original, result.item as TagRecItemExtend]),
    ),
    updated: [...results.values()].map(({ item }) => item as TagRecItemExtend),
    attempted,
    stats,
  }
}
