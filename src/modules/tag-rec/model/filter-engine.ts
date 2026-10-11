import { cloneDeep, isEqual } from 'es-toolkit'
import { getVersion, snapshot } from 'valtio/vanilla'
import { compareTagRecItems } from '../service/_pipeline'
import {
  evalTagRecCombination,
  isTagRecCombinationExcluded,
  isTagRecCombinationIntersection,
  mergeTagRecCombinationFilters,
  newTagRecCombination,
  validateTagRecCombination,
  type TagRecCombination,
  type TagRecConditionAtom,
} from './combination'
import { stripRelatedSuffix } from './dig'
import { dedupeTagIdEntries } from './favorites'
import { isPartialStat } from './normalize-item'
import { evalTagRecPartitionEntry, evalTagRecPartitionList } from './partition'
import { PARTITION_EXPAND_V2, PARTITION_NAME_TO_PARENT } from './partition-table'
import {
  compareTagRecRelevance,
  tagRecClaimsForGroup,
  tagRecGroupKey,
  tagRecRelevanceOf,
  tagRecSourceClaims,
} from './relevance'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type {
  TagGroup,
  TagIdEntry,
  TagL1Group,
  TagRecNegativeRules,
  TagRecPartitionEntry,
  TagRecPoolKey,
  TagRecTagListRule,
} from './types'

/**
 * [tag-rec] 过滤引擎 + 综合分 (spec §3.3 / §4.3) —— 纯函数主战场
 *
 * 维度三族:
 *   比率族  likeRate / favRate / coinRate / interactRate((danmaku+reply)/view) / shareRate —— 每 view
 *   绝对值族 viewMin / viewMax
 *   元信息族 duration(min/max 秒) / pubdate(withinDays 最近N天 / since 不早于, unix 秒)
 *           upBlacklist(owner mid/name) / partition(tid block|allow) / titleKeywords(子串)
 *   其它    minScore(综合分门槛) + 黑名单维(见下裁量注)
 *
 * 缺字段豁免 (默认): 源不带的字段对应维度不评估放行; strictMode 反转为「缺=不过」。
 *   参数未设 (value<=0 / min&max 均 0 / 空列表) = 该维无约束 => 恒 pass, 不吃严格模式。
 *   标签名单的缺字段始终豁免, 由各自严格开关在上屏切片补查后判断, 不受 strictMode 反转。
 * 小池降级: 池有效条数 < smallPoolThreshold => 比率族+minScore 失效, 硬条件仍生效。
 *
 * 黑名单维 = 组内负向过滤 (票 14 决议, spec §3.2/§4.5): 负向成员绑定标签组,
 *   按条目来源组(service 注入 entriesOf 解析 source.groupNames => 负向条目)分流:
 *   - all/v2 条目自带 tag 名名单 (item.ownTagNames) => 按名归一化匹配负向成员 (零请求)
 *   - tag/top 条目 => bvid ∩ 负向池快照 (ctx.negative.pools, service 轮前预热,
 *     每负向 tid 至多 1 请求/会话) —— 近似语义: 「进了拉黑池」当拉黑处理
 *   源组无负向 / entriesOf 空 => 该维不适用放行 (非缺字段语义, 不吃 strictMode)。
 *   残余洞 (负向池外的带拉黑 tag 视频) 由组开关 negative_strict 在 service/negative-slice.ts
 *   上屏切片级逐条 view/detail/tag 补齐 (默认关)。
 *
 * 滤除计数归因: 按「首个命中维度」归因 (评估序 = 下列数组序), Σ byDim === dropped,
 *   横幅「黑名单 x · 阈值 y」分解与合计恒对账。
 */

// #region 类型 (spec §3.3; settings/index.ts tagRec 段以此为注解)
export type TagRecScoreWeights = {
  view: number
  likeRate: number
  favRate: number
  coinRate: number
  interactRate: number
}

export type TagRecScoreAnchors = {
  viewLog10: number // log10(view+1) 的锚 (=7)
  likeRate: number
  favRate: number
  coinRate: number
  interactRate: number
}

export type TagRecScoreParams = {
  weights: TagRecScoreWeights
  anchors: TagRecScoreAnchors
}

export type TagRecFilterDims = {
  viewMin: { enabled: boolean; value: number }
  viewMax: { enabled: boolean; value: number }
  // stat 绝对值族 (+12, 票04): {enabled,value} 同款; min 杀与 max 杀分键归因
  likeMin: { enabled: boolean; value: number }
  likeMax: { enabled: boolean; value: number }
  favMin: { enabled: boolean; value: number }
  favMax: { enabled: boolean; value: number }
  coinMin: { enabled: boolean; value: number }
  coinMax: { enabled: boolean; value: number }
  danmakuMin: { enabled: boolean; value: number }
  danmakuMax: { enabled: boolean; value: number }
  replyMin: { enabled: boolean; value: number }
  replyMax: { enabled: boolean; value: number }
  shareMin: { enabled: boolean; value: number }
  shareMax: { enabled: boolean; value: number }
  likeRate: { enabled: boolean; value: number }
  favRate: { enabled: boolean; value: number }
  coinRate: { enabled: boolean; value: number }
  interactRate: { enabled: boolean; value: number }
  shareRate: { enabled: boolean; value: number }
  duration: { enabled: boolean; min: number; max: number } // 秒, 0=未设
  /** pubdate = token 一等公民 (票04): win 快捷窗 + from/to 独立绝对夹(AND) + tod 一天内时段(分钟-of-day) */
  pubdate: {
    enabled: boolean
    win?: 'today' | 'd7' | 'd30' | 'd180' | 'days' | 'range' // 空=未设快捷窗
    days?: number // win='days' 的滚动天数
    from?: number // 绝对下界 unix 秒 (与 win 窗 AND)
    to?: number // 绝对上界 unix 秒
    tod?: { from?: number; to?: number } // 一天内时段 0~1440 分钟, from>to=跨零点
  }
  upBlacklist: { enabled: boolean; list: { name: string; mid?: number }[] }
  descKeywords: { enabled: boolean; list: string[] } // 简介屏蔽词 —— 仅 all-v2-exact/all-v2-related/archive-related 池判定 (票02)
  partitionBlock: { enabled: boolean; list: TagRecPartitionEntry[] } // 分区屏蔽池: 命中即滤 (票03 双体系条目; 拆池实修)
  partitionAllow: { enabled: boolean; list: TagRecPartitionEntry[] } // 分区仅看池: 独立开关默认关 (防误杀), 开=只剩命中分区
  titleKeywords: { enabled: boolean; list: string[] }
  // R8 仅看池家族 (域收窄): 开且非空 = 流量只剩命中项; 与同实体屏蔽池同存时屏蔽先判赢; 缺字段 miss (非严格豁免)
  upAllow: { enabled: boolean; list: { name: string; mid?: number }[] } // 仅看 UP 主
  titleAllow: { enabled: boolean; list: string[] } // 仅看标题词
  descAllow: { enabled: boolean; list: string[] } // 仅看简介词
  tagBlock: TagRecTagListRule
  tagAllow: TagRecTagListRule
  minScore: { enabled: boolean; value: number }
}

// #region 分层覆盖类型 (filter-scope 票01/11): 生效链 会话>格(组×池)>组(L2)>L1>池>全局
/** dims patch: 名单维结构性除外 (名单走 negative 容器, 类型层封死错层; R8 +仅看家族) */
export type TagRecDimsPatch = Partial<
  Omit<
    TagRecFilterDims,
    | 'upBlacklist'
    | 'descKeywords'
    | 'partitionBlock'
    | 'partitionAllow'
    | 'titleKeywords'
    | 'upAllow'
    | 'titleAllow'
    | 'descAllow'
    | 'tagBlock'
    | 'tagAllow'
  >
>
export type TagRecScorePatch = {
  weights?: Partial<TagRecScoreWeights>
  anchors?: Partial<TagRecScoreAnchors>
}
/** 稀疏 override: 键存在=override, 删键=回继承; dims 覆盖粒度=整 dim 对象, score=逐字段 */
export type TagRecScopeOverride = {
  dims?: TagRecDimsPatch
  score?: TagRecScorePatch
  smallPoolThreshold?: number // 标量就近覆盖; ≤0=永不降级逃生口
}
/** L2 组 overrides: +负向名单容器 +格池槽 +池筛选 */
export type TagRecGroupOverrides = TagRecScopeOverride & {
  negative?: TagRecNegativeRules
  pools?: Partial<Record<TagRecPoolKey, TagRecScopeOverride>> // 格槽 = 组×池
  poolsEnabled?: Partial<Record<TagRecPoolKey, boolean>> // R8 池筛选 (组层; 逐池就近)
}
/** L1 组 overrides: 无 pools (格=L2×池), 麾下组链上继承 */
export type TagRecL1Overrides = TagRecScopeOverride & {
  negative?: TagRecNegativeRules
  poolsEnabled?: Partial<Record<TagRecPoolKey, boolean>> // R8 池筛选 (L1 层)
}
// #endregion

/** 整套可快照部分: 全局配置、预设和编辑器视图。 */
export type TagRecFilterCore = {
  enabled: boolean // 内容过滤开关；来源闸独立生效。
  strictMode: boolean // 严格模式: 缺字段=不过 (默认关=缺字段不评估放行)
  smallPoolThreshold: number // 小池降级阈值 (链底默认; 组/池/格可覆盖)
  dims: TagRecFilterDims
  score: TagRecScoreParams
  /** 池层 (全局按池): tagTop/allV2/archiveRelated 三槽, TagRecScopeOverride 同型;
   *  名单永不进池层 (类型上无 negative 键); 出厂仅 allV2 槽物化显式参数 (票05) */
  pools?: Partial<Record<TagRecPoolKey, TagRecScopeOverride>>
  /** 池筛选：false 不为本链拉取或领取该来源，true 显式开启，缺键继承。 */
  poolsEnabled?: Partial<Record<TagRecPoolKey, boolean>>
}

export type TagRecFilterPreset = {
  name: string
  builtin?: boolean // 内置档标记: 可改可恢复出厂; 自定义增删改名只对非内置放开
  config: TagRecFilterCore
}

/** 本次过滤只保存改动字段；未声明的字段继续沿全局→池→L1→组→格继承。 */
export type TagRecSessionFilterPatch = {
  enabled?: boolean
  strictMode?: boolean
  smallPoolThreshold?: number
  dims: Partial<TagRecFilterDims>
  score?: TagRecScorePatch
  pools?: Partial<Record<TagRecPoolKey, TagRecScopeOverride>>
  poolsEnabled?: Partial<Record<TagRecPoolKey, boolean>>
}

export type TagRecFilterSettings = TagRecFilterCore & {
  activePreset: string
  presets: TagRecFilterPreset[]
}

/** 多样性护栏 (票09): 两轴各带开关; 参数永远全局, 不进生效链 (流级整形非逐条判定) */
export type TagRecDiversityGuardSettings = {
  group: { enabled: boolean; maxShare: number } // 单组占比上限 (默认 0.6, 顺延不丢弃)
  up: { enabled: boolean; max: number } // 单 UP 每切片上限 (默认 4, 1~10; owner.mid 计数, 缺即豁免)
}

/** 梯队高级参数 (票10): 语境级共享态无组级载体 => 全局块, 按治理池分档 */
export type TagRecLadderSettings = {
  mode?: 'fixed' | 'adaptive' // 缺省保留自适应策略
  lowYield?: number // 自适应低产线，条/自动轮
  lowYieldStreakLimit?: number // 连续低产停止轮数
  emptyTtlMinutes?: number // 成功空响应/旧终态的复探冷却
  triggerYield: number // 干轮触发线 (本轮产出 < 此值走梯队)
  autoDigMax: number // fixed 模式累计已付自动轮次上限
  digStreamWindow: number // 深挖流并发窗
  seedPoolMax: number // 每轮选种扫描窗口；未取得标签的候选轮转扫描
  seedCount: number // 每干轮选种数
  seedMinScore: number // 选种分数门槛 (单一全局标量)
  fallbackPage: number // 兜底堆放行页长
}

export type TagRecSettingsSection = {
  defaultsVersion?: number
  k: number
  seenCap: number
  showAttributionBadge: boolean
  /** 「指定标签」tab 发现引导: 点进过一次即置位 (tab 内联红点一次性熄灭; 非用户设置项) */
  customTabSeen: boolean
  /** [tag-rec] 风控命中观测记录器 (票 10/11): 命中才写, 常态零成本; 默认开 */
  riskLog: { enabled: boolean }
  diversityGuard: TagRecDiversityGuardSettings
  ladder: TagRecLadderSettings
  filter: TagRecFilterSettings
}

/** 滤除计数维度键: 配置维 + 'blacklist' (名单维无配置开关) + 'poolFilter' (R8 池筛选) */
export type TagRecDropDimKey = keyof TagRecFilterDims | 'blacklist' | 'poolFilter' | 'combination'
/** 名单开关已在生效链合并；评估不再检查同名 dim 开关，仍受过滤总开关控制。 */
const LIST_DIM_KEYS: ReadonlySet<TagRecDropDimKey> = new Set<TagRecDropDimKey>([
  'blacklist',
  'upBlacklist',
  'descKeywords',
  'partitionBlock',
  'partitionAllow',
  'titleKeywords',
  'upAllow',
  'titleAllow',
  'descAllow',
  'tagBlock',
  'tagAllow',
])
// #endregion

// #region 出厂快照 (spec §3.3; settings/index.ts presets 字面量须与此保持一致)
export function createTagRecFactoryScoreParams(): TagRecScoreParams {
  return {
    weights: { view: 0.25, likeRate: 0.3, favRate: 0.2, coinRate: 0.15, interactRate: 0.1 },
    anchors: { viewLog10: 7, likeRate: 0.12, favRate: 0.06, coinRate: 0.03, interactRate: 0.03 },
  }
}

/** 出厂「淘沙」档: 相关性先行，互动质量只参与排序；显式开启的阈值仍做筛选。 */
export function createTagRecFactoryDims(): TagRecFilterDims {
  return {
    viewMin: { enabled: false, value: 0 },
    viewMax: { enabled: false, value: 0 },
    likeMin: { enabled: false, value: 0 },
    likeMax: { enabled: false, value: 0 },
    favMin: { enabled: false, value: 0 },
    favMax: { enabled: false, value: 0 },
    coinMin: { enabled: false, value: 0 },
    coinMax: { enabled: false, value: 0 },
    danmakuMin: { enabled: false, value: 0 },
    danmakuMax: { enabled: false, value: 0 },
    replyMin: { enabled: false, value: 0 },
    replyMax: { enabled: false, value: 0 },
    shareMin: { enabled: false, value: 0 },
    shareMax: { enabled: false, value: 0 },
    likeRate: { enabled: false, value: 0.02 },
    favRate: { enabled: false, value: 0 },
    coinRate: { enabled: false, value: 0 },
    interactRate: { enabled: false, value: 0 },
    shareRate: { enabled: false, value: 0 },
    duration: { enabled: false, min: 0, max: 0 },
    pubdate: { enabled: false },
    upBlacklist: { enabled: false, list: [] },
    descKeywords: { enabled: false, list: [] },
    partitionBlock: { enabled: false, list: [] },
    partitionAllow: { enabled: false, list: [] },
    titleKeywords: { enabled: false, list: [] },
    upAllow: { enabled: false, list: [] },
    titleAllow: { enabled: false, list: [] },
    descAllow: { enabled: false, list: [] },
    tagBlock: { enabled: false, list: [], strict: false },
    tagAllow: { enabled: false, list: [], strict: false },
    minScore: { enabled: false, value: 0 },
  }
}

