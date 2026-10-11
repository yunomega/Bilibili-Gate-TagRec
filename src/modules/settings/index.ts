import { cloneDeep, isNil } from 'es-toolkit'
import { get, set } from 'es-toolkit/compat'
import { proxy, snapshot, subscribe, useSnapshot, type UseSnapshotOptions } from 'valtio'
import { baseDebug, IN_BILIBILI_HOMEPAGE } from '$common'
import { EVideoLinkOpenMode } from '$components/VideoCard/index.shared'
import { EContinuePlayDirection, EGridDisplayMode, ESidebarAlign, ETab, ETwoColumnModeAlign } from '$enums'
import { reciveGmValueUpdatesFromOtherTab } from '$modules/gm'
import { WatchlaterItemsOrder } from '$modules/rec-services/watchlater/watchlater-enum'
import { migrateTagRecDefaultQualityGate } from '$modules/tag-rec/model/defaults'
import {
  DIG_STREAM_WINDOW,
  TAG_REC_AUTO_DIG_MAX,
  TAG_REC_FALLBACK_PAGE,
  TAG_REC_PREDIG_TRIGGER_YIELD,
  TAG_REC_SEED_COUNT,
  TAG_REC_SEED_MIN_SCORE,
  TAG_REC_SEED_POOL_MAX,
} from '$modules/tag-rec/model/dig' // [tag-rec] 梯队参数出厂值同 dig.ts 常量
import {
  createTagRecBuiltinPresets,
  migrateLegacyPartitionId,
  type TagRecSettingsSection,
} from '$modules/tag-rec/model/filter-engine' // [tag-rec]
import {
  normalizePoolsEnabled,
  normalizeTagRecFilterSettings,
  normalizeTagRecPools,
  normalizeTagRecPubdate,
} from '$modules/tag-rec/model/import-export'
import { getLeafPaths, type BooleanPaths, type LeafPaths, type ListPaths } from '$utility/object-paths'
import toast from '$utility/toast'
import { saveToDraft } from './cloud-backup'
import type { Get, PartialDeep, ReadonlyDeep } from 'type-fest'

const debug = baseDebug.extend('settings')

/* #region initialSettings */
// 命名: 模块/tab + 场景 + 功能

/**
 * [tag-rec] spec §3.3 完整 schema —— filter/dims/presets 直接走工厂函数,
 * 与 model/filter-engine.ts 出厂值天然一致 (filter-scope 后字面量维护成本过高)
 */
const tagRecInitialPresets = createTagRecBuiltinPresets()
const tagRecInitialSettings: TagRecSettingsSection = {
  defaultsVersion: 2,
  k: 3, // 收藏推荐每次预取的一级组上限，可调 1~10
  seenCap: 2000, // seen-set FIFO 容量, 可调 (消费归票 08)
  showAttributionBadge: true, // 归因徽章(来源组名)默认开; 关=卡片不写组名
  customTabSeen: false, // 「标签发掘」tab 内联红点: 激活一次即置位永不再现 (tab 栏发现引导, 非面板项)
  riskLog: { enabled: true }, // [tag-rec] 风控命中观测记录器 (票 10/11): 命中才写, 常态零成本
  // 多样性护栏: 单组占比默认 60%, 单 UP 每屏最多 4 条, 两轴默认开启。
  diversityGuard: {
    group: { enabled: true, maxShare: 0.6 },
    up: { enabled: true, max: 4 },
  },
  // 梯队高级参数 (票10): 语境级共享态 => 全局块, 按治理池分档 (搜索池档 / 相关池档)
  ladder: {
    triggerYield: TAG_REC_PREDIG_TRIGGER_YIELD,
    autoDigMax: TAG_REC_AUTO_DIG_MAX,
    digStreamWindow: DIG_STREAM_WINDOW,
    seedPoolMax: TAG_REC_SEED_POOL_MAX,
    seedCount: TAG_REC_SEED_COUNT,
    seedMinScore: TAG_REC_SEED_MIN_SCORE,
    fallbackPage: TAG_REC_FALLBACK_PAGE,
  },
  filter: {
    // 首次安装选「淘沙」，生效配置与内置预设的快照各自独立。
    ...cloneDeep(tagRecInitialPresets[1]!.config),
    activePreset: tagRecInitialPresets[1]!.name,
    presets: tagRecInitialPresets,
  },
}

