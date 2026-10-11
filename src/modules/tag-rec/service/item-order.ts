import { compareTagRecRelevance, tagRecGroupKey } from '../model/relevance'
import type { TagRecItemExtend } from '$define'

/**
 * 交付档位 (票 001): 首屏按**来源档位**出 —— tag/top → 精确搜索 → 搜索相关 → 推荐相关(相似垫底)。
 *   档位是**外层键**: 先档位, 再相关性, 再质量分 —— 否则高播放的「相似」条会把标签热门挤下首屏。
 *   与 `poolOfVia` (model/filter-engine.ts:363) 同口径维护; 本模块保持叶子, 不 import 它以免成环
 *   (filter-engine → service/_pipeline → 本模块)。
 */
const TIER_BY_VIA: Record<string, number> = {
  'tag-top': 0,
  'all-v2-exact': 1,
  'up-search': 1, // UP 定向搜索同「精确搜索」档
  'all-v2-related': 2,
  'archive-related': 3,
}

export function tagRecDeliveryTierOf(item: TagRecItemExtend): number {
  return TIER_BY_VIA[item.source.via ?? ''] ?? 0 // 未知 via 归 tag/top 档 (poolOfVia 同口径)
}

/** 档位 → 相关性证据 → 质量与源排名。 */
export function compareTagRecItems(a: TagRecItemExtend, b: TagRecItemExtend): number {
  const tierDiff = tagRecDeliveryTierOf(a) - tagRecDeliveryTierOf(b)
  const relevanceDiff = compareTagRecRelevance(a.relevance, b.relevance)
  return tierDiff || relevanceDiff || compareQuality(a, b)
}

function compareQuality(a: TagRecItemExtend, b: TagRecItemExtend, key?: string): number {
  const scoreDiff =
    ((key ? b.qualityByGroup?.[key] : undefined) ?? b.qualitySortScore ?? b.score ?? 0) -
    ((key ? a.qualityByGroup?.[key] : undefined) ?? a.qualitySortScore ?? a.score ?? 0)
  if (scoreDiff) return scoreDiff
  if (a.partial && b.partial) {
    const viewDiff = (b.stat.view ?? 0) - (a.stat.view ?? 0)
    if (viewDiff) return viewDiff
  }
  const rankDiff = (a.srcRank ?? 0) - (b.srcRank ?? 0)
  if (rankDiff) return rankDiff
  return a.bvid < b.bvid ? -1 : a.bvid > b.bvid ? 1 : 0
}

export function compareTagRecGroupItems(id: string, a: TagRecItemExtend, b: TagRecItemExtend): number {
  const key = tagRecGroupKey({ id })
  return (
    tagRecDeliveryTierOf(a) - tagRecDeliveryTierOf(b) ||
    compareTagRecRelevance(a.relevanceByGroup?.[key] ?? a.relevance, b.relevanceByGroup?.[key] ?? b.relevance) ||
    compareQuality(a, b, key)
  )
}
