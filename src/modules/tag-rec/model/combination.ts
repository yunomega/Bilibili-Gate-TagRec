import { cloneDeep } from 'es-toolkit'
import { validateTagRecCombinationFilters } from './combination-filters'
import { evalTagRecPartitionEntry } from './partition'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type { TagRecSessionFilterPatch } from './filter-engine'
import type { TagGroup, TagIdEntry, TagRecPartitionEntry } from './types'

export type TagRecConditionField = 'tag' | 'up' | 'title' | 'desc' | 'partition'
export type TagRecConditionAtom = { kind: 'atom'; id: string } & (
  | { field: 'tag'; value: TagIdEntry }
  | { field: 'up'; value: { name: string; mid?: number } }
  | { field: 'title' | 'desc'; value: string }
  | { field: 'partition'; value: TagRecPartitionEntry }
)
export type TagRecConditionGroup = {
  kind: 'group'
  id: string
  mode: 'any' | 'all'
  name?: string
  children: TagRecConditionNode[]
}
export type TagRecConditionNode = TagRecConditionAtom | TagRecConditionGroup
export type TagRecCombination = {
  version: 1
  include: TagRecConditionGroup
  exclude: TagRecConditionAtom[]
  filters?: TagRecSessionFilterPatch
}
export const TAG_REC_CONDITION_FIELDS: Record<TagRecConditionField, string> = {
  tag: '标签',
  up: 'UP 主',
  title: '标题词',
  desc: '简介词',
  partition: '分区',
}
export const TAG_REC_COMBINATION_MAX_NODES = 128
export const TAG_REC_COMBINATION_MAX_DEPTH = 8

export function newTagRecCombination(): TagRecCombination {
  return { version: 1, include: { kind: 'group', id: crypto.randomUUID(), mode: 'all', children: [] }, exclude: [] }
}
export function tagRecConditionAtom<F extends TagRecConditionAtom['field']>(
  field: F,
  value: F extends 'title' | 'desc' ? string : Extract<TagRecConditionAtom, { field: F }>['value'],
): TagRecConditionAtom {
  const atom = { kind: 'atom', id: crypto.randomUUID(), field, value }
  return atom as TagRecConditionAtom
}
export function tagRecConditionLabel(atom: TagRecConditionAtom): string {
  return typeof atom.value === 'string'
    ? atom.value
    : atom.value.name || ('mid' in atom.value ? `UID ${atom.value.mid}` : '')
}
export function tagRecConditionKey(atom: TagRecConditionAtom): string {
  if (atom.field === 'tag') return `tag:${atom.value.id}`
  if (atom.field === 'up')
    return atom.value.mid ? `up:${atom.value.mid}` : `up:name:${normalizeTagName(atom.value.name)}`
  if (atom.field === 'partition')
    return `partition:${atom.value.level ?? ''}:${atom.value.v1 ?? ''}:${atom.value.v2 ?? ''}`
  return `${atom.field}:${normalizeTagName(atom.value)}`
}
/** 只读遍历形态: valtio snapshot 的深只读组合同样可入 (children 只读数组)。 */
type TagRecConditionTree = TagRecConditionAtom | { kind: 'group'; children: readonly TagRecConditionTree[] }
export function tagRecConditionAtoms(node: TagRecConditionTree): TagRecConditionAtom[] {
  return node.kind === 'atom' ? [node] : node.children.flatMap(tagRecConditionAtoms)
}
/** 整棵树全部节点数 (组壳+原子) —— MAX_NODES 预算口径是节点不是原子;
 *  只数原子会漏组壳, 边界处偷偷产出超限组合 (审计 U07) */
function tagRecConditionNodes(node: TagRecConditionTree): number {
  return node.kind === 'atom' ? 1 : 1 + node.children.reduce((n, child) => n + tagRecConditionNodes(child), 0)
}
function populatedChildren(node: TagRecConditionGroup): TagRecConditionNode[] {
  return node.children.filter((child) => child.kind === 'atom' || populatedChildren(child).length > 0)
}
/**
 * 分支的「需 tag 证据」计数 —— 与可检索分支展开同口径:
 * tag 原子 = 1; 'all' 子组递归展开 (内成员各自是独立必需约束);
 * 'any' 子组整体只算一个分支 (内部是选项, 对外只需一份证据)。
 */
