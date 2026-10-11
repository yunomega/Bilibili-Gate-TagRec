import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import { fetchTagTop, fetchVideoTags } from '../api/endpoints'
import { SessionFetchCache } from '../api/session-fetch-cache'
import {
  evalTagRecChain,
  evalTagRecItem,
  tagRecChainKeysOf,
  tagRecPoolScopeKey,
  tagRecPoolsForChain,
  type TagRecFilterCore,
  type TagRecFilterCtx,
  type TagRecFilterRoundStats,
  type TagRecScopeResolve,
} from '../model/filter-engine'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagRecPartitionBudget } from './partition-slice'

/**
 * [tag-rec] 负向校验的两条异步路径 (票 14 决议: 负向成员绑定标签组)
 *
 * 同步两条免费路径在 filter-engine 黑名单维 (all/v2 自报名名单匹配 + 负向池交集):
 *   - all/v2 条目自带 tag 名名单 (ownTagNames), 按名匹配源组负向成员 —— 零请求
 *   - 负向池交集: 本模块会话级维护 tid -> bvid 集合快照 (tag/top 浅池), fetchMore 预热
 *
 * 本模块仅承担严格校验路径: 组开关 negative_strict 开启的源组条目,
 *   出队切片逐条 view/detail/tag 核查 (每上屏视频至多 1 次匿名请求, 会话缓存+弹层共用)
 *   - 退避态 (tagRecBackoff 已 engaged) => 整切片直通不校验 (风控可疑期零新增压力)
 *   - 常态加 STRICT_BUDGET_MS 时间盒, 超时未完成的条目 fail-open 放行
 *   - 单条拉取失败 => fail-open 放行; 未校验条数经 unchecked 回报
 */

const NEG_POOL_DEDUPE_MS = 3_000
/** 票 39: 空负向池 TTL (票面区间 10~30min 取 15min) —— 真空池也沉淀, 截停每轮恒定 1 发滴漏 */
const NEG_POOL_EMPTY_TTL_MS = 15 * 60_000
/**
 * A4-7: 非空负向池 TTL —— 恒沉淀期负向 tag 中途上新的 bvid 永远进不了交集快照;
 *   到期经 ensure 既有路径重探一轮 (1 发/tid 有界), 空集仍走短 TTL 快回填
 */
const NEG_POOL_TTL_MS = 60 * 60_000
const STRICT_BUDGET_MS = 5_000

/**
 * 显式严格标签名单: 仅上屏切片中缺标签的视频补查, 与右键浮窗共享缓存/在途。
 * 补齐后同时复核两侧标签名单及组内负向, 防「仅看补查」绕过屏蔽。
 * 失败/退避/5s 时间盒沿用组内严格校验的放行 + 未校验计数。
 */
