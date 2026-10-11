import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ETab } from '$enums'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

/**
 * 票 13-fix 回归 (源自探针 `.scratch/bilibili-gate-risk-control/probes/empty-context-backoff-loop.probe.test.ts`):
 * 「空语境 + 退避态」曾构成零请求无限微任务循环(主线程饿死, 实锤于 research/13)。
 * 修复后必须: 终止(有界), 且不让出宏任务的饿死模式不得复现。
 */

const net = vi.hoisted(() => ({ calls: 0 }))

// ---- IO/外围替身 (同 tag-rec-custom.dry.test.ts + probes 手法) ----
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
vi.mock('$components/RecGrid/useShortcut', () => ({ getColumnCount: () => 2 }))
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
  return {
    settings: { tagRec: { filter: createTagRecFactoryFilterCore(), diversityGuard: false, k: 3, ladder: undefined } },
  }
})
vi.mock('../api/endpoints', () => {
  const trip = () => {
    net.calls++
    return Promise.resolve(undefined)
  }
  return {
    ALLV2_PAGE_CAP: 50,
    fetchTagInfoByName: trip,
    fetchTagInfoById: trip,
    fetchTagTop: trip,
    fetchArchiveRelated: trip,
    fetchAllV2Search: trip,
    fetchSuggest: trip,
    fetchVideoTags: trip,
    fetchVideoTagNames: trip,
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

// ---- 真实件 ----
const { refreshForGrid } = await import('$modules/rec-services/index')
const { tagRecBackoff } = await import('../api/backoff')
const { resetTagRecCustomSharedState, TagRecCustomService } = await import('./tag-rec-custom')
const { tagRecCustomSession } = await import('../store/session')

const STOP = '[probe] stop'

/** 透明计数壳: 只代理 fetchMinCount 用到的 hasMore / loadMore; stopAt 兜底防回归时挂死测试进程 */
function mkCase(opts: { stopAt: number; yieldEach?: boolean }) {
  const real = new TagRecCustomService()
  let n = 0
  const service = {
    qs: real.qs,
    get hasMore() {
      return real.hasMore
    },
    get tabbarView() {
      return real.tabbarView
    },
    async loadMore(signal: AbortSignal) {
      n++
      if (opts.yieldEach) await new Promise((r) => setTimeout(r, 0))
      if (n >= opts.stopAt) throw new Error(STOP)
      return real.loadMore(signal)
    },
  }
  return { real, service, iters: () => n }
}

const signal = () => new AbortController().signal

const resetSession = () => {
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.selectedGroupIds = []
  tagRecCustomSession.draftGroup = undefined
  resetTagRecCustomSharedState()
}

describe('票 13-fix: 空语境 + 退避态 —— 零请求微任务空转回归', () => {
  beforeEach(() => {
    resetSession()
    net.calls = 0
    ;(tagRecBackoff as any).engaged = false
  })

  it('A 对照: 空语境 + 非退避态 => 单轮即止走 exhaustRound()', async () => {
    const { real, service, iters } = mkCase({ stopAt: 10 })
    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() })
    expect(items).toEqual([])
    expect(real.hasMoreExceptQueue).toBe(false) // 确实进到 592 分支并走了 exhaustRound()
    expect(iters()).toBe(1)
    expect(net.calls).toBe(0)
  })

  it('B 回归: 空语境 + 退避态 => 终止而非零让出空转 (0ms watchdog 可触发)', async () => {
    ;(tagRecBackoff as any).engaged = true
    let watchdog = false
    setTimeout(() => {
      watchdog = true
    }, 0)
    const { real, service, iters } = mkCase({ stopAt: 1000 })

    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() })

    expect(items).toEqual([])
    expect(real.hasMoreExceptQueue).toBe(false) // 纯空态: 终止(同非退避态语义, 无池底 UI)
    expect(iters()).toBeLessThanOrEqual(2)
    expect(net.calls).toBe(0)
    await new Promise((r) => setTimeout(r, 0)) // 放行宏任务队列
    expect(watchdog).toBe(true) // 修复前: 微任务饿死, 此断言必挂
  })

  it('B2 回归: 有待解析输入 + 退避态 => 有界重试后终止 (不无限挂起刷新)', async () => {
    ;(tagRecBackoff as any).engaged = true
    tagRecCustomSession.inputText = 'galgame'
    const { real, service, iters } = mkCase({ stopAt: 1000 })

    const items = await refreshForGrid({ tab: ETab.TagRecCustom, service: service as any, abortSignal: signal() })

    expect(items).toEqual([])
    expect(real.hasMoreExceptQueue).toBe(false)
    expect(iters()).toBeLessThanOrEqual(4) // 1 首发 + ≤2 重试 + 收尾轮
  })
})
