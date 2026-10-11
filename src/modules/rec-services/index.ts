import { uniqBy } from 'es-toolkit'
import { baseDebug } from '$common'
import { getColumnCount } from '$components/RecGrid/useShortcut'
import { checkIsDynamicFeed, type RecItemTypeOrSeparator } from '$define'
import { EApiType, ETab } from '$enums'
import { filterRecItems } from '$modules/filter'
import { normalizeCardData } from '$modules/filter/normalize'
import { settings } from '$modules/settings'
import { AppRecService } from './app'
import { DynamicFeedItemHelper } from './dynamic-feed/api/enums'
import { PcRecService } from './pc'
import { isRecTab, type FetcherOptions } from './service-map'
import type { IService } from './_base'
import type { DynamicFeedRecService } from './dynamic-feed'

const debug = baseDebug.extend('service')

export const recItemUniqer = (item: RecItemTypeOrSeparator): string => {
  if (item.api === EApiType.Separator) return item.uniqId
  const { bvid } = normalizeCardData(item)
  {
    // DynamicFeed uniq 逻辑特殊
    // see https://github.com/magicdawn/Bilibili-Gate/issues/259
    // 具体:
    // 1. 保留原视频, 保留转发原视频的所有转发动态
    // 2. 对于联合投稿: 作者1动态 + 作者2动态 + ..., 仅保留一个
    if (checkIsDynamicFeed(item)) {
      return !!bvid && DynamicFeedItemHelper.isVideo(item) ? `${EApiType.DynamicFeed}:video:${bvid}` : item.uniqId
    }
  }
  return bvid || item.uniqId
}

export function concatRecItems(existing: RecItemTypeOrSeparator[], newItems: RecItemTypeOrSeparator[]) {
  return uniqBy([...existing, ...newItems], recItemUniqer)
}

const willUsePcApi = (tab: ETab): tab is ETab.PcRecommend | ETab.KeepFollowOnly =>
  tab === ETab.PcRecommend || tab === ETab.KeepFollowOnly

async function fetchMinCount(count: number, fetcherOptions: FetcherOptions, filterMultiplier = 5) {
  const { tab, service, abortSignal } = fetcherOptions
  const loadControl: IService = service

  let items: RecItemTypeOrSeparator[] = []
  let hasMore = true
  const concatMore = (more: RecItemTypeOrSeparator[]) => {
    const moreFiltered = filterRecItems(more, tab) // filter
    items = concatRecItems(items, moreFiltered) // concat
  }

  const addMore = async (restCount: number) => {
    // dynamic-feed     动态
    // watchlater       稍候再看
    // fav              收藏
    // hot              热门 (popular-general  综合热门, popular-weekly  每周必看, ranking  排行榜)
    // live             直播
    if (!isRecTab(tab)) {
      const more = (await service.loadMore(abortSignal)) ?? []
      concatMore(more)
      hasMore = service.hasMore
      return
    }

    /**
     * REC_TABS
     */
    let times: number
    if (tab === ETab.KeepFollowOnly) {
      // 已关注
      times = 8
      debug('getMinCount: addMore(restCount = %s) times=%s', restCount, times)
    } else {
      // 常规
      const pagesize = willUsePcApi(tab) ? PcRecService.PAGE_SIZE : AppRecService.PAGE_SIZE
      // [tag-rec] 票 perf-09: hasFilter 语义修正 —— 原 `enabled ||` 裸值(默认 true)恒真,
      //   子维全关时 ×5 是纯空转(默认场景 times=9 路并发 GM_xhr feed/index)。
      //   改判「master enabled 且至少一个真会吃条目的子维启用」:
      //   - byAuthor/byTitle 须有 keywords 才会真过滤 (见 modules/filter)
      //   - hideGotoType* 为裸布尔, 开启即过滤 picture/bangumi
      //   - exemptForFollowed 是豁免不是过滤; `关注了你`剔除/黑名单为少数路径, 不计入
      //   - df* 子维只吃 dynamic-feed 条目, rec tab 无此 api 条目, 不计入
      const hasFilter = (() => {
        const f = settings.filter
        if (!f.enabled) return false
        return (
          f.minDuration.enabled ||
          f.minPlayCount.enabled ||
          f.minDanmakuCount.enabled ||
          (f.byAuthor.enabled && !!f.byAuthor.keywords.length) ||
          (f.byTitle.enabled && !!f.byTitle.keywords.length) ||
          f.hideGotoTypePicture ||
          f.hideGotoTypeBangumi
        )
      })()

      const multipler = hasFilter
        ? filterMultiplier // 过滤, 需要大基数
        : 1.2 // 可能有重复, so not 1.0
      times = Math.ceil((restCount * multipler) / pagesize)
      debug(
        'getMinCount: addMore(restCount = %s) multipler=%s pagesize=%s times=%s',
        restCount,
        multipler,
        pagesize,
        times,
      )
    }

    if (willUsePcApi(tab)) {
      const s = service as PcRecService
      if (s.isFirstAuthedFetch) await s.preloadPcInitialRecItems(abortSignal)
      await s.preloadTimesFromApiIfNeeded(abortSignal, times)
    } else {
      const s = service as AppRecService
      if (!s.config.addOtherTabContents) {
        await s.preloadTimesFromApiIfNeeded(abortSignal, times)
      }
    }

    const more = (await service.loadMore(abortSignal)) || []
    concatMore(more)
    hasMore = service.hasMore
  }

  loadControl.beginLoadOperation?.(abortSignal)
  try {
    await addMore(count)
    const len = () => items.filter((x) => x.api !== EApiType.Separator).length
    const shouldContinue = () => len() < count && hasMore && !loadControl.autoLoadPaused && !abortSignal?.aborted
    // 零进展护栏 (票 13 同族): loadMore 零消耗早退 (无新条但 hasMore 仍真) 时 while 会零间隔
    //   连发把主线程拖死 (实机: 选条件加词 → 骨架分钟级)。连续两轮零进展或超迭代上限即停,
    //   交回调用方 —— 滚动/刷新自然重试, 有货时下一轮照常继续。
    let stagnant = 0
    for (let iterations = 0; shouldContinue(); iterations++) {
      const before = len()
      await addMore(count - items.length)
      stagnant = len() === before ? stagnant + 1 : 0
      if (stagnant >= 2 || iterations >= 20) break
    }
    return items
  } finally {
    loadControl.endLoadOperation?.()
  }
}

export async function refreshForHome(fetcherOptions: FetcherOptions) {
  let items = await fetchMinCount(getColumnCount(undefined, false) * 2, fetcherOptions, 5) // 7 * 2-row
  if (fetcherOptions.tab === ETab.Watchlater) {
    items = items.slice(0, 20)
  }
  return items
}

export const getGridRefreshCount = () => getColumnCount() * 4

export async function refreshForGrid(fetcherOptions: FetcherOptions) {
  let minCount = getGridRefreshCount() // 7 * 3-row, 1 screen

  // 标签池一轮先上屏一页; 余货留在队列, 滚动继续取, 不为凑满四行再拉整轮。
  if (fetcherOptions.tab === ETab.TagRecFav || fetcherOptions.tab === ETab.TagRecCustom) {
    minCount = Math.min(minCount, fetcherOptions.service.qs.ps)
  }

  // 当结果很少的, 不用等一屏
  if (fetcherOptions.tab === ETab.DynamicFeed) {
    const _service = fetcherOptions.service as DynamicFeedRecService
    if (await _service.shouldReduceMinCount()) {
      minCount = 1
    }
  }

  return fetchMinCount(minCount, fetcherOptions, 5)
}
