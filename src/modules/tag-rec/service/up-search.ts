import { waitForAbortable } from '../api/abortable-promise'
import { fetchUpSearchPage } from '../api/up-search'
import { normalizeTagTopItem } from '../model/normalize-item'
import { mergeTagRecCandidate } from '../model/relevance'
import {
  applyTagRecStages,
  emptyTagRecRoundResult,
  fetchTagRecRoundSources,
  finishTagRecRound,
  type TagRecRoundResult,
  type TagRecRoundSource,
  type TagRecRoundStages,
  type TagRecTidDryTracker,
} from './_pipeline'
import { planTagRecRecall, tagRecConsumerSource, type TagRecRecallPlan, type UpSearchSource } from './recall-plan'
import type { TagRecItemExtend } from '$define'
import type { TagRecScopeResolve } from '../model/filter-engine'
export { planTagRecRecall, upSearchMids } from './recall-plan'
export type { UpSearchSource } from './recall-plan'

/** 试验切换暂存: UP 分页游标/源登记/剩余页预算/轮转位的值拷贝 (restore 覆盖式回填) */
export type TagRecUpSearchSnapshot = {
  pages: Map<string, { next: number; exhausted: boolean; seen: Set<string> }>
  sources: Map<string, UpSearchSource>
  budget: number
  cursor: number
  active: boolean
}