export const initialSettings = {
  accessKey: '',
  accessKeyExpireAt: 0,

  // 全屏模式
  // @history
  //  - 2024-03-18 bili-feed4 以前的内测首页现在是默认首页, 这里更名为全屏模式, 默认为 true
  pureRecommend: true,

  /**
   * ETab.app-recommend
   */
  appRecommend: {
    enableTabbarQuickSwitch: true,
    addOtherTabContents: false, // this flag will results MUCH more requests
    anonymousFetch: false,
  },

  /**
   * ETab.pc-recommend
   */
  pcRecommend: {
    enableTabbarQuickSwitch: true,
    anonymousFetch: false,
  },

  /**
   * 查看更多, aka ModalFeed
   */

  // ModalFeed.全屏
  modalFeedFullScreen: false,

  /**
   * Video Grid
   */
  grid: {
    // custom grid | default grid
    useCustomGrid: true,

    // mode, why repeat `grid`, for deconstruct
    gridDisplayMode: EGridDisplayMode.NormalGrid,

    // extra
    twoColumnModeAlign: ETwoColumnModeAlign.Center,

    // 手动指定
    enableForceColumn: false,
    forceColumnCount: 4,

    // 卡片最小宽度, 虽然是卡片, 但其实是网格布局
    cardMinWidth: 320,

    // row gap
    enableForceRowGap: false,
    forceRowGap: 25,
  },

  /**
   * Video Card
   */
  videoCard: {
    // action buttons
    actions: {
      openInPipWindow: false,
      showLargePreview: true,
    },

    // current largePreview: videoPreview
    videoPreview: {
      useMp4: true, // mp4 | dash (mp4: single video, dash: video only, no audio)
      useScale: false, // scale effect
      useVideoCardAsTrigger: false, // video card as trigger, v0.31.0 第一个版本就是这样的, 后改为 ActionButton
      usePreferredCdn: true,
      addTo: {
        searchPage: true,
        defaultHomepage: true,
      },
    },

    imgPreview: {
      enabled: true,

      // 自动开始预览: 按键选择
      autoPreviewWhenKeyboardSelect: false,

      // 自动开始预览: 鼠标悬浮; 不再跟随鼠标位置, 默认: 跟随鼠标
      autoPreviewWhenHover: true,

      // 多选时禁用
      disableWhenMultiSelecting: true,
    },
  },

  // 自动预览: 更新间隔
  // 跳跃式(400) 连续式(700)
  autoPreviewUpdateInterval: 700,

  // hover 延时
  useDelayForHover: false,

  // 启用侧边栏
  enableSidebar: true,
  sidebarAlign: ESidebarAlign.Right,

  /**
   * tab=dynamic-feed
   */
  dynamicFeed: {
    showLive: true, // 在动态中显示直播
    videoOnly: false, // type:all | type:video

    followGroup: {
      enabled: true, // 下拉筛选支持 - 关注分组
      forceUseMergeTimelineIds: [] as number[],
    },

    whenViewAll: {
      enableHideSomeContents: false, // 在「全部」动态中隐藏 UP 的动态 & 在「全部」动态中隐藏此分组的动态
      hideIds: [] as string[], // `up:${mid}` | `follow-group:${id}`
    },

    advancedFilter: false,
    __internal: {
      cacheAllItemsEntry: false,
      cacheAllItemsUpMids: [] as string[], // enable for these up
      externalFilterInput: false, // more convenient
    },
  },

  /**
   * tab=watchlater
   */
  watchlater: {
    // grid display
    addSeparator: true, // 添加 "近期" / "更早" 分割线
    itemsOrder: WatchlaterItemsOrder.AddTimeDesc, // 顺序
    enableTabbarQuickSwitch: true,

    // 连续播放 https://www.bilibili.com/list/watchlater?bvid=&oid=
    continuePlay: true,
    continuePlayDirection: EContinuePlayDirection.Normal,
  },

  /**
   * tab=fav
   */
  fav: {
    // useShuffle: false, // 打乱顺序
    addSeparator: true, // 收藏夹分割线
    excludedFolderIds: [] as string[], // 忽略的收藏夹
    useCustomFavPicker: {
      onPlayPage: false,
    },
  },

  /**
   * tab=popular-general
   */
  popularGeneralUseAnonymous: false, // without credentials

  /**
   * tab=popular-weekly
   */
  popularWeeklyUseShuffle: false, // shuffle

  /**
   * tab=live
   */

  /**
   * tab=space-upload
   */
  spaceUpload: {
    showVol: false,
    useSyncFilterTextFromSearchText: false,
    // 连续播放 https://www.bilibili.com/list/:mid/?sort_field=pubtime&tid=0&oid=:avid&bvid=:bvid
    continuePlay: false,
    continuePlayDirection: EContinuePlayDirection.Normal,
    // 直接查看合集
    useCollectionUrl: false,
  },

  /**
   * tab=history
   */
  history: {
    tabbarViewSmallControlSize: true,
    confirmBeforeDelete: true,
  },

  /**
   * 过滤器模块
   */
  filter: {
    enabled: true,

    // 时长
    minDuration: {
      enabled: false,
      value: 60, // 60s
    },

    // 最少播放次数
    minPlayCount: {
      enabled: false,
      value: 10000,
    },

    // 最少弹幕条数
    minDanmakuCount: {
      enabled: false,
      value: 10,
    },

    // 已关注豁免
    exemptForFollowed: {
      video: true,
      // 图文也是有 rcmd_reason = '已关注' 的
      picture: true,
    },

    // filter out goto = 'picture' | 'bangumi'
    hideGotoTypePicture: false,
    hideGotoTypeBangumi: false,

    byAuthor: {
      enabled: false,
      keywords: [] as string[],
    },
    byTitle: {
      enabled: false,
      keywords: [] as string[],
    },

    // dynamic-feed
    dfByTitle: {
      enabled: false,
      keywords: [] as string[],
    },
    dfHideOpusMids: {
      enabled: false,
      keywords: [] as string[],
    },
  },

  /**
   * 外观
   */
  style: {
    general: {
      popoverBorderColorUseColorPrimary: false,
    },

    pureRecommend: {
      // sticky tabbar
      useStickyTabbar: true,

      // expand-to-full-width & box-shadow
      stickyTabbarShadow: false,

      // bg1
      useWhiteBackground: true,

      // 隐藏顶部分区 (默认开: 推荐页顶部分区/Banner 是噪音)
      hideTopChannel: true,
    },

    videoCard: {
      // 使用卡片模式
      // inspired by https://ai.taobao.com
      useBorder: true,
      useBorderOnlyOnHover: true,
      useBoxShadow: false,
    },
  },

  /**
   * 颜色主题
   */
  theme: '',
  colorPickerThemeSelectedColor: '', // 自定义颜色

  /**
   * 功能
   */

  // 备份
  backupSettingsToArticleDraft: false,

  // 默认打开模式
  videoLinkOpenMode: EVideoLinkOpenMode.Normal,

  pipWindow: {
    defaultLocked: true, // 小窗默认锁定
    autoWebFullscreen: true, // 自动网页全屏
  },

  /**
   * 隐藏的 tab, 使用黑名单, 功能迭代之后新增的 tab, 默认开启.
   * 如果使用白名单, 新增的 tab 会被隐藏
   */
  hidingTabKeys: [ETab.KeepFollowOnly, ETab.Live, ETab.Liked] satisfies ETab[] as ETab[],
  customTabKeysOrder: [] satisfies ETab[] as ETab[],
  showBackForwardButtons: false,

  /**
   * multi-select module
   */
  multiSelect: {
    clearWhenExit: true,
    showIcon: true,
  },

  /**
   * video-play-page
   */
  videoPlayPage: {
    addQuickLinks: false,
  },

  /**
   * [tag-rec] tab=tag-rec-fav / tag-rec-custom (spec §3.3)
   */
  tagRec: tagRecInitialSettings,

  /**
   * internal
   */
  __internalEnableCopyBvidInfo: false, // ContextMenu | Button
  __internalAddTabbarCopyBvidButton: false,
  __internalHotSubUseDropdown: false,
  __internalRecTabRenderAsSegments: false,
}
/* #endregion */

