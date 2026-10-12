import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import { fetchAllV2Search, fetchTagInfoByName, fetchTagTop } from '../api/endpoints'
import { newTagRecCombination, tagRecConditionAtom } from '../model/combination'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { favorites, sediment, seen } from '../store'
import { beginTagRecCustomQuery, tagRecCustomSession, tagRecSharedSession } from '../store/session'
import { ensureTagRecNegativePools } from './negative-slice'
import {
  computeTagRecCustomContextSignature,
  resetTagRecCustomSharedState,
  TagRecCustomService,
} from './tag-rec-custom'
import type { TagRecItemExtend } from '$define'
import type { AllV2VideoItem } from '../model/normalize-item'
import type { SedimentNode } from '../model/sediment'
import type { TagGroup, TagIdEntry } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// IO 边界 mock (同 tag-rec-custom.dig.test.ts 手法): endpoints/backoff/store/video-tags-store + UI/settings
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_CLS_TAB_BAR: 'x' }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve()) }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false },
  isRiskControlError: (e: unknown) => e instanceof Error && e.name === 'RiskControlError',
}))
vi.mock('../store', async () => {
  // sediment.map = 原生 Map; 票 36: noteDig 走真写口委托 —— 签名变/重建的水合链路按真语义跑
  const { sedimentNoteDig } = await import('../model/sediment')
  const pool = new Map<string, SedimentNode>()
  return {
    sediment: {
      map: pool,
      merge: vi.fn(),
      confirm: vi.fn(),
      noteDig: vi.fn((norm: string, dig: { keyword: string; nextPage: number; exhausted?: boolean }) =>
        sedimentNoteDig(pool, norm, dig),
      ),
    },
    seen: new Set<string>(),
    favorites: { list: [] },
    favoritesStore: { list: [] },
    favoritesL1: { list: [] },
    favoritesL1Store: { list: [] },
  }
})
vi.mock(import('./negative-slice'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ensureTagRecNegativePools: vi.fn<typeof actual.ensureTagRecNegativePools>(() => Promise.resolve()),
    tagRecNegativePools: vi.fn<typeof actual.tagRecNegativePools>(() => new Map<number, ReadonlySet<string>>()),
    dropTagRecStrictNegativeHits: vi.fn<typeof actual.dropTagRecStrictNegativeHits>((items) =>
      Promise.resolve({ items, dropped: 0, unchecked: 0 }),
    ),
  }
})
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return { settings: { tagRec: { filter: createTagRecFactoryFilterCore(), diversityGuard: false, k: 3 } } }
})

const video = (bvid: string, tag?: string): AllV2VideoItem => ({ bvid, title: bvid, tag })
const group = (id: string, name: string, tagIds: readonly [number, string][]): TagGroup => ({
  id,
  name,
  tag_ids: tagIds.map(([id, n]): TagIdEntry => ({ id, name: n })),
  weight: 1,
  enabled: true,
  addedAt: 0,
})
const sig = () => new AbortController().signal
/** fetchTagTop mock 调用记录里的 tid 列表 */
const fetchedTids = () => vi.mocked(fetchTagTop).mock.calls.map((c) => c[0])

const resetCustomSession = () => {
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.selectedGroupIds = []
  tagRecCustomSession.draftGroup = undefined
  tagRecCustomSession.workingGroup = undefined
  tagRecCustomSession.candidates = []
  tagRecCustomSession.digPending = false
  tagRecCustomSession.digRunning = false
  tagRecCustomSession.hardBottom = false
  tagRecCustomSession.softBottom = false
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.phase2 = { status: 'idle', pagesFetched: 0, exhausted: false, autoDigs: 0, lastDigYield: 0 }
  resetTagRecCustomSharedState() // 模块级干态跨 service 存活 (票 32 刷新提速); 用例间需清防串态
}

