import { av2bv } from '@mgdn/bvid'
import dayjs from 'dayjs'
import { assert, memoize, noop, type MemoizeCache } from 'es-toolkit'
import { appWarn } from '$common'
import { defineCardBadges, type CardBadge } from '$components/VideoCard/card-badges'
import { AppRecommendApiIconType, defineStatItems, type StatItemType } from '$components/VideoCard/stat-item'
import { PcRecGoto } from '$define/pc-recommend'
import { EApiType, ELiveStatus } from '$enums'
import { AntdTooltip } from '$modules/antd/custom'
import { normalizeDynamicFeedItem } from '$modules/rec-services/dynamic-feed/api/df-normalize'
import { isFavFolderPrivate } from '$modules/rec-services/fav/fav-util'
import { IconForCollection, IconForPrivateFolder, IconForPublicFolder } from '$modules/rec-services/fav/views'
import {
  ApiDtToDeviceTypeStringMap,
  buildHistoryItemUrl,
  EHistoryBusiness,
  EHistoryDeviceType,
  EHistoryDeviceTypeConfig,
  EHistoryDeviceTypeString,
} from '$modules/rec-services/history/enums'
import { isPgcSeasonRankItem, isPgcWebRankItem } from '$modules/rec-services/hot/rank/rank-tab'
import { spaceUploadAvatarCache } from '$modules/rec-services/space-upload'
import { SpaceUploadItemHelper } from '$modules/rec-services/space-upload/api/helper'
import { buildSpaceUploadVideoCardUrl } from '$modules/rec-services/space-upload/store'
import { buildWatchlaterVideoCardUrl } from '$modules/rec-services/watchlater/helper'
import { settings } from '$modules/settings' // [tag-rec]
import { joinTagRecAttributionLabels, registerTagRecCardDataInvalidator } from '$modules/tag-rec/model/attribution' // [tag-rec] R7 卡片归因标签
import { toHttps } from '$utility/url'
import { formatDuration, formatTimestamp, getVideoInvalidReason, parseCount, parseDuration } from '$utility/video'
import { NestedTitleHelper } from './normalize-helper'
import type { ReactNode } from 'react'
import type {
  AppRecItemExtend,
  DynamicFeedItemExtend,
  HistoryItemExtend,
  LikedItemExtend,
  LiveItemExtend,
  PcRecItemExtend,
  PopularGeneralItemExtend,
  PopularWeeklyItemExtend,
  RankItemExtend,
  RecItemType,
  SpaceUploadItemExtend,
  TagRecItemExtend, // [tag-rec]
  WatchlaterItemExtend,
} from '$define'
import type { FavItemExtend } from '$modules/rec-services/fav/types'

export const DESC_SEPARATOR = '·'

// #region goto
export const KNOWN_GOTO = [
  'av',
  'bangumi',
  'live',
  // 各种形式的专栏
  'picture',
  'opus',
  'article',
] as const

export type Goto = (typeof KNOWN_GOTO)[number] | (string & {})

export function checkIsNormalVideo(goto: Goto) {
  return goto === 'av'
}
// #endregion

export interface IVideoCardData {
  // video
  avid?: string // should be a number, but use string for safety
  bvid?: string
  cid?: number
  goto: Goto
  href: string

  title: string
  titleRender?: ReactNode

  cover?: string
  pubts?: number // unix timestamp
  pubdateDisplay?: string // for display
  pubdateDisplayForTitleAttr?: string
  duration?: number
  durationDisplay?: ReactNode
  recommendReason?: string
  recommendReasonDetails?: string[]

  // 视频进度: 0-1
  watchedProgress?: number

  // stat
  statItems: StatItemType[]
  // for filter
  play?: number
  like?: number
  coin?: number
  danmaku?: number
  favorite?: number
  bangumiFollow?: number

  // author
  authorName?: string
  authorFace?: string
  authorMid?: string
  followed?: boolean // 是否「已关注」

  // general top-mark
  cardBadges?: CardBadge[]