const tagEvidenceBranches = (node: TagRecConditionNode): number => {
  if (node.kind === 'atom') return node.field === 'tag' ? 1 : 0
  if (node.mode === 'all') return node.children.reduce((sum, child) => sum + tagEvidenceBranches(child), 0)
  return tagRecConditionAtoms(node).some((atom) => atom.field === 'tag') ? 1 : 0
}
/** 「仅看标签」是否为必过非空名单 (组合内 filters.dims / 生效链) => 计一个 tag 证据分支 */
const comboTagAllowOn = (combination: TagRecCombination): boolean =>
  combination.filters?.enabled !== false &&
  !!combination.filters?.dims?.tagAllow?.enabled &&
  combination.filters.dims.tagAllow.list.length > 0
/**
 * 交集组合判定: ≥2 个必需分支各自需要 tag 证据。
 * 计数口径:
 * - 'all' 根: 直属 children 求和 —— 'all' 子组递归展开 (成员各自是独立必需约束),
 *   'any' 子组整体一分支; 空组不算
 * - 'any' 根: 纯 tag 并集对外仍是一个必过 tag 约束 => 1 (混入 title 词的路径可零 tag 证据过关)
 * - tagAllow「仅看标签」必过名单 => +1 (组合内 dims + 生效链 extraTagAllow 各计一份)
 * tag 是唯一不能靠条目字段自证的维 (tag/top 只带召回 claim, archive/related 零证据),
 * 多分支同时欠 tag 证据时取数应收窄到 all/v2 (自带 tag 名单, 一次请求产全量证据)。
 */
export function isTagRecCombinationIntersection(combination: TagRecCombination, extraTagAllow = false): boolean {
  const include = combination.include
  const atoms = tagRecConditionAtoms(include)
  const tree =
    include.mode === 'all'
      ? include.children.reduce((sum, child) => sum + tagEvidenceBranches(child), 0)
      : atoms.length > 0 && atoms.every((a) => a.field === 'tag')
        ? 1
        : 0
  return tree + (comboTagAllowOn(combination) ? 1 : 0) + (extraTagAllow ? 1 : 0) >= 2
}
export type TagRecSearchTerm = { norm: string; name: string; field: TagRecConditionField }
/**
 * 生效链词源 (service 由 scopeResolver 解出喂入): 「仅看」名单与屏蔽名单都在
 * 会话>L2>L1>全局 链上, 组合自己的 filters 看不到 —— 不带则漏配/配死词。
 */
export type TagRecSearchExtra = {
  /** 生效链启用的仅看标签名单 —— 必过 tag 约束 */
  allowTags?: readonly TagIdEntry[]
  /** 生效链启用的仅看标题词名单 */
  allowTitle?: readonly string[]
  /** 生效链启用的仅看简介词名单 */
  allowDesc?: readonly string[]
  /** 生效链屏蔽词归一集 (tagBlock/标题/简介屏蔽) —— 命中即滤的词不配进查询, 配了也是整流白烧 */
  blockNorms?: ReadonlySet<string>
}
/**
 * 组合的「可检索分支」(Q4-C 组合词深挖流配对原料):
 * - required: 必过约束 —— 'all' 根/子组展开逐分支 (atom 一支, 'any' 子组整支);
 *   启用的 titleAllow/descAllow/tagAllow (组合内 + 生效链 extra) 各作一个伪分支
 * - optional: 'any' 根全部检索词摊平 —— 只配去和 required 侧配对 (彼此不配, 会截并集召回)
 * - internal: 'any' 根下 'all' 子组的内部分支簇 —— 子组成员在那条备选里是同位必需,
 *   互配不截并集 (如 any[a, all{x,y}] 的 x×y 是唯一瞄准该备选的查询)
 * 检索词 = tag 名 + title/desc 词 (up/partition 无法进搜索查询); 归一去重 + 屏蔽词剔除;
 * 词面长度过滤 (长文本词纯噪声) 由调用侧按 field 决定 —— tag 名不设限。
 */
