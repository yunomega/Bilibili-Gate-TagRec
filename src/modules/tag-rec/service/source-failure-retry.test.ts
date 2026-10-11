import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getColumnCount } from '$components/RecGrid/useShortcut'
import { ETab } from '$enums'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

/**
 * R09 回归 (源自审查 `.scratch/tag-rec-comprehensive-review-2026-09-30`, R09):
 * 源请求持续失败 => 零产出 + failedTids => 未决轮保 hasMore=true, fetchMinCount 单次刷新无限连发
 * (探针实锤: 连发 40 次直至外部 abort)。修复后必须:
 *   单次刷新内有界重试 (1 首发 + TAG_REC_SOURCE_FAILURE_MAX_RETRIES), 超限抛可重试错误截停;
 *   定轮 (有产出/无失败源) 归零; 错误收尾后再次刷新重新获得完整预算。
 */

const net = vi.hoisted(() => ({ calls: 0, failFirstN: Infinity }))

// ---- IO/外围替身 (同 tag-rec-custom.empty-context-backoff.test.ts 手法) ----
vi.mock('$common', () => {
  const debug: any = Object.assign(() => {}, { extend: () => debug, enabled: false })
  return {
    baseDebug: debug,
    appWarn: vi.fn(),
    appError: vi.fn(),
    APP_CLS_TAB_BAR: 'x',
    APP_CLS_CARD: 'x',
    APP_CLS_GRID: 'x',
    APP_NAMESPACE: 'x',
    IN_BILIBILI: true,
    HOST_API: '',
    HOST_APP: '',
    TVKeyInfo: {},
  }
})
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$components/RecGrid/useShortcut', () => ({ getColumnCount: vi.fn(() => 1) }))
vi.mock('$modules/filter/index', () => ({ filterRecItems: (x: unknown) => x }))
vi.mock('$modules/filter/normalize', () => ({ normalizeCardData: (x: unknown) => x }))
vi.mock('$modules/rec-services/app', () => ({ AppRecService: class {} }))
vi.mock('$modules/rec-services/pc', () => ({ PcRecService: class {} }))
vi.mock('$modules/rec-services/dynamic-feed/api/enums', () => ({ DynamicFeedItemHelper: { isVideo: () => false } }))
vi.mock('$modules/rec-services/service-map', () => ({ isRecTab: () => false }))
vi.mock('$utility/idb', () => ({
  getIdbCache: () => ({
    db: { iterate: () => {}, removeItem: () => Promise.resolve() },
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  }),
  wrapWithIdbCache: (opts: any) =>
    Object.assign(opts.fn, { cache: {}, cleanUp: () => {}, queryCache: () => Promise.resolve(undefined) }),
}))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  const filter = createTagRecFactoryFilterCore()
  filter.dims.likeRate.enabled = false
  return { settings: { tagRec: { filter, diversityGuard: false, k: 3, ladder: undefined } } }
})
vi.mock('../api/endpoints', () => {
  const ok = () => Promise.resolve([])
  return {
    ALLV2_PAGE_CAP: 50,
    fetchTagTop: vi.fn(() => {
      net.calls += 1
      if (net.calls <= net.failFirstN) return Promise.reject(new Error('persistent network failure'))
      return Promise.resolve([{ bvid: `BV-ok-${net.calls}`, title: 'ok', stat: {} }])
    }),
    fetchTagInfoByName: ok,
    fetchTagInfoById: ok,
    fetchArchiveRelated: ok,
    fetchAllV2Search: ok,
    fetchSuggest: ok,
    fetchVideoTags: ok,
    fetchVideoTagNames: ok,
    invalidateVideoTagsCache: () => {},
    TagRecApiCodeError: class extends Error {},
  }
})
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: () => Promise.resolve() }))
vi.mock('../store', async () => {
  const { sedimentNoteDig } = await import('../model/sediment')
  const pool = new Map<string, unknown>()
  return {
    sediment: {
      map: pool,
      merge: vi.fn(),
      confirm: vi.fn(),
      noteDig: vi.fn((n: string, d: any) => sedimentNoteDig(pool as never, n, d)),
    },
    seen: new Set<string>(),
    favorites: { list: [] },
    favoritesStore: { list: [] },
    favoritesL1: { list: [] },
    favoritesL1Store: { list: [] },
    themes: { list: [], active: undefined },
    viewScope: { viewedL1Ids: () => undefined },
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
vi.mock('./share-like', () => ({ noteShareLikeDelivered: vi.fn() }))
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('../ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))

// ---- 真实件 ----
const { refreshForGrid } = await import('$modules/rec-services/index')
const { resetTagRecCustomSharedState, TagRecCustomService } = await import('./tag-rec-custom')
const { resetTagRecFavSharedState, TagRecFavService } = await import('./tag-rec-fav')
const { TAG_REC_SOURCE_FAILURE_MAX_RETRIES, TagRecSourceFailureError } = await import('./_pipeline')
const { makeTagGroup } = await import('../model/favorites')
const { favorites, favoritesL1 } = await import('../store')
const { tagRecCustomSession, tagRecFavSession, tagRecSharedSession } = await import('../store/session')

const signal = () => new AbortController().signal

/** 透明计数壳: 只代理 fetchMinCount 用到的 hasMore / loadMore; stopAt 兜底防回归时挂死测试进程 */
function mkShell(real: any, stopAt = 50) {
  let n = 0
  const service = {
    qs: real.qs,
    get hasMore() {
      return real.hasMore
    },
    get tabbarView() {
      return real.tabbarView
    },
    loadMore(sig: AbortSignal) {
      n++
      if (n >= stopAt) return Promise.reject(new Error('[test] stop'))
      return real.loadMore(sig)
    },
  }
  return { service, iters: () => n }
}

const mkGroup = () => makeTagGroup({ id: 'g1', name: '组A', tag_ids: [{ id: 1, name: 'alpha' }] })!

const resetStores = () => {
  favorites.list.length = 0
  favoritesL1.list.length = 0
  tagRecCustomSession.selectedGroupIds = []
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.draftGroup = undefined
  tagRecSharedSession.tempEnabledL1Ids = []
  tagRecFavSession.bypassSeen = false
  tagRecCustomSession.bypassSeen = false
  resetTagRecCustomSharedState()
  resetTagRecFavSharedState()
  net.calls = 0
  net.failFirstN = Infinity
}

describe('R09: 源请求持续失败 —— 单次刷新有界重试回归', () => {
  beforeEach(resetStores)

  it('custom: 源持续失败 => 1 首发 + 2 重试后以可重试错误截停', async () => {
    favorites.list.push(mkGroup())
    tagRecCustomSession.selectedGroupIds = ['g1']
    const real = new TagRecCustomService()
    const { service, iters } = mkShell(real)

    await expect(
      refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() }),
    ).rejects.toBeInstanceOf(TagRecSourceFailureError)

    expect(iters()).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1)
    expect(net.calls).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1) // 1 源/轮
  })

  it('fav: 源持续失败 => 有界轮数后以可重试错误截停 (不再无限连发)', async () => {
    favoritesL1.list.push({ id: 'l1', name: '一级组', enabled: true, weight: 1 } as any)
    const g = mkGroup()
    g.l1Id = 'l1'
    favorites.list.push(g)
    const real = new TagRecFavService()
    const { service, iters } = mkShell(real)

    await expect(
      refreshForGrid({ tab: ETab.TagRecFav, service: service as any, abortSignal: signal() }),
    ).rejects.toBeInstanceOf(TagRecSourceFailureError)

    expect(iters()).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1)
    expect(net.calls).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1)
  })

  it('custom: 瞬时失败恢复 => 正常交付 (未决轮预算未被打穿)', async () => {
    favorites.list.push(mkGroup())
    tagRecCustomSession.selectedGroupIds = ['g1']
    net.failFirstN = 1 // 首发失败, 其后成功
    const real = new TagRecCustomService()
    const { service, iters } = mkShell(real)

    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() })
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(iters()).toBeGreaterThanOrEqual(2) // 首发失败 + 重试成功
  })

  it('custom: 错误收尾后再次刷新 => 重新获得完整预算 (计数已归零)', async () => {
    favorites.list.push(mkGroup())
    tagRecCustomSession.selectedGroupIds = ['g1']
    const real = new TagRecCustomService()
    const { service, iters } = mkShell(real)

    await expect(
      refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() }),
    ).rejects.toBeInstanceOf(TagRecSourceFailureError)
    const first = iters()
    await expect(
      refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() }),
    ).rejects.toBeInstanceOf(TagRecSourceFailureError)
    expect(iters() - first).toBe(TAG_REC_SOURCE_FAILURE_MAX_RETRIES + 1)
  })
})

describe('标签首刷先上屏一页', () => {
  it.each([ETab.TagRecFav, ETab.TagRecCustom])('%s: 七列布局不为凑四行再拉下一页', async (tab) => {
    vi.mocked(getColumnCount).mockReturnValue(7)
    const loadMore = vi.fn(() =>
      Promise.resolve(
        Array.from({ length: 20 }, (_, i) => ({
          bvid: `BV-first-${i}`,
          uniqId: `first-${i}`,
          api: 'tag-rec',
        })),
      ),
    )
    try {
      const items = await refreshForGrid({
        tab,
        service: { qs: { ps: 20 }, hasMore: true, loadMore } as any,
        abortSignal: signal(),
      })
      expect(items).toHaveLength(20)
      expect(loadMore).toHaveBeenCalledTimes(1)
    } finally {
      vi.mocked(getColumnCount).mockReturnValue(1)
    }
  })
})
