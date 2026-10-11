import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'
import { cloneDeep, isEqual } from 'es-toolkit'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  hasTagRecCombination,
  nameTagRecCombination,
  newTagRecCombination,
  removeTagRecCondition,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  validateTagRecCombination,
  type TagRecCombination,
  type TagRecConditionAtom,
} from './combination'
import { parseTagRecGroupIds, TagRecDeepLinkParam } from './deeplink'
import { createTagRecFactoryFilterCore, type TagRecFilterSettings } from './filter-engine'
import {
  planTagRecImport,
  serializeTagRecConfig,
  type TagRecConfigExportV1,
  type TagRecImportPlan,
} from './import-export'
import { extractSharePkgCode } from './share-pkg'
import type { TagBlacklistEntry, TagGroup, TagL1Group, TagTheme } from './types'

/**
 * [tag-rec] 分享上传链路纯逻辑 (tag-share-platform spec §5 / 票 16) —— 零 IO 叶子模块, 可测
 * - 勾选集展开: L1 勾选 = 麾下整棵 L2 子树 (pane 复选同款语义); L2 勾选 = 该项本身
 * - payload = serializeTagRecConfig 完整 v2/v3 形态 (携 combination 或 combinationExclusions 即升 v3),
 *   favorites 裁到勾选集,
 *   l1/themes 节裁到被勾组实际归属链 (悬挂引用保原值, 导入侧 planTagRecImport 有兜底);
 *   blacklist 随勾选含/空; filterConfig 默认出厂占位 —— 票26 起 Modal「含过滤配置」
 *   opt-in 勾选时改写为真实私配 (阈值/名单/算分/预设整套随包);
 *   combinationExclusions 默认不携 —— 006 缺口2 Modal「随包携带全局排除」opt-in 勾时传全局排除清单;
 *   activeThemeId/enabled 不携 —— 分享是数据不是视图态: 开关位剥键,
 *   导入侧 planShareImport 归一默认档 (组=true/L1=true 全启用) + Modal 反向取消决定谁停用
 * - preflightShareIssues = 服务端 guards.ts 防护档的客户端镜像 (同上限/同 field 路径),
 *   上传前就位列问题, 400 轮次省掉; 服务端仍是终审
 * - normalizeShareRejections: 错误体两形归一 —— 现网 {error, field?, reason, word?, category?}
 *   单条形态 + 票面预留 {reasons:[...]} 多条形态 => 统一清单给 Modal 逐条列
 */

// #region 勾选集展开
/**
 * 复选集 => 实际分享组集 (保序去重):
 * 勾中 L2 ∪ 勾中 L1 麾下全部 L2 (票 31「L1 勾选 = 整棵子树」沿用);
 * favorites 传面板已排序的组列表, 清单序与面板一致
 */
export function expandShareSelection(
  selection: { l1Ids: readonly string[]; groupIds: readonly string[] },
  favorites: readonly TagGroup[],
): TagGroup[] {
  const l1Set = new Set(selection.l1Ids)
  const picked = new Set(selection.groupIds)
  return favorites.filter((g) => picked.has(g.id) || (g.l1Id !== undefined && l1Set.has(g.l1Id)))
}
// #endregion

// #region payload 构造
/**
 * 出厂过滤配置占位 (spec §2「filterConfig 出厂占位不分享用户私配」)
 * - core = 出厂档 (= 初始 settings 的「淘沙」内容); presets 留空
 * - 票26 起真实私配可 opt-in 随包 (服务端深度档已放宽到 11, 覆盖
 *   presets[].config.pools.*.dims.pubdate.tod 最深合法路径); 占位仍是默认档
 * - activePreset '' = 无预设档 (presets 空集下「淘沙」是悬挂引用, 归一层同样回 '')
 */
export function createShareFactoryFilterConfig(): TagRecFilterSettings {
  return {
    ...createTagRecFactoryFilterCore(),
    activePreset: '',
    presets: [],
  }
}

/**
 * 包内 filterConfig 是否还是出厂占位 (票26 导入侧裁决用):
 * - 以归一化后产物为准做深比 —— 归一后的占位 == 本函数出厂字面量 (键序/补齐差被 isEqual 抹平);
 *   传入须先过 normalizeTagRecFilterSettings/parseTagRecConfig (分享导入管线本就过这层)
 * - 假阳容忍: 真实私配恰好等于出厂字面量 (没开过维度/没私建预设) 时判占位 —— 内容上二者本就等价
 */
export function isShareFactoryFilterConfig(fc: TagRecFilterSettings | undefined): boolean {
  return !!fc && isEqual(fc, createShareFactoryFilterConfig())
}

/**
 * 勾选集 => 分享 payload (完整 v2 导出结构):
 * - favorites = 勾选组原样 (serialize 深拷贝脱 valtio proxy, 不引用原对象)
 * - l1 = 勾选组 l1Id 实际指向的节点; themes = 被收 l1.themeId 实际指向的节点;
 *   悬挂引用 (组.l1Id/l1.themeId 指到节外) 保留原值不裁 —— planTagRecImport 合成/auto-wrap 兜底
 * - blacklist = includeBlacklist ? 全量 : []
 * - filterConfig = input.filterConfig ?? 出厂占位 (票26: Modal opt-in 传真实私配随包);
 *   combinationExclusions = input.combinationExclusions ?? 键不携 (006 缺口2: Modal opt-in 传
 *   tagRecCombinationBlocks.list, serialize 深拷贝 + 升 v3; 屏蔽项是隐私面, 默认不携);
 *   activeThemeId = 删键不携 (见头注)
 */
export function buildSharePayload(input: {
  groups: readonly TagGroup[]
  l1: readonly TagL1Group[]
  themes: readonly TagTheme[]
  blacklist: readonly TagBlacklistEntry[]
  includeBlacklist: boolean
  /** 票26「含过滤配置」opt-in: 勾上 => 传 settings.tagRec.filter (serialize 深拷贝脱 proxy); 缺省 => 出厂占位 */
  filterConfig?: TagRecFilterSettings
  /** 006 缺口2「全局排除」opt-in: 勾上 => 传 tagRecCombinationBlocks.list; 缺省/空 => 键不携 (不升 v3) */
  combinationExclusions?: readonly TagRecConditionAtom[]
}): TagRecConfigExportV1 {
  const l1Ids = new Set(input.groups.map((g) => g.l1Id).filter((x): x is string => !!x))
  const l1 = input.l1.filter((l) => l1Ids.has(l.id))
  const themeIds = new Set(l1.map((l) => l.themeId).filter((x): x is string => !!x))
  const themes = input.themes.filter((t) => themeIds.has(t.id))
  const data = serializeTagRecConfig({
    combinationExclusions: input.combinationExclusions,
    l1,
    themes,
    favorites: input.groups,
    blacklist: input.includeBlacklist ? input.blacklist : [],
    filterConfig: input.filterConfig ?? createShareFactoryFilterConfig(),
    activeThemeId: null,
  })
  delete data.activeThemeId // 不分享视图态: 键缺席 => 导入侧不动当前主题 (planTagRecImport 缺省语义)
  // enabled = 开关位同属视图态: 剥键不携 (校验层已放宽为可选); 导入侧归一默认档见 planShareImport
  for (const g of data.favorites) delete (g as { enabled?: boolean }).enabled
  for (const l of data.l1) delete (l as { enabled?: boolean }).enabled
  return data
}
// #endregion