const FILTER_DIM_KEYS = Object.keys(createTagRecFactoryDims()) as (keyof TagRecFilterDims)[]

/** 旧预设可能缺新增维度，或存有 undefined/null；在应用与求解边界补齐。 */
export function completeTagRecFilterDims(dims: TagRecFilterDims | undefined): TagRecFilterDims {
  if (dims && FILTER_DIM_KEYS.every((key) => dims[key] != null)) return dims
  const out = createTagRecFactoryDims()
  for (const key of FILTER_DIM_KEYS) {
    const value = dims?.[key]
    if (value != null) Object.assign(out, { [key]: { ...out[key], ...value } })
  }
  return out
}

/** all/v2 出厂池槽 = 显式全集 (票05): coinRate 权按 3:2:1 摊还 + 锚 0 封禁 (结构性无投币信号) */
export function createTagRecAllV2ScoreParams(): TagRecScoreParams {
  return {
    weights: { view: 0.25, likeRate: 0.375, favRate: 0.25, coinRate: 0, interactRate: 0.125 },
    anchors: { viewLog10: 7, likeRate: 0.12, favRate: 0.06, coinRate: 0, interactRate: 0.03 },
  }
}

/** 出厂核心配置 = 「淘沙」档内容 + allV2 池槽物化显式参数 (tagTop/archiveRelated 缺席=全继承) */
export function createTagRecFactoryFilterCore(): TagRecFilterCore {
  return {
    enabled: true,
    strictMode: false,
    smallPoolThreshold: 15,
    dims: createTagRecFactoryDims(),
    score: createTagRecFactoryScoreParams(),
    pools: { allV2: { score: createTagRecAllV2ScoreParams() } },
  }
}

/** 三内置预设: 全放 / 淘沙 (首次安装默认) / 只看高质量 */
export function createTagRecBuiltinPresets(): TagRecFilterPreset[] {
  const off = createTagRecFactoryDims()
  for (const d of Object.values(off)) (d as { enabled: boolean }).enabled = false
  const hi = createTagRecFactoryDims()
  hi.likeRate = { enabled: true, value: 0.06 }
  hi.favRate = { enabled: true, value: 0.02 }
  hi.minScore = { enabled: true, value: 50 }
  return [
    { name: '全放', builtin: true, config: { ...createTagRecFactoryFilterCore(), enabled: false, dims: off } },
    { name: '淘沙', builtin: true, config: createTagRecFactoryFilterCore() },
    {
      name: '只看高质量',
      builtin: true,
      config: { ...createTagRecFactoryFilterCore(), smallPoolThreshold: 15, dims: hi },
    },
  ]
}
// #endregion

// #region 生效链求解 (filter-scope 票01): 链 会话>格(组×池)>组(L2)>L1>池>全局
/** via => 池键归并: 名单不分池, 阈值/算分按池区分 */
export function poolOfVia(via: TagRecItemExtend['source']['via'] | undefined): TagRecPoolKey {
  if (via === 'all-v2-exact' || via === 'up-search') return 'allV2'
  // 搜索相关独立成池 (feat: 区分「搜索相关」与「推荐相关」) —— allV2 格=精确命中语义
  if (via === 'all-v2-related') return 'allV2Related'
  if (via === 'archive-related') return 'archiveRelated'
  return 'tagTop' // tag-top 及未知 via 归 tagTop
}

/** 名单元素带来源标记 (归因双键「维@来源」; 全局层 scope='全局') */
export type TagRecScoped<T> = { v: T; scope: string }

/** 名单链并集产物 (票01/02): kill-list 三层叠加各层绝对; 仅看=就近覆盖取最近一层 allow */
export type TagRecNegativeMerged = {
  tagIds: TagRecScoped<TagIdEntry>[] // L1+L2 并集 (tag_id 名单无全局层)
  strict: boolean // 任一声明层 strict 即严 (并集)
  up: TagRecScoped<{ name: string; mid?: number }>[]
  title: TagRecScoped<string>[]
  desc: TagRecScoped<string>[]
  partitionBlock: TagRecScoped<TagRecPartitionEntry>[] // mode=block 各层并集
  partitionAllow?: { list: TagRecPartitionEntry[]; scope: string } // 链上最近一层 mode=allow
  // R8 仅看家族: 链上最近一层「开且非空」者 (就近覆盖, 非并集)
  upAllow?: { list: { name: string; mid?: number }[]; scope: string }
  titleAllow?: { list: string[]; scope: string }
  descAllow?: { list: string[]; scope: string }
  tagBlock?: TagRecEffectiveTagList[] // 屏蔽逐层叠加, 保留每层自己的严格开关和归因
  tagAllow?: TagRecEffectiveTagList // 会话 > L2 > L1 > 全局, 最近启用非空层
}

type TagRecTagListIndex = { ids: ReadonlySet<number>; names: ReadonlySet<string> }
type TagRecEffectiveTagList = {
  list: readonly TagIdEntry[]
  strict?: boolean
  scope: string
  index: TagRecTagListIndex
}

function indexTagRecTagList(list: readonly TagIdEntry[]): TagRecTagListIndex {
  return {
    ids: new Set(list.map((e) => e.id)),
    names: new Set(list.map((e) => normalizeTagName(e.name)).filter(Boolean)),
  }
}

/** 生效配置 = 链合并产物: cfg 为已合标量/dims/score/threshold (pools 槽已按当前池合入), neg 为已并名单 */
export type TagRecEffectiveConfig = {
  globalExclusions?: readonly TagRecConditionAtom[]
  globalExclusionsInvalid?: boolean
  combination?: TagRecCombination
  combinationInvalid?: boolean
  allowUnverified?: boolean
  cfg: TagRecFilterCore
  neg: TagRecNegativeMerged
  /** AUDIT-A1-3: 解到的归属组显示名 (阈值维 scope 标签回填; id 链借位名错位时以权威组名为准) */
  groupName?: string
  queryEntries?: readonly TagIdEntry[]
  /** 池筛选解析 (全量; false=不取): 本次>组>L1>全局，逐池继承。 */
  poolsEnabled: Record<TagRecPoolKey, boolean>
  /** 组合为「多分支各需 tag 证据」的交集形态 —— 火力集中 all/v2 的派生标记 (不写存档) */
  intersection?: boolean
}

/**
 * 归因链键 (AUDIT-A1-3): `{id}` = 组源条目稳定归因 (groupIds 与 groupNames 平行, id 权威不随改名/撞名错账);
 * 纯字符串 = 名链 (独立输入词或旧条目); undefined = 无认领 => 全局/草稿兜底链
 */
export type TagRecChainKey = string | { id?: string; name?: string } | undefined

export type TagRecScopeResolve = (key: TagRecChainKey, pool: TagRecPoolKey) => TagRecEffectiveConfig

/**
 * 条目认领链键序 (票01 任一放行评估序): groupIds 在位 => 纯 id 链 (名同序仅作标签, 求解不借位);
 * 否则名链 (独立输入词/旧条目); 全无 => [undefined] 全局/兜底链
 */
export function tagRecChainKeysOf(item: TagRecItemExtend): TagRecChainKey[] {
  const keys = (item.activeSourceClaims ?? tagRecSourceClaims(item)).flatMap<TagRecChainKey>((claim) =>
    claim.input
      ? [undefined]
      : claim.groupIds?.length
        ? claim.groupIds.map((id) => ({ id }))
        : claim.groupNames.length
          ? claim.groupNames
          : [undefined],
  )
  return [...new Map(keys.map((key) => [tagRecGroupKey(key), key])).values()]
}

/**
 * 条目最近一次投影所用 resolver (幂等缓存): 同 resolver 重复投影零成本;
 * 失效 = activeSourceClaims 被清 (mergeTagRecCandidate 合并新归因时) —— 无须版本戳
 */
const projectedBy = new WeakMap<TagRecItemExtend, TagRecScopeResolve>()

/** 来源投影先于任何评分/库存判断；不改原始证据，重开可在本地重评。 */
export function projectTagRecActiveClaims(item: TagRecItemExtend, resolve: TagRecScopeResolve): boolean {
  if (item.activeSourceClaims !== undefined && projectedBy.get(item) === resolve)
    return item.activeSourceClaims.length > 0
  item.activeSourceClaims = tagRecSourceClaims(item).flatMap((claim) => {
    const keys: TagRecChainKey[] = claim.input
      ? [undefined]
      : claim.groupIds?.length
        ? claim.groupIds.map((id) => ({ id }))
        : claim.groupNames.length
          ? claim.groupNames
          : [undefined]
    return keys.flatMap((key, i) => {
      if (!resolve(key, poolOfVia(claim.via)).poolsEnabled[poolOfVia(claim.via)]) return []
      return [
        {
          ...claim,
          groupIds: typeof key === 'object' && key?.id ? [key.id] : undefined,
          groupNames: claim.groupNames[i] ? [claim.groupNames[i]] : [],
        },
      ]
    })
  })
  projectedBy.set(item, resolve)
  return item.activeSourceClaims.length > 0
}

/**
 * 组负向名单合并读 (票11): overrides.negative 与存量顶层 negative_tag_ids/negative_strict 并集。
 * 存量写路径 (computeNegativeAdd/CSV/面板) 仍落顶层字段, 新名单维 (up/title/desc/partition) 只在 overrides;
 * JSON v2 导出统一归一到 overrides.negative, 顶层位降级为导入/迁移期只读别名。
 */
/** 旧形 partition{mode,list} => 双池键 (持久化/导入的存量 overrides.negative 读期折叠; 新写不再产旧形) */
/**
 * R8 兼容收敛 (站点 R6 旧编辑器写入的形状 => 插件规范形; 只在读/归一路径收敛, 不回写持久层):
 * - up 字符串条目 => {name} (旧站编辑器写字符串数组, 插件归一 e.name.trim() 会抛错)
 * - partitionBlock {enabled,list} 包装 => 裸数组 (插件形无开关)
 * - 分区字符串条目 => 表解析 {name,v1?,v2?} (解析不到丢弃; 旧站编辑器只写名字)
 * 无变化时返回原引用 (免无谓对象churn)
 */
export function coerceTagRecNegativeShapes(n: TagRecNegativeRules): TagRecNegativeRules {
  let out = n
  const mutate = () => {
    if (out === n) out = { ...n }
    return out
  }
  // up: 字符串条目 => {name}
  if (Array.isArray(n.up) && n.up.some((e) => typeof e === 'string')) {
    const up = (n.up as unknown[])
      .map((e) => (typeof e === 'string' ? { name: e } : e))
      .filter((e): e is { name: string; mid?: number } => {
        const o = e as { name?: unknown; mid?: unknown } | null
        if (!o || typeof o !== 'object') return false
        return (typeof o.name === 'string' && o.name.trim() !== '') || typeof o.mid === 'number'
      })
    mutate().up = up
  }
  // partitionBlock: {enabled,list} 包装 => 裸数组; 条目收敛
  const pb = n.partitionBlock as unknown
  if (pb !== undefined && !Array.isArray(pb)) {
    const list = (pb as { list?: unknown } | null)?.list
    if (Array.isArray(list)) mutate().partitionBlock = coercePartitionEntries(list)
    else delete mutate().partitionBlock
  } else if (Array.isArray(pb) && pb.some((e) => typeof e === 'string')) {
    mutate().partitionBlock = coercePartitionEntries(pb)
  }
  // partitionAllow: 条目收敛 (包装形已规范)
  if (
    n.partitionAllow &&
    Array.isArray(n.partitionAllow.list) &&
    n.partitionAllow.list.some((e) => typeof e === 'string')
  ) {
    mutate().partitionAllow = { ...n.partitionAllow, list: coercePartitionEntries(n.partitionAllow.list) }
  }
  return out
}

/** 分区条目收敛: 字符串名 => 表解析 {name,v1?,v2?}; 解析不到丢弃; 对象条目原样 */
function coercePartitionEntries(list: readonly unknown[]): TagRecPartitionEntry[] {
  const out: TagRecPartitionEntry[] = []
  for (const e of list) {
    if (typeof e === 'string') {
      const hit = PARTITION_NAME_TO_PARENT[e]
      if (hit) out.push({ name: e, v1: hit.v1, v2: hit.v2 })
      continue
    }
    if (e && typeof e === 'object') out.push(e as TagRecPartitionEntry)
  }
  return out
}

function foldLegacyPartition(n: TagRecNegativeRules): TagRecNegativeRules {
  const coerced = coerceTagRecNegativeShapes(n)
  const legacy = coerced.partition
  if (!legacy?.list?.length) return coerced
  const { partition: _drop, ...rest } = coerced
  if (legacy.mode === 'allow') {
    // AUDIT-A2-10b: 已有显式 partitionAllow (含 enabled=false 存表待开) 不复活 —— 只并入名单, 用户开关保留
    const cur = rest.partitionAllow
    rest.partitionAllow = cur
      ? { enabled: cur.enabled, list: [...cur.list, ...legacy.list] }
      : { enabled: true, list: [...legacy.list] } // 旧仅看语义常效 => 迁移保持开
  } else {
    rest.partitionBlock = [...(rest.partitionBlock ?? []), ...legacy.list]
  }
  return rest
}

export function groupNegativeMerged(g: TagGroup | undefined): TagRecNegativeRules {
  const o = g?.overrides?.negative
  // AUDIT-A2-10a: 迁移期双源可同 id 重复入链 —— 按 id 去重保序 (eval 首命中无差, 签名/名单面去冗)
  const tagIds = dedupeTagIdEntries([...(o?.tagIds ?? []), ...(g?.negative_tag_ids ?? [])])
  const strict = (o?.strict ?? false) || (g?.negative_strict ?? false)
  return foldLegacyPartition({ ...o, tagIds, strict })
}

export function l1NegativeMerged(l1: TagL1Group | undefined): TagRecNegativeRules {
  return foldLegacyPartition(l1?.overrides?.negative ?? {})
}

