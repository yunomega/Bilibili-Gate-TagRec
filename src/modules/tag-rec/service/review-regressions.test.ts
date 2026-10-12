import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType, ETab } from '$enums'
import { refreshForGrid } from '$modules/rec-services'
import { settings } from '$modules/settings'
import { fetchAllV2Search, fetchTagInfoByName, fetchTagTop, fetchVideoTags } from '$modules/tag-rec/api/endpoints'
import { fetchUpSearchPage } from '$modules/tag-rec/api/up-search'
import { UpSearchPausedError } from '$modules/tag-rec/api/up-search-gate'
import { makeTagGroup } from '$modules/tag-rec/model/favorites'
import {
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  evalTagRecItem,
  runTagRecFilter,
} from '$modules/tag-rec/model/filter-engine'
import { TAG_REC_SOURCE_FAILURE_MAX_RETRIES } from '$modules/tag-rec/service/_pipeline' // R09-fix
import { resetTagRecCustomSharedState, TagRecCustomService } from '$modules/tag-rec/service/tag-rec-custom'
import { resetTagRecFavSharedState, TagRecFavService } from '$modules/tag-rec/service/tag-rec-fav'
import { favorites, favoritesL1, sediment, seen } from '$modules/tag-rec/store'
import {
  emptyTagRecFilterStats,
  switchTagRecGroupContext,
  tagRecCustomSession,
  tagRecFavSession,
  tagRecSharedSession,
} from '$modules/tag-rec/store/session'
import type { TagRecItemExtend } from '$define'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_CLS_TAB_BAR: 'audit', baseDebug: { extend: () => vi.fn() } }))
vi.mock('$components/RecGrid/useShortcut', () => ({ getColumnCount: () => 1 }))
vi.mock('$modules/filter', () => ({ filterRecItems: (items: any[]) => items }))
vi.mock('$modules/filter/normalize', () => ({ normalizeCardData: (item: any) => ({ bvid: item.bvid }) }))
vi.mock('$modules/rec-services/app', () => ({ AppRecService: class {} }))
vi.mock('$modules/rec-services/pc', () => ({ PcRecService: class {} }))
vi.mock('$modules/rec-services/service-map', () => ({ isRecTab: () => false }))
vi.mock('$modules/rec-services/dynamic-feed/api/enums', () => ({ DynamicFeedItemHelper: {} }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/tag-rec/api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTags: vi.fn(() => Promise.resolve([{ tag_id: 99, tag_name: 'blocked' }])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('$modules/tag-rec/api/video-tags-store', () => ({
  persistVideoTags: vi.fn(() => Promise.resolve()),
  getPersistedVideoTags: vi.fn(() => Promise.resolve(undefined)),
  evictPersistedVideoTags: vi.fn(() => Promise.resolve()),
}))
vi.mock('$modules/tag-rec/api/up-search', () => ({ fetchUpSearchPage: vi.fn() }))
vi.mock('$modules/tag-rec/api/dry-tids-store', () => ({
  isPersistedDryTid: () => false,
  persistDryTid: vi.fn(() => Promise.resolve()),
}))
vi.mock('$modules/tag-rec/api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, currentIntervalMs: 0, lastRecoveredAt: 0, recentlyRecovered: () => false },
  isRiskControlError: () => false,
}))
vi.mock('$modules/tag-rec/store', () => {
  const list: any[] = []
  return {
    favorites: {
      list,
      addTagIdsToGroup: vi.fn((gid: string, entries: any[]) => {
        const group = list.find((g) => g.id === gid)
        group?.tag_ids.push(...entries)
        return { added: entries.length, skipped: 0, moved: 0, alsoIn: [] }
      }),
    },
    favoritesStore: { list },
    favoritesL1: { list: [] },
    favoritesL1Store: { list: [] },
    themes: { list: [], active: undefined },
    viewScope: { viewedL1Ids: () => undefined },
    seen: new Set<string>(),
    sediment: { map: new Map(), merge: vi.fn(), confirm: vi.fn(), noteDig: vi.fn() },
  }
})
// REAL negative-slice: only IO mocked. Existing service suites replace its complete behavior.
vi.mock('$modules/tag-rec/ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))
vi.mock('$modules/tag-rec/ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('$modules/tag-rec/service/share-like', () => ({ noteShareLikeDelivered: vi.fn() }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('$modules/tag-rec/model/filter-engine')
  const filter = createTagRecFactoryFilterCore()
  filter.dims.likeRate.enabled = false
  return { settings: { tagRec: { filter, diversityGuard: false, k: 3 } } }
})

const item = (bvid: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['A', 'B'], groupIds: ['A', 'B'] },
})
const group = (id: string, strict = false) =>
  makeTagGroup({
    id,
    name: `组${id}`,
    tag_ids: [{ id: id === 'A' ? 1 : 2, name: id === 'A' ? 'alpha' : 'beta' }],
    ...(strict ? { negative_tag_ids: [{ id: 99, name: 'blocked' }], negative_strict: true } : {}),
  })!