  // [tag-rec] 归因组名 (弹层 ⛔ 负向落点解析: source.groupNames 透传, spec §4.6/票 14)
  tagRecGroupNames?: string[]
  tagRecGroupIds?: string[]
  /** R8: 简介原文 (右键「简介词」入口原料; tag/top 池条目无 desc => 缺省) */
  tagRecDesc?: string
  // [tag-rec] 分区字段 (右键「屏蔽此分区」原料, filter-scope 票03/12): v1=tid / v2=tidv2 叶 + pid_v2 一级
  tagRecTid?: number
  tagRecTidv2?: number
  tagRecTnamev2?: string
  tagRecPidV2?: number
  tagRecPidNameV2?: string

  /**
   * adpater specific
   */
  appRecommendDesc?: string
  rankingDesc?: string
  liveExtraDesc?: string
  liveAreaName?: string
  historyDeviceIcon?: ReactNode
}

export type LookintoOptions<T> = {
  [ApiType in RecItemType['api']]: (item: Extract<RecItemType, { api: ApiType }>) => T
}

export function lookinto<T>(item: RecItemType, opts: LookintoOptions<T>): T {
  // 这样写的理由：
  //  1. 类型安全在调用处保证：LookintoOptions 的定义确保调用方传入的 handlers 类型正确
  //  2. Runtime 正确性：如果 item.api = 'AppRecommend'，则 opts['AppRecommend'] 确实期望接收 AppRecItemExtend
  //  3. 编译通过：用 as any 绕过无法精确推断的限制
  // 这是一个常见的 discriminated union + 动态查找的问题，在 TypeScript 中通常需要类型断言辅助。
  const api = item.api as RecItemType['api']
  const handler = opts[api] as (item: RecItemType) => T
  return handler(item)
}

function createCacheFor__normalizeCardData() {
  const weakMap = new WeakMap<RecItemType, IVideoCardData>()
  const normalizeCardDataCache = weakMap as unknown as MemoizeCache<RecItemType, IVideoCardData>
  normalizeCardDataCache.clear ??= noop // weakmap has no clear
  normalizeCardDataCache.size = 0 // weakmap has no size
  return normalizeCardDataCache
}

export const normalizeCardData = memoize(
  (item: RecItemType) => {
    const ret = lookinto<IVideoCardData>(item, {
      [EApiType.AppRecommend]: apiAppAdapter,
      [EApiType.PcRecommend]: apiPcAdapter,
      [EApiType.DynamicFeed]: apiDynamicAdapter,
      [EApiType.Watchlater]: apiWatchlaterAdapter,
      [EApiType.Fav]: apiFavAdapter,
      [EApiType.PopularGeneral]: apiPopularGeneralAdapter,
      [EApiType.PopularWeekly]: apiPopularWeeklyAdapter,
      [EApiType.Rank]: apiRankAdapter,
      [EApiType.Live]: apiLiveAdapter,
      [EApiType.SpaceUpload]: apiSpaceUploadAdapter,
      [EApiType.Liked]: apiLikedAdapter,
      [EApiType.History]: apiHistoryAdapter,
      [EApiType.TagRec]: apiTagRecAdapter, // [tag-rec]
    })

    // handle mixed content
    if (ret.authorFace) ret.authorFace = toHttps(ret.authorFace)
    if (ret.cover) ret.cover = toHttps(ret.cover)

    // empty string -> undefined
    ret.bvid ||= undefined
    ret.avid ||= undefined

    return ret
  },
  {
    cache: createCacheFor__normalizeCardData(),
    getCacheKey: (item: RecItemType) => item,
  },
)

// 卡片数据按 item 对象记忆 (WeakMap): tag-rec 交付时重写归因字段后必须失效, 否则同一
// 对象重交付会冻结在首次计算的旧徽标 (注册到模型层, service 侧不引 UI 重依赖)。
registerTagRecCardDataInvalidator((item) => normalizeCardData.cache.delete(item))

function apiAppAdapter(item: AppRecItemExtend): IVideoCardData {
  return apiIpadAppAdapter(item)
}

