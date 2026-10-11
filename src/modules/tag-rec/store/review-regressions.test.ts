import { describe, expect, it, vi } from 'vitest'
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'audit', APP_NAMESPACE: 'audit' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))
vi.mock('$modules/tag-rec/api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve(undefined)), setValue: vi.fn(() => Promise.resolve()) })
vi.useFakeTimers()
const { favorites, favoritesStore, favoritesL1Store } = await import('$modules/tag-rec/store')
vi.runAllTimers()
vi.useRealTimers()

const { groupNegativeMerged } = await import('$modules/tag-rec/model/filter-engine')
const { classifyVideoTagStatus } = await import('$modules/tag-rec/model/tag-status')
const { makeTagGroup } = await import('$modules/tag-rec/model/favorites')
const { applyTagRecImport } = await import('$modules/tag-rec/store/apply-import')
const { switchTagRecGroupContext, tagRecCustomSession } = await import('$modules/tag-rec/store/session')

describe('audit: structured negative tag mutation', () => {
  it('merge-to-new creates a fresh identity, preserves the base parent/config, and removes only source groups', () => {
    favoritesL1Store.list = [{ id: 'parent', name: 'Parent', enabled: true, weight: 1, addedAt: 1 }]
    favoritesStore.list = [
      makeTagGroup({
        id: 'a',
        l1Id: 'parent',
        addedAt: 1,
        weight: 0,
        tag_ids: [{ id: 1, name: 'one' }],
        overrides: { poolsEnabled: { archiveRelated: false } },
      })!,
      makeTagGroup({ id: 'b', l1Id: 'parent', addedAt: 2, tag_ids: [{ id: 2, name: 'two' }] })!,
    ]
    const created = favorites.mergeGroupsToNew(['b', 'a'], 'Merged')!
    expect(created.id).not.toBe('a')
    expect(created.id).not.toBe('b')
    expect(favoritesStore.list.map((g) => g.id)).toEqual([created.id])
    expect(created.l1Id).toBe('parent')
    expect(created.weight).toBe(0)
    expect(created.overrides?.poolsEnabled?.archiveRelated).toBe(false)
    expect(created.tag_ids.map((e) => e.id)).toEqual([1, 2])
  })
  it('structured negatives are visible, removable, and mutually exclusive with positive members', () => {
    const negative = { id: 99, name: 'blocked' }
    const g = makeTagGroup({
      id: 'g',
      name: 'G',
      tag_ids: [{ id: 1, name: 'pos' }],
      overrides: { negative: { tagIds: [negative] } },
    })!
    favoritesStore.list = [g]
    favoritesL1Store.list = []
    expect(groupNegativeMerged(favoritesStore.list[0]).tagIds?.map((e) => e.id)).toEqual([99])
    expect(classifyVideoTagStatus(negative, favoritesStore.list).negative.map((g) => g.id)).toEqual(['g'])
    expect(favorites.removeNegativeFromGroup('g', 99)).toBe(true)
    expect(groupNegativeMerged(favoritesStore.list[0]).tagIds ?? []).toEqual([])
    favorites.addNegativeToGroup('g', [negative])
    expect(favorites.addTagIdsToGroup('g', [negative], { silent: true }).moved).toBe(1)
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toContain(99)
    expect(groupNegativeMerged(favoritesStore.list[0]).tagIds?.map((e) => e.id)).not.toContain(99)
  })

  it('merging groups preserves structured negatives and pool selection', () => {
    favoritesStore.list = [
      makeTagGroup({ id: 'keep', name: 'K', tag_ids: [{ id: 1, name: 'one' }], addedAt: 1 })!,
      makeTagGroup({
        id: 'absorbed',
        name: 'A',
        tag_ids: [{ id: 2, name: 'two' }],
        addedAt: 2,
        overrides: { negative: { tagIds: [{ id: 99, name: 'blocked' }] }, poolsEnabled: { archiveRelated: false } },
      })!,
    ]
    expect(favorites.mergeGroupsInto(['absorbed'], 'keep')).toBe(1)
    expect(favoritesStore.list).toHaveLength(1)
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual([1, 2])
    expect(groupNegativeMerged(favoritesStore.list[0]).tagIds?.map((e) => e.id)).toEqual([99])
    expect(favoritesStore.list[0].overrides?.poolsEnabled).toEqual({ archiveRelated: false })
  })

  it('merging the current group follows the target and preserves unsaved expansions', () => {
    favoritesStore.list = [
      makeTagGroup({ id: 'keep', name: 'K', tag_ids: [{ id: 1, name: 'one' }] })!,
      makeTagGroup({ id: 'source', name: 'S', tag_ids: [{ id: 2, name: 'two' }] })!,
    ]
    switchTagRecGroupContext('source')
    tagRecCustomSession.expandedIds = [{ id: 99, name: 'unsaved' }]
    tagRecCustomSession.candidates = [{ key: 'old', tag_name: 'old', badge: 'cooccur', checked: false }]
    const oldCandidates = tagRecCustomSession.candidates
    favorites.mergeGroupsInto(['source'], 'keep')
    expect(tagRecCustomSession.selectedGroupIds).toEqual(['keep'])
    expect(tagRecCustomSession.expandedIds.map((e) => e.id)).toEqual([99])
    expect(tagRecCustomSession.candidates).not.toBe(oldCandidates)
  })

  it('importing multiple sources into one target uses the same fixed source order', () => {
    const a = makeTagGroup({
      id: 'a',
      addedAt: 2,
      tag_ids: [
        { id: 3, name: 'three' },
        { id: 1, name: 'one' },
      ],
      overrides: { dims: { viewMin: { enabled: true, value: 100 } } },
    })!
    const b = makeTagGroup({
      id: 'b',
      addedAt: 3,
      tag_ids: [
        { id: 3, name: 'three' },
        { id: 2, name: 'two' },
      ],
      overrides: { dims: { viewMin: { enabled: true, value: 200 } } },
    })!
    favoritesStore.list = [makeTagGroup({ id: 'keep', tag_ids: [{ id: 3, name: 'three' }] })!]
    const result = applyTagRecImport({
      plan: {
        favoritesToAdd: [b, a],
        l1ToAdd: [],
        themesToAdd: [],
        synthesizedThemes: 0,
        blacklistToAdd: [],
        overlappedGroups: [],
        invalidGroups: [],
        conflicts: [b, a].map((group) => ({
          group,
          hits: [{ id: 'keep', name: 'Keep', shared: [3], sameEntity: false }],
        })),
      },
      choices: { a: 'merge', b: 'merge' },
    })
    expect(result.merged).toBe(2)
    expect(favoritesStore.list[0].overrides?.dims?.viewMin?.value).toBe(100)
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual([3, 1, 2])
  })
})

const { tagRecConditionAtom, removeTagRecCondition, tagRecConditionAtoms, TAG_REC_COMBINATION_MAX_NODES } =
  await import('$modules/tag-rec/model/combination')

describe('wayfinding 004: editGroupCombination 直写通道', () => {
  it('无组合组首次走此通道: 既有 tag_ids 播种成 tag 行原子, 投影不丢员', () => {
    favoritesStore.list = [makeTagGroup({ id: 'g', tag_ids: [{ id: 1, name: 'one' }] })!]
    favoritesL1Store.list = []
    const ok = favorites.editGroupCombination('g', (c) => {
      c.include.children.push(tagRecConditionAtom('title', 'foo'))
      c.exclude.push(tagRecConditionAtom('up', { name: 'someone' }))
    })
    expect(ok).toBe(true)
    const saved = favoritesStore.list[0]
    const atoms = tagRecConditionAtoms(saved.combination!.include)
    expect(atoms.map((a) => a.field)).toContain('title')
    expect(atoms.map((a) => a.field)).toContain('tag')
    // tag_ids 投影 = 播种成员 + 新增 tag 原子; title/up 不进投影
    expect(saved.tag_ids.map((e) => e.id)).toEqual([1])
    favorites.editGroupCombination('g', (c) =>
      c.include.children.push(tagRecConditionAtom('tag', { id: 7, name: 'seven' })),
    )
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual([1, 7])
  })

  it('播种超节点上限: 整批拒绝, 不落盘也不截断既有 tag_ids (审计: 静默数据丢失)', () => {
    const many = Array.from({ length: TAG_REC_COMBINATION_MAX_NODES + 4 }, (_, i) => ({ id: i + 1, name: `t${i}` }))
    favoritesStore.list = [makeTagGroup({ id: 'big', tag_ids: many })!]
    const ok = favorites.editGroupCombination('big', (c) => {
      c.exclude.push(tagRecConditionAtom('up', { name: 'someone' }))
    })
    expect(ok).toBe(false)
    // 组合不物化 + 投影未重导 => 成员一个不少
    expect(favoritesStore.list[0].combination).toBeUndefined()
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual(many.map((e) => e.id))
  })

  it('校验失败整批丢弃 —— 超节点上限的原组原样保留', () => {
    favoritesStore.list = [makeTagGroup({ id: 'g2', tag_ids: [{ id: 1, name: 'one' }] })!]
    const ok = favorites.editGroupCombination('g2', (c) => {
      for (let i = 0; i < TAG_REC_COMBINATION_MAX_NODES + 5; i++)
        c.include.children.push(tagRecConditionAtom('title', `w${i}`))
    })
    expect(ok).toBe(false)
    // 整批丢弃: 组合不物化, tag_ids 原样
    expect(favoritesStore.list[0].combination).toBeUndefined()
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual([1])
  })

  it('不存在的组返回 false; 移除原子后投影同步收缩 (播种成员存活)', () => {
    expect(favorites.editGroupCombination('missing', () => {})).toBe(false)
    const g = makeTagGroup({ id: 'g3', tag_ids: [{ id: 1, name: 'one' }] })!
    favoritesStore.list = [g]
    expect(
      favorites.editGroupCombination('g3', (c) =>
        c.include.children.push(tagRecConditionAtom('tag', { id: 9, name: 'nine' })),
      ),
    ).toBe(true)
    const atomId = tagRecConditionAtoms(favoritesStore.list[0].combination!.include).find(
      (n) => n.field === 'tag' && n.value.id === 9,
    )!.id
    expect(favorites.editGroupCombination('g3', (c) => removeTagRecCondition(c, atomId))).toBe(true)
    expect(favoritesStore.list[0].tag_ids.map((e) => e.id)).toEqual([1])
  })
})
