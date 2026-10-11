import { normalizeTagName } from './tag-norm'
import type { TagIdEntry } from './types'

type Group = { id: string; name: string; l1Id?: string; tag_ids: readonly TagIdEntry[] }
type L1 = { id: string; name: string; themeId?: string }
type Theme = { id: string; name: string }

/** 本地收藏层级索引: 每条正向成员最多进入 L2/L1/主题三张表, 不读负向或配置。 */
export function createTagRecFavoriteTagIndex(groups: readonly Group[], l1s: readonly L1[], themes: readonly Theme[]) {
  const l1ById = new Map(l1s.map((l1) => [l1.id, l1]))
  const themeById = new Map(themes.map((theme) => [theme.id, theme]))
  const entries = new Map<string, Map<number, TagIdEntry>>()
  const add = (key: string, tags: readonly TagIdEntry[]) => {
    let index = entries.get(key)
    if (!index) entries.set(key, (index = new Map()))
    for (const tag of tags) if (!index.has(tag.id)) index.set(tag.id, tag)
  }
  for (const group of groups) {
    add(`l2:${group.id}`, group.tag_ids)
    const l1 = group.l1Id ? l1ById.get(group.l1Id) : undefined
    if (!l1) continue
    add(`l1:${l1.id}`, group.tag_ids)
    if (l1.themeId && themeById.has(l1.themeId)) add(`theme:${l1.themeId}`, group.tag_ids)
  }
  const option = (value: string, level: string, names: string[]) => {
    const count = entries.get(value)?.size ?? 0
    const path = names.filter(Boolean).join(' / ')
    return {
      value,
      label: `${level} · ${path} (${count} 标签)`,
      search: normalizeTagName(`${level} ${path}`),
      disabled: !count,
    }
  }
  const options = [
    ...themes.map((theme) => option(`theme:${theme.id}`, '主题', [theme.name])),
    ...l1s.map((l1) => option(`l1:${l1.id}`, '一级组', [themeById.get(l1.themeId ?? '')?.name ?? '', l1.name])),
    ...groups.map((group) => {
      const l1 = l1ById.get(group.l1Id ?? '')
      return option(`l2:${group.id}`, '二级组', [
        themeById.get(l1?.themeId ?? '')?.name ?? '',
        l1?.name ?? '',
        group.name,
      ])
    }),
  ]
  return {
    options,
    /** 确认时复制快照, 同时选主题与其子组也只返回一份成员。 */
    select(values: readonly string[]): TagIdEntry[] {
      const selected = new Map<number, TagIdEntry>()
      for (const value of values) {
        for (const [id, entry] of entries.get(value) ?? []) if (!selected.has(id)) selected.set(id, { ...entry })
      }
      return [...selected.values()]
    },
  }
}
