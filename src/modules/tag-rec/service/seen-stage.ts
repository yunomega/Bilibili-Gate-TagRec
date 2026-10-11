import { filterTagRecSeenItems } from '../model/seen'
import { seen } from '../store'
import type { TagRecItemExtend } from '$define'
import type { TagRecFilterRoundStats } from '../model/filter-engine'
import type { TagRecRoundStage } from './_pipeline'

/**
 * [tag-rec] 轮次管线「去已看」阶段 (spec §3.4 / §4.5; 实装归票 08)
 * - bypassSeen 关 => 滤掉 seen-set 命中条目 (已看不再入队)
 * - bypassSeen 开 => 直通 (不删 set, 会话 flag 刷新即丢)
 * - bypass 取值按调用方 scope: 主题推荐读 tagRecFavSession / 标签发掘读 tagRecCustomSession
 * - 黑名单条目渲染前已被过滤管线滤除 => 不计已看, 本阶段不另处理 (§4.5)
 * 纯判定逻辑在 model/seen.ts (filterTagRecSeenItems), 本文件只做 store 绑定
 */
export const tagRecSeenStage = (items: TagRecItemExtend[], bypassSeen: boolean) =>
  filterTagRecSeenItems(items, (bvid) => seen.has(bvid), bypassSeen)

/** 显示已看跳过数，让“滤除 0 条但没有结果”能解释清楚；旁路批沿用过滤阶段的累计账。 */
export function createTagRecSeenStage(
  target: { filterStats: TagRecFilterRoundStats },
  bypassSeen: () => boolean,
): TagRecRoundStage {
  return (items) => {
    const out = tagRecSeenStage(items, bypassSeen())
    target.filterStats.seenDropped = (target.filterStats.seenDropped ?? 0) + items.length - out.length || undefined
    return out
  }
}
