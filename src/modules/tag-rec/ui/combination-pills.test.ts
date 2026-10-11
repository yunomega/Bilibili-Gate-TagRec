import { describe, expect, it } from 'vitest'
import { newTagRecCombination, tagRecConditionAtom, type TagRecCombination } from '../model/combination'
import { tagRecCombinationPills } from './combination-pills'

function combinationOf(build: (combination: TagRecCombination) => void): TagRecCombination {
  const combination = newTagRecCombination()
  build(combination)
  return combination
}
function group(mode: 'any' | 'all', children: TagRecCombination['include']['children']): TagRecCombination['include'] {
  return { kind: 'group', id: `g-${mode}`, mode, children }
}
const label = (items: ReturnType<typeof tagRecCombinationPills>) =>
  items
    .map((item) => {
      if (item.kind === 'join' || item.kind === 'more') return item.label
      if (item.kind === 'exclude') return `excl:${item.label}`
      return `${item.field}:${item.label}`
    })
    .join(' ')

describe('书架药丸串: 长条件折成可扫读的摘要', () => {
  it('单组多标签折成 且 连接, 溢出折成 +N, 排除折成 不看 + 红药丸', () => {
    const combination = combinationOf((current) => {
      for (const [id, name] of [
        [1, '原神'],
        [2, '原神 4.0'],
        [3, '原神 5.0'],
      ] as const)
        current.include.children.push(tagRecConditionAtom('tag', { id, name }))
      current.include.children.push(tagRecConditionAtom('title', '攻略'))
      current.exclude.push(tagRecConditionAtom('tag', { id: 9, name: '代肝' }))
    })
    expect(label(tagRecCombinationPills(combination))).toBe(
      'tag:原神 且 tag:原神 4.0 且 tag:原神 5.0 +1 不看 excl:代肝',
    )
  })

  it('嵌套组摊平后仍按出现顺序取前 N 个, 组内 any 用 或 连接', () => {
    const combination = combinationOf((current) => {
      current.include.children.push(
        group('any', [
          tagRecConditionAtom('tag', { id: 1, name: '原神' }),
          tagRecConditionAtom('tag', { id: 2, name: '原神 4.0' }),
        ]),
        tagRecConditionAtom('up', { name: '洛雪高', mid: 11 }),
        tagRecConditionAtom('partition', { name: '游戏', v1: 4, level: 'parent' }),
      )
    })
    expect(label(tagRecCombinationPills(combination, { limit: 3 }))).toBe('tag:原神 或 tag:原神 4.0 且 up:洛雪高 +1')
    expect(label(tagRecCombinationPills(combination, { limit: 2 }))).toBe('tag:原神 或 tag:原神 4.0 +2')
  })

  it('空组合返回空数组 (由调用方回落文案), 排除溢出单独折叠', () => {
    const empty = newTagRecCombination()
    expect(tagRecCombinationPills(empty)).toEqual([])

    const combination = combinationOf((current) => {
      current.include.children.push(tagRecConditionAtom('tag', { id: 1, name: '原神' }))
      current.exclude.push(
        tagRecConditionAtom('tag', { id: 9, name: '代肝' }),
        tagRecConditionAtom('tag', { id: 10, name: '搬砖' }),
      )
    })
    expect(label(tagRecCombinationPills(combination))).toBe('tag:原神 不看 excl:代肝 +1')
  })
})