export function tagRecSearchBranches(
  combination: TagRecCombination,
  extra?: TagRecSearchExtra,
): {
  required: TagRecSearchTerm[][]
  optional: TagRecSearchTerm[]
  internal: TagRecSearchTerm[][][]
} {
  const termOf = (atom: TagRecConditionAtom): TagRecSearchTerm | undefined => {
    const surface =
      atom.field === 'tag' ? atom.value.name : atom.field === 'title' || atom.field === 'desc' ? atom.value : ''
    const norm = normalizeTagName(surface)
    return norm && !extra?.blockNorms?.has(norm) ? { norm, name: surface, field: atom.field } : undefined
  }
  const collect = (node: TagRecConditionNode): TagRecSearchTerm[] => {
    const terms = new Map<string, TagRecSearchTerm>()
    for (const atom of tagRecConditionAtoms(node)) {
      const t = termOf(atom)
      if (t && !terms.has(t.norm)) terms.set(t.norm, t)
    }
    return [...terms.values()]
  }
  const expand = (node: TagRecConditionNode): TagRecSearchTerm[][] => {
    if (node.kind === 'atom') {
      const t = termOf(node)
      return t ? [[t]] : []
    }
    if (node.mode === 'all') return node.children.flatMap(expand)
    const terms = collect(node)
    return terms.length ? [terms] : []
  }
  const include = combination.include
  const required = include.mode === 'all' ? expand(include) : []
  const optional = include.mode === 'any' ? collect(include) : []
  const internal =
    include.mode === 'any'
      ? include.children
          .filter((c): c is TagRecConditionGroup => c.kind === 'group' && c.mode === 'all')
          .map(expand)
          .filter((branches) => branches.length > 1)
      : []
  // 过滤「仅看」名单 = 恒真必需约束 (不受 include.mode 影响, 任一命中下同样必过) —— 组合内 + 生效链
  const pushAllow = (terms: TagRecSearchTerm[]) => {
    const alive = terms.filter((t) => t.norm && !extra?.blockNorms?.has(t.norm))
    if (alive.length) required.push(alive)
  }
  if (combination.filters?.enabled !== false) {
    const dims = combination.filters?.dims
    if (dims?.tagAllow?.enabled && dims.tagAllow.list.length)
      pushAllow(
        dims.tagAllow.list.map((e) => ({ norm: normalizeTagName(e.name), name: e.name, field: 'tag' as const })),
      )
    for (const [field, rule] of [
      ['title', dims?.titleAllow],
      ['desc', dims?.descAllow],
    ] as const)
      if (rule?.enabled && rule.list.length)
        pushAllow(rule.list.map((w) => ({ norm: normalizeTagName(w), name: w, field })))
  }
  if (extra?.allowTags?.length)
    pushAllow(extra.allowTags.map((e) => ({ norm: normalizeTagName(e.name), name: e.name, field: 'tag' as const })))
  if (extra?.allowTitle?.length)
    pushAllow(extra.allowTitle.map((w) => ({ norm: normalizeTagName(w), name: w, field: 'title' as const })))
  if (extra?.allowDesc?.length)
    pushAllow(extra.allowDesc.map((w) => ({ norm: normalizeTagName(w), name: w, field: 'desc' as const })))
  return { required, optional, internal }
}
export function findTagRecCondition(node: TagRecConditionNode, id: string): TagRecConditionNode | undefined {
  if (node.id === id) return node
  if (node.kind === 'group')
    for (const child of node.children) {
      const found = findTagRecCondition(child, id)
      if (found) return found
    }
}
export function addTagRecCondition(
  combination: TagRecCombination,
  atom: TagRecConditionAtom,
  target?: string,
): boolean {
  // A borrowed positive never silently cancels an explicit exclusion.
  const destination = target ? findTagRecCondition(combination.include, target) : undefined
  if (target && destination?.kind !== 'group') return false
  // 预算按实际新增节点计: 落既有组 +1 原子; 无落点须新建 field 行组 = +2 (组壳+原子)
  const needsRow =
    !destination && !combination.include.children.some((child) => child.kind === 'group' && child.name === atom.field)
  if (
    tagRecConditionNodes(combination.include) + combination.exclude.length + (needsRow ? 2 : 1) >
    TAG_REC_COMBINATION_MAX_NODES
  )
    return false
  if (destination?.kind === 'group') {
    if (
      destination.children.some(
        (child) => child.kind === 'atom' && tagRecConditionKey(child) === tagRecConditionKey(atom),
      )
    )
      return false
    destination.children.push({ ...cloneDeep(atom), id: crypto.randomUUID() })
    return true
  }
  const root = combination.include
  let row = root.children.find(
    (child): child is TagRecConditionGroup => child.kind === 'group' && child.name === atom.field,
  )
  if (!row) {
    row = { kind: 'group', id: crypto.randomUUID(), mode: 'any', name: atom.field, children: [] }
    root.children.push(row)
  }
  if (row.children.some((child) => child.kind === 'atom' && tagRecConditionKey(child) === tagRecConditionKey(atom)))
    return false
  row.children.push({ ...cloneDeep(atom), id: crypto.randomUUID() })
  return true
}
export function removeTagRecCondition(combination: TagRecCombination, id: string): void {
  const remove = (node: TagRecConditionGroup) => {
    // 本来就空的组是用户建好的编辑落点 (组合卡里会继续投喂), 只有「被本次删空」的组才剪
    const emptyBefore = new Set(
      node.children.filter((child) => child.kind === 'group' && !child.children.length).map((child) => child.id),
    )
    node.children = node.children.filter((child) => child.id !== id)
    for (const child of node.children) if (child.kind === 'group') remove(child)
    node.children = node.children.filter(
      (child) => child.kind !== 'group' || child.children.length > 0 || emptyBefore.has(child.id),
    )
  }
  remove(combination.include)
  combination.exclude = combination.exclude.filter((atom) => atom.id !== id)
}
export function excludeTagRecCondition(combination: TagRecCombination, atom: TagRecConditionAtom): boolean {
  if (combination.exclude.some((entry) => tagRecConditionKey(entry) === tagRecConditionKey(atom))) return false
  combination.exclude.push({ ...cloneDeep(atom), id: crypto.randomUUID() })
  return true
}