export type Settings = typeof initialSettings
export const settings = proxy(cloneDeep(initialSettings))

export type LeafSettingsPath = LeafPaths<Settings>
export type BooleanSettingsPath = BooleanPaths<Settings>
export type ListSettingsPath = ListPaths<Settings>

export const allowedLeafSettingsPaths = getLeafPaths(initialSettings)
export const internalBooleanPaths = allowedLeafSettingsPaths.filter(
  (p) => p.includes('__internal') && typeof get(initialSettings, p) === 'boolean',
) as BooleanSettingsPath[]
debug('allowedLeafSettingsPaths = %O, internalBooleanPaths = %O', allowedLeafSettingsPaths, internalBooleanPaths)

export function useSettingsSnapshot(options?: UseSnapshotOptions) {
  return useSnapshot(settings, options)
}

export function getSettingsSnapshot() {
  return snapshot(settings)
}

/**
 * storage
 */
const storageKey = `settings`

/**
 * TagRec 的稀疏池槽、日期可选条件、池筛选不全是出厂叶子，归一后补接。
 * 整份存储快照还需清除被省略的可选字段；普通局部更新保留其他设置。
 */
function graftTagRecPools(source: unknown, target: object, replace = false) {
  const filter = get(source, 'tagRec.filter')
  if (!filter || typeof filter !== 'object') return
  // 旧版存储中的预设整档也要补齐新增维度，避免切换后 UI/推荐求解崩溃。
  const presets: unknown = get(source, 'tagRec.filter.presets')
  if (Array.isArray(presets)) {
    const normalized = normalizeTagRecFilterSettings({ presets })
    // 内置档是契约 (UI 拒删): 整表被导入档覆盖成空 (预设下拉只剩「自定义」) 时按出厂档补回;
    //   存量自选表不动 —— 用户自定义预设库按既有语义原样读回
    if (normalized) {
      if (!normalized.presets.length) normalized.presets.push(...createTagRecBuiltinPresets())
      set(target, 'tagRec.filter.presets', normalized.presets)
    }
  }
  const pools = normalizeTagRecPools(get(source, 'tagRec.filter.pools'))
  if (pools !== undefined) set(target, 'tagRec.filter.pools', pools)
  const rawDate: unknown = get(source, 'tagRec.filter.dims.pubdate')
  const currentDate: unknown = get(target, 'tagRec.filter.dims.pubdate')
  const pubdate = normalizeTagRecPubdate(
    !replace && rawDate && typeof rawDate === 'object'
      ? { ...(currentDate && typeof currentDate === 'object' ? currentDate : {}), ...rawDate }
      : rawDate,
  )
  if (pubdate !== undefined) set(target, 'tagRec.filter.dims.pubdate', pubdate)
  const rawEnabled = get(source, 'tagRec.filter.poolsEnabled')
  if (rawEnabled !== undefined || replace || Object.hasOwn(filter, 'poolsEnabled')) {
    set(target, 'tagRec.filter.poolsEnabled', normalizePoolsEnabled(rawEnabled))
  }
}

