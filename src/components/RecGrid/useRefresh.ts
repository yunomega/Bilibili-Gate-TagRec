import { useMemoizedFn, useMount, useUnmount } from 'ahooks'
import { Result } from 'better-result'
import { assert, isEqual } from 'es-toolkit'
import { RingBuffer } from 'ring-buffer-ts'
import { appError } from '$common'
import { useEmitterOn } from '$common/hooks/useEmitter'
import { TabConfig } from '$components/RecHeader/tab-config'
// [tag-rec] RecSelf 类型引入 (refresh 重构一部分)
import { useRecSelfContext, type RecSelf, type RefreshFn, type RefreshType } from '$components/Recommends/rec.shared'
import { EHotSubTab, ETab } from '$enums'
import { filterRecItems } from '$modules/filter'
import { getGridRefreshCount } from '$modules/rec-services'
import { getDynamicFeedServiceConfig, type DynamicFeedRecService } from '$modules/rec-services/dynamic-feed'
import { getFavServiceConfig, type FavRecService } from '$modules/rec-services/fav'
import { hotStore, type HotRecService } from '$modules/rec-services/hot'
import { RankRecService } from '$modules/rec-services/hot/rank'
import { rankStore } from '$modules/rec-services/hot/rank/store'
import {
  checkTagRecContextDrift, // [tag-rec] 票 perf-08: 漂移判定走注册表, 不 instanceof 惰性 service 类
  createServiceMap,
  getServiceFromRegistry,
  isRecTab,
  loadTagRecServiceClasses, // [tag-rec] 票 perf-08
  restorePrewarmedTabService, // [tag-rec] AUDIT-31
  takePrewarmedTabService, // [tag-rec] 票 perf-09
  type FetcherOptions,
  type ServiceMap,
} from '$modules/rec-services/service-map'
import { getSpaceUploadServiceConfig, type SpaceUploadService } from '$modules/rec-services/space-upload'
import { tagRecStoresHydrated } from '$modules/tag-rec/store' // [tag-rec] perf 票 03: 建服务前闸控后台水合
import { assertNever } from '$utility/type'
import type { Debugger } from 'obug'
import type { RecItemTypeOrSeparator } from '$define'
import type { BaseTabService } from '$modules/rec-services/_base'
import type { RecGridSelf } from '.'

/**
 * refresh for same tab, but conditions changed
 */
function checkIsSameTabButConditionsChanged(tab: ETab, serviceRegistry: Partial<ServiceMap>) {
  let s: DynamicFeedRecService | FavRecService | HotRecService | SpaceUploadService | undefined
  switch (tab) {
    case ETab.DynamicFeed:
      s = serviceRegistry[ETab.DynamicFeed]
      return !isEqual(s?.config, getDynamicFeedServiceConfig())

    case ETab.Fav:
      s = serviceRegistry[ETab.Fav]
      return !isEqual(s?.config, getFavServiceConfig())

    case ETab.Hot:
      s = serviceRegistry[ETab.Hot]
      if (s?.subtab !== hotStore.subtab) return true // subtab changed
      if (
        // rank slug changed
        s.subtab === EHotSubTab.Rank &&
        s.service instanceof RankRecService &&
        s.service.rankTab.slug !== rankStore.slug
      ) {
        return true
      }
      return false

    case ETab.SpaceUpload:
      s = serviceRegistry[ETab.SpaceUpload]
      return !isEqual(s?.config, getSpaceUploadServiceConfig())

    // [tag-rec] 票 44: 语境签名漂移 (主题切换/选组/扩选/锚点变) => 在途刷新是旧境产物, 顶替;
    //   无条件漂移 (如重抽连点) 仍判 false 丢掉新 refresh, 与既有语义一致;
    //   票 perf-08: service 类惰性化后判定走 tagRecDriftCheckers 注册表 (模块 eval 时自注册)
    case ETab.TagRecFav:
    case ETab.TagRecCustom:
      return checkTagRecContextDrift(tab, serviceRegistry[tab])

    default:
      return false
  }
}

export const MAX_REC_SERVICE_HISTORY_COUNT = 5

