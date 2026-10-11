import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTagRecGroupScopeDraft } from '../model/theme-scope-draft'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve(undefined)), setValue: vi.fn(() => Promise.resolve()) })
const {
  favorites,
  favoritesStore,
  favoritesL1,
  favoritesL1Store,
  themesStore,
  viewScope,
  viewScopeStore,
  tagRecStoresHydrated,
} = await import('./index')
const { tagRecSharedSession } = await import('./session')
await tagRecStoresHydrated

beforeEach(() => {
  favoritesL1Store.list = [{ id: 'p', name: '一级组', themeId: 't', enabled: false, weight: 1, addedAt: 1 }]
  favoritesStore.list = [
    { id: 'a', name: '子组 A', l1Id: 'p', tag_ids: [{ id: 1, name: 'A' }], enabled: true, weight: 1, addedAt: 1 },
    {
      id: 'b',
      name: '子组 B',
      l1Id: 'p',
      tag_ids: [{ id: 2, name: 'B' }],
      enabled: false,
      weight: 2,
      note: '保留简介',
      overrides: { negative: { title: ['词'] } },
      addedAt: 1,
    },
  ]
  themesStore.list = [{ id: 't', name: '主题', addedAt: 1 }]
  viewScopeStore.scope = {}
  viewScopeStore.groupScope = {}
  tagRecSharedSession.tempEnabledL1Ids = []
  tagRecSharedSession.tempEnabledGroupIds = []
})
const current = () =>
  createTagRecGroupScopeDraft(
    favoritesStore.list,
    favoritesL1Store.list,
    new Set(['t']),
    viewScopeStore.scope,
    viewScopeStore.groupScope,
    tagRecSharedSession.tempEnabledL1Ids,
    tagRecSharedSession.tempEnabledGroupIds,
  )

describe('保存开关优先于二级组临时范围', () => {
  it('关掉一个临时二级组只移除该叶子，父组及兄弟继续临时参与', () => {
    tagRecSharedSession.tempEnabledL1Ids = ['p']
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    expect(current()).toEqual({ a: true, b: true })
    favorites.updateGroup('b', { enabled: false })
    expect(current()).toEqual({ a: true, b: false })
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual(['p'])
    expect(tagRecSharedSession.tempEnabledGroupIds).toEqual([])
  })
  it('显式开启一级组恢复保存的子开关，清除整支临时覆盖', () => {
    viewScopeStore.scope = { t: [] }
    viewScopeStore.groupScope = { p: ['b'] }
    tagRecSharedSession.tempEnabledL1Ids = ['p']
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    favoritesL1.updateL1('p', { enabled: true })
    expect(current()).toEqual({ a: true, b: false })
    expect(viewScopeStore.groupScope).toEqual({})
    expect(tagRecSharedSession.tempEnabledGroupIds).toEqual([])
  })
  it('显式关闭一级组整支退出，但不改各二级组保存开关', () => {
    tagRecSharedSession.tempEnabledL1Ids = ['p']
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    favoritesL1.updateL1('p', { enabled: false })
    expect(current()).toEqual({ a: false, b: false })
    expect(favoritesStore.list.map((g) => g.enabled)).toEqual([true, false])
  })
  it('在启用父组内显式打开子组覆盖临时排除，保留兄弟的临时选择', () => {
    favoritesL1Store.list[0].enabled = true
    viewScopeStore.scope = { t: [] }
    viewScopeStore.groupScope = { p: [] }
    favorites.updateGroup('b', { enabled: true })
    expect(current()).toEqual({ a: false, b: true })
  })
  it('从收藏表应用主题筛选清除旧二级组范围，恢复各子开关', () => {
    viewScopeStore.groupScope = { p: ['b'] }
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    viewScope.previewThemes(new Set(['t']))
    expect(current()).toEqual({ a: true, b: false })
  })
})

describe('空二级组生命周期', () => {
  it('在已有一级组内新建空组，不另建父组，也不改变父开关', () => {
    const created = favorites.addGroup({ l1Id: 'p', name: ' 待添加 ', tag_ids: [] })!
    expect(created.group).toMatchObject({ l1Id: 'p', name: '待添加', tag_ids: [], enabled: false })
    expect(favoritesL1Store.list).toHaveLength(1)
    expect(favoritesL1Store.list[0].enabled).toBe(false)
    favorites.updateGroup(created.group.id, { enabled: true })
    expect(created.group.enabled).toBe(false)
  })
  it('删除最后一个标签保留配置并移除临时开启；填充后由用户显式启用', () => {
    tagRecSharedSession.tempEnabledL1Ids = ['p']
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    expect(favorites.removeTagIdFromGroup('b', 2)).toBe(true)
    expect(favoritesStore.list[1]).toMatchObject({
      id: 'b',
      name: '子组 B',
      l1Id: 'p',
      tag_ids: [],
      enabled: false,
      weight: 2,
      note: '保留简介',
      overrides: { negative: { title: ['词'] } },
    })
    expect(tagRecSharedSession.tempEnabledGroupIds).toEqual([])
    favorites.addTagIdsToGroup('b', [{ id: 3, name: '补充' }])
    expect(favoritesStore.list[1].enabled).toBe(false)
    favorites.updateGroup('b', { enabled: true })
    expect(current()).toEqual({ a: true, b: true })
    expect(favoritesL1Store.list[0].enabled).toBe(false)
  })
  it('级联删除清除所有子组和临时引用', () => {
    tagRecSharedSession.tempEnabledL1Ids = ['p']
    tagRecSharedSession.tempEnabledGroupIds = ['b']
    viewScopeStore.groupScope = { p: ['b'] }
    favoritesL1.removeL1Tree('p')
    expect(favoritesStore.list).toEqual([])
    expect(viewScopeStore.groupScope).toEqual({})
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual([])
    expect(tagRecSharedSession.tempEnabledGroupIds).toEqual([])
  })
})
