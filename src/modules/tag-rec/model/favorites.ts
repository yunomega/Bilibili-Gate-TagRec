import { cloneDeep } from 'es-toolkit'
import {
  excludeTagRecCondition,
  hasTagRecCombination,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
} from './combination'
import type { TagBlacklistEntry, TagGroup, TagIdEntry, TagL1Group, TagTheme } from './types'

/**
 * [tag-rec] 收藏表/黑名单 纯逻辑 (spec §3.1 / §3.2; 零依赖叶子模块, 可测)
 * - 有名字的空组可保存；空组不启用、不参与查询，移出最后一个标签保留组的配置。
 * - 跨组重复 tag_id 合法 (票 14 裁决: 不同组有重复标签很正常);
 *   intersectCheck 降级为「已在组 X」信息提示, 不再拦截入表
 * - 组内正负互斥: 同 id 在同组不可既是正向又是负向 —— addNegativeToGroup/addTagIdsToGroup
 *   入列时自动从另一边移除并上报 (最后正向例外拒移, 见 computeNegativeAdd 注)
 * - 三态: 正常(weight≥1) / 挂起(weight=0) / 停用(enabled=false)
 */

export const TAG_GROUP_WEIGHT_MIN = 0
export const TAG_GROUP_WEIGHT_MAX = 5
export const TAG_GROUP_WEIGHT_DEFAULT = 1

export type TagGroupState = 'normal' | 'suspended' | 'disabled'
export const TagGroupStateLabel: Record<TagGroupState, string> = {
  normal: '正常',
  suspended: '挂起',
  disabled: '停用',
}

/** 三态归类 (spec §3.1): enabled=false > weight=0 > 正常 */
export function groupState(g: Pick<TagGroup, 'weight' | 'enabled'>): TagGroupState {
  if (!g.enabled) return 'disabled'
  if (g.weight <= TAG_GROUP_WEIGHT_MIN) return 'suspended'
  return 'normal'
}

/** weight 行内步进收口: 取整 + clamp 0~5; 非有限数回落默认 1 */
export function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return TAG_GROUP_WEIGHT_DEFAULT
  return Math.min(TAG_GROUP_WEIGHT_MAX, Math.max(TAG_GROUP_WEIGHT_MIN, Math.round(w)))
}

