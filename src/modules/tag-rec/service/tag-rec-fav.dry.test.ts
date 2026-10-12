import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { settings } from '$modules/settings'
import { tagRecBackoff } from '../api/backoff'
import { fetchAllV2Search, fetchTagTop } from '../api/endpoints'
import { newTagRecCombination, tagRecConditionAtom } from '../model/combination'
import { favorites, favoritesL1, sediment, seen } from '../store'
import { emptyTagRecFilterStats, tagRecFavSession, tagRecSharedSession } from '../store/session'
import { ensureTagRecNegativePools } from './negative-slice'
import { resetTagRecFavSharedState, TagRecFavService } from './tag-rec-fav'
import type { TagRecItemExtend } from '$define'
import type { AllV2VideoItem } from '../model/normalize-item'
import type { SedimentNode } from '../model/sediment'
import type { TagGroup, TagIdEntry, TagL1Group } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// IO 边界 mock (照抄 tag-rec-custom.dry.test.ts 手法): endpoints/backoff/store/video-tags-store + UI/settings;
// 票 41 附加: dry-tids-store mock —— tab1 会话级干态不吃持久层 (票 41 裁: 持久化另议), 隔掉 GM 全局
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
vi.mock('../api/dry-tids-store', () => ({
  isPersistedDryTid: () => false,
  persistDryTid: vi.fn(() => Promise.resolve()),
}))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false },
  isRiskControlError: (e: unknown) => e instanceof Error && e.name === 'RiskControlError',
}))
vi.mock('../store', async () => {
  // sediment.map = 原生 Map; 票 36: noteDig 走真写口委托 (水合读端经 map.get 原生可读)
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
    themes: { list: [], active: undefined },
    // R7: 查看范围不筛 (undefined = 不筛语义; mock 返回 undefined 绕过 Set 约束)
    viewScope: { viewedL1Ids: () => undefined },
  }
})