/** dims patch 合入: patch 粒度=整 dim 对象; patch 序低→高, 后到者赢 */
function mergeDimsPatch(
  base: TagRecFilterDims,
  ...patches: (Partial<TagRecFilterDims> | undefined)[]
): TagRecFilterDims {
  // 标签名单只读且不进标量 patch; 避免每个 (组,池) 重复深拷贝整主题的标签。
  const out: TagRecFilterDims = {
    ...cloneDeep({ ...base, tagBlock: undefined, tagAllow: undefined }),
    tagBlock: base.tagBlock,
    tagAllow: base.tagAllow,
  }
  for (const p of patches) {
    if (!p) continue
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined)
        (out as unknown as Record<string, unknown>)[k] = k === 'tagBlock' || k === 'tagAllow' ? v : cloneDeep(v)
    }
  }
  return out
}

/** score patch 合入: 逐字段就近覆盖 (weights/anchors 各成半格) */
function mergeScorePatch(base: TagRecScoreParams, ...patches: (TagRecScorePatch | undefined)[]): TagRecScoreParams {
  const out = cloneDeep(base)
  for (const p of patches) {
    if (!p) continue
    for (const [k, v] of Object.entries(p.weights ?? {})) {
      if (v !== undefined) out.weights[k as keyof TagRecScoreWeights] = v
    }
    for (const [k, v] of Object.entries(p.anchors ?? {})) {
      if (v !== undefined) out.anchors[k as keyof TagRecScoreAnchors] = v
    }
  }
  return out
}

const scopedAll = <T>(list: readonly T[] | undefined, scope: string): TagRecScoped<T>[] =>
  (list ?? []).map((v) => ({ v, scope }))

/** 生效值归因层 id (wayfinding 003): 与 :638-655 链序同步; 'combination'=组合.filters, 'derived'=交集派生默认 */
export type TagRecProvenanceLayerId =
  | 'global'
  | 'pool'
  | 'l1'
  | 'l2'
  | 'cell'
  | 'combination'
  | 'session'
  | 'sessionCell'
  | 'derived'

/** 逐字段胜者层表: 只记「声明过该键」的层 (稀疏语义: 键存在=声明, 等值也占层) */
export type TagRecEffectiveProvenance = {
  dims: Partial<Record<keyof TagRecFilterDims, TagRecProvenanceLayerId>>
  scoreWeights: Partial<Record<keyof TagRecScoreWeights, TagRecProvenanceLayerId>>
  scoreAnchors: Partial<Record<keyof TagRecScoreAnchors, TagRecProvenanceLayerId>>
  smallPoolThreshold: TagRecProvenanceLayerId
  enabled: TagRecProvenanceLayerId
  strictMode: TagRecProvenanceLayerId
  poolsEnabled: Record<TagRecPoolKey, TagRecProvenanceLayerId>
  /** 名单严格位声明层 (L1‖L2 的 OR 拆源); 未声明 = undefined */
  negStrict?: 'l1' | 'l2'
}

/** 会话位有序 patch (低到高): 'combination'=组合.filters, 'session'=会话补丁 —— 顺序应用与 mergeTagRecCombinationFilters 逐键合并等价 */
type TagRecSessionLayer = { id: TagRecProvenanceLayerId; patch: TagRecSessionFilterPatch }

const sessionLayerLabel = (id: TagRecProvenanceLayerId | undefined): string =>
  id === 'combination' ? '组合' : id === 'session' ? '会话' : '全局'

/**
 * 逐 (组,池) 求生效配置 (纯函数版, UI/测试可用; 轮内求解难走 createTagRecScopeResolver 带缓存).
 * sessionCore 只覆盖本次修改的字段；未修改的标量、评分和池开关继续继承。
 * 临时仅看规则统一优先于组/L1；明确关闭或清空可以解除下层仅看。组/L1 屏蔽仍然叠加。
 * groupName 未命中/未给 => 全局链 (池层仍可生效)。
 */
export function resolveTagRecEffective(
  core: TagRecFilterCore,
  pool: TagRecPoolKey,
  group?: TagGroup,
  l1?: TagL1Group,
  sessionCore?: TagRecSessionFilterPatch,
  tagListIndexes = new Map<readonly TagIdEntry[], TagRecTagListIndex>(),
): TagRecEffectiveConfig {
  return resolveTagRecEffectiveInner(
    core,
    pool,
    group,
    l1,
    sessionCore ? [{ id: 'session', patch: sessionCore }] : [],
    tagListIndexes,
  ).eff
}

/**
 * 归因版求解 (组现状面板): 会话位拆为 组合.filters → 会话 两层顺序应用,
 * 返回 eff + 逐字段胜者层 prov。结果与 resolveTagRecEffective(传入合并 patch) 逐项等价。
 */
export function resolveTagRecEffectiveProvenance(
  core: TagRecFilterCore,
  pool: TagRecPoolKey,
  group?: TagGroup,
  l1?: TagL1Group,
  sessionCore?: TagRecSessionFilterPatch,
  tagListIndexes = new Map<readonly TagIdEntry[], TagRecTagListIndex>(),
): TagRecEffectiveConfig & { prov: TagRecEffectiveProvenance } {
  const prov: TagRecEffectiveProvenance = {
    dims: {},
    scoreWeights: {},
    scoreAnchors: {},
    smallPoolThreshold: 'global',
    enabled: 'global',
    strictMode: 'global',
    poolsEnabled: { tagTop: 'derived', allV2: 'derived', allV2Related: 'derived', archiveRelated: 'derived' },
  }
  const layers: TagRecSessionLayer[] = []
  if (group?.combination?.filters) layers.push({ id: 'combination', patch: group.combination.filters })
  if (sessionCore) layers.push({ id: 'session', patch: sessionCore })
  const { eff } = resolveTagRecEffectiveInner(core, pool, group, l1, layers, tagListIndexes, prov)
  return { ...eff, prov }
}

function resolveTagRecEffectiveInner(
  core: TagRecFilterCore,
  pool: TagRecPoolKey,
  group: TagGroup | undefined,
  l1: TagL1Group | undefined,
  sessionLayers: readonly TagRecSessionLayer[],
  tagListIndexes: Map<readonly TagIdEntry[], TagRecTagListIndex>,
  prov?: TagRecEffectiveProvenance,
): { eff: TagRecEffectiveConfig } {
  // 会话位各层顺序应用 ≡ 逐键合并补丁 —— 合并后消费维持原求解体零改动
  const sessionCore = mergeTagRecCombinationFilters(...sessionLayers.map((l) => l.patch))
  /** 该键由哪个会话位层最后声明 (后声明赢) —— 归因与名单 scope 标签共用 */
  const sessionLayerOfDim = (key: keyof TagRecFilterDims): TagRecProvenanceLayerId | undefined => {
    let hit: TagRecProvenanceLayerId | undefined
    for (const l of sessionLayers) if (l.patch.dims?.[key] !== undefined) hit = l.id
    return hit
  }
  const l2 = group?.overrides
  const l1o = group ? l1?.overrides : undefined // L1 仅随麾下组链生效, 裸全局链不吃 L1 (票01)
  const poolOvr = core.pools?.[pool]
  const cell = l2?.pools?.[pool]
  const sessionCell = sessionCore?.pools?.[pool]
  // score 池层对 allV2Related 回落 allV2 槽 (同字段形适配, 与 resolvePoolScoreParams 同口径);
  //   dims/smallPoolThreshold 严格按本池键 —— 那是用户意图, 分池就是为了拆开
  const poolScore = poolOvr?.score ?? (pool === 'allV2Related' ? core.pools?.allV2?.score : undefined)
  const sessionScore = sessionCell?.score ?? (pool === 'allV2Related' ? sessionCore?.pools?.allV2?.score : undefined)
  const baseDims = completeTagRecFilterDims(core.dims)
  const dims = mergeDimsPatch(
    baseDims,
    poolOvr?.dims,
    l1o?.dims,
    l2?.dims,
    cell?.dims,
    sessionCore?.dims,
    sessionCell?.dims,
  )
  const score = mergeScorePatch(
    core.score,
    poolScore,
    l1o?.score,
    l2?.score,
    cell?.score,
    sessionCore?.score,
    sessionScore,
  )
  const cfg: TagRecFilterCore = {
    enabled: sessionCore?.enabled ?? core.enabled,
    strictMode: sessionCore?.strictMode ?? core.strictMode,
    smallPoolThreshold:
      sessionCell?.smallPoolThreshold ??
      sessionCore?.smallPoolThreshold ??
      cell?.smallPoolThreshold ??
      l2?.smallPoolThreshold ??
      l1o?.smallPoolThreshold ??
      poolOvr?.smallPoolThreshold ??
      core.smallPoolThreshold,
    dims,
    score,
  }
  const g = { ...baseDims, ...sessionCore?.dims }
  const scopeOf = (key: keyof TagRecFilterDims) => sessionLayerLabel(sessionLayerOfDim(key))
  if (prov) {
    // 键存在性回放: 链序与上方 merge 同源 —— 池→L1→组→格→会话位(逐层)→会话格(逐层), 后声明赢
    const cellLayers = sessionLayers.map((l) => ({
      id: (l.id === 'combination' ? 'combination' : 'sessionCell') as TagRecProvenanceLayerId,
      patch: l.patch.pools?.[pool],
    }))
    const dimsChain: [TagRecProvenanceLayerId, Partial<TagRecFilterDims> | undefined][] = [
      ['pool', poolOvr?.dims],
      ['l1', l1o?.dims],
      ['l2', l2?.dims],
      ['cell', cell?.dims],
      ...sessionLayers.map(
        (l) => [l.id, l.patch.dims] as [TagRecProvenanceLayerId, Partial<TagRecFilterDims> | undefined],
      ),
      ...cellLayers.map(
        (c) => [c.id, c.patch?.dims] as [TagRecProvenanceLayerId, Partial<TagRecFilterDims> | undefined],
      ),
    ]
    for (const [id, patch] of dimsChain)
      if (patch)
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) prov.dims[k as keyof TagRecFilterDims] = id
    const scoreChain: [TagRecProvenanceLayerId, TagRecScorePatch | undefined][] = [
      ['pool', poolScore],
      ['l1', l1o?.score],
      ['l2', l2?.score],
      ['cell', cell?.score],
      ...sessionLayers.map((l) => [l.id, l.patch.score] as [TagRecProvenanceLayerId, TagRecScorePatch | undefined]),
    ]
    // 会话格 score 回放与上方 wholesale 回落同口径: 逐层本池 score, 全无才回落各层 allV2 槽
    const layerCellScores = sessionLayers.map((l) => l.patch.pools?.[pool]?.score)
    const cellScoreEntries = (
      layerCellScores.some((s) => s !== undefined)
        ? layerCellScores
        : sessionLayers.map((l) => l.patch.pools?.allV2?.score)
    ).map(
      (s, i) =>
        [sessionLayers[i].id === 'combination' ? 'combination' : 'sessionCell', s] as [
          TagRecProvenanceLayerId,
          TagRecScorePatch | undefined,
        ],
    )
    for (const [id, patch] of [...scoreChain, ...cellScoreEntries]) {
      if (!patch) continue
      for (const [k, v] of Object.entries(patch.weights ?? {}))
        if (v !== undefined) prov.scoreWeights[k as keyof TagRecScoreWeights] = id
      for (const [k, v] of Object.entries(patch.anchors ?? {}))
        if (v !== undefined) prov.scoreAnchors[k as keyof TagRecScoreAnchors] = id
    }
    // 标量就近覆盖 = 从高到低首个声明层 (链序: 会话格>会话位>格>组>L1>池>全局)
    const thrChain: [TagRecProvenanceLayerId, number | undefined][] = [
      ...[...cellLayers]
        .reverse()
        .map((c) => [c.id, c.patch?.smallPoolThreshold] as [TagRecProvenanceLayerId, number | undefined]),
      ...[...sessionLayers]
        .reverse()
        .map((l) => [l.id, l.patch.smallPoolThreshold] as [TagRecProvenanceLayerId, number | undefined]),
      ['cell', cell?.smallPoolThreshold],
      ['l2', l2?.smallPoolThreshold],
      ['l1', l1o?.smallPoolThreshold],
      ['pool', poolOvr?.smallPoolThreshold],
    ]
    prov.smallPoolThreshold = thrChain.find(([, v]) => v !== undefined)?.[0] ?? 'global'
    for (const l of [...sessionLayers].reverse()) {
      if (l.patch.enabled !== undefined) {
        prov.enabled = l.id
        break
      }
    }
    for (const l of [...sessionLayers].reverse()) {
      if (l.patch.strictMode !== undefined) {
        prov.strictMode = l.id
        break
      }
    }
    for (const p of TAG_REC_ALL_POOL_KEYS) {
      const hit = sessionLayers.findLast((l) => l.patch.poolsEnabled?.[p] !== undefined)
      prov.poolsEnabled[p] =
        hit?.id ??
        (l2?.poolsEnabled?.[p] !== undefined
          ? 'l2'
          : l1o?.poolsEnabled?.[p] !== undefined
            ? 'l1'
            : core.poolsEnabled?.[p] !== undefined
              ? 'global'
              : 'derived')
    }
  }
  const l1Neg = group ? l1NegativeMerged(l1) : {}
  const l2Neg = groupNegativeMerged(group)
  const tagList = (rule: TagRecTagListRule | undefined, scope: string): TagRecEffectiveTagList | undefined => {
    if (!rule?.enabled || !rule.list.length) return undefined
    let index = tagListIndexes.get(rule.list)
    if (!index) {
      index = indexTagRecTagList(rule.list)
      tagListIndexes.set(rule.list, index)
    }
    return { list: rule.list, strict: rule.strict, scope, index }
  }
  const baseTagBlock = tagList(g.tagBlock, scopeOf('tagBlock'))
  const baseTagAllow = tagList(g.tagAllow, scopeOf('tagAllow'))
  const groupTagAllow = tagList(l2Neg.tagAllow, group?.name ?? '组') ?? tagList(l1Neg.tagAllow, l1?.name ?? 'L1')
  const allowList = <T>(
    key: 'partitionAllow' | 'upAllow' | 'titleAllow' | 'descAllow',
    groupRule: { enabled: boolean; list: T[] } | undefined,
    l1Rule: { enabled: boolean; list: T[] } | undefined,
    baseRule: { enabled: boolean; list: T[] },
  ): { list: T[]; scope: string } | undefined => {
    const sessionHit = sessionLayerOfDim(key)
    if (sessionHit !== undefined) {
      return baseRule.enabled && baseRule.list.length
        ? { list: baseRule.list, scope: sessionLayerLabel(sessionHit) }
        : undefined
    }
    if (groupRule?.enabled && groupRule.list.length) return { list: groupRule.list, scope: group?.name ?? '组' }
    if (l1Rule?.enabled && l1Rule.list.length) return { list: l1Rule.list, scope: l1?.name ?? 'L1' }
    return baseRule.enabled && baseRule.list.length ? { list: baseRule.list, scope: '全局' } : undefined
  }
  const neg: TagRecNegativeMerged = {
    // 本次只覆盖声明的全局名单；组/L1 屏蔽继续叠加。
    tagBlock: [
      baseTagBlock,
      tagList(l1Neg.tagBlock, l1?.name ?? 'L1'),
      tagList(l2Neg.tagBlock, group?.name ?? '组'),
    ].filter((entry): entry is TagRecEffectiveTagList => !!entry),
    tagAllow: sessionLayerOfDim('tagAllow') !== undefined ? baseTagAllow : (groupTagAllow ?? baseTagAllow),
    tagIds: [...scopedAll(l1Neg.tagIds, l1?.name ?? 'L1'), ...scopedAll(l2Neg.tagIds, group?.name ?? '组')],
    strict: !!(l2Neg.strict || l1Neg.strict),
    up: [
      ...scopedAll(g.upBlacklist.enabled ? g.upBlacklist.list : [], scopeOf('upBlacklist')),
      ...scopedAll(l1Neg.up, l1?.name ?? 'L1'),
      ...scopedAll(l2Neg.up, group?.name ?? '组'),
    ],
    title: [
      ...scopedAll(g.titleKeywords.enabled ? g.titleKeywords.list : [], scopeOf('titleKeywords')),
      ...scopedAll(l1Neg.title, l1?.name ?? 'L1'),
      ...scopedAll(l2Neg.title, group?.name ?? '组'),
    ],
    desc: [
      ...scopedAll(g.descKeywords.enabled ? g.descKeywords.list : [], scopeOf('descKeywords')),
      ...scopedAll(l1Neg.desc, l1?.name ?? 'L1'),
      ...scopedAll(l2Neg.desc, group?.name ?? '组'),
    ],
    partitionBlock: [
      ...scopedAll(g.partitionBlock.enabled ? g.partitionBlock.list : [], scopeOf('partitionBlock')),
      ...scopedAll(l1Neg.partitionBlock, l1?.name ?? 'L1'),
      ...scopedAll(l2Neg.partitionBlock, group?.name ?? '组'),
    ],
    // 五类仅看采用相同的会话优先级；未声明时仍按组>L1>全局就近。
    partitionAllow: allowList('partitionAllow', l2Neg.partitionAllow, l1Neg.partitionAllow, g.partitionAllow),
    upAllow: allowList('upAllow', l2Neg.upAllow, l1Neg.upAllow, g.upAllow),
    titleAllow: allowList('titleAllow', l2Neg.titleAllow, l1Neg.titleAllow, g.titleAllow),
    descAllow: allowList('descAllow', l2Neg.descAllow, l1Neg.descAllow, g.descAllow),
  }
  // 池筛选逐池继承，临时修改一池不会改变其他池。
  //   交集形态下只留 allV2 精确搜索池缺省档 (派生收窄, 不物化进存档) —— tag×tag 交集里
  //   tag/top 单边货只有一边 claim, 另一边永远 pending 占坑; archive/related 逐条 bvid
  //   单独发请求、零 tag 证据; allV2Related 虽搭 all/v2 响应顺风车, 但交集下相关条
  //   噪声盖过产出 => 同收窄。任一显式声明照常胜出。
  //   tagAllow 生效链名单 (会话>L2>L1>全局) 同样是必过 tag 约束 => 计一个 tag 证据分支;
  //   组合内 filters.dims.tagAllow 由判定函数自查 —— 两侧同语义不重复计
  const intersection =
    !!group?.combination && isTagRecCombinationIntersection(group.combination, !!neg.tagAllow?.list.length)
  const poolsEnabled: Record<TagRecPoolKey, boolean> = {
    tagTop: true,
    allV2: true,
    allV2Related: true,
    archiveRelated: true,
  }
  for (const p of TAG_REC_ALL_POOL_KEYS) {
    poolsEnabled[p] =
      sessionCore?.poolsEnabled?.[p] ??
      l2?.poolsEnabled?.[p] ??
      l1o?.poolsEnabled?.[p] ??
      core.poolsEnabled?.[p] ??
      (!intersection || p === 'allV2')
  }
  if (prov && (l2Neg.strict || l1Neg.strict)) prov.negStrict = l2Neg.strict ? 'l2' : 'l1'
  return { eff: { cfg, neg, poolsEnabled, intersection } }
}