/**
 * 整棵条件子树嫁接 (收藏组「整组导入」用): 克隆 node 作为目标组的子组落位,
 * 保留原 any/all 嵌套结构; 全树换 id —— 克隆节点 id 与库内/树上现存 id 撞车会让 find/remove 串组。
 * atom 级去重不做 (保结构优先); 受 MAX_NODES 预算约束, 空子树不落。
 */
export function graftTagRecConditionTree(
  combination: TagRecCombination,
  node: TagRecConditionNode,
  target?: string,
): boolean {
  if (node.kind !== 'group') return false
  const clone = cloneDeep(node)
  const reid = (n: TagRecConditionNode) => {
    n.id = crypto.randomUUID()
    if (n.kind === 'group') for (const child of n.children) reid(child)
  }
  reid(clone)
  const grafted = tagRecConditionNodes(clone)
  if (!tagRecConditionAtoms(clone).length) return false
  if (tagRecConditionNodes(combination.include) + combination.exclude.length + grafted > TAG_REC_COMBINATION_MAX_NODES)
    return false
  const destination = target ? findTagRecCondition(combination.include, target) : combination.include
  if (!destination || destination.kind !== 'group') return false
  destination.children.push(clone)
  return true
}
export function tagRecCombinationTagIds(combination: TagRecCombination): TagIdEntry[] {
  const tags = tagRecConditionAtoms(combination.include).flatMap((atom) => (atom.field === 'tag' ? [atom.value] : []))
  return [...new Map(tags.map((tag) => [tag.id, { ...tag }])).values()]
}
export function hasTagRecCombination(combination: TagRecCombination | undefined): boolean {
  return (
    !!combination &&
    validateTagRecCombination(combination) &&
    (tagRecConditionAtoms(combination.include).length > 0 ||
      combination.exclude.length > 0 ||
      (!!combination.filters &&
        Object.keys(combination.filters).some(
          (key) => key !== 'dims' || Object.keys(combination.filters!.dims).length > 0,
        )))
  )
}
/**
 * 扁平 tag_ids 播种为 tag 行原子 —— all-or-nothing: 预算不足返回 false 并保留已落部分。
 * 调用侧不得在 false 后仍按组合投影重导 tag_ids (未播种成员会被静默抹掉), 须整体放弃或拒载。
 */
