import { tagRecConditionLabel, type TagRecConditionAtom, type TagRecConditionField } from '../model/combination'

/**
 * 书架行的药丸串: 把一整句条件 (describeTagRecCondition) 折成可扫读的小药丸,
 * 组间/组内关系保留成 且 / 或 连接词, 溢出折成 +N, 排除项折成 不看 + 红药丸。
 * 整句仍然挂在 title 上, 药丸只是摘要。
 */
export type TagRecCombinationPillItem =
  | { kind: 'pill'; key: string; field: TagRecConditionField; label: string }
  | { kind: 'exclude'; key: string; label: string }
  | { kind: 'join'; key: string; label: string }
  | { kind: 'more'; key: string; label: string }

/** 只读遍历形态: valtio snapshot 的深只读组合同样可入 (children 只读数组)。 */
type PillGroup = { kind: 'group'; mode: 'any' | 'all'; children: readonly PillTree[] }
type PillTree = TagRecConditionAtom | PillGroup

type Slot = { atom: TagRecConditionAtom; join?: 'and' | 'or' }

/** 按出现顺序摊平条件; 每个条件的 join 由它所在组的 mode 决定 (首个条件继承组的入边)。 */
function collectSlots(node: PillGroup, join: Slot['join'], out: Slot[]) {
  node.children.forEach((child, index) => {
    const childJoin = index === 0 ? join : node.mode === 'all' ? 'and' : 'or'
    if (child.kind === 'atom') out.push({ atom: child, join: childJoin })
    else collectSlots(child, childJoin, out)
  })
}

export function tagRecCombinationPills(
  combination: { include: PillGroup; exclude: readonly TagRecConditionAtom[] },
  { limit = 3, excludeLimit = 1 }: { limit?: number; excludeLimit?: number } = {},
): TagRecCombinationPillItem[] {
  const slots: Slot[] = []
  collectSlots(combination.include, undefined, slots)
  const items: TagRecCombinationPillItem[] = []
  for (const slot of slots.slice(0, limit)) {
    if (items.length && slot.join)
      items.push({ kind: 'join', key: `${slot.atom.id}:join`, label: slot.join === 'and' ? '且' : '或' })
    items.push({ kind: 'pill', key: slot.atom.id, field: slot.atom.field, label: tagRecConditionLabel(slot.atom) })
  }
  if (slots.length > limit) items.push({ kind: 'more', key: 'include:more', label: `+${slots.length - limit}` })

  const excluded = combination.exclude.slice(0, excludeLimit)
  if (excluded.length) {
    items.push({ kind: 'join', key: 'exclude:join', label: '不看' })
    for (const atom of excluded) items.push({ kind: 'exclude', key: atom.id, label: tagRecConditionLabel(atom) })
    if (combination.exclude.length > excluded.length)
      items.push({
        kind: 'more',
        key: 'exclude:more',
        label: `+${combination.exclude.length - excluded.length}`,
      })
  }
  return items
}
