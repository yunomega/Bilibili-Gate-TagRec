import { hasTagRecCombination } from './combination'
import { tagRecViewBucketOf, tagRecViewScopeViewedIds, type TagRecViewScope } from './view-scope'
import type { TagGroup, TagL1Group } from './types'

export type TagRecThemeScopeDraft = Record<string, boolean>
/** 缺少父组键表示跟随所有二级组的保存状态；数组表示该父组的精确临时范围。 */
export type TagRecGroupScope = Record<string, string[]>

export function tagRecViewedGroupIds(groups: readonly TagGroup[], scope: TagRecGroupScope): Set<string> | undefined {
  if (!Object.keys(scope).length) return undefined
  return new Set(groups.filter((g) => !g.l1Id || !scope[g.l1Id] || scope[g.l1Id].includes(g.id)).map((g) => g.id))
}

export function createTagRecGroupScopeDraft(
  groups: readonly TagGroup[],
  l1s: readonly TagL1Group[],
  themeIds: ReadonlySet<string>,
  scope: TagRecViewScope,
  groupScope: TagRecGroupScope,
  temporaryL1s: readonly string[],
  temporaryGroups: readonly string[],
): TagRecThemeScopeDraft {
  const parents = createTagRecThemeScopeDraft(l1s, themeIds, scope, temporaryL1s)
  const viewed = tagRecViewedGroupIds(groups, groupScope)
  const temporary = new Set(temporaryGroups)
  return Object.fromEntries(
    groups.map((g) => [
      g.id,
      !!g.l1Id &&
        !!parents[g.l1Id] &&
        (g.tag_ids.length > 0 || hasTagRecCombination(g.combination)) &&
        (!viewed || viewed.has(g.id)) &&
        (g.enabled || temporary.has(g.id)),
    ]),
  )
}

export function materializeTagRecGroupScopeDraft(
  draft: TagRecThemeScopeDraft,
  groups: readonly TagGroup[],
  l1s: readonly TagL1Group[],
  themeIds: ReadonlySet<string>,
): { scope: TagRecViewScope; groupScope: TagRecGroupScope; temporary: string[]; temporaryGroups: string[] } {
  const parentDraft: TagRecThemeScopeDraft = {}
  const groupScope: TagRecGroupScope = {}
  const temporaryGroups: string[] = []
  for (const l of l1s) {
    const children = groups.filter((g) => g.l1Id === l.id)
    const selected = children.filter(
      (g) => (g.tag_ids.length > 0 || hasTagRecCombination(g.combination)) && (draft[g.id] ?? (l.enabled && g.enabled)),
    )
    parentDraft[l.id] = children.length ? selected.length > 0 : l.enabled
    if (children.some((g) => g.enabled && !selected.some((s) => s.id === g.id))) {
      groupScope[l.id] = selected.map((g) => g.id)
    }
    temporaryGroups.push(...selected.filter((g) => !g.enabled).map((g) => g.id))
  }
  return { ...materializeTagRecThemeScopeDraft(parentDraft, l1s, themeIds), groupScope, temporaryGroups }
}

/** 草稿只在面板内变化；未覆盖的一级组继续跟随收藏表启用状态。 */
export function createTagRecThemeScopeDraft(
  l1s: readonly TagL1Group[],
  themeIds: ReadonlySet<string>,
  scope: TagRecViewScope,
  temporary: readonly string[],
): TagRecThemeScopeDraft {
  const viewed = tagRecViewScopeViewedIds(scope, l1s, themeIds)
  const temp = new Set(temporary)
  return Object.fromEntries(l1s.map((l) => [l.id, viewed.has(l.id) && (l.enabled || temp.has(l.id))]))
}

/** 仅记录与收藏表不同的会话覆盖，不把关闭的一级组算成主题全选。 */
export function materializeTagRecThemeScopeDraft(
  draft: TagRecThemeScopeDraft,
  l1s: readonly TagL1Group[],
  themeIds: ReadonlySet<string>,
): { scope: TagRecViewScope; temporary: string[] } {
  const scope: TagRecViewScope = {}
  const temporary: string[] = []
  for (const l of l1s) {
    const on = draft[l.id] ?? l.enabled
    if (on && !l.enabled) temporary.push(l.id)
    if (l.enabled && !on) {
      const bucket = tagRecViewBucketOf(l, themeIds)
      scope[bucket] ??= l1s
        .filter((x) => tagRecViewBucketOf(x, themeIds) === bucket && (draft[x.id] ?? x.enabled))
        .map((x) => x.id)
    }
  }
  return { scope, temporary }
}