describe('收藏推荐库存与展示分离', () => {
  const services: TagRecFavService[] = []
  const oldEnabled = settings.tagRec.filter.enabled
  beforeEach(() => {
    favorites.list.length = 0
    favoritesL1.list.length = 0
    seen.clear()
    sediment.map.clear()
    resetFavSession()
    tagRecFavSession.bypassSeen = false
    settings.tagRec.filter.enabled = false
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
  })
  afterEach(async () => {
    for (const svc of services) await (svc as any).prefetchRunning
    services.length = 0
    settings.tagRec.filter.enabled = oldEnabled
  })
  const service = () => {
    const svc = new TagRecFavService()
    services.push(svc)
    return svc
  }
  const deliveries = (items: readonly unknown[] | undefined) => {
    const result: Record<string, number> = {}
    for (const item of (items ?? []) as TagRecItemExtend[]) {
      if (item.api !== EApiType.TagRec) continue
      const id = item.source.groupIds![0]
      result[id] = (result[id] ?? 0) + 1
    }
    return result
  }

  it('单父组下5个二级组首批各4条，大组余量不阻挡第二批，也不重复取有库存的组', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(
      group(
        'A',
        'A',
        'P',
        Array.from({ length: 100 }, (_, i) => [i + 1, `a${i}`]),
      ),
    )
    for (let i = 0; i < 4; i++) favorites.list.push(group('BCDE'[i], 'BCDE'[i], 'P', [[201 + i, `t${i}`]]))
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve(Array.from({ length: 20 }, (_, i) => ({ bvid: `BV-${tid}-${i}`, title: `${tid}-${i}` }))),
    )
    const svc = service()
    const first = await svc.loadMore(sig())
    expect(deliveries(first)).toEqual({ A: 4, B: 4, C: 4, D: 4, E: 4 })
    expect(fetchTagTop).toHaveBeenCalledTimes(14) // A最多10标签，其余各1
    const second = await svc.loadMore(sig())
    expect(deliveries(second)).toEqual({ A: 4, B: 4, C: 4, D: 4, E: 4 })
    expect(fetchTagTop).toHaveBeenCalledTimes(14)
    expect(svc.qs.bufferQueue).toHaveLength(240)
    const ids = [...first!, ...second!].map((item) => (item as TagRecItemExtend).bvid)
    expect(new Set(ids).size).toBe(40)
    expect(tagRecFavSession.drawnGroupNames.sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('普通刷新延续实际展示权重，不反复重置5:1的轮转尾部', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(group('A', 'A', 'P', [[1, 'alpha']]), group('B', 'B', 'P', [[2, 'beta']]))
    favorites.list[0].weight = 5
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve(Array.from({ length: 200 }, (_, i) => ({ bvid: `BV-${tid}-${i}` }))),
    )
    const all: unknown[] = []
    for (let page = 0; page < 6; page++) all.push(...(await service().loadMore(sig()))!)
    expect(deliveries(all)).toEqual({ A: 100, B: 20 })
    expect(fetchTagTop).toHaveBeenCalledTimes(2)
  })

  it('深挖余量进入同一库存，不能绕过二级组展示份额', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(group('A', 'A', 'P', [[1, 'alpha']]), group('B', 'B', 'P', [[2, 'beta']]))
    const svc = service()
    const deep = (id: string, count: number): TagRecItemExtend[] =>
      Array.from({ length: count }, (_, i) => ({
        api: EApiType.TagRec,
        bvid: `${id}${i}`,
        uniqId: `${id}${i}`,
        title: id,
        pic: '',
        stat: {},
        source: { via: 'all-v2-exact', groupIds: [id], groupNames: [id] },
      }))
    ;(svc as any).ladder.hooks.pushQueue([...deep('A', 200), ...deep('B', 20)])
    expect(deliveries(await svc.loadMore(sig()))).toEqual({ A: 10, B: 10 })
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('热组库存充足时，冷组的相关兜底库存仍能补进公平名额且不追加请求', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(group('A', 'A', 'P', [[1, 'alpha']]), group('B', 'B', 'P', [[2, 'beta']]))
    const svc = service()
    const raw = (id: string, count: number): TagRecItemExtend[] =>
      Array.from({ length: count }, (_, i) => ({
        api: EApiType.TagRec,
        uniqId: `${id}:${i}`,
        bvid: `${id}:${i}`,
        title: id,
        pic: '',
        stat: {},
        source: { via: 'all-v2-related', groupIds: [id], groupNames: [id] },
      }))
    svc.qs.bufferQueue.push(...raw('A', 200))
    ;(svc as any).ladder.heap.push(...raw('B', 20), ...raw('A', 20))
    expect(deliveries(await svc.loadMore(sig()))).toEqual({ A: 10, B: 10 })
    expect((svc as any).ladder.heap).toHaveLength(20) // 暂不缺货的 A 原料保留，未被切页消费。
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
  })

  it('尚未扫到的有货组不会被前面空组误判成全范围见底', async () => {
    favoritesL1.list.push(l1('P'))
    for (let i = 1; i <= 6; i++) favorites.list.push(group(`g${i}`, `g${i}`, 'P', [[i, `t${i}`]]))
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve(tid === 6 ? Array.from({ length: 100 }, (_, i) => ({ bvid: `BV-good-${i}` })) : []),
    )
    const svc = service()
    const first = await svc.loadMore(sig())
    const second = await svc.loadMore(sig())
    expect([...first!, ...second!].some((item) => item.api === EApiType.TagRec)).toBe(true)
    expect(tagRecFavSession.hardBottom).toBe(false)
  })

  it('预取复用重复标签的一次请求，仍保留所有认领组', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(group('A', 'A', 'P', [[1, 'shared']]), group('B', 'B', 'P', [[1, 'shared']]))
    vi.mocked(fetchTagTop).mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ bvid: `BV-shared-${i}` })))
    const items = await service().loadMore(sig())
    expect(fetchTagTop).toHaveBeenCalledExactlyOnceWith(1, expect.anything())
    expect(items).toHaveLength(20)
    expect((items as TagRecItemExtend[]).every((item) => item.source.groupIds?.length === 2)).toBe(true)
  })

  it('中止的取数不会把旧语境产出写回共享库存', async () => {
    favoritesL1.list.push(l1('P'))
    favorites.list.push(group('A', 'A', 'P', [[1, 'alpha']]))
    const deferred = Promise.withResolvers<any[]>()
    vi.mocked(fetchTagTop).mockReturnValue(deferred.promise)
    const ctl = new AbortController()
    const svc = service()
    const pending = svc.loadMore(ctl.signal)
    favorites.list[0].weight = 2
    ctl.abort()
    deferred.resolve([{ bvid: 'BV-old' }])
    expect(await pending).toBeUndefined()
    expect(service().qs.bufferQueue).toHaveLength(0)
  })
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
vi.mock('../ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return { settings: { tagRec: { filter: createTagRecFactoryFilterCore(), diversityGuard: false, k: 3 } } }
})