export async function loadSettingsFromGmStorage(): Promise<PartialDeep<Settings>> {
  const saved = await GM.getValue<Settings>(storageKey)
  if (!saved || typeof saved !== 'object') return {}
  runSettingsMigration(saved)
  const picked = pickSettings(saved, allowedLeafSettingsPaths).pickedSettings
  graftTagRecPools(saved, picked)
  return picked
}

export async function loadAndSetup() {
  const val = await loadSettingsFromGmStorage()
  updateSettings(val, { replaceTagRecFilter: true })

  // persist when config change
  subscribe(settings, () => {
    _onSettingsChange()
  })

  // replace memory-settings when other tabs change
  reciveGmValueUpdatesFromOtherTab<PartialDeep<Settings>>({
    storageKey,
    setPersist(val) {
      _persist = val
    },
    onUpdate(newValue) {
      updateSettings(newValue, { replaceTagRecFilter: true })
    },
  })
}

async function _onSettingsChange() {
  if (!_persist) return // 远端回放不复制整份设置，也不重复触发云备份。
  const snap = cloneDeep(snapshot(settings))
  await _saveToGmStorage(snap)
  await saveToDraft(snap) // http backup
}

let _persist = true
async function _saveToGmStorage(snap: ReadonlyDeep<PartialDeep<Settings>>) {
  if (!_persist) return
  await GM.setValue(storageKey, snap)
}