function apiIpadAppAdapter(item: AppRecItemExtend): IVideoCardData {
  const parseCountByIcon = (icon: AppRecommendApiIconType) => {
    const leftGroups = [
      { icon: item.cover_left_icon_1, text: item.cover_left_text_1 },
      { icon: item.cover_left_icon_2, text: item.cover_left_text_2 },
      { icon: item.cover_left_icon_3, text: item.cover_left_text_3 },
    ].filter((x) => x.icon && x.text)
    const text = leftGroups.find((x) => x.icon === icon)?.text
    if (text) return parseCount(text)
  }

  const avid = item.param
  const bvid = item.bvid || item.videoDetail?.bvid || av2bv(Number(item.param))
  const cid = item.videoDetail?.cid || item.player_args?.cid

  const href = (() => {
    // valid uri
    if (item.uri.startsWith('http://') || item.uri.startsWith('https://')) {
      return item.uri
    }

    // more see https://github.com/magicdawn/Bilibili-Gate/issues/23#issuecomment-1533079590

    if (item.goto === 'av') {
      return `/video/${bvid}/`
    }

    if (item.goto === 'bangumi') {
      appWarn(`bangumi uri should not starts with 'bilibili://': %s`, item.uri)
      return item.uri
    }

    // goto = picture, 可能是专栏 or 动态
    // 动态的 url 是 https://t.bilibili.com, 使用 uri
    // 专栏的 url 是 bilibili://article/<id>
    if (item.goto === 'picture') {
      const id = /^bilibili:\/\/article\/(\d+)$/.exec(item.uri)?.[1]
      if (id) return `/read/cv${id}`
      return item.uri
    }

    return item.uri
  })()

  // stat
  const play = parseCountByIcon(AppRecommendApiIconType.Play)
  const like = undefined
  const coin = undefined
  const danmaku = parseCountByIcon(AppRecommendApiIconType.Danmaku)
  const favorite = undefined
  const bangumiFollow = parseCountByIcon(AppRecommendApiIconType.BangumiFollow)
  const statItems: StatItemType[] = [
    { field: 'play', value: play },
    typeof danmaku === 'number'
      ? { field: 'danmaku', value: danmaku }
      : { field: 'bangumi:follow', value: bangumiFollow },
  ]

  const desc = item.desc || ''
  const [descAuthorName = undefined, descDate = undefined] = desc.split(DESC_SEPARATOR)

  const badge = item.cover_badge || (item.goto !== 'av' ? item.cover_right_text : undefined)

  return {
    // video
    avid,
    bvid,
    cid,
    goto: item.goto,
    href,
    title: item.title,
    cover: item.cover,
    cardBadges: badge ? defineCardBadges([{ key: 'app-recommend:badge', text: badge }]) : undefined,
    pubts: item.videoDetail?.pubdate || undefined,
    pubdateDisplay: descDate,
    duration: item.videoDetail?.duration || item.player_args?.duration || undefined,
    durationDisplay: item.player_args?.duration ? formatDuration(item.player_args.duration) : undefined,
    recommendReason: item.bottom_rcmd_reason || item.top_rcmd_reason,

    // stat
    play,
    like,
    coin,
    danmaku,
    favorite,
    bangumiFollow,
    statItems,

    // author
    authorName: item.args.up_name || descAuthorName,
    authorFace: item.avatar?.cover,
    authorMid: item.args.up_id?.toString(),

    // desc
    appRecommendDesc: item.desc,
  }
}