export async function dropTagRecStrictTagListHits(
  items: RecItemTypeOrSeparator[],
  core: TagRecFilterCore,
  resolve: TagRecScopeResolve,
  signal?: AbortSignal,
  queryMatches?: TagRecFilterCtx['queryMatches'],
  allowFetch = true,
  /** 整次刷新共享预算 (审计 §1): 传入后严格核查不再每批自立 5s 时间盒,
   *   与分区/素材核验共用同一请求上限; 耗尽 => 剩余条目按未校验 fail-open 放行 */
  budget?: TagRecPartitionBudget,
): Promise<{ items: RecItemTypeOrSeparator[]; stats: TagRecFilterRoundStats; checkedBvids: ReadonlySet<string> }> {
  const stats: TagRecFilterRoundStats = { dropped: 0, byDim: {}, byScope: {}, degraded: false }
  const checkedBvids = new Set<string>()
  if (!core.enabled) return { items, stats, checkedBvids }
  const pools = tagRecNegativePools()
  const videos = items.flatMap((item, at) => {
    if (item.api !== EApiType.TagRec) return []
    let strict = false
    for (const { key, pool } of tagRecChainKeysOf(item).flatMap((key) =>
      tagRecPoolsForChain(item, key).map((pool) => ({ key, pool })),
    )) {
      const eff = resolve(key, pool)
      const needsCheck =
        eff.cfg.enabled &&
        ((eff.neg.strict && eff.neg.tagIds.length > 0) ||
          eff.neg.tagBlock?.some((rule) => rule.strict) ||
          eff.neg.tagAllow?.strict)
      strict ||= !!needsCheck
      if (
        evalTagRecChain(item, eff, {
          poolSize: item.filterPoolSizes?.[tagRecPoolScopeKey(key, pool)] ?? item.filterPoolSize,
          sourcePool: pool,
          negative: { pools },
          onlyTagLists: item.filterPoolSize === undefined,
        }) !== null
      )
        continue
      // 完整允许链无需严格核查时，OR 已确定通过，不为其他组额外请求。
      if (!needsCheck) return []
    }
    return strict ? [{ item, at }] : []
  })
  if (!videos.length) return { items, stats, checkedBvids }
  const pending = videos.filter(
    ({ item }) =>
      item.ownTagIds === undefined &&
      (item.ownTagNames === undefined ||
        tagRecChainKeysOf(item).some((key) =>
          tagRecPoolsForChain(item, key).some((pool) => {
            const eff = resolve(key, pool)
            return eff.neg.strict && eff.neg.tagIds.length > 0
          }),
        )),
  )
  for (const { item } of pending) if (item.bvid) checkedBvids.add(item.bvid)
  const checked = new Map<number, TagRecItemExtend>()
  let unchecked = 0
  const applyTags = (item: TagRecItemExtend, at: number, tags: { tag_id?: number; tag_name?: string }[]) =>
    checked.set(at, {
      ...item,
      ownTagNames: tags.map((t) => t.tag_name).filter((name): name is string => name !== undefined),
      ownTagIds: tags.map((t) => t.tag_id).filter((id): id is number => id !== undefined),
    })
  if (allowFetch && pending.length && !signal?.aborted && tagRecBackoff.currentIntervalMs === 0) {
    if (budget) {
      // 共享整次刷新预算: 上限/时间盒/操作 abort 由 budget 承担; 命中持久层的条目免费
      const requests = new Map<string, ReturnType<TagRecPartitionBudget['lookupTags']>>()
      await Promise.all(
        pending.map(async ({ item, at }) => {
          let request = item.bvid ? requests.get(item.bvid) : undefined
          if (item.bvid && !request) {
            request = budget.lookupTags(item.bvid)
            requests.set(item.bvid, request)
          }
          const tags = await request
          if (tags === undefined) {
            unchecked++
            return
          }
          applyTags(item, at, tags)
        }),
      )
    } else {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), STRICT_BUDGET_MS)
      try {
        const requests = new Map<string, ReturnType<typeof fetchVideoTags>>()
        await Promise.all(
          pending.map(async ({ item, at }) => {
            let request = item.bvid ? requests.get(item.bvid) : undefined
            if (item.bvid && !request) {
              request = fetchVideoTags(item.bvid, { signal: controller.signal }).catch(() => undefined)
              requests.set(item.bvid, request)
            }
            const tags = await request
            if (tags === undefined) {
              unchecked++
              return
            }
            applyTags(item, at, tags)
          }),
        )
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
  } else unchecked = pending.length
  stats.unchecked = unchecked || undefined
  if (signal?.aborted) return { items: [], stats, checkedBvids }

  const checkable = new Set(videos.map(({ at }) => at))
  const out = items.flatMap<RecItemTypeOrSeparator>((item, at) => {
    if (item.api !== EApiType.TagRec || !checkable.has(at)) return [item]
    const video = checked.get(at) ?? item
    const verdict = evalTagRecItem(video, resolve, {
      queryMatches,
      negative: { pools },
      poolSize: video.filterPoolSize,
      poolSizes: video.filterPoolSizes,
      onlyTagLists: video.filterPoolSize === undefined, // 兼容旧切片；正常管线保留真实池深，复核完整链
      confirmPartitions: true,
    })
    if (verdict.pass) return [video]
    const { dim, scope } = verdict.drop!
    stats.dropped++
    stats.byDim[dim] = (stats.byDim[dim] ?? 0) + 1
    const key = `${dim}@${scope}`
    stats.byScope![key] = (stats.byScope![key] ?? 0) + 1
    return []
  })
  return { items: out, stats, checkedBvids }
}

// ———— 负向池 (tid -> bvid 集合, 会话级快照) ————
/** 池条目: 全集带 expiresAt —— 空集 15min (真空池 ≠ 取数失败/reject, 分流记账); 非空集 60min */
type NegPoolEntry = { set: ReadonlySet<string>; expiresAt: number }

const pools = new Map<number, NegPoolEntry>()
const poolFetch = new SessionFetchCache<number, NegPoolEntry>({
  dedupeMs: NEG_POOL_DEDUPE_MS,
  // 票 39: 空集放开入缓存 (条内 emptyUntil 记死期, 读侧过期即弃); 真失败走 reject => failed 态仍 3s 去重
  isCacheable: () => true,
})