export function seedTagRecCombination(combination: TagRecCombination, tagIds: readonly TagIdEntry[]): boolean {
  for (const tag of tagIds) if (!addTagRecCondition(combination, tagRecConditionAtom('tag', tag))) return false
  return true
}
export function tagRecCombinationOf(group: TagGroup): TagRecCombination {
  if (group.combination) return cloneDeep(group.combination)
  const result = newTagRecCombination()
  // 超预算时截断 —— 只读展示/派生可用; 落盘或回写原组前必须先过 tagRecCombinationOverflows
  seedTagRecCombination(result, group.tag_ids)
  return result
}
/** 该扁平组转组合是否会因节点预算截断 (工作台载入/回写原组前的守卫) */
export function tagRecCombinationOverflows(group: TagGroup): boolean {
  return !group.combination && !seedTagRecCombination(newTagRecCombination(), group.tag_ids)
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    )
  return value
}
export function tagRecCombinationSignature(combination: TagRecCombination): string {
  const canonical = (node: TagRecConditionNode): unknown =>
    node.kind === 'atom'
      ? tagRecConditionKey(node)
      : [
          node.mode,
          populatedChildren(node)
            .map(canonical)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ]
  return JSON.stringify([
    canonical(combination.include),
    combination.exclude.map(tagRecConditionKey).sort(),
    stable(combination.filters),
  ])
}
export function mergeTagRecCombinationFilters(
  ...patches: (TagRecSessionFilterPatch | undefined)[]
): TagRecSessionFilterPatch | undefined {
  const defined = patches.filter((patch) => patch !== undefined)
  if (defined.length <= 1) return defined[0]
  let result: TagRecSessionFilterPatch | undefined
  for (const patch of patches)
    if (patch) {
      const previous = result
      result = { ...previous, ...cloneDeep(patch), dims: { ...previous?.dims, ...cloneDeep(patch.dims) } }
      if (previous?.poolsEnabled || patch.poolsEnabled)
        result.poolsEnabled = { ...previous?.poolsEnabled, ...patch.poolsEnabled }
      if (previous?.pools || patch.pools) {
        result.pools = cloneDeep(previous?.pools ?? {})
        for (const [pool, upper] of Object.entries(patch.pools ?? {})) {
          const key = pool as keyof NonNullable<TagRecSessionFilterPatch['pools']>
          const lower = result.pools[key]
          const cell = { ...lower, ...cloneDeep(upper) }
          if (lower?.dims || upper.dims) cell.dims = { ...lower?.dims, ...cloneDeep(upper.dims) }
          if (lower?.score || upper.score) cell.score = mergeScore(lower?.score, upper.score)
          result.pools[key] = cell
        }
      }
      if (previous?.score || patch.score) result.score = mergeScore(previous?.score, patch.score)
    }
  return result
}
function mergeScore(lower?: TagRecSessionFilterPatch['score'], upper?: TagRecSessionFilterPatch['score']) {
  const result = { ...lower, ...upper }
  if (lower?.weights || upper?.weights) result.weights = { ...lower?.weights, ...upper?.weights }
  if (lower?.anchors || upper?.anchors) result.anchors = { ...lower?.anchors, ...upper?.anchors }
  return result
}
export function tagRecWorkingGroupSignature(group: TagGroup): string {
  return JSON.stringify([
    group.l1Id,
    group.combination && tagRecCombinationSignature(group.combination),
    stable(group.overrides),
  ])
}
/** Convert a copy, keeping the stored favorite unchanged and making all local lists editable. */
export function prepareTagRecWorkingGroup(group: TagGroup): TagGroup {
  const copy = cloneDeep(group)
  copy.combination = tagRecCombinationOf(copy)
  const negative = copy.overrides?.negative
  const exclude = (field: TagRecConditionField, entries: unknown[]) => {
    for (const value of entries) excludeTagRecCondition(copy.combination!, tagRecConditionAtom(field, value as never))
  }
  exclude('tag', negative?.tagIds ?? copy.negative_tag_ids ?? [])
  exclude('tag', negative?.tagBlock?.enabled ? negative.tagBlock.list : [])
  exclude('up', negative?.up ?? [])
  exclude('title', negative?.title ?? [])
  exclude('desc', negative?.desc ?? [])
  exclude(
    'partition',
    negative?.partitionBlock ?? (negative?.partition?.mode === 'block' ? negative.partition.list : []),
  )
  const allow = (field: TagRecConditionField, entries: unknown[]) => {
    if (!entries.length) return
    copy.combination!.include.children.push({
      kind: 'group',
      id: crypto.randomUUID(),
      mode: 'any',
      name: field,
      children: entries.map((value) => tagRecConditionAtom(field, value as never)),
    })
  }
  allow('tag', negative?.tagAllow?.enabled ? negative.tagAllow.list : [])
  allow('up', negative?.upAllow?.enabled ? negative.upAllow.list : [])
  allow('title', negative?.titleAllow?.enabled ? negative.titleAllow.list : [])
  allow('desc', negative?.descAllow?.enabled ? negative.descAllow.list : [])
  allow(
    'partition',
    negative?.partitionAllow?.enabled
      ? negative.partitionAllow.list
      : negative?.partition?.mode === 'allow'
        ? negative.partition.list
        : [],
  )
  if (copy.overrides) {
    const { negative: _negative, ...filters } = copy.overrides
    if (Object.keys(filters).length)
      copy.combination.filters = mergeTagRecCombinationFilters(
        { ...filters, dims: filters.dims ?? {} },
        copy.combination.filters,
      )
    delete copy.overrides
  }
  delete copy.negative_tag_ids
  delete copy.negative_strict
  return copy
}
export function describeTagRecCondition(node: TagRecConditionNode): string {
  if (node.kind === 'atom') return `${TAG_REC_CONDITION_FIELDS[node.field]}「${tagRecConditionLabel(node)}」`
  return node.children
    .map((child) => {
      const text = describeTagRecCondition(child)
      return child.kind === 'group' && child.children.length > 1 ? `（${text}）` : text
    })
    .filter(Boolean)
    .join(node.mode === 'all' ? ' 且 ' : ' 或 ')
}
export function nameTagRecCombination(combination: TagRecCombination): string {
  const positive = describeTagRecCondition(combination.include)
  const negative = combination.exclude.map(tagRecConditionLabel).join('、')
  return [positive || '内容组合', negative && `不看 ${negative}`].filter(Boolean).join(' · ')
}