// #region 防护档客户端镜像 (worker/src/guards.ts 同上限; 服务端仍是终审, 这层只为省一轮 400)
export const SHARE_GUARD_LIMITS = {
  MAX_BODY_BYTES: 1_000_000,
  MAX_GROUPS: 200,
  MAX_TAG_IDS_PER_GROUP: 100,
  MAX_STRING_LEN: 200,
  /** 票47 放宽 11→24 (服务端同档): 最深合法路径 = favorites[].combination.include 组树深 8 + value 容器 ≈ 23 */
  MAX_DEPTH: 24,
} as const

/** 分享拒绝/预检条目 (worker {error,field,reason,word?,category?} 单条形态 + 票面 reasons[] 形态归一后的行) */
export type ShareRejectItem = {
  field?: string
  reason: string
  word?: string
  category?: string
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isSafePosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const SHARE_BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 递归串长/深度/危险键巡检 (同 worker walkJsonTree 档; 收集全部命中而非首拒) */
function walkShareIssues(value: unknown, field: string, depth: number, out: ShareRejectItem[]): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length > SHARE_GUARD_LIMITS.MAX_STRING_LEN) {
      out.push({ field, reason: `字符串长度 ${value.length} 超过上限 ${SHARE_GUARD_LIMITS.MAX_STRING_LEN}` })
    }
    return
  }
  if (typeof value !== 'object') return
  if (depth > SHARE_GUARD_LIMITS.MAX_DEPTH) {
    out.push({ field, reason: `JSON 嵌套深度超过上限 ${SHARE_GUARD_LIMITS.MAX_DEPTH}` })
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkShareIssues(value[i], `${field}[${i}]`, depth + 1, out)
    return
  }
  for (const [k, v] of Object.entries(value)) {
    if (SHARE_BANNED_KEYS.has(k)) out.push({ field: `${field}.${k}`, reason: `包含危险键 ${k}` })
    walkShareIssues(v, `${field}.${k}`, depth + 1, out)
  }
}

const checkTagIds = (arr: unknown, field: string, out: ShareRejectItem[]) => {
  if (!Array.isArray(arr)) return
  if (arr.length > SHARE_GUARD_LIMITS.MAX_TAG_IDS_PER_GROUP) {
    out.push({ field, reason: `单组 tag_id 数 ${arr.length} 超过上限 ${SHARE_GUARD_LIMITS.MAX_TAG_IDS_PER_GROUP}` })
  }
  arr.forEach((e, i) => {
    if (!isPlainObj(e) || !isSafePosInt(e.id)) out.push({ field: `${field}[${i}].id`, reason: 'tag_id 须为安全正整数' })
  })
}

/**
 * 上传前本地预检 (与服务端同口径, 逐条收集不早退):
 * 标题必填 ≤200 / 描述 ≤200 / mid 安全正整数 / 组数·组内 id·tag_id 形态 / 递归串长·深度·危险键 / 体积 ≤1MB
 * + 毒包防线 (006 缺口3): 服务端不做 schema 校验, 畸形 combination/combinationExclusions 会透传落库,
 *   下载方 parseTagRecConfig 却整包硬拒 —— 这两个面的硬拒条件 (含 v<3 携组合/排除) 上传前就拦
 */
export function preflightShareIssues(body: {
  mid: number
  nickname?: string
  avatar?: string // 票34: 服务端只做白名单归一 (非法落 null 不 400),此处仅随串长递归档走一遍
  title: string
  description?: string
  payload: TagRecConfigExportV1
}): ShareRejectItem[] {
  const out: ShareRejectItem[] = []
  if (!isSafePosInt(body.mid)) out.push({ field: 'mid', reason: 'mid 须为安全正整数' })
  if (!body.title.trim()) out.push({ field: 'title', reason: '标题必填' })

  const favorites = body.payload.favorites
  if (favorites.length > SHARE_GUARD_LIMITS.MAX_GROUPS) {
    out.push({
      field: 'payload.favorites',
      reason: `组数 ${favorites.length} 超过上限 ${SHARE_GUARD_LIMITS.MAX_GROUPS}`,
    })
  }
  favorites.forEach((g, i) => {
    const gf = `payload.favorites[${i}]`
    checkTagIds(g.tag_ids, `${gf}.tag_ids`, out)
    checkTagIds(g.negative_tag_ids, `${gf}.negative_tag_ids`, out)
    const neg = isPlainObj(g.overrides) && isPlainObj(g.overrides.negative) ? g.overrides.negative : undefined
    if (neg) checkTagIds(neg.tagIds, `${gf}.overrides.negative.tagIds`, out)
    // 毒包防线: 组携 combination 须过结构校验 (parseTagRecConfig → validateTagGroup 同口径整包硬拒)
    if (g.combination !== undefined && !validateTagRecCombination(g.combination)) {
      out.push({ field: `${gf}.combination`, reason: '组合条件结构不合法 (导入方将整包拒收)' })
    }
  })
  // v3 门槛 (parseTagRecConfig 硬拒同口径): 携 combination / combinationExclusions 的包须 v3
  const belowV3 = typeof body.payload.version !== 'number' || body.payload.version < 3
  if (belowV3 && favorites.some((g) => g.combination !== undefined)) {
    out.push({ field: 'payload.version', reason: '携带组合条件的包须使用 v3 格式' })
  }
  // 全局组合排除: 存在 => v3 + 合法条件原子清单 (借 exclude 槽整树校验, 同 parseTagRecConfig 判据)
  const shareExclusions: unknown = body.payload.combinationExclusions
  if (shareExclusions !== undefined) {
    const probe = newTagRecCombination()
    probe.exclude = shareExclusions as TagRecConditionAtom[]
    if (belowV3 || !validateTagRecCombination(probe)) {
      out.push({ field: 'payload.combinationExclusions', reason: '全局组合排除条件不兼容或不完整' })
    }
  }
  if (Array.isArray(body.payload.blacklist)) {
    body.payload.blacklist.forEach((e, i) => {
      if (!isPlainObj(e) || !isSafePosInt(e.id)) {
        out.push({ field: `payload.blacklist[${i}].id`, reason: '黑名单条目 id 须为安全正整数' })
      }
    })
  }

  walkShareIssues(body, '$', 1, out)

  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
  if (bytes > SHARE_GUARD_LIMITS.MAX_BODY_BYTES) {
    out.push({ field: 'body', reason: `请求体 ${bytes} 字节超过上限 ${SHARE_GUARD_LIMITS.MAX_BODY_BYTES}` })
  }
  return out
}
// #endregion