// [tag-rec] AUDIT-14: rec service 历史 RingBuffer 登记 —— 'back'/'forward' 可达性来源;
//   预热注入 (reuse 分支) 与正常重建 (willRecreateService 分支) 共用同一登记口,
//   否则预热路径下首个 service 永不入队, 「后退」晚一轮且最初 service 不可达
function addServiceToQueueHistory(recSelf: RecSelf, tab: ETab, service: BaseTabService) {
  if (!isRecTab(tab)) return
  recSelf.serviceQueueMap[tab] ||= new RingBuffer(MAX_REC_SERVICE_HISTORY_COUNT)
  const queue = recSelf.serviceQueueMap[tab]!
  queue.add(service as any)
  const len = queue.getBufferLength()
  recSelf.setTabServiceQueueState(tab, { len, cursor: len - 1 })
}

// [tag-rec] AUDIT-04: refresh() reject (back/forward 越界 throw / 断言 / 内部异常) 会经
//   emittery allSettled 聚合为 emit() 的 AggregateError —— 数十个裸 onRefresh()/emit()
//   调用点均不接 promise => unhandled rejection; 调用点统一走此兜底上报
const reportRefreshError = (e: unknown) => appError('refresh() error', e)

export type RefreshDeps = {
  tab: ETab
  debug: Debugger
  fetcher: (opts: FetcherOptions) => Promise<RecItemTypeOrSeparator[]>
  preAction?: (signal: AbortSignal) => void | Promise<void>
  postAction?: (signal: AbortSignal) => void | Promise<void>
  updateViewFromService?: () => void
  self: RecGridSelf
  recSelf: RecSelf
}

/**
 * [tag-rec] AUDIT-04: refresh 主体抽为非 hook 工厂 —— node 测试可直驱泄漏/顶替语义,
 *   useRefresh 只负责 mount/unmount/emit 接线
 */