const l1 = (id: string, extra: Partial<TagL1Group> = {}): TagL1Group => ({
  id,
  name: `L1-${id}`,
  enabled: true,
  weight: 1,
  addedAt: 0,
  ...extra,
})
const group = (id: string, name: string, l1Id: string, tagIds: readonly [number, string][]): TagGroup => ({
  id,
  name,
  l1Id,
  tag_ids: tagIds.map(([id, n]): TagIdEntry => ({ id, name: n })),
  weight: 1,
  enabled: true,
  addedAt: 0,
})
const sig = () => new AbortController().signal
const video = (bvid: string, tag?: string): AllV2VideoItem => ({ bvid, title: bvid, tag })
/** fetchTagTop mock 调用记录里的 tid 列表 */
const fetchedTids = () => vi.mocked(fetchTagTop).mock.calls.map((c) => c[0])

const resetFavSession = () => {
  tagRecFavSession.softBottom = false
  tagRecFavSession.hardBottom = false
  tagRecFavSession.digPending = false
  tagRecFavSession.digRunning = false
  tagRecFavSession.drawnGroupNames = []
  tagRecFavSession.filterStats = emptyTagRecFilterStats()
  resetTagRecFavSharedState() // 票 41: 模块级干态+深挖态跨 service 存活, 用例间需清防串态
}