// #region 拒绝归一化
/** 单条目形态识别: {reason:string} 为底线, field/word/category 可携 */
function toShareRejectItem(v: unknown): ShareRejectItem | undefined {
  if (!isPlainObj(v) || typeof v.reason !== 'string' || !v.reason) return undefined
  const item: ShareRejectItem = { reason: v.reason }
  if (typeof v.field === 'string' && v.field) item.field = v.field
  if (typeof v.word === 'string' && v.word) item.word = v.word
  if (typeof v.category === 'string' && v.category) item.category = v.category
  return item
}

/**
 * 服务端错误体 => 拒绝条目清单:
 * - {reasons:[{field,reason,word?|category?}...]} 多条形态 (票面预留)
 * - {error, field?, reason, word?, category?} 现网单条形态 (worker http.ts: extra 键摊平在顶层)
 * - 其它 => [] (调用侧回落兜底 toast)
 */
export function normalizeShareRejections(json: unknown): ShareRejectItem[] {
  if (!isPlainObj(json)) return []
  if (Array.isArray(json.reasons)) {
    return json.reasons.map(toShareRejectItem).filter((x): x is ShareRejectItem => !!x)
  }
  const single = toShareRejectItem(json)
  return single ? [single] : []
}
// #endregion

// #region 分享页链接 / 管理 token 记账 (纯部分; GM 读写见 store/share-tokens.ts)
/** 网站单页详情位: `${siteBase}/?share=<id>` (spec §7 左列表右详情, query 定位目标分享) */
export function buildSharePageUrl(siteBase: string, shareId: string): string {
  const u = new URL('/', siteBase)
  u.searchParams.set('share', shareId)
  return u.href
}

/**
 * 网页编辑直链 (票22): 详情位 + `#key=<mgmtToken>` —— 管理 token 走 URL fragment:
 * fragment 不进服务端请求/CF 日志/Referer; 站点捕获后落 sessionStorage 并擦除地址栏。
 * token 仅当本机账本有记录时给出 (失权条目不给此链接)。
 */
export function buildShareEditUrl(siteBase: string, shareId: string, mgmtToken: string): string {
  return `${buildSharePageUrl(siteBase, shareId)}#key=${encodeURIComponent(mgmtToken)}`
}

/** 「我的分享」账本条目 (GM `tag-rec:share-tokens`, spec §5: shareId → {token,title,createdAt}) */
export type ShareTokenRecord = { token: string; title: string; createdAt: number }
export type ShareTokenMap = Record<string, ShareTokenRecord>

/** 账本容量上限 (W3-4: 无 cap 时 GM 账本无限胀 —— 兄弟库 video-tags=2000, 账本条目轻按 500) */
export const SHARE_TOKENS_LEDGER_MAX = 500

/** upsert 纯变换 (新记录尾部插入; 同 id 覆写原位 —— Map 序语义在 GM 层不保证, 平面对象即可);
 *  W3-4: 超限按 createdAt 升序淘汰最旧 (createdAt=0 畸形条先走) */
export function upsertShareToken(map: Readonly<ShareTokenMap>, shareId: string, rec: ShareTokenRecord): ShareTokenMap {
  const next = { ...map, [shareId]: rec }
  const keys = Object.keys(next)
  if (keys.length > SHARE_TOKENS_LEDGER_MAX) {
    keys.sort((a, b) => next[a].createdAt - next[b].createdAt || a.localeCompare(b))
    for (const k of keys.slice(0, keys.length - SHARE_TOKENS_LEDGER_MAX)) delete next[k]
  }
  return next
}

export function removeShareToken(map: Readonly<ShareTokenMap>, shareId: string): ShareTokenMap {
  if (!(shareId in map)) return { ...map }
  const next = { ...map }
  delete next[shareId]
  return next
}
// #endregion

// #region 分享导入 (票 18 / spec §6) —— 深链/粘贴 → 预览 Modal 纯逻辑
/** 分享 id 形态 = 服务端 nanoid(10) 默认字母表 (spec §3) */
export const SHARE_ID_RE = /^[\w-]{10}$/

/** 任意文本中 `<param>=<值>` 取值 (前界 ?&# 防 utm_share 误中); 仅收合法 shareId 形态 */
function shareIdFromParam(text: string, param: string): string | undefined {
  const m = text.match(new RegExp(`[?&#]${param}=([\\w-]{1,64})`))
  return m?.[1] && SHARE_ID_RE.test(m[1]) ? m[1] : undefined
}

/**
 * 「粘贴分享链接/id」自由文本 => 分享定位 (spec §6 降级双件, 顺带支持 B 站动态里的纯链接):
 * - 含 `tag-rec-share=` 参的任意 URL / 站点分享页 `?share=<id>` / 整段裸 shareId / 自由文本内嵌 token
 * - 顺带抽 `tag-rec-groups` 子集参 (URL 内携时, 容许 percent 编码); 抽不出 id => undefined
 */
/** 「粘贴」文本判别结果 (判别联合): share = 分享页/深链/裸 id 定位; pkg = 票27 试改版导入码 */
export type ShareImportTextFound =
  | { kind: 'share'; shareId: string; groupIds: string[] | undefined }
  | { kind: 'pkg'; code: string }