/** tag_id 按 id 去重保序 (组内同 id 无意义) */
export function dedupeTagIdEntries(entries: readonly TagIdEntry[]): TagIdEntry[] {
  const seen = new Set<number>()
  const out: TagIdEntry[] = []
  for (const e of entries) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** id → 宿主导组 (§4.6 已收藏判定同套: tag_id ∈ 任一组 tag_ids[]); 跨组重复合法后返回首个命中 */
export function findGroupByTagId(groups: readonly TagGroup[], tagId: number): TagGroup | undefined {
  return groups.find((g) => g.tag_ids.some((e) => e.id === tagId))
}

/** id → 含其为「正向成员」的全部组 (票 12 候选行「已在组」徽标 / 票 19 弹层 ★ 全宿主素材; findGroupByTagId 的全量版) */
export function findGroupsByTagId(groups: readonly TagGroup[], tagId: number): TagGroup[] {
  return groups.filter((g) => g.tag_ids.some((e) => e.id === tagId))
}

/** id → 含其为「负向成员」的全部组 (弹层「负向@组名」/解黑素材) */
export function findGroupsByNegativeTagId(groups: readonly TagGroup[], tagId: number): TagGroup[] {
  return groups.filter((g) => groupNegativeTagIds(g).some((e) => e.id === tagId))
}

/** 所有成员读写共用双格式兼容视图，不能让字段位置改变状态和互斥。 */
export function groupNegativeTagIds(g: Pick<TagGroup, 'overrides' | 'negative_tag_ids' | 'combination'>): TagIdEntry[] {
  return dedupeTagIdEntries([
    ...(g.overrides?.negative?.tagIds ?? []),
    ...(g.negative_tag_ids ?? []),
    ...(g.combination?.exclude.flatMap((atom) => (atom.field === 'tag' ? [atom.value] : [])) ?? []),
  ])
}

export function setGroupNegativeTagIds(g: TagGroup, entries: readonly TagIdEntry[]) {
  const ids = dedupeTagIdEntries(entries).map((e) => ({ ...e }))
  if (g.combination) {
    g.combination.exclude = g.combination.exclude.filter((atom) => atom.field !== 'tag')
    ids.forEach((tag) => excludeTagRecCondition(g.combination!, tagRecConditionAtom('tag', tag)))
    delete g.negative_tag_ids
    if (g.overrides?.negative) delete g.overrides.negative.tagIds
    return
  }
  g.overrides ??= {}
  g.overrides.negative ??= {}
  g.overrides.negative.tagIds = ids
  g.negative_tag_ids = ids // 旧界面/CSV 的兼容镜像，两个写位同步落定
}

/** 组名 => 组 (出队负向解析: source.groupNames 归因名反查) */
export function findGroupsByNames(groups: readonly TagGroup[], names: readonly string[]): TagGroup[] {
  const set = new Set(names)
  return groups.filter((g) => set.has(g.name))
}

/**
 * 交集查重: 任一 tagId 已在表内 => 返回首个宿主导组 (「已在组 X」提示素材;
 * 票 14 起跨组重复合法, 不再拦截, 仅供预检标记/报告)
 * excludeGroupId: 向既有组加 id 时排除自身 (本组内已有 id 走 dedupe 不算冲突)
 */
export function intersectCheck(
  groups: readonly TagGroup[],
  tagIds: readonly number[],
  excludeGroupId?: string,
): TagGroup | undefined {
  const ids = new Set(tagIds)
  return groups.find((g) => g.id !== excludeGroupId && g.tag_ids.some((e) => ids.has(e.id)))
}

/** 任一 tagId 命中 => 全部宿主导组 (入表「也存在于组 X」枚举素材; intersectCheck 的全量版) */
export function findGroupsByTagIds(groups: readonly TagGroup[], tagIds: readonly number[]): TagGroup[] {
  const ids = new Set(tagIds)
  return groups.filter((g) => g.tag_ids.some((e) => ids.has(e.id)))
}

/** 组名枚举文案: ≤cap 全列「A」「B」, 超出「等 n 组」封顶 (toast 报告粒度, 票 12) */
export function summarizeGroupNames(names: readonly string[], cap = 3): string {
  const shown = names
    .slice(0, cap)
    .map((n) => `「${n}」`)
    .join('')
  return names.length > cap ? `${shown}等 ${names.length} 组` : shown
}

/**
 * 建组 (跨组重复合法, 不查重): 空组必须有名字，并保持停用；
 * name 缺省回落首 id 名; tag_type 缺省 = opportunistic 待回填 (spec §3.1);
 * 组内正负互斥: negative_tag_ids 中与正向同 id 者被剔除 (构造期正向优先)
 */
export function makeTagGroup(input: {
  name?: string
  tag_ids: TagIdEntry[]
  negative_tag_ids?: TagIdEntry[]
  negative_strict?: boolean
  overrides?: TagGroup['overrides']
  combination?: TagGroup['combination']
  weight?: number
  enabled?: boolean
  note?: string
  l1Id?: string
  id?: string
  addedAt?: number
}): TagGroup | undefined {
  const tag_ids = dedupeTagIdEntries(input.combination ? tagRecCombinationTagIds(input.combination) : input.tag_ids)
  const name = (input.name ?? '').trim() || tag_ids[0]?.name
  if (!name) return undefined
  const posIds = new Set(tag_ids.map((e) => e.id))
  const negative_tag_ids = dedupeTagIdEntries(input.negative_tag_ids ?? []).filter((e) => !posIds.has(e.id))
  const overrides = input.overrides ? cloneDeep(input.overrides) : undefined
  if (overrides?.negative?.tagIds)
    overrides.negative.tagIds = overrides.negative.tagIds.filter((e) => !posIds.has(e.id))
  return {
    id: input.id ?? crypto.randomUUID(),
    name,
    ...(input.l1Id && { l1Id: input.l1Id }), // 归属由调用侧裁决 (票 17 导入对回); 缺省不裸奔兜底在 store 门面
    tag_ids: tag_ids.map((e) => ({ ...e })),
    ...(input.combination && { combination: cloneDeep(input.combination) }),
    ...(negative_tag_ids.length && { negative_tag_ids: negative_tag_ids.map((e) => ({ ...e })) }),
    ...(input.negative_strict && { negative_strict: true }),
    // overrides 原样透传 (filter-scope 票11): 名单容器+格槽经 merge 读取, 不在此归一
    ...(overrides && { overrides }),
    weight: clampWeight(input.weight ?? TAG_GROUP_WEIGHT_DEFAULT),
    enabled: (tag_ids.length > 0 || hasTagRecCombination(input.combination)) && (input.enabled ?? true),
    note: input.note,
    addedAt: input.addedAt ?? Date.now(),
  }
}

/**
 * 建一级组 (票 17): 纯构造; 空名拒建 (门面 toast 前置)
 * enabled 缺省 false —— 新建/自动套 L1 默认不启用, 麾下整棵不入外层堆, 直到面板主动开 (spec)
 */
export function makeTagL1Group(input: {
  name?: string
  enabled?: boolean
  weight?: number
  note?: string
  themeId?: string
  overrides?: TagL1Group['overrides']
  id?: string
  addedAt?: number
}): TagL1Group | undefined {
  const name = (input.name ?? '').trim()
  if (!name) return undefined
  return {
    id: input.id ?? crypto.randomUUID(),
    name,
    ...(input.themeId && { themeId: input.themeId }), // 归属由调用侧裁决 (导入对回); 悬挂引用不入对象
    enabled: input.enabled ?? false,
    weight: clampWeight(input.weight ?? TAG_GROUP_WEIGHT_DEFAULT),
    // overrides 原样透传 (filter-scope 票11): 麾下组链上继承
    ...(input.overrides && { overrides: cloneDeep(input.overrides) }),
    note: input.note,
    addedAt: input.addedAt ?? Date.now(),
  }
}

/**
 * 建主题 (票 26): 纯构造; 空名拒建 (门面 toast 前置)
 * 主题只是筛子 —— 无 weight/enabled/tag 字段
 */
export function makeTagTheme(input: { name?: string; id?: string; addedAt?: number }): TagTheme | undefined {
  const name = (input.name ?? '').trim()
  if (!name) return undefined
  return {
    id: input.id ?? crypto.randomUUID(),
    name,
    addedAt: input.addedAt ?? Date.now(),
  }
}

/**
 * 合并成组 (组手术只在面板, spec §5.1): 并入最早 addedAt 的组 (keep),
 * tag_ids 按 keep 组优先序并集去重 (负向成员同规则并集去重,
 * 与合并后正向重叠者剔除保互斥); 其余组被吸收删除
 */
export function computeMergeGroups(
  groups: readonly TagGroup[],
): { keepId: string; tag_ids: TagIdEntry[]; negative_tag_ids: TagIdEntry[]; absorbedIds: string[] } | undefined {
  if (groups.length < 2) return undefined
  const sorted = [...groups].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))
  const keep = sorted[0]
  const tag_ids = dedupeTagIdEntries(sorted.flatMap((g) => g.tag_ids))
  const posIds = new Set(tag_ids.map((e) => e.id))
  const negative_tag_ids = dedupeTagIdEntries(sorted.flatMap(groupNegativeTagIds)).filter((e) => !posIds.has(e.id))
  return { keepId: keep.id, tag_ids, negative_tag_ids, absorbedIds: sorted.slice(1).map((g) => g.id) }
}

