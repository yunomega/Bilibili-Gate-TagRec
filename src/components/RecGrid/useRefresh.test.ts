import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ETab } from '$enums'
import type { RecItemTypeOrSeparator } from '$define'
import type { RecGridSelf } from '.'

/**
 * [tag-rec] AUDIT-04 / AUDIT-14 回归 —— useRefresh 生命周期
 * createRefreshFn 为非 hook 工厂 (useRefresh 仅接线 mount/unmount/emit),
 * 此处用真 RecSelf (valtio 在 node 可用) + 结构化 self 桩直驱 refresh 语义:
 *  - abort 早退 / 同步抛错后 refreshing 标志必须摘除 (修复前 = 同 tab 刷新永久死锁)
 *  - 顶替语义: 旧轮 finally 不得误清新轮刚置的标志
 *  - 预热 service 注入后必须登记 serviceQueueMap (后退可达性)
 */

// #region mocks —— 剪断 useRefresh 的重依赖链 (services / icons / GM / settings)
vi.mock('$common', () => ({ appError: vi.fn() }))
vi.mock('$modules/filter', () => ({ filterRecItems: (items: unknown[]) => items }))
vi.mock('$modules/rec-services', () => ({ getGridRefreshCount: () => 8 }))
vi.mock('$components/RecHeader/tab-config', () => ({
  TabConfig: new Proxy({}, { get: () => ({}) }), // .swr => undefined (falsy)
}))

const h = vi.hoisted(() => ({
  dfConfig: { v: 1 } as unknown,
  created: vi.fn(() => fakeService()),
}))
vi.mock('$modules/rec-services/dynamic-feed', () => ({ getDynamicFeedServiceConfig: vi.fn(() => h.dfConfig) }))
vi.mock('$modules/rec-services/fav', () => ({ getFavServiceConfig: vi.fn(() => ({})) }))
vi.mock('$modules/rec-services/hot', () => ({ hotStore: { subtab: undefined } }))
vi.mock('$modules/rec-services/hot/rank', () => ({ RankRecService: class RankRecService {} }))
vi.mock('$modules/rec-services/hot/rank/store', () => ({ rankStore: { slug: undefined } }))
vi.mock('$modules/rec-services/space-upload', () => ({ getSpaceUploadServiceConfig: vi.fn(() => ({})) }))
vi.mock('$modules/tag-rec/service/tag-rec-custom', () => ({
  TagRecCustomService: class TagRecCustomService {},
  computeTagRecCustomContextSignature: vi.fn(() => ''),
}))
vi.mock('$modules/tag-rec/service/tag-rec-fav', () => ({
  TagRecFavService: class TagRecFavService {},
  computeTagRecFavContextSignature: vi.fn(() => ''),
}))
vi.mock('$modules/tag-rec/store', () => ({ tagRecStoresHydrated: Promise.resolve() }))

const REC_TABS = [ETab.KeepFollowOnly, ETab.PcRecommend, ETab.AppRecommend]
vi.mock('$modules/rec-services/service-map', () => ({
  REC_TABS,
  isRecTab: (tab: ETab) => REC_TABS.includes(tab),
  createServiceMap: new Proxy({}, { get: () => () => h.created() }),
  getServiceFromRegistry: (registry: Record<string, unknown>, tab: string) => {
    const service = registry[tab]
    if (!service) throw new Error(`serviceRegistry[tab=${tab}] should not be nil`)
    return service
  },
  takePrewarmedTabService: vi.fn(() => undefined),
  restorePrewarmedTabService: vi.fn(), // [tag-rec] AUDIT-31
  prewarmTabService: vi.fn(),
  // [tag-rec] 票 perf-08: service-map 新增导出
  checkTagRecContextDrift: vi.fn(() => false),
  loadTagRecServiceClasses: vi.fn(() => Promise.resolve()),
}))
// #endregion

const { RecSelf } = await import('$components/Recommends/rec.shared')
const { createRefreshFn } = await import('./useRefresh')
const { checkTagRecContextDrift, takePrewarmedTabService, restorePrewarmedTabService } =
  await import('$modules/rec-services/service-map')

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    qs: { bufferQueue: [] as RecItemTypeOrSeparator[], fetchedCount: 0 },
    hasMore: true,
    restore: vi.fn(),
    loadMore: vi.fn(() => Promise.resolve([])),
    ...overrides,
  }
}

// refresh 主体只触 self.abortController / self.setStore —— 结构化桩足够
function fakeSelf() {
  const store: Record<string, unknown> = {}
  return {
    store,
    abortController: new AbortController(),
    setStore: (payload: Record<string, unknown>) => Object.assign(store, payload),
  }
}

