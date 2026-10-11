import { stripRelatedSuffix } from './dig'
import type { TagGroup } from './types'

type OwnerGroup = Readonly<Pick<TagGroup, 'id' | 'name'>>
type OwnerIndex = { ids: Map<string, number[]>; names: Map<string, number[]> }

// 只接收不可变的收藏快照；一次建索引供整批卡片复用，避免逐卡遍历 Valtio 跟踪代理。
const indices = new WeakMap<readonly OwnerGroup[], OwnerIndex>()

export function lookupSnapshotCardOwners<G extends OwnerGroup>(
  groups: readonly G[],
  sourceNames: readonly string[],
  sourceIds?: readonly string[],
): { matched: G[]; hasUnowned: boolean } {
  if (!sourceIds?.length && !sourceNames.length) return { matched: [], hasUnowned: false }

  let index = indices.get(groups)
  if (!index) {
    index = { ids: new Map(), names: new Map() }
    groups.forEach((group, position) => {
      for (const [map, key] of [
        [index!.ids, group.id],
        [index!.names, group.name],
      ] as const) {
        const positions = map.get(key)
        if (positions) positions.push(position)
        else map.set(key, [position])
      }
    })
    indices.set(groups, index)
  }

  const positions = new Set<number>()
  let hasUnowned = false
  if (sourceIds?.length) {
    for (const id of sourceIds) for (const position of index.ids.get(id) ?? []) positions.add(position)
  } else {
    for (const sourceName of sourceNames) {
      const found = index.names.get(stripRelatedSuffix(sourceName))
      if (!found) hasUnowned = true
      else if (found.length === 1) positions.add(found[0]!)
    }
  }
  // 与 resolveLandingGroups 一致：收藏表顺序、稳定 ID 优先、旧名称仅唯一匹配。
  return { matched: [...positions].sort((a, b) => a - b).map((position) => groups[position]!), hasUnowned }
}