/** 过滤维读的负向池快照视图 (fetchMore 预热后直接同步读); 空池条目读时过期即弃 */
export function tagRecNegativePools(): ReadonlyMap<number, ReadonlySet<string>> {
  const now = Date.now()
  const view = new Map<number, ReadonlySet<string>>()
  for (const [tid, e] of pools) {
    if (e.expiresAt <= now) {
      pools.delete(tid) // 过期快照弃 —— ensure 侧会重探
      continue
    }
    view.set(tid, e.set)
  }
  return view
}

/** 预热负向池: 每个负向 tid 一次 tag/top; 已缓存/在途自动去重; 空池 TTL 到期弃快照重探一轮 */
export async function ensureTagRecNegativePools(tids: readonly number[], signal?: AbortSignal): Promise<void> {
  const load = (tid: number) =>
    poolFetch
      .fetch(
        tid,
        async (entrySignal) => {
          // AUDIT-33: 底层取数不绑调用方 signal —— 但绑 entry 自身的取消闸:
          //   最后一个等待者离开时取消排队/在途取数, 共享期间互不传染
          const items = await fetchTagTop(tid, { signal: entrySignal })
          const set = new Set(items.map((i) => i.bvid).filter((b): b is string => !!b))
          const entry: NegPoolEntry = {
            set,
            expiresAt: Date.now() + (set.size ? NEG_POOL_TTL_MS : NEG_POOL_EMPTY_TTL_MS),
          }
          pools.set(tid, entry)
          return entry
        },
        signal, // 只判本 await 方: abort => 拒 AbortError 且不新发请求, 在途共享 fetch 照常落定
      )
      .catch(() => undefined)
  await Promise.all(
    [...new Set(tids)].map(async (tid) => {
      const hit = await load(tid)
      if (hit && hit.expiresAt <= Date.now()) {
        // 快照 TTL 到期 => 弃旧重探 (冷负向池会回填; 取数失败走 reject 不至此)
        poolFetch.invalidate(tid)
        pools.delete(tid)
        await load(tid)
      }
    }),
  )
}

// ———— 严格校验: 出队切片逐条 view/detail/tag (组开关 negative_strict) ————

/**
 * 对切片内需严格校验的条目逐条拉视频 tag 列表, 命中负向 id 即剔除。
 * negativeIdsOf(item): 返回该条目「开了严格校验的源组」负向 id 并集; 空数组 => 本条不校验不发请求。
 * 返回 unchecked = 未能校验放行条数 (拉取失败/退避直通/超时; 供滤除统计旁显示)
 */
export async function dropTagRecStrictNegativeHits(
  items: RecItemTypeOrSeparator[],
  negativeIdsOf: (item: TagRecItemExtend) => readonly number[],
  signal?: AbortSignal,
  checkedBvids?: ReadonlySet<string>,
): Promise<{ items: RecItemTypeOrSeparator[]; dropped: number; unchecked: number }> {
  const videos: { at: number; bvid: string; item: TagRecItemExtend }[] = []
  items.forEach((it, at) => {
    if (it.api === EApiType.TagRec && it.bvid) videos.push({ at, bvid: it.bvid, item: it })
  })
  if (!videos.length) return { items, dropped: 0, unchecked: 0 }

  const checkable = videos
    .filter((v) => v.item.ownTagIds !== undefined || !checkedBvids?.has(v.bvid))
    .map((v) => ({ ...v, negIds: negativeIdsOf(v.item) }))
    .filter((v) => v.negIds.length)
  if (!checkable.length) return { items, dropped: 0, unchecked: 0 }

  // 退避态直通: 风控可疑期不追加请求 (与 fail-open 语义一致)
  if (tagRecBackoff.currentIntervalMs > 0) return { items, dropped: 0, unchecked: checkable.length }

  // 时间盒: 超时中止未完成的拉取 (fail-open), 防 20 条排队卡死 loadMore
  const ctrl = new AbortController()
  const onOuterAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(), STRICT_BUDGET_MS)
  let tagLists: ({ tag_id?: number }[] | undefined)[]
  try {
    tagLists = await Promise.all(
      checkable.map(({ bvid, item }) =>
        item.ownTagIds !== undefined
          ? Promise.resolve(item.ownTagIds.map((tag_id) => ({ tag_id })))
          : fetchVideoTags(bvid, { signal: ctrl.signal }).catch(() => undefined),
      ),
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }

  const dropIdx = new Set<number>()
  let unchecked = 0
  tagLists.forEach((tags, i) => {
    const { at, negIds } = checkable[i]
    if (tags === undefined) {
      unchecked++
      return
    }
    if (tags.some((t) => t.tag_id !== undefined && negIds.includes(t.tag_id))) dropIdx.add(at)
  })
  return {
    items: dropIdx.size ? items.filter((_, i) => !dropIdx.has(i)) : items,
    dropped: dropIdx.size,
    unchecked,
  }
}