/** 全池键序 (R8 池筛选解析/UI 共用; 与 types.TagRecPoolKey 同步维护) */
export const TAG_REC_ALL_POOL_KEYS: readonly TagRecPoolKey[] = ['tagTop', 'allV2', 'allV2Related', 'archiveRelated']

/**
 * 生效链求解器工厂 (票01): 轮初建一次, 内部按 (组,池) 缓存解好有效配置。
 * 名解析: `X·相关` 旁路归因剥后缀回落源组 (票13, 与 service attributionKey 同语义);
 * 未命中名回落 fallbackGroup (tab2 草稿组: 持本会话一切未归属来源的名单位, 票02)。
 */
export function createTagRecScopeResolver(opts: {
  globalExclusions?: readonly TagRecConditionAtom[]
  globalExclusionsInvalid?: boolean
  allowUnverified?: boolean
  core: TagRecFilterCore
  sessionCore?: TagRecSessionFilterPatch
  groupsByName?: ReadonlyMap<string, TagGroup>
  /** A1-3: 组 id => 组 (id 链权威解析; 名表仅作名链/旧路径兜底 —— 重名组不再互相错账) */
  groupsById?: ReadonlyMap<string, TagGroup>
  l1ById?: ReadonlyMap<string, TagL1Group>
  fallbackGroup?: TagGroup
  queryEntries?: readonly TagIdEntry[]
}): TagRecScopeResolve {
  const cache = new Map<string, TagRecEffectiveConfig>()
  const tagListIndexes = new Map<readonly TagIdEntry[], TagRecTagListIndex>()
  return (key, pool) => {
    const k: { id?: string; name?: string } | undefined = typeof key === 'string' ? { name: key } : key
    const cacheKey = `${k?.id ? `#${k.id}` : (k?.name ?? '')}|${pool}`
    let eff = cache.get(cacheKey)
    if (!eff) {
      // 实修: 未归属名 (name 未命中收藏表) 与空认领皆回落 fallbackGroup —
      //   草稿组语义 = 本会话一切未归属来源的负向位
      // A1-3: id 键不回退名查 —— id 给了但表里没了 (=组已删) 落兜底, 若按名撞会错挂同名别组规则
      const group = k?.id
        ? (opts.groupsById?.get(k.id) ?? opts.fallbackGroup)
        : k?.name
          ? (opts.groupsByName?.get(k.name) ?? opts.groupsByName?.get(stripRelatedSuffix(k.name)) ?? opts.fallbackGroup)
          : opts.fallbackGroup
      const l1 = group?.l1Id ? opts.l1ById?.get(group.l1Id) : undefined
      const combinationFilters = mergeTagRecCombinationFilters(group?.combination?.filters, opts.sessionCore)
      eff = {
        ...resolveTagRecEffective(opts.core, pool, group, l1, combinationFilters, tagListIndexes),
        globalExclusions: opts.globalExclusions,
        globalExclusionsInvalid: opts.globalExclusionsInvalid,
        combination: group?.combination && { ...group.combination, filters: combinationFilters },
        combinationInvalid: group?.combination !== undefined && !validateTagRecCombination(group.combination),
        allowUnverified: opts.allowUnverified,
        groupName: group?.name,
        queryEntries: group?.tag_ids.length ? group.tag_ids : opts.queryEntries,
      }
      cache.set(cacheKey, eff)
    }
    return eff
  }
}

/** 池层分数参数 (梯队链 = 全局默认 → pools[池].score 合入; 组层不进梯队, 票05/10) */
export function resolvePoolScoreParams(core: TagRecFilterCore, pool: TagRecPoolKey): TagRecScoreParams {
  // allV2Related 缺槽回落 allV2 槽: 两源字段覆盖同构 (all-v2 系均无 coin/share),
  //   allV2 参数是为该字段形调的 (coinRate=0) —— 属机械适配非「搜索池意图」外溢;
  //   用户显式配 allV2Related.score 时自然胜出。dims/阈值不回退 (那是真意图, 分池就是为了拆开)
  const slot = core.pools?.[pool] ?? (pool === 'allV2Related' ? core.pools?.allV2 : undefined)
  return mergeScorePatch(core.score, slot?.score)
}

/**
 * 过滤生效签名 (实修「放宽过滤救不活已滤条」的单向死):
 *   覆盖生效链全部输入 —— 全局/会话副本 + 每组(名/负向名单/严格标/overrides) + 每L1(名/overrides)
 *   + 草稿兜底组负向件。组/L1 名参与签名因为生效链按名解析 (改名=链变)。
 *   service 侧签名变化重评未交付原料与库存；来源变化由独立签名协调，保留已付预算。
 *   曝光、交付事实与深挖页游标保留，恢复候选不额外重取已消费页面。
 */
export function computeTagRecFilterSignature(opts: {
  core: TagRecFilterCore
  sessionCore?: TagRecSessionFilterPatch
  groups?: readonly TagGroup[]
  l1s?: readonly TagL1Group[]
  fallbackGroup?: Pick<TagGroup, 'name' | 'negative_tag_ids' | 'negative_strict' | 'overrides' | 'combination'>
  withoutSources?: boolean
}): string {
  const json = (v: unknown) =>
    JSON.stringify(
      getVersion(v) === undefined ? (v ?? null) : snapshot(v as object),
      opts.withoutSources
        ? (key, value) => {
            if (key === 'poolsEnabled') return undefined
            if (
              value &&
              !Array.isArray(value) &&
              typeof value === 'object' &&
              Object.keys(value).every((k) => k === 'poolsEnabled' || value[k] === undefined)
            )
              return key ? undefined : null
            return value
          }
        : undefined,
    )
  // AUDIT-A2-3: l1Id 入签 —— 生效链沿 l1Id 上溯 L1, 改挂即链变; 漏签则 tab2 放宽侧 seenBvids 不清
  const grp = (
    g: Pick<TagGroup, 'name' | 'negative_tag_ids' | 'negative_strict' | 'overrides' | 'l1Id' | 'combination'>,
  ) =>
    `${g.name}|${g.l1Id ?? ''}|${g.negative_strict ? 1 : 0}|${json(g.negative_tag_ids)}|${json(g.overrides)}|${json(g.combination)}`
  return [
    json(opts.core),
    json(opts.sessionCore),
    (opts.groups ?? []).map(grp).sort().join(';'),
    (opts.l1s ?? [])
      .map((l) => `${l.name}|${json(l.overrides)}`)
      .sort()
      .join(';'),
    opts.fallbackGroup ? grp(opts.fallbackGroup) : '',
  ].join('::')
}

/** patch 可表达的 dim 键全集 (= keyof TagRecDimsPatch; 名单四维走 negative 容器, 结构性除外) */
export const TAG_REC_PATCHABLE_DIM_KEYS = [
  'viewMin',
  'viewMax',
  'likeMin',
  'likeMax',
  'favMin',
  'favMax',
  'coinMin',
  'coinMax',
  'danmakuMin',
  'danmakuMax',
  'replyMin',
  'replyMax',
  'shareMin',
  'shareMax',
  'likeRate',
  'favRate',
  'coinRate',
  'interactRate',
  'shareRate',
  'duration',
  'pubdate',
  'minScore',
] as const satisfies readonly (keyof TagRecDimsPatch)[]

/**
 * draft-基准差分 => 稀疏 override (票12 GroupConfigModal 存盘核):
 *   draft = 含本层 override 的生效解编辑副本; base = 剥掉本层 override 的重解。
 *   per-dim 整对象比对 (键存在=override, isEqual=回继承不键化); score 逐字段; 标量直比。
 *   返回 undefined = 无任何覆盖 (调用侧据此删槽)。
 */
export function diffTagRecScopeOverride(
  draft: TagRecFilterCore,
  base: TagRecFilterCore,
): TagRecScopeOverride | undefined {
  const patch: TagRecScopeOverride = {}
  const dims: TagRecDimsPatch = {}
  for (const k of TAG_REC_PATCHABLE_DIM_KEYS) {
    if (!isEqual(draft.dims[k], base.dims[k])) {
      ;(dims as Record<string, unknown>)[k] = cloneDeep(draft.dims[k])
    }
  }
  if (Object.keys(dims).length) patch.dims = dims

  const weights: Partial<TagRecScoreWeights> = {}
  for (const k of Object.keys(draft.score.weights) as (keyof TagRecScoreWeights)[]) {
    if (draft.score.weights[k] !== base.score.weights[k]) weights[k] = draft.score.weights[k]
  }
  const anchors: Partial<TagRecScoreAnchors> = {}
  for (const k of Object.keys(draft.score.anchors) as (keyof TagRecScoreAnchors)[]) {
    if (draft.score.anchors[k] !== base.score.anchors[k]) anchors[k] = draft.score.anchors[k]
  }
  if (Object.keys(weights).length || Object.keys(anchors).length) {
    patch.score = {
      ...(Object.keys(weights).length ? { weights } : {}),
      ...(Object.keys(anchors).length ? { anchors } : {}),
    }
  }

  if (draft.smallPoolThreshold !== base.smallPoolThreshold) {
    patch.smallPoolThreshold = draft.smallPoolThreshold
  }
  return Object.keys(patch).length ? patch : undefined
}