// #region modify settings
export function updateSettings(payload: PartialDeep<Settings>, { replaceTagRecFilter = false } = {}) {
  const { pickedPaths } = pickSettings(payload, allowedLeafSettingsPaths)
  for (const p of pickedPaths) {
    const v = get(payload, p)
    set(settings, p, v)
  }
  graftTagRecPools(payload, settings, replaceTagRecFilter)
}

export function resetSettings() {
  return updateSettings(initialSettings, { replaceTagRecFilter: true })
}
// #endregion

// #region helper

/**
 * this function mutates `val`
 */
export function runSettingsMigration(val: object | undefined) {
  if (!val) return

  // from v0.28.2, remove after several releases
  const config: Array<[configPath: LeafSettingsPath, legacyConfigPath: string]> = [
    ['dynamicFeed.showLive', 'dynamicFeedShowLive'],
    ['dynamicFeed.followGroup.enabled', 'dynamicFeedFollowGroupEnabled'],
    ['dynamicFeed.followGroup.forceUseMergeTimelineIds', 'dynamicFeedFollowGroupForceUseMergeTimelineIds'],
    ['dynamicFeed.whenViewAll.enableHideSomeContents', 'dynamicFeedWhenViewAllEnableHideSomeContents'],
    ['dynamicFeed.whenViewAll.hideIds', 'dynamicFeedWhenViewAllHideIds'],
    // ['dynamicFeed.advancedSearch', 'dynamicFeedAdvancedSearch'],

    // ['fav.useShuffle', 'favUseShuffle'],
    ['fav.addSeparator', 'favAddSeparator'],
    ['fav.excludedFolderIds', 'favExcludedFolderIds'],

    ['filter.enabled', 'filterEnabled'],
    ['filter.minPlayCount.enabled', 'filterMinPlayCountEnabled'],
    ['filter.minPlayCount.value', 'filterMinPlayCount'],
    ['filter.minDuration.enabled', 'filterMinDurationEnabled'],
    ['filter.minDuration.value', 'filterMinDuration'],
    ['filter.exemptForFollowed.video', 'exemptForFollowedVideo'],
    ['filter.exemptForFollowed.picture', 'exemptForFollowedPicture'],
    ['filter.hideGotoTypePicture', 'filterOutGotoTypePicture'],
    ['filter.hideGotoTypeBangumi', 'filterOutGotoTypeBangumi'],
    ['filter.byAuthor.enabled', 'filterByAuthorNameEnabled'],
    ['filter.byAuthor.keywords', 'filterByAuthorNameKeywords'],
    ['filter.byTitle.enabled', 'filterByTitleEnabled'],
    ['filter.byTitle.keywords', 'filterByTitleKeywords'],

    // ['style.general.videoSourceTabStandardHeight', 'styleUseStandardVideoSourceTab'],
    ['style.pureRecommend.useStickyTabbar', 'styleUseStickyTabbarInPureRecommend'],
    // ['style.pureRecommend.useCustomGrid', 'styleUseCustomGrid'],
    ['style.pureRecommend.useWhiteBackground', 'styleUseWhiteBackground'],
    ['style.pureRecommend.hideTopChannel', 'styleHideTopChannel'],
    ['style.videoCard.useBorder', 'styleUseCardBorder'],
    ['style.videoCard.useBorderOnlyOnHover', 'styleUseCardBorderOnlyOnHover'],
    ['style.videoCard.useBoxShadow', 'styleUseCardBoxShadow'],
    // 2025-04-23
    ['pipWindow.defaultLocked', 'pipWindowDefaultLocked'],

    // 2025-11-02
    ['videoCard.imgPreview.autoPreviewWhenKeyboardSelect', 'autoPreviewWhenKeyboardSelect'],
    ['videoCard.imgPreview.autoPreviewWhenHover', 'autoPreviewWhenHover'],

    // 2025-12-13
    ['grid.useCustomGrid', 'style.pureRecommend.useCustomGrid'],

    // 2025-12-23: fix typo
    ['grid.enableForceColumn', 'grid.enableForceCoumn'],

    // 2026-01-06: unify term to `filter` for client side (filter / search etc)
    ['dynamicFeed.advancedFilter', 'dynamicFeedAdvancedSearch'],
    ['dynamicFeed.advancedFilter', 'dynamicFeed.advancedSearch'],

    // 2026-05-12: watchlater deep keys
    ['watchlater.addSeparator', 'watchlaterAddSeparator'],
    ['watchlater.itemsOrder', 'watchlaterItemsOrder'],
  ]
  // 伪代码: savedConfig[newName] = savedConfig[legacyName]
  for (const [configPath, legacyConfigPath] of config) {
    const haveValue = (v: any) => !isNil(v) // 迁移设置, 只是改名, 不用考虑空数组
    if (haveValue(get(val, configPath))) {
      // already have a value
      continue
    }
    if (!haveValue(get(val, legacyConfigPath))) {
      // no legacy value
      continue
    }
    // fallback to legacy
    set(val, configPath, get(val, legacyConfigPath))
  }

  // 2026-xx: tag-rec filter-scope 迁移 (票11 清单)
  //  - diversityGuard 布尔 => 两轴对象 {group:{enabled,maxShare}, up:{enabled,max}}
  //  - dims.pubdate {withinDays,since} => {win,days,from,to} (withinDays→win:'days'+days, since→from)
  //  - dims.partition.list number[] => {name,v1,v2}[] (旧语义 tid/tidv2 双空间混放 => 双键等值保语义)
  const tagRec = get(val, 'tagRec') as Record<string, unknown> | undefined
  if (tagRec && typeof tagRec === 'object') {
    const dg = tagRec.diversityGuard
    if (typeof dg === 'boolean') {
      tagRec.diversityGuard = {
        group: { enabled: dg, maxShare: 0.6 },
        up: { enabled: true, max: 4 },
      }
    }
    const migrateDims = (dims: unknown) => {
      if (!dims || typeof dims !== 'object') return
      const d = dims as Record<string, any>
      // 旧预设是数组项, 不经过叶路径补默认; 新标签名单在本档及每个预设中补齐。
      d.tagBlock ??= { enabled: false, list: [], strict: false }
      d.tagAllow ??= { enabled: false, list: [], strict: false }
      const p = d.pubdate
      if (p && typeof p === 'object' && (p.withinDays !== undefined || p.since !== undefined)) {
        const next: Record<string, unknown> = { enabled: p.enabled === true }
        if (typeof p.withinDays === 'number' && p.withinDays > 0) {
          next.win = 'days'
          next.days = p.withinDays
        }
        if (typeof p.since === 'number' && p.since > 0) next.from = p.since
        d.pubdate = next
      }
      // 分区名单拆双池 (实修): 旧 partition{enabled,mode,list} => partitionBlock/partitionAllow;
      //   mode=allow 迁移保持 enabled (存量语义常效), 新池开关默认关防误杀
      const part = d.partition
      if (part && typeof part === 'object' && Array.isArray(part.list)) {
        // R3-05: number 迁移走共用助手 —— v2 一级分区段只发 v1 键保死值 (双键会复活成整分区过滤)
        const list = part.list.map((x: unknown) => (typeof x === 'number' ? migrateLegacyPartitionId(x) : x))
        if (part.mode === 'allow') d.partitionAllow ??= { enabled: part.enabled === true, list }
        else d.partitionBlock ??= { enabled: part.enabled === true, list }
        delete d.partition
      }
      for (const k of ['partitionBlock', 'partitionAllow']) {
        const p = d[k]
        if (p && typeof p === 'object' && Array.isArray(p.list)) {
          p.list = p.list.map((x: unknown) => (typeof x === 'number' ? migrateLegacyPartitionId(x) : x))
        }
      }
    }
    const filter = tagRec.filter as Record<string, any> | undefined
    migrateDims(filter?.dims)
    if (Array.isArray(filter?.presets)) {
      for (const p of filter.presets as Record<string, any>[]) migrateDims(p?.config?.dims)
    }
    if (Number(tagRec.defaultsVersion ?? 0) < 2) {
      const normalized = normalizeTagRecFilterSettings(filter)
      if (normalized && filter) {
        if (filter.activePreset === '淘沙' && migrateTagRecDefaultQualityGate(normalized)) {
          filter.dims.likeRate.enabled = false
        }
        for (const preset of normalized.presets) {
          if (preset.builtin && preset.name === '淘沙' && migrateTagRecDefaultQualityGate(preset.config)) {
            const old = filter.presets.find((p: { name: string }) => p.name === preset.name)
            old.config.dims.likeRate.enabled = false
          }
        }
      }
      // 选种默认门槛按字段迁移，其他已调整的预算不受影响；非默认分数保持原值。
      const ladder = tagRec.ladder as Record<string, unknown> | undefined
      if (ladder?.seedMinScore === 30) ladder.seedMinScore = 0
      tagRec.defaultsVersion = 2
    }
  }
}