export function extractShareImportFromText(text: string): ShareImportTextFound | undefined {
  const t = text.trim()
  if (!t) return undefined
  const pkgCode = extractSharePkgCode(t) // 导入码先行 —— fork 深链 hash 参/裸码都比 shareId 更特异
  if (pkgCode) return { kind: 'pkg', code: pkgCode }
  const shareId =
    shareIdFromParam(t, TagRecDeepLinkParam.Share) ??
    shareIdFromParam(t, 'share') ??
    (SHARE_ID_RE.test(t) ? t : undefined) ??
    t.match(/(?:^|[^\w-])([\w-]{10})(?=$|[^\w-])/)?.[1]
  if (!shareId) return undefined
  const gm = t.match(new RegExp(`[?&#]${TagRecDeepLinkParam.Groups}=([^\\s&#]*)`))
  let groupIds: string[] | undefined
  if (gm) {
    try {
      groupIds = parseTagRecGroupIds(decodeURIComponent(gm[1]))
    } catch {
      groupIds = parseTagRecGroupIds(gm[1])
    }
  }
  return { kind: 'share', shareId, groupIds }
}

/**
 * 分享导入计划 = planTagRecImport 前置子集裁剪 (spec §6):
 * - requestedGroupIds (深链/粘贴 URL 的 tag-rec-groups) 在 => payload.favorites 裁到子集再进 plan;
 *   请求 id 不在包内 => missingGroupCount 计数上报 (Modal 提示「N 个组不在包内」)
 * - 无子集 => 整包全列; 冲突裁量/悬挂兜底/幂等全归 planTagRecImport 本体
 */
export function planShareImport(input: {
  payload: TagRecConfigExportV1
  requestedGroupIds?: readonly string[]
  existing: {
    favorites: readonly TagGroup[]
    blacklist: readonly TagBlacklistEntry[]
    l1?: readonly TagL1Group[]
    themes?: readonly TagTheme[]
  }
}): { plan: TagRecImportPlan; missingGroupCount: number } {
  const requested = input.requestedGroupIds?.length ? new Set(input.requestedGroupIds) : undefined
  let missingGroupCount = 0
  let favorites = input.payload.favorites
  if (requested) {
    const inPack = new Set(favorites.map((g) => g.id))
    missingGroupCount = [...requested].filter((id) => !inPack.has(id)).length
    favorites = favorites.filter((g) => requested.has(g.id))
  }
  // activeThemeId/enabled 剥键 (同 export 侧语义): 远端包即便私带视图态也不许复位主题/沿用上传方开关 —
  //   「分享是数据不是视图态」进口侧再守一道 (worker 不过滤键, 防御深度靠双边); enabled 归一默认档:
  //   组=true (入表即可用) / L1=true (默认全启用; Modal 反向取消 —— 勾选结果 = 最终启用集)
  const plan = planTagRecImport(
    {
      ...input.payload,
      favorites: favorites.map((g) => ({ ...g, enabled: true })),
      l1: (input.payload.l1 ?? []).map((l) => ({ ...l, enabled: true })),
      activeThemeId: undefined,
    },
    input.existing,
  )
  return { plan, missingGroupCount }
}

/**
 * 分享导入落表后的 L1 启用裁决 (「默认全启用 + 反向取消」, Modal onOk 与警示条同源):
 * - 作用域 = applied.l1ToAdd 新增 id ∪ 本批实际落表组 (含 merge 并入源组) 的归属 l1Id,
 *   保序去重 —— 未涉改的 L1 不在集内 (调用侧不动其状态)
 * - 每条裁决 = !disabledL1Ids.has(id): 默认全启用, Modal 反向取消集 (disabledL1Ids) 内的落停用
 */
export function resolveShareImportL1Enabled(input: {
  /** 本批实际落表组 (applied.groupsToAdd ∪ applied.merges[].src) —— 归属 L1 逐一入作用域 */
  groups: readonly Pick<TagGroup, 'l1Id'>[]
  /** 本批新增 L1 (applied.l1ToAdd; 归属组缺席/全 merge 时也须给裁决) */
  l1ToAdd?: readonly Pick<TagL1Group, 'id'>[]
  /** 反向取消集 (Modal 行/节/批量开关维护; 空集 = 全启用) */
  disabledL1Ids: ReadonlySet<string>
}): { id: string; enabled: boolean }[] {
  const out: { id: string; enabled: boolean }[] = []
  const seen = new Set<string>()
  const push = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, enabled: !input.disabledL1Ids.has(id) })
  }
  for (const l of input.l1ToAdd ?? []) push(l.id)
  for (const g of input.groups) if (g.l1Id) push(g.l1Id)
  return out
}

/**
 * 分享导入预览草稿 (tagRecSharedSession.shareImport.draft 载荷):
 * 经 valtio ref() 脱壳入 session —— plan 内对象保持 raw, 确认落表时直推 store 不被代理/frozen;
 * key = `${shareId}:${请求序号}`, Modal 以 key 重挂载重置勾选/裁量态
 */
export type ShareImportDraft = {
  key: string
  /** 源分享 id —— 试改版(票27)信封未带 sid 时缺省 (回赞账/原分享页链同缺) */
  shareId?: string
  title: string
  /** 源分享者元信息 —— 试改版直给包体拉不到远端 meta 时全缺省 (卡头按需隐去) */
  nickname?: string
  mid?: number
  likesCount?: number
  description?: string
  /** 站点分享页 (`SITE_BASE/?share=<id>` —— 「打开分享页」跳网站); 无 sid 缺省 */
  siteUrl?: string
  /** 票27: 试改版标记 —— 包体经导入码直给未经服务端拉取 (卡头徽标+文案分叉位) */
  isPkg?: boolean
  /** planTagRecImport 产物 (清单/冲突/兜底全在内); Modal 只列 plan.favoritesToAdd, 默认全勾 */
  plan: TagRecImportPlan
  /** 深链 tag-rec-groups 指定 id 中不在包内的个数 (0 = 未指定或全命中) */
  missingGroupCount: number
  /** 深链是否圈定子集 (Modal 文案分叉位) */
  hasSubset: boolean
  /**
   * 包内真实私配 (票26; 已归一化快照 —— parseTagRecConfig 出物):
   * 仅当非出厂占位时上字段 (isShareFactoryFilterConfig); Modal 裁决区凭它渲染「带入过滤配置」勾选,
   * 确认时整档覆写 settings.tagRec.filter (applyTagRecImport 克隆落表)
   */
  filterConfig?: TagRecFilterSettings
}
// #endregion

// #region 「我的分享」账本视图 (票 17) —— GM tag-rec:share-tokens => Modal 行, 纯逻辑可测
/** 账本条目归一后形态: GM 畸形条目不丢 —— token 缺 = 「失权」(只读), title/createdAt 缺省兜底 */
export type MyShareEntry = {
  shareId: string
  /** 管理 token; undefined = 账本畸形失权 (PATCH/DELETE 不可操作) */
  token: string | undefined
  title: string
  createdAt: number
}

