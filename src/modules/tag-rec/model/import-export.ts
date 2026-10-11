import { cloneDeep } from 'es-toolkit'
import {
  newTagRecCombination,
  tagRecCombinationSignature,
  tagRecConditionKey,
  validateTagRecCombination,
  type TagRecConditionAtom,
} from './combination'
import {
  groupNegativeTagIds,
  intersectCheck,
  makeTagGroup,
  makeTagL1Group,
  makeTagTheme,
  pickNewBlacklistEntries,
} from './favorites'
import {
  createTagRecBuiltinPresets,
  createTagRecFactoryDims,
  createTagRecFactoryFilterCore,
  createTagRecFactoryScoreParams,
  migrateLegacyPartitionId,
  type TagRecDimsPatch,
  type TagRecFilterCore,
  type TagRecFilterDims,
  type TagRecFilterPreset,
  type TagRecFilterSettings,
  type TagRecGroupOverrides,
  type TagRecL1Overrides,
  type TagRecScopeOverride,
  type TagRecScoreAnchors,
  type TagRecScoreParams,
  type TagRecScorePatch,
  type TagRecScoreWeights,
} from './filter-engine'
import { normalizeTagName } from './tag-norm'
import type {
  TagBlacklistEntry,
  TagGroup,
  TagIdEntry,
  TagL1Group,
  TagRecPartitionEntry,
  TagRecPoolKey,
  TagTheme,
} from './types'

/**
 * [tag-rec] 导入导出纯逻辑 (spec §6) —— 零 IO 叶子模块 (除 favorites 纯函数), 可测
 *
 * JSON (§6.1 「我的配置」打包):
 *   出方向 {version:1, themes, activeThemeId, l1, favorites, blacklist, filterConfig}
 *   —— themes = 主题节 (票 26, l1.themeId 的解析源); filterConfig = tagRec.filter 整套快照
 *   (含自定义 presets; seen-set 与沉淀池不进导出, 观察缓存可重采; blacklist = 休眠旧黑名单存档, 票 14)
 *   l1 节 = 一级组容器 (票 17): 组 l1Id 指回节内 id; 旧版导出无 l1 节 => 导入照常, 组靠 store auto-wrap 兜底
 *   入方向 逐件校验 + 与既有收藏表 intersectCheck 交集查重 —— 跨组重复合法后降为信息上报
 *   (照常入表, overlappedGroups 报「也存在于组 X」), 票 14; 组可携 negative_tag_ids/negative_strict
 *   + filterConfig 由调用侧整体覆盖 settings.tagRec.filter (含 presets, 裁量见 planTagRecImport 注)
 *   兼容位: filterConfig 缺省键 (随票演进新增 dims) 填出厂值不拒档; 历史导出缺 themes 节且 l1
 *   携悬挂 themeId 时, plan 按首个引用 L1 名合成主题兜底 —— 老档反复导出后归属不丢 (票 46)
 *
 * CSV (§6.2):
 *   出方向 = 收藏表名单, 列 name,tag_id,weight,enabled,note,neg_tag_id; 多 id 列 `;` 连 (可回导)
 *   入方向 = 行模型 {原始名, tagIds?, checked} + 状态机 resolved/待解析/与组X重复(信息徽标, 不拦截);
 *   网络解析(fetchTagInfoByName/ById)在 modal 侧, 解析结果经 applyCsvRowResolution 落地
 */

// #region JSON (§6.1)
/** v2 (filter-scope 票11): 组/L1 携 overrides (名单容器+格槽); dims 新形 (stat±/descKeywords/分区条目/pubdate token)。
 *  读 {1,2} —— v1 差异键全部由归一层迁移 (partition number[]→条目, pubdate withinDays/since→win/days/from);
 *  写恒 2 —— 旧版读者拿到明确「不支持版本」报错, 好过半静默丢 overrides */
export const TAG_REC_EXPORT_VERSION = 3
const TAG_REC_READ_VERSIONS = new Set([1, 2, TAG_REC_EXPORT_VERSION])

export type TagRecConfigExportV1 = {
  combinationExclusions?: TagRecConditionAtom[]
  version: number // 普通标签配置写 v2，完整组合/全局字段排除写 v3；读 v1/v2/v3。
  l1: TagL1Group[] // 一级组节 (票 17); 入方向旧版文件缺省 => 解析归一为 []
  /** 主题节 (票 26): l1.themeId 的解析源; 旧版导出缺省 => [], 悬挂 themeId 由 plan 合成兜底 */
  themes?: TagTheme[]
  /** 当前生效主题快照; null = 「全部」档; 缺省 = 旧版文件 => 导入不动当前主题 */
  activeThemeId?: string | null
  favorites: TagGroup[]
  blacklist: TagBlacklistEntry[]
  filterConfig: TagRecFilterSettings
}

/** 序列化打包 (纯函数): 深拷贝脱离 valtio proxy, 不引用原对象; themes/activeThemeId 随包落盘防 themeId 悬挂 */
export function serializeTagRecConfig(input: {
  combinationExclusions?: readonly TagRecConditionAtom[]
  l1: readonly TagL1Group[]
  favorites: readonly TagGroup[]
  blacklist: readonly TagBlacklistEntry[]
  filterConfig: TagRecFilterSettings
  themes?: readonly TagTheme[]
  activeThemeId?: string | null
}): TagRecConfigExportV1 {
  return {
    ...(input.combinationExclusions?.length
      ? { combinationExclusions: cloneDeep([...input.combinationExclusions]) }
      : {}),
    version:
      input.combinationExclusions?.length || input.favorites.some((group) => group.combination)
        ? TAG_REC_EXPORT_VERSION
        : 2,
    l1: input.l1.map((l) => ({ ...l, ...(l.overrides && { overrides: cloneDeep(l.overrides) }) })),
    themes: (input.themes ?? []).map((t) => ({ ...t })),
    activeThemeId: input.activeThemeId ?? null,
    favorites: input.favorites.map((g) => ({
      ...g,
      tag_ids: g.tag_ids.map((e) => ({ ...e })),
      ...(g.negative_tag_ids && { negative_tag_ids: g.negative_tag_ids.map((e) => ({ ...e })) }),
      ...(g.overrides && { overrides: cloneDeep(g.overrides) }),
      ...(g.combination && { combination: cloneDeep(g.combination) }),
    })),
    blacklist: input.blacklist.map((e) => ({ ...e })),
    filterConfig: cloneDeep(input.filterConfig), // valtio proxy 脱壳: cloneDeep 穿透读值产出 plain object
  }
}

export function stringifyTagRecConfig(data: TagRecConfigExportV1): string {
  return JSON.stringify(data, null, 2)
}

export type ParseTagRecConfigResult = { ok: true; data: TagRecConfigExportV1 } | { ok: false; reason: string }

/**
 * W3-5: 本地导入体量闸 —— 上传分享有 SHARE_GUARD_LIMITS (worker 同口径), 本地文件/粘贴路径零闸:
 *   超大文本 = JSON.parse 全量驻内存 + 逐条校验主线程长阻; 条数档防「十万组」级变形件
 */
export const IMPORT_TEXT_MAX_LEN = 4 * 1024 * 1024 // 字符上界 (≈4MB ASCII / 2M CJK)
export const IMPORT_MAX_ROWS = 50_000 // CSV 行数档
export const IMPORT_MAX_GROUPS = 2_000 // JSON favorites/l1/themes/blacklist 各节条数档 (本地宽于服务端上限)