/**
 * pick
 */
export function pickSettings(source: ReadonlyDeep<PartialDeep<Settings>>, paths: LeafSettingsPath[]) {
  const pickedSettings: PartialDeep<Settings> = {}
  const pickedPaths = paths.filter((p) => allowedLeafSettingsPaths.includes(p) && !isNil(get(source, p)))
  pickedPaths.forEach((p) => {
    const v = get(source, p)
    set(pickedSettings, p, v)
  })
  return { pickedPaths, pickedSettings }
}
// #endregion

// #region `inner array`

//
// Q: 为什么重新获取
// A: 在多 Tab 访问的情况下, `settings` 上的数据可能不是最新的, 不想丢失 collection 数据
//
// Q: reciveGmValueUpdatesFromOtherTab
// A: 现代脚本管理器可以订阅其他 Tab 更改, 但存在不支持的脚本管理器
//

export type SettingsInnerArrayItem<P extends ListSettingsPath> = Get<Settings, P>[number]

export function useSettingsInnerArray<P extends ListSettingsPath>(path: P) {
  const snap = useSettingsSnapshot()
  return get(snap, path) as SettingsInnerArrayItem<P>[]
}

export async function getNewestValueOfSettingsInnerArray<P extends ListSettingsPath>(path: P) {
  const newest = await loadSettingsFromGmStorage()
  return (get(newest, path) || get(getSettingsSnapshot(), path)) as SettingsInnerArrayItem<P>[]
}

export function setSettingsInnerArray<P extends ListSettingsPath>(path: P, value: SettingsInnerArrayItem<P>[]) {
  set(settings, path, value)
}

export async function updateSettingsInnerArray<P extends ListSettingsPath>(
  path: P,
  { add, remove }: { add?: SettingsInnerArrayItem<P>[]; remove?: SettingsInnerArrayItem<P>[] },
) {
  const arr = await getNewestValueOfSettingsInnerArray(path)
  const s = new Set(arr)
  for (const x of add ?? []) s.add(x)
  for (const x of remove ?? []) s.delete(x)
  setSettingsInnerArray(path, Array.from(s))
}
// #endregion

/**
 * load on init
 */
await loadAndSetup()

/**
 * access_key expire check
 */
if (
  IN_BILIBILI_HOMEPAGE &&
  settings.accessKey &&
  settings.accessKeyExpireAt &&
  Date.now() >= settings.accessKeyExpireAt
) {
  toast('access_key 已过期, 请重新获取 !!!')
}
