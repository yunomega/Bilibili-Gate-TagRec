import { assert } from 'es-toolkit'
import { snapshot } from 'valtio'
import { ETab } from '$enums'
import { getSettingsSnapshot } from '$modules/settings'
import { AppRecService, getAppRecServiceConfig } from './app'
import { DynamicFeedRecService, getDynamicFeedServiceConfig } from './dynamic-feed'
import { FavRecService, getFavServiceConfig } from './fav'
import { getHistoryRecServiceConfig, HistoryRecService } from './history'
import { HotRecService } from './hot'
import { LikedRecService } from './liked'
import { LiveRecService } from './live'
import { PcRecService } from './pc'
import { getSpaceUploadServiceConfig, SpaceUploadService } from './space-upload'
import { WatchlaterRecService } from './watchlater'
import { watchlaterStore } from './watchlater/store'
import type { TagRecConditionAtom } from '$modules/tag-rec/model/combination'
import type { BaseTabService } from './_base'

export const REC_TABS = [ETab.KeepFollowOnly, ETab.PcRecommend, ETab.AppRecommend] satisfies ETab[]

export type RecTab = (typeof REC_TABS)[number]

export function isRecTab(tab: ETab): tab is RecTab {
  return REC_TABS.includes(tab)
}

export const createServiceMap = {
  [ETab.AppRecommend]: () => new AppRecService(getAppRecServiceConfig()),
  [ETab.PcRecommend]: () =>
    new PcRecService({
      isKeepFollowOnly: false,
      anonymousFetch: getSettingsSnapshot().pcRecommend.anonymousFetch,
    }),
  [ETab.KeepFollowOnly]: () =>
    new PcRecService({
      isKeepFollowOnly: true,
      anonymousFetch: false,
    }),
  [ETab.DynamicFeed]: () => new DynamicFeedRecService(getDynamicFeedServiceConfig()),
  [ETab.Watchlater]: ({ existingService }) => {
    const { addSeparator, itemsOrder } = getSettingsSnapshot().watchlater
    const { searchText } = snapshot(watchlaterStore)
    const prevShuffleBvidIndexMap =
      existingService && existingService instanceof WatchlaterRecService
        ? existingService.getServiceSnapshot().bvidIndexMap
        : undefined
    return new WatchlaterRecService(itemsOrder, addSeparator, prevShuffleBvidIndexMap, searchText)
  },
  [ETab.Fav]: () => new FavRecService(getFavServiceConfig()),
  [ETab.Hot]: () => new HotRecService(),
  [ETab.Live]: () => new LiveRecService(),
  [ETab.SpaceUpload]: () => new SpaceUploadService(getSpaceUploadServiceConfig()),
  [ETab.Liked]: () => new LikedRecService(),
  [ETab.History]: () => new HistoryRecService(getHistoryRecServiceConfig()),
  // [tag-rec] 票 perf-08: 类引用由 loadTagRecServiceClasses 惰性填充 —— 整个 tag-rec
  //   service/model/api 图 (~17k LOC) 脱急切求值, 首次进入 tag-rec tab 才 eval。
  //   useRefresh 在建 service 前 await 该 loader (与水合闸同点), 此处构造仍保持同步契约。
  [ETab.TagRecFav]: () => new (assertTagRecLoaded('TagRecFavService'))(),
  [ETab.TagRecCustom]: () => new (assertTagRecLoaded('TagRecCustomService'))(),
} satisfies Record<ETab, (options: { existingService?: BaseTabService }) => BaseTabService>

const tagRecServiceClasses: Partial<Record<'TagRecFavService' | 'TagRecCustomService', new () => BaseTabService>> = {}

function assertTagRecLoaded(key: 'TagRecFavService' | 'TagRecCustomService') {
  const ctor = tagRecServiceClasses[key]
  assert(ctor, `[tag-rec] ${key} 未加载 —— useRefresh 应先 await loadTagRecServiceClasses()`)
  return ctor
}

// [tag-rec] 票 perf-08: 惰性装载两 service 类 (SystemJS 惰性 chunk, 求值推迟到首个 tag-rec tab)
export function loadTagRecServiceClasses() {
  return Promise.all([
    import('$modules/tag-rec/service/tag-rec-fav'),
    import('$modules/tag-rec/service/tag-rec-custom'),
  ]).then(([fav, custom]) => {
    tagRecServiceClasses.TagRecFavService = fav.TagRecFavService
    tagRecServiceClasses.TagRecCustomService = custom.TagRecCustomService
    // 漂移检查器随类一并注册 (原 useRefresh instanceof+签名比对, 急切引用会钉回模块图)
    tagRecDriftCheckers.set(ETab.TagRecFav, (svc) => {
      return (
        svc instanceof fav.TagRecFavService &&
        // A4-3: 过滤签名同属「条件变更」— 收紧型编辑的在途 emit 原被静默丢, 存货重滤永不发生
        (svc.contextSignature !== fav.computeTagRecFavContextSignature() ||
          svc.filterSignature !== fav.computeTagRecFavFilterSignature())
      )
    })
    tagRecDriftCheckers.set(ETab.TagRecCustom, (svc) => {
      return (
        svc instanceof custom.TagRecCustomService &&
        (svc.contextSignature !== custom.computeTagRecCustomContextSignature() ||
          svc.filterSignature !== custom.computeTagRecCustomFilterSignature())
      )
    })
    // A4-6: 内存 seen 清道夫随类注册 —— 「清空已看」销毁链须穿透惰性边界
    tagRecSeenClearers.set(ETab.TagRecFav, fav.clearTagRecFavSharedSeenBvids)
    tagRecSeenClearers.set(ETab.TagRecCustom, custom.clearTagRecCustomSharedSeenBvids)
    // Q8a: 选条件成本预览随类注册 (UI 侧急切、service 类惰性, 同清道夫边界)
    tagRecImpactEstimators.set(ETab.TagRecCustom, custom.tagRecLocalConditionImpact)
  })
}