// 串行: 全 suite 共享 endpoints/store mock (同 dig.test.ts 纪律)
describe('$modules/tag-rec/service/tag-rec-custom 票32 逐源干态 + 首载预热', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    sediment.map.clear()
    seen.clear()
    tagRecCustomSession.bypassSeen = false
    tagRecSharedSession.recoveryRevision = 0
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
  })

  it('刷尽并记干后开启显示已看，重新请求并恢复旧视频；关闭后继续去重', async () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    seen.add('BV-old')
    // pn=1 恒同一条 (全已见 => 零新增连击); 深页空体 = 池底即干
    vi.mocked(fetchTagTop).mockImplementation((_tid, opts) =>
      Promise.resolve(opts?.pn && opts.pn > 1 ? [] : [{ bvid: 'BV-old' }]),
    )
    const initial = new TagRecCustomService()
    await initial.fetchMore(sig())
    expect(tagRecCustomSession.filterStats.seenDropped).toBe(1)
    // r2 零新增 streak1 / r3 streak2 => 进 pn=2; r4 pn=2 空体 => 池底即干 + 硬见底
    for (let i = 0; i < 3; i++) await initial.fetchMore(sig())
    expect(tagRecCustomSession.hardBottom).toBe(true)
    vi.mocked(fetchTagTop).mockClear()
    await initial.fetchMore(sig())
    expect(fetchedTids()).toEqual([])

    tagRecCustomSession.bypassSeen = true
    const revisit = new TagRecCustomService()
    expect(revisit.contextSignature).not.toBe(initial.contextSignature)
    const restored = await revisit.fetchMore(sig())
    expect(restored?.some((item) => item.api === EApiType.TagRec && item.bvid === 'BV-old')).toBe(true)
    expect(fetchedTids()).toEqual([7])
    expect(seen.has('BV-old')).toBe(true)
    expect(tagRecCustomSession.hardBottom).toBe(false)

    tagRecCustomSession.bypassSeen = false
    const hiddenAgain = await new TagRecCustomService().fetchMore(sig())
    expect(hiddenAgain?.some((item) => item.api === EApiType.TagRec && item.bvid === 'BV-old')).toBe(false)
  })

  it('清空已看与沉淀后，同一查询的内存干态及旧进度也复位', async () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    seen.add('BV-old')
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BV-old' }])
    const initial = new TagRecCustomService()
    for (let i = 0; i < 3; i++) await initial.fetchMore(sig())
    seen.clear()
    sediment.map.clear()
    tagRecSharedSession.recoveryRevision++
    vi.mocked(fetchTagTop).mockClear()
    const recovered = new TagRecCustomService()
    expect(recovered.contextSignature).not.toBe(initial.contextSignature)
    const items = await recovered.fetchMore(sig())
    expect(items?.some((item) => item.api === EApiType.TagRec && item.bvid === 'BV-old')).toBe(true)
    expect(fetchedTids()).toEqual([7])
  })

  it('会话/组配置放入万条过滤标签, 浅池预热仍只包含原组内负向成员', async () => {
    const tags = Array.from({ length: 10_000 }, (_, i) => ({ id: i + 10_000, name: `标签${i}` }))
    const g = group('g1', '组G', [[7, 'foo']])
    g.negative_tag_ids = [{ id: 80, name: '原负向' }]
    g.overrides = { negative: { tagBlock: { enabled: true, list: tags } } }
    ;(favorites.list as TagGroup[]).push(g)
    tagRecCustomSession.selectedGroupIds = [g.id]
    tagRecCustomSession.filterOverride = createTagRecFactoryFilterCore()
    tagRecCustomSession.filterOverride.dims.tagAllow = { enabled: true, list: tags }
    vi.mocked(ensureTagRecNegativePools).mockClear()

    await new TagRecCustomService().fetchMore(sig())
    expect(ensureTagRecNegativePools).toHaveBeenCalledExactlyOnceWith([80], expect.any(AbortSignal))
    expect(fetchedTids()).toEqual([7])
  })

  it('空响应即干 + 部分干只拉未干 tid', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' }, { id: 8, name: 'bar' })
    vi.mocked(fetchTagTop).mockImplementation((tid) => Promise.resolve(tid === 7 ? [] : [{ bvid: 'BV8' }]))

    await svc.fetchMore(sig())
    expect(fetchedTids().sort()).toEqual([7, 8]) // 首轮两个 tid 都打

    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([8]) // tid7 空响应即干 => 次轮起跳过
  })

  it('零新增连 2 轮进页: 首页饱和自动翻 pn=2, 三页到顶才标干 (实测池深 200/标签)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVx' }]) // 恒同一条 => 跨轮全已见

    const pns: number[] = []
    for (let i = 0; i < 7; i++) {
      await svc.fetchMore(sig())
      pns.push(vi.mocked(fetchTagTop).mock.calls.at(-1)?.[1]?.pn ?? 1)
    }
    // pn=1 两轮零新增 => 进 pn=2; pn=2 同 => 进 pn=3; pn=3 到顶连击 => 干
    expect(pns).toEqual([1, 1, 1, 2, 2, 3, 3])

    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig()) // r8: 到顶标干 => 零请求空轮
    expect(fetchedTids()).toEqual([])
  })

  it('深翻页交付: pn=2 新页内容照常上屏 (单标签查询不再 2 轮饿死)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    // pn=1/pn=2 各 100 条互不相交; pn=3 空体 (池底)
    vi.mocked(fetchTagTop).mockImplementation((_tid, opts) =>
      Promise.resolve(
        opts?.pn === 3 ? [] : Array.from({ length: 100 }, (_, i) => ({ bvid: `BV-${opts?.pn ?? 1}-${i}` })),
      ),
    )
    const delivered = new Set<string>()
    for (let round = 0; round < 10; round++) {
      const items = (await svc.loadMore(sig())) ?? []
      for (const item of items) if (item.api === EApiType.TagRec && item.bvid) delivered.add(item.bvid)
    }
    expect([...delivered].some((bvid) => bvid.startsWith('BV-2-'))).toBe(true)
    expect(vi.mocked(fetchTagTop).mock.calls.some(([, opts]) => opts?.pn === 2)).toBe(true)
  })

  it('签名变 (扩选进暂存层) => 干态全清: 所有 tid 重获一轮 tag/top', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    // fetchTagTop 恒空: r1 后 tid7 即干
    await svc.fetchMore(sig())
    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig()) // r2: 全干 => 不打 tag/top
    expect(fetchedTids()).toEqual([])

    tagRecCustomSession.expandedIds.push({ id: 8, name: 'bar' }) // 成员变动 => 签名变
    await svc.fetchMore(sig())
    expect(fetchedTids().sort()).toEqual([7, 8]) // 干 tid 重获一轮机会
    expect((svc as any).ladder.streams.has('bar')).toBe(true) // 变员再触发预热: 新扩选注册成流
  })

  it('全源皆干跳过 tag/top 不构成见底: 兜底堆照常放行', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })

    await svc.fetchMore(sig()) // r1: tag/top 空 => tid7 即干
    // r1 走完梯队后在堆补货 (模拟在途深挖随后落的相关留存)
    ;(svc as any).ladder.heap.push({
      api: EApiType.TagRec,
      uniqId: 'tag-rec:stock',
      bvid: 'stock',
      title: 'stock',
      pic: '',
      stat: { view: 1e5 },
      source: { via: 'all-v2-related', groupNames: [] },
    } as TagRecItemExtend)
    vi.mocked(fetchTagTop).mockClear()
    const items = await svc.fetchMore(sig()) // r2: 全干零请求 => 梯堆放行 stock
    expect(fetchedTids()).toEqual([])
    expect(items?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['stock'])
    expect(tagRecCustomSession.hardBottom).toBe(false)
    expect(tagRecCustomSession.digPending).toBe(false)
  })

  it('首载预热: 首轮即后台注册 选定组簇流 + 每扩选 id 一条独立流, 深挖与 tag/top 并行', async () => {
    const svc = new TagRecCustomService()
    ;(favorites.list as TagGroup[]).push(
      group('g1', '组G', [
        [1, 'Alpha'],
        [2, 'Beta'],
      ]),
    )
    tagRecCustomSession.selectedGroupIds = ['g1']
    tagRecCustomSession.expandedIds.push({ id: 9, name: 'Gamma' })
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVt' }])
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVd', 'alpha')])

    await svc.fetchMore(sig())
    const streams = (svc as any).ladder.streams as Map<string, { attribution: string[] }>
    expect([...streams.keys()].sort()).toEqual(['alpha', 'beta', 'gamma']) // 簇流 ×2 + 扩选流 ×1
    expect(streams.get('alpha')?.attribution).toEqual(['组G'])
    expect(streams.get('gamma')?.attribution).toEqual(['Gamma']) // 扩选流归因 = tag 名 (同查询单元口径)
    expect(fetchedTids().sort()).toEqual([1, 2, 9])
    expect(fetchAllV2Search).toHaveBeenCalled() // 预热深挖真跑 (不等 tag/top 落空才起步)
  })

  it('首载预热归一去重: 扩选与组成员同形 => 不重复开流', async () => {
    const svc = new TagRecCustomService()
    ;(favorites.list as TagGroup[]).push(
      group('g1', '组G', [
        [1, 'Alpha'],
        [2, 'Gamma X'],
      ]),
    )
    tagRecCustomSession.selectedGroupIds = ['g1']
    tagRecCustomSession.expandedIds.push({ id: 9, name: 'gamma  x' }) // 归一化后与组成员同形
    await svc.fetchMore(sig())
    const streams = (svc as any).ladder.streams as Map<string, unknown>
    expect([...streams.keys()].sort()).toEqual(['alpha', 'gammax']) // 撞 key 不重复开流
  })

  it('冷组首轮: tag/top 落空但预热深挖货经堆放行 —— 首轮产出非纯空转', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    vi.mocked(fetchTagTop).mockResolvedValue([]) // 冷 tag/top
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVr', 'other')]) // 非锚点 tag => related 入堆

    const items = await svc.fetchMore(sig())
    // runLadder 等在途预热 dig => related 落堆即放行, 首轮就有产出
    expect(items?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['BVr'])
    expect(tagRecCustomSession.hardBottom).toBe(false)
  })

  it('service 重建 (点刷新) 同签名 => 干态+深挖态跨实例保住: 死源/已挖页皆不重付', async () => {
    const svc1 = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    vi.mocked(fetchTagTop).mockResolvedValue([]) // 空响应 => tid7 即干
    await svc1.fetchMore(sig())
    expect(fetchedTids()).toEqual([7])
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(3) // 预热 manual 档挖了第 1~3 页
    expect((svc1 as any).ladder.streams.get('foo').nextPage).toBe(4)

    // service 重建 (= 点刷新), 成员签名不变 => 干态+流页游标跨实例存活 (票 37)
    const svc2 = new TagRecCustomService()
    vi.mocked(fetchTagTop).mockClear()
    vi.mocked(fetchAllV2Search).mockClear()
    await svc2.fetchMore(sig())
    expect(fetchedTids()).toEqual([]) // 死源不再重打抢闸 (冷池首屏提速点)
    const s2streams = (svc2 as any).ladder.streams as Map<string, { nextPage: number; exhausted: boolean }>
    expect(s2streams.get('foo')?.nextPage).toBe(4) // 页游标续进 —— 刷新不重抓第 1~3 页
    expect(fetchAllV2Search).not.toHaveBeenCalled() // 流已 exhausted 且无新注册 => 刷新零深挖重付
  })

  it('service 重建 + 成员已变 => 签名变即全清: 干 tid 重获一轮机会, 深挖态归页1重挖', async () => {
    const svc1 = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    vi.mocked(fetchTagTop).mockResolvedValue([])
    await svc1.fetchMore(sig()) // tid7 干 + 'foo' 流挖过 (exhausted, nextPage=4)

    const svc2 = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 8, name: 'bar' }) // 成员变 => 签名变
    vi.mocked(fetchTagTop).mockClear()
    vi.mocked(fetchAllV2Search).mockClear()
    await svc2.fetchMore(sig())
    expect(fetchedTids().sort()).toEqual([7, 8]) // 重建+变员 => tag/top 全量重打 (干态语义不变)
    // 票 37: 共享深挖态随签名变清空重注册; 票 36: 'foo' 游标已落沉淀 (挖穿 exhausted) =>
    //   重注册建流水合终态不再重挖 (签名 churn 不再重复烧); 仅新词 'bar' 页1挖 3 页
    const s2streams = (svc2 as any).ladder.streams as Map<string, { nextPage: number; exhausted: boolean }>
    expect(s2streams.get('foo')).toMatchObject({ nextPage: 4, exhausted: true })
    expect(s2streams.get('bar')?.nextPage).toBe(4)
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(3) // 仅 bar 一流挖过 (foo 水合 exhausted 零重付)
  })

  it('预热不放宽请求纪律: 风控退避期不点火深挖', async () => {
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    try {
      const svc = new TagRecCustomService()
      tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
      vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVt' }])
      await svc.fetchMore(sig())
      expect(fetchAllV2Search).not.toHaveBeenCalled()
      expect(fetchedTids()).toEqual([7]) // tag/top 主池照常
    } finally {
      ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false
    }
  })

  it('票 44 构造期签名同步: 变员后新 service 不放行旧境存货 (loadMore 先放队列后进 fetchMore)', async () => {
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', [[7, 'foo']]))
    tagRecCustomSession.selectedGroupIds = ['g1']
    const svc1 = new TagRecCustomService()
    await svc1.fetchMore(sig()) // 确立签名
    ;(svc1.qs.bufferQueue as unknown[]).push({ bvid: 'stock', uniqId: 'x' }) // 攒存货

    tagRecCustomSession.selectedGroupIds = [] // 变员: 撤组改扩选 => 签名变
    tagRecCustomSession.expandedIds = [{ id: 9, name: '扩' }]
    const svc2 = new TagRecCustomService()
    expect(svc2.qs.bufferQueue).toHaveLength(0) // 旧境存货被构造期同步清掉
    expect(svc1.qs.bufferQueue).toHaveLength(0)
    expect(svc2.contextSignature).not.toBe(svc1.contextSignature)
    // 同语境重建 => 存货保留 (票 37 语义不破)
    const svc3 = new TagRecCustomService()
    ;(svc3.qs.bufferQueue as unknown[]).push({ bvid: 'keep', uniqId: 'y' })
    const svc4 = new TagRecCustomService()
    expect(svc4.qs.bufferQueue).toHaveLength(1)
    expect(svc4.contextSignature).toBe(svc3.contextSignature)
  })
})