export type NegativeAddResult = {
  /** 纯新增进负向位的 id 数 */
  added: number
  /** 组内互斥: 原为正向被移到负向的 id 数 (自动移除正向) */
  moved: number
  /** 已是负向而跳过 */
  skipped: number
  /** 组内唯一正向拒转负向 (不变式1): 未加入的条目 */
  refusedSole: TagIdEntry[]
}

/**
 * 组内加负向成员 (组内正负互斥, spec §3.2 票 14 裁决):
 * - 已是负向 => skipped; 是正向 => 自动移出正向转负向 (moved)
 * - 正向恰剩 1 个且就是它 => refusedSole (不移, 保不变式1)
 * 返回新 tag_ids/negative_tag_ids (调用侧整体写回), 不改传入组
 */
export function computeNegativeAdd(
  g: TagGroup,
  entries: readonly TagIdEntry[],
): { tag_ids: TagIdEntry[]; negative_tag_ids: TagIdEntry[] } & NegativeAddResult {
  const res: NegativeAddResult = { added: 0, moved: 0, skipped: 0, refusedSole: [] }
  const tag_ids = [...g.tag_ids]
  const neg = groupNegativeTagIds(g)
  for (const e of dedupeTagIdEntries(entries)) {
    if (neg.some((x) => x.id === e.id)) {
      res.skipped++
      continue
    }
    const pi = tag_ids.findIndex((x) => x.id === e.id)
    if (pi !== -1) {
      if (tag_ids.length <= 1) {
        res.refusedSole.push(e)
        continue
      }
      tag_ids.splice(pi, 1)
      res.moved++
    } else {
      res.added++
    }
    neg.push({ ...e })
  }
  return { tag_ids, negative_tag_ids: neg, ...res }
}

