import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTagRecThemeScopeDraft } from '../model/theme-scope-draft'
import { TAG_REC_VIEW_UNASSIGNED } from '../model/view-scope'
import { TagRecUnitsDeck, withTagRecTempEnables } from '../service/deck'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
const getValue = vi.fn((key: string) =>
  Promise.resolve(key === 'tag-rec:view-scope' ? { scope: { t: [] } } : undefined),
)
vi.stubGlobal('GM', { getValue, setValue: vi.fn(() => Promise.resolve()) })
vi.useFakeTimers()
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
vi.runAllTimers()
vi.useRealTimers()

describe('收藏表和会话观看范围同步', () => {
  beforeEach(() => {
    favoritesL1Store.list = [
      { id: 'a', name: 'A', themeId: 't', enabled: true, weight: 1, addedAt: 1 },
      { id: 'b', name: 'B', themeId: 't', enabled: false, weight: 1, addedAt: 1 },
    ]
    themesStore.list = [{ id: 't', name: 'T', addedAt: 1 }]
    viewScopeStore.scope = {}
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledL1Ids = []
    tagRecSharedSession.tempEnabledGroupIds = []
    favoritesStore.list = []
  })
  const current = () =>
    createTagRecThemeScopeDraft(
      favoritesL1Store.list,
      new Set(['t']),
      viewScopeStore.scope,
      tagRecSharedSession.tempEnabledL1Ids,
    )
  it('不再读取旧持久范围，刷新时默认跟随收藏表', () => {
    expect(getValue.mock.calls.some(([key]) => key === 'tag-rec:view-scope')).toBe(false)
    expect(current()).toEqual({ a: true, b: false })
  })
  it('收藏表明确启用时，覆盖此前临时取消', () => {
    viewScopeStore.scope = { t: [] }
    expect(current().a).toBe(false)
    favoritesL1.updateL1('a', { enabled: true })
    expect(current().a).toBe(true)
    expect(current().b).toBe(false)
  })
  it('收藏表明确停用时，清掉此前的临时启用', () => {
    tagRecSharedSession.tempEnabledL1Ids = ['b']
    expect(current().b).toBe(true)
    favoritesL1.updateL1('b', { enabled: false })
    expect(current().b).toBe(false)
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual([])
  })
})

describe('收藏表筛选跳转主题推荐', () => {
  beforeEach(() => {
    favoritesL1Store.list = [
      { id: 'a', name: '甜蜜女友', themeId: 't', enabled: false, weight: 1, addedAt: 1 },
      { id: 'b', name: '我家老婆', themeId: 'u', enabled: true, weight: 5, addedAt: 1 },
      { id: 'c', name: '其他停用组', themeId: 'v', enabled: false, weight: 1, addedAt: 1 },
      { id: 'd', name: '其他启用组', themeId: 'v', enabled: true, weight: 1, addedAt: 1 },
      { id: 'e', name: '未归属', enabled: false, weight: 1, addedAt: 1 },
    ]
    themesStore.list = [
      { id: 't', name: '甜蜜女友', addedAt: 1 },
      { id: 'u', name: '我家老婆', addedAt: 1 },
      { id: 'v', name: '其他', addedAt: 1 },
    ]
    viewScopeStore.scope = { u: [] }
    tagRecSharedSession.tempEnabledL1Ids = ['c']
  })
  const current = () =>
    createTagRecThemeScopeDraft(
      favoritesL1Store.list,
      new Set(themesStore.list.map((t) => t.id)),
      viewScopeStore.scope,
      tagRecSharedSession.tempEnabledL1Ids,
    )

  it('两个主题同时参与推荐，临时开启停用一级组，并替换旧会话选择', () => {
    const saved = JSON.stringify(favoritesL1Store.list)
    viewScope.previewThemes(new Set(['t', 'u']))
    expect(current()).toEqual({ a: true, b: true, c: false, d: false, e: false })
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual(['a'])
    expect(viewScope.summaryText()).toBe('主题：甜蜜女友、我家老婆')

    const groups = favoritesL1Store.list.map((l, i) => ({
      id: 'g-' + l.id,
      name: l.name,
      l1Id: l.id,
      tag_ids: [{ id: i + 1, name: l.name }],
      enabled: true,
      weight: 1,
      addedAt: 1,
    }))
    const deck = new TagRecUnitsDeck((items) => items)
    const drawn = deck.drawUnits(
      groups,
      withTagRecTempEnables(favoritesL1Store.list, tagRecSharedSession.tempEnabledL1Ids),
      10,
      viewScope.viewedL1Ids(),
    )
    expect(drawn.map((g) => g.id).sort()).toEqual(['g-a', 'g-b'])
    expect(JSON.stringify(favoritesL1Store.list)).toBe(saved)
  })

  it('再次应用时取消上次临时开启；未勾选时恢复收藏表启用集', () => {
    viewScope.previewThemes(new Set(['t', 'u']))
    viewScope.previewThemes(new Set(['u']))
    expect(current()).toEqual({ a: false, b: true, c: false, d: false, e: false })
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual([])
    viewScope.previewThemes(new Set(['t']))
    viewScope.previewThemes(new Set())
    expect(current()).toEqual({ a: false, b: true, c: false, d: true, e: false })
    expect(viewScopeStore.scope).toEqual({})
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual([])
  })

  it('勾选未归属时只临时开启未归属一级组，包括已删除主题的组', () => {
    favoritesL1Store.list.push({ id: 'f', name: '失效主题', themeId: 'deleted', enabled: false, weight: 1, addedAt: 1 })
    viewScope.previewThemes(new Set([TAG_REC_VIEW_UNASSIGNED]))
    expect(current()).toEqual({ a: false, b: false, c: false, d: false, e: true, f: true })
    expect(tagRecSharedSession.tempEnabledL1Ids).toEqual(['e', 'f'])
  })
})
