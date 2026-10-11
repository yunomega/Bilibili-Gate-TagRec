import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { persistDryTid } from '../api/dry-tids-store'
import { fetchTagTop } from '../api/endpoints'
import {
  applyTagRecStages,
  clampTagRecK,
  compareTagRecItems,
  createTagRecProduceTracker,
  defaultTagRecScoreStage,
  makeTagRecExhaustSeparator,
  runTagRecRound,
  TAG_REC_SOFT_BOTTOM_MIN_PRODUCE,
  TAG_REC_SOFT_BOTTOM_STREAK,
  TAG_REC_TAG_TOP_PAGE_CAP,
  TAG_REC_TID_DRY_STREAK,
  tagRecStagePassthrough,
  TagRecTidDryTracker,
  trackTagRecRoundProduce,
  type TagRecRoundStage,
} from './_pipeline'
import type { TagRecItemExtend } from '$define'

// $common / endpoints 触浏览器环境 (location/GM); 纯函数测试以 mock 隔掉 (同 resolve.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  fetchTagTop: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../api/dry-tids-store', () => ({
  isPersistedDryTid: vi.fn(() => false),
  persistDryTid: vi.fn(() => Promise.resolve()),
}))

const item = (bvid: string, extra: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: [] },
  ...extra,
})