export type TagRecConditionVerdict = {
  state: 'match' | 'mismatch' | 'unknown'
  missing: TagRecConditionField[]
  hits: number
}
function verdict(
  state: TagRecConditionVerdict['state'],
  missing: TagRecConditionField[] = [],
  hits = 0,
): TagRecConditionVerdict {
  return { state, missing, hits }
}
export function evalTagRecConditionAtom(item: TagRecItemExtend, atom: TagRecConditionAtom): TagRecConditionVerdict {
  let hit: boolean | undefined
  switch (atom.field) {
    case 'tag': {
      const id = atom.value.id
      const name = normalizeTagName(atom.value.name)
      // Complete IDs are authoritative; a same-name tag with another ID is not this tag.
      // Tag/top evidence may live on the merged claims rather than the top-level source
      // (e.g. the scoped recheck path), so tag/top claims are consulted too. Only the
      // tag/top route proves membership in its response, so the via gate here matches
      // relevance/attribution scoring — derived or future routes must not inherit it.
      const claimed = !!(
        item.source.tagIds?.includes(id) ||
        item.source.claims?.some((claim) => claim.via === 'tag-top' && claim.tagIds?.includes(id))
      )
      if (item.ownTagIds !== undefined) hit = item.ownTagIds.includes(id)
      else if (name && item.ownTagNames?.length) {
        // ownTagNames 是视频完整标签名单 (搜索响应的 tag 字段 / 补查的 Tags)：
        // 名字命中 => 命中；名字不在 => 确认不含这个标签，不能降级成 unknown 再逐条补查。
        hit = item.ownTagNames.some((tag) => normalizeTagName(tag) === name) || claimed
      } else hit = claimed || undefined

      break
    }
    case 'up': {
      const owner = item.owner
      if (atom.value.mid) hit = owner?.mid ? atom.value.mid === owner.mid : undefined
      else if (owner?.name && atom.value.name) hit = normalizeTagName(owner.name) === normalizeTagName(atom.value.name)

      break
    }
    case 'partition': {
      const state = evalTagRecPartitionEntry(item, atom.value)
      return verdict(state, state === 'unknown' ? ['partition'] : [], state === 'match' ? 1 : 0)
    }
    default: {
      const text = item[atom.field]
      if (text !== undefined && (atom.field !== 'title' || text || item.fieldEvidence?.title === 'complete')) {
        hit = normalizeTagName(text).includes(normalizeTagName(atom.value))
        if (!hit && atom.field === 'desc' && item.fieldEvidence?.desc !== 'complete') hit = undefined
      }
    }
  }
  return hit === undefined ? verdict('unknown', [atom.field]) : verdict(hit ? 'match' : 'mismatch', [], hit ? 1 : 0)
}
export function tagRecCombinationFilterConditions(combination: TagRecCombination): {
  include: TagRecConditionGroup[]
  exclude: TagRecConditionAtom[]
} {
  const result: { include: TagRecConditionGroup[]; exclude: TagRecConditionAtom[] } = { include: [], exclude: [] }
  if (combination.filters?.enabled === false) return result
  const fields = {
    tagAllow: 'tag',
    tagBlock: 'tag',
    upAllow: 'up',
    upBlacklist: 'up',
    titleAllow: 'title',
    titleKeywords: 'title',
    descAllow: 'desc',
    descKeywords: 'desc',
    partitionAllow: 'partition',
    partitionBlock: 'partition',
  } as const
  for (const [key, field] of Object.entries(fields)) {
    const rule = combination.filters?.dims[key as keyof typeof fields]
    if (!rule?.enabled || !rule.list.length) continue
    const atoms = rule.list.map((value, i) => {
      const atom = { kind: 'atom', id: `filter:${key}:${i}`, field, value }
      return atom as TagRecConditionAtom
    })
    if (key.endsWith('Allow')) result.include.push({ kind: 'group', id: `filter:${key}`, mode: 'any', children: atoms })
    else result.exclude.push(...atoms)
  }
  return result
}
export function evalTagRecCombination(item: TagRecItemExtend, combination: TagRecCombination): TagRecConditionVerdict {
  const matched = new Set<string>()
  const evaluate = (node: TagRecConditionNode): TagRecConditionVerdict => {
    if (node.kind === 'atom') {
      const result = evalTagRecConditionAtom(item, node)
      if (result.state === 'match') matched.add(tagRecConditionKey(node))
      return result
    }
    // Empty groups are editing destinations, not an always-true branch inside OR.
    const results = populatedChildren(node).map(evaluate)
    if (!results.length) return verdict('match')
    const state =
      node.mode === 'all'
        ? results.some((r) => r.state === 'mismatch')
          ? 'mismatch'
          : results.some((r) => r.state === 'unknown')
            ? 'unknown'
            : 'match'
        : results.some((r) => r.state === 'match')
          ? 'match'
          : results.some((r) => r.state === 'unknown')
            ? 'unknown'
            : 'mismatch'
    return verdict(
      state,
      state === 'unknown' ? [...new Set(results.flatMap((r) => r.missing))] : [],
      results.reduce((sum, r) => sum + r.hits, 0),
    )
  }
  const lists = tagRecCombinationFilterConditions(combination)
  const positive = evaluate({ ...combination.include, mode: 'all', children: [combination.include, ...lists.include] })
  const exclusions = [...combination.exclude, ...lists.exclude].map((atom) => evalTagRecConditionAtom(item, atom))
  if (positive.state === 'mismatch' || exclusions.some((r) => r.state === 'match')) return verdict('mismatch')
  const missing = [...new Set([...positive.missing, ...exclusions.flatMap((r) => r.missing)])]
  return verdict(missing.length ? 'unknown' : 'match', missing, matched.size)
}

