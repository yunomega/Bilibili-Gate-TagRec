import { arrayMove } from '@dnd-kit/sortable'
import { useCreation, useEventListener, useLatest, useMemoizedFn, useMount, useUnmountedRef } from 'ahooks'
import { Button, Divider } from 'antd'
import { Result } from 'better-result'
import clsx, { type ClassValue } from 'clsx'
import Emittery from 'emittery'
import { delay } from 'es-toolkit'
import ms from 'ms'
import {
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type Key,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { useInView } from 'react-intersection-observer'
import { proxy, ref, useSnapshot } from 'valtio'
import { APP_CLS_GRID, appError, baseDebug } from '$common'
import { useEmitterOn } from '$common/hooks/useEmitter'
import { useRecSelfContext, type RefreshFn } from '$components/Recommends/rec.shared'
import { clsGateVideoGridDivider } from '$components/shared.module.scss'
import { VideoCard } from '$components/VideoCard'
import { useCardBorderCss } from '$components/VideoCard/card-border-css' // [tag-rec] (原 getActiveCardBorderCss 并入此)
import { EApiType, EGridDisplayMode, ETab } from '$enums'
import { $headerHeight } from '$header'
import { antMessage, antNotification } from '$modules/antd'
import { filterRecItems } from '$modules/filter'
import { multiSelectStore } from '$modules/multi-select/store'
import { concatRecItems, getGridRefreshCount, refreshForGrid } from '$modules/rec-services'
import { querySupportsLoadToEnd } from '$modules/rec-services/_shared/copy-bvid-buttons'
import { getServiceFromRegistry } from '$modules/rec-services/service-map.ts'
import { settings } from '$modules/settings'
import { TagRecAutoContinuation } from '$modules/tag-rec/model/auto-continuation'
import { tagRecDiscoveryPreferences } from '$modules/tag-rec/store/discovery-ui'
import { tagRecCustomSession } from '$modules/tag-rec/store/session'
import { isSafari } from '$ua'
import { ErrorDetail } from './error-detail'
import { useSetupGridState } from './rec-grid-state'
import { setGlobalGridItems } from './unsafe-window-export'
import { useRefresh } from './useRefresh'
import { getColumnCount, useShortcut } from './useShortcut'
import * as gridClassNames from './video-grid.module.scss'
import type { ArgsProps } from 'antd/es/notification'
import type { VideoCardEmitter, VideoCardEvents } from '$components/VideoCard/index.shared'
import type { RecItemType, RecItemTypeOrSeparator } from '$define'
import type { IVideoCardData } from '$modules/filter/normalize'
import type { IService } from '$modules/rec-services/_base'
import type { TagRecCustomService } from '$modules/tag-rec/service/tag-rec-custom'

const debug = baseDebug.extend('components:RecGrid')

// [tag-rec] AUDIT-04 同款收口: emittery 2 emit() 会把 listener 异常聚合为 AggregateError 抛出,
//   而多数 emit 调用点不接返回 promise => unhandled rejection; 同步 listener 统一经此兜底上报
const runEmitterListener = (fn: () => void) => {
  try {
    fn()
  } catch (e) {
    appError('recSharedEmitter listener error', e)
  }
}

export type RecGridRef = { refresh: RefreshFn }

export type RecGridProps = {
  containerClassName?: string
  className?: string
  shortcutEnabled: boolean
  infiniteScrollUseWindow: boolean
  onScrollToTop?: () => void
  scrollerRef?: RefObject<HTMLElement | null>
  tab: ETab
  direction?: 'left' | 'right' // how to get to current tab, moved left or right
  ref?: Ref<RecGridRef>
}

const clsGridColSpanFull = 'grid-col-span-full'

// [tag-rec] 「标签发掘」tab 空态教学 (替代「没有更多了~」): 未选组且未输入 => 空轮 (hasMore=false + 零条目)
//   才显示; 有内容列表 / 硬见底 (fullList 含见底 separator) 均不经过
const TAG_REC_CUSTOM_EMPTY_HINT = '输入关键词，或从左侧打开二级组试看；视频上的「选条件」可临时补条件。'

// like `this` in Class Component, but it's for Function Component
export class RecGridSelf {
  // render state
  private store = proxy({
    refreshKey: -1,
    showSkeleton: false,
    hasMore: true,
    refreshError: undefined as any,
    loadMoreError: undefined as any,
    items: [] as RecItemTypeOrSeparator[],
  })

  // #region getters
  get refreshKey() {
    return this.store.refreshKey
  }
  get refreshKeyValid() {
    return this.refreshKey > 0
  }
  get showSkeleton() {
    return this.store.showSkeleton
  }
  get items() {
    return this.store.items
  }
  get hasMore() {
    return this.store.hasMore
  }
  get refreshError() {
    return this.store.refreshError
  }
  get loadMoreError() {
    return this.store.loadMoreError
  }
  // #endregion

  useStore = () => {
    // oxlint-disable-next-line react-hooks/rules-of-hooks
    return useSnapshot(this.store)
  }

  setStore = (payload: Partial<RecGridSelf['store']>) => {
    const wrapRefKeys: (keyof RecGridSelf['store'])[] = ['items', 'refreshError', 'loadMoreError']
    for (const key of wrapRefKeys) {
      if (typeof payload[key] === 'object') {
        payload[key] = ref(payload[key])
      }
    }
    Object.assign(this.store, payload)
  }

  loadedPage = 0
  abortController = new AbortController()

  private loadMoreLocker: Map<Key, boolean> = new Map()
  isLocked = (lockKey: Key) => !!this.loadMoreLocker.get(lockKey)
  lock = (lockKey: Key) => void (this.loadMoreLocker = new Map([[lockKey, true]]))
  unlock = (lockKey: Key) => void this.loadMoreLocker.set(lockKey, false)
  get loadMoreRunning() {
    return this.isLocked(this.store.refreshKey)
  }
}

export const RecGrid = memo(function RecGrid({
  className: propClassName,
  containerClassName: propContainerClassName,
  shortcutEnabled,
  tab,
  infiniteScrollUseWindow,
  onScrollToTop,
  scrollerRef,
  ref,
}: RecGridProps) {
  // rec-shared
  const recSelf = useRecSelfContext()
  const { serviceRegistry, recSharedEmitter } = recSelf
  const { refreshing } = recSelf.useStore()
  // rec-grid
  const self = useCreation(() => new RecGridSelf(), [])
  const { items, hasMore, refreshError, refreshKey, showSkeleton, loadMoreError } = self.useStore()
  const {
    useCustomGrid,
    gridDisplayMode,
    enableForceColumn,
    forceColumnCount,
    cardMinWidth,
    enableForceRowGap,
    forceRowGap,
  } = useSnapshot(settings.grid)
  const { multiSelecting } = useSnapshot(multiSelectStore)
  const discoveryDisplay = useSnapshot(tagRecDiscoveryPreferences)
  const discoverySession = useSnapshot(tagRecCustomSession)
  const unmountedRef = useUnmountedRef()
  useSetupGridState()

  const updateViewFromService = useMemoizedFn(() => {
    if (unmountedRef.current) return
    recSelf.setStore({
      tabbarView: serviceRegistry[tab]?.tabbarView,
      sidebarView: serviceRegistry[tab]?.sidebarView,
    })
  })
  useMount(updateViewFromService)

  const preAction = useMemoizedFn(() => {
    clearActiveIndex()
    updateViewFromService()
    onScrollToTop?.()
  })
  const postAction = useMemoizedFn(() => {
    clearActiveIndex()
    updateViewFromService()
    self.loadedPage = 1
    checkShouldLoadMore()
  })
  const { refresh } = useRefresh({
    tab,
    debug,
    fetcher: refreshForGrid,
    preAction,
    postAction,
    updateViewFromService,
    self,
  })

  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  useEffect(() => setGlobalGridItems(items), [items])

  const goOutAt = useRef<number | undefined>(undefined)
  useEventListener(
    'visibilitychange',
    (_e) => {
      const visible = document.visibilityState === 'visible'
      if (!visible) {
        goOutAt.current = Date.now()
        return
      }

      if (recSelf.refreshing) return
      if (self.loadMoreRunning) return

      // 场景
      // 当前 Tab: 稍后再看, 点视频进去, 在视频页移除了, 关闭视频页, 回到首页
      if (
        (tab === ETab.Watchlater || tab === ETab.History) &&
        goOutAt.current &&
        Date.now() - goOutAt.current > ms('30s')
      ) {
        // [tag-rec] AUDIT-04: 裸调用 catch, 防内部 throw -> unhandled rejection
        void Promise.resolve(refresh('reuse')).catch((e) => appError('refresh() error', e))
      }
    },
    { target: document },
  )

  const checkShouldLoadMore = useMemoizedFn(async () => {
    await delay(isSafari ? 100 : 0) // always async
    debug('checkShouldLoadMore(): footerInViewRef = %s', footerInViewRef.current)
    if (footerInViewRef.current) return loadMore()
  })

  const loadMorePrecheck = useMemoizedFn(() => {
    if (
      // rec-shared
      recSelf.refreshing ||
      // rec-grid
      unmountedRef.current ||
      self.abortController.signal.aborted ||
      self.loadMoreRunning ||
      !self.refreshKeyValid || // before-start state
      !self.hasMore || // after-end state
      (getServiceFromRegistry(serviceRegistry, tab) as IService).autoLoadPaused ||
      // error
      self.refreshError ||
      self.loadMoreError
    ) {
      return false
    }
    return true
  })
  const loadMore = useMemoizedFn(async () => {
    if (!loadMorePrecheck()) return

    const getRefreshKey = () => self.refreshKey
    const startingRefreshKey = getRefreshKey()
    self.lock(startingRefreshKey)

    let newItems = self.items
    let newHasMore = true
    let err: any
    try {
      const service: IService = getServiceFromRegistry(serviceRegistry, tab)
      service.beginLoadOperation?.(self.abortController.signal)
      let more: RecItemTypeOrSeparator[]
      try {
        more = (await service.loadMore(self.abortController.signal)) || []
      } finally {
        service.endLoadOperation?.()
      }
      more = filterRecItems(more, tab)
      newItems = concatRecItems(newItems, more)
      newHasMore = service.hasMore
    } catch (e) {
      err = e
    }

    // loadMore 发出请求了, 但切 Tab 导致组件 unmount
    if (unmountedRef.current || self.abortController.signal.aborted) {
      debug(
        'loadMore: skip update for RecGrid unmounted or aborted: tab=%s startingRefreshKey=%s',
        tab,
        startingRefreshKey,
      )
      self.unlock(startingRefreshKey)
      return
    }
    // loadMore 发出请求了, 但稍候重新刷新了, setItems 以及后续操作应该 abort
    if (startingRefreshKey !== getRefreshKey()) {
      debug(
        'loadMore: skip update for refreshKey mismatch, expect %o but found %o',
        startingRefreshKey,
        getRefreshKey(),
      )
      self.unlock(startingRefreshKey)
      return
    }

    // error
    if (err) {
      self.unlock(startingRefreshKey)
      antNotification.error({ title: '加载失败', description: err.message || err.stack })
      self.setStore({ loadMoreError: err })
      throw err
    }

    self.loadedPage++
    debug('loadMore: loadedPage(%s) len(%s -> %s)', self.loadedPage, self.items.length, newItems.length)
    self.setStore({ hasMore: newHasMore, items: newItems })
    self.unlock(startingRefreshKey)
    // check
    checkShouldLoadMore()
  })
  const loadMoreRetry = useMemoizedFn(() => {
    self.setStore({ loadMoreError: undefined })
    return loadMore()
  })

  const loadToEnd = useMemoizedFn(async () => {
    /* #region precheck */
    const notifyKey = 'RecGrid:loadToEnd'
    const notifyErrorArgs: Partial<ArgsProps> = { key: notifyKey + ':error', title: '加载全部', duration: 15 }
    const notifySuccessArgs: Partial<ArgsProps> = { title: '加载全部' }
    const error = (description: ReactNode) => {
      antNotification.error({ ...notifyErrorArgs, description })
      throw new Error('loadToEnd error', { cause: description })
    }

    if (!querySupportsLoadToEnd()) return error('当前 Tab 不支持加载全部')
    if (self.refreshError) return error('预检查失败: 先前错误')
    // consider `!hasMore` as a success case
    if (!self.hasMore) {
      return antNotification.success({ ...notifySuccessArgs, description: '没有更多了' })
    }
    /* #endregion */

    while (!loadMorePrecheck()) await delay(500) // wait refresh + loadMore  complete
    while (loadMorePrecheck()) await loadMore()
    antNotification.success({ ...notifySuccessArgs, description: '已完成' })
  })
  useEmitterOn(recSharedEmitter, 'load-to-end', loadToEnd)

  // [tag-rec] 旁路异步落货 (手动「继续深挖」/Phase 2 等): service 复活但 grid hasMore 已锁死 =>
  // 重同步 hasMore + 页脚在视口即续拉 (队列/兜底堆货经 service.loadMore 正常上屏)
  const loadMoreOnExternalRefill = useMemoizedFn(() => {
    const service = getServiceFromRegistry(serviceRegistry, tab)
    if (service.hasMore && !self.hasMore) self.setStore({ hasMore: service.hasMore })
    checkShouldLoadMore()
  })
  // [tag-rec] AUDIT-04 同款: listener 抛错 (service 缺席 assert 等) 会聚合进 emit() reject,
  //   裸 emit('load-more') 调用点 -> unhandled rejection; 就地兜底上报
  useEmitterOn(recSharedEmitter, 'load-more', () => runEmitterListener(loadMoreOnExternalRefill))

  const [continuingDiscovery, setContinuingDiscovery] = useState(false)
  const continuationLock = useRef(false)
  const autoContinuation = useMemo(() => new TagRecAutoContinuation(), [refreshKey])
  const [autoContinueTick, setAutoContinueTick] = useState(0)
  const continueDiscovery = useMemoizedFn(async (automatic = false) => {
    if (
      tab !== ETab.TagRecCustom ||
      continuationLock.current ||
      self.loadMoreRunning ||
      recSelf.refreshing ||
      !self.refreshKeyValid
    )
      return
    const service = serviceRegistry[ETab.TagRecCustom] as TagRecCustomService | undefined
    if (!service) return
    const key = self.refreshKey
    if (!automatic) autoContinuation.resume()
    continuationLock.current = true
    setContinuingDiscovery(true)
    try {
      tagRecCustomSession.supplyPaused = false
      service.retryPartitions()
      if (tagRecCustomSession.digPending || !service.hasMore) await service.digMore(automatic)
      if (unmountedRef.current || self.abortController.signal.aborted || key !== self.refreshKey) return
      self.setStore({ hasMore: service.hasMore, loadMoreError: undefined })
      await loadMore()
    } catch (error) {
      appError('tag discovery continuation failed', error)
    } finally {
      continuationLock.current = false
      setContinuingDiscovery(false)
    }
  })
  useEmitterOn(recSharedEmitter, 'tag-rec:continue', () => continueDiscovery())

  // fullList = videoList + separators
  const fullList = items
  const videoList = useMemo(() => fullList.filter((x) => x.api !== EApiType.Separator), [fullList])
  // [tag-rec] AUDIT-06: uniqId -> videoList 下标一次建图, renderItem/large-preview O(1) 查
  //   (原 renderItem 内逐项 findIndex => 整表渲染 O(n²)); 重复 uniqId 取首个, 与 findIndex 语义一致
  const videoIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    videoList.forEach((x, i) => {
      if (!m.has(x.uniqId)) m.set(x.uniqId, i)
    })
    return m
  }, [videoList])

  // the grid: `.video-grid`
  const gridRef = useRef<HTMLDivElement | null>(null)

  const getScrollerRect = useMemoizedFn(() => {
    // use window
    if (infiniteScrollUseWindow) {
      const yStart = $headerHeight.get() + 50 // 50 RecHeader height
      return new DOMRect(0, yStart, window.innerWidth, window.innerHeight - yStart)
    }
    // use in a scroller
    else {
      return scrollerRef?.current?.getBoundingClientRect()
    }
  })

  // emitters
  const videoCardEmitterCache = useMemo(() => new Map<string, VideoCardEmitter>(), [refreshKey])
  const videoCardEmitters = useMemo(() => {
    return videoList.map(({ uniqId }) => {
      const cacheKey = uniqId
      return (
        videoCardEmitterCache.get(cacheKey) ||
        (() => {
          const instance = new Emittery<VideoCardEvents>()
          videoCardEmitterCache.set(cacheKey, instance)
          return instance
        })()
      )
    })
  }, [videoList])

  const [activeLargePreviewUniqId, setActiveLargePreviewUniqId] = useState<string | undefined>(undefined)
  useEmitterOn(recSharedEmitter, 'show-large-preview', ({ data: uniqId }) => setActiveLargePreviewUniqId(uniqId))
  const activeLargePreviewItemIndex = useMemo(() => {
    if (!activeLargePreviewUniqId) return
    return videoIndexMap.get(activeLargePreviewUniqId) // [tag-rec] AUDIT-06: 复用同一张图 (原 dep 误写 fullList)
  }, [videoIndexMap, activeLargePreviewUniqId])

  // 快捷键
  const { activeIndex, clearActiveIndex } = useShortcut({
    shortcutEnabled,
    maxIndex: videoList.length - 1,
    gridRef,
    getScrollerRect,
    videoCardEmitters,
    activeLargePreviewItemIndex,
    changeScrollY: infiniteScrollUseWindow
      ? function ({ offset, absolute }) {
          const scroller = document.documentElement
          if (typeof offset === 'number') {
            scroller.scrollTop += offset
            return
          }
          if (typeof absolute === 'number') {
            scroller.scrollTop = absolute
            return
          }
        }
      : undefined,
  })

  /**
   * card state change
   */
  type Modifier = (items: RecItemTypeOrSeparator[]) => RecItemTypeOrSeparator[] | undefined
  const modifyItems = useMemoizedFn((fn: Modifier) => {
    const val = self.items
    self.setStore({ items: fn(val) ?? val })
  })
  const handleRemoveCards = useMemoizedFn(
    (uniqIds: string[], titles?: string[], messageConfig?: { silent?: boolean; itemsDescription?: string }) => {
      modifyItems((items) => {
        // [tag-rec] AUDIT-06: 单遍过滤替代逐项 findIndex+splice (原 O(k·n) + splice 移位重扫);
        //   pending 命中即消费 => 每个 uniqId 只删首个匹配项, 与原语义一致
        const pending = new Map(uniqIds.map((uniqId, i) => [uniqId, i]))
        const newItems: RecItemTypeOrSeparator[] = []
        const removedTitlePairs: [pos: number, title: string][] = []

        for (const item of items) {
          const pos = pending.get(item.uniqId)
          if (pos === undefined) {
            newItems.push(item)
            continue
          }
          pending.delete(item.uniqId)
          const title = titles?.[pos]
          if (title) removedTitlePairs.push([pos, title])

          // side effects
          if (tab === ETab.Watchlater) {
            serviceRegistry[tab]?.decreaseTotal()
          }
          if (tab === ETab.Fav) {
            serviceRegistry[tab]?.decreaseTotal()
          }
        }
        // [tag-rec] 保持原顺序语义: titles 按 uniqIds 入参序 (原逐项循环序)
        const removedTitles = removedTitlePairs.sort((a, b) => a[0] - b[0]).map(([, t]) => t)

        // 稍后再看最近的删完了, 最近的 separator 也删掉
        if (
          tab === ETab.Watchlater &&
          newItems.length > 2 &&
          newItems.slice(0, 2).every((x) => x.api === EApiType.Separator)
        ) {
          newItems.splice(0, 1)
        }

        const silent = messageConfig?.silent ?? false
        const itemsDescription = messageConfig?.itemsDescription ?? '个视频'
        if (!silent && removedTitles.length) {
          if (removedTitles.length <= 3) {
            removedTitles.forEach((t) => antMessage.success(`已移除: ${t}`))
          } else {
            antMessage.success(`已移除: ${removedTitles.length}${itemsDescription}`)
          }
        }

        return newItems
      })
    },
  )
  const handleMoveCardTo = useMemoizedFn((itemUniqId: string, pos: 'start' | 'end') => {
    modifyItems((items) => {
      const index = items.findIndex((x) => x.uniqId === itemUniqId)
      if (index === -1) return
      // move to start
      if (pos === 'start') {
        const firstNoneSeparatorIndex = items.findIndex((x) => x.api !== EApiType.Separator)
        return arrayMove(items, index, firstNoneSeparatorIndex)
      }
      // to end
      else if (pos === 'end') {
        // NOTE: 移到最后也不太准确, 需考虑分页加载
        return arrayMove(items, index, items.length - 1)
      }
    })
  })
  // [tag-rec] AUDIT-05: VideoCard memo 浅比较要稳 —— onRemoveCurrent 用单例 fn,
  //   原 `(item, data, silent) => handleRemoveCards(...)` 内联箭头每轮新引用必击穿全卡重渲
  const onRemoveCardCurrent = useMemoizedFn((item: RecItemType, data: IVideoCardData, silent?: boolean) =>
    handleRemoveCards([item.uniqId], [data.title], { silent }),
  )
  useEmitterOn(recSharedEmitter, 'remove-cards', ({ data }) => runEmitterListener(() => handleRemoveCards(...data)))
  useEmitterOn(recSharedEmitter, 'move-card-to', ({ data }) => runEmitterListener(() => handleMoveCardTo(...data)))

  /**
   * footer for infinite scroll
   */
  const { ref: footerRef, inView: __footerInView } = useInView({
    root: infiniteScrollUseWindow ? null : scrollerRef?.current || null,
    rootMargin: `0px 0px ${window.innerHeight}px 0px`,
    onChange(inView) {
      if (inView) {
        debug('footerInView change to visible')
        Result.try(() => (footerInViewRef.current = true))
        checkShouldLoadMore()
      }
    },
  })
  const footerInViewRef = useLatest(__footerInView)
  const footerElement = useRef<HTMLDivElement | null>(null)
  const setFooterRef = useMemoizedFn((node: HTMLDivElement | null) => {
    footerRef(node)
    footerElement.current = node
  })
  const [scrollDemand, setScrollDemand] = useState(false)
  const [scrollTick, setScrollTick] = useState(0)
  const scrollPosition = useMemoizedFn(() =>
    infiniteScrollUseWindow ? window.scrollY : (scrollerRef?.current?.scrollTop ?? 0),
  )
  const lastScrollPosition = useRef(0)
  useEffect(() => {
    setScrollDemand(false)
    lastScrollPosition.current = scrollPosition()
  }, [refreshKey, scrollPosition])
  useEventListener(
    'scroll',
    () => {
      if (tab !== ETab.TagRecCustom) return
      const position = scrollPosition()
      if (position > lastScrollPosition.current + 1) setScrollDemand(true)
      lastScrollPosition.current = position
      setScrollTick((tick) => tick + 1)
    },
    { target: () => (infiniteScrollUseWindow ? window : scrollerRef?.current) },
  )
  useEventListener('visibilitychange', () => setScrollTick((tick) => tick + 1), { target: document })
  const nearDiscoveryEnd = useMemoizedFn(() => {
    const rect = footerElement.current?.getBoundingClientRect()
    const bottom = infiniteScrollUseWindow
      ? window.innerHeight
      : (scrollerRef?.current?.getBoundingClientRect().bottom ?? 0)
    return !!rect && rect.top <= bottom + 240 && rect.bottom >= 0
  })
  // Normal pages already use infinite loading. Continue bounded verification/deep-dig batches on scrolling too.
  useEffect(() => {
    if (
      tab !== ETab.TagRecCustom ||
      !scrollDemand ||
      refreshing ||
      continuingDiscovery ||
      loadMoreError ||
      refreshError ||
      discoverySession.supplyPaused ||
      (!discoverySession.partitionPaused && !discoverySession.digPending) ||
      document.visibilityState !== 'visible' ||
      !nearDiscoveryEnd()
    )
      return
    const wait = autoContinuation.delay(Date.now())
    if (wait === undefined) return
    const timer = setTimeout(() => {
      if (
        document.visibilityState !== 'visible' ||
        !nearDiscoveryEnd() ||
        self.loadMoreRunning ||
        recSelf.refreshing ||
        continuationLock.current ||
        self.abortController.signal.aborted ||
        !autoContinuation.start(Date.now())
      )
        return
      const key = self.refreshKey
      const before = self.items.filter((item) => item.api !== EApiType.Separator).length
      void continueDiscovery(true).finally(() => {
        const after = self.items.filter((item) => item.api !== EApiType.Separator).length
        autoContinuation.finish(Date.now(), after - before)
        if (!unmountedRef.current && key === self.refreshKey) setAutoContinueTick((tick) => tick + 1)
      })
    }, wait)
    return () => clearTimeout(timer)
  }, [
    tab,
    scrollDemand,
    scrollTick,
    autoContinueTick,
    refreshing,
    continuingDiscovery,
    loadMoreError,
    refreshError,
    discoverySession.supplyPaused,
    discoverySession.partitionPaused,
    discoverySession.digPending,
    items,
    autoContinuation,
    nearDiscoveryEnd,
    self,
    recSelf,
    continueDiscovery,
    unmountedRef,
  ])
  const footer = (
    <div
      ref={setFooterRef}
      className={clsx(clsGridColSpanFull, 'flex items-center justify-center py-30px text-size-120%')}
    >
      {(() => {
        if (refreshing) return
        if (loadMoreError)
          return (
            <ErrorDetail
              err={loadMoreError}
              onRetry={tab === ETab.TagRecCustom ? () => continueDiscovery() : loadMoreRetry}
            />
          )
        if (tab === ETab.TagRecCustom) {
          const paused =
            discoverySession.supplyPaused || discoverySession.partitionPaused || discoverySession.digPending
          return (
            <div className='flex flex-col items-center gap-10px' style={{ fontSize: 13 }}>
              <span aria-live='polite'>
                已展示 {videoList.length} 条
                {discoverySession.supplyPaused
                  ? ' · 只浏览缓存'
                  : autoContinuation.stalled
                    ? ' · 暂时没有新视频，自动发掘已暂停'
                    : continuingDiscovery
                      ? ' · 正在继续发掘…'
                      : discoverySession.partitionPaused
                        ? ` · ${discoverySession.partitionPending} 条待核实，向下浏览会自动继续`
                        : discoverySession.digPending
                          ? ' · 向下浏览会自动深挖下一批'
                          : !hasMore
                            ? videoList.length
                              ? ' · 当前来源暂时没有新结果'
                              : ` · ${TAG_REC_CUSTOM_EMPTY_HINT}`
                            : ' · 向下滚动会自动加载'}
              </span>
              {(hasMore || paused) && (
                <Button
                  type='primary'
                  loading={continuingDiscovery || discoverySession.digRunning}
                  onClick={() => void continueDiscovery()}
                >
                  {discoverySession.supplyPaused ? '继续发掘' : '加载更多视频'}
                </Button>
              )}
              {paused && !discoverySession.supplyPaused && (
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  约 8 秒后可自动续批，也可点按钮继续；已有视频会保留。
                </span>
              )}
            </div>
          )
        }
        if (!hasMore) {
          return '没有更多了~'
        }
        return (
          <>
            <IconParkOutlineLoading className='mr-10px size-40px animate-spin color-gate-primary' />
            加载中~
          </>
        )
      })()}
    </div>
  )

  // it's a `@container` query root
  const containerClassName = clsx('min-h-100vh @container-inline-size', propContainerClassName)

  type StyleProps = Pick<ComponentProps<'div'>, 'className' | 'style'>
  const gridStyleProps: StyleProps = useMemo(() => {
    if (tab === ETab.TagRecCustom)
      return {
        className: clsx(APP_CLS_GRID, gridClassNames.videoGrid, gridClassNames.videoGridCustom, propClassName),
        style: {
          'gridTemplateColumns': `repeat(auto-fill, minmax(min(100%, ${{ small: 220, medium: 285, large: 370 }[discoveryDisplay.size] ?? 285}px), 1fr))`,
          '--row-gap': '24px',
        },
      }
    const {
      videoGrid,
      videoGridBiliFeed4,
      videoGridCustom,
      videoGridAddonCenterEmpty,
      gridTemplateColumnsUsingVarCol,
      gridTemplateColumnsUsingCardMinWidth,
      narrowMode,
    } = gridClassNames

    // 分支
    // - videoGridBiliFeed4
    // - videoGridCustom
    //   - forceColumn
    //   - cardMinWidth
    //
    // displayMode
    //  - TwoColumn
    //  - List
    //  - CenterEmpty: Normal + addonCenterEmpty
    //  - Normal

    const clsGridTemplateColumns =
      useCustomGrid && !(enableForceColumn && forceColumnCount) && gridDisplayMode !== EGridDisplayMode.TwoColumnGrid
        ? gridTemplateColumnsUsingCardMinWidth
        : gridTemplateColumnsUsingVarCol

    const baseClass: ClassValue = [
      APP_CLS_GRID, // for customize css
      videoGrid,
      clsGridTemplateColumns,
      useCustomGrid ? videoGridCustom : videoGridBiliFeed4,
    ]

    let baseStyle: CSSProperties | undefined
    if (enableForceRowGap && forceRowGap && useCustomGrid) {
      baseStyle ||= {}
      baseStyle['--row-gap'] = `${forceRowGap}px`
    }

    const renderClassName = (...more: ClassValue[]) => clsx(baseClass, ...more, propClassName)

    // 双列
    if (gridDisplayMode === EGridDisplayMode.TwoColumnGrid) {
      return { className: renderClassName(narrowMode), style: baseStyle }
    }

    // 中空
    if (gridDisplayMode === EGridDisplayMode.CenterEmptyGrid) {
      baseClass.push(videoGridAddonCenterEmpty)
    }

    // bili-feed4
    if (!useCustomGrid) {
      return { className: renderClassName(), style: baseStyle }
    }

    // Bilibili-Gate custom
    if (enableForceColumn && forceColumnCount) {
      return { className: renderClassName(), style: { ...baseStyle, '--col': forceColumnCount.toString() } }
    } else {
      return { className: renderClassName(), style: { ...baseStyle, '--card-min-width': `${cardMinWidth}px` } }
    }
  }, [
    gridClassNames,
    useCustomGrid,
    gridDisplayMode,
    enableForceColumn,
    forceColumnCount,
    cardMinWidth,
    enableForceRowGap,
    forceRowGap,
    propClassName,
    tab,
    discoveryDisplay.size,
  ])

  const cardBorderCss = useCardBorderCss()

  // 总是 render grid, getColumnCount 依赖 grid columns
  const render = ({ gridChildren, gridSiblings }: { gridChildren?: ReactNode; gridSiblings?: ReactNode } = {}) => {
    return (
      <div data-tab={tab} className={containerClassName}>
        <div data-tab={tab} ref={gridRef} {...gridStyleProps}>
          {gridChildren}
        </div>
        {gridSiblings}
      </div>
    )
  }

  // Shit happens!
  if (refreshError) {
    appError('RecGrid.refresh error:', refreshError)
    return render({ gridSiblings: <ErrorDetail tab={tab} err={refreshError} /> })
  }

  // skeleton loading
  if (refreshing && showSkeleton) {
    const cardCount = getGridRefreshCount()
    return render({
      gridChildren: Array.from({ length: cardCount })
        .fill(0)
        .map((_, index) => {
          return <VideoCard key={index} loading={true} tab={tab} />
        }),
    })
  }

  // [tag-rec] AUDIT-21: eager 阈值与列数挂钩 —— 一刷量 = cols*4 (getGridRefreshCount), 恒定 8 在
  //   宽屏首行(>8 列)漏 eager; getColumnCount 自身已收敛 List=1/TwoColumn=2/forceColumn, max(8) 保底窄屏
  const eagerCoverCount = Math.max(8, getColumnCount(gridRef.current) * 2)

  const renderItem = (item: RecItemTypeOrSeparator) => {
    if (item.api === EApiType.Separator) {
      const shouldWrap = item.wrapWithDivider ?? true
      return <Fragment key={item.uniqId}>{shouldWrap ? wrapWithDivider(item.content) : item.content}</Fragment>
    } else {
      const index = videoIndexMap.get(item.uniqId) ?? -1 // [tag-rec] AUDIT-06: Map O(1) 查 (原 findIndex => O(n²))
      const active = index === activeIndex

      return (
        <VideoCard
          key={item.uniqId}
          // [tag-rec] AUDIT-05: baseCss 只传稳定 cardBorderCss, active 边样式已收进 VideoCard 内部
          //   (原 `[cardBorderCss, getActiveCardBorderCss(active)]` 数组字面量 + 内联 onRemoveCurrent 每轮新引用击穿 memo)
          baseCss={cardBorderCss}
          tab={tab}
          item={item}
          active={active}
          onRemoveCurrent={onRemoveCardCurrent}
          emitter={videoCardEmitters[index]}
          recSharedEmitter={recSharedEmitter}
          gridDisplayMode={tab === ETab.TagRecCustom ? EGridDisplayMode.NormalGrid : gridDisplayMode}
          multiSelecting={multiSelecting}
          // [tag-rec] 票 perf-05: 首屏约两排封面 eager 免 IO 门控, 首张 fetchpriority=high
          eagerCover={index !== -1 && index < eagerCoverCount}
          highPriorityCover={index === 0}
        />
      )
    }
  }

  // plain dom
  return render({
    gridChildren: (
      <>
        {fullList.map(renderItem)}
        {footer}
      </>
    ),
  })
})

export function wrapWithDivider(children: ReactNode) {
  return (
    <Divider
      className={clsx(clsGridColSpanFull, clsGateVideoGridDivider)}
      orientation='horizontal'
      titlePlacement='left'
    >
      {children}
    </Divider>
  )
}