/** 两个服务分别持有共享分页态；页面缓存与网络节流在 API 层跨服务共用。 */
export class TagRecUpSearchPool {
  static readonly PAGE_BUDGET = 3
  private pages = new Map<string, { next: number; exhausted: boolean; seen: Set<string> }>()
  private sources = new Map<string, UpSearchSource>()
  private budget = TagRecUpSearchPool.PAGE_BUDGET
  private cursor = 0
  private epoch = 0
  private pendingLoad?: Promise<TagRecItemExtend[]>
  active = false
  reset(preserveBudget = false) {
    this.pages.clear()
    this.sources.clear()
    if (!preserveBudget) this.budget = TagRecUpSearchPool.PAGE_BUDGET
    this.cursor = 0
    this.pendingLoad = undefined
    this.epoch++
    this.active = false
  }
  private key(source: UpSearchSource) {
    return JSON.stringify([source.mid, source.keyword])
  }
  hasMore(sources: readonly UpSearchSource[]) {
    for (const source of sources) this.sources.set(this.key(source), source)
    return sources.some((s) => !this.pages.get(this.key(s))?.exhausted)
  }
  sync(sources: readonly UpSearchSource[]) {
    this.sources = new Map(sources.map((source) => [this.key(source), source]))
    this.active = sources.length > 0
  }
  invalidate() {
    this.pendingLoad = undefined
    this.epoch++
  }
  snapshot(): TagRecUpSearchSnapshot {
    return {
      pages: new Map([...this.pages].map(([k, v]) => [k, { ...v, seen: new Set(v.seen) }])),
      sources: new Map(this.sources),
      budget: this.budget,
      cursor: this.cursor,
      active: this.active,
    }
  }
  restore(snap: TagRecUpSearchSnapshot) {
    this.pages = new Map([...snap.pages].map(([k, v]) => [k, { ...v, seen: new Set(v.seen) }]))
    this.sources = new Map(snap.sources)
    this.budget = snap.budget
    this.cursor = snap.cursor
    this.active = snap.active
    this.pendingLoad = undefined
    this.epoch++ // 换语境期间在途 load 落定作废 (与 reset/invalidate 同口径)
  }
  get hasAnyMore() {
    return this.hasMore([...this.sources.values()])
  }
  get pending() {
    return this.active && this.budget <= 0
  }
  continue() {
    this.budget = TagRecUpSearchPool.PAGE_BUDGET
  }
  /** Serialize shared-pool loads; transport dedupe alone cannot protect cursor/budget commits. */
  load(
    sources: readonly UpSearchSource[],
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<TagRecItemExtend[]> {
    const epoch = this.epoch
    const run = () => {
      if (signal?.aborted || epoch !== this.epoch || isCurrent?.() === false) return Promise.resolve([])
      return this.loadNext(sources, signal, isCurrent)
    }
    const task = this.pendingLoad ? this.pendingLoad.then(run, run) : run()
    this.pendingLoad = task
    const clear = () => {
      if (this.pendingLoad === task) this.pendingLoad = undefined
    }
    void task.then(clear, clear)
    return waitForAbortable(task, signal)
  }

  private async loadNext(
    sources: readonly UpSearchSource[],
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<TagRecItemExtend[]> {
    this.hasMore(sources)
    if (!sources.length || !this.budget || signal?.aborted) return []
    this.active = true
    const open = sources.filter((s) => !this.pages.get(this.key(s))?.exhausted)
    if (!open.length) return []
    const source = open[this.cursor++ % open.length]!
    const key = this.key(source)
    const state = this.pages.get(key) ?? { next: 1, exhausted: false, seen: new Set<string>() }
    const epoch = this.epoch
    this.budget--
    let page
    try {
      page = await fetchUpSearchPage(source.mid, source.keyword, state.next, signal)
    } catch (err) {
      if (epoch === this.epoch && !signal?.aborted && isCurrent?.() !== false) this.budget = 0
      throw err
    }
    if (signal?.aborted || epoch !== this.epoch || isCurrent?.() === false) return []
    const fresh = page.items.filter((it) => {
      if (!it.bvid || state.seen.has(it.bvid)) return false
      state.seen.add(it.bvid)
      return true
    })
    state.exhausted = !page.hasMore || !page.items.length || !fresh.length
    state.next++
    this.pages.set(key, state)
    return fresh.map((it, srcRank) => {
      const item = normalizeTagTopItem(it, { groupNames: source.groupNames, groupIds: source.groupIds, srcRank })
      item.fieldEvidence = { ...item.fieldEvidence, desc: it.desc === undefined ? 'missing' : 'partial' }
      item.source.via = 'up-search'
      item.source.queryKeyword = source.keyword
      item.source.claims = source.consumers?.map((c) => ({
        via: 'up-search',
        queryKeyword: source.keyword,
        ...tagRecConsumerSource([c]),
      }))
      return item
    })
  }
}

/** UP 定向页与普通标签池共用过滤/算分，但 UP 页不进入全站兜底选种原料池。 */
export async function runTagRecRecallRound(opts: {
  sources: readonly TagRecRoundSource[]
  resolve: TagRecScopeResolve
  upPool: TagRecUpSearchPool
  dryTids: TagRecTidDryTracker
  seenBvids: Set<string>
  signal?: AbortSignal
  stages?: TagRecRoundStages
  mergeExisting?: (item: TagRecItemExtend) => TagRecItemExtend | undefined
  /** runTagRecRound 透传: 已见 BV 是否仍挂未交付态 (无则归一/合并全省) */
  hasPending?: (bvid: string) => boolean
  plan?: TagRecRecallPlan
  isCurrent?: () => boolean
}): Promise<TagRecRoundResult & { upSources: UpSearchSource[]; hasTagTop: boolean }> {
  const plan = opts.plan ?? planTagRecRecall(opts.sources, opts.resolve)
  const topSources = plan.tagTop.filter((s) => !opts.dryTids.isDry(s.tid))
  const fetched = await fetchTagRecRoundSources(topSources, opts.signal, opts.isCurrent)
  const cancelled = () => opts.signal?.aborted || opts.isCurrent?.() === false
  const empty = () => ({ ...emptyTagRecRoundResult(), upSources: plan.up, hasTagTop: !!plan.tagTop.length })
  if (cancelled()) return empty()
  let upItems: TagRecItemExtend[] = []
  let upFailure: { error: unknown } | undefined
  try {
    upItems = await opts.upPool.load(plan.up, opts.signal, opts.isCurrent)
  } catch (error) {
    upFailure = { error }
  }
  if (cancelled()) return empty()
  const top = finishTagRecRound(
    {
      sources: topSources,
      seenBvids: opts.seenBvids,
      signal: opts.signal,
      stages: { scoreStage: (items) => items },
      mergeExisting: opts.mergeExisting,
      hasPending: opts.hasPending,
      isCurrent: opts.isCurrent,
      commitSeen: false,
    },
    fetched,
  )
  if (upFailure && !top.poolItems.length) throw upFailure.error
  const byBvid = new Map(top.poolItems.map((it) => [it.bvid, it]))
  for (const item of upItems) {
    const existing = byBvid.get(item.bvid)
    if (existing) {
      mergeTagRecCandidate(existing, item)
    } else if (!opts.seenBvids.has(item.bvid)) {
      byBvid.set(item.bvid, item)
    } else {
      const updated = opts.mergeExisting?.(item)
      if (updated) byBvid.set(item.bvid, updated)
    }
  }
  const pool = [...byBvid.values()]
  const items = applyTagRecStages(
    pool,
    { fetchedCount: top.fetchedCount + upItems.length, poolSize: pool.length, poolItems: pool, signal: opts.signal },
    opts.stages,
  )
  if (cancelled()) return empty()
  for (const item of pool) opts.seenBvids.add(item.bvid)
  return {
    ...top,
    items,
    producedCount: items.length,
    fetchedCount: top.fetchedCount + upItems.length,
    upSources: plan.up,
    hasTagTop: !!plan.tagTop.length,
  }
}