/** 入方向逐件校验 (§6.1): version 在 => 逐件结构校验; 拦截一切坏数据 (不解析的结构错误 => reason) */
export function parseTagRecConfig(text: string): ParseTagRecConfigResult {
  if (text.length > IMPORT_TEXT_MAX_LEN) {
    return { ok: false, reason: `文件过大 (${text.length} 字符, 上限 ${IMPORT_TEXT_MAX_LEN})` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: '文件内容无法解析为 JSON' }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: '不是有效的配置文件 (顶层须为对象)' }
  }
  const v = json as Record<string, unknown>
  // 缺失、非数或不支持的版本拒绝；v1 差异键走归一层迁移。
  if (typeof v.version !== 'number') return { ok: false, reason: '缺少 version 字段' }
  if (!TAG_REC_READ_VERSIONS.has(v.version)) {
    return { ok: false, reason: `不支持的配置版本 v${v.version} (当前支持 v${TAG_REC_EXPORT_VERSION})` }
  }
  if (v.combinationExclusions !== undefined) {
    const combination = newTagRecCombination()
    combination.exclude = v.combinationExclusions as TagRecConditionAtom[]
    if (v.version < 3 || !validateTagRecCombination(combination))
      return { ok: false, reason: '全局组合排除条件不兼容或不完整' }
  }
  // l1 节 (票 17): 缺省 = 旧版导出照常过 (归一为 [], 组落地 auto-wrap 兜底); 存在则须结构合法
  if (v.l1 !== undefined && !validateTagL1Groups(v.l1)) return { ok: false, reason: 'l1 结构不合法' }
  // themes 节 (票 26): 缺省 = 主题实体未随包 (历史导出), 悬挂 themeId 由 plan 合成兜底
  if (v.themes !== undefined && !validateTagThemes(v.themes)) return { ok: false, reason: 'themes 结构不合法' }
  if (v.activeThemeId !== undefined && v.activeThemeId !== null && !isStr(v.activeThemeId)) {
    return { ok: false, reason: 'activeThemeId 结构不合法' }
  }
  if (v.version < 3 && Array.isArray(v.favorites) && v.favorites.some((g) => isObj(g) && g.combination !== undefined))
    return { ok: false, reason: '完整组合条件须使用 v3 格式，不能作为旧版标签组导入' }
  if (!validateTagGroups(v.favorites)) return { ok: false, reason: 'favorites 结构不合法' }
  if (!validateTagBlacklist(v.blacklist)) return { ok: false, reason: 'blacklist 结构不合法' }
  // W3-5 条数档 (校验过后再数, 此时已确证是数组)
  const oversized = [v.favorites, v.l1, v.themes, v.blacklist].some(
    (a) => Array.isArray(a) && a.length > IMPORT_MAX_GROUPS,
  )
  if (oversized) return { ok: false, reason: `条目数超过上限 ${IMPORT_MAX_GROUPS}` }
  // filterConfig 走宽容归一 (schema 随票演进加过 dims 键): 缺省键填出厂值, 存在但畸形仍拒
  const filterConfig = normalizeTagRecFilterSettings(v.filterConfig)
  if (!filterConfig) return { ok: false, reason: 'filterConfig 结构不合法' }
  return {
    ok: true,
    data: {
      version: v.version,
      ...(v.combinationExclusions !== undefined
        ? { combinationExclusions: v.combinationExclusions as TagRecConditionAtom[] }
        : {}),
      l1: v.l1 ?? [],
      themes: v.themes ?? [],
      activeThemeId: v.activeThemeId,
      favorites: v.favorites,
      blacklist: v.blacklist,
      filterConfig,
    },
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
/** upBlacklist.list 条目守卫 (命名型谓词: every 收窄数组元素类型, normalize 输出直接复用) */
const isUpBlacklistEntry = (e: unknown): e is { name: string; mid?: number } =>
  isObj(e) && isStr(e.name) && (e.mid === undefined || (isNum(e.mid) && Number.isInteger(e.mid)))

const TAG_ID_ENTRY_TYPES = new Set<NonNullable<TagIdEntry['tag_type']>>(['topic', 'old_channel', 'bgm'])

export function validateTagIdEntry(v: unknown): v is TagIdEntry {
  if (!isObj(v)) return false
  if (!isNum(v.id) || v.id <= 0 || !Number.isInteger(v.id)) return false
  if (!isStr(v.name) || !v.name.trim()) return false
  if (v.tag_type !== undefined && !TAG_ID_ENTRY_TYPES.has(v.tag_type as NonNullable<TagIdEntry['tag_type']>))
    return false
  return true
}

/** overrides.negative 名单容器校验 (v2): 各键缺席合法, 存在须同型; 负向池 id 表走 validateTagIdEntry */
function validateNegativeRules(v: unknown): boolean {
  if (!isObj(v)) return false
  if (v.tagIds !== undefined && !(Array.isArray(v.tagIds) && v.tagIds.every(validateTagIdEntry))) return false
  if (v.strict !== undefined && !isBool(v.strict)) return false
  for (const key of ['tagBlock', 'tagAllow'] as const) {
    const rule = v[key]
    if (rule === undefined) continue
    if (
      !isObj(rule) ||
      !isBool(rule.enabled) ||
      (rule.strict !== undefined && !isBool(rule.strict)) ||
      !Array.isArray(rule.list) ||
      !rule.list.every(validateTagIdEntry)
    )
      return false
  }
  // R8 迁移期宽容 (站点 R6 旧编辑器形状; 读侧 coerceTagRecNegativeShapes 收敛为规范形):
  //   up 允许字符串条目 / partitionBlock 允许 {enabled,list} 包装 / 分区条目允许字符串名 (表解析不到读侧丢弃)
  if (v.up !== undefined && !(Array.isArray(v.up) && v.up.every((e) => isUpBlacklistEntry(e) || isStr(e)))) return false
  if (v.title !== undefined && !(Array.isArray(v.title) && v.title.every(isStr))) return false
  if (v.desc !== undefined && !(Array.isArray(v.desc) && v.desc.every(isStr))) return false
  // 分区双池 (拆池实修): 新键 partitionBlock:Entry[] / partitionAllow:{enabled,list};
  //   旧形 partition{mode,list} 兼容收 (读期 groupNegativeMerged 折叠), v2 跨版本导出可能仍携旧键
  if (v.partition !== undefined) {
    const p = v.partition
    if (!isObj(p) || (p.mode !== 'block' && p.mode !== 'allow')) return false
    if (!Array.isArray(p.list) || !p.list.every(isPartitionEntry)) return false
  }
  const isPartitionEntryLoose = (e: unknown) => isPartitionEntry(e) || isStr(e)
  if (v.partitionBlock !== undefined) {
    const pb = v.partitionBlock
    const list = Array.isArray(pb) ? pb : isObj(pb) && Array.isArray(pb.list) ? pb.list : undefined
    if (!list || !list.every(isPartitionEntryLoose)) return false
  }
  if (v.partitionAllow !== undefined) {
    const p = v.partitionAllow
    if (!isObj(p) || !isBool(p.enabled) || !Array.isArray(p.list) || !p.list.every(isPartitionEntryLoose)) return false
  }
  // R8 仅看家族 (组/L1 容器)
  if (v.upAllow !== undefined) {
    const a = v.upAllow
    if (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(isUpBlacklistEntry)) return false
  }
  for (const k of ['titleAllow', 'descAllow'] as const) {
    const a = v[k]
    if (a !== undefined && (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(isStr)))
      return false
  }
  return true
}

/** 分区条目守卫 (票03): {name, v1?, v2?} —— 双体系 id 允许单边空, 但不可皆无 */
const isPartitionEntry = (e: unknown): e is TagRecPartitionEntry =>
  isObj(e) &&
  isStr(e.name) &&
  (e.level === undefined || e.level === 'parent' || e.level === 'leaf') &&
  (e.v1 === undefined || (isNum(e.v1) && Number.isInteger(e.v1))) &&
  (e.v2 === undefined || (isNum(e.v2) && Number.isInteger(e.v2))) &&
  (e.v1 !== undefined || e.v2 !== undefined)

/** overrides 浅校验 (票11): 整体须对象; negative 子节须过名单容器校验; dims/score/pools 深层键由归一/load 兜底 */
function validateOverridesShape(v: unknown, poolsAllowed: boolean): boolean {
  if (!isObj(v)) return false
  if (v.negative !== undefined && !validateNegativeRules(v.negative)) return false
  if (v.dims !== undefined && !isObj(v.dims)) return false
  if (v.score !== undefined && !isObj(v.score)) return false
  if (v.smallPoolThreshold !== undefined && !isNum(v.smallPoolThreshold)) return false
  if (!poolsAllowed && v.pools !== undefined) return false // L1 无格槽
  if (poolsAllowed && v.pools !== undefined) {
    if (!isObj(v.pools)) return false
    for (const slot of Object.values(v.pools)) {
      if (slot === undefined) continue
      if (!isObj(slot)) return false
      if ((slot as Record<string, unknown>).negative !== undefined) return false // 格槽不持名单
    }
  }
  return true
}

export function validateTagGroup(v: unknown): v is TagGroup {
  if (!isObj(v)) return false
  if (!isStr(v.id) || !v.id) return false
  if (!isStr(v.name)) return false
  if (v.l1Id !== undefined && !isStr(v.l1Id)) return false // 一级组归属 (票 17; 悬挂引用由 plan 裁决)
  if (!Array.isArray(v.tag_ids) || !v.tag_ids.every(validateTagIdEntry)) return false
  if (!v.tag_ids.length && !v.name.trim()) return false
  if (
    v.negative_tag_ids !== undefined &&
    !(Array.isArray(v.negative_tag_ids) && v.negative_tag_ids.every(validateTagIdEntry))
  )
    return false
  if (v.negative_strict !== undefined && !isBool(v.negative_strict)) return false
  if (v.overrides !== undefined && !validateOverridesShape(v.overrides, true)) return false // v2 组级配置位
  if (v.combination !== undefined && !validateTagRecCombination(v.combination)) return false
  if (!isNum(v.weight)) return false
  // enabled 缺省合法 (分享包剥键: 开关位=上传方视图态不进包); plan 期 makeTagGroup `?? true` 回填
  if (v.enabled !== undefined && !isBool(v.enabled)) return false
  if (!isNum(v.addedAt)) return false
  if (v.note !== undefined && !isStr(v.note)) return false
  return true
}

export function validateTagGroups(v: unknown): v is TagGroup[] {
  return Array.isArray(v) && v.every(validateTagGroup)
}

/** 一级组校验 (票 17): 结构同 store 落盘 shape; name 空串拒 (makeTagL1Group 同款判据, 防坏档直入) */
export function validateTagL1Group(v: unknown): v is TagL1Group {
  if (!isObj(v)) return false
  if (!isStr(v.id) || !v.id) return false
  if (!isStr(v.name) || !v.name.trim()) return false
  if (v.themeId !== undefined && !isStr(v.themeId)) return false // 主题归属 (票 26; 悬挂引用由 plan 合成兜底)
  // enabled 缺省合法 (同 L2 剥键口径); plan 期 makeTagL1Group `?? false` 回填 (新建默认不入池)
  if (v.enabled !== undefined && !isBool(v.enabled)) return false
  if (!isNum(v.weight)) return false
  if (v.overrides !== undefined && !validateOverridesShape(v.overrides, false)) return false // v2 L1 无格槽
  if (v.note !== undefined && !isStr(v.note)) return false
  if (!isNum(v.addedAt)) return false
  return true
}

export function validateTagL1Groups(v: unknown): v is TagL1Group[] {
  return Array.isArray(v) && v.every(validateTagL1Group)
}

/** 主题校验 (票 26): 结构同 store 落盘 shape; name 空串拒 (makeTagTheme 同款判据) */
export function validateTagTheme(v: unknown): v is TagTheme {
  if (!isObj(v)) return false
  if (!isStr(v.id) || !v.id) return false
  if (!isStr(v.name) || !v.name.trim()) return false
  if (!isNum(v.addedAt)) return false
  return true
}

export function validateTagThemes(v: unknown): v is TagTheme[] {
  return Array.isArray(v) && v.every(validateTagTheme)
}

export function validateTagBlacklist(v: unknown): v is TagBlacklistEntry[] {
  return (
    Array.isArray(v) && v.every((e) => isObj(e) && isNum(e.id) && Number.isInteger(e.id) && e.id > 0 && isStr(e.name))
  )
}

// #region filterConfig 结构校验 (TagRecFilterSettings = core + activePreset + presets)
/** {enabled,value} 标量维全集 (v2: view± + stat 七项± + 比率五 + minScore) */
const VALUE_DIM_KEYS = [
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
  'minScore',
] as const satisfies readonly (keyof TagRecFilterDims)[]
const SCORE_COMPONENT_KEYS = ['view', 'likeRate', 'favRate', 'coinRate', 'interactRate'] as const
const PUBDATE_WINS = new Set(['today', 'd7', 'd30', 'd180', 'days', 'range'])
const POOL_KEYS = new Set(['tagTop', 'allV2', 'allV2Related', 'archiveRelated'])

function validateTagRecFilterCore(v: unknown): boolean {
  if (!isObj(v)) return false
  if (!isBool(v.enabled) || !isBool(v.strictMode) || !isNum(v.smallPoolThreshold)) return false
  if (!validateTagRecFilterDims(v.dims)) return false
  // R8 池筛选: 稀疏布尔记录 (值须布尔; 未知键交归一丢弃, 与 dims 宽容口径一致)
  if (v.poolsEnabled !== undefined) {
    if (!isObj(v.poolsEnabled)) return false
    for (const b of Object.values(v.poolsEnabled)) {
      if (!isBool(b)) return false
    }
  }
  const score = v.score
  if (!isObj(score) || !isObj(score.weights) || !isObj(score.anchors)) return false
  for (const k of SCORE_COMPONENT_KEYS) {
    if (!isNum(score.weights[k])) return false
  }
  if (!isNum(score.anchors.viewLog10)) return false
  for (const k of SCORE_COMPONENT_KEYS.slice(1)) {
    if (!isNum(score.anchors[k])) return false
  }
  return true
}

function validateTagRecFilterDims(dims: unknown): dims is TagRecFilterDims {
  if (!isObj(dims)) return false
  const isValueDim = (v: unknown) => isObj(v) && isBool(v.enabled) && isNum(v.value)
  for (const k of VALUE_DIM_KEYS) {
    if (!isValueDim(dims[k])) return false
  }
  const duration = dims.duration
  if (!isObj(duration) || !isBool(duration.enabled) || !isNum(duration.min) || !isNum(duration.max)) return false
  const pubdate = dims.pubdate
  if (!isObj(pubdate) || !isBool(pubdate.enabled)) return false
  if (pubdate.win !== undefined && !PUBDATE_WINS.has(pubdate.win as string)) return false
  for (const k of ['days', 'from', 'to'] as const) {
    if (pubdate[k] !== undefined && !isNum(pubdate[k])) return false
  }
  if (pubdate.tod !== undefined && !isObj(pubdate.tod)) return false
  const upBlacklist = dims.upBlacklist
  if (
    !isObj(upBlacklist) ||
    !isBool(upBlacklist.enabled) ||
    !Array.isArray(upBlacklist.list) ||
    !upBlacklist.list.every(isUpBlacklistEntry)
  )
    return false
  const descKeywords = dims.descKeywords
  if (
    !isObj(descKeywords) ||
    !isBool(descKeywords.enabled) ||
    !Array.isArray(descKeywords.list) ||
    !descKeywords.list.every(isStr)
  )
    return false
  // 分区双池 (拆池实修): {enabled,list} 两维各自校验; 旧形 partition{mode,list} 在时仍严校 (v2 跨版本档可携)
  for (const k of ['partitionBlock', 'partitionAllow'] as const) {
    const p = dims[k]
    if (!isObj(p) || !isBool(p.enabled) || !Array.isArray(p.list) || !p.list.every(isPartitionEntry)) return false
  }
  const legacyPartition = dims.partition
  if (
    legacyPartition !== undefined &&
    (!isObj(legacyPartition) ||
      !isBool(legacyPartition.enabled) ||
      (legacyPartition.mode !== 'block' && legacyPartition.mode !== 'allow') ||
      !Array.isArray(legacyPartition.list) ||
      !legacyPartition.list.every(isPartitionEntry))
  )
    return false
  const titleKeywords = dims.titleKeywords
  if (
    !isObj(titleKeywords) ||
    !isBool(titleKeywords.enabled) ||
    !Array.isArray(titleKeywords.list) ||
    !titleKeywords.list.every(isStr)
  )
    return false
  // R8 仅看家族 (全局 dims)
  const upAllow = dims.upAllow
  if (
    !isObj(upAllow) ||
    !isBool(upAllow.enabled) ||
    !Array.isArray(upAllow.list) ||
    !upAllow.list.every(isUpBlacklistEntry)
  )
    return false
  for (const k of ['titleAllow', 'descAllow'] as const) {
    const a = dims[k]
    if (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(isStr)) return false
  }
  for (const k of ['tagBlock', 'tagAllow'] as const) {
    const a = dims[k]
    if (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(validateTagIdEntry)) return false
    if (a.strict !== undefined && !isBool(a.strict)) return false
  }
  return true
}

export function validateTagRecFilterSettings(v: unknown): v is TagRecFilterSettings {
  if (!validateTagRecFilterCore(v)) return false
  const s = v as Record<string, unknown>
  if (!isStr(s.activePreset)) return false
  if (!Array.isArray(s.presets)) return false
  return s.presets.every((p) => isObj(p) && isStr(p.name) && validateTagRecFilterCore(p.config))
}

// #region filterConfig 宽容归一 (历史导出兼容位): schema 随票演进加过 dims 键 (upBlacklist/partition/titleKeywords),
// 旧档缺键不该整文件拒 —— 缺省键填出厂值 (各维 enabled:false = 不加过滤, 语义最安全); 存在但畸形仍拒
const SCORE_ANCHOR_KEYS = ['viewLog10', 'likeRate', 'favRate', 'coinRate', 'interactRate'] as const

/**
 * 缺省键逐键填出厂 (dims 整体缺失/为空亦可); 存在但结构畸形 => undefined (拒)。
 * v1→v2 迁移点:
 * - pubdate {withinDays>0 → win:'days'+days; since>0 → from} (新形 token 一等公民, 票04)
 * - partition.list number[] → 条目 {name:'#N', v1:N, v2:N} (旧语义 tid∪tidv2 扁平等值, 双键恰好等价还原)
 * - 新增维 (stat±/descKeywords) 缺席 => 出厂 enabled:false (不加过滤, 语义最安全)
 */
function normalizeTagRecFilterDims(dims: unknown): TagRecFilterDims | undefined {
  const factory = createTagRecFactoryDims()
  if (dims === undefined) return factory
  if (!isObj(dims)) return undefined
  const isValueDim = (v: unknown): v is { enabled: boolean; value: number } =>
    isObj(v) && isBool(v.enabled) && isNum(v.value)
  const out = cloneDeep(factory)
  for (const k of VALUE_DIM_KEYS) {
    const src = dims[k] === undefined ? factory[k] : dims[k]
    if (!isValueDim(src)) return undefined
    ;(out[k] as { enabled: boolean; value: number }) = { enabled: src.enabled, value: src.value }
  }
  const duration = dims.duration === undefined ? factory.duration : dims.duration
  if (!isObj(duration) || !isBool(duration.enabled) || !isNum(duration.min) || !isNum(duration.max)) return undefined
  out.duration = { enabled: duration.enabled, min: duration.min, max: duration.max }

  const pubdate = dims.pubdate === undefined ? factory.pubdate : dims.pubdate
  if (!isObj(pubdate) || !isBool(pubdate.enabled)) return undefined
  const pd: TagRecFilterDims['pubdate'] = { enabled: pubdate.enabled }
  if (pubdate.win !== undefined) {
    if (!PUBDATE_WINS.has(pubdate.win as string)) return undefined
    pd.win = pubdate.win as NonNullable<typeof pd.win>
  }
  for (const k of ['days', 'from', 'to'] as const) {
    if (pubdate[k] !== undefined) {
      if (!isNum(pubdate[k])) return undefined
      pd[k] = pubdate[k]
    }
  }
  if (pubdate.tod !== undefined) {
    const t = pubdate.tod
    if (!isObj(t)) return undefined
    if (t.from !== undefined && !isNum(t.from)) return undefined
    if (t.to !== undefined && !isNum(t.to)) return undefined
    pd.tod = { from: t.from as number | undefined, to: t.to as number | undefined }
  }
  // v1 形迁移: withinDays/since 数值键 (新形缺席时)
  if (pd.win === undefined && isNum(pubdate.withinDays) && pubdate.withinDays > 0) {
    pd.win = 'days'
    pd.days = pubdate.withinDays
  }
  if (pd.from === undefined && isNum(pubdate.since) && pubdate.since > 0) pd.from = pubdate.since
  out.pubdate = pd

  const upBlacklist = dims.upBlacklist === undefined ? factory.upBlacklist : dims.upBlacklist
  if (
    !isObj(upBlacklist) ||
    !isBool(upBlacklist.enabled) ||
    !Array.isArray(upBlacklist.list) ||
    !upBlacklist.list.every(isUpBlacklistEntry)
  )
    return undefined
  out.upBlacklist = { enabled: upBlacklist.enabled, list: upBlacklist.list.map((e) => ({ ...e })) }

  const descKeywords = dims.descKeywords === undefined ? factory.descKeywords : dims.descKeywords
  if (
    !isObj(descKeywords) ||
    !isBool(descKeywords.enabled) ||
    !Array.isArray(descKeywords.list) ||
    !descKeywords.list.every(isStr)
  )
    return undefined
  // W1-3: 归一化后 <2 字符的词归一时丢弃 (eval 侧 scopedSubstringHit 亦兜底; 单字符词 includes 必中 = 静默灭池)
  out.descKeywords = {
    enabled: descKeywords.enabled,
    list: descKeywords.list.filter((w) => normalizeTagName(w).length >= 2),
  }

  // 分区双池 (拆池实修): 旧形 partition{enabled,mode,list} => 按 mode 拆 partitionBlock/partitionAllow;
  //   新键 {enabled,list} 各自归一; 条目 number 档迁移 tid∪tidv2 扁平等值语义保持
  const normPartitionList = (list: unknown): TagRecPartitionEntry[] | undefined => {
    if (!Array.isArray(list)) return undefined
    const out: TagRecPartitionEntry[] = []
    for (const e of list) {
      if (isPartitionEntry(e)) out.push({ name: e.name, v1: e.v1, v2: e.v2, ...(e.level ? { level: e.level } : {}) })
      else if (isNum(e) && Number.isInteger(e) && e > 0) out.push(migrateLegacyPartitionId(e)) // R3-05: pid 段保死值
      else return undefined
    }
    return out
  }
  for (const k of ['partitionBlock', 'partitionAllow'] as const) {
    const src = dims[k] === undefined ? factory[k] : dims[k]
    if (!isObj(src) || !isBool(src.enabled)) return undefined
    const list = normPartitionList(src.list)
    if (list === undefined) return undefined
    out[k] = { enabled: src.enabled, list }
  }
  const legacyPartition = dims.partition // v1/v2-早期单列表+mode 形
  if (legacyPartition !== undefined) {
    if (
      !isObj(legacyPartition) ||
      !isBool(legacyPartition.enabled) ||
      (legacyPartition.mode !== 'block' && legacyPartition.mode !== 'allow')
    )
      return undefined
    const plist = normPartitionList(legacyPartition.list)
    if (plist === undefined) return undefined
    if (legacyPartition.mode === 'allow') {
      out.partitionAllow = { enabled: legacyPartition.enabled, list: [...out.partitionAllow.list, ...plist] }
    } else {
      out.partitionBlock = { enabled: legacyPartition.enabled, list: [...out.partitionBlock.list, ...plist] }
    }
  }

  const titleKeywords = dims.titleKeywords === undefined ? factory.titleKeywords : dims.titleKeywords
  if (
    !isObj(titleKeywords) ||
    !isBool(titleKeywords.enabled) ||
    !Array.isArray(titleKeywords.list) ||
    !titleKeywords.list.every(isStr)
  )
    return undefined
  out.titleKeywords = {
    enabled: titleKeywords.enabled,
    list: titleKeywords.list.filter((w) => normalizeTagName(w).length >= 2),
  }

  // R8 仅看家族 (缺键=出厂空; 词表 <2 字符丢弃同屏蔽侧口径)
  const upAllow = dims.upAllow === undefined ? factory.upAllow : dims.upAllow
  if (
    !isObj(upAllow) ||
    !isBool(upAllow.enabled) ||
    !Array.isArray(upAllow.list) ||
    !upAllow.list.every(isUpBlacklistEntry)
  )
    return undefined
  out.upAllow = { enabled: upAllow.enabled, list: upAllow.list.map((e) => ({ ...e })) }
  for (const k of ['titleAllow', 'descAllow'] as const) {
    const a = dims[k] === undefined ? factory[k] : dims[k]
    if (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(isStr)) return undefined
    out[k] = { enabled: a.enabled, list: a.list.filter((w) => normalizeTagName(w).length >= 2) }
  }
  for (const k of ['tagBlock', 'tagAllow'] as const) {
    const a = dims[k] === undefined ? factory[k] : dims[k]
    if (!isObj(a) || !isBool(a.enabled) || !Array.isArray(a.list) || !a.list.every(validateTagIdEntry)) return undefined
    if (a.strict !== undefined && !isBool(a.strict)) return undefined
    out[k] = {
      enabled: a.enabled,
      strict: a.strict === true,
      list: [...new Map(a.list.map((e) => [e.id, { ...e }])).values()],
    }
  }
  return out
}

/** dims patch 可写键 = dims 全集减名单四维 (名单走 negative 容器, patch 不接) */
const DIMS_PATCH_KEYS = new Set(Object.keys(createTagRecFactoryDims()))
for (const k of [
  'upBlacklist',
  'descKeywords',
  'partitionBlock',
  'partitionAllow',
  'titleKeywords',
  'tagBlock',
  'tagAllow',
])
  DIMS_PATCH_KEYS.delete(k)

/**
 * dims patch 单值消毒 (R3-04): patch 粒度=整 dim 对象 —— 单值形不符整键弃之 (回继承不拒档)。
 * 原实现值原样穿透 (`as never`), 畸形深层值 (pubdate.win={} / viewMin.value='x') 经 mergeDimsPatch
 * 直达求值器致崩/NaN; 值域逐键白名单在 merge 前截断。
 */
const normalizeDimsPatchValue = (k: string, v: unknown): unknown => {
  if ((VALUE_DIM_KEYS as readonly string[]).includes(k)) {
    return isObj(v) && isBool(v.enabled) && isNum(v.value) ? { enabled: v.enabled, value: v.value } : undefined
  }
  if (k === 'duration') {
    return isObj(v) && isBool(v.enabled) && isNum(v.min) && isNum(v.max)
      ? { enabled: v.enabled, min: v.min, max: v.max }
      : undefined
  }
  // k === 'pubdate' (DIMS_PATCH_KEYS 余下唯一非标量维键; 名单五维结构性不在 patch)
  if (!isObj(v) || !isBool(v.enabled)) return undefined
  const pd: NonNullable<TagRecDimsPatch['pubdate']> = { enabled: v.enabled }
  if (v.win !== undefined) {
    if (!PUBDATE_WINS.has(v.win as string)) return undefined
    pd.win = v.win as NonNullable<typeof pd.win>
  }
  for (const f of ['days', 'from', 'to'] as const) {
    if (v[f] === undefined) continue
    if (!isNum(v[f])) return undefined
    pd[f] = v[f]
  }
  if (v.tod !== undefined) {
    const t = v.tod
    if (!isObj(t) || (t.from !== undefined && !isNum(t.from)) || (t.to !== undefined && !isNum(t.to))) {
      return undefined
    }
    pd.tod = { from: t.from as number | undefined, to: t.to as number | undefined }
  }
  return pd
}

/** settings 的可选日期字段与导入共用同一读取校验。 */
export function normalizeTagRecPubdate(v: unknown): TagRecFilterDims['pubdate'] | undefined {
  return normalizeDimsPatchValue('pubdate', v) as TagRecFilterDims['pubdate'] | undefined
}

/**
 * scope override (组/L1/池槽同款 patch 形) 宽容归一: dims 逐键半格, score 半格; 畸形键弃之不拒 (稀疏结构无整档风险)。
 * R3-04: score 半格逐键白名单只收数值 —— 原 `{...v.score.weights}` 浅拷会把 'x'/异物键穿进 mergeScorePatch。
 */
function normalizeTagRecScopeOverride(v: unknown): TagRecScopeOverride | undefined {
  if (!isObj(v)) return undefined
  const out: TagRecScopeOverride = {}
  if (isObj(v.dims)) {
    const dims: TagRecDimsPatch = {}
    for (const [k, val] of Object.entries(v.dims)) {
      if (!DIMS_PATCH_KEYS.has(k) || val === undefined) continue
      const nv = normalizeDimsPatchValue(k, val)
      if (nv !== undefined) dims[k as keyof TagRecDimsPatch] = nv as never
    }
    if (Object.keys(dims).length) out.dims = dims
  }
  if (isObj(v.score)) {
    const score: TagRecScorePatch = {}
    if (isObj(v.score.weights)) {
      const w: Partial<TagRecScoreWeights> = {}
      for (const k of SCORE_COMPONENT_KEYS) {
        const val = v.score.weights[k]
        if (isNum(val)) w[k] = val
      }
      if (Object.keys(w).length) score.weights = w
    }
    if (isObj(v.score.anchors)) {
      const a: Partial<TagRecScoreAnchors> = {}
      for (const k of SCORE_ANCHOR_KEYS) {
        const val = v.score.anchors[k]
        if (isNum(val)) a[k] = val
      }
      if (Object.keys(a).length) score.anchors = a
    }
    if (score.weights || score.anchors) out.score = score
  }
  if (isNum(v.smallPoolThreshold)) out.smallPoolThreshold = v.smallPoolThreshold
  return out
}

/** pools 槽归一: 池键白名单 + 槽内 patch; 畸形槽弃之 (缺槽=全继承)。settings GM 读回嫁接复用 (R3-02) */
export function normalizeTagRecPools(v: unknown): TagRecFilterCore['pools'] | undefined {
  if (v === undefined) return undefined
  if (!isObj(v)) return undefined // 畸形 => 弃槽不拒档
  const out: NonNullable<TagRecFilterCore['pools']> = {}
  for (const [k, slot] of Object.entries(v)) {
    if (!POOL_KEYS.has(k)) continue
    const norm = normalizeTagRecScopeOverride(slot)
    if (norm && Object.keys(norm).length) out[k as TagRecPoolKey] = norm
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 组/L1 overrides 归一 (R3-04): 标量槽经 patch 消毒 —— makeTagGroup 只 cloneDeep 透传,
 * 畸形 dims/score 原样入表会经 merge 直达求值器; negative 名单容器由 validateNegativeRules
 * 深校后透传 (克隆脱源); pools 格槽仅 L2 可持 (L1 无格, validateOverridesShape 已拒)。
 * 全槽弃空 => undefined (无配置语义)。
 */
/** 池筛选的显式 true/false 都有覆盖语义，缺键才继承。 */
export function normalizePoolsEnabled(v: unknown): Partial<Record<TagRecPoolKey, boolean>> | undefined {
  if (v === undefined) return undefined
  if (!isObj(v)) return undefined
  const rec: Partial<Record<TagRecPoolKey, boolean>> = {}
  for (const [k, b] of Object.entries(v)) {
    if (POOL_KEYS.has(k) && typeof b === 'boolean') rec[k as TagRecPoolKey] = b
  }
  return Object.keys(rec).length ? rec : undefined
}

function normalizeTagRecGroupOverrides(v: TagRecGroupOverrides | undefined): TagRecGroupOverrides | undefined {
  if (!v) return undefined
  const out: TagRecGroupOverrides = normalizeTagRecScopeOverride(v) ?? {}
  if (v.negative !== undefined) out.negative = cloneDeep(v.negative)
  const pools = normalizeTagRecPools(v.pools)
  if (pools) out.pools = pools
  const poolsEnabled = normalizePoolsEnabled(v.poolsEnabled)
  if (poolsEnabled) out.poolsEnabled = poolsEnabled
  return Object.keys(out).length ? out : undefined
}
function normalizeTagRecL1Overrides(v: TagRecL1Overrides | undefined): TagRecL1Overrides | undefined {
  if (!v) return undefined
  const out: TagRecL1Overrides = normalizeTagRecScopeOverride(v) ?? {}
  if (v.negative !== undefined) out.negative = cloneDeep(v.negative)
  const poolsEnabled = normalizePoolsEnabled(v.poolsEnabled)
  if (poolsEnabled) out.poolsEnabled = poolsEnabled
  return Object.keys(out).length ? out : undefined
}

/** score 节同款宽容: weights/anchors 缺键填出厂锚点; 节整体缺失 => 全出厂; 类型错 => 拒 */
function normalizeTagRecScoreParams(score: unknown): TagRecScoreParams | undefined {
  const factory = createTagRecFactoryScoreParams()
  if (score === undefined) return factory
  if (!isObj(score)) return undefined
  if (score.weights !== undefined && !isObj(score.weights)) return undefined
  if (score.anchors !== undefined && !isObj(score.anchors)) return undefined
  const w = score.weights ?? {}
  const a = score.anchors ?? {}
  const wNums: Record<string, number> = {}
  const aNums: Record<string, number> = {}
  for (const k of SCORE_COMPONENT_KEYS) {
    const val = w[k] === undefined ? factory.weights[k] : w[k]
    if (!isNum(val)) return undefined
    wNums[k] = val
  }
  for (const k of SCORE_ANCHOR_KEYS) {
    const val = a[k] === undefined ? factory.anchors[k] : a[k]
    if (!isNum(val)) return undefined
    aNums[k] = val
  }
  const out: TagRecScoreParams = {
    weights: {
      view: wNums.view,
      likeRate: wNums.likeRate,
      favRate: wNums.favRate,
      coinRate: wNums.coinRate,
      interactRate: wNums.interactRate,
    },
    anchors: {
      viewLog10: aNums.viewLog10,
      likeRate: aNums.likeRate,
      favRate: aNums.favRate,
      coinRate: aNums.coinRate,
      interactRate: aNums.interactRate,
    },
  }
  return out
}

function normalizeTagRecFilterCore(v: unknown): TagRecFilterCore | undefined {
  if (!isObj(v)) return undefined
  const factory = createTagRecFactoryFilterCore()
  if (v.enabled !== undefined && !isBool(v.enabled)) return undefined
  if (v.strictMode !== undefined && !isBool(v.strictMode)) return undefined
  if (v.smallPoolThreshold !== undefined && !isNum(v.smallPoolThreshold)) return undefined
  const dims = normalizeTagRecFilterDims(v.dims)
  const score = normalizeTagRecScoreParams(v.score)
  if (!dims || !score) return undefined
  const pools = normalizeTagRecPools(v.pools) ?? factory.pools // 缺槽=出厂 (allV2 显式参数); 畸形键弃之
  // R8 池筛选: 稀疏化 (只留 false 项; true/未知键丢弃 —— 缺省=取)
  let poolsEnabled: TagRecFilterCore['poolsEnabled']
  if (v.poolsEnabled !== undefined) {
    if (!isObj(v.poolsEnabled)) return undefined
    const rec: NonNullable<TagRecFilterCore['poolsEnabled']> = {}
    for (const [k, b] of Object.entries(v.poolsEnabled)) {
      if (POOL_KEYS.has(k) && b === false) rec[k as TagRecPoolKey] = false
    }
    if (Object.keys(rec).length) poolsEnabled = rec
  }
  return {
    enabled: v.enabled ?? factory.enabled,
    strictMode: v.strictMode ?? factory.strictMode,
    smallPoolThreshold: v.smallPoolThreshold ?? factory.smallPoolThreshold,
    dims,
    score,
    ...(pools && { pools }),
    ...(poolsEnabled && { poolsEnabled }),
  }
}

/** 出厂内置预设名单 (AUDIT-19): 导入档的 builtin 标志仅放行名单内名 ——
 *  构造 builtin:true 落库会被 removeTagRecPreset/renameTagRecPreset 拒操作成僵尸预设 */
const BUILTIN_PRESET_NAMES = new Set(createTagRecBuiltinPresets().map((p) => p.name))

/** 入方向宽容归一: core/presets 每项经 normalizeTagRecFilterCore 缺键填出厂; 非对象/坏名条目仍拒。
 *  builtin 非出厂名剥除 (僵尸预设防护); activePreset 须落在归一后 presets 名单内, 悬空置 '' (自定义态) */
export function normalizeTagRecFilterSettings(v: unknown): TagRecFilterSettings | undefined {
  const core = normalizeTagRecFilterCore(v)
  if (!core) return undefined
  const s = v as Record<string, unknown>
  if (s.activePreset !== undefined && !isStr(s.activePreset)) return undefined
  if (s.presets !== undefined && !Array.isArray(s.presets)) return undefined
  const presets: TagRecFilterPreset[] = []
  for (const p of s.presets ?? []) {
    if (!isObj(p) || !isStr(p.name)) return undefined
    const config = normalizeTagRecFilterCore(p.config)
    if (!config) return undefined
    presets.push({
      name: p.name,
      ...(isBool(p.builtin) && { builtin: p.builtin && BUILTIN_PRESET_NAMES.has(p.name) }),
      config,
    })
  }
  const activePreset = isStr(s.activePreset) && presets.some((x) => x.name === s.activePreset) ? s.activePreset : ''
  return { ...core, activePreset, presets }
}
// #endregion

/** 导入冲突项 (feat: 用户裁量并入/并存/跳过) */
export type TagRecImportConflict = {
  /** 待入组 (已规范化; 组 id 撞车时已换新 uuid —— 落表前可被裁量剔除) */
  group: TagGroup
  /** 命中宿主: 共享 ≥1 正向 tag_id 或组 id 同源撞车; sameEntity 优先、共享数降序 */
  hits: {
    /** 宿主组 id (表内既有 / 本批先行者的入表 id) */
    id: string
    name: string
    /** 共享的正向 tag_id 列表 */
    shared: number[]
    /** 组 id 撞车 = 同源实体导出再导回/改内容回导 (仅对表内既有组判定) */
    sameEntity: boolean
  }[]
}

export type TagRecImportPlan = {
  combinationExclusionsToAdd?: TagRecConditionAtom[]
  /** 过校验的主题 (保原 id/name/addedAt; 与表内或本批 id 撞车者复用既有不重复建; 含悬挂 themeId 合成项) */
  themesToAdd: TagTheme[]
  /** 文件 l1 引用了未声明的主题 id => 按首个引用 L1 名补建的主题数 (历史导出主题节未写盘的修复上报) */
  synthesizedThemes: number
  /** activeThemeId 解析结果: undefined = 文件未声明 => 导入不动当前; null = 文件明示「全部」; 字符串 = 可解析的主题 id */
  activeThemeId?: string | null
  /** 过校验的一级组 (保原 id/enabled/weight/addedAt + themeId 归属对回; 与表内或本批 id 撞车者复用既有不重复建) */
  l1ToAdd: TagL1Group[]
  /** 过校验的整组 (保原 id/addedAt + l1Id 归属对回; 与表内 id 撞车已换新 uuid) */
  favoritesToAdd: TagGroup[]
  /** 与既有/本批组 id 重叠的信息上报 {导入组名, 重叠宿主组名} —— 不拦截 (票 14 跨组重复合法) */
  overlappedGroups: { name: string; hitGroupName: string }[]
  /**
   * 冲突清单 (feat: 导入不再静默出双份) —— 与表内既有/本批先行者组「共享正向 tag_id」
   * 或「组 id 同源撞车」的待入组; hits 按 sameEntity 优先、共享数降序排, hits[0] = 默认并入目标;
   * 逐条交用户裁量 (并入宿主/保留两份/跳过), 调用侧应用后才落表
   */
  conflicts: TagRecImportConflict[]
  /** 结构无效拒入的组名 (空 tag_ids 等; makeTagGroup 拒建) */
  invalidGroups: string[]
  /** 黑名单增量 (去重后; 休眠库存档, 票 14) */
  blacklistToAdd: TagBlacklistEntry[]
}

/**
 * 批量 JSON 导入的节合并 (feat: 多文件一次预览落表):
 * - themes/l1 逐节 concat —— 同 id 撞车由 plan 认领复用 (容器幂等在 plan 侧, 本层不判重名)
 * - favorites 按内容签名去重 (name + 正向 id 集 + 负向 id 集 + strict): 同签名 = 同一份导出的
 *   重复件 (包内互引/多文件含同一组), 收首件弃后续 —— 不签名化去重则批量包互撞会刷屏冲突清单;
 *   签名不同 = 真冲突 (含同 id 异内容), 照常入批交 plan/裁量处理
 * - blacklist 按 id 去重 (休眠存档, 跨文件重份无增量)
 * - activeThemeId / filterConfig: 后文件覆盖先前件 (末写胜出; 单文件时与原语义一致)
 */
export function mergeTagRecConfigExports(datas: readonly TagRecConfigExportV1[]): TagRecConfigExportV1 {
  const themes: TagTheme[] = []
  const l1: TagL1Group[] = []
  const favorites: TagGroup[] = []
  const blacklist: TagBlacklistEntry[] = []
  let activeThemeId: string | null | undefined
  let filterConfig: TagRecFilterSettings = { ...createTagRecFactoryFilterCore(), activePreset: '', presets: [] }
  const combinationExclusions = new Map<string, TagRecConditionAtom>()
  const seenGroupSigs = new Set<string>()
  const parentConfigs = new Map<string, string>()
  const canonical = (value: unknown) =>
    JSON.stringify(value ?? null, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    )
  const seenBlacklistIds = new Set<number>()
  for (const d of datas) {
    for (const atom of d.combinationExclusions ?? []) combinationExclusions.set(tagRecConditionKey(atom), atom)
    themes.push(...(d.themes ?? []))
    const parentIds = new Map<string, string>()
    for (const parent of d.l1) {
      const config = canonical(parent.overrides)
      const conflict = parentConfigs.has(parent.id) && parentConfigs.get(parent.id) !== config
      const id = conflict ? crypto.randomUUID() : parent.id
      parentConfigs.set(id, config)
      parentIds.set(parent.id, id)
      l1.push(conflict ? { ...parent, id } : parent)
    }
    for (const raw of d.favorites) {
      const parent = d.l1.find((l) => l.id === raw.l1Id)
      const g =
        raw.l1Id && parentIds.has(raw.l1Id) && parentIds.get(raw.l1Id) !== raw.l1Id
          ? { ...raw, l1Id: parentIds.get(raw.l1Id) }
          : raw
      const sig = `${g.name}\n${g.tag_ids
        .map((e) => e.id)
        .sort((a, b) => a - b)
        .join(',')}\n${(g.negative_tag_ids ?? [])
        .map((e) => e.id)
        .sort((a, b) => a - b)
        .join(
          ',',
        )}\n${g.negative_strict ?? ''}\n${canonical(g.overrides)}\n${canonical(parent?.overrides)}\n${g.combination ? tagRecCombinationSignature(g.combination) : ''}`
      if (seenGroupSigs.has(sig)) continue
      seenGroupSigs.add(sig)
      favorites.push(g)
    }
    for (const e of d.blacklist) {
      if (seenBlacklistIds.has(e.id)) continue
      seenBlacklistIds.add(e.id)
      blacklist.push(e)
    }
    if (d.activeThemeId !== undefined) activeThemeId = d.activeThemeId
    filterConfig = d.filterConfig
  }
  return {
    version: combinationExclusions.size || favorites.some((g) => g.combination) ? TAG_REC_EXPORT_VERSION : 2,
    ...(combinationExclusions.size ? { combinationExclusions: [...combinationExclusions.values()] } : {}),
    l1,
    themes,
    activeThemeId,
    favorites,
    blacklist,
    filterConfig,
  }
}

/**
 * JSON 导入计划 (纯函数):
 * - 主题 (票 26): 每条经 makeTagTheme 规范化 (空名弃) 保 id+addedAt;
 *   id 撞车 (已在表内 / 本批重复) => 复用既有主题不重复建 (容器幂等);
 *   文件 l1 引用未声明的 themeId => 按首个引用 L1 名补建主题兜底 (历史导出主题节未写盘的数据保全),
 *   合成主题 id 沿用引用值 => L1 归属自动对回; synthesizedThemes 计数上报
 * - 一级组 (票 17): 每条经 makeTagL1Group 规范化 (空名弃/clamp weight) 保 id+addedAt + themeId 归属对回;
 *   id 撞车 (已在表内 / 本批重复) => 复用既有 L1 不重复建壳 (容器幂等, 重复导入归属仍对回同一壳);
 *   组 l1Id 经 l1IdRemap 对回最终 id; 悬挂 l1Id (节内/表内皆无) => 不带归属落表,
 *   由 store addGroups 走 auto-wrap 兜底 (「无裸奔 L2」不变式在门面收口, 本层只产计划)
 * - activeThemeId: 缺省不动; null => 「全部」复位; 字符串经已认领集校验 (悬挂 id 不落)
 * - 收藏表: 每组经 makeTagGroup 规范化 (dedupe/clamp/name 回落 + 组内正负互斥) 保 id+addedAt;
 *   跨组 id 重复合法 => 照常入表, 重叠进 overlappedGroups 信息上报 (票 14)
 *   组 id 与表内撞车 (不同 tag_ids 的极端场景) => 换新 uuid
 * - 黑名单: pickNewBlacklistEntries 增量 (休眠 store, 可经面板「导入为负向」转入组)
 * - filterConfig 不在此合 —— 调用侧拿归一过的快照整体覆盖 settings.tagRec.filter
 *   (含 presets; 裁量: spec 未定义逐维合并语义, 整体覆盖与「切预设=整套覆盖」同构)
 */
export function planTagRecImport(
  data: TagRecConfigExportV1,
  existing: {
    favorites: readonly TagGroup[]
    blacklist: readonly TagBlacklistEntry[]
    l1?: readonly TagL1Group[]
    themes?: readonly TagTheme[]
  },
): TagRecImportPlan {
  // 主题先行 —— l1.themeId 的解析源须先于 L1 循环备好 (含悬挂合成)
  const themesToAdd: TagTheme[] = []
  const claimedThemeIds = new Set((existing.themes ?? []).map((t) => t.id))
  for (const raw of data.themes ?? []) {
    const t = makeTagTheme({ id: raw.id, name: raw.name, addedAt: raw.addedAt })
    if (!t) continue // 防御: 校验层已挡坏构; 漏网者弃之, 麾下 L1 themeId 走悬挂合成
    if (!claimedThemeIds.has(t.id)) {
      claimedThemeIds.add(t.id)
      themesToAdd.push(t)
    }
  }
  // 悬挂 themeId 兜底: l1 引用了节内/表内皆无的主题 id => 按首个引用 L1 名合成主题, id 沿用引用值
  let synthesizedThemes = 0
  for (const raw of data.l1) {
    if (!raw.themeId || claimedThemeIds.has(raw.themeId)) continue
    const t = makeTagTheme({ id: raw.themeId, name: raw.name, addedAt: raw.addedAt })
    if (!t) continue
    claimedThemeIds.add(t.id)
    themesToAdd.push(t)
    synthesizedThemes++
  }

  const l1ToAdd: TagL1Group[] = []
  const l1IdRemap = new Map<string, string>()
  const claimedL1Ids = new Set((existing.l1 ?? []).map((l) => l.id))
  for (const raw of data.l1) {
    // themeId 对回: 节内/表内/合成集已认领 => 沿用; 余者悬挂不携 (防御分支, 合成兜底后正常不触发)
    const themeId = raw.themeId && claimedThemeIds.has(raw.themeId) ? raw.themeId : undefined
    const l1 = makeTagL1Group({
      id: raw.id,
      name: raw.name,
      enabled: raw.enabled,
      weight: raw.weight,
      note: raw.note,
      themeId,
      overrides: normalizeTagRecL1Overrides(raw.overrides),
      addedAt: raw.addedAt,
    })
    if (!l1) continue // 防御: 校验层已挡坏构; 漏网者弃之, 麾下组回落 auto-wrap
    if (!claimedL1Ids.has(l1.id)) {
      claimedL1Ids.add(l1.id)
      l1ToAdd.push(l1)
    }
    l1IdRemap.set(raw.id, l1.id)
  }

  // activeThemeId 解析: 缺省 => undefined (不动); null => 复位「全部」; 字符串须落在已认领集 (含本批新增)
  const activeThemeId =
    data.activeThemeId === undefined
      ? undefined
      : data.activeThemeId === null || claimedThemeIds.has(data.activeThemeId)
        ? data.activeThemeId
        : undefined

  const planned: TagGroup[] = []
  const plannedGroupIds = new Set(existing.favorites.map((g) => g.id))
  const favoritesToAdd: TagGroup[] = []
  const overlappedGroups: TagRecImportPlan['overlappedGroups'] = []
  const conflicts: TagRecImportConflict[] = []
  const invalidGroups: string[] = []

  // 冲突命中反查索引: tagId => 宿主组 (existing 序先建, planned 随入组挂尾)
  //   原实现 per-入组全扫两池 × per-host ids.filter(some) = O(组×组×id²), 深链分享包远程输入下可秒级冻结;
  //   索引版 O(入组 ids × 平均桶长) + O(宿主数) 序回放, 语义逐项对齐 (shared 保 ids 序 / sameEntity 只认表内)
  const hostByTagId = new Map<number, TagGroup[]>()
  const indexHost = (h: TagGroup) => {
    const seen = new Set<number>()
    for (const e of h.tag_ids) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const arr = hostByTagId.get(e.id)
      if (arr) arr.push(h)
      else hostByTagId.set(e.id, [h])
    }
  }
  for (const h of existing.favorites) indexHost(h)
  const existingById = new Map(existing.favorites.map((h) => [h.id, h]))

  for (const raw of data.favorites) {
    // 归属对回: 节内映射优先, 次认表内既有 L1 id (文件指认已存在容器的合流场景), 余者悬挂不携
    const l1Id = raw.l1Id ? (l1IdRemap.get(raw.l1Id) ?? (claimedL1Ids.has(raw.l1Id) ? raw.l1Id : undefined)) : undefined
    const g = makeTagGroup({
      id: raw.id,
      name: raw.name,
      tag_ids: raw.tag_ids,
      negative_tag_ids: raw.negative_tag_ids,
      negative_strict: raw.negative_strict,
      overrides: normalizeTagRecGroupOverrides(raw.overrides),
      combination: raw.combination,
      weight: raw.weight,
      enabled: raw.enabled,
      note: raw.note,
      l1Id,
      addedAt: raw.addedAt,
    })
    if (!g) {
      invalidGroups.push(raw.name || '(未命名组)')
      continue
    }
    const ids = g.tag_ids.map((e) => e.id)
    const hitMap = new Map<string, TagRecImportConflict['hits'][number]>()
    for (const id of ids) {
      for (const h of hostByTagId.get(id) ?? []) {
        let hit = hitMap.get(h.id)
        if (!hit) hitMap.set(h.id, (hit = { id: h.id, name: h.name, shared: [], sameEntity: false }))
        hit.shared.push(id)
      }
    }
    const entityHost = existingById.get(raw.id)
    if (entityHost) {
      const hit = hitMap.get(entityHost.id)
      if (hit) hit.sameEntity = true
      else hitMap.set(entityHost.id, { id: entityHost.id, name: entityHost.name, shared: [], sameEntity: true })
    }
    // 枚举序回放池序 (existing → planned): hits[0] 为默认并入目标, 序敏感不可随 hitMap 插入序
    const hits: TagRecImportConflict['hits'] = []
    for (const h of existing.favorites) {
      const hit = hitMap.get(h.id)
      if (hit) hits.push(hit)
    }
    for (const h of planned) {
      const hit = hitMap.get(h.id)
      if (hit) hits.push(hit)
    }
    hits.sort((a, b) => Number(b.sameEntity) - Number(a.sameEntity) || b.shared.length - a.shared.length)
    if (plannedGroupIds.has(g.id)) g.id = crypto.randomUUID()
    plannedGroupIds.add(g.id)
    if (hits.length) {
      conflicts.push({ group: g, hits })
      overlappedGroups.push({ name: g.name, hitGroupName: hits[0].name })
    }
    planned.push(g)
    indexHost(g)
    favoritesToAdd.push(g)
  }

  const blacklistToAdd = pickNewBlacklistEntries(existing.blacklist, data.blacklist)
  return {
    ...(data.combinationExclusions ? { combinationExclusionsToAdd: cloneDeep(data.combinationExclusions) } : {}),
    themesToAdd,
    synthesizedThemes,
    activeThemeId,
    l1ToAdd,
    favoritesToAdd,
    overlappedGroups,
    conflicts,
    invalidGroups,
    blacklistToAdd,
  }
}

/**
 * 冲突裁量值 (feat4): merge=并入宿主 hits[0] / keep=保留两份照常入 / skip=跳过不入
 * —— pane JSON 导入与票 18 分享导入 Modal 共用
 */
export type TagRecImportChoice = 'merge' | 'keep' | 'skip'

/** 裁量后的落表决议 (落表门面消费 —— 纯逻辑, 不写 store) */
export type TagRecImportApply = {
  themesToAdd: TagTheme[]
  l1ToAdd: TagL1Group[]
  /** keep/无冲突 组 (含宿主缺席回落的 merge 不在此 —— 门面 resolve 时逐条判) */
  groupsToAdd: TagGroup[]
  /** merge 并入对: src=payload 组, targetId=宿主组 id (conflict.hits[0] —— 表内既有或本批先行者) */
  merges: { targetId: string; src: TagGroup }[]
  /** 裁量跳过数 (onlyGroupIds 勾选子集剔除不记 skip —— 未勾即不导, 与「跳过」语义不同) */
  skippedCount: number
}

/**
 * plan + 裁量 => 落表决议 (纯逻辑, 票 18 分享导入与 JSON 导入 confirm 共用 —— pane 原内联逻辑的抽提):
 * - choices: 冲突组三态, 缺省 keep (与 Modal 初值口径一致)
 * - onlyGroupIds (分享勾选子集): 只落勾选组; l1/themes 一并裁到实际入表组的归属链
 *   (防勾两组却建出全包主题树 —— 勾选不入的组其新 L1/主题也不进表)
 */
export function resolveTagRecImportApply(
  plan: TagRecImportPlan,
  opts: { choices?: Readonly<Record<string, TagRecImportChoice>>; onlyGroupIds?: ReadonlySet<string> } = {},
): TagRecImportApply {
  const { choices = {}, onlyGroupIds } = opts
  const conflictById = new Map(plan.conflicts.map((c) => [c.group.id, c]))
  const groupsToAdd: TagGroup[] = []
  const merges: TagRecImportApply['merges'] = []
  let skippedCount = 0
  for (const g of plan.favoritesToAdd) {
    if (onlyGroupIds && !onlyGroupIds.has(g.id)) continue
    const c = conflictById.get(g.id)
    const choice = c ? (choices[g.id] ?? 'keep') : 'keep'
    if (choice === 'skip') skippedCount++
    else if (choice === 'merge' && c) merges.push({ targetId: c.hits[0].id, src: g })
    else groupsToAdd.push(g)
  }
  let l1ToAdd = plan.l1ToAdd
  let themesToAdd = plan.themesToAdd
  if (onlyGroupIds) {
    const imported = [...groupsToAdd, ...merges.map((m) => m.src)]
    const neededL1 = new Set(imported.map((g) => g.l1Id).filter((x): x is string => !!x))
    l1ToAdd = plan.l1ToAdd.filter((l) => neededL1.has(l.id))
    const neededThemes = new Set(l1ToAdd.map((l) => l.themeId).filter((x): x is string => !!x))
    themesToAdd = plan.themesToAdd.filter((t) => neededThemes.has(t.id))
  }
  return { themesToAdd, l1ToAdd, groupsToAdd, merges, skippedCount }
}
// #endregion

// #region CSV 出方向 (§6.2): 收藏表名单 (含负向列, 票 14)
export const TAG_REC_CSV_HEADER = 'name,tag_id,weight,enabled,note,neg_tag_id'

/** CSV 字段转义: 含 `,` `"` 换行 => 双引号包裹 + 内部 `"` => `""` (RFC 4180 惯例) */
export function csvEscapeField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field
}

/**
 * 收藏表 => CSV: 每行 = 一组; 多 id 组 tag_id 列 `;` 连
 * (入方向同列兼容 => 本产物可回导; weight/enabled/note 入方向不消费, 仅留档)
 */
export function favoritesToCsv(groups: readonly TagGroup[]): string {
  if (groups.some((g) => g.combination)) throw new Error('完整组合无法无损保存为 CSV，请使用导出 JSON')
  const lines = [TAG_REC_CSV_HEADER]
  for (const g of groups) {
    lines.push(
      [
        csvEscapeField(g.name),
        csvEscapeField(g.tag_ids.map((e) => e.id).join(';')),
        String(g.weight),
        g.enabled ? 'true' : 'false',
        csvEscapeField(g.note ?? ''),
        csvEscapeField(
          groupNegativeTagIds(g)
            .map((e) => e.id)
            .join(';'),
        ),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
// #endregion

// #region CSV 入方向 (§6.2): 行模型 + 状态机
export type CsvImportRowStatus = 'ready' | 'resolving' | 'resolved' | 'pending' | 'conflict'
export type CsvImportSource = 'id-column' | 'name'

/**
 * 导入行 = 一个未来标签组:
 * - rawName: name 列原样 (原始名; 待解析行可编辑重试)
 * - tagIds: tag_id 列直给的 id 列表 (可多个, `;` 连); 名称解析成功后 = [解析 id]; 待解析行可直填
 * - negTagIds: neg_tag_id 列 (出方向 col5) 直给的负向 id 列表; 确认入表时写进组 negative_tag_ids
 * - resolvedEntries: 解析产出的 {id,name} 快照 (name 列=组名来源, entries=组 tag_ids 来源)
 * - use: 解析行的 count.use; 多 id 取 max (裁量: 阈值勾选按「组内最热标签」判)
 */
export type CsvImportRow = {
  key: string
  index: number // 文件内原始序 (use 排序 toggle 还原用)
  rawName: string
  tagIds: number[]
  negTagIds: number[]
  resolvedEntries: TagIdEntry[]
  use?: number
  source: CsvImportSource // 来源徽标: id 列 / 名称解析
  checked: boolean
  status: CsvImportRowStatus
  conflictGroupName?: string
}

/** RFC 4180 风格解析: `,` 分隔; `"..."` 包裹内含字面 `,`/换行, `""` => `"`; 去 BOM; `\r\n`/`\n` 断行
 *  W3-5: 超大文本/行数截断 —— 超限按空档返 (调用侧按「无可导入行」提示, 同空文件语义) */
export function parseCsvText(text: string): string[][] {
  if (text.length > IMPORT_TEXT_MAX_LEN) return []
  if (text.codePointAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let fieldTouched = false // 区分「空行」与「末尾无换行的单字段行」
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    switch (c) {
      case '"':
        inQuotes = true
        fieldTouched = true
        break
      case ',':
        row.push(field)
        field = ''
        fieldTouched = true
        break
      case '\n':
      case '\r':
        if (c === '\r' && text[i + 1] === '\n') i++ // \r\n 一次消费
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        fieldTouched = false
        break
      default:
        field += c
        fieldTouched = true
        break
    }
  }
  if (fieldTouched || field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.slice(0, IMPORT_MAX_ROWS)
}

/** tag_id 单元格: `;` `;` 空白 分隔的数字 token => 去重保序; 非数字 token 丢弃 */
export function parseTagIdCell(cell: string | undefined): number[] {
  if (!cell) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const token of cell.split(/[;；\s]+/)) {
    if (!token) continue
    const id = Number(token)
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const CSV_HEADER_CELLS = TAG_REC_CSV_HEADER.split(',')
/** [tag-rec] AUDIT-43: 表头判定收窄 —— 首行须整行恰为导出列序 (逐格 trim+小写比对) 才跳过; 组名恰叫「name」不误杀 */
const isCsvHeaderRecord = (rec: readonly string[]): boolean =>
  rec.length === CSV_HEADER_CELLS.length && rec.every((c, i) => c.trim().toLowerCase() === CSV_HEADER_CELLS[i])

/**
 * 记录 => 导入行: col0=原始名, col1=tag_id(`;`连), col5=neg_tag_id(`;`连) 回读为 negTagIds;
 * 其余列忽略 (出方向 weight/enabled/note 不回读)
 * 首个非空行整行恰为导出表头列序才判 header 跳过 (只判首行: 中段存在同名标签不误杀); 空名且无 id 的行丢弃
 */
export function csvRecordsToImportRows(records: readonly string[][]): CsvImportRow[] {
  const rows: CsvImportRow[] = []
  let firstMeaningfulSeen = false
  for (const rec of records) {
    const first = (rec[0] ?? '').trim()
    const tagIds = parseTagIdCell(rec[1])
    const negTagIds = parseTagIdCell(rec[5]) // [tag-rec] AUDIT-43: neg_tag_id 列回读 (出方向写了但回导曾静默丢)
    if (!first && !tagIds.length) continue
    if (!firstMeaningfulSeen) {
      firstMeaningfulSeen = true
      if (isCsvHeaderRecord(rec)) continue // header 行 (本仓库出方向产物)
    }
    rows.push({
      key: `r${rows.length}`,
      index: rows.length,
      rawName: first,
      tagIds,
      negTagIds,
      resolvedEntries: [],
      source: tagIds.length ? 'id-column' : 'name',
      checked: false,
      status: 'ready',
    })
  }
  return rows
}

/**
 * 解析结果落地 (modal 拿到 tag/info 结果后调):
 * - 任一空 info => 待解析 (checked=false)
 * - 全成 => resolved: resolvedEntries={id,name} 快照, tagIds 对齐, use=多 id 取 max, 默认勾选
 *   (默认勾 = 名单导入语义; 「不勾不进表」由用户取消)
 */
export function applyCsvRowResolution(
  row: CsvImportRow,
  infos: ((TagIdEntry & { use?: number }) | undefined)[],
): CsvImportRow {
  if (!infos.length || infos.some((i) => !i)) {
    return {
      ...row,
      resolvedEntries: [],
      use: undefined,
      checked: false,
      status: 'pending',
      conflictGroupName: undefined,
    }
  }
  const entries = (infos as TagIdEntry[]).map((e) => ({ id: e.id, name: e.name, tag_type: e.tag_type }))
  const uses = (infos as { use?: number }[]).map((e) => e.use).filter((u): u is number => u !== undefined)
  return {
    ...row,
    tagIds: entries.map((e) => e.id),
    resolvedEntries: entries,
    use: uses.length ? Math.max(...uses) : undefined,
    source: row.source === 'id-column' ? 'id-column' : 'name',
    checked: true,
    status: 'resolved',
    conflictGroupName: undefined,
  }
}

/** 入表前交集查重 (票 14 降为信息): resolved 行 tag_id 已入既有表 => 「与组X重复」徽标, 不取消勾选不拦截 */
export function checkCsvRowConflict(row: CsvImportRow, existing: readonly TagGroup[]): CsvImportRow {
  if (row.status !== 'resolved' || !row.tagIds.length) return row
  const hit = intersectCheck(existing, row.tagIds)
  if (!hit) return { ...row, status: 'resolved', conflictGroupName: undefined }
  return { ...row, status: 'conflict', checked: true, conflictGroupName: hit.name }
}

/** 手动改 tag_id 列 / 原始名后回到待解析前置态 (清解析产物) */
export function resetCsvRowForRetry(row: CsvImportRow): CsvImportRow {
  return { ...row, resolvedEntries: [], use: undefined, status: 'ready', conflictGroupName: undefined }
}

export type CsvImportPlan = {
  /** 勾选中可入表的新组 (makeTagGroup 规范化; weight/enabled 默认) */
  toAdd: TagGroup[]
  /** 勾选且与既有/本批组 id 重叠的行 {key, 宿主组名} —— 信息上报, 已照常入表 (票 14) */
  overlaps: { key: string; groupName: string }[]
}

/**
 * 确认导入计划 (§6.2 不勾不进表):
 * 仅 status=resolved|conflict && checked && 有 resolvedEntries 的行参与 (conflict=重复徽标不拦, 票 14);
 * 组名 = rawName (回导场景 = 原组名; 空则 makeTagGroup 回落首 id 名); negTagIds 写进组 negative_tag_ids
 */
export function planCsvImport(rows: readonly CsvImportRow[], existing: readonly TagGroup[]): CsvImportPlan {
  const planned: TagGroup[] = []
  const toAdd: TagGroup[] = []
  const overlaps: CsvImportPlan['overlaps'] = []
  // [tag-rec] AUDIT-43: negTagIds 随行进组 negative_tag_ids —— CSV 无名只有 id, 名先借表内/本行已解析条目,
  // 缺省落 `#id` 占位 (非空 => JSON 再导出过校验; 不撞真实 tag 名归一名 => 负向名匹配腿降级不命中, id 腿不受影响)
  const knownNames = new Map<number, string>()
  const collectNames = (entries: readonly TagIdEntry[] | undefined) => {
    for (const e of entries ?? []) if (!knownNames.has(e.id)) knownNames.set(e.id, e.name)
  }
  for (const g of existing) {
    collectNames(g.tag_ids)
    collectNames(groupNegativeTagIds(g))
  }
  for (const r of rows) collectNames(r.resolvedEntries)
  for (const row of rows) {
    if ((row.status !== 'resolved' && row.status !== 'conflict') || !row.checked || !row.resolvedEntries.length)
      continue
    const hit = intersectCheck(existing, row.tagIds) ?? intersectCheck(planned, row.tagIds)
    const g = makeTagGroup({
      name: row.rawName,
      tag_ids: row.resolvedEntries,
      negative_tag_ids: row.negTagIds.map((id) => ({ id, name: knownNames.get(id) ?? `#${id}` })),
    })
    if (!g) continue // 无效组 (空 ids) 静默跳过 —— resolved 行必有 entries, 纯防御
    if (hit) overlaps.push({ key: row.key, groupName: hit.name })
    planned.push(g)
    toAdd.push(g)
  }
  return { toAdd, overlaps }
}
// #endregion