export type TagRecDeliverableState = 'match' | 'pending' | 'mismatch'
/**
 * 命中本组合的排除/屏蔽 (exclude 原子 + 组合显式过滤名单里的 block 类) —— 与 include 的
 * mismatch 区分开: 小池降级的「相关兜底放行」只豁免 include 不符, 排除必须保持绝对。
 */
export function isTagRecCombinationExcluded(item: TagRecItemExtend, combination: TagRecCombination): boolean {
  // 组合 exclude 原子恒查 —— filters.enabled 只门控辅助名单派生项 (lists.exclude 内部已判),
  //   不能拿辅助开关放行用户明确写进组合的排除 (兜底路径靠本函数守排除底线)
  const lists = tagRecCombinationFilterConditions(combination)
  return [...combination.exclude, ...lists.exclude].some(
    (atom) => evalTagRecConditionAtom(item, atom).state === 'match',
  )
}
/**
 * 单一交付口径 (spec 05 一致性契约): 当前组合下条目的三态结论 ——
 * match = 已证明满足 (可交付, 占库存); pending = 证据不足 (待核实: 展示计数但不占库存、不阻断取新);
 * mismatch = 已证明不满足 (滤除)。库存视图 / 来源状态 / 交付闸共用此判定:
 * 原始候选 ≠ 可交付库存 ≠ 未知暂存。
 */
export function tagRecDeliverable(
  item: TagRecItemExtend,
  combination: TagRecCombination | undefined,
): TagRecDeliverableState {
  if (!combination) return 'match'
  const state = evalTagRecCombination(item, combination).state
  return state === 'unknown' ? 'pending' : state
}

