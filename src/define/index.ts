import { EApiType } from '$enums'
import type { ReactNode } from 'react'
import type { VideoDetailData } from '$modules/bilibili/video/types/video-detail'
import type { HistoryItem } from '$modules/rec-services/history/api/shared.api'
import type { ERankApiType, IRankTab } from '$modules/rec-services/hot/rank/rank-tab'
import type { RankItem } from '$modules/rec-services/hot/rank/types'
import type { LikedItem } from '$modules/rec-services/liked/api/liked.api'
import type { LiveItem } from '$modules/rec-services/live/types/list-live'
import type { SpaceUploadItem } from '$modules/rec-services/space-upload/api/space-upload.api'
import type { DynamicFeedItem } from '../modules/rec-services/dynamic-feed/api/types'
import type { FavItemExtend } from '../modules/rec-services/fav/types'
import type { WatchlaterItem } from '../modules/rec-services/watchlater/types'
import type { ipad } from './app-recommend.ipad'
import type { DmJson } from './dm'
import type { PcRecItem } from './pc-recommend'
import type { PopularGeneralItem } from './popular-general'
import type { PopularWeeklyItem } from './popular-weekly'
import type { PvideoJson } from './pvideo'

export type { FavItem, FavItemExtend } from '$modules/rec-services/fav/types'
export type { SpaceUploadItem, SpaceUploadJson } from '$modules/rec-services/space-upload/api/space-upload.api'
export type { DynamicFeedItem, DynamicFeedJson } from '../modules/rec-services/dynamic-feed/api/types'
export type { WatchlaterItem, WatchlaterJson } from '../modules/rec-services/watchlater/types'
export type { DmJson, PvideoJson }
export type PvideoData = PvideoJson['data']
export type DmData = DmJson['data']
export type { PcRecItem, PcRecommendJson } from './pc-recommend'

/**
 * app
 */
export type AppRecommendJson = ipad.AppRecommendJson
export type AppRecItem = ipad.AppRecItem
export interface AppRecItemExtend extends AppRecItem {
  uniqId: string
  api: EApiType.AppRecommend
  videoDetail?: VideoDetailData // previously fetched
}

export type RecItemTypeOrSeparator = RecItemType | ItemsSeparator

export type ItemsSeparator = {
  uniqId: string
  api: EApiType.Separator
  content: ReactNode
  wrapWithDivider?: boolean // 使用 Divider 包裹
}

/**
 * ItemExtend
 */
export type RecItemType =
  | AppRecItemExtend
  | PcRecItemExtend
  | DynamicFeedItemExtend
  | WatchlaterItemExtend
  | FavItemExtend
  | PopularGeneralItemExtend
  | PopularWeeklyItemExtend
  | RankItemExtend
  | LiveItemExtend
  | SpaceUploadItemExtend
  | LikedItemExtend
  | HistoryItemExtend
  | TagRecItemExtend // [tag-rec]

// #region define ItemExtend
export type PcRecItemExtend = PcRecItem & {
  uniqId: string
  api: EApiType.PcRecommend
}

export type DynamicFeedItemExtend = DynamicFeedItem & {
  uniqId: string
  api: EApiType.DynamicFeed
  groupId?: number // from some follow-group
}

export type WatchlaterItemExtend = WatchlaterItem & {
  uniqId: string
  api: EApiType.Watchlater
}

export type PopularGeneralItemExtend = PopularGeneralItem & {
  uniqId: string
  api: EApiType.PopularGeneral
}

export type PopularWeeklyItemExtend = PopularWeeklyItem & {
  uniqId: string
  api: EApiType.PopularWeekly
}

export type RankItemExtendProps = {
  uniqId: string
  api: EApiType.Rank
  // rank specific
  rankingNo: number
  from: ERankApiType
  slug: string
  rankTab: IRankTab
}
export type RankItemExtend = RankItem & RankItemExtendProps

export type LiveItemExtend = LiveItem & {
  uniqId: string
  api: EApiType.Live
}

export type SpaceUploadItemExtend = SpaceUploadItem & {
  uniqId: string
  api: EApiType.SpaceUpload
  groupId?: number // from some follow-group ?
  vol: number
  page?: number
}

export type LikedItemExtend = LikedItem & {
  uniqId: string
  api: EApiType.Liked
  videoDetail?: VideoDetailData
}

export type HistoryItemExtend = HistoryItem & {
  uniqId: string
  api: EApiType.History
}

