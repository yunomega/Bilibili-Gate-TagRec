import { describe, expect, it } from 'vitest'
import { ETab } from '$enums'
import {
  addToSeenSet,
  clampSeenCap,
  clearSeenSet,
  DEFAULT_SEEN_CAP,
  filterTagRecSeenItems,
  isTagRecSeenTab,
  SEEN_CAP_MAX,
  SEEN_CAP_MIN,
} from './seen'

describe.concurrent('$modules/tag-rec/model/seen', () => {
  it('.isTagRecSeenTab tab 门控: 仅 TagRecFav/TagRecCustom 计已看', () => {
    expect(isTagRecSeenTab(ETab.TagRecFav)).toBe(true)
    expect(isTagRecSeenTab(ETab.TagRecCustom)).toBe(true)
    expect(isTagRecSeenTab(ETab.AppRecommend)).toBe(false)
    expect(isTagRecSeenTab(ETab.PcRecommend)).toBe(false)
    expect(isTagRecSeenTab(ETab.Fav)).toBe(false)
    expect(isTagRecSeenTab(ETab.History)).toBe(false)
  })

  it('.addToSeenSet 先查重: 重复 bvid 不重复入 + 不刷位置', () => {
    const s = new Set<string>()
    expect(addToSeenSet(s, 'BV1')).toBe(true)
    expect(addToSeenSet(s, 'BV2')).toBe(true)
    expect(addToSeenSet(s, 'BV1')).toBe(false) // 已在集, 拒且不动顺序
    expect(addToSeenSet(s, '')).toBe(false) // 空 bvid 拒
    expect([...s]).toEqual(['BV1', 'BV2'])
  })

  it('.addToSeenSet FIFO 容量: 超限删最旧 (插入序)', () => {
    const s = new Set<string>()
    for (let i = 1; i <= 3; i++) addToSeenSet(s, `BV${i}`, 3)
    addToSeenSet(s, 'BV4', 3) // 超 cap=3 => 删最旧 BV1
    expect([...s]).toEqual(['BV2', 'BV3', 'BV4'])
    addToSeenSet(s, 'BV5', 3)
    expect([...s]).toEqual(['BV3', 'BV4', 'BV5'])
    // 重复 add 不刷新 FIFO 位置: BV4 仍先于 BV5 淘汰
    addToSeenSet(s, 'BV4', 3)
    addToSeenSet(s, 'BV6', 3)
    expect([...s]).toEqual(['BV4', 'BV5', 'BV6']) // BV3 淘汰; BV4 位置未动
  })

  it('.DEFAULT_SEEN_CAP = 2000 (spec §3.3 seenCap 默认)', () => {
    expect(DEFAULT_SEEN_CAP).toBe(2000)
  })

  it('.clampSeenCap (W3-2): 非有限回落默认, 超界压进 [MIN,MAX], 小数取整', () => {
    expect(clampSeenCap(undefined)).toBe(DEFAULT_SEEN_CAP)
    expect(clampSeenCap(NaN)).toBe(DEFAULT_SEEN_CAP)
    expect(clampSeenCap(Infinity)).toBe(DEFAULT_SEEN_CAP)
    expect(clampSeenCap(0)).toBe(SEEN_CAP_MIN)
    expect(clampSeenCap(-5)).toBe(SEEN_CAP_MIN)
    expect(clampSeenCap(1e9)).toBe(SEEN_CAP_MAX)
    expect(clampSeenCap(99.6)).toBe(100)
  })

  it('.addToSeenSet (W3-2): GM 直改 cap=0 不再把刚 add 的删掉, cap<1 按 MIN 生效', () => {
    const s = new Set<string>()
    addToSeenSet(s, 'BV1', 0) // 旧实现 cap=0 => 连新入的 BV1 也被 while 删掉, 已看静默失效
    expect([...s]).toEqual(['BV1'])
    addToSeenSet(s, 'BV2', 0) // cap→1: BV1 淘汰, BV2 在
    expect([...s]).toEqual(['BV2'])
  })

  it('.clearSeenSet 「清空已看」销毁性清空', () => {
    const s = new Set<string>(['BV1', 'BV2'])
    clearSeenSet(s)
    expect(s.size).toBe(0)
  })

  it('.filterTagRecSeenItems bypassSeen 两态: 开=直通(同引用), 关=滤掉命中', () => {
    const seen = new Set(['BV2', 'BV4'])
    const isSeen = (bvid: string) => seen.has(bvid)
    const items = [{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }, { bvid: 'BV4' }]

    // bypassSeen 开 => 直通, 不改数组
    const on = filterTagRecSeenItems(items, isSeen, true)
    expect(on).toBe(items)

    // bypassSeen 关 => seen 命中滤除, 保序
    const off = filterTagRecSeenItems(items, isSeen, false)
    expect(off.map((x) => x.bvid)).toEqual(['BV1', 'BV3'])
    expect(items).toHaveLength(4) // 入参未被原地改
  })
})