/**
 * 远端探测态 (reconcile 轻量档, getShareDetail 携 token 探):
 * - unprobed = 未探/探测失败 (静默, 不阻塞列表); gone = 服务端 404 (不存在或 token 失效且非 published —
 *   worker 不暴露存在性, 同态合并); published/pending/removed = meta.status 直译
 */
export type MyShareRemote = 'unprobed' | 'published' | 'pending' | 'removed' | 'gone'

/** Modal 行 = 账本条目 + 探测态归并 */
export type MyShareRow = MyShareEntry & { remote: MyShareRemote }

/**
 * GM 账本 map => 条目序列 (畸形兜底, 不丢行 —— 畸形条目正是「失权」只读行的来源):
 * map 非平面对象 => []; 条目非对象/字段缺失 => token=undefined, title='', createdAt=0;
 * 排序: createdAt desc (新分享在前), 并列按 shareId 字典序 (稳定序)
 */
export function normalizeShareTokenEntries(map: unknown): MyShareEntry[] {
  if (!isPlainObj(map)) return []
  const out: MyShareEntry[] = []
  for (const [shareId, v] of Object.entries(map)) {
    const rec = isPlainObj(v) ? v : {}
    out.push({
      shareId,
      token: typeof rec.token === 'string' && rec.token ? rec.token : undefined,
      title: typeof rec.title === 'string' ? rec.title : '',
      createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || a.shareId.localeCompare(b.shareId))
}

/** 探测结果 => 行远端态: 网络错/超时 => unprobed 静默 (reconcile 不阻塞); status 缺省视 published */
export function probeOutcomeToRemote(kind: 'ok' | 'not-found' | 'failed', status?: string): MyShareRemote {
  if (kind === 'not-found') return 'gone'
  if (kind === 'failed') return 'unprobed'
  if (status === 'removed') return 'removed'
  if (status === 'pending') return 'pending'
  return 'published'
}

/** 账本 map + 探测表 (shareId => remote) => Modal 行; probes 缺省/未覆盖 => unprobed */
export function buildMyShareRows(map: unknown, probes?: Readonly<Record<string, MyShareRemote>>): MyShareRow[] {
  return normalizeShareTokenEntries(map).map((e) => ({
    ...e,
    remote: probes?.[e.shareId] ?? 'unprobed',
  }))
}

/**
 * 「改标题/描述」PATCH 体构造 (worker validatePatchBody 同口径):
 * - title: trim 后必填且 ≤200, 违例 => undefined (调用侧拦保存)
 * - description: undefined = 键缺席不改 (远端现值未知时的防误清护栏);
 *   字符串 => trim, 空 => null (worker「显式清空」语义), 超长 => undefined 整体拒构
 */
export function buildSharePatchBody(input: {
  title: string
  description?: string
}): { title: string; description?: string | null } | undefined {
  const title = input.title.trim()
  if (!title || title.length > SHARE_GUARD_LIMITS.MAX_STRING_LEN) return undefined
  const body: { title: string; description?: string | null } = { title }
  if (input.description !== undefined) {
    const d = input.description.trim()
    if (d.length > SHARE_GUARD_LIMITS.MAX_STRING_LEN) return undefined
    body.description = d === '' ? null : d
  }
  return body
}

// #region 「我的分享」包内容结构化编辑 —— 免手改 JSON: 组/L1/主题/黑名单全可增删改 (票 17 结构档扩展)
/** 可编辑组模型: raw 携原始 favorites 条目, overrides/addedAt 等未暴露字段经它原样回写 */
export type SharePkgGroup = {
  /** 原组 id (React key + 写回 favorites[].id); 缺 id 的畸形条目用序号顶替 */
  id: string
  name: string
  tagIds: { id: number; name?: string }[]
  negIds: { id: number; name?: string }[]
  /** 负向严格标 (读 = overrides.negative.strict ?? 顶层别名 negative_strict; 写回顶层 —— 构造器写位) */
  negStrict: boolean
  /** 归属一级组 id (须指向 l1[] 内节点; 未归属/悬挂 = undefined) */
  l1Id?: string
  weight: number // 0~5
  note?: string
  raw: Record<string, unknown>
}
/** 可编辑一级组模型 (包内节 —— enabled 不进编辑面: 开关位是视图态, 写回恒剥键) */
export type SharePkgL1 = {
  id: string
  name: string
  /** 所属主题 id (须指向 themes[] 内节点) */
  themeId?: string
  weight: number
  note?: string
  raw: Record<string, unknown>
}
/** 可编辑主题模型 (纯筛子: 只有名) */
export type SharePkgTheme = { id: string; name: string; raw: Record<string, unknown> }
/** 可编辑包模型: 各节抽为可改行; version/filterConfig 等未暴露字段经 base 原样回写 */
export type SharePkgEdit = {
  base: Record<string, unknown>
  groups: SharePkgGroup[]
  l1: SharePkgL1[]
  themes: SharePkgTheme[]
  blacklist: { id: number; name?: string }[]
}

const normTagArr = (v: unknown): { id: number; name?: string }[] => {
  if (!Array.isArray(v)) return []
  const out: { id: number; name?: string }[] = []
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue
    const id = (e as Record<string, unknown>).id
    const name = (e as Record<string, unknown>).name
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
    out.push({ id, ...(typeof name === 'string' && name ? { name } : {}) })
  }
  return out
}
const mergeTagArr = (...arrs: { id: number; name?: string }[][]) => {
  const seen = new Set<number>()
  const out: { id: number; name?: string }[] = []
  for (const a of arrs) for (const e of a) if (!seen.has(e.id)) (seen.add(e.id), out.push(e))
  return out
}
const normStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const normWeight = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(5, Math.trunc(v))) : 1

/**
 * detail.payload → 可编辑模型; 结构不合法 (非对象/favorites 非数组) => undefined (调用侧提示不支持编辑)。
 * 宽于服务端防护档 —— 条目畸形字段滤掉不判死, 终审在服务端。
 * 负向名单读两源并集: 顶层别名 negative_tag_ids ∪ overrides.negative.tagIds (迁移双源, 写回折叠顶层)
 */
