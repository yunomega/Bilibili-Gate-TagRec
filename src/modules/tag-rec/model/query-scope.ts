import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type { TagIdEntry } from './types'

/** 仅看是原查询内的交集；相关来源须有标签或标题证据，归因名不能证明命中查询。 */
export function createTagRecQueryMatcher(entries: readonly TagIdEntry[]) {
  const ids = new Set(entries.map((entry) => entry.id))
  const names = new Set(entries.map((entry) => normalizeTagName(entry.name)).filter(Boolean))
  const titleTerms = [...names].filter((name) => name.length >= 2)
  return (item: TagRecItemExtend): boolean => {
    // 两种主来源已按查询取池/判定；不要求 tag/top 再补查自身标签。
    if (item.source.via === 'tag-top' || item.source.via === 'all-v2-exact') return true
    if (item.source.via === 'up-search') return names.has(normalizeTagName(item.source.queryKeyword ?? ''))
    if (item.ownTagIds?.some((id) => ids.has(id))) return true
    if (item.ownTagNames?.some((name) => names.has(normalizeTagName(name)))) return true
    const title = normalizeTagName(item.title)
    return titleTerms.some((term) => title.includes(term))
  }
}