// 串行: 全 suite 共享 endpoints/store mock (同 tab2 dry.test.ts 纪律)
describe('$modules/tag-rec/service/tag-rec-fav 票41 逐源干态移植', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    sediment.map.clear()
    seen.clear()
    tagRecFavSession.bypassSeen = false
    tagRecSharedSession.recoveryRevision = 0
    ;(favorites.list as TagGroup[]).length = 0
    ;(favoritesL1.list as TagL1Group[]).length = 0
    resetFavSession()
  })

  it('主题推荐刷尽后显示已看，干态和去重一起复位，保存的已看仍保留', async () => {
    favoritesL1.list.push(l1('A'))
    favorites.list.push(group('g1', '组A', 'A', [[7, 'foo']]))
    seen.add('BV-old')
    // pn=1 恒同一条 (全已见 => 零新增连击); 深页空体 = 池底即干
    vi.mocked(fetchTagTop).mockImplementation((_tid, opts) =>
      Promise.resolve(opts?.pn && opts.pn > 1 ? [] : [{ bvid: 'BV-old' }]),
    )
    const initial = new TagRecFavService()
    await initial.fetchMore(sig())
    expect(tagRecFavSession.filterStats.seenDropped).toBe(1)
    // r2 零新增 streak1 / r3 streak2 => 进 pn=2; r4 pn=2 空体 => 池底即干 + 硬见底
    for (let i = 0; i < 3; i++) await initial.fetchMore(sig())
    expect(tagRecFavSession.hardBottom).toBe(true)
    vi.mocked(fetchTagTop).mockClear()
    await initial.fetchMore(sig())
    expect(fetchedTids()).toEqual([])

    tagRecFavSession.bypassSeen = true
    const recovered = new TagRecFavService()
    expect(recovered.contextSignature).not.toBe(initial.contextSignature)
    const items = await recovered.fetchMore(sig())
    expect(items?.some((item) => item.api === EApiType.TagRec && item.bvid === 'BV-old')).toBe(true)
    expect(fetchedTids()).toEqual([7])
    expect(seen.has('BV-old')).toBe(true)
    expect(tagRecFavSession.hardBottom).toBe(false)
  })

  it('全局/L1/组放入万条过滤标签也不追加 tag/top 预热队列', async () => {
    const tags = Array.from({ length: 10_000 }, (_, i) => ({ id: i + 10_000, name: `标签${i}` }))
    const parent = l1('A', { overrides: { negative: { tagAllow: { enabled: true, list: tags } } } })
    const g = group('g1', '组A', 'A', [[7, 'foo']])
    g.negative_tag_ids = [{ id: 80, name: '原负向' }]
    g.overrides = { negative: { tagBlock: { enabled: true, list: tags } } }
    ;(favoritesL1.list as TagL1Group[]).push(parent)
    ;(favorites.list as TagGroup[]).push(g)
    const before = settings.tagRec.filter.dims.tagAllow
    settings.tagRec.filter.dims.tagAllow = { enabled: true, list: tags }
    vi.mocked(ensureTagRecNegativePools).mockClear()
    try {
      await new TagRecFavService().fetchMore(sig())
      expect(ensureTagRecNegativePools).toHaveBeenCalledExactlyOnceWith([80], expect.any(AbortSignal))
      expect(fetchedTids()).toEqual([7])
    } finally {
      settings.tagRec.filter.dims.tagAllow = before
    }
  })

  it('冷 tid 连抽两轮: 空响应即干 => 第二轮起零 tag/top 发数', async () => {
    const svc = new TagRecFavService()
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
    // fetchTagTop 恒空 => r1 后 tid7 即干
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([7])

    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig())
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([]) // 干 tid 不再重打 (冷收藏组不再每轮空放)
  })

  it('部分干只拉未干 tid', async () => {
    const svc = new TagRecFavService()
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'), l1('B'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]), group('g2', '组B', 'B', [[8, 'bar']]))
    vi.mocked(fetchTagTop).mockImplementation((tid) => Promise.resolve(tid === 7 ? [] : [{ bvid: 'BV8' }]))

    await svc.fetchMore(sig())
    expect(fetchedTids().sort()).toEqual([7, 8]) // 首轮两个 tid 都打

    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([8]) // tid7 空响应即干 => 次轮起只拉未干的 tid8
  })

  it('零新增连 2 轮进页: 首页饱和自动翻 pn=2, 三页到顶才标干', async () => {
    const svc = new TagRecFavService()
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
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

  it('全源皆干零请求空轮: 直走梯队不构成见底, 兜底堆照常放行', async () => {
    const svc = new TagRecFavService()
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))

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
    const items = await svc.fetchMore(sig()) // r2: 全干零请求 => 梯堆放行 stock (§4.4 全干≠见底)
    expect(fetchedTids()).toEqual([])
    expect(items?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['stock'])
    expect(tagRecFavSession.hardBottom).toBe(false)
    expect(tagRecFavSession.digPending).toBe(false)
  })

  it('资格指纹变 (组三态/权重变) => 干态随共享态全清: 各 tid 重获一轮机会', async () => {
    const svc = new TagRecFavService()
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))

    await svc.fetchMore(sig()) // tid7 空响应即干
    vi.mocked(fetchTagTop).mockClear()
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([]) // 全干零请求

    ;(favorites.list as TagGroup[])[0].weight = 2 // 资格字段变 => unitsFingerprint 变 => 干态全清
    await svc.fetchMore(sig())
    expect(fetchedTids()).toEqual([7]) // 干 tid 重获一轮 tag/top 机会 (与 37 共享态同生死)
  })

  it('票 44 构造期签名同步: 语境变后新 service 不放行旧境存货 (loadMore 先放队列后进 fetchMore)', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
    const svc1 = new TagRecFavService()
    await svc1.fetchMore(sig()) // 确立签名
    // 攒下未上屏存货 (深挖/兜底轮落的货)
    ;(svc1.qs.bufferQueue as unknown[]).push({ bvid: 'stock', uniqId: 'x' })

    // 语境变 (组权重) => 新 service 构造即签名同步 => 共享存货原地清零, 旧境货不端上新境首页
    ;(favorites.list as TagGroup[])[0].weight = 5
    const svc2 = new TagRecFavService()
    expect(svc2.qs.bufferQueue).toHaveLength(0)
    expect(svc1.qs.bufferQueue).toHaveLength(0) // 同一共享数组
    expect(svc2.contextSignature).not.toBe(svc1.contextSignature)
    // 同语境重建 => 存货保留 (票 37 语义不破)
    const svc3 = new TagRecFavService()
    ;(svc3.qs.bufferQueue as unknown[]).push({ bvid: 'keep', uniqId: 'y' })
    const svc4 = new TagRecFavService()
    expect(svc4.qs.bufferQueue).toHaveLength(1)
    expect(svc4.contextSignature).toBe(svc3.contextSignature)
  })
})