describe.concurrent('$modules/tag-rec/service/_pipeline', () => {
  it('.trackTagRecRoundProduce 软见底: 连续2轮产出<5 标记, 达标清零', () => {
    const t = createTagRecProduceTracker()
    expect(TAG_REC_SOFT_BOTTOM_MIN_PRODUCE).toBe(5)
    expect(TAG_REC_SOFT_BOTTOM_STREAK).toBe(2)

    trackTagRecRoundProduce(t, 20)
    expect(t).toMatchObject({ lowStreak: 0, softBottom: false })
    trackTagRecRoundProduce(t, 4) // <5
    expect(t).toMatchObject({ lowStreak: 1, softBottom: false })
    trackTagRecRoundProduce(t, 0) // <5, 连续第2轮
    expect(t).toMatchObject({ lowStreak: 2, softBottom: true })
    trackTagRecRoundProduce(t, 3) // 连续第3轮仍 <5
    expect(t).toMatchObject({ lowStreak: 3, softBottom: true })
    trackTagRecRoundProduce(t, 5) // 达标 (>=5) 清零
    expect(t).toMatchObject({ lowStreak: 0, softBottom: false })
  })

  it('.clampTagRecK 可调 1~10 收口, 非数回落默认 3', () => {
    expect(clampTagRecK(3)).toBe(3)
    expect(clampTagRecK(0)).toBe(1)
    expect(clampTagRecK(-5)).toBe(1)
    expect(clampTagRecK(99)).toBe(10)
    expect(clampTagRecK(2.6)).toBe(3)
    expect(clampTagRecK(NaN)).toBe(3)
  })

  it('.compareTagRecItems 排序: score desc → srcRank → bvid; partial 排尾按 view desc', () => {
    const sorted = [
      item('a', { score: 50, srcRank: 0 }),
      item('b', { score: 80, srcRank: 9 }), // score 高在前
      item('c', { score: 50, srcRank: 2 }), // 同分按 srcRank
      item('d', { score: 50, srcRank: 2, bvid: 'a0' }), // 同分同 rank 按 bvid ('a0' < 'c')
      item('p1', { partial: true, stat: { view: 100 } }),
      item('p2', { partial: true, stat: { view: 900 } }), // partial 排尾按 view desc
    ].sort(compareTagRecItems)
    expect(sorted.map((x) => x.uniqId)).toEqual([
      'tag-rec:b',
      'tag-rec:a', // score=50 内 srcRank=0 最先
      'tag-rec:d', // srcRank=2 平级, bvid 'a0' < 'c'
      'tag-rec:c',
      'tag-rec:p2', // view 900 在前
      'tag-rec:p1',
    ])
  })

  it('.compareTagRecItems score 占位期 (undefined) 退化为 srcRank 源序', () => {
    const sorted = [item('a', { srcRank: 5 }), item('b', { srcRank: 0 }), item('c', { srcRank: 2 })].sort(
      compareTagRecItems,
    )
    expect(sorted.map((x) => x.bvid)).toEqual(['b', 'c', 'a'])
  })

  it('.defaultTagRecScoreStage 不改原数组 + 排序产出', () => {
    const items = [item('a', { srcRank: 9 }), item('b', { srcRank: 1 })]
    const out = defaultTagRecScoreStage(items, { fetchedCount: 2 })
    expect(out.map((x) => x.bvid)).toEqual(['b', 'a'])
    expect(items[0].bvid).toBe('a') // 入参未被原地排序
  })

  it('.applyTagRecStages 阶段顺序 过滤=>算分=>去已看 + 缺省直通', () => {
    const items = [item('a', { srcRank: 1 }), item('b', { srcRank: 0 }), item('c', { srcRank: 2 })]
    const calls: string[] = []
    const mark = (name: string, fn: (i: TagRecItemExtend[]) => TagRecItemExtend[]): TagRecRoundStage => {
      return (i) => {
        calls.push(name)
        return fn(i)
      }
    }

    const out = applyTagRecStages(
      items,
      { fetchedCount: 3 },
      {
        filterStage: mark('filter', (i) => i.filter((x) => x.bvid !== 'c')),
        scoreStage: mark('score', (i) => [...i].reverse()),
        seenStage: mark('seen', (i) => i.filter((x) => x.bvid !== 'a')),
      },
    )
    expect(calls).toEqual(['filter', 'score', 'seen'])
    expect(out.map((x) => x.bvid)).toEqual(['b'])

    // 缺省 stages: filter/seen 直通, score 用默认 srcRank 排序
    expect(tagRecStagePassthrough(items, { fetchedCount: 3 })).toBe(items)
    const out2 = applyTagRecStages(items, { fetchedCount: 3 })
    expect(out2.map((x) => x.bvid)).toEqual(['b', 'a', 'c'])
  })

  it('.runTagRecRound 池并集 + 同轮 bvid 命中合并 groupNames + 跨轮 seenBvids 去重', async () => {
    const mockFetch = vi.mocked(fetchTagTop)
    mockFetch.mockImplementation((tid) => {
      if (tid === 1) return Promise.resolve([{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }])
      if (tid === 2) return Promise.resolve([{ bvid: 'BV2' }, { bvid: 'BV4' }]) // BV2 跨组命中
      return Promise.resolve([])
    })
    const seenBvids = new Set<string>()
    const sources = [
      { tid: 1, groupNames: ['组A'] },
      { tid: 2, groupNames: ['组B'] },
      { tid: 3, groupNames: ['组C'] }, // 空池
    ]
    const r1 = await runTagRecRound({ sources, seenBvids })
    expect(r1.fetchedCount).toBe(5)
    expect(r1.producedCount).toBe(4) // BV1~BV4
    const byBvid = new Map(r1.items.map((x) => [x.bvid, x]))
    expect(byBvid.get('BV2')?.source.groupNames).toEqual(['组A', '组B']) // 同轮多组命中合并归因
    expect(byBvid.get('BV1')?.source.groupNames).toEqual(['组A'])
    expect(byBvid.get('BV1')?.source.tagIds).toEqual([1])
    expect(byBvid.get('BV2')?.source.tagIds).toEqual([1, 2])
    expect(byBvid.get('BV4')?.source.tagIds).toEqual([2])
    // srcRank 源序交错合并 (组内不配额, 跨池公平)
    expect(r1.items.map((x) => x.bvid)).toEqual(['BV1', 'BV2', 'BV4', 'BV3'])

    // 跨轮: 同池重拉全被 seenBvids 滤掉 => 产出 0
    const r2 = await runTagRecRound({ sources, seenBvids })
    expect(r2.producedCount).toBe(0)
  })

  it('.runTagRecRound 单源失败 (allSettled) 不拖死整轮', async () => {
    const mockFetch = vi.mocked(fetchTagTop)
    mockFetch.mockImplementation((tid) => {
      if (tid === 1) return Promise.resolve([{ bvid: 'BV1' }])
      return Promise.reject(new Error('network'))
    })
    const r = await runTagRecRound({
      sources: [
        { tid: 1, groupNames: ['A'] },
        { tid: 2, groupNames: ['B'] },
      ],
      seenBvids: new Set(),
    })
    expect(r.producedCount).toBe(1)
    expect(r.items[0].source.groupNames).toEqual(['A'])
  })

  it('.makeTagRecExhaustSeparator separator 形态 (EApiType.Separator, uniqId 唯一)', () => {
    const s1 = makeTagRecExhaustSeparator('见底1')
    const s2 = makeTagRecExhaustSeparator('见底2')
    expect(s1.api).toBe(EApiType.Separator)
    expect(s1.content).toBe('见底1')
    expect(s1.uniqId).not.toBe(s2.uniqId)
    expect(s1.uniqId).toContain('tag-rec')
  })
})