describe('$modules/tag-rec/service/tag-rec-custom AUDIT 回归 (03/09/15/16/20)', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchTagInfoByName).mockReset().mockResolvedValue(undefined)
    sediment.map.clear()
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
  })

  it('AUDIT-03: 共享 bufferQueue 原地 splice —— 上屏切片后别名不脱钩, 跨实例续落货同视', async () => {
    const svc1 = new TagRecCustomService()
    const item = (bvid: string) => ({ bvid, uniqId: `tag-rec:${bvid}` })
    ;(svc1.qs.bufferQueue as unknown[]).push(item('BV1'), item('BV2'), item('BV3'))

    const items = await svc1.loadMore(sig())
    expect(items).toHaveLength(3) // 三条上屏, 进 returnQueue

    // 旧实现 slice 重建 => svc1.qs.bufferQueue 换壳脱钩共享盒 (共享旧数组仍冻结含已上屏货);
    // 原地 splice 后两实例必须仍指同一数组 —— 深挖续落货不再进死数组静默丢
    const svc2 = new TagRecCustomService()
    expect(svc2.qs.bufferQueue).toBe(svc1.qs.bufferQueue)
    expect(svc2.qs.bufferQueue).toHaveLength(0) // 已上屏货被 splice 摘走, 不再冻结回放

    ;(svc1.qs.bufferQueue as unknown[]).push(item('BV4')) // 模拟 svc1 在途深挖续落货
    expect(svc2.qs.bufferQueue).toHaveLength(1) // 共享盒同视 —— svc2 下轮直放

    // restore() 同型原地修复: returnQueue 回放共享盒
    await svc1.loadMore(sig()) // BV4 上屏 => returnQueue=[1,2,3,4]
    svc1.qs.restore()
    expect(svc2.qs.bufferQueue).toHaveLength(4)
    expect((svc2.qs.bufferQueue as { bvid: string }[]).map((x) => x.bvid)).toEqual(['BV1', 'BV2', 'BV3', 'BV4'])
  })

  it('AUDIT-09: 语境签名并入归一化 inputText —— 同组同扩选下输入变即语境变', () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    const s0 = computeTagRecCustomContextSignature() // '7|in:|g:...' (R5-P1-11 后组身份入签)
    expect(s0).toContain('7|in:|g:')

    tagRecCustomSession.inputText = 'Foo Bar'
    const s1 = computeTagRecCustomContextSignature()
    expect(s1).not.toBe(s0) // 输入是语境成分 —— 原实现只有 id 段, 输入变签名不变 => refresh 判丢
    expect(s1).toContain('|in:foobar')

    tagRecCustomSession.inputText = ' Foo  Bar ' // 归一化 (空白/大小写) 后同形 => 同签名不误漂
    expect(computeTagRecCustomContextSignature()).toBe(s1)

    tagRecCustomSession.inputText = 'baz'
    expect(computeTagRecCustomContextSignature()).not.toBe(s1)
  })

  it('R5-P1-11: 语境签名并入组身份 —— 同 tag_ids 异组切组判漂移', () => {
    // 复刻 P1-11: 两组共用全部 tag_id, A→B 切组签名原恒等 => 共享盒按 B 语境放 A 境存货
    favorites.list.push(group('ga', 'A', [[1, 'x']]), group('gb', 'B', [[1, 'x']]))

    tagRecCustomSession.selectedGroupIds = ['ga']
    const sA = computeTagRecCustomContextSignature()
    tagRecCustomSession.selectedGroupIds = ['gb']
    const sB = computeTagRecCustomContextSignature()
    expect(sB).not.toBe(sA)
    expect(sA).toContain('|g:ga')
    expect(sB).toContain('|g:gb')
  })

  it('AUDIT-09: 空输入/未命中锚点不缓存 —— 实例内可重读新输入重解析', async () => {
    tagRecCustomSession.inputText = 'foo'
    const svc = new TagRecCustomService()

    // 'foo' 文本路径解不出 => undefined 不得被 ??= 钉死 (旧实现该实例终身 anchorless)
    await expect((svc as any).resolveAnchorOnce()).resolves.toBeUndefined()
    expect(fetchTagInfoByName).toHaveBeenCalledTimes(1)
    expect(fetchTagInfoByName).toHaveBeenLastCalledWith('foo', undefined)

    tagRecCustomSession.inputText = 'bar' // 同实例换可解词 => 重发解析 (实例场景: 轮询/失败重试链)
    vi.mocked(fetchTagInfoByName).mockResolvedValue({ id: 42, name: 'bar' })
    await expect((svc as any).resolveAnchorOnce()).resolves.toEqual({ id: 42, name: 'bar' })
    expect(vi.mocked(fetchTagInfoByName).mock.calls.map((c) => c[0])).toEqual(['foo', 'bar'])

    // 真锚点照旧 promise 级缓存: 第三发不再重打 tag/info
    await expect((svc as any).resolveAnchorOnce()).resolves.toEqual({ id: 42, name: 'bar' })
    expect(fetchTagInfoByName).toHaveBeenCalledTimes(2)
  })

  it('收编票: fetch 闸 abort 不废同股已付页 —— 页游标推进/落货/记 sediment', async () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'], input: true })
    const ctl = new AbortController()
    ;(svc as any).lastFetchSignal = ctl.signal // 手动深挖批生命周期随当前 fetch 闸

    // 页请求一发出即 abort (模拟 useRefresh 弃旧 service): 同股盒未换 => 已完成页照常收编,
    //   abort 只掐未发出的排队页 (真实端点 abort 拒绝 => gap 不推进), 不再作废重拉
    vi.mocked(fetchAllV2Search).mockImplementation(() => {
      ctl.abort()
      return Promise.resolve([video('BVx', 'foo')])
    })
    await svc.digMore()
    // 同股收编契约 = 已付页入账不重拉: 游标推进+sediment 落盘;
    //   条目本体按活 resolver 路由 (此语境 'foo' 无组链 => observe 进候补池, 不作废)
    expect((svc as any).ladder.streams.get('foo').nextPage).toBe(4)
    expect(sediment.noteDig).toHaveBeenCalled()
  })

  it('AUDIT-16: 语境漂移后弃实例 digMore 收尾不写共享 session', async () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'], input: true })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = [] // 一批 3 页并发 —— 收集全部 resolver
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p = svc.digMore()
    expect(tagRecCustomSession.digRunning).toBe(true) // 非 stale 时照常置在途标
    expect(tagRecCustomSession.phase2.status).toBe('running')

    beginTagRecCustomQuery('') // 语境漂移 (原 inputText 比对在组/扩选漂移下漏判): 新语境镜像重置
    waiters.forEach((r) => r([video('BVx', 'foo')]))
    await p
    // 弃实例收尾被 stale 门拦: 新语境的 idle/false 镜像不被回写
    expect(tagRecCustomSession.digRunning).toBe(false)
    expect(tagRecCustomSession.digPending).toBe(false)
    expect(tagRecCustomSession.hardBottom).toBe(false)
    expect(tagRecCustomSession.phase2).toMatchObject({ status: 'idle', pagesFetched: 0, lastDigYield: 0 })
  })

  it('AUDIT-16: 漂移发生在 digMore 之前 => 入口即拒发 (不置标不烧请求)', async () => {
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'], input: true })
    tagRecCustomSession.expandedIds.push({ id: 8, name: 'bar' }) // 先漂移后开挖
    await svc.digMore()
    expect(tagRecCustomSession.digRunning).toBe(false) // 弃实例从未置在途标
    expect(fetchAllV2Search).not.toHaveBeenCalled() // 弃实例整发拒挖, 不落旧境货
  })

  it('AUDIT-20: >10 id 大组轮转游标升共享盒 —— service 重建不重拉首片, ids 11..N 不饿死', async () => {
    ;(favorites.list as TagGroup[]).push(
      group(
        'g1',
        '大组',
        Array.from({ length: 12 }, (_, i) => [i + 1, `t${i + 1}`] as [number, string]),
      ),
    )
    tagRecCustomSession.selectedGroupIds = ['g1']

    const svc1 = new TagRecCustomService()
    await svc1.fetchMore(sig())
    expect(fetchedTids().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // 首片

    // 同签名重建 (点刷新): 旧实现实例级游标归零 => 永远重拉首片 (全已见 => 干态标干 => 11..N 饿死)
    const svc2 = new TagRecCustomService()
    vi.mocked(fetchTagTop).mockClear()
    await svc2.fetchMore(sig())
    expect(fetchedTids().sort((a, b) => a - b)).toEqual([11, 12]) // 游标随共享盒续进第二片
  })

  it('严格配方只产 pending 时仍点火深挖 —— fed 与库存同域 (match), pending 供货不算喂过', async () => {
    // all{tag:foo, desc:zzz}: 非交集配方 (tag 证据分支=1) 池闸全开 => tag/top 条目可交付;
    //   但 desc 支路缺证据恒 unknown => 每条都是 pending => wg 可证库存恒零。
    //   若 fed 把 pending 条也算"供过货", wg 永远看似已喂 => 深挖永不开火 (旧 fed 口径的洞)
    const combo = newTagRecCombination()
    combo.include.children.push(tagRecConditionAtom('tag', { id: 1, name: 'foo' }), tagRecConditionAtom('desc', 'zzz'))
    tagRecCustomSession.workingGroup = {
      id: '__tagrec_working__',
      name: 'wg',
      tag_ids: [{ id: 1, name: 'foo' }],
      enabled: true,
      weight: 1,
      addedAt: 0,
      combination: combo,
    }
    // 32 条 tag/top 高产 (≥triggerYield): 全局欠产门不开, 只能靠饿组闸救
    // 逐轮出新 bvid (same-bvid 会在第二轮被 seen 去重成空轮 => 走 hasTagTopPagesLeft 早退, 评估不到闸)
    let round = 0
    vi.mocked(fetchTagTop).mockImplementation(() => {
      const items = Array.from({ length: 32 }, (_, i) => ({ bvid: `tp-${round}-${i}` }))
      round++
      return Promise.resolve(items)
    })
    // allV2 给非空回包 —— 首轮热身挖后流不 exhausted, 第二轮饿组闸才有货可挖
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('dg', 'other')])

    const svc = new TagRecCustomService()
    await svc.fetchMore(sig())
    await (svc as any).ladder.digRunning?.catch(() => undefined) // 热身挖落地
    // 第二轮: 流表已建 => warmup 不再触发; wg 依旧 pending 供货 + 零可证库存 =>
    //   唯一引爆路径 = 饿组闸 (旧 fed 口径把 pending 当供货 => 不开火)
    vi.mocked(fetchAllV2Search).mockClear()
    await svc.fetchMore(sig())
    for (let i = 0; i < 8 && !vi.mocked(fetchAllV2Search).mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 0))
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])).toContain('foo')
  })

  it('共享 tid 被别组资格放行不误判供货 —— fed 同域 claims ∩ eligibleGroupKeys', async () => {
    // gA=all{tag:foo, title:zzz} (非交集可抽) + gB=foo 普通组 —— 同 tid=1 合并归因;
    //   条目对 gA mismatch (title 不含 zzz) => eligible 只剩 gB => 裸认 claims 会误判 gA 已喂
    const combo = newTagRecCombination()
    combo.include.children.push(tagRecConditionAtom('tag', { id: 1, name: 'foo' }), tagRecConditionAtom('title', 'zzz'))
    ;(favorites.list as TagGroup[]).push(
      { ...group('gA', '配方组', [[1, 'foo']]), combination: combo },
      group('gB', '普通组', [[1, 'foo']]),
    )
    tagRecCustomSession.selectedGroupIds = ['gA', 'gB']
    let sharedRound = 0
    vi.mocked(fetchTagTop).mockImplementation(() => {
      // title 必须存在且不含 'zzz' —— 无标题条目 desc/title 原子判 unknown(defer 放行),
      //   只有真标题才证 mismatch => gA 链被剥资格只剩 gB eligible
      const items = Array.from({ length: 32 }, (_, i) => ({ bvid: `tp-${sharedRound}-${i}`, title: `视频${i}` }))
      sharedRound++
      return Promise.resolve(items)
    })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('dg', 'other')])

    const svc = new TagRecCustomService()
    await svc.fetchMore(sig())
    await (svc as any).ladder.digRunning?.catch(() => undefined) // 热身挖落地
    vi.mocked(fetchAllV2Search).mockClear()
    await svc.fetchMore(sig()) // 第二轮: 唯一引爆路径 = 饿组闸 (gA 恒零库存 + 资格被剥)
    for (let i = 0; i < 8 && !vi.mocked(fetchAllV2Search).mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 0))
    const keywords = vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])
    expect(keywords.some((k) => k === 'foo' || k === 'zzz')).toBe(true)
  })
})
