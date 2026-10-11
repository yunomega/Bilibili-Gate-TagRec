export enum ETab {
  AppRecommend = 'app-recommend',
  PcRecommend = 'pc-recommend',
  KeepFollowOnly = 'keep-follow-only',
  DynamicFeed = 'dynamic-feed',
  Watchlater = 'watchlater',
  Fav = 'fav',
  Hot = 'hot',
  Live = 'live',
  SpaceUpload = 'space-upload',
  Liked = 'liked', // 点赞的视频
  History = 'history', // 历史记录
  TagRecFav = 'tag-rec-fav', // [tag-rec] 收藏推荐
  TagRecCustom = 'tag-rec-custom', // [tag-rec] 指定标签
}

/** [tag-rec] tagrec 族 tab 判定 —— `?gate-tab=tag-rec-*` 深链落的是完整 app (入口激活);
 *  非 tagrec 值保持上游 onlyTab 单栏语义 (embed 式单视图) */
export function isTagRecTab(tab: string | null | undefined): boolean {
  return tab === ETab.TagRecFav || tab === ETab.TagRecCustom
}

export enum EHotSubTab {
  PopularGeneral = 'popular-general',
  PopularWeekly = 'popular-weekly',
  Rank = 'ranking',
}

export enum EApiType {
  Separator = 'separator',
  AppRecommend = 'app-recommend',
  PcRecommend = 'pc-recommend',
  DynamicFeed = 'dynamic-feed',
  Watchlater = 'watchlater',
  Fav = 'fav',
  PopularGeneral = 'popular-general',
  PopularWeekly = 'popular-weekly',
  Rank = 'ranking',
  Live = 'live',
  SpaceUpload = 'space-upload',
  Liked = 'liked',
  History = 'history',
  TagRec = 'tag-rec', // [tag-rec]
}

export enum EAppApiDevice {
  android = 'android',
  ipad = 'ipad',
}

export enum EGridDisplayMode {
  NormalGrid = 'grid', // Normal grid
  // rest are PureRecommend only!
  List = 'list', // list
  TwoColumnGrid = 'two-column-grid', // 2 column grid
  CenterEmptyGrid = 'center-empty-grid',
}

/**
 * 双列模式
 */
export enum ETwoColumnModeAlign {
  Center = 'center',
  Left = 'left',
  Right = 'right',
}

export enum ESidebarAlign {
  Left = 'left',
  Right = 'right',
}

/**
 * 0：未开播
 * 1：直播中
 * 2：轮播中
 */
export enum ELiveStatus {
  Offline = 0,
  Streaming = 1,
  Rolling = 2,
}

export enum EContinuePlayDirection {
  Normal = 'normal',
  Reverse = 'reverse',
}
