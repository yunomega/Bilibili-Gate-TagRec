import { hasTagRecCombination } from './combination'
import { groupTagMatches } from './tag-peek'
import { TAG_REC_VIEW_UNASSIGNED, tagRecViewBucketOf } from './view-scope'
import type { TagRecThemeScopeDraft } from './theme-scope-draft'
import type { TagGroup, TagL1Group, TagTheme } from './types'

const EMPTY_GROUPS: readonly TagGroup[] = []
const EMPTY_L1S: readonly TagL1Group[] = []
type ThemeBucket = { id: string; name: string }

/** 收藏快照变化时建一次索引；草稿、搜索和展开不再扫描整棵树查父子归属。 */
export function buildTagRecScopeIndex(
  groups: readonly TagGroup[],
  l1s: readonly TagL1Group[],
  themes: readonly Pick<TagTheme, 'id' | 'name'>[],
) {
  const themeIds = new Set(themes.map((t) => t.id))
  const buckets: ThemeBucket[] = [
    ...themes.map((t) => ({ id: t.id, name: t.name })),
    { id: TAG_REC_VIEW_UNASSIGNED, name: '未归属' },
  ]
  const l1ById = new Map(l1s.map((l) => [l.id, l]))
  const l1sByBucket = new Map<string, TagL1Group[]>()
  const groupsByL1 = new Map<string, TagGroup[]>()
  const groupsByBucket = new Map<string, TagGroup[]>()
  const selectableIds = new Set<string>()
  const available: TagGroup[] = []
  const savedSelection: TagRecThemeScopeDraft = {}
  for (const l of l1s) {
    const bucket = tagRecViewBucketOf(l, themeIds)
    const items = l1sByBucket.get(bucket) ?? []
    items.push(l)
    l1sByBucket.set(bucket, items)
  }
  for (const g of groups) {
    const parent = g.l1Id ? l1ById.get(g.l1Id) : undefined
    if (g.l1Id) {
      const children = groupsByL1.get(g.l1Id) ?? []
      children.push(g)
      groupsByL1.set(g.l1Id, children)
    }
    if (parent) {
      const bucket = tagRecViewBucketOf(parent, themeIds)
      const items = groupsByBucket.get(bucket) ?? []
      items.push(g)
      groupsByBucket.set(bucket, items)
    }
    const hasConditions = g.tag_ids.length > 0 || hasTagRecCombination(g.combination)
    savedSelection[g.id] = !!parent?.enabled && g.enabled && hasConditions
    if (hasConditions && g.weight > 0 && parent && parent.weight > 0) {
      selectableIds.add(g.id)
      available.push(g)
    }
  }
  return {
    themeIds,
    buckets,
    l1ById,
    available,
    savedSelection,
    selectable: (g: TagGroup) => selectableIds.has(g.id),
    l1sOf: (id: string): readonly TagL1Group[] => l1sByBucket.get(id) ?? EMPTY_L1S,
    childrenOf: (id: string): readonly TagGroup[] => groupsByL1.get(id) ?? EMPTY_GROUPS,
    groupsOfBucket: (id: string): readonly TagGroup[] => groupsByBucket.get(id) ?? EMPTY_GROUPS,
  }
}

export type TagRecScopeIndex = ReturnType<typeof buildTagRecScopeIndex>
export type TagRecScopeRow =
  | { kind: 'theme'; key: string; bucket: ThemeBucket }
  | { kind: 'l1'; key: string; l1: TagL1Group; contextOnly: boolean }
  | { kind: 'group'; key: string; l1: TagL1Group; group: TagGroup }
  | { kind: 'empty'; key: string }

/** 展平数据而非 JSX，让动态高度的组内标签也能随所在行虚拟渲染。 */
export function buildTagRecScopeRows(
  index: TagRecScopeIndex,
  bucketId: string,
  expanded: ReadonlySet<string>,
  query: string,
): TagRecScopeRow[] {
  const q = query.trim().toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(q)
  const rows: TagRecScopeRow[] = []
  const append = (l1: TagL1Group, contextOnly: boolean, children: readonly TagGroup[], showChildren: boolean) => {
    rows.push({ kind: 'l1', key: `l1:${l1.id}`, l1, contextOnly })
    if (!showChildren) return
    for (const group of children) rows.push({ kind: 'group', key: `group:${group.id}`, l1, group })
    if (!children.length) rows.push({ kind: 'empty', key: `empty:${l1.id}` })
  }
  if (!q) {
    for (const l of index.l1sOf(bucketId)) append(l, false, index.childrenOf(l.id), expanded.has(l.id))
    return rows
  }
  for (const bucket of index.buckets) {
    const themeMatch = matches(bucket.name)
    let addedHeader = false
    for (const l of index.l1sOf(bucket.id)) {
      const ancestorMatch = themeMatch || matches(l.name)
      const children = index.childrenOf(l.id)
      const shown = ancestorMatch ? children : children.filter((g) => groupTagMatches(g, q))
      if (!ancestorMatch && !shown.length) continue
      if (!addedHeader) {
        rows.push({ kind: 'theme', key: `theme:${bucket.id}`, bucket })
        addedHeader = true
      }
      append(l, !ancestorMatch, shown, true)
    }
  }
  return rows
}
