import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUpSearchPage } from '../api/up-search'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver, runTagRecFilter } from '../model/filter-engine'
import { TagRecTidDryTracker } from './_pipeline'
import { planTagRecRecall, runTagRecRecallRound, TagRecUpSearchPool, type UpSearchSource } from './up-search'
import type { TagGroup, TagL1Group } from '../model/types'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('../api/up-search', () => ({ fetchUpSearchPage: vi.fn() }))
const sources = [
  { tid: 1, keyword: '医生', groupIds: ['A', 'B'], groupNames: ['错位名字', 'B'] },
  { tid: 2, keyword: '护士', groupIds: ['A'], groupNames: ['A'] },
]
function resolver({
  enabled = true,
  groupAllow = [{ mid: 7, name: 'UP7' }],
}: { enabled?: boolean; groupAllow?: { mid?: number; name: string }[] } = {}) {
  const core = createTagRecFactoryFilterCore()
  core.enabled = enabled
  core.dims.likeRate.enabled = false
  core.dims.upAllow = { enabled: true, list: [{ mid: 10, name: '全局' }] }
  const groups: TagGroup[] = [
    {
      id: 'A',
      name: 'A',
      tag_ids: [],
      enabled: true,
      weight: 1,
      addedAt: 0,
      l1Id: 'P',
      overrides: { negative: { upAllow: { enabled: true, list: groupAllow } } },
    },
    { id: 'B', name: 'B', tag_ids: [], enabled: true, weight: 1, addedAt: 0 },
  ]
  const l1s: TagL1Group[] = [
    {
      id: 'P',
      name: '父',
      enabled: true,
      weight: 1,
      addedAt: 0,
      overrides: { negative: { upAllow: { enabled: true, list: [{ mid: 9, name: '父层' }] } } },
    },
  ]
  return createTagRecScopeResolver({
    core,
    groupsById: new Map(groups.map((g) => [g.id, g])),
    l1ById: new Map(l1s.map((g) => [g.id, g])),
  })
}
const upSource: UpSearchSource = { ...sources[1]!, mid: 7, keyword: '护士' }
beforeEach(() => vi.mocked(fetchUpSearchPage).mockReset())

describe('UP 定向召回与普通召回分流', () => {
  it('最近层 UID 生效，按作者与关键词拆分，同源组归因采用稳定编号的实际名字', () => {
    const plan = planTagRecRecall(sources, resolver())
    expect(plan.tagTop).toEqual([])
    expect(plan.up.map((s) => [s.mid, s.keyword, s.groupIds, s.groupNames])).toEqual([
      [7, '医生', ['A'], ['A']],
      [10, '医生', ['B'], ['B']],
      [7, '护士', ['A'], ['A']],
    ])
  })

  it('总开关关闭不定向；只有名字的规则继续原筛选，不猜 UID', () => {
    expect(planTagRecRecall(sources, resolver({ enabled: false })).up).toEqual([])
    const byName = resolver({ groupAllow: [{ name: '同名UP' }] })
    const plan = planTagRecRecall(sources, byName)
    expect(plan.tagTop.map((s) => s.groupIds)).toEqual([['A'], ['A']])
    expect(plan.up[0]?.mid).toBe(10)
  })

  it('关键词合并同 UP 跨组请求；同 MID 的重复条目不增加请求源', () => {
    const plan = planTagRecRecall(
      [sources[0]!],
      resolver({
        groupAllow: [
          { mid: 10, name: '全局' },
          { mid: 10, name: '重复' },
        ],
      }),
    )
    expect(plan.up).toHaveLength(1)
    expect(plan.up[0]?.groupIds).toEqual(['A', 'B'])
  })

  it('定向搜索绕过已干 tag/top 标签，真实作者不匹配时仍被仅看规则挡住', async () => {
    vi.mocked(fetchUpSearchPage).mockResolvedValue({
      items: [{ bvid: 'BV-up', title: '关键词投稿', owner: { mid: 8, name: '合作作者' }, stat: { view: 100 } }],
      hasMore: false,
    })
    const resolve = resolver()
    const dry = new TagRecTidDryTracker()
    dry.note([{ tid: 2, fetched: 0, contributed: 0, ok: true }])
    const result = await runTagRecRecallRound({
      sources: [sources[1]!],
      resolve,
      upPool: new TagRecUpSearchPool(),
      dryTids: dry,
      seenBvids: new Set(),
      stages: { filterStage: (items) => runTagRecFilter(items, { resolve, poolSize: items.length }).items },
    })
    expect(fetchUpSearchPage).toHaveBeenCalledWith(7, '护士', 1, undefined)
    expect(result.items).toEqual([])
    expect(result.sourceStats).toEqual([])
    expect(result.poolItems).toEqual([])
  })
})

describe('有限分页', () => {
  it('每轮一页，自动最多三页，手动继续后沿原游标取下一页', async () => {
    vi.mocked(fetchUpSearchPage).mockImplementation((_mid, _kw, page) =>
      Promise.resolve({ items: [{ bvid: `BV-${page}` }], hasMore: true }),
    )
    const pool = new TagRecUpSearchPool()
    for (let i = 0; i < 4; i++) await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(3)
    expect(pool.pending).toBe(true)
    pool.continue()
    const next = await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenLastCalledWith(7, '护士', 4, undefined)
    expect(next[0]?.source).toMatchObject({ via: 'up-search', queryKeyword: '护士' })
    expect(next[0]?.ownTagNames).toBeUndefined()
    expect(next[0]?.source.tagIds).toBeUndefined()
  })

  it('空页、尾页或忽略页码返回重复视频都停止，不无限翻页', async () => {
    vi.mocked(fetchUpSearchPage).mockResolvedValue({ items: [{ bvid: 'BV-repeat' }], hasMore: true })
    const pool = new TagRecUpSearchPool()
    await pool.load([upSource])
    await pool.load([upSource])
    await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(2)
    expect(pool.hasMore([upSource])).toBe(false)
    const empty = new TagRecUpSearchPool()
    vi.mocked(fetchUpSearchPage).mockResolvedValue({ items: [], hasMore: false })
    await empty.load([upSource])
    await empty.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(3)
  })

  it('查询切换后的在途结果不推进新查询游标，也不消耗新预算', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof fetchUpSearchPage>>>()
    vi.mocked(fetchUpSearchPage)
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue({ items: [{ bvid: 'BV-new' }], hasMore: true })
    const pool = new TagRecUpSearchPool()
    const old = pool.load([upSource])
    pool.reset()
    held.resolve({ items: [{ bvid: 'BV-old' }], hasMore: false })
    expect(await old).toEqual([])
    await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenLastCalledWith(7, '护士', 1, undefined)
    expect(pool.hasMore([upSource])).toBe(true)
  })

  it('请求失败停止自动分页，不当空页、不推进游标', async () => {
    vi.mocked(fetchUpSearchPage)
      .mockRejectedValueOnce(new Error('受限'))
      .mockResolvedValue({ items: [{ bvid: 'BV-good' }], hasMore: false })
    const pool = new TagRecUpSearchPool()
    await expect(pool.load([upSource])).rejects.toThrow('受限')
    await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    pool.continue()
    await pool.load([upSource])
    expect(fetchUpSearchPage).toHaveBeenLastCalledWith(7, '护士', 1, undefined)
  })
})
