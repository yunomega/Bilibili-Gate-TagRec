import { ETab } from '$enums'

/**
 * [tag-rec] seen-set / bypassSeen 纯逻辑 (spec §3.4 / §4.5; 零依赖叶子模块, 可测)
 * - seen-set = bvid 集合, 只计肉眼可见的展示 (≥50% 进视口), 被拉取/被滤除不计
 * - 容量 FIFO 超限删最旧 (Set 迭代序 = 插入序); 两 tab 共享; 收藏表/黑名单变动不动 set
 * - bypassSeen 开 => 去已看阶段直通 (不删 set); 关 => 滤掉 seen 命中条目
 * - 黑名单条目渲染前已被过滤管线滤除 => 不计已看, 本文件不另处理 (§4.5)
 */

/**
 * seen-set FIFO 容量默认值 (spec §3.3 seenCap=2000)
 * 生效值 = settings.tagRec.seenCap, 由调用侧 (store/index.ts seen.add) 注入 cap 参数, 此处仅兜底
 */
export const DEFAULT_SEEN_CAP = 2000

/**
 * W3-2: seenCap 硬界 —— settings 可由 GM 直改/导入绕过 UI 校验:
 *   超上限 => 每次 add(每卡 ≥50% 进视口)触发 ~15MB 级全量序列化 flush + 跨 tab 广播;
 *   0/负 => while 把刚 add 的也删 = 去已看静默失效
 */
export const SEEN_CAP_MAX = 100_000
export const SEEN_CAP_MIN = 1

/** cap 入参钳制: 非有限数回落默认, 其余压进 [MIN, MAX] 取整 */
export function clampSeenCap(cap: number | undefined): number {
  if (cap === undefined || !Number.isFinite(cap)) return DEFAULT_SEEN_CAP
  return Math.min(SEEN_CAP_MAX, Math.max(SEEN_CAP_MIN, Math.round(cap)))
}

/** Set 兼容接口: proxySet 与原生 Set 均满足, 纯函数可测 */
export type SeenSet = Pick<Set<string>, 'has' | 'add' | 'delete' | 'size' | 'values' | 'clear'>

/** 计已看生效的 tab (spec §4.5): 仅「收藏推荐 / 指定标签」两 tab */
export function isTagRecSeenTab(tab: ETab): boolean {
  return tab === ETab.TagRecFav || tab === ETab.TagRecCustom
}

/** 记入已看: 先查重 (重复 => false); 新入后超 cap => FIFO 删最旧; 返回是否新入 */
export function addToSeenSet(seen: SeenSet, bvid: string, cap: number = DEFAULT_SEEN_CAP): boolean {
  if (!bvid || seen.has(bvid)) return false
  seen.add(bvid)
  const effectiveCap = clampSeenCap(cap) // W3-2: 硬兜 (GM 直改/导入的 cap 无 UI 校验)
  while (seen.size > effectiveCap) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
  return true
}

/** 清空可重建的浏览去重记录，收藏与过滤配置不受影响。 */
export function clearSeenSet(seen: SeenSet) {
  seen.clear()
}

/**
 * 轮次管线「去已看」纯判定 (spec §3.4):
 * bypassSeen 开 => 原样直通 (不删 set); 关 => 滤掉 seen-set 命中条目 (已看不再入队)
 */
export function filterTagRecSeenItems<T extends { bvid: string }>(
  items: T[],
  isSeen: (bvid: string) => boolean,
  bypassSeen: boolean,
): T[] {
  if (bypassSeen) return items
  return items.filter((it) => !it.bvid || !isSeen(it.bvid))
}