export function parseSharePkgForEdit(payload: unknown): SharePkgEdit | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const base = payload as Record<string, unknown>
  if (!Array.isArray(base.favorites)) return undefined
  const groups: SharePkgGroup[] = []
  for (const [i, g] of base.favorites.entries()) {
    if (typeof g !== 'object' || g === null) continue
    const raw = g as Record<string, unknown>
    const neg = isPlainObj(raw.overrides) && isPlainObj(raw.overrides.negative) ? raw.overrides.negative : undefined
    const combination = validateTagRecCombination(raw.combination) ? raw.combination : undefined
    groups.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `#${i}`,
      name: typeof raw.name === 'string' ? raw.name : '',
      tagIds: combination ? tagRecCombinationTagIds(combination) : normTagArr(raw.tag_ids),
      negIds: mergeTagArr(
        combination?.exclude.flatMap((atom) => (atom.field === 'tag' ? [atom.value] : [])) ?? [],
        normTagArr(raw.negative_tag_ids),
        normTagArr(neg?.tagIds),
      ),
      negStrict: neg?.strict === true || raw.negative_strict === true,
      ...(normStr(raw.l1Id) && { l1Id: normStr(raw.l1Id) }),
      weight: normWeight(raw.weight),
      ...(normStr(raw.note) && { note: normStr(raw.note) }),
      raw,
    })
  }
  const l1: SharePkgL1[] = []
  if (Array.isArray(base.l1)) {
    for (const [i, l] of base.l1.entries()) {
      if (typeof l !== 'object' || l === null) continue
      const raw = l as Record<string, unknown>
      l1.push({
        id: typeof raw.id === 'string' && raw.id ? raw.id : `#l${i}`,
        name: typeof raw.name === 'string' ? raw.name : '',
        ...(normStr(raw.themeId) && { themeId: normStr(raw.themeId) }),
        weight: normWeight(raw.weight),
        ...(normStr(raw.note) && { note: normStr(raw.note) }),
        raw,
      })
    }
  }
  const themes: SharePkgTheme[] = []
  if (Array.isArray(base.themes)) {
    for (const [i, t] of base.themes.entries()) {
      if (typeof t !== 'object' || t === null) continue
      const raw = t as Record<string, unknown>
      themes.push({
        id: typeof raw.id === 'string' && raw.id ? raw.id : `#t${i}`,
        name: typeof raw.name === 'string' ? raw.name : '',
        raw,
      })
    }
  }
  const blacklist = normTagArr(base.blacklist)
  return { base, groups, l1, themes, blacklist }
}

/** Apply flat tag edits to a copied tree, retaining non-tag rules and nested matching modes. */
function editedShareCombination(group: SharePkgGroup): TagRecCombination | undefined {
  if (!validateTagRecCombination(group.raw.combination)) return undefined
  const combination = cloneDeep(group.raw.combination)
  const selected = new Map(group.tagIds.map((tag) => [tag.id, tag]))
  const retained = new Set<number>()
  for (const atom of tagRecConditionAtoms(combination.include)) {
    if (atom.field !== 'tag') continue
    const tag = selected.get(atom.value.id)
    if (!tag) removeTagRecCondition(combination, atom.id)
    else {
      atom.value = { ...atom.value, ...tag, name: tag.name ?? atom.value.name }
      retained.add(tag.id)
    }
  }
  // Preserve identities for unchanged exclusions, including no-op editor saves.
  const negative = new Map(group.negIds.map((tag) => [tag.id, tag]))
  const retainedNegative = new Set<number>()
  combination.exclude = combination.exclude.filter((atom) => {
    if (atom.field !== 'tag') return true
    const tag = negative.get(atom.value.id)
    if (!tag) return false
    atom.value = { ...atom.value, ...tag, name: tag.name ?? atom.value.name }
    retainedNegative.add(tag.id)
    return true
  })
  for (const tag of group.tagIds) {
    if (retained.has(tag.id)) continue
    if (!addTagRecCondition(combination, tagRecConditionAtom('tag', { ...tag, name: tag.name ?? `#${tag.id}` })))
      throw new RangeError('内容条件超过组合上限，请减少条件后再保存')
    retained.add(tag.id)
  }
  for (const tag of group.negIds)
    if (!retainedNegative.has(tag.id))
      excludeTagRecCondition(combination, tagRecConditionAtom('tag', { ...tag, name: tag.name ?? `#${tag.id}` }))
  if (!validateTagRecCombination(combination)) throw new RangeError('内容条件超过组合上限，请减少条件后再保存')
  return combination
}

/** Same content guard for the editor and payload builder; condition-only groups are valid. */
export function hasSharePkgGroupContent(group: SharePkgGroup): boolean {
  if (group.tagIds.length) return true
  const combination = group.raw.combination
  if (!validateTagRecCombination(combination)) return false
  // Inspect intended content without constructing a potentially over-limit edit.
  return (
    group.negIds.length > 0 ||
    hasTagRecCombination({
      ...combination,
      include: {
        ...combination.include,
        children: tagRecConditionAtoms(combination.include).filter((atom) => atom.field !== 'tag'),
      },
      exclude: combination.exclude.filter((atom) => atom.field !== 'tag'),
    })
  )
}

/**
 * 可编辑模型 → PATCH payload (保存即整包重审):
 * - 组: 全字段写回 raw 副本 (name 空回落首 tag 名; ≥1 正向 id 由调用侧前置拦);
 *   负向双源折叠顶层 (overrides.negative.tagIds/strict 摘键 —— 顶层是构造器写位);
 *   l1Id 须指向幸存 L1 否则摘键; enabled/activeThemeId 恒剥键 (视图态不进包, 与 buildSharePayload 同口径)
 * - l1 按剩余组引用精简 (空壳不上架), themes 按幸存 L1 引用精简; 缺 addedAt/weight 填默认 (新建行)
 */