function apiPcAdapter(item: PcRecItemExtend): IVideoCardData {
  // 2026-01-30 live 又过滤掉了:
  // 我自己不使用 pc-recommend, 使用它的人 hate live items, 这里的适配代码实际上用不上了.
  const _isVideo = item.goto === PcRecGoto.AV
  const _isLive = item.goto === PcRecGoto.Live

  return {
    // video
    avid: _isLive ? undefined : String(item.id),
    bvid: _isLive ? undefined : item.bvid,
    cid: _isLive ? undefined : item.cid,
    goto: item.goto,
    href: item.goto === 'av' ? `/video/${item.bvid}/` : item.uri,
    title: item.title,
    cover: item.pic,
    pubts: item.pubdate,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: _isLive ? item.room_info?.area.area_name : item.rcmd_reason?.content,

    // stat
    play: item.stat?.view,
    like: item.stat?.like,
    coin: undefined,
    danmaku: item.stat?.danmaku,
    favorite: undefined,
    statItems: defineStatItems(
      _isLive
        ? [{ field: 'live:viewed-by', value: item.room_info?.watched_show.num }]
        : [
            { field: 'play', value: item.stat?.view },
            { field: 'danmaku', value: item.stat?.danmaku },
          ],
    ),

    // author
    authorName: item.owner?.name,
    authorFace: item.owner?.face,
    authorMid: String(item.owner?.mid),
  }
}

function apiDynamicAdapter(item: DynamicFeedItemExtend): IVideoCardData {
  const ret = normalizeDynamicFeedItem(item)
  assert(ret, 'unexpected `normalizeDynamicFeedItem` empty result')
  return ret
}