// 串行: 断言 fetchTagTop mock 逐源账, 不与上方 concurrent 套件共享在途 mock
describe('$modules/tag-rec/service/_pipeline 票32 逐源干态', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
  })

  it('.runTagRecRound sourceStats: fetched/contributed/ok 逐源记账', async () => {
    vi.mocked(fetchTagTop).mockImplementation((tid) => {
      if (tid === 1) return Promise.resolve([{ bvid: 'BV1' }, { bvid: 'BV2' }])
      if (tid === 2) return Promise.resolve([{ bvid: 'BV2' }]) // 同轮重复 => 贡献 0
      if (tid === 4) return Promise.reject(new Error('network'))
      return Promise.resolve([]) // tid 3 空响应
    })
    const r = await runTagRecRound({
      sources: [
        { tid: 1, groupNames: ['A'] },
        { tid: 2, groupNames: ['B'] },
        { tid: 3, groupNames: ['C'] },
        { tid: 4, groupNames: ['D'] },
      ],
      seenBvids: new Set(),
    })
    expect(r.sourceStats).toEqual([
      { tid: 1, pn: 1, fetched: 2, contributed: 2, ok: true },
      { tid: 2, pn: 1, fetched: 1, contributed: 0, ok: true },
      { tid: 3, pn: 1, fetched: 0, contributed: 0, ok: true },
      { tid: 4, pn: 1, fetched: 0, contributed: 0, ok: false }, // 被拒不判干
    ])
  })

  it('.runTagRecRound 深翻页: 源 pn 透传 fetchTagTop 并回写 sourceStats', async () => {
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BV-p2' }])
    const r = await runTagRecRound({
      sources: [{ tid: 9, groupNames: ['A'], pn: 2 }],
      seenBvids: new Set(),
    })
    expect(fetchTagTop).toHaveBeenCalledWith(9, expect.objectContaining({ pn: 2 }))
    expect(r.sourceStats).toEqual([{ tid: 9, pn: 2, fetched: 1, contributed: 1, ok: true }])
  })

  it('.TagRecTidDryTracker: 空即干 / 零新增连2轮进页 / 深页空体池底干 / 有新货清连击 / 失败不动 / clear 全清', () => {
    const t = new TagRecTidDryTracker()
    expect(TAG_REC_TID_DRY_STREAK).toBe(2)

    // 空响应即干 (pn=1 = 源真空)
    t.note([{ tid: 1, fetched: 0, contributed: 0, ok: true }])
    expect(t.isDry(1)).toBe(true)

    // 零新增: 第 1 轮不干; 连击达阈值 => 进下一页 (实测 pn=1 不重采样, 深页才有新内容)
    t.note([{ tid: 2, pn: 1, fetched: 5, contributed: 0, ok: true }])
    expect(t.isDry(2)).toBe(false)
    expect(t.pageOf(2)).toBe(1)
    t.note([{ tid: 2, pn: 1, fetched: 3, contributed: 0, ok: true }])
    expect(t.isDry(2)).toBe(false)
    expect(t.pageOf(2)).toBe(2)

    // 深页零新增 => 继续进页; 到 cap 后连击才标干
    t.note([{ tid: 2, pn: 2, fetched: 3, contributed: 0, ok: true }])
    t.note([{ tid: 2, pn: 2, fetched: 3, contributed: 0, ok: true }])
    expect(t.pageOf(2)).toBe(TAG_REC_TAG_TOP_PAGE_CAP)
    t.note([{ tid: 2, pn: TAG_REC_TAG_TOP_PAGE_CAP, fetched: 3, contributed: 0, ok: true }])
    expect(t.isDry(2)).toBe(false)
    t.note([{ tid: 2, pn: TAG_REC_TAG_TOP_PAGE_CAP, fetched: 3, contributed: 0, ok: true }])
    expect(t.isDry(2)).toBe(true)

    // 深页空体 = 池底 => 立即干 (会话级, 不落持久图)
    t.note([{ tid: 5, pn: 2, fetched: 0, contributed: 0, ok: true }])
    expect(t.isDry(5)).toBe(true)

    // 有新货清连击: 1 次零新增不累计
    t.note([{ tid: 3, fetched: 5, contributed: 0, ok: true }])
    t.note([{ tid: 3, fetched: 5, contributed: 1, ok: true }])
    t.note([{ tid: 3, fetched: 5, contributed: 0, ok: true }])
    expect(t.isDry(3)).toBe(false) // 连击被清过, 当前 streak=1

    // 请求被拒 (ok=false) 不动干态 —— 不判干也不清连击
    t.note([{ tid: 3, fetched: 0, contributed: 0, ok: false }])
    expect(t.isDry(3)).toBe(false)
    t.note([{ tid: 3, fetched: 5, contributed: 0, ok: true }]) // streak 2 => 进页
    expect(t.isDry(3)).toBe(false)
    expect(t.pageOf(3)).toBe(2)

    // clear 全清 (签名变: 所有 tid 重获一轮机会, 翻页游标归零)
    t.clear()
    expect(t.size).toBe(0)
    expect(t.isDry(1)).toBe(false)
    expect(t.isDry(2)).toBe(false)
    expect(t.isDry(3)).toBe(false)
    expect(t.pageOf(2)).toBe(1)
  })

  it('.TagRecTidDryTracker persistEmpty: 仅 pn=1 空响应落盘; 深页空体/到顶不落盘', () => {
    const t = new TagRecTidDryTracker({ persistEmpty: true })
    vi.mocked(persistDryTid).mockClear()
    t.note([{ tid: 6, pn: 2, fetched: 0, contributed: 0, ok: true }])
    expect(persistDryTid).not.toHaveBeenCalled()
    t.note([{ tid: 7, pn: 1, fetched: 0, contributed: 0, ok: true }])
    expect(persistDryTid).toHaveBeenCalledWith(7)
  })
})