export function buildSharePkgPayload(e: SharePkgEdit): Record<string, unknown> {
  const out = { ...e.base }
  const l1Ids = new Set(e.l1.map((l) => l.id))
  const themeIds = new Set(e.themes.map((t) => t.id))
  const usedL1 = new Set<string>()

  out.favorites = e.groups
    .filter(hasSharePkgGroupContent) // 空组不构 (服务端语义档也拒; 调用侧先拦)
    .map((g) => {
      const f: Record<string, unknown> = { ...g.raw }
      f.id = g.id
      const combination = editedShareCombination(g)
      f.name =
        g.name.trim() || g.tagIds[0]?.name || (combination ? nameTagRecCombination(combination) : `#${g.tagIds[0]?.id}`)
      f.tag_ids = g.tagIds
      if (combination) f.combination = combination
      if (g.negIds.length) f.negative_tag_ids = g.negIds
      else delete f.negative_tag_ids
      if (g.negStrict) f.negative_strict = true
      else delete f.negative_strict
      // 负向双源折叠: overrides.negative.tagIds/strict 已并入顶层值 => 摘键防两源分叉
      // W6-4: 先克隆两级再摘 —— `{...g.raw}` 浅拷贝后 overrides/negative 仍共享引用,
      //   就地 delete 会污染编辑底稿 (g.raw 是远端包归一缓存的视图)
      const rawOverrides = f.overrides
      if (isPlainObj(rawOverrides) && isPlainObj(rawOverrides.negative)) {
        const negative = { ...rawOverrides.negative }
        delete negative.tagIds
        delete negative.strict
        const overrides = { ...rawOverrides }
        if (Object.keys(negative).length) overrides.negative = negative
        else delete overrides.negative
        if (Object.keys(overrides).length) f.overrides = overrides
        else delete f.overrides
      }
      if (g.l1Id && l1Ids.has(g.l1Id)) {
        f.l1Id = g.l1Id
        usedL1.add(g.l1Id)
      } else {
        delete f.l1Id
      }
      f.weight = normWeight(g.weight)
      if (g.note?.trim()) f.note = g.note.trim()
      else delete f.note
      delete f.enabled // 开关位不进包
      if (typeof f.addedAt !== 'number' || !Number.isFinite(f.addedAt)) f.addedAt = Date.now()
      return f
    })

  // l1: 只留被组引用的 (空壳不上架); themeId 须指向包内主题否则摘键
  const keptL1 = e.l1.filter((l) => usedL1.has(l.id))
  const usedThemes = new Set(keptL1.map((l) => l.themeId).filter((x): x is string => !!x && themeIds.has(x)))
  out.l1 = keptL1.map((l) => {
    const o: Record<string, unknown> = { ...l.raw }
    delete o.enabled // 同组口径
    o.id = l.id
    o.name = l.name.trim()
    if (l.themeId && themeIds.has(l.themeId)) o.themeId = l.themeId
    else delete o.themeId
    o.weight = normWeight(l.weight)
    if (l.note?.trim()) o.note = l.note.trim()
    else delete o.note
    if (typeof o.addedAt !== 'number' || !Number.isFinite(o.addedAt)) o.addedAt = Date.now()
    return o
  })
  out.themes = e.themes
    .filter((t) => usedThemes.has(t.id))
    .map((t) => {
      const o: Record<string, unknown> = { ...t.raw }
      o.id = t.id
      o.name = t.name.trim()
      if (typeof o.addedAt !== 'number' || !Number.isFinite(o.addedAt)) o.addedAt = Date.now()
      return o
    })
  delete out.activeThemeId // 视图态恒剥 (分享包语义)
  out.blacklist = e.blacklist
  return out
}
// #endregion

// #region 票 19 (tag-share): 回赞闭环纯逻辑 (spec §6) —— GM 读写见 store/share-tokens.ts
/** tab1「实际渲染」回赞触发阈值 (与 TagRecFavService.PAGE_SIZE 同值口径, spec §6「≥20 条」) */
export const SHARE_LIKE_MIN_RENDERED = 20
/** 已赞/已拒集各自上限 (FIFO 截尾; GM 值防无限涨, 正常体量远不达) */
export const SHARE_LIKE_ACTED_MAX = 500

/**
 * 已赞/已拒记忆集 (GM `tag-rec:share-like-acted`):
 * - liked = 「赞一个」成功 (ok/already 皆算); dismissed = 「不了」或点赞失败安静收下
 * - 两集命中任一 => 回赞横幅永不再出 (会话内+跨会话); 同 id 不两集并存 (后动作者赢)
 */
export type ShareLikeActed = { liked: string[]; dismissed: string[] }

const normIdArr = (v: unknown): string[] => {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && x && !seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/** GM 读值 => 记忆集 (畸形容忍: 非对象/非数组字段 => 空; 去重保序) */
export function normalizeShareLikeActed(v: unknown): ShareLikeActed {
  if (!isPlainObj(v)) return { liked: [], dismissed: [] }
  return { liked: normIdArr(v.liked), dismissed: normIdArr(v.dismissed) }
}

/** 入集纯变换 (不改原对象): set 指定集追加 shareId (去重), 对侧集摘除; 各集截尾到上限 */
export function upsertShareLikeActed(
  acted: Readonly<ShareLikeActed>,
  shareId: string,
  set: 'liked' | 'dismissed',
): ShareLikeActed {
  const liked = new Set(acted.liked)
  const dismissed = new Set(acted.dismissed)
  ;(set === 'liked' ? liked : dismissed).add(shareId)
  ;(set === 'liked' ? dismissed : liked).delete(shareId)
  const cap = (s: Set<string>) => [...s].slice(-SHARE_LIKE_ACTED_MAX)
  return { liked: cap(liked), dismissed: cap(dismissed) }
}

/**
 * 回赞横幅触发判定 (spec §6 决议行): pendingShareId 存在 ∧ 不在已赞/已拒集 ∧ 渲染条数达标
 *   => 返 shareId (调用侧武装横幅 + 清 pending); 任一不满足 => undefined
 * 「已赞/已拒先于渲染条件」票面条目: 判定与次序无关, 三条件合取即真
 */
export function resolveShareLikePrompt(input: {
  pendingShareId: string | undefined
  renderedCount: number
  acted: Readonly<ShareLikeActed>
  minRendered?: number // 缺省 SHARE_LIKE_MIN_RENDERED (测试可注入边界)
}): string | undefined {
  const pending = input.pendingShareId
  if (!pending) return undefined
  if (input.renderedCount < (input.minRendered ?? SHARE_LIKE_MIN_RENDERED)) return undefined
  if (input.acted.liked.includes(pending) || input.acted.dismissed.includes(pending)) return undefined
  return pending
}
// #endregion

// #region 票 31 (tag-share): dup-check 重复分享软提醒 —— 纯逻辑
dayjs.extend(duration) // duration 插件挂点 (src/index.ts 已挂;测试直 import 本模块时补挂 —— extend 幂等)

/**
 * dup-check 入参 tagIds: 待发 payload.favorites[].tag_ids[].id 拍平去重 (保序);
 * 只收正向 tag_id (契约语义 = 「本次将传的正向 tag id 集」), 负向/黑名单不入集
 */
export function collectSharePositiveTagIds(favorites: readonly Pick<TagGroup, 'tag_ids'>[]): number[] {
  const seen = new Set<number>()
  for (const g of favorites) {
    for (const e of g.tag_ids) {
      if (Number.isSafeInteger(e.id) && e.id > 0) seen.add(e.id)
    }
  }
  return [...seen]
}

/**
 * dup-check 行「更新于 X 前」: updated_at(unix ms) → 中文相对时长短文案;
 * 缺省/非法/未来值 → 「刚刚」(条目时间在 dup-check 语义下天然是过去时, 异常值不给怪文案)
 */
export function formatShareUpdatedAgo(ms: number | undefined, now = Date.now()): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '刚刚'
  const d = dayjs.duration(Math.max(0, now - ms))
  if (d.asMinutes() < 1) return '刚刚'
  if (d.asHours() < 1) return `${Math.floor(d.asMinutes())} 分钟前`
  if (d.asDays() < 1) return `${Math.floor(d.asHours())} 小时前`
  if (d.asMonths() < 1) return `${Math.floor(d.asDays())} 天前`
  if (d.asYears() < 1) return `${Math.floor(d.asMonths())} 个月前`
  return `${Math.floor(d.asYears())} 年前`
}
// #endregion