export type RemoveTagIdResult = { ok: true; tag_ids: TagIdEntry[] } | { ok: false; reason: 'not-found' }

/**
 * 移出标签只改成员；最后一个标签移出后，门面停用空组并保留名字和配置。
 */
export function removeTagIdFromGroup(g: TagGroup, tagId: number): RemoveTagIdResult {
  if (!g.tag_ids.some((e) => e.id === tagId)) return { ok: false, reason: 'not-found' }
  return { ok: true, tag_ids: g.tag_ids.filter((e) => e.id !== tagId) }
}

/** 「拆为新项」前提: 源组 ≥2 id (单 id 组拆分无意义 = 自身复制) */
export function canSplitTagId(g: TagGroup): boolean {
  return g.tag_ids.length >= 2
}

/**
 * tab2 选中组 (spec §4.3): 正常+挂起组可列可选; 停用组防御剔除 (「停用不进」双保险——
 * 选中后再停用的组不进查询单元)。传入 ids 中不存在的 id 静默跳过, 返回按收藏表序。
 */
export function pickTagGroupsByIds(groups: readonly TagGroup[], selectedIds: readonly string[]): TagGroup[] {
  const set = new Set(selectedIds)
  return groups.filter(
    (g) => set.has(g.id) && g.enabled && (g.tag_ids.length > 0 || hasTagRecCombination(g.combination)),
  )
}

/** 选中组 tag_id 并集 (spec §4.3): 按组序+组内序并集去重 —— 查询单元/预算小字 M 的素材 */
export function unionTagIdsOfGroups(groups: readonly TagGroup[]): TagIdEntry[] {
  return dedupeTagIdEntries(groups.flatMap((g) => g.tag_ids))
}

export function blacklistHas(list: readonly TagBlacklistEntry[], id: number): boolean {
  return list.some((e) => e.id === id)
}

/** 入黑名单增量: 表内已有 + 入参自身重复 皆滤除, 返回待新增 {id,name} 快照 */
export function pickNewBlacklistEntries(
  list: readonly TagBlacklistEntry[],
  entries: readonly TagIdEntry[],
): TagBlacklistEntry[] {
  return dedupeTagIdEntries(entries)
    .filter((e) => !blacklistHas(list, e.id))
    .map(({ id, name }) => ({ id, name }))
}

/**
 * [tag-rec] 「指定标签」tab 内联红点 (发现引导, 一次性):
 *   收藏表非空 (有组可点 —— 手动收藏或分享导入皆可) 且未点进过该 tab => 红点;
 *   seen = settings.tagRec.customTabSeen, tab 激活即置位落盘, 红点永不再现
 */
export function shouldShowTagRecCustomDot(customTabSeen: boolean, favoritesGroupCount: number): boolean {
  return !customTabSeen && favoritesGroupCount > 0
}
