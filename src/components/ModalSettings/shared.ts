import { proxy } from 'valtio'
import { __PROD__ } from '$common'

// [tag-rec] 票 perf-08: TabPaneKey/modalSettingsStore 抽轻模块,
// banner/tabbar-fav 深链落 pane 时不再急切拉起整个 ModalSettings 图

export const enum TabPaneKey {
  // [tag-rec] export: 横幅深链用 (pane 本体归后续票)
  Basic = 'basic',
  VideoCard = 'video-card',
  Filter = 'filter',
  ThemeSelect = 'theme-select',
  VideoSourceTabConfig = 'video-source-tab-config',
  OtherPages = 'other-pages',
  Advance = 'advance',
  TagRecFavorites = 'tag-rec-favorites', // [tag-rec]
  TagRecFilter = 'tag-rec-filter', // [tag-rec]
}

const tab = __PROD__
  ? TabPaneKey.TagRecFavorites // [tag-rec] 默认落标签收藏 pane
  : // for debug, free to change this
    TabPaneKey.TagRecFavorites
export const modalSettingsStore = proxy({ tab }) // [tag-rec] export: 横幅深链用