function apiWatchlaterAdapter(item: WatchlaterItemExtend): IVideoCardData {
  const invalidReason = getVideoInvalidReason(item.state)
  const viewed = item.progress > 0
  const title = `${viewed ? '【已观看】· ' : ''}${item.title}`
  const titleRender: ReactNode = invalidReason ? (
    <AntdTooltip title={<>视频已失效, 原因: {invalidReason}</>} align={{ offset: [0, -5] }} placement='topLeft'>
      <del>
        {viewed ? '【已观看】· ' : ''}
        {item.title}`
      </del>
    </AntdTooltip>
  ) : undefined

  const href = buildWatchlaterVideoCardUrl(item.bvid, item.aid)

  return {
    // video
    avid: String(item.aid),
    bvid: item.bvid,
    cid: item.cid,
    goto: 'av',
    href,
    title,
    titleRender,
    cover: item.pic,
    pubts: item.pubdate,
    pubdateDisplayForTitleAttr: `${formatTimestamp(item.pubdate, true)} 发布, ${formatTimestamp(
      item.add_at,
      true,
    )} 添加稍后再看`,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: `${formatTimestamp(item.add_at)} · 稍后再看`,
    watchedProgress: item.progress / item.duration,

    // stat
    statItems: defineStatItems([
      { field: 'play', value: item.stat.view },
      { field: 'like', value: item.stat.like },
      // { field: 'coin', value: item.stat.coin },
      { field: 'favorite', value: item.stat.favorite },
    ]),
    play: item.stat.view,
    like: item.stat.like,
    danmaku: item.stat.danmaku,

    // author
    authorName: item.owner.name,
    authorFace: item.owner.face,
    authorMid: String(item.owner.mid),
  }
}

function apiFavAdapter(item: FavItemExtend): IVideoCardData {
  const belongsToTitle = item.from === 'fav-folder' ? item.folder.title : item.collection.title
  const Icon =
    item.from === 'fav-folder'
      ? isFavFolderPrivate(item.folder.attr)
        ? IconForPrivateFolder
        : IconForPublicFolder
      : IconForCollection
  const title = NestedTitleHelper.buildTitle(belongsToTitle, item.title)
  const titleRender = NestedTitleHelper.buildTitleReactNode(Icon, belongsToTitle, item.title)

  return {
    // video
    avid: String(item.id),
    bvid: item.bvid,
    // cid: item.
    goto: 'av',
    href: `/video/${item.bvid}/`,
    title,
    titleRender,
    cover: item.cover,
    pubts: item.pubtime,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: item.from === 'fav-folder' ? `${formatTimestamp(item.fav_time)} · 收藏` : undefined,

    // stat
    play: item.cnt_info.play,
    danmaku: item.cnt_info.danmaku,
    favorite: item.cnt_info.collect,
    statItems: defineStatItems([
      { field: 'play', value: item.cnt_info.play },
      { field: 'danmaku', value: item.cnt_info.danmaku },
      { field: 'favorite', value: item.cnt_info.collect },
    ]),

    // author
    authorName: item.upper.name,
    authorFace: item.upper.face,
    authorMid: String(item.upper.mid),
  }
}

function apiPopularGeneralAdapter(item: PopularGeneralItemExtend): IVideoCardData {
  return {
    // video
    avid: String(item.aid),
    bvid: item.bvid,
    cid: item.cid,
    goto: 'av',
    href: `/video/${item.bvid}/`,
    title: item.title,
    cover: item.pic,
    pubts: item.pubdate,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: item.rcmd_reason?.content,

    // stat
    play: item.stat.view,
    like: item.stat.like,
    coin: undefined,
    danmaku: item.stat.danmaku,
    favorite: undefined,
    statItems: defineStatItems([
      { field: 'play', value: item.stat.view },
      { field: 'like', value: item.stat.like },
      // { field: 'danmaku', value: item.stat.danmaku },
    ]),

    // author
    authorName: item.owner.name,
    authorFace: item.owner.face,
    authorMid: String(item.owner.mid),
  }
}

function apiPopularWeeklyAdapter(item: PopularWeeklyItemExtend): IVideoCardData {
  return {
    // video
    avid: String(item.aid),
    bvid: item.bvid,
    cid: item.cid,
    goto: 'av',
    href: `/video/${item.bvid}/`,
    title: item.title,
    cover: item.pic,
    pubts: item.pubdate,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: item.rcmd_reason,

    // stat
    play: item.stat.view,
    like: item.stat.like,
    danmaku: item.stat.danmaku,
    statItems: defineStatItems([
      { field: 'play', value: item.stat.view },
      { field: 'like', value: item.stat.like },
      // { field: 'danmaku', value: item.stat.danmaku },
    ]),

    // author
    authorName: item.owner.name,
    authorFace: item.owner.face,
    authorMid: String(item.owner.mid),
  }
}

function apiRankAdapter(item: RankItemExtend): IVideoCardData {
  if (isPgcWebRankItem(item) || isPgcSeasonRankItem(item)) {
    const cover = item.new_ep.cover
    const rankingDesc = item.new_ep.index_show

    return {
      // video
      avid: '',
      bvid: '',
      goto: 'bangumi',
      href: item.url,
      title: item.title,
      cover,
      pubts: undefined,
      pubdateDisplay: undefined,
      duration: 0,
      durationDisplay: '',

      // stat
      play: item.stat.view,
      like: item.stat.follow,
      danmaku: item.stat.danmaku,
      statItems: defineStatItems([
        { field: 'play', value: item.stat.view },
        { field: 'bangumi:follow', value: item.stat.follow },
        // { field: 'danmaku', value: item.stat.danmaku },
      ]),

      rankingDesc,
    }
  }

  let recommendReason: string | undefined = (item.dynamic || item.desc)?.trim()
  if (recommendReason === '-') recommendReason = undefined
  if (recommendReason && item.title.includes(recommendReason)) recommendReason = undefined

  // normal
  return {
    // video
    avid: String(item.aid),
    bvid: item.bvid,
    cid: item.cid,
    goto: 'av',
    href: `/video/${item.bvid}/`,
    title: item.title,
    cover: item.pic,
    pubts: item.pubdate,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason,

    // stat
    play: item.stat.view,
    like: item.stat.like,
    danmaku: item.stat.danmaku,
    statItems: defineStatItems([
      { field: 'play', value: item.stat.view },
      { field: 'like', value: item.stat.like },
      // { field: 'danmaku', value: item.stat.danmaku },
    ]),

    // author
    authorName: item.owner.name,
    authorFace: item.owner.face,
    authorMid: String(item.owner.mid),
  }
}

function apiLiveAdapter(item: LiveItemExtend): IVideoCardData {
  const area = `${item.area_name_v2}`
  const liveExtraDesc =
    item.live_status === ELiveStatus.Streaming
      ? '' // 「 不需要 space padding
      : `${DESC_SEPARATOR}${formatLiveTime(item.record_live_time)} 直播过`

  const coverFallback = 'https://s1.hdslb.com/bfs/static/blive/blfe-link-center/static/img/average-backimg.e65973e.png'

  function formatLiveTime(ts: number) {
    const today = dayjs().format('YYYYMMDD')
    const yesterday = dayjs().subtract(1, 'day').format('YYYYMMDD')

    const d = dayjs.unix(ts)
    if (d.format('YYYYMMDD') === today) {
      return d.format('HH:mm')
    }
    if (d.format('YYYYMMDD') === yesterday) {
      return `昨天 ${d.format('HH:mm')}`
    }
    return d.format('MM-DD HH:mm')
  }

  return {
    // video
    goto: 'live',
    href: `https://live.bilibili.com/${item.roomid}`,
    title: item.title,
    cover: item.room_cover || coverFallback,
    recommendReason: area,
    liveExtraDesc,
    // stat
    statItems: defineStatItems([{ field: 'live:viewed-by', value: item.text_small }]),
    // author
    authorName: item.uname,
    authorFace: item.face,
    authorMid: String(item.uid),
  }
}