// [tag-rec] 票 perf-08: 语境漂移检查注册表 —— useRefresh 的签漂判定不再 instanceof 惰性
//   service 类 (instanceof 急切引用会把模块图钉回急切求值); service 模块 eval 时自注册,
//   注册表项缺失(=类未加载=registry 里不可能有该 service)时返回 false。
export const tagRecDriftCheckers = new Map<ETab, (svc: BaseTabService) => boolean>()

export function checkTagRecContextDrift(tab: ETab, svc: BaseTabService | undefined): boolean {
  if (!svc) return false
  return tagRecDriftCheckers.get(tab)?.(svc) ?? false
}

/**
 * A4-6: 「清空已看」销毁链 —— 两 tab service 的跨轮内存 seen (sharedSeenBvids) 清道夫注册表。
 *   pane 侧急切、service 类惰性 (同 drift-checker 边界); 未加载 = 无存货可清, 天然幂等。
 *   不清的后果: 持久池空但条级去重记忆还在 => 已滤条仍被挡在池外, 「已看重新进推荐流」承诺破产。
 */
export const tagRecSeenClearers = new Map<ETab, () => void>()

export function notifyTagRecSeenCleared(): void {
  for (const clear of tagRecSeenClearers.values()) clear()
}

/**
 * Q8a: 选条件成本预览注册表 —— UI 侧急切、service 类惰性 (同 seen 清道夫边界);
 *   service 未加载 = 工作台未起 = 无存量可估, 返回保守空估算。
 */
export const tagRecImpactEstimators = new Map<
  ETab,
  (atom: TagRecConditionAtom) => { hits: number; join: 'any' | 'all' }
>()

export function estimateTagRecConditionImpact(atom: TagRecConditionAtom): { hits: number; join: 'any' | 'all' } {
  return tagRecImpactEstimators.get(ETab.TagRecCustom)?.(atom) ?? { hits: 0, join: 'all' }
}

export type ServiceMapKey = keyof typeof createServiceMap

export type ServiceMap = {
  [K in ServiceMapKey]: ReturnType<(typeof createServiceMap)[K]>
}

export type FetcherOptions = {
  tab: ETab
  service: BaseTabService
  abortSignal: AbortSignal
}

export function getServiceFromRegistry<T extends ETab>(serviceRegistry: Partial<ServiceMap>, tab: T): ServiceMap[T] {
  const service = serviceRegistry[tab]
  assert(service, `serviceRegistry[tab=${tab}] should not be nil`)
  return service
}

// [tag-rec] 票 perf-09: mount 前预热 —— initHomepagePureRecommend 在 header-poll/createRoot 窗口内
//   预建当前 tab 的 service 并发起首个 loadMore(结果落 qs.returnQueue/bufferQueue);
//   useRefresh 'reuse' 首刷时经 takePrewarmedTabService 取回, 注入 serviceRegistry 走既有
//   existingService 通道 —— 抹平 mount→fetch 串行段 (~50-150ms)。
//   仅 REC_TABS(均无 swr): swr tab 命中后 useRefresh 会再建 service 造成二次拉取;
//   tag-rec tab 构造需先等 tagRecStoresHydrated 水合(useRefresh:234-237), 均不在此预热。
export type PrewarmedTabServiceEntry = { service: ServiceMap[ETab]; firstFetch: Promise<unknown> }
const prewarmedTabServices = new Map<ETab, PrewarmedTabServiceEntry>()

export function prewarmTabService(tab: ETab) {
  if (!isRecTab(tab) || prewarmedTabServices.has(tab)) return
  // satisfies 保留了各条目的零参签名, 这里按 Record 签名收窄再调
  const create = createServiceMap[tab] as (options: { existingService?: BaseTabService }) => ServiceMap[ETab]
  const service = create({})
  // loadMore = fetchMore + qs 队列回填; 永不 abort (独立 controller), 失败静默吞掉,
  // 挂载路径照常重试/报错, 预热属纯优化
  const firstFetch = service.loadMore(new AbortController().signal).catch(() => undefined)
  const entry: PrewarmedTabServiceEntry = { service, firstFetch }
  prewarmedTabServices.set(tab, entry)
  // 未被首刷消费(预热 tab != 实际 mount tab 等边缘场景)时过期丢弃, 避免注入陈旧 service
  // [tag-rec] AUDIT-31: 到期比对条目身份再删 —— take/回补后同 tab 二次 prewarm 时, 旧 timer 不得误杀新条目
  setTimeout(() => {
    if (prewarmedTabServices.get(tab) === entry) prewarmedTabServices.delete(tab)
  }, 30_000)
}

export function takePrewarmedTabService(tab: ETab) {
  const prewarmed = prewarmedTabServices.get(tab)
  prewarmedTabServices.delete(tab)
  return prewarmed
}

// [tag-rec] AUDIT-31: take 后本轮 refresh 被 abort 的回补口 —— 槽位仍空则放回同一条目
//   (原 TTL timer 按身份继续生效, 死期不重置), 留给同 tab 下次 mount 消费, 避免孤儿化白付首 fetch;
//   已有新 prewarm 占位则弃 (防回填覆盖)
export function restorePrewarmedTabService(tab: ETab, entry: PrewarmedTabServiceEntry) {
  if (!prewarmedTabServices.has(tab)) prewarmedTabServices.set(tab, entry)
}
