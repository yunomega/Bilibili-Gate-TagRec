import { EApiType } from '$enums'
import {
  runTagRecFilter,
  runTagRecScoreStage,
  type TagRecDiversityGuardSettings,
  type TagRecFilterCore,
  type TagRecScopeResolve,
} from '../model/filter-engine'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagRecDeferredCandidates } from './deferred-candidates'

/** 交付前更新未展示库存；已看阶段不重跑，分隔符保留，筛选和排序采用同一当前配置。 */
export function refilterTagRecStock(
  queue: RecItemTypeOrSeparator[],
  core: TagRecFilterCore,
  resolve: TagRecScopeResolve,
  opts: {
    pools?: ReadonlyMap<number, ReadonlySet<string>>
    queryMatches?: (item: TagRecItemExtend) => boolean
    diversityGuard?: TagRecDiversityGuardSettings
    sliceSize?: number
    candidates?: TagRecDeferredCandidates
    recover?: (items: TagRecItemExtend[]) => TagRecItemExtend[]
    /** 小池降级的「相关兜底放行」: 透传过滤 ctx (见 TagRecFilterCtx.relatedFallback) */
    relatedFallback?: boolean
  } = {},
) {
  // A failed pass must remain retryable; clear the marker only after commit.
  if (opts.candidates) opts.candidates.needsRefilter = true
  const queued = queue.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
  // 队列货不再整批灌入有界候补表: 5000 深库存反复装入 2000 容量再逐条淘汰是实测热点 —
  //   候补表只收「本轮新被滤出」的条目 (留料语义不变); mergeQueued 标脏的归因同步照原通道收编
  opts.candidates?.absorbRetouched()
  const byBvid = new Map(opts.candidates?.values().map((item) => [item.bvid, item]))
  for (const item of queued) byBvid.set(item.bvid, item)
  const videos = [...byBvid.values()]
  if (!videos.length) {
    if (opts.candidates) opts.candidates.needsRefilter = false
    return
  }
  const result = runTagRecFilter(videos, {
    resolve,
    pools: opts.pools,
    queryMatches: opts.queryMatches,
    poolSize: videos.length,
    poolItems: videos,
    deferPartitions: true,
    relatedFallback: opts.relatedFallback,
  })
  const filtered = result.items
  const queuedIds = new Set(queued.map((item) => item.bvid))
  const passedSet = new Set(filtered)
  const restored = (opts.recover ?? ((items) => items))(filtered.filter((item) => !queuedIds.has(item.bvid)))
  const passed = [...filtered.filter((item) => queuedIds.has(item.bvid)), ...restored]
  result.stats.seenDropped = filtered.length - passed.length || undefined
  const failed = queued.filter((item) => !passedSet.has(item))
  if (failed.length) opts.candidates?.record(failed)
  else opts.candidates?.flushMerged()
  const keep = new Set(passed)
  const scored = runTagRecScoreStage(passed, core, {
    resolve,
    diversityGuard: opts.diversityGuard,
    sliceSize: opts.sliceSize,
  }).items
  let at = 0
  const updated: RecItemTypeOrSeparator[] = []
  const placed = new Set<string>()
  for (const item of queue) {
    if (item.api !== EApiType.TagRec) updated.push(item)
    else if (keep.has(item) && !placed.has(item.bvid)) {
      placed.add(item.bvid)
      updated.push(scored[at++])
    }
  }
  while (at < scored.length) updated.push(scored[at++])
  queue.splice(0, queue.length, ...updated)
  if (opts.candidates) opts.candidates.needsRefilter = false
  return result.stats
}