/** Unknown operators and malformed hard conditions must never fall back to a wider tag-only group. */
/** 原子值分 field 判定 (validateTagRecCombination 原子分支抽出; 旧包升格按同档预过滤不可表达原子) */
export function tagRecConditionAtomValueValid(node: { field: string; value: unknown }): boolean {
  const v = node.value as Record<string, unknown> & { name?: unknown }
  if (node.field === 'title' || node.field === 'desc')
    return typeof node.value === 'string' && normalizeTagName(node.value).length >= 2 && node.value.length <= 200
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200) return false
  if (node.field === 'tag')
    return (
      Object.keys(v).every((key) => ['id', 'name', 'tag_type'].includes(key)) &&
      (v.tag_type === undefined || ['topic', 'old_channel', 'bgm'].includes(v.tag_type as string)) &&
      Number.isSafeInteger(v.id) &&
      (v.id as number) > 0 &&
      !!v.name.trim()
    )
  if (node.field === 'up')
    return (
      Object.keys(v).every((key) => ['name', 'mid'].includes(key)) &&
      !!v.name.trim() &&
      (v.mid === undefined || (Number.isSafeInteger(v.mid) && (v.mid as number) > 0))
    )
  if (node.field === 'partition')
    return (
      Object.keys(v).every((key) => ['name', 'v1', 'v2', 'level'].includes(key)) &&
      (v.level === undefined || v.level === 'parent' || v.level === 'leaf') &&
      [v.v1, v.v2].some((id) => Number.isSafeInteger(id) && (id as number) > 0) &&
      [v.v1, v.v2].every((id) => id === undefined || (Number.isSafeInteger(id) && (id as number) > 0))
    )
  return false
}
export function validateTagRecCombination(value: unknown): value is TagRecCombination {
  if (!value || typeof value !== 'object') return false
  const combo = value as TagRecCombination
  if (
    Array.isArray(value) ||
    combo.version !== 1 ||
    !Array.isArray(combo.exclude) ||
    combo.include?.kind !== 'group' ||
    (combo.filters !== undefined && !validateTagRecCombinationFilters(combo.filters))
  )
    return false
  if (Object.keys(combo).some((key) => !['version', 'include', 'exclude', 'filters'].includes(key))) return false
  let count = 0
  const ids = new Set<string>()
  const valid = (node: TagRecConditionNode, depth: number): boolean => {
    if (
      !node ||
      typeof node !== 'object' ||
      typeof node.id !== 'string' ||
      !node.id ||
      node.id.length > 128 ||
      ids.has(node.id) ||
      ++count > TAG_REC_COMBINATION_MAX_NODES ||
      depth > TAG_REC_COMBINATION_MAX_DEPTH
    )
      return false
    ids.add(node.id)
    if (
      Object.keys(node).some(
        (key) =>
          !(
            node.kind === 'group' ? ['kind', 'id', 'mode', 'name', 'children'] : ['kind', 'id', 'field', 'value']
          ).includes(key),
      )
    )
      return false
    if (node.kind === 'group')
      return (
        (node.mode === 'any' || node.mode === 'all') &&
        (node.name === undefined || (typeof node.name === 'string' && node.name.length <= 200)) &&
        Array.isArray(node.children) &&
        node.children.every((child) => valid(child, depth + 1))
      )
    if (node.kind !== 'atom') return false
    return tagRecConditionAtomValueValid(node)
  }
  return valid(combo.include, 0) && combo.exclude.every((atom) => atom?.kind === 'atom' && valid(atom, 0))
}

/** Physical seeds are separate from the predicate; a search word is never evidence of a tag or author. */
export function tagRecCombinationSeeds(combination: TagRecCombination) {
  const atoms = tagRecConditionAtoms(combination.include)
  const tags = tagRecCombinationTagIds(combination)
  const ups = atoms.flatMap((atom) => (atom.field === 'up' ? [atom.value] : []))
  const words = [
    ...new Set(atoms.flatMap((atom) => (atom.field === 'title' || atom.field === 'desc' ? [atom.value] : []))),
  ]
  const keywords = [...new Set([...tags.map((tag) => tag.name), ...words])]
  if (!keywords.length && ups.some((up) => !up.mid)) keywords.push(...ups.map((up) => up.name))
  if (!keywords.length && !ups.length)
    keywords.push(...atoms.flatMap((atom) => (atom.field === 'partition' ? [atom.value.name] : [])))
  return { tags, ups, keywords: keywords.length ? keywords : ups.length ? [''] : ['热门'] }
}
export function tagRecCombinationRequiresUp(combination: TagRecCombination): boolean {
  const requires = (node: TagRecConditionNode): boolean => {
    if (node.kind === 'atom') return node.field === 'up'
    const children = populatedChildren(node)
    return children.length > 0 && (node.mode === 'all' ? children.some(requires) : children.every(requires))
  }
  return requires(combination.include)
}