function apiSpaceUploadAdapter(item: SpaceUploadItemExtend): IVideoCardData {
  const duration = parseDuration(item.length)
  const durationStr = formatDuration(duration) // 太蠢啦, 这个 API length 有时候会返回 '90:10', 表示 90分钟10秒, 不能直接用

  let recommendReason: string | undefined = item.description?.trim()
  if (recommendReason === '-') recommendReason = undefined
  if (recommendReason && item.title.includes(recommendReason)) recommendReason = undefined

  const authorMid = item.mid.toString()
  const avid = item.aid.toString()
  const bvid = item.bvid
  const href = buildSpaceUploadVideoCardUrl(authorMid, bvid, avid)
  const usingMeta = SpaceUploadItemHelper.getMeta(item)
  const isCollection = SpaceUploadItemHelper.checkIsCollection(item)

  const belongsToTitle = usingMeta?.title
  const title = usingMeta ? NestedTitleHelper.buildTitle(belongsToTitle || '', item.title) : item.title
  const titleRender = usingMeta
    ? NestedTitleHelper.buildTitleReactNode(IconForCollection, belongsToTitle || '', item.title)
    : undefined

  const watchedProgress = duration && item.playback_position ? item.playback_position / duration : undefined

  return {
    // video
    avid,
    bvid,
    cid: undefined,
    goto: 'av',
    href,
    title,
    titleRender,
    cover: item.pic, // use item cover even for collection, collection cover `usingMeta.cover`
    pubts: usingMeta ? usingMeta.ptime : item.created,
    duration,
    // 不管 lesson
    durationDisplay: usingMeta ? (
      <span className='inline-flex-center gap-x-2px'>
        {isCollection && <IconForCollection className='size-14px' />}
        {usingMeta.ep_count}
      </span>
    ) : (
      durationStr
    ),
    recommendReason,

    // stat
    play: item.play,
    like: undefined,
    coin: undefined,
    danmaku: item.video_review,
    favorite: undefined,
    statItems: defineStatItems(
      usingMeta
        ? [
            { field: 'play', value: usingMeta.stat.view },
            { field: 'danmaku', value: usingMeta.stat.danmaku },
          ]
        : [
            { field: 'play', value: item.play },
            { field: 'danmaku', value: item.video_review },
          ],
    ),
    watchedProgress,

    // author
    authorName: item.author,
    authorFace: spaceUploadAvatarCache.get(item.mid),
    authorMid,
    cardBadges: defineCardBadges(
      isCollection && {
        key: `${item.api}:collection`,
        icon: <IconForCollection className='size-14px' />,
        text: '合集',
      },
      SpaceUploadItemHelper.checkIsChargeOnly(item) && {
        key: `${item.api}:charge-only`,
        icon: <IconMingcuteLightningFill className='size-14px' />,
        text: item.elec_arc_badge,
      },
      SpaceUploadItemHelper.checkIsUnionVideo(item) && {
        key: `${item.api}:union-video`,
        text: '合作',
      },
    ),
  }
}