/** 名单草稿归一化 (票12): trim/去重/摘空集; 全空 => undefined (槽位删键=回继承) */
export function normalizeTagRecNegativeDraft(n: TagRecNegativeRules | undefined): TagRecNegativeRules | undefined {
  if (!n) return undefined
  // R8: 旧形 (字符串 up / 包装 partitionBlock) 先收敛再归一
  const src = coerceTagRecNegativeShapes(n)
  const out: TagRecNegativeRules = {}
  const strList = (l?: string[]) => [...new Set((l ?? []).map((s) => s.trim()).filter(Boolean))]
  const up = (src.up ?? []).filter((e) => e.name.trim() || e.mid !== undefined)
  if (up.length) out.up = up.map((e) => ({ name: e.name.trim(), mid: e.mid }))
  const title = strList(src.title)
  if (title.length) out.title = title
  const desc = strList(src.desc)
  if (desc.length) out.desc = desc
  // R8 仅看家族 (归一: {enabled,list} 整体存, 同 partitionAllow「关闸存表留待下次开」口径)
  const upAllow = (src.upAllow?.list ?? []).filter((e) => e.name.trim() || e.mid !== undefined)
  if (upAllow.length) {
    out.upAllow = { enabled: !!src.upAllow?.enabled, list: upAllow.map((e) => ({ name: e.name.trim(), mid: e.mid })) }
  }
  const titleAllow = strList(src.titleAllow?.list)
  if (titleAllow.length) out.titleAllow = { enabled: !!src.titleAllow?.enabled, list: titleAllow }
  const descAllow = strList(src.descAllow?.list)
  if (descAllow.length) out.descAllow = { enabled: !!src.descAllow?.enabled, list: descAllow }
  if (src.tagIds?.length) out.tagIds = src.tagIds
  if (src.strict) out.strict = true
  for (const key of ['tagBlock', 'tagAllow'] as const) {
    const rule = src[key]
    if (!rule?.list.length) continue
    out[key] = {
      enabled: !!rule.enabled,
      strict: !!rule.strict,
      list: dedupeTagIdEntries(rule.list.map((entry) => ({ ...entry, name: entry.name.trim() }))),
    }
  }
  // 分区双池 (拆池实修): 屏蔽池有内容即存; 仅看池存「开状态+表」整体 (关闸存表留待下次开)
  const folded = foldLegacyPartition(n)
  if (folded.partitionBlock?.length) out.partitionBlock = folded.partitionBlock
  if (folded.partitionAllow?.list.length) {
    out.partitionAllow = { enabled: !!folded.partitionAllow.enabled, list: folded.partitionAllow.list }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 名单并集 (导入并入既有组): 各槽按身份键去重合并, 同组互斥链各自仍是同层域;
 * partitionAllow.enabled 取 OR (任一来源开则开), 全空 => undefined
 */
export function mergeTagRecNegativeRules(
  a: TagRecNegativeRules | undefined,
  b: TagRecNegativeRules | undefined,
): TagRecNegativeRules | undefined {
  const x = a ? foldLegacyPartition(a) : {}
  const y = b ? foldLegacyPartition(b) : {}
  const out: TagRecNegativeRules = {}
  const byId = (x.tagIds ?? []).concat(y.tagIds ?? [])
  const seenIds = new Set<number>()
  const tagIds = byId.filter((e) => !seenIds.has(e.id) && seenIds.add(e.id))
  if (tagIds.length) out.tagIds = tagIds
  if (x.strict || y.strict) out.strict = true
  for (const key of ['tagBlock', 'tagAllow'] as const) {
    const list = dedupeTagIdEntries([...(x[key]?.list ?? []), ...(y[key]?.list ?? [])])
    if (list.length)
      out[key] = { enabled: !!(x[key]?.enabled || y[key]?.enabled), strict: !!(x[key]?.strict || y[key]?.strict), list }
  }
  const seenUp = new Set<string>()
  const up = (x.up ?? []).concat(y.up ?? []).filter((e) => {
    const k = e.mid !== undefined ? `m:${e.mid}` : `n:${e.name.trim().toLowerCase()}`
    return !seenUp.has(k) && seenUp.add(k)
  })
  if (up.length) out.up = up
  const unionStr = (p?: string[], q?: string[]) => [...new Set((p ?? []).concat(q ?? []))]
  const title = unionStr(x.title, y.title)
  if (title.length) out.title = title
  const desc = unionStr(x.desc, y.desc)
  if (desc.length) out.desc = desc
  // R8 仅看家族并集 (enabled 取 OR, 同 partitionAllow 口径)
  const seenUpAllow = new Set<string>()
  const upAllowList = (x.upAllow?.list ?? []).concat(y.upAllow?.list ?? []).filter((e) => {
    const k = e.mid !== undefined ? `m:${e.mid}` : `n:${e.name.trim().toLowerCase()}`
    return !seenUpAllow.has(k) && seenUpAllow.add(k)
  })
  if (upAllowList.length) out.upAllow = { enabled: !!(x.upAllow?.enabled || y.upAllow?.enabled), list: upAllowList }
  const titleAllowList = unionStr(x.titleAllow?.list, y.titleAllow?.list)
  if (titleAllowList.length) {
    out.titleAllow = { enabled: !!(x.titleAllow?.enabled || y.titleAllow?.enabled), list: titleAllowList }
  }
  const descAllowList = unionStr(x.descAllow?.list, y.descAllow?.list)
  if (descAllowList.length) {
    out.descAllow = { enabled: !!(x.descAllow?.enabled || y.descAllow?.enabled), list: descAllowList }
  }
  const seenPe = new Set<string>()
  const peKey = (e: TagRecPartitionEntry) => `${e.v1 ?? ''}|${e.v2 ?? ''}`
  const block = (x.partitionBlock ?? [])
    .concat(y.partitionBlock ?? [])
    .filter((e) => !seenPe.has(peKey(e)) && seenPe.add(peKey(e)))
  if (block.length) out.partitionBlock = block
  const allowList = (x.partitionAllow?.list ?? [])
    .concat(y.partitionAllow?.list ?? [])
    .filter((e) => !seenPe.has(peKey(e)) && seenPe.add(peKey(e)))
  if (x.partitionAllow?.enabled || y.partitionAllow?.enabled || allowList.length) {
    out.partitionAllow = {
      enabled: !!(x.partitionAllow?.enabled || y.partitionAllow?.enabled),
      list: allowList,
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 导入与面板合并共用：屏蔽名单并集，其他冲突保留目标、缺项补齐。
 * 仅看条件整项优先，严格开关不因合并自动开启。
 */
export { mergeTagRecGroupOverrides as mergeTagRecScopeOverrideForImport } from './merge-groups'

/** override 非空判定 (行徽标/徽数): 任一槽有键即算 */
export function hasTagRecOverride(o: TagRecScopeOverride | undefined): boolean {
  if (!o) return false
  return (
    !!(o.dims && Object.keys(o.dims).length) ||
    !!(o.score && (Object.keys(o.score.weights ?? {}).length || Object.keys(o.score.anchors ?? {}).length)) ||
    o.smallPoolThreshold !== undefined
  )
}

/** 组 overrides 非空判定 (行 ⚙ 徽标): 本层槽/negative 容器/格槽任一有内容 */
export function hasTagRecGroupConfig(o: TagRecGroupOverrides | TagRecL1Overrides | undefined): boolean {
  if (!o) return false
  if (hasTagRecOverride(o)) return true
  if (normalizeTagRecNegativeDraft(o.negative)) return true
  // R8: 池筛选任一 false 即算配置 (全 true/空 = 无覆盖)
  if (o.poolsEnabled && Object.values(o.poolsEnabled).some((v) => typeof v === 'boolean')) return true
  return (
    !!(o as TagRecGroupOverrides).pools &&
    Object.values((o as TagRecGroupOverrides).pools ?? {}).some(hasTagRecOverride)
  )
}

// #region R6: 槽位存盘组装 (ScopeConfigEditor onSave 产物 -> overrides 落位)
/** 槽位存盘条目 (key 由调用方定槽位语义: 'group'|'l1'|`cell:${pool}`|`pool:${pool}`) */
export type TagRecScopeSaveEntry = {
  key: string
  patch?: TagRecScopeOverride // dims/score/smallPoolThreshold 差分; undefined = 回继承 (摘槽键)
  negative?: TagRecNegativeRules // 归一后名单容器 (仅非 cell 槽); undefined = 摘
  /** R8 池筛选覆盖 (稀疏 false; 键缺席 = 该槽不支持池筛选, 不动存储; 显式 undefined = 清覆盖) */
  poolsEnabled?: Partial<Record<TagRecPoolKey, boolean>>
}

/**
 * [tag-rec] entries -> 组 overrides 整槽组装: **只动已建草稿槽, 未开槽原样保留**
 * - 'group' 槽: patch 覆盖三键 (patch 缺 = 三键摘回继承); negative 容器整替 (缺 = 摘)
 * - `cell:${pool}` 槽: patch 落 pools[pool] (缺 = 摘槽); pools 全空连容器摘
 * - 修正旧 onSave 未开「组」槽时把整段组级 overrides 误清的潜伏 bug (R6)
 */
export function applyTagRecScopeEntriesToGroupOverrides(
  prev: TagRecGroupOverrides | undefined,
  entries: TagRecScopeSaveEntry[],
): TagRecGroupOverrides | undefined {
  const next = cloneDeep(prev ?? {})
  for (const e of entries) {
    if (e.key === 'group') {
      // 三键整槽替换 (非合并): diff 产物是「当前全部覆盖项」全量形 —— 用户把某键全重置回继承时
      //   patch 缺该键, 合并会残留旧槽 (重置静默失效); 整槽替换 = patch 缺键即摘回继承
      if (e.patch?.dims) next.dims = e.patch.dims
      else delete next.dims
      if (e.patch?.score) next.score = e.patch.score
      else delete next.score
      if (e.patch?.smallPoolThreshold !== undefined) next.smallPoolThreshold = e.patch.smallPoolThreshold
      else delete next.smallPoolThreshold
      if (e.negative) next.negative = e.negative
      else delete next.negative
      // R8 池筛选: 键缺席 = 调用方不支持 (不动存储); 显式 undefined = 清覆盖
      if ('poolsEnabled' in e) {
        if (e.poolsEnabled) next.poolsEnabled = e.poolsEnabled
        else delete next.poolsEnabled
      }
    } else if (e.key.startsWith('cell:')) {
      const p = e.key.slice(5) as TagRecPoolKey
      const pools = (next.pools ??= {})
      if (e.patch) pools[p] = e.patch
      else delete pools[p]
      if (!Object.keys(pools).length) delete next.pools
    }
  }
  return Object.keys(next).length ? next : undefined
}

/** L1 版 (无 pools 槽; 单 'l1' 槽语义) —— 同「只动已建草稿槽」口径 */
export function applyTagRecScopeEntriesToL1Overrides(
  prev: TagRecL1Overrides | undefined,
  entries: TagRecScopeSaveEntry[],
): TagRecL1Overrides | undefined {
  const next = cloneDeep(prev ?? {})
  for (const e of entries) {
    if (e.key !== 'l1') continue
    // 三键整槽替换 (同组版口径: 重置静默失效防呆)
    if (e.patch?.dims) next.dims = e.patch.dims
    else delete next.dims
    if (e.patch?.score) next.score = e.patch.score
    else delete next.score
    if (e.patch?.smallPoolThreshold !== undefined) next.smallPoolThreshold = e.patch.smallPoolThreshold
    else delete next.smallPoolThreshold
    if (e.negative) next.negative = e.negative
    else delete next.negative
    if ('poolsEnabled' in e) {
      if (e.poolsEnabled) next.poolsEnabled = e.poolsEnabled
      else delete next.poolsEnabled
    }
  }
  return Object.keys(next).length ? next : undefined
}

/** 剥枝组副本: 从链上摘掉目标槽 (group 槽摘 dims/score/threshold; cell 槽摘 pools[P]) —— 差分基准构造 */
export function stripTagRecGroupSlot(g: TagGroup, key: string): TagGroup {
  const o = g.overrides
  if (!o) return g
  if (key === 'group') {
    return { ...g, overrides: { ...o, dims: undefined, score: undefined, smallPoolThreshold: undefined } }
  }
  const pool = key.slice(5) as TagRecPoolKey
  return { ...g, overrides: { ...o, pools: { ...o.pools, [pool]: undefined } } }
}

/** L1 链生效需要一个 L2 主体: 取首个麾下组剥本层, 无麾下 => 裸桩 (l1Id 指向该 L1 即入链) */
export function tagRecL1ChainGroup(l: TagL1Group, groups: TagGroup[]): TagGroup {
  const child = groups.find((g) => g.l1Id === l.id)
  if (child) return { ...child, overrides: undefined }
  return { id: '', name: '', l1Id: l.id, tag_ids: [], weight: 1, enabled: true, addedAt: 0 }
}
// #endregion

// #region 过滤评估
export type TagRecFilterCtx = {
  /** 召回/库存阶段暂留分区未知项，交付前异步核验。 */
  deferPartitions?: boolean
  /** 上屏时分区未知不能放行；召回阶段仍可暂存等待补查。 */
  confirmPartitions?: boolean
  /** 轮内池有效条数 (小池降级判定); 缺省 = 不降级 */
  poolSize?: number
  poolSizes?: Readonly<Record<string, number>>
  sourcePool?: TagRecPoolKey
  /** 负池: 负向 tid => 其 tag/top 池 bvid 集合 (negative-slice 会话级预热; 名单本体走 resolver) */
  negative?: {
    pools: ReadonlyMap<number, ReadonlySet<string>>
  }
  /** minScore 维的分数来源; 缺省内部按该链 score 参数 computeScore */
  scoreOf?: (item: TagRecItemExtend, params: TagRecScoreParams) => number | undefined
  /** pubdate 判定时钟 (ms), 测试可注入; 缺省 Date.now() */
  now?: number
  /** 兼容未携带普通过滤上下文的旧切片；正常管线补查后按原池深复核完整链。 */
  onlyTagLists?: boolean
  /** 标签发掘的仅看必须与原查询取交集，防相关兜底扩大到名单标签的独立视频池。 */
  queryMatches?: (item: TagRecItemExtend) => boolean
  /**
   * 小池降级时的「相关兜底放行」: 池浅 (degraded) 时放行 related 路由
   * (搜索相关 all-v2-related / 推荐相关 archive-related) 的组合 mismatch 条目 ——
   * 恢复工作台之前的语义: 相关条带「相关」徽标交付、不冒充命中标签; 非 related 路由
   * 的 mismatch (精确搜索/标签池确认不符) 与排除条件仍照常拒绝。
   */
  relatedFallback?: boolean
}

type DimVerdict = 'pass' | 'fail' | 'miss' // miss = 字段缺失 (豁免/严格反转素材)
type DimVerdictScoped = { verdict: DimVerdict; scope?: string }

/** 标签按 id / 归一化整名匹配; 浅池命中是正证据, 浅池未命中不能证明视频没有该标签。 */
export function evalTagRecTagList(
  item: Pick<TagRecItemExtend, 'bvid' | 'ownTagNames' | 'ownTagIds'>,
  list: readonly TagIdEntry[],
  mode: 'block' | 'allow',
  pools?: ReadonlyMap<number, ReadonlySet<string>>,
  index = indexTagRecTagList(list),
): DimVerdict {
  if (!list.length) return 'pass'
  const known = item.ownTagNames !== undefined || item.ownTagIds !== undefined
  // 已知视频按少量自身标签查 Set; 未知视频只检查已有浅池, 不扫描几千条名单。
  let hit = !!(
    known &&
    (item.ownTagIds?.some((id) => index.ids.has(id)) ||
      item.ownTagNames?.some((name) => index.names.has(normalizeTagName(name))))
  )
  if (!known && item.bvid && pools) {
    for (const [id, bvids] of pools)
      if (index.ids.has(id) && bvids.has(item.bvid)) {
        hit = true
        break
      }
  }
  if (!known && !hit) return 'miss'
  return mode === 'block' ? (hit ? 'fail' : 'pass') : hit ? 'pass' : 'fail'
}

/** 小池降级判定: 池有效条数 < 阈值 => 比率族+minScore 失效; threshold<=0 = 永不降级 (逃生口, 票06) */
export function isTagRecSmallPoolDegraded(cfg: TagRecFilterCore, poolSize: number | undefined): boolean {
  return cfg.smallPoolThreshold > 0 && poolSize !== undefined && poolSize < cfg.smallPoolThreshold
}

const RATE_DIM_KEYS = ['likeRate', 'favRate', 'coinRate', 'interactRate', 'shareRate'] as const
const DEGRADED_OFF_DIMS: ReadonlySet<TagRecDropDimKey> = new Set<TagRecDropDimKey>([...RATE_DIM_KEYS, 'minScore'])

const rateOf = (num: number | undefined, view: number | undefined): number | undefined =>
  num === undefined || view === undefined || view <= 0 ? undefined : num / view

function rateVerdict(rate: number | undefined, threshold: number): DimVerdict {
  if (threshold <= 0) return 'pass'
  if (rate === undefined) return 'miss'
  return rate >= threshold ? 'pass' : 'fail'
}

/** 绝对值维: value<=0 = 未设 => 恒 pass (不吃严格); stat 缺 => miss */
function absVerdict(stat: number | undefined, threshold: number, cmp: 'min' | 'max'): DimVerdict {
  if (threshold <= 0) return 'pass'
  if (stat === undefined) return 'miss'
  return cmp === 'min' ? (stat >= threshold ? 'pass' : 'fail') : stat <= threshold ? 'pass' : 'fail'
}

/**
 * 旧分区 number 迁移 (R3-05): 旧语义 `list.includes(tid) || list.includes(tidv2)` 扁平等值。
 * x ∈ PARTITION_EXPAND_V2 (v2 一级分区段) => 只发 v1 键保死值 —— 旧义下 x 近乎不可命中
 *   (tid 是 v1 段), 双键会把陈旧 x 复活成整分区屏蔽/仅看; v1 侧对 ≥1001 恒死恰好承载「保死」。
 * 其余 => 双键等值还原 (v1 tid 旧义活值随新判升到叶展开属可接受语义; v2 叶等值保原义)。
 */
export function migrateLegacyPartitionId(x: number): TagRecPartitionEntry {
  return PARTITION_EXPAND_V2[x] !== undefined ? { name: `#${x}`, v1: x } : { name: `#${x}`, v1: x, v2: x }
}

/** 归一化子串判 (票02, 票35 同款归一): 首个命中者 scope 带出归因
 *  W1-3: 归一化后 <2 字符的词不作判据 (types.ts 规格 ≥2; 单字符词如「的」「e」
 *  经 includes 几乎必中 = 静默灭整个池)。消费点兜底 —— 写入侧另有 block-write/import 过滤 */
function scopedSubstringHit(list: readonly TagRecScoped<string>[], text: string | undefined): string | null {
  if (text == null || !list.length) return null
  const t = normalizeTagName(text)
  for (const e of list) {
    const kw = normalizeTagName(e.v)
    if (kw.length >= 2 && t.includes(kw)) return e.scope
  }
  return null
}

export type TagRecItemDrop = { dim: TagRecDropDimKey; scope: string }
/** 单链原始掉落: scope 可空 (名单维自带声明层名; 阈值维由 evalTagRecItem 回填链名) */
type TagRecChainDrop = { dim: TagRecDropDimKey; scope?: string }

/**
 * 单链判定 (票01): 名单并集 + dims 依固定序; 返回 null=放行, 否则首失败维(+名单维来源 scope)。
 * 来源闸先行，内容过滤关闭后跳过内容条件；名单开关在生效链解析，空名单放行。
 */
export function evalTagRecChain(
  item: TagRecItemExtend,
  eff: TagRecEffectiveConfig,
  ctx: TagRecFilterCtx = {},
): TagRecChainDrop | null {
  const { cfg, neg } = eff
  if (!eff.poolsEnabled[ctx.sourcePool ?? poolOfVia(item.source.via)]) return { dim: 'poolFilter', scope: '池筛选' }
  if (eff.globalExclusionsInvalid) return { dim: 'combination', scope: '全局排除条件不兼容' }
  if (eff.globalExclusions?.length) {
    const global = newTagRecCombination()
    global.exclude = [...eff.globalExclusions]
    const result = evalTagRecCombination(item, global)
    if (result.state === 'mismatch' || (result.state === 'unknown' && !ctx.deferPartitions && !eff.allowUnverified))
      return { dim: 'combination', scope: result.state === 'unknown' ? '待核实全局排除' : '以后都不看' }
  }
  if (eff.combinationInvalid) return { dim: 'combination', scope: '组合条件不兼容' }
  if (eff.combination) {
    const result = evalTagRecCombination(item, eff.combination)
    // 小池降级 + related 路由: mismatch 兜底放行 (徽标仍显示「相关」, 不冒充命中)。
    //   排除/屏蔽 (本组合不看 + 组合显式过滤名单) 命中时同样落 mismatch —— 用 excluded 判据挡住,
    //   保证「明确排除与来源闸」不被兜底绕过 (设计稿 B04)。
    const pool = ctx.sourcePool ?? poolOfVia(item.source.via)
    const relatedRoute = pool === 'allV2Related' || pool === 'archiveRelated'
    const fallback =
      ctx.relatedFallback &&
      relatedRoute &&
      (result.state === 'mismatch' ||
        // 交集收窄衔接: related 条停证据补查后只能停在 unknown —— 降级兜底一并放行,
        //   否则停补查的相关条永远够不着兜底 (选种仍要求完整 match, 单边货不进 related 流)
        (eff.intersection && result.state === 'unknown')) &&
      !isTagRecCombinationExcluded(item, eff.combination)
    if (result.state === 'mismatch' && !fallback) return { dim: 'combination', scope: '组合条件' }
    if (result.state === 'unknown' && !ctx.deferPartitions && !eff.allowUnverified && !fallback)
      return { dim: 'combination', scope: '待核实组合' }
  }
  if (!cfg.enabled) return null
  const dims = cfg.dims
  const strict = cfg.strictMode
  const degraded = isTagRecSmallPoolDegraded(cfg, ctx.poolSize)
  const nowSec = (ctx.now ?? Date.now()) / 1000
  const { stat } = item
  const view = stat.view

  const evaluators: [TagRecDropDimKey, () => DimVerdictScoped][] = [
    // 与请求计划共用允许来源；关闭 claim 不进入评分、池深或库存。
    [
      'poolFilter',
      () =>
        eff.poolsEnabled[ctx.sourcePool ?? poolOfVia(item.source.via)] === false
          ? { verdict: 'fail', scope: '池筛选' }
          : { verdict: 'pass' },
    ],
    // 黑名单维 = 组内负向过滤 (裁量见文件头注): all/v2 名匹配 + 负向池交集
    [
      'blacklist',
      () => {
        if (!neg.tagIds.length) return { verdict: 'pass' }
        const own = item.ownTagNames
        let hit: TagRecScoped<TagIdEntry> | undefined
        if (item.ownTagIds !== undefined) {
          const ids = new Set(item.ownTagIds)
          hit = neg.tagIds.find((e) => ids.has(e.v.id))
        } else if (own?.length) {
          const ownNorm = new Set(own.map(normalizeTagName))
          hit = neg.tagIds.find((e) => ownNorm.has(normalizeTagName(e.v.name)))
        } else if (item.bvid) {
          hit = neg.tagIds.find((e) => e.v.id != null && ctx.negative?.pools.get(e.v.id)?.has(item.bvid))
        }
        if (!hit) return { verdict: 'pass' }
        return { verdict: 'fail', scope: hit.scope } // 池交集/自报名 = 直接证据, 不因 stat 不全豁免
      },
    ],
    // 同一标签同时在两侧时屏蔽先判; 组内负向也在仅看之前判定。
    [
      'tagBlock',
      () => {
        for (const list of neg.tagBlock ?? []) {
          const verdict = evalTagRecTagList(item, list.list, 'block', ctx.negative?.pools, list.index)
          if (verdict === 'fail') return { verdict, scope: list.scope }
        }
        return { verdict: 'pass' }
      },
    ],
    [
      'tagAllow',
      () => {
        const list = neg.tagAllow
        if (!list) return { verdict: 'pass' }
        if (ctx.queryMatches && !ctx.queryMatches(item)) return { verdict: 'fail', scope: list.scope }
        const verdict = evalTagRecTagList(item, list.list, 'allow', ctx.negative?.pools, list.index)
        return {
          // 缺标签永不当作「没有标签」; 严格开关负责切片补查, 失败仍放行。
          verdict: verdict === 'miss' ? 'pass' : verdict,
          scope: list.scope,
        }
      },
    ],
    // 名单开关已按所属组与上层配置合并，无需再检查全局同名 dim 开关。
    [
      'upBlacklist',
      () => {
        if (!neg.up.length) return { verdict: 'pass' }
        const { mid, name } = item.owner ?? {}
        if (mid === undefined && name === undefined) return { verdict: 'miss' }
        const nameN = name !== undefined ? normalizeTagName(name) : undefined
        const hit = neg.up.find((e) => {
          // AUDIT-A2-11: 双 mid 俱在 => mid 独断 (同名异 UP 不被名兜底误杀);
          //   名兜底要求名单名非空 (无名条目 ''==='' 不误伤同无名 item)
          if (e.v.mid !== undefined && mid !== undefined) return e.v.mid === mid
          const en = normalizeTagName(e.v.name)
          return en !== '' && nameN === en
        })
        return hit ? { verdict: 'fail', scope: hit.scope } : { verdict: 'pass' }
      },
    ],
    [
      'titleKeywords',
      () => {
        // AUDIT-A2-4: 名单非空而字段缺 => miss (strict 反转「缺=不过」); 空名单照旧 pass
        if (neg.title.length && !item.title) return { verdict: 'miss' }
        const scope = scopedSubstringHit(neg.title, item.title)
        return scope ? { verdict: 'fail', scope } : { verdict: 'pass' }
      },
    ],
    // R8 仅看家族: 域收窄 (开且非空才生效; 缺字段 miss —— 非严格豁免 / strict 反转, 与屏蔽侧同构)
    [
      'upAllow',
      () => {
        const allow = neg.upAllow
        if (!allow || !allow.list.length) return { verdict: 'pass' }
        const { mid, name } = item.owner ?? {}
        if (mid === undefined && name === undefined) return { verdict: 'miss' }
        const nameN = name !== undefined ? normalizeTagName(name) : undefined
        const hit = allow.list.some((e) => {
          if (e.mid !== undefined && mid !== undefined) return e.mid === mid
          const en = normalizeTagName(e.name)
          return en !== '' && nameN === en
        })
        return hit ? { verdict: 'pass' } : { verdict: 'fail', scope: allow.scope }
      },
    ],
    [
      'titleAllow',
      () => {
        const allow = neg.titleAllow
        if (!allow || !allow.list.length) return { verdict: 'pass' }
        if (!item.title) return { verdict: 'miss' }
        const t = normalizeTagName(item.title)
        const hit = allow.list.some((kw) => {
          const k = normalizeTagName(kw)
          return k.length >= 2 && t.includes(k)
        })
        return hit ? { verdict: 'pass' } : { verdict: 'fail', scope: allow.scope }
      },
    ],
    [
      'descKeywords',
      () => {
        // 仅搜索/相关池判定 (票02): tag/top 池不判 desc
        const via = item.source.via
        if (via !== 'all-v2-exact' && via !== 'all-v2-related' && via !== 'archive-related') {
          return { verdict: 'pass' }
        }
        if (neg.desc.length && item.desc === undefined) return { verdict: 'miss' } // AUDIT-A2-4 同 title
        const scope = scopedSubstringHit(neg.desc, item.desc)
        return scope ? { verdict: 'fail', scope } : { verdict: 'pass' }
      },
    ],
    [
      'descAllow',
      () => {
        const allow = neg.descAllow
        if (!allow || !allow.list.length) return { verdict: 'pass' }
        // R8 统一语义: 不硬编码池豁免 —— tag/top 条目本无 desc => miss (非严格豁免 / strict 反转)
        if (item.desc === undefined) return { verdict: 'miss' }
        const d = normalizeTagName(item.desc)
        const hit = allow.list.some((kw) => {
          const k = normalizeTagName(kw)
          return k.length >= 2 && d.includes(k)
        })
        return hit ? { verdict: 'pass' } : { verdict: 'fail', scope: allow.scope }
      },
    ],
    // 分区双池 (拆池实修): 屏蔽池=命中即滤(kill-list 各层并集); 仅看池=域门(就近一层, 开且非空才生效)
    //   两池同分区 => 屏蔽先判赢 (仅看域内命中屏蔽照样死); 分区字段全缺 => miss (strict 反转)
    [
      'partitionBlock',
      () => {
        if (!neg.partitionBlock.length) return { verdict: 'pass' }
        let unknown = false
        for (const e of neg.partitionBlock) {
          const verdict = evalTagRecPartitionEntry(item, e.v)
          if (verdict === 'match') return { verdict: 'fail', scope: e.scope }
          unknown ||= verdict === 'unknown'
        }
        return { verdict: unknown ? 'miss' : 'pass' }
      },
    ],
    [
      'partitionAllow',
      () => {
        const allow = neg.partitionAllow
        if (!allow || !allow.list.length) return { verdict: 'pass' }
        const verdict = evalTagRecPartitionList(item, allow.list)
        return { verdict: verdict === 'match' ? 'pass' : verdict === 'unknown' ? 'miss' : 'fail', scope: allow.scope }
      },
    ],
    // 绝对值族 (view + stat 七项各 min/max 分键归因, 票04)
    ['viewMin', () => ({ verdict: absVerdict(view, dims.viewMin.value, 'min') })],
    ['viewMax', () => ({ verdict: absVerdict(view, dims.viewMax.value, 'max') })],
    ['likeMin', () => ({ verdict: absVerdict(stat.like, dims.likeMin.value, 'min') })],
    ['likeMax', () => ({ verdict: absVerdict(stat.like, dims.likeMax.value, 'max') })],
    ['favMin', () => ({ verdict: absVerdict(stat.favorite, dims.favMin.value, 'min') })],
    ['favMax', () => ({ verdict: absVerdict(stat.favorite, dims.favMax.value, 'max') })],
    ['coinMin', () => ({ verdict: absVerdict(stat.coin, dims.coinMin.value, 'min') })],
    ['coinMax', () => ({ verdict: absVerdict(stat.coin, dims.coinMax.value, 'max') })],
    ['danmakuMin', () => ({ verdict: absVerdict(stat.danmaku, dims.danmakuMin.value, 'min') })],
    ['danmakuMax', () => ({ verdict: absVerdict(stat.danmaku, dims.danmakuMax.value, 'max') })],
    ['replyMin', () => ({ verdict: absVerdict(stat.reply, dims.replyMin.value, 'min') })],
    ['replyMax', () => ({ verdict: absVerdict(stat.reply, dims.replyMax.value, 'max') })],
    ['shareMin', () => ({ verdict: absVerdict(stat.share, dims.shareMin.value, 'min') })],
    ['shareMax', () => ({ verdict: absVerdict(stat.share, dims.shareMax.value, 'max') })],
    // 元信息族
    [
      'duration',
      () => {
        const { min, max } = dims.duration
        if (min <= 0 && max <= 0) return { verdict: 'pass' }
        if (item.duration === undefined) return { verdict: 'miss' }
        if (min > 0 && item.duration < min) return { verdict: 'fail' }
        if (max > 0 && item.duration > max) return { verdict: 'fail' }
        return { verdict: 'pass' }
      },
    ],
    [
      'pubdate',
      () => {
        const d = dims.pubdate
        const winDays = d.win === 'today' ? -1 : d.win === 'days' ? (d.days ?? 0) : d.win ? Number(d.win.slice(1)) : 0
        const hasTod = !!d.tod && (d.tod.from !== undefined || d.tod.to !== undefined)
        if (winDays <= 0 && d.win !== 'today' && d.from === undefined && d.to === undefined && !hasTod) {
          return { verdict: 'pass' }
        }
        const n = item.pubdate
        if (n === undefined) return { verdict: 'miss' }
        if (d.win === 'today') {
          const midnight = new Date(ctx.now ?? Date.now())
          midnight.setHours(0, 0, 0, 0)
          if (n < midnight.getTime() / 1000) return { verdict: 'fail' }
        } else if (winDays > 0 && n < nowSec - winDays * 86400) {
          return { verdict: 'fail' }
        }
        if (d.from !== undefined && n < d.from) return { verdict: 'fail' }
        if (d.to !== undefined && n > d.to) return { verdict: 'fail' }
        if (hasTod) {
          const t = new Date(n * 1000)
          const m = t.getHours() * 60 + t.getMinutes()
          const f = d.tod!.from ?? 0
          const to = d.tod!.to ?? 1440
          const inTod = f <= to ? m >= f && m < to : m >= f || m < to
          if (!inTod) return { verdict: 'fail' }
        }
        return { verdict: 'pass' }
      },
    ],
    // 比率族 (num/view >= value; view<=0 视同比率不可成 => miss)
    ['likeRate', () => ({ verdict: rateVerdict(rateOf(stat.like, view), dims.likeRate.value) })],
    ['favRate', () => ({ verdict: rateVerdict(rateOf(stat.favorite, view), dims.favRate.value) })],
    ['coinRate', () => ({ verdict: rateVerdict(rateOf(stat.coin, view), dims.coinRate.value) })],
    [
      'interactRate',
      () => ({
        verdict: rateVerdict(
          stat.danmaku === undefined || stat.reply === undefined ? undefined : rateOf(stat.danmaku + stat.reply, view),
          dims.interactRate.value,
        ),
      }),
    ],
    ['shareRate', () => ({ verdict: rateVerdict(rateOf(stat.share, view), dims.shareRate.value) })],
    [
      'minScore',
      () => {
        if (dims.minScore.value <= 0) return { verdict: 'pass' }
        // AUDIT-A2-7: 注入即全责 —— scoreOf 返 undefined 即「不可评」走 miss, 不再回退内部算分
        const score = ctx.scoreOf ? ctx.scoreOf(item, cfg.score) : computeScore(item, cfg.score).score
        if (score === undefined) return { verdict: 'miss' }
        return { verdict: score >= dims.minScore.value ? 'pass' : 'fail' }
      },
    ],
  ]

  for (const [dim, fn] of evaluators) {
    if (ctx.onlyTagLists && dim !== 'blacklist' && dim !== 'tagBlock' && dim !== 'tagAllow') continue
    // 未开维度不评估 (名单维/poolFilter 不在此门控: 前者由名单链驱动, 后者非 dims 项)
    if (dim !== 'poolFilter' && !LIST_DIM_KEYS.has(dim) && !dims[dim as keyof TagRecFilterDims].enabled) continue
    if (degraded && DEGRADED_OFF_DIMS.has(dim)) continue // 小池降级: 比率族+minScore 失效
    const raw = fn()
    if (ctx.deferPartitions && raw.verdict === 'miss' && (dim === 'partitionBlock' || dim === 'partitionAllow'))
      continue
    const partition = dim === 'partitionBlock' || dim === 'partitionAllow'
    const v = raw.verdict === 'miss' ? (strict || (partition && ctx.confirmPartitions) ? 'fail' : 'pass') : raw.verdict
    if (v === 'fail') return { dim, scope: raw.scope } // 名单维自带来源层; 阈值维无 scope 由上层回填链名
  }
  return null
}

/**
 * 单条多链评估 (票01 任一放行): 逐认领组链各跑一遍, 任一链放行即活;
 * 全灭 => 归因首个认领组链的首个失败维 (groupNames 序). 无认领组 => 全局链.
 */
export function evalTagRecItem(
  item: TagRecItemExtend,
  resolve: TagRecScopeResolve,
  ctx: TagRecFilterCtx = {},
): { pass: boolean; drop?: TagRecItemDrop } {
  projectTagRecActiveClaims(item, resolve)
  const chains = tagRecChainKeysOf(item)
  // 相关兜底只放「认领全为 related 路由」的条目: 带 allV2/tagTop 等可证认领的合并条
  //   (mergeTagRecCandidate 累积多源 claims), mismatch 是实锤不能被附带的 related claim
  //   赦免 —— 徽标按主路由显示, 否则「搜索」条被兜底放行而不自知 (违背「不冒充命中」)
  const relatedOnly =
    chains.length > 0 &&
    chains
      .flatMap((key) => tagRecPoolsForChain(item, key))
      .every((pool) => pool === 'allV2Related' || pool === 'archiveRelated')
  let firstDrop: TagRecItemDrop | undefined
  const eligible: string[] = []
  const scopes: string[] = []
  for (const key of chains) {
    for (const pool of tagRecPoolsForChain(item, key)) {
      const eff = resolve(key, pool)
      const r = evalTagRecChain(item, eff, {
        ...ctx,
        sourcePool: pool,
        relatedFallback: ctx.relatedFallback && relatedOnly,
        poolSize: ctx.poolSizes?.[tagRecPoolScopeKey(key, pool)] ?? ctx.poolSize,
      })
      if (r == null) {
        eligible.push(tagRecGroupKey(key))
        scopes.push(tagRecPoolScopeKey(key, pool))
        continue
      }
      const label = typeof key === 'string' ? key : (key?.name ?? eff.groupName)
      firstDrop ??= { dim: r.dim, scope: r.scope ?? label ?? '全局' }
    }
  }
  item.eligibleGroupKeys = [...new Set(eligible)]
  item.eligiblePoolScopes = scopes
  return {
    pass: eligible.length > 0,
    drop: eligible.length ? undefined : (firstDrop ?? { dim: 'poolFilter', scope: '池筛选' }),
  }
}

export function tagRecPoolScopeKey(key: TagRecChainKey, pool: TagRecPoolKey): string {
  return JSON.stringify([tagRecGroupKey(key), pool])
}

export function tagRecPoolsForChain(item: TagRecItemExtend, key: TagRecChainKey): TagRecPoolKey[] {
  const pools = tagRecClaimsForGroup(item, key).map((claim) => poolOfVia(claim.via))
  return [...new Set(pools)]
}

/** 按组与召回来源去重计池深，大池不影响另一组或另一来源的降级资格。 */
export function tagRecPoolSizes(items: readonly TagRecItemExtend[]): Record<string, number> {
  const scopes = new Map<string, Set<string>>()
  for (const item of items)
    for (const key of tagRecChainKeysOf(item)) {
      for (const pool of tagRecPoolsForChain(item, key)) {
        const scope = tagRecPoolScopeKey(key, pool)
        let bvids = scopes.get(scope)
        if (!bvids) scopes.set(scope, (bvids = new Set()))
        bvids.add(item.bvid)
      }
    }
  return Object.fromEntries([...scopes].map(([scope, bvids]) => [scope, bvids.size]))
}
// #endregion

// #region 轮次过滤 (聚合入口: 服务 stages.filterStage 调此)
export type TagRecFilterRoundStats = {
  /** 本轮滤除总条数 (= Σ byDim, 首命中归因) */
  dropped: number
  /** 已看去重跳过的候选数，单独展示，不混入过滤条件的 dropped/byDim。 */
  seenDropped?: number
  /** 分维度滤除计数 {dimension: count} */
  byDim: Partial<Record<TagRecDropDimKey, number>>
  /** 双键细账 {「维@来源」: count} (票01: 组级屏蔽归因 UI 尾注用; Σ === dropped) */
  byScope?: Record<string, number>
  /** 小池降级标记 (横幅「池浅已放宽过滤」消费, spec §3.3) */
  degraded: boolean
  /** 严格校验未能核查而放行的条数 (退避直通/拉取失败/超时; negative-slice 切片级回报) */
  unchecked?: number
}

export function runTagRecFilter(
  items: TagRecItemExtend[],
  opts: {
    resolve: TagRecScopeResolve
    pools?: ReadonlyMap<number, ReadonlySet<string>>
    poolSize?: number
    poolItems?: readonly TagRecItemExtend[]
    now?: number
    scoreOf?: TagRecFilterCtx['scoreOf']
    queryMatches?: TagRecFilterCtx['queryMatches']
    deferPartitions?: boolean
    relatedFallback?: boolean
  },
): { items: TagRecItemExtend[]; stats: TagRecFilterRoundStats } {
  const poolSize = opts.poolSize ?? items.length // 有效条数 = 轮内去重后进入过滤的条目数
  for (const item of [...(opts.poolItems ?? []), ...items]) projectTagRecActiveClaims(item, opts.resolve)
  const poolSizes = tagRecPoolSizes(opts.poolItems ?? items)
  // 保留单池调用的显式分母接口；服务入口传完整原料池，始终使用组×来源分母。
  if (!opts.poolItems && opts.poolSize !== undefined && Object.keys(poolSizes).length === 1)
    for (const scope of Object.keys(poolSizes)) poolSizes[scope] = opts.poolSize
  const ctx: TagRecFilterCtx = {
    poolSize,
    poolSizes,
    negative: opts.pools ? { pools: opts.pools } : undefined,
    now: opts.now,
    scoreOf: opts.scoreOf,
    queryMatches: opts.queryMatches,
    deferPartitions: opts.deferPartitions,
    relatedFallback: opts.relatedFallback,
  }
  const byDim: Partial<Record<TagRecDropDimKey, number>> = {}
  const byScope: Record<string, number> = {}
  const out: TagRecItemExtend[] = []
  let dropped = 0
  let degraded = false
  for (const it of items) {
    // AUDIT-A2-8: 降级标记按「该条任一认领组链」判定 (多归属条目第2..n链降级同样点亮横幅);
    //   resolver 有缓存, 多链重复调用免费
    if (!degraded) {
      for (const key of tagRecChainKeysOf(it)) {
        for (const pool of tagRecPoolsForChain(it, key)) {
          const eff = opts.resolve(key, pool)
          if (eff.cfg.enabled && isTagRecSmallPoolDegraded(eff.cfg, poolSizes[tagRecPoolScopeKey(key, pool)])) {
            degraded = true
            break
          }
        }
      }
    }
    const r = evalTagRecItem(it, opts.resolve, ctx)
    if (r.pass) {
      it.filterPoolSize = poolSize
      it.filterPoolSizes = poolSizes
      out.push(it)
      continue
    }
    dropped++
    byDim[r.drop!.dim] = (byDim[r.drop!.dim] ?? 0) + 1
    const sk = `${r.drop!.dim}@${r.drop!.scope}`
    byScope[sk] = (byScope[sk] ?? 0) + 1
  }
  return { items: out, stats: { dropped, byDim, byScope, degraded } }
}
// #endregion

// #region 综合分 + 排序 + 多样性护栏
export type TagRecScoreResult = {
  /** 0~100; 无有效分量 / partial => undefined */
  score: number | undefined
  /** stat 缺到只剩 view (或 item.partial) => 不伪造分数，排序另用中性值。 */
  partial: boolean
  /** 截断后分量 (诊断/测试用) */
  components: Partial<Record<keyof TagRecScoreWeights, number>>
}

/**
 * spec §3.3: score = Σ(wᵢ·min(1,cᵢ/anchorᵢ))×100
 *   分量: view => log10(view+1) (锚 viewLog10) ; 四比率 num/view 线性 (锚 likeRate/favRate/coinRate/interactRate)
 *   缺分量跳过 + 权重按比例重归一; partial (stat 只剩 view) 不算分
 */
export function computeScore(item: TagRecItemExtend, params: TagRecScoreParams): TagRecScoreResult {
  const { stat } = item
  const partial = item.partial ?? isPartialStat(stat)
  const components: TagRecScoreResult['components'] = {}
  if (partial) return { score: undefined, partial: true, components }

  const { weights, anchors } = params
  const view = stat.view
  const cView = view !== undefined && view >= 0 ? Math.log10(view + 1) : undefined
  const rates: Record<Exclude<keyof TagRecScoreWeights, 'view'>, number | undefined> = {
    likeRate: rateOf(stat.like, view),
    favRate: rateOf(stat.favorite, view),
    coinRate: rateOf(stat.coin, view),
    interactRate:
      stat.danmaku === undefined || stat.reply === undefined ? undefined : rateOf(stat.danmaku + stat.reply, view),
  }
  const raw: Record<keyof TagRecScoreWeights, { c: number | undefined; a: number }> = {
    view: { c: cView, a: anchors.viewLog10 },
    likeRate: { c: rates.likeRate, a: anchors.likeRate },
    favRate: { c: rates.favRate, a: anchors.favRate },
    coinRate: { c: rates.coinRate, a: anchors.coinRate },
    interactRate: { c: rates.interactRate, a: anchors.interactRate },
  }

  let wsum = 0
  let acc = 0
  let anyComp = false
  for (const k of Object.keys(raw) as (keyof TagRecScoreWeights)[]) {
    const { c, a } = raw[k]
    if (c === undefined || a <= 0) continue // 缺分量 / 锚失效 => 跳过且不占权重
    const comp = Math.min(1, Math.max(0, c / a)) // AUDIT-A2-6: 截底 —— 负 stat (导入/手改数据) 不倒扣总分
    components[k] = comp
    anyComp = true
    const w = weights[k] ?? 0
    wsum += w
    acc += w * comp
  }
  if (!anyComp) return { score: undefined, partial, components }
  return { score: wsum > 0 ? (acc / wsum) * 100 : 0, partial, components }
}

/** 相关性证据优先，同层按质量、源序排序；缺统计使用中性排序值。 */
export function sortTagRecItems(items: TagRecItemExtend[]): TagRecItemExtend[] {
  return [...items].sort(compareTagRecItems)
}

export type TagRecDiversityOpts = {
  /** loadMore 切片长 = service PAGE_SIZE (默认 20) */
  sliceSize?: number
  /** 两轴参数 (票09): 组占比轴 + 单 UP 轴; 缺省轴 = 关 */
  guard?: TagRecDiversityGuardSettings
  /** 条目归属组 (默认 source.groupNames 全部组各计一票) */
  groupOf?: (item: TagRecItemExtend) => readonly string[]
}

export type TagRecDeferredCounts = { group: number; up: number }

/**
 * diversityGuard (spec §3.3/§4.3 + 票09): 逐「虚拟切片」贪心整形, 超额顺延不丢弃。
 *   组轴: 单组占每切片 ≤ floor(sliceSize*maxShare) (缺省 0.6, 默认关)
 *   UP 轴: 同一 owner.mid 每切片 ≤ max (缺省 4, 默认开; 缺 mid 豁免)
 *   切片起始计数清零 => 首条必取 => 有限步内必排空 (顺延是软保证, 不死锁)。
 *   顺延条数走 deferred 回报 (不进滤除口径)。
 */
export function applyDiversityGuard(
  items: TagRecItemExtend[],
  opts: TagRecDiversityOpts = {},
): { items: TagRecItemExtend[]; deferred: TagRecDeferredCounts } {
  const sliceSize = opts.sliceSize ?? 20
  const g = opts.guard
  const groupOn = g?.group.enabled ?? false
  const upOn = g?.up.enabled ?? true
  const quota = Math.max(1, Math.floor(sliceSize * (g?.group.maxShare ?? 0.6)))
  const upMax = Math.max(1, Math.floor(g?.up.max ?? 4))
  // A1-3: 组轴计数按 id (稳定键; 「A·相关」衍生并入本源组配额, 不再因后缀名逃组轴)
  const groupOf =
    opts.groupOf ?? ((it: TagRecItemExtend) => it.eligibleGroupKeys ?? tagRecChainKeysOf(it).map(tagRecGroupKey))
  const pool = [...items]
  const out: TagRecItemExtend[] = []
  const deferredGroup = new Set<TagRecItemExtend>()
  const deferredUp = new Set<TagRecItemExtend>()
  while (pool.length) {
    const counts = new Map<string, number>()
    const upCounts = new Map<number, number>()
    let taken = 0
    for (let i = 0; i < pool.length && taken < sliceSize; i++) {
      const it = pool[i]
      const gs = groupOf(it).length ? groupOf(it) : ['']
      const mid = it.owner?.mid
      const groupHit = groupOn && !gs.every((x) => (counts.get(x) ?? 0) < quota)
      const upHit = upOn && mid !== undefined && (upCounts.get(mid) ?? 0) >= upMax
      if (groupHit || upHit) {
        if (groupHit) deferredGroup.add(it)
        if (upHit) deferredUp.add(it)
        continue
      }
      pool.splice(i, 1)
      i--
      for (const x of gs) counts.set(x, (counts.get(x) ?? 0) + 1)
      if (mid !== undefined) upCounts.set(mid, (upCounts.get(mid) ?? 0) + 1)
      out.push(it)
      taken++
    }
  }
  return { items: out, deferred: { group: deferredGroup.size, up: deferredUp.size } }
}

/**
 * 逐链算分一次出全量 (复用设计 2): 单趟遍历认领链×池, 同参数 computeScore 只算一遍,
 * 顺手带回 {最佳参数, 最佳分, 组键=>池=>得分明细} —— 总分排序/组内排序/选种三处复用同一遍结果
 * (改前: 选参数一遍 + 按参数重算一遍 + qualityByGroup 再逐池一遍)
 */
export function evalTagRecItemScores(
  item: TagRecItemExtend,
  resolve: TagRecScopeResolve,
): {
  /** 最佳得分对应参数 (选种/门槛判据输入); 无链得分时回落工厂默认 */
  params: TagRecScoreParams
  /** 最佳得分结果 (总排序分); 无任何链得分时为工厂参数下的 computeScore 结果 */
  result: TagRecScoreResult
  /** 组键 => 池 => 该链得分 (qualityByGroup 原料; 未过 eligiblePoolScopes 的池不收录) */
  byGroup: Map<string, Map<TagRecPoolKey, TagRecScoreResult>>
} {
  projectTagRecActiveClaims(item, resolve)
  const byGroup = new Map<string, Map<TagRecPoolKey, TagRecScoreResult>>()
  let best: TagRecScoreResult | undefined
  let params: TagRecScoreParams | undefined
  for (const key of tagRecChainKeysOf(item)) {
    for (const pool of tagRecPoolsForChain(item, key)) {
      if (item.eligiblePoolScopes && !item.eligiblePoolScopes.includes(tagRecPoolScopeKey(key, pool))) continue
      const candidate = resolve(key, pool).cfg.score
      const r = computeScore(item, candidate)
      const groupKey = tagRecGroupKey(key)
      let group = byGroup.get(groupKey)
      if (!group) byGroup.set(groupKey, (group = new Map()))
      group.set(pool, r)
      if (!best || (r.score !== undefined && (best.score === undefined || r.score > best.score))) {
        best = r
        params = candidate
      }
    }
  }
  const chosen = params ?? createTagRecFactoryScoreParams()
  return { params: chosen, result: best ?? computeScore(item, chosen), byGroup }
}

/** 逐链算分取 max (票01/05): 多归属条目按各认领组 (×所属池) 参数各算一遍取最高 */
export function computeTagRecItemScore(item: TagRecItemExtend, resolve: TagRecScopeResolve): TagRecScoreResult {
  return evalTagRecItemScores(item, resolve).result
}

/** 显式综合分门槛也约束选种；默认无门槛，多认领仍按任一允许链放行。 */
export function resolveTagRecSeedMinScore(item: TagRecItemExtend, resolve: TagRecScopeResolve): number {
  return Math.min(
    ...tagRecChainKeysOf(item).flatMap((key) =>
      tagRecPoolsForChain(item, key).map((pool) => {
        const { cfg } = resolve(key, pool)
        return cfg.enabled && cfg.dims.minScore.enabled ? Math.max(0, cfg.dims.minScore.value) : 0
      }),
    ),
  )
}

/** 兜底选种/堆排序与主队列共用同一组链参数，避免两条路径调参结果相反。 */
export function resolveTagRecItemScoreParams(item: TagRecItemExtend, resolve: TagRecScopeResolve): TagRecScoreParams {
  return evalTagRecItemScores(item, resolve).params
}

/**
 * scoreStage 聚合入口: 算分写回 item.score/partial => 排序 => (可选) diversityGuard。
 * 分数参数: resolve 提供则逐认领组链取 max (票01); 缺省按 via 池层求解 (票05, 组层不参与算分兜底)。
 * 返回 {items, deferred}: deferred = 护栏顺延计数 (横幅尾注消费, 不进滤除口径)。
 */
export function runTagRecScoreStage(
  items: TagRecItemExtend[],
  cfg: TagRecFilterCore,
  opts: {
    resolve?: TagRecScopeResolve
    diversityGuard?: TagRecDiversityGuardSettings
    sliceSize?: number
  } = {},
): { items: TagRecItemExtend[]; deferred: TagRecDeferredCounts } {
  if (opts.resolve) items = items.filter((item) => projectTagRecActiveClaims(item, opts.resolve!))
  // A5: 池层参数在本阶段内不变 —— mergeScorePatch 内含 cloneDeep, 逐条求解改按池记忆化 (≤4 池)
  const poolParams = new Map<TagRecPoolKey, TagRecScoreParams>()
  const poolParamsOf = (pool: TagRecPoolKey) => {
    let sp = poolParams.get(pool)
    if (!sp) poolParams.set(pool, (sp = resolvePoolScoreParams(cfg, pool)))
    return sp
  }
  // 复用设计 2: resolve 路径单条目一次 evalTagRecItemScores —— 总分/组内分/参数同出一遍链×池遍历
  const scoreEvalOf = opts.resolve ? (it: TagRecItemExtend) => evalTagRecItemScores(it, opts.resolve!) : undefined
  const groupScores = new Map<string, number[]>()
  const median = (values: number[]) => {
    values.sort((a, b) => a - b)
    return values.length
      ? (values[Math.floor(values.length / 2)] + values[Math.floor((values.length - 1) / 2)]) / 2
      : 50
  }
  for (const it of items) {
    const evald = scoreEvalOf?.(it)
    const r = evald?.result ?? computeScore(it, poolParamsOf(poolOfVia(it.source.via)))
    it.score = r.score
    it.partial = r.partial
    it.relevanceByGroup = {}
    it.qualityByGroup = {}
    for (const key of tagRecChainKeysOf(it)) {
      const groupKey = tagRecGroupKey(key)
      if (it.eligibleGroupKeys && !it.eligibleGroupKeys.includes(groupKey)) continue
      const pool_ = tagRecPoolsForChain(it, key).find(
        (pool) => !it.eligiblePoolScopes || it.eligiblePoolScopes.includes(tagRecPoolScopeKey(key, pool)),
      )
      const eff = opts.resolve?.(key, pool_ ?? poolOfVia(it.source.via))
      it.relevanceByGroup[groupKey] = eff?.combination
        ? { tier: 2, hits: evalTagRecCombination(it, eff.combination).hits }
        : tagRecRelevanceOf(it, eff?.queryEntries ?? [], key)
      const groupEval = evald?.byGroup.get(groupKey)
      const scoresByPool = groupEval
        ? [...groupEval.values()].flatMap((res) => (res.score === undefined ? [] : [res.score]))
        : []
      const score = opts.resolve ? (scoresByPool.length ? Math.max(...scoresByPool) : undefined) : r.score
      const scores = groupScores.get(groupKey) ?? []
      if (score !== undefined) {
        it.qualityByGroup[groupKey] = score
        scores.push(score)
      }
      groupScores.set(groupKey, scores)
    }
    it.relevance = Object.entries(it.relevanceByGroup)
      .filter(([key]) => !it.eligibleGroupKeys || it.eligibleGroupKeys.includes(key))
      .map(([, relevance]) => relevance)
      .sort(compareTagRecRelevance)[0]
  }
  const neutral = median(items.flatMap((it) => (it.score === undefined ? [] : [it.score])))
  const byGroup = new Map([...groupScores].map(([key, values]) => [key, median(values)]))
  for (const it of items) {
    it.qualitySortScore = it.score ?? neutral
    for (const key of Object.keys(it.relevanceByGroup!)) it.qualityByGroup![key] ??= byGroup.get(key)!
  }
  const sorted = sortTagRecItems(items)
  const guard = opts.diversityGuard
  if (guard && (guard.group.enabled || guard.up.enabled)) {
    return applyDiversityGuard(sorted, { sliceSize: opts.sliceSize, guard })
  }
  return { items: sorted, deferred: { group: 0, up: 0 } }
}
// #endregion

// #region 预设引擎 (spec §3.3: 整套覆盖 / 恢复出厂 / 自定义增删改名; 绑 settings 归票 07)
export function assignTagRecFilterCore(dst: TagRecFilterCore, src: TagRecFilterCore) {
  const c = cloneDeep(src)
  dst.enabled = c.enabled
  dst.strictMode = c.strictMode
  dst.smallPoolThreshold = c.smallPoolThreshold
  dst.dims = completeTagRecFilterDims(c.dims)
  dst.score = c.score ?? createTagRecFactoryScoreParams()
  dst.pools = c.pools
  dst.poolsEnabled = c.poolsEnabled
}

/** 深拷贝核心五字段 => 纯对象副本 (tab2 会话覆盖副本初值, spec §3.3 两层作用域) */
export function cloneTagRecFilterCore(src: TagRecFilterCore): TagRecFilterCore {
  const dst = createTagRecFactoryFilterCore()
  assignTagRecFilterCore(dst, src)
  return dst
}

/**
 * 按预设名整套覆盖到任意 core 绑定 (tab2 会话副本用, spec §3.3/§5.2):
 * 预设表恒存于全局 settings.tagRec.filter.presets, 此处只负责「选定名 => 写 core」
 */
export function applyTagRecPresetToCore(
  presets: readonly TagRecFilterPreset[],
  core: TagRecFilterCore,
  name: string,
): boolean {
  const p = presets.find((x) => x.name === name)
  if (!p) return false
  assignTagRecFilterCore(core, p.config)
  return true
}

/** 切预设 = 整套覆盖 + activePreset 跟随 */
export function applyTagRecPreset(filter: TagRecFilterSettings, name: string): boolean {
  const p = filter.presets.find((x) => x.name === name)
  if (!p) return false
  assignTagRecFilterCore(filter, p.config)
  filter.activePreset = name
  return true
}

/** 「恢复出厂」: 内置档 config 重置为出厂字面量 (自定义档不可恢复) */
export function restoreTagRecBuiltinPreset(filter: TagRecFilterSettings, name: string): boolean {
  const factory = createTagRecBuiltinPresets().find((p) => p.name === name)
  const target = filter.presets.find((p) => p.name === name)
  if (!factory || !target?.builtin) return false
  target.config = cloneDeep(factory.config)
  return true
}

/** 自定义增/改: name 冲突 = 覆盖 (改名请走 renameTagRecPreset) */
export function upsertTagRecPreset(filter: TagRecFilterSettings, preset: TagRecFilterPreset) {
  const snap: TagRecFilterPreset = {
    name: preset.name,
    builtin: preset.builtin ?? false,
    config: cloneDeep(preset.config),
  }
  const i = filter.presets.findIndex((p) => p.name === preset.name)
  if (i === -1) filter.presets.push(snap)
  else filter.presets[i] = snap
}

/** 删预设: 内置档拒删; 删中 activePreset => 置空 (语义=自定义态) */
export function removeTagRecPreset(filter: TagRecFilterSettings, name: string): boolean {
  const i = filter.presets.findIndex((p) => p.name === name)
  if (i === -1 || filter.presets[i].builtin) return false
  filter.presets.splice(i, 1)
  if (filter.activePreset === name) filter.activePreset = ''
  return true
}

/** 改名: 仅自定义档; 冲突/内置/空名 => false; activePreset 跟随 */
export function renameTagRecPreset(filter: TagRecFilterSettings, oldName: string, newName: string): boolean {
  const name = newName.trim()
  const p = filter.presets.find((x) => x.name === oldName)
  if (!p || p.builtin || !name || filter.presets.some((x) => x.name === name)) return false
  p.name = name
  if (filter.activePreset === oldName) filter.activePreset = name
  return true
}
// #endregion