const signal = () => new AbortController().signal

describe('audit: service contracts with real final strict slice', () => {
  beforeEach(() => {
    settings.tagRec.filter = { ...settings.tagRec.filter, ...createTagRecFactoryFilterCore() }
    settings.tagRec.filter.dims.likeRate.enabled = false
    favorites.list.length = 0
    favoritesL1.list.length = 0
    seen.clear()
    sediment.map.clear()
    switchTagRecGroupContext(undefined)
    tagRecCustomSession.filterOverride = undefined
    tagRecCustomSession.filterStats = emptyTagRecFilterStats()
    tagRecFavSession.filterStats = emptyTagRecFilterStats()
    tagRecFavSession.bypassSeen = false
    tagRecCustomSession.bypassSeen = false
    tagRecSharedSession.tempEnabledL1Ids = []
    delete (settings.tagRec as Record<string, unknown>).ladder
    resetTagRecCustomSharedState()
    resetTagRecFavSharedState()
    vi.mocked(fetchTagInfoByName).mockReset().mockResolvedValue(undefined)
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTags)
      .mockReset()
      .mockResolvedValue([{ tag_id: 99, tag_name: 'blocked' }])
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchUpSearchPage).mockReset().mockResolvedValue({ items: [], hasMore: false })
  })

  const upGroup = () => {
    const a = group('A')
    a.l1Id = 'P'
    a.overrides = { negative: { upAllow: { enabled: true, list: [{ mid: 7, name: 'UP7' }] } } }
    favorites.list.push(a)
    favoritesL1.list.push({ id: 'P', name: '父组', enabled: true, weight: 1, addedAt: 0 })
    switchTagRecGroupContext('A')
    return a
  }
  const upPage = (page: number, length = 30) =>
    Array.from({ length }, (_, i) => ({
      bvid: `BV-up-${page}-${i}`,
      title: 'alpha 投稿',
      owner: { mid: 7, name: 'UP7' },
      stat: { view: 100 },
    }))
  const upServices = [
    { name: '主题推荐', Service: TagRecFavService, session: tagRecFavSession },
    { name: '标签发掘', Service: TagRecCustomService, session: tagRecCustomSession },
  ]

  const stockService = (Service: typeof TagRecFavService | typeof TagRecCustomService) => {
    const a = group('A')
    a.l1Id = 'P'
    favorites.list.push(a)
    favoritesL1.list.push({ id: 'P', name: '父组', enabled: true, weight: 1, addedAt: 0 })
    switchTagRecGroupContext('A')
    const svc = new Service()
    svc.hasMoreExceptQueue = false
    return svc
  }
  const stockItem = (n: number): TagRecItemExtend => ({
    ...item(`BV-stock-${n}`),
    title: n % 2 ? '丢弃关键词' : '保留关键词',
    score: 1000 - n,
    stat: { view: 1000 + n * 100, like: 100, favorite: 10, coin: 1, danmaku: 2, reply: 3, share: 1 },
    source: { via: 'tag-top', groupIds: ['A'], groupNames: ['组A'] },
  })

  it.each(upServices.flatMap((entry) => [false, true].map((bypass) => ({ ...entry, bypass }))))(
    '$name: recovered candidates honor only this tab show-seen setting ($bypass)',
    ({ Service, session, bypass }) => {
      const svc = stockService(Service)
      session.bypassSeen = bypass
      const other = session === tagRecFavSession ? tagRecCustomSession : tagRecFavSession
      other.bypassSeen = !bypass
      const raw = { ...stockItem(0), title: 'alpha video', stat: { view: 10 }, ownTagIds: [1] }
      seen.add(raw.bvid)
      settings.tagRec.filter.dims.viewMin = { enabled: true, value: 1_000 }
      expect((svc as any).applyStages([raw])).toEqual([])
      settings.tagRec.filter.dims.viewMin.enabled = false
      ;(svc as any).refilterSharedQueue()
      expect(svc.qs.bufferQueue.map((video) => video.api === EApiType.TagRec && video.bvid)).toEqual(
        bypass ? [raw.bvid] : [],
      )
      expect(fetchTagTop).not.toHaveBeenCalled()
      expect(fetchAllV2Search).not.toHaveBeenCalled()
    },
  )

  it.each(upServices)('$name：严格补查新增的标签证据会在交付前重新排序', async ({ Service }) => {
    const svc = stockService(Service)
    settings.tagRec.filter.dims.tagAllow = {
      enabled: true,
      list: [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ],
      strict: true,
    }
    const low = {
      ...stockItem(0),
      title: 'alpha 内容',
      source: { via: 'all-v2-related' as const, groupNames: ['组A'], groupIds: ['A'] },
      stat: { view: 1000, like: 0, favorite: 0, coin: 0, danmaku: 0, reply: 0 },
    }
    const high = {
      ...stockItem(1),
      title: 'alpha 内容',
      source: low.source,
      stat: { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 },
    }
    vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
      Promise.resolve(bvid === low.bvid ? [{ tag_id: 1, tag_name: 'alpha' }] : [{ tag_id: 2, tag_name: 'beta' }]),
    )
    const staged = (svc as any).applyStages([low, high])
    expect(staged.map((it: TagRecItemExtend) => it.bvid)).toEqual([high.bvid, low.bvid])
    svc.qs.bufferQueue.push(...staged)
    const delivered = await svc.loadMore(signal())
    expect(delivered?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual([low.bvid, high.bvid])
    expect(fetchVideoTags).toHaveBeenCalledTimes(2)
  })

  it('严格核查沿用组×来源池深，另一个大池不能让冷池在出队时被质量门槛挡掉', async () => {
    const svc = stockService(TagRecFavService)
    const b = group('B')
    b.l1Id = 'P'
    favorites.list.push(b)
    // 对齐资格语境后再入原料，避免语境切换的正常清缓存路径。
    const active = new TagRecFavService()
    active.hasMoreExceptQueue = false
    settings.tagRec.filter.dims.likeRate.enabled = true
    settings.tagRec.filter.dims.tagAllow = { enabled: true, list: [{ id: 1, name: 'alpha' }], strict: true }
    const make = (n: number, id: string): TagRecItemExtend => ({
      ...stockItem(n),
      source: { via: 'tag-top', groupNames: [`组${id}`], groupIds: [id], tagIds: [id === 'A' ? 1 : 2] },
      stat: { view: 1000, like: 0 },
    })
    const cold = make(100, 'B')
    const staged = (active as any).applyStages([...Array.from({ length: 40 }, (_, i) => make(i, 'A')), cold])
    expect(staged.map((it: TagRecItemExtend) => it.bvid)).toEqual([cold.bvid])
    active.qs.bufferQueue.push(...staged)
    vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 1, tag_name: 'alpha' }])
    expect((await active.loadMore(signal()))?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual([cold.bvid])
    expect(svc.qs.bufferQueue).toEqual([])
  })

  it.each(upServices)('$name：后来的直接标签命中能提升堆内同 BV 候选', async ({ Service }) => {
    const svc = stockService(Service)
    const related = {
      ...stockItem(0),
      bvid: 'BV-promoted',
      source: { via: 'all-v2-related' as const, groupNames: ['组A·相关'], groupIds: ['A'] },
      ownTagNames: ['other'],
    }
    const ladder = (svc as any).ladder
    ladder.heap.push(related)
    ;(svc as any).seenBvids.add(related.bvid)
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: related.bvid, title: 'alpha', stat: { view: 100 } }])
    const result = await svc.fetchMore(signal())
    const candidates = [...(result ?? []), ...svc.qs.bufferQueue].filter(
      (it): it is TagRecItemExtend => it.api === EApiType.TagRec,
    )
    const promoted = candidates.find((it) => it.bvid === related.bvid)!
    expect(promoted).toBeDefined()
    expect(promoted.source.via).toBe('tag-top')
    expect(promoted.relevance?.tier).toBe(2)
    expect(promoted.source.claims?.map((claim) => claim.via)).toEqual(['all-v2-related', 'tag-top'])
    expect(ladder.heap.some((it: TagRecItemExtend) => it.bvid === related.bvid)).toBe(false)
  })

  it.each(upServices)('$name：严格核查挡住的候选在临时解除条件后能恢复', async ({ Service, session }) => {
    const svc = stockService(Service)
    settings.tagRec.filter.dims.tagAllow = { enabled: true, list: [{ id: 1, name: 'alpha' }], strict: true }
    const raw = {
      ...stockItem(0),
      source: { via: 'tag-top' as const, groupNames: ['组A'], groupIds: ['A'], tagIds: [1] },
      ownTagIds: undefined,
      ownTagNames: undefined,
    }
    const staged = (svc as any).applyStages([raw])
    svc.qs.bufferQueue.push(...staged)
    expect(await svc.loadMore(signal())).toEqual([])
    session.filterOverride = { dims: { tagAllow: { enabled: false, list: [] } } }
    const restored = new Service()
    restored.hasMoreExceptQueue = false
    expect((await restored.loadMore(signal()))?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual([raw.bvid])
    expect(fetchVideoTags).toHaveBeenCalledTimes(1)
  })

  it.each(upServices)(
    '$name：放宽后从已消费深挖页恢复候选，不重取页面、不恢复已交付视频',
    async ({ Service, session }) => {
      const svc = stockService(Service)
      settings.tagRec.filter.dims.viewMin = { enabled: true, value: 1000 }
      // 先同步当前阈值，随后让真实深挖与真实过滤管线消费页面。
      const active = new Service()
      active.hasMoreExceptQueue = false
      const ladder = (active as any).ladder
      ladder.addStream({ key: 'alpha', keyword: 'alpha', attribution: ['组A'], groupIds: ['A'] })
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce([
        { bvid: 'BV-deferred', title: 'alpha 视频', tag: 'alpha', play: 100, like: 0 },
      ])
      await ladder.digPass('manual', signal())
      expect(active.qs.bufferQueue).toHaveLength(0)
      const stream = ladder.streams.get('alpha')
      const nextPage = stream.nextPage
      const requests = vi.mocked(fetchAllV2Search).mock.calls.length
      expect(requests).toBeGreaterThan(0)
      expect(session.filterStats.dropped).toBeGreaterThan(0)
      ladder.earlyStopped = true
      ladder.autoDigs = 3

      session.filterOverride = { dims: { viewMin: { enabled: false, value: 1000 } } }
      const restored = new Service()
      restored.hasMoreExceptQueue = false
      expect(restored.qs.bufferQueue).toHaveLength(1)
      const delivered = await restored.loadMore(signal())
      expect(delivered?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual(['BV-deferred'])
      expect(stream.nextPage).toBe(nextPage)
      expect(fetchAllV2Search).toHaveBeenCalledTimes(requests)
      expect(ladder.earlyStopped).toBe(false)
      expect(ladder.autoDigs).toBe(3) // 本地恢复不退还已付自动轮次。
      const afterDelivery = new Service()
      expect(afterDelivery.qs.bufferQueue).toHaveLength(0)
      expect(svc.qs.bufferQueue).toHaveLength(0)
    },
  )

  it.each(upServices)('$name 同一实例下一批按临时仅看重筛已有库存', async ({ Service, session }) => {
    const svc = stockService(Service)
    svc.qs.bufferQueue.push(...Array.from({ length: 60 }, (_, n) => stockItem(n)))
    expect(await svc.loadMore(signal())).toHaveLength(20)
    session.filterOverride = { dims: { titleAllow: { enabled: true, list: ['保留关键词'] } } }
    const delivered = await svc.loadMore(signal())
    expect(delivered).toHaveLength(20)
    expect(delivered?.every((video) => video.api === EApiType.TagRec && video.title === '保留关键词')).toBe(true)
    expect(svc.qs.bufferQueue).toHaveLength(0)
    expect(settings.tagRec.filter.dims.titleAllow.enabled).toBe(false)
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name 改评分权重后已有库存重算并重排，下一批不沿用旧分', async ({ Service, session }) => {
    const svc = stockService(Service)
    svc.qs.bufferQueue.push(...Array.from({ length: 60 }, (_, n) => stockItem(n)))
    expect(await svc.loadMore(signal())).toHaveLength(20)
    session.filterOverride = {
      dims: {},
      score: {
        weights: {
          view: 1,
          likeRate: 0,
          favRate: 0,
          coinRate: 0,
          interactRate: 0,
        },
      },
    }
    const delivered = await svc.loadMore(signal())
    const videos = delivered?.filter((video): video is TagRecItemExtend => video.api === EApiType.TagRec) ?? []
    expect(videos).toHaveLength(20)
    expect(videos[0].bvid).toBe('BV-stock-59')
    expect(videos.at(-1)!.bvid).toBe('BV-stock-40')
    expect(videos.every((video, n) => !n || video.score! <= videos[n - 1].score!)).toBe(true)
    expect(videos.every((video) => video.score! < 100)).toBe(true)
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('主题推荐同范围重刷和权重调整保留临时差分，参与组切换时清除', () => {
    stockService(TagRecFavService)
    tagRecFavSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['临时关键词'] } } }
    tagRecFavSession.tempWriteLog.push({ kind: 'titleAllow', value: '临时关键词', label: 'l', owningGroupNames: [] })
    const patch = tagRecFavSession.filterOverride
    new TagRecFavService()
    expect(tagRecFavSession.filterOverride).toBe(patch)
    favorites.list[0].weight = 2
    new TagRecFavService()
    expect(tagRecFavSession.filterOverride).toBe(patch)
    favorites.list[0].enabled = false
    new TagRecFavService()
    expect(tagRecFavSession.filterOverride).toBeUndefined()
    expect(tagRecFavSession.tempWriteLog).toEqual([])
  })

  it.each(upServices)('$name 仅看 UID 从 UP 投稿取数，库存复用，勋章不冒充视频标签', async ({ Service }) => {
    upGroup()
    vi.mocked(fetchUpSearchPage).mockResolvedValue({ items: upPage(1), hasMore: false })
    const svc = new Service()
    const delivered = await svc.loadMore(signal())
    expect(delivered).toHaveLength(20)
    for (const video of delivered ?? []) {
      expect(video.api).toBe(EApiType.TagRec)
      if (video.api !== EApiType.TagRec) continue
      expect(video.source).toMatchObject({
        via: 'up-search',
        queryKeyword: 'alpha',
        attributionLabels: ['父组 › 组A › 搜索「alpha」'],
      })
      expect(video.source.tagIds).toBeUndefined()
      expect(video.ownTagNames).toBeUndefined()
      expect(video.ownTagIds).toBeUndefined()
    }
    expect(await svc.loadMore(signal())).toHaveLength(10)
    expect(svc.hasMore).toBe(false)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    expect(fetchUpSearchPage).toHaveBeenCalledWith(7, 'alpha', 1, expect.any(AbortSignal))
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name UP 关键词零命中只查一页，不转全站兜底', async ({ Service }) => {
    upGroup()
    const svc = new Service()
    const delivered = await svc.loadMore(signal())
    expect(delivered?.filter((video) => video.api === EApiType.TagRec)).toEqual([])
    expect(svc.hasMore).toBe(false)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name UP 自动三页后停，手动继续沿原页码取数', async ({ Service, session }) => {
    upGroup()
    vi.mocked(fetchUpSearchPage).mockImplementation((_mid, _keyword, page) =>
      Promise.resolve({ items: upPage(page, 20), hasMore: true }),
    )
    const svc = new Service()
    for (let page = 1; page <= 3; page++) expect(await svc.loadMore(signal())).toHaveLength(20)
    expect(svc.hasMore).toBe(false)
    expect(session.digPending).toBe(true)
    await svc.loadMore(signal())
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(3)
    await svc.digMore()
    expect(await svc.loadMore(signal())).toHaveLength(20)
    expect(fetchUpSearchPage).toHaveBeenLastCalledWith(7, 'alpha', 4, expect.any(AbortSignal))
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name 风控失败不自动重试，也不误报 UP 没有投稿', async ({ Service, session }) => {
    upGroup()
    vi.mocked(fetchUpSearchPage).mockRejectedValue(new UpSearchPausedError(Date.now() + 300_000))
    const svc = new Service()
    await expect(svc.loadMore(signal())).rejects.toBeInstanceOf(UpSearchPausedError)
    const retried = await svc.loadMore(signal())
    expect(retried).toEqual([])
    expect(session.digPending).toBe(true)
    expect(session.hardBottom).toBe(false)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name 普通组与定向组共存，只给普通组请求 tag/top', async ({ Service }) => {
    upGroup()
    const b = group('B')
    b.l1Id = 'P'
    favorites.list.push(b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    vi.mocked(fetchUpSearchPage).mockResolvedValue({ items: upPage(1), hasMore: false })
    vi.mocked(fetchTagTop).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        bvid: `BV-normal-${i}`,
        title: 'beta',
        owner: { mid: 8, name: 'UP8' },
        stat: { view: 100 },
      })),
    )
    const svc = new Service()
    const delivered = await svc.loadMore(signal())
    expect(delivered).toHaveLength(20)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    expect(fetchTagTop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchTagTop).mock.calls[0]?.[0]).toBe(2)
    for (const call of vi.mocked(fetchAllV2Search).mock.calls) expect(call[0]).not.toBe('alpha')
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it.each(upServices)('$name 混合组均无结果会结束，不被未用的 UP 标签干态拖入空转', async ({ Service }) => {
    upGroup()
    const b = group('B')
    b.l1Id = 'P'
    favorites.list.push(b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    const svc = new Service()
    const fetch = svc.fetchMore.bind(svc)
    let rounds = 0
    vi.spyOn(svc, 'fetchMore').mockImplementation((abortSignal) => {
      if (++rounds > 12) throw new Error('混合组陷入空转')
      return fetch(abortSignal)
    })
    await refreshForGrid({
      tab: Service === TagRecFavService ? ETab.TagRecFav : ETab.TagRecCustom,
      service: svc,
      abortSignal: signal(),
    })
    expect(svc.hasMore).toBe(false)
    expect(rounds).toBeLessThan(12)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    for (const call of vi.mocked(fetchAllV2Search).mock.calls) expect(call[0]).not.toBe('alpha')
  })

  it.each(upServices)('$name 普通组耗尽仍保留 UP 手动续页入口', async ({ Service, session }) => {
    upGroup()
    const b = group('B')
    b.l1Id = 'P'
    favorites.list.push(b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    vi.mocked(fetchUpSearchPage).mockImplementation((_mid, _keyword, page) =>
      Promise.resolve({ items: upPage(page, 20), hasMore: true }),
    )
    const svc = new Service()
    for (let page = 1; page <= 3; page++) expect(await svc.loadMore(signal())).toHaveLength(20)
    await svc.loadMore(signal())
    expect(svc.hasMore).toBe(false)
    expect(session.digPending).toBe(true)
    expect(session.hardBottom).toBe(false)
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(3)
    await svc.digMore()
    const continued = await svc.loadMore(signal())
    expect(continued).toHaveLength(20)
    expect(continued?.every((item) => item.api === EApiType.TagRec && item.bvid.startsWith('BV-up-4-'))).toBe(true)
    // 下一页后台预取可先于异步交付收尾；验证实际续页，不依赖微任务顺序。
    expect(fetchUpSearchPage).toHaveBeenCalledWith(7, 'alpha', 4, expect.any(AbortSignal))
  })

  it.each([
    { name: '主题推荐', Service: TagRecFavService, enabled: true },
    { name: '主题推荐', Service: TagRecFavService, enabled: false },
    { name: '标签发掘', Service: TagRecCustomService, enabled: true },
    { name: '标签发掘', Service: TagRecCustomService, enabled: false },
  ])('$name 交付勋章子标签，过滤 enabled=$enabled，无额外请求', async ({ Service, enabled }) => {
    const a = group('A')
    const b = group('B')
    a.l1Id = b.l1Id = 'P'
    favorites.list.push(a, b)
    favoritesL1.list.push({ id: 'P', name: '父组', enabled: true, weight: 1, addedAt: 0 })
    settings.tagRec.filter.enabled = enabled
    switchTagRecGroupContext('A')
    const svc = new Service()
    svc.hasMoreExceptQueue = false
    const stock = Array.from({ length: 20 }, (_, i) => {
      const video = item(`BV-badge-${i}`)
      video.source.tagIds = [1, 2]
      return video
    })
    svc.qs.bufferQueue.push(...stock)
    const delivered = await svc.loadMore(signal())
    expect(delivered).toHaveLength(20)
    for (const video of delivered ?? []) {
      expect(video.api).toBe(EApiType.TagRec)
      if (video.api !== EApiType.TagRec) continue
      expect(video.source.attributionLabels).toEqual(['父组 › 组A › alpha', '父组 › 组B › beta'])
      expect(video.source.attributionPaths).toEqual(
        Service === TagRecFavService
          ? ['未归属 › 父组 › 组A › alpha', '未归属 › 父组 › 组B › beta']
          : ['父组 › 组A › alpha', '父组 › 组B › beta'],
      )
    }
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('strict slice preserves the complete allowing source chain', async () => {
    favorites.list.push(group('A', true), group('B'))
    const video = item('BV-shared')
    const resolve = createTagRecScopeResolver({
      core: settings.tagRec.filter,
      groupsById: new Map(favorites.list.map((g) => [g.id, g])),
    })
    expect(evalTagRecItem(video, resolve, { poolSize: 1 }).pass).toBe(true)
    const svc = new TagRecFavService()
    svc.qs.bufferQueue.push(video)
    expect((await svc.loadMore(signal()))?.some((it) => it.api === EApiType.TagRec && it.bvid === 'BV-shared')).toBe(
      true,
    )
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('a chain rejected by numeric conditions cannot rescue a strict-rejected chain', async () => {
    const a = group('A', true)
    const b = group('B')
    b.overrides = { dims: { viewMin: { enabled: true, value: 1000 } } }
    favorites.list.push(a, b)
    const video = item('BV-numeric')
    video.stat.view = 10
    const resolve = createTagRecScopeResolver({
      core: settings.tagRec.filter,
      groupsById: new Map(favorites.list.map((g) => [g.id, g])),
    })
    const svc = new TagRecFavService()
    svc.qs.bufferQueue.push(...runTagRecFilter([video], { resolve, poolSize: 40 }).items)
    expect(await svc.loadMore(signal())).toEqual([])
    expect(fetchVideoTags).toHaveBeenCalledTimes(1)
  })

  const strictStockService = () => {
    const a = group('A', true)
    const b = group('B')
    a.l1Id = b.l1Id = 'P'
    favorites.list.push(a, b)
    favoritesL1.list.push({ id: 'P', name: '父组', enabled: true, weight: 1, addedAt: 0 })
    const svc = new TagRecFavService()
    svc.hasMoreExceptQueue = false // 只检验已有库存的严格出队，避免供给请求干扰。
    for (const id of ['A', 'B'])
      for (let n = 0; n < 60; n++)
        svc.qs.bufferQueue.push({
          ...item(`BV-${id}-${n}`),
          score: 1000 - n,
          source: { via: 'tag-top', groupIds: [id], groupNames: [`组${id}`] },
        })
    return svc
  }
  const deliveredCounts = (items: Awaited<ReturnType<TagRecFavService['loadMore']>>) => {
    const counts: Record<string, number> = {}
    for (const it of items ?? [])
      if (it.api === EApiType.TagRec) {
        const id = it.source.groupIds![0]
        counts[id] = (counts[id] ?? 0) + 1
      }
    return counts
  }

  it('严格拒绝不占份额，严格通过的标签副本仍记账，补满后下一批保持混排', async () => {
    ;(settings.tagRec as Record<string, unknown>).ladder = { verifyRequests: 20 }
    const svc = strictStockService()
    vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
      Promise.resolve([{ tag_id: Number(bvid.split('-').at(-1)) < 10 ? 99 : 1, tag_name: 'checked' }]),
    )
    const first = await svc.loadMore(signal())
    expect(deliveredCounts(first)).toEqual({ A: 10, B: 10 })
    expect(
      first
        ?.filter((it) => it.api === EApiType.TagRec && it.source.groupIds?.[0] === 'A')
        .every((it) => (it as TagRecItemExtend).ownTagIds?.includes(1)),
    ).toBe(true)
    expect(tagRecFavSession.filterStats.dropped).toBe(10)
    // 审计 §1: 严格核查并入整次刷新共享预算 —— 两次补位共 20 次核查耗尽额度后
    //   自动补位暂停待决 (旧契约: 每批自立时间盒, 外层可反复领额度无限补查)
    expect(tagRecFavSession.partitionPaused).toBe(true)
    // 停牌不再闩装载: 下一轮自立预算继续核查+交付 (无需手动恢复)
    expect(deliveredCounts(await svc.loadMore(signal()))).toEqual({ A: 10, B: 10 })
    svc.retryPartitions()
    expect(deliveredCounts(await svc.loadMore(signal()))).toEqual({ A: 10, B: 10 })
    expect(svc.qs.bufferQueue).toHaveLength(50) // 120 - 10拒绝 - 60交付
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('第二次严格补位中止时，首批未交付的库存、份额和滤除计数都不提交', async () => {
    const svc = strictStockService()
    const original = [...svc.qs.bufferQueue]
    const enteredRefill = Promise.withResolvers<void>()
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof fetchVideoTags>>>()
    vi.mocked(fetchVideoTags).mockImplementation((bvid) => {
      if (Number(bvid.split('-').at(-1)) < 10) return Promise.resolve([{ tag_id: 99, tag_name: 'blocked' }])
      enteredRefill.resolve()
      return deferred.promise
    })
    const ctl = new AbortController()
    const pending = svc.loadMore(ctl.signal)
    await enteredRefill.promise
    ctl.abort()
    deferred.resolve([])
    expect(await pending).toBeUndefined()
    expect(svc.qs.bufferQueue).toEqual(original)
    expect(tagRecFavSession.filterStats.dropped).toBe(0)
    vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 1, tag_name: 'allowed' }])
    expect(deliveredCounts(await svc.loadMore(signal()))).toEqual({ A: 10, B: 10 })
  })

  it('selected-group search results retain identity and execute strict checks', async () => {
    favorites.list.push(group('A', true))
    switchTagRecGroupContext('A')
    vi.mocked(fetchAllV2Search).mockResolvedValue([{ bvid: 'BV-deep', title: 'alpha', tag: 'alpha' }])
    const svc = new TagRecCustomService()
    const delivered = await svc.loadMore(signal())
    expect(fetchAllV2Search).toHaveBeenCalled()
    expect(delivered?.some((it) => it.api === EApiType.TagRec && it.bvid === 'BV-deep')).toBe(false)
    expect(fetchVideoTags).toHaveBeenCalled()
  })

  it('an old expand result cannot enter a newly selected context', async () => {
    favorites.list.push(group('A'), group('B'))
    switchTagRecGroupContext('A')
    const deferred = Promise.withResolvers<any>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(deferred.promise)
    const svc = new TagRecCustomService()
    const pending = svc.expandQuery([{ key: 'n:old-alias', tag_name: 'old-alias', badge: 'cooccur', checked: true }])
    switchTagRecGroupContext('B')
    deferred.resolve({ id: 123, name: 'old-alias', use: 1 })
    await pending
    expect(tagRecCustomSession.selectedGroupIds).toEqual(['B'])
    expect(tagRecCustomSession.expandedIds.map((e) => e.id)).not.toContain(123)
  })

  it('an old save preserves the new-context unsaved expansion', async () => {
    favorites.list.push(group('A'), group('B'))
    switchTagRecGroupContext('A')
    const deferred = Promise.withResolvers<any>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(deferred.promise)
    const svc = new TagRecCustomService()
    const pending = svc.saveAsFavoriteGroup([
      { key: 'n:old-alias', tag_name: 'old-alias', badge: 'cooccur', checked: true },
    ])
    switchTagRecGroupContext('B')
    tagRecCustomSession.expandedIds = [{ id: 456, name: 'new-context-expansion' }]
    deferred.resolve({ id: 123, name: 'old-alias', use: 1 })
    await pending
    expect(tagRecCustomSession.expandedIds.map((e) => e.id)).toEqual([456])
    expect(favorites.list.every((g) => g.tag_ids.every((e) => e.id !== 456))).toBe(true)
  })

  it('an old expansion stays invalid after switching away and back to the same group', async () => {
    favorites.list.push(group('A'), group('B'))
    switchTagRecGroupContext('A')
    const deferred = Promise.withResolvers<any>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(deferred.promise)
    const svc = new TagRecCustomService()
    const pending = svc.expandQuery([{ key: 'n:old-alias', tag_name: 'old-alias', badge: 'cooccur', checked: true }])
    switchTagRecGroupContext('B')
    switchTagRecGroupContext('A')
    deferred.resolve({ id: 123, name: 'old-alias', use: 1 })
    await pending
    expect(tagRecCustomSession.expandedIds).toEqual([])
  })

  it('saving captures only existing expansions and preserves later additions in the same context', async () => {
    favorites.list.push(group('A'))
    switchTagRecGroupContext('A')
    tagRecCustomSession.expandedIds = [{ id: 111, name: 'original-expansion' }]
    const deferred = Promise.withResolvers<any>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(deferred.promise)
    const svc = new TagRecCustomService()
    const pending = svc.saveAsFavoriteGroup([
      { key: 'n:same-context', tag_name: 'same-context', badge: 'cooccur', checked: true },
    ])
    tagRecCustomSession.expandedIds.push({ id: 456, name: 'later-expansion' })
    deferred.resolve({ id: 123, name: 'same-context', use: 1 })
    await pending
    expect(favorites.list[0].tag_ids.map((e) => e.id)).toContain(111)
    expect(favorites.list[0].tag_ids.map((e) => e.id)).not.toContain(456)
    expect(tagRecCustomSession.expandedIds.map((e) => e.id)).toEqual([456])
  })

  // R09 已修复 (2026-09-30): 原 witness (连发 40 次直至外部 abort) 按审查 README 指引转为期望行为断言
  it('real upstream grid refresh stops a continuously failed tag source with a bounded retryable error', async () => {
    const g = group('A')
    g.l1Id = 'l1'
    favorites.list.push(g)
    favoritesL1.list.push({ id: 'l1', name: '一级组', enabled: true, weight: 1 } as any)
    const ctl = new AbortController()
    let calls = 0
    vi.mocked(fetchTagTop).mockImplementation(() => {
      calls++
      return Promise.reject(new Error('persistent network failure'))
    })
    const svc = new TagRecFavService()
    await expect(refreshForGrid({ tab: ETab.TagRecFav, service: svc, abortSignal: ctl.signal })).rejects.toThrow(
      /持续失败/,
    )
    expect(calls).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1) // 1 首发 + 有界重试
    expect(svc.hasMore).toBe(true) // hasMore 保持, 重试入口 (refresh/loadMoreError) 可用
  })
})
