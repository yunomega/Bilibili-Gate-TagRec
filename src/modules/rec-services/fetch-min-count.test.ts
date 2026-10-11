import { describe, expect, it, vi } from 'vitest'
import { EApiType, ETab } from '$enums'
import { refreshForGrid } from './index'
vi.mock('$common', () => ({ appWarn: vi.fn(), baseDebug: { extend: () => vi.fn() } }))
vi.mock('$components/RecGrid/useShortcut', () => ({ getColumnCount: () => 7 }))
vi.mock('$modules/filter', () => ({ filterRecItems: vi.fn((items: unknown[]) => items) }))
vi.mock('$modules/filter/normalize', () => ({ normalizeCardData: (item: { bvid?: string; uniqId?: string }) => item }))
vi.mock('$modules/settings', () => ({ settings: {} }))
vi.mock('./app', () => ({ AppRecService: class {} }))
vi.mock('./pc', () => ({ PcRecService: class {} }))
vi.mock('./dynamic-feed/api/enums', () => ({ DynamicFeedItemHelper: {} }))
vi.mock('./service-map', () => ({ isRecTab: () => false }))

describe('fetchMinCount 零进展护栏 (票 13 同族)', () => {
  it('loadMore 零产出且 hasMore 恒真: 连续两轮零进展即停, 不再零间隔连发拖死主线程', async () => {
    const loadMore = vi.fn(() => Promise.resolve([] as never[]))
    const service = {
      qs: { ps: 20 },
      config: { addOtherTabContents: true },
      hasMore: true,
      loadMore,
    }
    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service } as never)
    expect(items).toEqual([])
    // 首轮 + 两轮零进展 = 3 次后停止 (无护栏时 hasMore 恒真会无限连发, 实机表现为骨架分钟级)
    expect(loadMore).toHaveBeenCalledTimes(3)
  })

  it('正常有货时照常凑满 minCount, 护栏不误伤', async () => {
    let serial = 0
    const loadMore = vi.fn(() =>
      Promise.resolve([
        { api: EApiType.Separator, uniqId: `sep-${serial}` },
        { api: EApiType.Fav, bvid: `BV-${serial}`, uniqId: `uniq-${serial++}` },
      ]),
    )
    const service = {
      qs: { ps: 20 },
      config: { addOtherTabContents: true },
      hasMore: true,
      loadMore,
    }
    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service } as never)
    // 每轮 1 条非分隔符: 凑满 20 需 20 轮, 迭代上限 20 生效但产出已足
    expect(items.filter((item) => (item as { api?: string }).api !== EApiType.Separator).length).toBe(20)
    expect(loadMore.mock.calls.length).toBe(20)
  })
})