function apiLikedAdapter(item: LikedItemExtend): IVideoCardData {
  const { videoDetail } = item
  const avid = item.param
  const bvid = av2bv(Number(avid))

  return {
    // video
    avid,
    bvid,
    cid: undefined,
    goto: 'av',
    href: `/video/${bvid}/`,
    title: item.title,
    cover: item.cover,
    pubts: videoDetail?.pubdate ?? item.ctime,
    duration: item.duration,
    durationDisplay: formatDuration(item.duration),
    recommendReason: undefined,

    // stat
    play: item.play,
    danmaku: item.danmaku,
    like: undefined,
    coin: undefined,
    favorite: undefined,
    statItems: defineStatItems([
      { field: 'play', value: item.play },
      { field: 'danmaku', value: item.danmaku },
    ]),

    // author
    authorName: item.author,
    authorFace: videoDetail?.owner.face,
    authorMid: videoDetail?.owner.mid?.toString(),
  }
}

function apiHistoryAdapter(item: HistoryItemExtend): IVideoCardData {
  const isVideo = item.history.business === EHistoryBusiness.ARCHIVE
  const isLive = item.history.business === EHistoryBusiness.LIVE
  const isArticle = item.history.business === EHistoryBusiness.ARTICLE
  const isBangumi = item.history.business === EHistoryBusiness.PGC

  // item.progress = -1, 已看完
  // 官方页面中使用 item.progress < 0 判断
  const isVideoFinished = isVideo && item.progress < 0
  const watchedProgress: number | undefined =
    isVideo && item.progress && item.duration ? (isVideoFinished ? 1 : item.progress / item.duration) : undefined

  const goto: Goto = (() => {
    if (isVideo) return 'av'
    if (isLive) return 'live'
    if (isArticle) return 'article'
    if (isBangumi) return 'bangumi'
    return item.history.business
  })()

  let bottomRightInfo: ReactNode
  if (isVideo) {
    bottomRightInfo = isVideoFinished ? '已看完' : `${formatDuration(item.progress)} / ${formatDuration(item.duration)}`
  } else if (isLive) {
    bottomRightInfo = item.tag_name
  } else if (isArticle) {
    //
  }

  const cardBadges = (() => {
    if (!item.badge) return
    if (isVideo) return
    if (isLive && item.live_status === ELiveStatus.Streaming) return // "直播中" 会单独处理

    let className: string | undefined
    if (isLive && item.live_status === ELiveStatus.Offline) {
      className = 'bg-black/50' // 未开播, 灰色 tag
    }

    return defineCardBadges([{ key: 'history:badge', text: item.badge, className }])
  })()

  const { DeviceIcon, deviceName } =
    (() => {
      const deviceType =
        ApiDtToDeviceTypeStringMap[item.history.dt as keyof typeof ApiDtToDeviceTypeStringMap] ||
        EHistoryDeviceTypeString.UNKNOWN // UPPER_CASE_STRING
      const deviceConfig = EHistoryDeviceTypeConfig[EHistoryDeviceType[deviceType as keyof typeof EHistoryDeviceType]]
      const DeviceIcon = deviceConfig?.Icon
      const deviceName = deviceConfig?.label
      return { DeviceIcon, deviceName }
    })() || {}

  return {
    cover: item.cover || item.covers?.[0] || '',
    bvid: item.history.bvid || undefined,
    avid: item.history.oid?.toString() || undefined,
    goto,
    href: buildHistoryItemUrl(item),
    title: isBangumi ? item.show_title || item.title : item.title,

    watchedProgress,
    duration: item.duration,
    durationDisplay: bottomRightInfo,

    // stat & tags
    statItems: [], // no stat data available
    cardBadges,

    // author
    authorFace: item.author_face || undefined,
    authorMid: (item.author_mid || undefined)?.toString(), // 可能为无意义的 0
    authorName: item.author_name || undefined,

    // bottom
    historyDeviceIcon: DeviceIcon && (
      <span title={deviceName} className='size-16px'>
        <DeviceIcon className='size-full' />
      </span>
    ),
  }
}