export function createRefreshFn({
  tab,
  debug,
  fetcher,
  preAction,
  postAction,
  updateViewFromService,
  self,
  recSelf,
}: RefreshDeps): RefreshFn {
  const { serviceRegistry } = recSelf

  return async function refresh(refreshType: RefreshType = 'refresh') {
    const isSameTabRefreshing = recSelf.refreshing && recSelf.refreshingTab === tab
    if (isSameTabRefreshing) {
      if (checkIsSameTabButConditionsChanged(tab, serviceRegistry)) {
        debug('refresh(): tab=%s [start], current refreshing, sametab but conditions change, abort existing', tab)
        self.abortController.abort()
      } else {
        // prevent same tab `refresh()`
        debug('refresh() tab=%s [start], current refreshing, prevent same tab refresh()', tab)
        return
      }
    } else {
      debug('refresh(): tab=%s [start]', tab)
    }

    // refresh start
    const start = performance.now()

    // #region abort-controller
    //  - 往 self / recSelf 上写 state 前需确保 `!signal.aborted`
    //  - async code 后需要判断 `signal.aborted` early return
    self.abortController.abort()
    self.abortController = new AbortController()
    const controller = self.abortController // [tag-rec] AUDIT-04: finally 顶替判定基准
    const { signal } = controller
    // #endregion

    try {
      recSelf.setStore({ refreshing: true, refreshingTab: tab })
      self.setStore({ refreshError: undefined, hasMore: true, items: [], refreshKey: Date.now() })
      await preAction?.(signal)
      if (signal.aborted) return

      function _onAny() {
        if (signal.aborted) return
        recSelf.setStore({ refreshing: false, refreshingTab: undefined })
        self.setStore({ showSkeleton: false })
      }
      function onError(err: any) {
        if (signal.aborted) return
        _onAny()
        self.setStore({ refreshError: err })
        appError(err)
      }
      function onSuccess() {
        if (signal.aborted) return
        _onAny()
        self.setStore({ hasMore: getServiceFromRegistry(serviceRegistry, tab).hasMore })
      }

      async function doFetch(service: BaseTabService) {
        const result = await Result.tryPromise(() => fetcher({ tab, service, abortSignal: signal }))
        // aborted
        if (signal.aborted) return false

        // err
        if (result.isErr()) {
          onError(result.error.cause) // 拆包 UnhandledException
          return false
        }

        // success
        self.setStore({ items: result.value })
        return true
      }

      let existingService: (typeof serviceRegistry)[ETab]
      let willRecreateService: boolean
      switch (refreshType) {
        case 'refresh':
          break
        case 'reuse': {
          existingService = serviceRegistry[tab] // reuse existing service
          // [tag-rec] AUDIT-A4-2: 复用前漂移判 —— 切走期语境/过滤变更 (pane 编辑 emit 落无监听期
          //   被丢) 的旧 service 带旧境存货回归 = 已删成员产出即屏 + stale 楔; 弃实例走重建
          if (existingService && checkTagRecContextDrift(tab, existingService)) {
            delete serviceRegistry[tab]
            existingService = undefined
          }
          // [tag-rec] 票 perf-09: mount 前预热 —— initHomepagePureRecommend 在 poll/createRoot
          //   窗口内已按当前 tab 预建 service 并发起首个 loadMore; 此处取回并等在途首 fetch 落定
          //   (loadMore 结果落 qs 队列, 下面 restore() 归位 bufferQueue), 注入 registry 走既有
          //   existingService 通道: cachedItems 立即上屏 + doFetch 消费缓存, 不再重发首 fetch。
          if (!existingService) {
            const prewarmed = takePrewarmedTabService(tab)
            if (prewarmed) {
              // 首 fetch 仍在途时保持骨架(与新建路径观感一致); 已落定则下面直接上屏
              if (!prewarmed.service.qs.fetchedCount) self.setStore({ showSkeleton: true })
              await prewarmed.firstFetch
              // [tag-rec] AUDIT-31: take 已出 map + 未注入 registry => 直接 return 会孤儿化白付首 fetch;
              //   回补预热池 (槽位空才放回, 原 TTL 到点自清), 同 tab 下次 mount 仍可消费
              if (signal.aborted) {
                restorePrewarmedTabService(tab, prewarmed)
                return
              }
              if (checkTagRecContextDrift(tab, prewarmed.service)) {
                willRecreateService = true
                break
              }
              serviceRegistry[tab] = prewarmed.service as any
              existingService = prewarmed.service as any
              // [tag-rec] AUDIT-14: 预热注入补同款 RingBuffer 登记 (原只在 willRecreateService
              //   分支登记 => 首 service 永不入历史, 「后退」晚一轮且最初 service 不可达);
              //   updateViewFromService 对齐 :willRecreateService 分支 —— 注入后立即有 tabbarView/sidebarView
              updateViewFromService?.()
              addServiceToQueueHistory(recSelf, tab, prewarmed.service)
            }
          }
          break
        }
        case 'back':
        case 'forward': {
          assert(isRecTab(tab), `only rec tab can perform back/forward`)
          const [canGoBack, canGoForward] = recSelf.getTabBackForwardStatus(tab)
          if (refreshType === 'back' && !canGoBack) throw new Error('cannot go back')
          if (refreshType === 'forward' && !canGoForward) throw new Error('cannot go forward')

          const state = recSelf.getTabServiceQueueState(tab)
          assert(state, `state should not be nil`)
          const { len, cursor } = state
          const inc = refreshType === 'back' ? -1 : 1
          const newCursor = cursor + inc
          if (newCursor < 0 || newCursor > len - 1) throw new Error('cannot go back/forward')

          const service = recSelf.serviceQueueMap[tab]?.get(newCursor)
          assert(service, `service should not be nil`)
          // [tag-rec] AUDIT-A4-2: 历史 service 已漂移 => 旧境存货不上屏, 弃历史走重建
          //   (游标仍进位 —— 该历史点的语境已死, 下个点按同规则再判)
          if (checkTagRecContextDrift(tab, service)) {
            recSelf.setTabServiceQueueState(tab, { cursor: newCursor, len })
            delete serviceRegistry[tab]
            willRecreateService = true
            break
          }
          existingService = service
          recSelf.setTabServiceQueueState(tab, { cursor: newCursor, len })
          serviceRegistry[tab] = service as any

          willRecreateService = false
          break
        }
        default:
          assertNever(refreshType)
          break
      }

      // cached
      if (existingService) {
        await existingService.restore()
        if (checkTagRecContextDrift(tab, existingService)) {
          delete serviceRegistry[tab]
          existingService = undefined
          willRecreateService = true
        } else {
          const cachedItems = filterRecItems(existingService.qs.bufferQueue, tab).slice(0, getGridRefreshCount())
          if (signal.aborted) return
          self.setStore({ items: cachedItems })
          const success = await doFetch(existingService)
          if (signal.aborted) return
          // swr?
          willRecreateService ??= success && !!TabConfig[tab].swr
        }
      }
      // create new service
      else {
        if (signal.aborted) return
        self.setStore({ showSkeleton: true })
        willRecreateService = true
      }

      if (willRecreateService) {
        // [tag-rec] perf 票 03: tag-rec store 已脱 TLA 改后台水合 —— 建 service 前先等水合:
        //   构造期即读真值 (custom 构造消费深链参数查 favorites.list; 双 tab 构造期拍语境签名),
        //   空骨架会误判; 水合与模块求值/挂载并行, 首个 tag-rec 服务创建点通常已 resolved, 实损≈0
        if (tab === ETab.TagRecFav || tab === ETab.TagRecCustom) {
          // [tag-rec] 票 perf-08: 水合闸 + 惰性 service 类装载并行 —— 首个 tag-rec tab 才 eval 模块图
          await Promise.all([tagRecStoresHydrated, loadTagRecServiceClasses()])
          if (signal.aborted) return
        }
        const result = Result.try(() => createServiceMap[tab]({ existingService }))
        if (result.isErr()) return onError(result.error.cause)

        // save services
        const service = result.value
        const firstFetch = serviceRegistry[tab] ? undefined : true // no previous service
        if (signal.aborted) return
        serviceRegistry[tab] = service as any
        updateViewFromService?.()
        addServiceToQueueHistory(recSelf, tab, service)

        const success = await doFetch(service)
        if (signal.aborted || !success) return
      }

      if (signal.aborted) return
      onSuccess()
      await postAction?.(signal)
      const cost = performance.now() - start
      debug('refresh(): tab=%s [success] cost %s ms', tab, cost.toFixed(0))
    } finally {
      // [tag-rec] AUDIT-04: abort 早退/同步抛错也要摘 refreshing 标志 —— 滞留会让同 tab 后续
      //   refresh 走 isSameTabRefreshing -> checkIsSameTabButConditionsChanged=false -> 静默丢弃 (死锁,
      //   复现: ModalFeed 载入中关弹层, useUnmount abort => 泄漏 => 同 tab 重开永久空网格)
      //   顶替语义: 新一轮 refresh 已替换 self.abortController 并自行重写 refreshing/refreshingTab,
      //   仅本轮 controller 仍是当前值时清理, 避免旧轮 finally 误清新一轮刚置的标志
      if (self.abortController === controller) {
        recSelf.setStore({ refreshing: false, refreshingTab: undefined })
        self.setStore({ showSkeleton: false })
      }
    }
  }
}

export function useRefresh({
  tab,
  debug,
  fetcher,
  preAction,
  postAction,
  updateViewFromService,
  self,
}: Omit<RefreshDeps, 'recSelf'>) {
  const recSelf = useRecSelfContext()

  const refresh: RefreshFn = useMemoizedFn(
    createRefreshFn({ tab, debug, fetcher, preAction, postAction, updateViewFromService, self, recSelf }),
  )

  useMount(() => {
    // reuse service when switch tab
    // [tag-rec] AUDIT-04: 裸调用也需 catch, 防 refresh() 内部 throw -> unhandled rejection
    void Promise.resolve(refresh('reuse')).catch(reportRefreshError)
  })
  // switch away
  useUnmount(() => {
    self.abortController.abort()
  })

  // listen for `refresh` event
  const { recSharedEmitter } = recSelf
  // [tag-rec] AUDIT-04: 监听器返回 refresh() promise, reject 会聚合进 emit() AggregateError ->
  //   裸 emit/onRefresh 调用点 unhandled rejection; 就地 catch 上报
  useEmitterOn(recSharedEmitter, 'refresh', ({ data: refreshType }) =>
    Promise.resolve(refresh(refreshType)).catch(reportRefreshError),
  )

  return { refresh }
}