// [tag-rec] 统一字段视图 = item 层 (spec §3.7)
export type TagRecItemExtend = {
  api: EApiType.TagRec
  uniqId: string // `tag-rec:${bvid}`
  // 归一后的统一字段视图(过滤/算分只认这套键)
  bvid: string
  aid?: number
  cid?: number
  title: string
  desc?: string
  fieldEvidence?: { title?: 'complete' | 'partial' | 'missing'; desc?: 'complete' | 'partial' | 'missing' }
  pic: string
  duration?: number
  pubdate?: number
  owner?: { mid?: number; name?: string; face?: string }
  tid?: number
  tidv2?: number // v2 子分区 id (tag/top/archive 原生带; all/v2 无此字段)
  tnamev2?: string
  pid_v2?: number // v2 一级分区 id (tag/top/archive 原生带; 分区名单一级直判原料)
  pid_name_v2?: string
  stat: {
    view?: number
    like?: number
    favorite?: number
    coin?: number
    danmaku?: number
    reply?: number
    share?: number
  }
  partial?: boolean // stat 缺到只剩 view
  // 归因与溯源
  // AUDIT-A1-3: groupIds 与 groupNames 平行 (同序同义, id=稳定键); 组源条目两者并填,
  //   组簇深挖也携带稳定 id；独立输入词无组实体时仅 names，旧条目才按名兜底
  source: {
    via: 'tag-top' | 'all-v2-exact' | 'all-v2-related' | 'archive-related' | 'up-search'
    /** 召回关键词，不代表视频真实标签。 */
    queryKeyword?: string
    groupNames: string[]
    groupIds?: string[]
    /** 实际召回本视频的 tag/top 标签编号；同轮多源命中取并集，不代表视频的完整标签名单。 */
    tagIds?: number[]
    /** 已格式化的来源组与实际命中子标签；缺省回落 groupNames。 */
    attributionLabels?: string[]
    /** 单条视频真实来源组的完整路径及命中子标签，用于归因勋章详情。 */
    attributionPaths?: string[]
    /** 展示用召回词 (富化器交付时按当前配方重算): 组合组的旧召回词在配方编辑后不再解释当前信息流,
     *  收敛到仍属配方的条件值; 只影响徽标文案, 原始 claims/证据不动。 */
    attributionKeywords?: string[]
    /** 同一视频的实际召回记录；重复命中补充证据，保留各组对应的来源。 */
    claims?: TagRecSourceClaim[]
    input?: boolean // 独立输入使用草稿/全局链，不按显示名借收藏组
  }
  score?: number // 管线内算分结果(排序用;卡片不展示分数)
  srcRank?: number // 源池内推荐序(同分破序第二键)
  ownTagNames?: string[] // all/v2 自报的 tag 名名单 (负向名匹配原料; tag/top 源无此字段)
  ownTagIds?: number[] // 严格标签校验补查的完整 id 名单 (空数组 = 已确认无标签)
  combinationUnverified?: true // 用户主动临时查看的未知条件，必须在卡片上标明
  tagRecReplayed?: true // 票 006: 来自本地回放池的零请求复用内容，卡片标「回放」不冒充新推荐
  filterPoolSize?: number // 普通判定的真实池深；补查标签时复核同一条完整生效链
  filterPoolSizes?: Record<string, number> // 各认领组×来源的池深，补查时沿用
  eligibleGroupKeys?: string[] // 本次普通筛选实际放行的组，用于展示份额
  activeSourceClaims?: TagRecSourceClaim[] // 当前允许归属；原始 source.claims 留作有界恢复
  eligiblePoolScopes?: string[] // 实际放行的组×来源
  relevance?: TagRecRelevance
  relevanceByGroup?: Record<string, TagRecRelevance>
  qualitySortScore?: number // 缺统计时使用同批可评候选的中位质量，不伪造公开分数
  qualityByGroup?: Record<string, number> // 各组自己的质量参数与中性排序值
}

export type TagRecSourceClaim = {
  via: TagRecItemExtend['source']['via']
  groupNames: string[]
  groupIds?: string[]
  tagIds?: number[]
  queryKeyword?: string
  srcRank?: number
  input?: boolean
}

export type TagRecRelevance = { tier: number; hits: number }
// #endregion

// #region predicates
export function checkIsAppRecommend(item: RecItemType): item is AppRecItemExtend {
  return item.api === EApiType.AppRecommend
}
export function checkIsPcRecommend(item: RecItemType): item is PcRecItemExtend {
  return item.api === EApiType.PcRecommend
}
export function checkIsDynamicFeed(item: RecItemType): item is DynamicFeedItemExtend {
  return item.api === EApiType.DynamicFeed
}
export function checkIsWatchlater(item: RecItemType): item is WatchlaterItemExtend {
  return item.api === EApiType.Watchlater
}
export function checkIsFav(item: RecItemType): item is FavItemExtend {
  return item.api === EApiType.Fav
}
export function checkIsPopularGeneral(item: RecItemType): item is PopularGeneralItemExtend {
  return item.api === EApiType.PopularGeneral
}
export function checkIsPopularWeekly(item: RecItemType): item is PopularWeeklyItemExtend {
  return item.api === EApiType.PopularWeekly
}
export function checkIsRank(item: RecItemType): item is RankItemExtend {
  return item.api === EApiType.Rank
}
export function checkIsLive(item: RecItemType): item is LiveItemExtend {
  return item.api === EApiType.Live
}
export function checkIsSpaceUpload(item: RecItemType): item is SpaceUploadItemExtend {
  return item.api === EApiType.SpaceUpload
}
export function checkIsLiked(item: RecItemType): item is LikedItemExtend {
  return item.api === EApiType.Liked
}
export function checkIsHistory(item: RecItemType): item is HistoryItemExtend {
  return item.api === EApiType.History
}
export function checkIsTagRec(item: RecItemType): item is TagRecItemExtend {
  return item.api === EApiType.TagRec
} // [tag-rec]
// #endregion
