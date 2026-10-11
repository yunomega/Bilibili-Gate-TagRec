import { describe, expect, it } from 'vitest'
import { newTagRecCombination, tagRecConditionAtom } from './combination'
import { buildTagRecScopeIndex, buildTagRecScopeRows } from './theme-scope-tree'
import { TAG_REC_VIEW_UNASSIGNED } from './view-scope'
import type { TagGroup, TagL1Group } from './types'

const themes = [{ id: 't', name: '主题 T' }]
const l1s: TagL1Group[] = [
  { id: 'a', name: '作品 A', themeId: 't', enabled: true, weight: 1, addedAt: 1 },
  { id: 'b', name: '作品 B', themeId: 't', enabled: false, weight: 1, addedAt: 1 },
  { id: 'unassigned', name: '旧主题作品', themeId: 'removed', enabled: true, weight: 1, addedAt: 1 },
  { id: 'paused', name: '挂起作品', themeId: 't', enabled: true, weight: 0, addedAt: 1 },
  { id: 'empty', name: '空作品', themeId: 't', enabled: true, weight: 1, addedAt: 1 },
]
const group = (id: string, l1Id = 'a', patch: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: id,
  l1Id,
  enabled: true,
  weight: 1,
  addedAt: 1,
  tag_ids: [{ id: 1, name: '学生会' }],
  ...patch,
})
const groups = [
  group('a1', 'a', { name: '學生會' }),
  group('a2', 'a', { enabled: false, tag_ids: [{ id: 2, name: '别名' }] }),
  group('b1', 'b'),
  group('u1', 'unassigned'),
  group('paused-child', 'a', { weight: 0 }),
  group('paused-parent', 'paused'),
  group('empty-child', 'a', { tag_ids: [] }),
  group('orphan', 'missing'),
]

describe('主题选择器索引与可滚动结果', () => {
  it('允许临时选择停用父子，仍排除挂起、空条件和缺失父组', () => {
    const index = buildTagRecScopeIndex(groups, l1s, themes)
    expect(index.available.map((g) => g.id)).toEqual(['a1', 'a2', 'b1', 'u1'])
    expect(index.savedSelection.a2).toBe(false)
    expect(index.savedSelection.b1).toBe(false)
    expect(index.savedSelection['paused-child']).toBe(true)
    expect(index.savedSelection.orphan).toBe(false)
  })

  it('完整组合无需正向标签也可以选择；未知主题留在未归属', () => {
    const combination = newTagRecCombination()
    combination.include.children.push(tagRecConditionAtom('title', '标题词'))
    const index = buildTagRecScopeIndex(
      [...groups, group('combination', 'a', { tag_ids: [], combination })],
      l1s,
      themes,
    )
    expect(index.selectable(index.childrenOf('a').at(-1)!)).toBe(true)
    expect(index.groupsOfBucket(TAG_REC_VIEW_UNASSIGNED).map((g) => g.id)).toEqual(['u1'])
    expect(index.groupsOfBucket('t').some((g) => g.id === 'orphan')).toBe(false)
  })

  it('折叠时仍保留所有一级组，展开只添加该一级组的子行', () => {
    const index = buildTagRecScopeIndex(groups, l1s, themes)
    const closed = buildTagRecScopeRows(index, 't', new Set(), '')
    expect(closed.map((r) => r.key)).toEqual(['l1:a', 'l1:b', 'l1:paused', 'l1:empty'])
    const expanded = buildTagRecScopeRows(index, 't', new Set(['b', 'empty']), '')
    expect(expanded.map((r) => r.key)).toEqual(['l1:a', 'l1:b', 'group:b1', 'l1:paused', 'l1:empty', 'empty:empty'])
  })

  it('标签别名命中时保留上下文、只显示命中的组；结果可跨主题', () => {
    const index = buildTagRecScopeIndex(groups, l1s, themes)
    const rows = buildTagRecScopeRows(index, 't', new Set(), ' 学生会 ')
    expect(rows.filter((r) => r.kind === 'group').map((r) => r.group.id)).toEqual([
      'a1',
      'paused-child',
      'b1',
      'paused-parent',
      'u1',
    ])
    expect(rows.filter((r) => r.kind === 'l1').every((r) => r.contextOnly)).toBe(true)
    expect(rows.filter((r) => r.kind === 'theme').map((r) => r.bucket.id)).toEqual(['t', TAG_REC_VIEW_UNASSIGNED])
  })

  it('一级组名命中会显示完整子树，空一级组仍能命中并显示空提示', () => {
    const index = buildTagRecScopeIndex(groups, l1s, themes)
    const rows = buildTagRecScopeRows(index, 't', new Set(), '作品 A')
    expect(rows.filter((r) => r.kind === 'group').map((r) => r.group.id)).toEqual([
      'a1',
      'a2',
      'paused-child',
      'empty-child',
    ])
    expect(rows.find((r) => r.kind === 'l1')).toMatchObject({ contextOnly: false })
    expect(buildTagRecScopeRows(index, 't', new Set(), '空作品').map((r) => r.key)).toEqual([
      'theme:t',
      'l1:empty',
      'empty:empty',
    ])
    expect(buildTagRecScopeRows(index, 't', new Set(), '不匹配任何项')).toEqual([])
  })

  it('主题命中完整保留 535 个组和 73 个 L1，不以丢弃结果限制挂载数量', () => {
    const parents = Array.from({ length: 73 }, (_, i) => ({ ...l1s[0], id: `l${i}` }))
    const leaves = Array.from({ length: 535 }, (_, i) => group(`g${i}`, `l${i % 73}`))
    const index = buildTagRecScopeIndex(leaves, parents, themes)
    const rows = buildTagRecScopeRows(index, 't', new Set(), '主题 T')
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(535)
    expect(rows.filter((r) => r.kind === 'l1')).toHaveLength(73)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})