describe('$modules/tag-rec/service/tag-rec-fav AUDIT 回归 (15/16/17/20)', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    sediment.map.clear()
    ;(favorites.list as TagGroup[]).length = 0
    ;(favoritesL1.list as TagL1Group[]).length = 0
    resetFavSession()
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false
  })

  it('交集组与有产组同选时, 零归属库存触发深挖供 (原全局欠产门饿死交集组)', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('P'))
    // 原子直挂 'all' 根 = 真交集 (tagEvidenceBranches=2) —— 收窄到 only-allV2,
    // tag/top 单边货证明不了交集被池筛选拦死; addTagRecCondition 会并成 any 行 ≠ 交集
    const combo = newTagRecCombination()
    combo.include.children.push(
      tagRecConditionAtom('tag', { id: 1, name: '原神' }),
      tagRecConditionAtom('tag', { id: 2, name: 'cos' }),
    )
    ;(favorites.list as TagGroup[]).push(
      {
        ...group('X', '交集', 'P', [
          [1, '原神'],
          [2, 'cos'],
        ]),
        combination: combo,
      },
      group('Y', '普通', 'P', [[9, 'other']]),
    )
    // Y 的 tag/top 高产顶过 triggerYield; X 收窄到 allV2 后 tag/top 不取源,
    // 归属库存恒零 —— 修复前全局产出闸门让深挖流永不点火 (实机零产出)
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve(
        tid === 9 ? Array.from({ length: 32 }, (_, i) => ({ bvid: `BVy${i}` })) : [{ bvid: `BVx${tid}` }],
      ),
    )
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))
    const svc = new TagRecFavService()
    const first = await svc.loadMore(sig())
    expect(first?.length).toBeGreaterThan(0) // 本轮全局产出健康 —— 修复前梯队整体不开火
    for (let i = 0; i < 8 && !vi.mocked(fetchAllV2Search).mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 0))
    // 断言到关键词级: 交集组的流 ('原神'/'cos' 单词流或 '原神 cos' 组合词流) 必须在挖 —
    // 防"梯队开了火但开错流"的假阳性 (Y 的 'other' 顺带被挖无害: needed 视图滞后一轮,
    // 本轮未入队时它仍算欠水位, 是既有浅水位语义不是本改动的偏差)
    const keywords = vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])
    expect(keywords.length).toBeGreaterThan(0)
    expect(keywords.some((k) => k.includes('原神') || k.includes('cos'))).toBe(true)
    waiters.forEach((r) => r([]))
    await (svc as any).ladder.digRunning
  })

  it('共享 tid 条目被别组资格放行时不误算本组供货 —— fed 同域 claims ∩ eligibleGroupKeys', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('P'))
    // G=all{tag:foo, title:zzz}: 非交集配方照常抽 tag/top; 同 tid=1 与 H 合并归因;
    //   条目对 G mismatch (title 不含 zzz) => eligibleGroupKeys 只剩 H =>
    //   裸认 claims 会把 G 误判"已喂" => 深挖永不开火 (G 归属库存恒零)
    const combo = newTagRecCombination()
    combo.include.children.push(tagRecConditionAtom('tag', { id: 1, name: 'foo' }), tagRecConditionAtom('title', 'zzz'))
    ;(favorites.list as TagGroup[]).push(
      { ...group('G', '配方组', 'P', [[1, 'foo']]), combination: combo },
      group('H', '普通组', 'P', [[1, 'foo']]),
    )
    // 高产顶过 triggerYield; 全对 G 剥资格 —— 修复前 fed 认 claims 记 G 已供 => 闸不开
    //   (title 字段必须存在: 无标题条目 title 原子判 unknown 即 defer 放行, 剥不了资格)
    vi.mocked(fetchTagTop).mockResolvedValue(
      Array.from({ length: 32 }, (_, i) => ({ bvid: `BVs${i}`, title: `视频${i}` })),
    )
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))
    const svc = new TagRecFavService()
    const first = await svc.loadMore(sig())
    expect(first?.length).toBeGreaterThan(0)
    for (let i = 0; i < 8 && !vi.mocked(fetchAllV2Search).mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 0))
    // 挖的是 G 的流: 'foo' 单边词 (G/H 共享归一源) 或 'zzz' 文本种子流
    const keywords = vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])
    expect(keywords.some((k) => k === 'foo' || k === 'zzz')).toBe(true)
    waiters.forEach((r) => r([]))
    await (svc as any).ladder.digRunning
  })

  it('AUDIT-17: 浅水位 preDig 后台化 —— fetchMore 不押深挖批落定即返回本轮产出', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVt' }]) // 产出 1 => 浅水位 (<triggerYield)
    const waiters: ((v: AllV2VideoItem[]) => void)[] = [] // 深挖批 3 页并发 —— 收集全部 resolver
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const svc = new TagRecFavService()
    let finished = false
    const p = svc.fetchMore(sig()).then((items) => ((finished = true), items))
    // 微任务全落定即应返回 —— 若仍 await preDig, fetchMore 被挂起批卡死 (finished 恒 false)
    for (let i = 0; i < 5 && !finished; i++) await new Promise((r) => setTimeout(r, 0))
    expect(finished).toBe(true)
    expect((await p)?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['BVt'])
    expect(fetchAllV2Search).toHaveBeenCalled() // 深挖已点火后台在途

    waiters.forEach((r) => r([])) // 收尾释放整批在途页防悬挂
    await (svc as any).ladder.digRunning
  })

  it('收编票: fetch 闸 abort 不废同股已付页; 退避期拒发', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
    const svc = new TagRecFavService()
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['组A'] })
    const ctl = new AbortController()
    ;(svc as any).lastFetchSignal = ctl.signal // digMore 批生命周期随当前 fetch 闸 (无 fetch 过则无闸)

    // 页请求发出即 abort (service 被弃): 同股盒未换 => 已完成页照常收编, 不再作废重拉
    vi.mocked(fetchAllV2Search).mockImplementation(() => {
      ctl.abort()
      return Promise.resolve([video('BVx', 'foo')])
    })
    await svc.digMore()
    // 同股收编契约 = 已付页入账不重拉 (游标+sediment); 条目按活 resolver 路由
    expect((svc as any).ladder.streams.get('foo').nextPage).toBe(4)
    expect(sediment.noteDig).toHaveBeenCalled()

    // 退避门: 风控时手动 dig 拒发 (对齐 tab2 票 38-C)
    vi.mocked(fetchAllV2Search).mockClear()
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    try {
      await svc.digMore()
      expect(fetchAllV2Search).not.toHaveBeenCalled()
      expect(tagRecFavSession.digRunning).toBe(false)
    } finally {
      ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false
    }
  })

  it('AUDIT-16: 资格指纹漂移后弃实例 digMore 收尾不写共享 session', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(group('g1', '组A', 'A', [[7, 'foo']]))
    const svc = new TagRecFavService()
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['组A'] })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = [] // 一批 3 页并发 —— 收集全部 resolver
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p = svc.digMore()
    expect(tagRecFavSession.digRunning).toBe(true) // 非 stale 时照常置在途标

    ;(favorites.list as TagGroup[])[0].weight = 9 // 资格指纹漂移 => 本实例 stale
    waiters.forEach((r) => r([])) // 空页挖穿 => 语境结论位 (hardBottom/digPending) 须被 stale 门拦
    await p
    // A4-5: 在途标是「本实例置的旗」非语境结论 —— 共享盒无新挖接管时弃实例必须摘掉,
    //   否则镜像永 true 卡死 banner loading; (有新语境在挖时由在途闸保它不摘, 归新 service 管)
    expect(tagRecFavSession.digRunning).toBe(false)
    expect(tagRecFavSession.hardBottom).toBe(false)
    expect(tagRecFavSession.digPending).toBe(false)
  })

  it('AUDIT-20: >10 id 大组轮转游标升共享盒 —— service 重建不重拉首片, ids 11..N 不饿死', async () => {
    ;(favoritesL1.list as TagL1Group[]).push(l1('A'))
    ;(favorites.list as TagGroup[]).push(
      group(
        'g1',
        '大组',
        'A',
        Array.from({ length: 12 }, (_, i) => [i + 1, `t${i + 1}`] as [number, string]),
      ),
    )

    const svc1 = new TagRecFavService()
    await svc1.fetchMore(sig())
    expect(fetchedTids().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // 首片

    // 同指纹重建 (重抽/刷新): 旧实现实例级游标归零 => 永远重拉首片 (ids 11..N 饿死)
    const svc2 = new TagRecFavService()
    vi.mocked(fetchTagTop).mockClear()
    await svc2.fetchMore(sig())
    expect(fetchedTids().sort((a, b) => a - b)).toEqual([11, 12]) // 游标随共享盒续进第二片
  })
})