const deferred = <T>() => Promise.withResolvers<T>()
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function setup(tab: ETab = ETab.AppRecommend) {
  const recSelf = new RecSelf()
  const self = fakeSelf()
  const fetcher = vi.fn((): Promise<RecItemTypeOrSeparator[]> => Promise.resolve([]))
  const refresh = createRefreshFn({
    tab,
    debug: vi.fn() as any,
    fetcher,
    self: self as unknown as RecGridSelf,
    recSelf,
  })
  return { recSelf, self, fetcher, refresh }
}

describe('$components/RecGrid/useRefresh createRefreshFn (AUDIT-04/14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.created.mockImplementation(() => fakeService())
    h.dfConfig = { v: 1 }
    vi.mocked(takePrewarmedTabService).mockReturnValue(undefined)
    vi.mocked(checkTagRecContextDrift).mockReturnValue(false)
  })

  it('refresh 正常完成后摘除 refreshing (基线)', async () => {
    const { recSelf, refresh } = setup()
    await refresh('refresh')
    expect(recSelf.refreshing).toBe(false)
    expect(recSelf.refreshingTab).toBeUndefined()
  })

  it('AUDIT-04: abort 早退后 refreshing===false, 同 tab 再刷不被静默丢弃 (ModalFeed 死锁回归)', async () => {
    const { recSelf, self, fetcher, refresh } = setup(ETab.AppRecommend)
    const d = deferred<RecItemTypeOrSeparator[]>()
    fetcher.mockImplementationOnce(() => d.promise)

    const p1 = refresh('refresh')
    await flush() // 停在 doFetch 的 fetcher await 上
    expect(recSelf.refreshing).toBe(true)
    expect(recSelf.refreshingTab).toBe(ETab.AppRecommend)

    // 模拟 unmount: useUnmount 只 abort 不替换 controller
    self.abortController.abort()
    d.resolve([]) // fetcher 落定 -> signal.aborted 早退 -> finally 摘标志
    await p1

    expect(recSelf.refreshing).toBe(false)
    expect(recSelf.refreshingTab).toBeUndefined()

    // 死锁回归断言: 同 tab 再次 refresh 必须真的跑 (修复前被 isSameTabRefreshing 门永久丢弃)
    await refresh('refresh')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(recSelf.refreshing).toBe(false)
  })

  it('AUDIT-04: 顶替语义 —— 旧轮 finally 不误清新轮 refreshing', async () => {
    const { recSelf, self, fetcher, refresh } = setup(ETab.DynamicFeed)
    // 预置旧 service (config v1); 当前配置 v2 => checkIsSameTabButConditionsChanged=true => 顶替
    recSelf.serviceRegistry[ETab.DynamicFeed] = fakeService({ config: { v: 1 } }) as any
    h.dfConfig = { v: 2 }

    const d1 = deferred<RecItemTypeOrSeparator[]>()
    const d2 = deferred<RecItemTypeOrSeparator[]>()
    fetcher.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise)

    const p1 = refresh('refresh')
    await flush()
    expect(recSelf.refreshing).toBe(true)

    const p2 = refresh('refresh') // 条件漂移 -> abort 旧轮 -> 新 controller -> 自行重写标志
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)

    d1.resolve([]) // 旧轮落定 -> 早退 -> finally 见到 controller 已换 => 不得清
    await p1
    expect(recSelf.refreshing).toBe(true) // 新轮仍在途
    expect(recSelf.refreshingTab).toBe(ETab.DynamicFeed)

    d2.resolve([])
    await p2
    expect(recSelf.refreshing).toBe(false)
    expect(recSelf.refreshingTab).toBeUndefined()
    expect(self.abortController.signal.aborted).toBe(false) // 新轮 controller 未被误伤
  })

  it('AUDIT-04: 内部 throw (back 越界) 既 reject 也摘标志', async () => {
    const { recSelf, refresh } = setup(ETab.AppRecommend) // rec tab, 空队列
    await expect(refresh('back')).rejects.toThrow('cannot go back')
    expect(recSelf.refreshing).toBe(false)
    expect(recSelf.refreshingTab).toBeUndefined()
    // 且后续 refresh 不被丢弃
    await refresh('refresh')
    expect(recSelf.refreshing).toBe(false)
  })

  it('AUDIT-14: 预热 service 注入后登记 serviceQueueMap (首 service 后退可达)', async () => {
    const { recSelf, refresh } = setup(ETab.AppRecommend)
    const prewarmed = { service: fakeService(), firstFetch: Promise.resolve() }
    vi.mocked(takePrewarmedTabService).mockReturnValueOnce(prewarmed as any)

    await refresh('reuse')
    expect(recSelf.serviceRegistry[ETab.AppRecommend]).toBe(prewarmed.service)
    expect(recSelf.serviceQueueMap[ETab.AppRecommend]?.getBufferLength()).toBe(1)
    expect(recSelf.getTabServiceQueueState(ETab.AppRecommend)).toEqual({ len: 1, cursor: 0 })
    expect(recSelf.refreshing).toBe(false)
  })

  it('AUDIT-14: 无预热时 reuse 走正常重建, 同样登记一份', async () => {
    const { recSelf, refresh } = setup(ETab.AppRecommend)
    await refresh('reuse')
    expect(recSelf.serviceQueueMap[ETab.AppRecommend]?.getBufferLength()).toBe(1)
    expect(recSelf.getTabServiceQueueState(ETab.AppRecommend)).toEqual({ len: 1, cursor: 0 })
  })

  it('A13: source drift while awaiting prewarm rebuilds before cached first screen', async () => {
    const { recSelf, self, fetcher, refresh } = setup()
    const d = deferred<unknown>()
    const old = fakeService()
    old.qs.bufferQueue.push({ uniqId: 'closed-cache' } as RecItemTypeOrSeparator)
    vi.mocked(takePrewarmedTabService).mockReturnValueOnce({ service: old, firstFetch: d.promise } as any)
    const pending = refresh('reuse')
    await flush()
    vi.mocked(checkTagRecContextDrift).mockImplementation((_tab, service) => service === (old as any))
    d.resolve(undefined)
    await pending
    expect(h.created).toHaveBeenCalledTimes(1)
    expect(old.restore).not.toHaveBeenCalled()
    expect(recSelf.serviceRegistry[ETab.AppRecommend]).not.toBe(old)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(self.store.items).toEqual([])
    expect(recSelf.refreshing).toBe(false)
  })

  it('A13: source drift during restore rebuilds inline without exposing cached rows or locking refresh', async () => {
    const { recSelf, self, refresh } = setup()
    const d = deferred<void>()
    const old = fakeService({ restore: () => d.promise })
    old.qs.bufferQueue.push({ uniqId: 'closed-history' } as RecItemTypeOrSeparator)
    recSelf.serviceRegistry[ETab.AppRecommend] = old as any
    const pending = refresh('reuse')
    await flush()
    vi.mocked(checkTagRecContextDrift).mockImplementation((_tab, service) => service === (old as any))
    d.resolve()
    await pending
    expect(h.created).toHaveBeenCalledTimes(1)
    expect(recSelf.serviceRegistry[ETab.AppRecommend]).not.toBe(old)
    expect(self.store.items).toEqual([])
    expect(recSelf.refreshing).toBe(false)
  })

  it.each(['back', 'forward'] as const)(
    'A13: %s rejects a history service whose source policy drifted before restore',
    async (direction) => {
      const { recSelf, self, refresh } = setup()
      const first = fakeService()
      const second = fakeService()
      h.created.mockReturnValueOnce(first).mockReturnValueOnce(second)
      await refresh('refresh')
      await refresh('refresh')
      const stale = direction === 'back' ? first : second
      stale.qs.bufferQueue.push({ uniqId: 'closed-history' } as RecItemTypeOrSeparator)
      recSelf.setTabServiceQueueState(ETab.AppRecommend, { len: 2, cursor: direction === 'back' ? 1 : 0 })
      vi.mocked(checkTagRecContextDrift).mockImplementation((_tab, service) => service === (stale as any))
      await refresh(direction)
      expect(stale.restore).not.toHaveBeenCalled()
      expect(h.created).toHaveBeenCalledTimes(3)
      expect(recSelf.serviceRegistry[ETab.AppRecommend]).not.toBe(stale)
      expect(self.store.items).toEqual([])
      expect(recSelf.refreshing).toBe(false)
    },
  )

  it('AUDIT-31: take 后 abort —— 预热条目回补预热池, 不注入 registry 不孤儿化', async () => {
    const { recSelf, self, refresh } = setup(ETab.AppRecommend)
    const d = deferred<unknown>()
    const prewarmed = { service: fakeService(), firstFetch: d.promise }
    vi.mocked(takePrewarmedTabService).mockReturnValueOnce(prewarmed as any)

    const p = refresh('reuse')
    await flush() // 停在 await prewarmed.firstFetch
    expect(takePrewarmedTabService).toHaveBeenCalledWith(ETab.AppRecommend)

    self.abortController.abort() // take 后、firstFetch 落定前 abort (模拟 unmount)
    d.resolve(undefined)
    await p

    expect(restorePrewarmedTabService).toHaveBeenCalledWith(ETab.AppRecommend, prewarmed)
    expect(recSelf.serviceRegistry[ETab.AppRecommend]).toBeUndefined() // 未注入 => 无孤儿 registry 条目
    expect(recSelf.serviceQueueMap[ETab.AppRecommend]).toBeUndefined() // 未登记队列历史
    expect(recSelf.refreshing).toBe(false) // finally 摘标志照常
  })
})