// [tag-rec] TagRecItemExtend -> IVideoCardData (spec §3.7)
function apiTagRecAdapter(item: TagRecItemExtend): IVideoCardData {
  const { stat, owner, source } = item
  // 只折叠展示单条视频实际认领的来源，不使用当前范围或本轮抽取数量。
  const attributionText = joinTagRecAttributionLabels(
    source.attributionLabels ?? source.groupNames,
    source.groupIds?.length ? new Set(source.groupIds).size : undefined,
  )
  // Tag-centric: 归因徽章自动下钻到标签那一级 —— 召回关键词就是「这条为什么出现」；
  // 没有关键词时才回落来源归因文本。富化器已按当前配方重算展示词时以它为准 (组合组
  // 编辑后旧召回词不再解释当前信息流)；未重算 (非组合来源/未交付) 才回落原始召回词。
  const matchedTagNames = [
    ...new Set(
      source.attributionKeywords ??
        [
          ...(source.claims ?? []).flatMap((claim) => (claim.queryKeyword ? [claim.queryKeyword.trim()] : [])),
          ...(source.queryKeyword ? [source.queryKeyword.trim()] : []),
        ].filter(Boolean),
    ),
  ]
  const recommendReason = settings.tagRec.showAttributionBadge
    ? matchedTagNames.length
      ? matchedTagNames.join(' · ')
      : attributionText
    : undefined
  // 详情只用真实来源路径：groupNames 可能是工作副本占位名（「新试验」），不能当来源路径展示
  const detailPaths = source.attributionPaths?.length
    ? source.attributionPaths
    : source.attributionLabels?.length
      ? source.attributionLabels
      : matchedTagNames
  // 票 13 D9 来源徽标 (与归因徽标分维度): 搜索=all/v2 精确召回; 相关=all/v2 其余命中(橙); 相似=archive/related(橙)
  const viaBadge =
    source.via === 'up-search'
      ? { key: 'tag-rec:via', text: 'UP搜索' }
      : source.via === 'all-v2-exact'
        ? { key: 'tag-rec:via', text: '搜索' }
        : source.via === 'all-v2-related'
          ? { key: 'tag-rec:via', text: '相关', className: 'bg-[#fa8c16]' }
          : source.via === 'archive-related'
            ? { key: 'tag-rec:via', text: '相似', className: 'bg-[#fa8c16]' }
            : undefined
  return {
    // video
    avid: item.aid?.toString(),
    bvid: item.bvid,
    cid: item.cid,
    goto: 'av',
    href: `/video/${item.bvid}/`,
    title: item.title,
    cover: item.pic,
    pubts: item.pubdate,
    duration: item.duration,
    durationDisplay: item.duration === undefined ? undefined : formatDuration(item.duration),
    recommendReason,
    recommendReasonDetails: recommendReason && detailPaths.length ? [...new Set(detailPaths)] : undefined,
    cardBadges: viaBadge ? defineCardBadges([viaBadge]) : undefined,

    // stat
    play: stat.view,
    like: stat.like,
    coin: stat.coin,
    danmaku: stat.danmaku,
    favorite: stat.favorite,
    statItems: defineStatItems([
      { field: 'play', value: stat.view },
      { field: 'danmaku', value: stat.danmaku },
      { field: 'like', value: stat.like },
    ]),

    // author
    authorName: owner?.name,
    authorFace: owner?.face,
    authorMid: owner?.mid?.toString(),

    // [tag-rec]
    tagRecGroupNames: source.groupNames,
    tagRecGroupIds: source.groupIds,
    tagRecDesc: item.desc,
    tagRecTid: item.tid,
    tagRecTidv2: item.tidv2,
    tagRecTnamev2: item.tnamev2,
    tagRecPidV2: item.pid_v2,
    tagRecPidNameV2: item.pid_name_v2,
  }
}