// #region 拒绝定位人话化 (票40: 服务端 field 路径 → 用户可读位置 + 实文本)

/** 具名容器键 → 中文位名 (元素携带 .name,显示为「name」) */
const FIELD_COLL_ZH: Record<string, string> = {
  l1: '一级组',
  favorites: '标签组',
  themes: '主题',
  presets: '预设',
}
/** 名单/叶子键 → 中文位名 */
const FIELD_LEAF_ZH: Record<string, string> = {
  note: '备注',
  up: '屏蔽 UP 主',
  title: '屏蔽词',
  desc: '简介屏蔽词',
  upBlacklist: 'UP 主黑名单',
  titleKeywords: '标题屏蔽词',
  descKeywords: '简介屏蔽词',
  partitionBlock: '屏蔽分区',
  partitionAllow: '分区白名单',
  partition: '分区名单',
  tagIds: '屏蔽 tag',
  tag_ids: 'tag 条目',
  activePreset: '当前预设',
  combination: '组合条件',
  combinationExclusions: '全局排除条件',
  version: '版本号',
}
const FIELD_TOP_ZH: Record<string, string> = {
  title: '标题',
  description: '描述',
  nickname: '昵称',
  mid: 'mid',
  body: '请求体',
}
/** 纯包装键:不产生可读位名,穿透 */
const FIELD_WRAP_KEYS = new Set(['payload', 'list', 'config', 'dims', 'negative', 'overrides'])
const ownLabel = (labels: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(labels, key) ? labels[key] : undefined

/**
 * worker 送审域路径 (fields.ts 形态) → 用户可读定位:
 *   'payload.l1[15].name'                                  → 一级组「我心危」
 *   'payload.favorites[0].overrides.negative.title[2]'     → 标签组「X」的屏蔽词「word」
 *   'payload.filterConfig.presets[0].config.dims.upBlacklist.list[1].name' → 预设「X」的 UP 主黑名单「Y」
 * 未识别路径原样透传 (本地预检的 $.* / tag_ids 结构性路径兜底)。
 */
export function describeShareField(field: string | undefined, body: { payload?: unknown } | undefined): string {
  if (!field) return ''
  const f = field.startsWith('$.') ? field.slice(2) : field
  const topLabel = ownLabel(FIELD_TOP_ZH, f)
  if (topLabel) return topLabel

  let cur: unknown = body
  const crumbs: string[] = []
  let pendingKey = ''
  let leafText = ''
  for (const s of f.split('.')) {
    const m = s.match(/^([^[]+)(?:\[(\d+)\])?$/)
    if (!m) return field
    const k = m[1]!
    if (SHARE_BANNED_KEYS.has(k)) return field
    const idx = m[2]
    cur = isPlainObj(cur) && Object.hasOwn(cur, k) ? cur[k] : undefined
    if (!FIELD_WRAP_KEYS.has(k)) pendingKey = k
    if (idx !== undefined) {
      cur = Array.isArray(cur) ? cur[+idx] : undefined
      const label = ownLabel(FIELD_COLL_ZH, k) ?? ownLabel(FIELD_LEAF_ZH, k) ?? ownLabel(FIELD_LEAF_ZH, pendingKey)
      if (isPlainObj(cur) && typeof cur.name === 'string' && cur.name && label) {
        crumbs.push(`${label}「${cur.name}」`)
      }
    }
    if (typeof cur === 'string') leafText = cur
  }

  const lastKey =
    f
      .split('.')
      .at(-1)
      ?.match(/^([^[]+)/)?.[1] ?? ''
  if (lastKey === 'name' && crumbs.length) return crumbs.join('的')
  const leafLabel = ownLabel(FIELD_LEAF_ZH, lastKey) ?? (lastKey === 'name' ? '名称' : lastKey)
  const textBit = leafText ? `「${leafText}」` : ''
  if (!crumbs.length) {
    if (leafText || ownLabel(FIELD_LEAF_ZH, lastKey)) return `${leafLabel}${textBit}`
    return field
  }
  return `${crumbs.join('的')}的${leafLabel}${textBit}`
}

/** 审核类目 → 中文 (Workers AI S 码可读名 + OpenAI omni categories 双档;未知原样) */
const CATEGORY_ZH: Record<string, string> = {
  // llama-guard S1–S14 映射名 (worker workersai.ts CATEGORY_LABELS)
  'violent_crimes': '暴力犯罪',
  'non_violent_crimes': '非暴力违法',
  'sex_crimes': '性相关犯罪',
  'child_exploitation': '未成年人性剥削',
  'defamation': '诽谤',
  'specialized_advice': '违规专业建议',
  'privacy': '隐私泄露',
  'intellectual_property': '知识产权',
  'indiscriminate_weapons': '武器/危险品',
  'hate': '仇恨言论',
  'self_harm': '自伤/自杀',
  'sexual_content': '色情内容',
  'elections': '选举操纵',
  'code_interpreter_abuse': '代码滥用',
  'flagged': '违规内容',
  // OpenAI omni-moderation categories
  'harassment': '骚扰',
  'harassment/threatening': '骚扰威胁',
  'hate/threatening': '仇恨威胁',
  'illicit': '违法内容',
  'illicit/violent': '暴力违法',
  'self-harm': '自伤/自杀',
  'self-harm/intent': '自伤倾向',
  'self-harm/instructions': '自伤指导',
  'sexual': '色情内容',
  'sexual/minors': '未成年人性内容',
  'violence': '暴力内容',
  'violence/graphic': '血腥暴力',
}
export function describeShareCategory(category: string): string {
  return ownLabel(CATEGORY_ZH, category) ?? category
}
// #endregion
