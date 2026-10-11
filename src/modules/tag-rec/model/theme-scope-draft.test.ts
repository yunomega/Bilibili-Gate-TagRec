import { describe, expect, it } from 'vitest'
import { TagRecUnitsDeck, unitsFingerprint, withTagRecGroupScope, withTagRecTempEnables } from '../service/deck'
import {
  createTagRecGroupScopeDraft,
  createTagRecThemeScopeDraft,
  materializeTagRecGroupScopeDraft,
  materializeTagRecThemeScopeDraft,
  tagRecViewedGroupIds,
} from './theme-scope-draft'
import type { TagGroup, TagL1Group } from './types'

const l1s: TagL1Group[] = [
  { id: 'a', name: 'A', themeId: 't', enabled: true, weight: 1, addedAt: 1 },
  { id: 'b', name: 'B', themeId: 't', enabled: false, weight: 1, addedAt: 1 },
  { id: 'c', name: 'C', themeId: 'u', enabled: true, weight: 1, addedAt: 1 },
]
const themes = new Set(['t', 'u'])
const groups: TagGroup[] = [
  { id: 'a1', name: 'A1', l1Id: 'a', tag_ids: [{ id: 1, name: 'A1' }], enabled: true, weight: 1, addedAt: 1 },
  { id: 'a2', name: 'A2', l1Id: 'a', tag_ids: [{ id: 2, name: 'A2' }], enabled: false, weight: 1, addedAt: 1 },
  { id: 'b1', name: 'B1', l1Id: 'b', tag_ids: [{ id: 3, name: 'B1' }], enabled: true, weight: 1, addedAt: 1 },
  { id: 'b2', name: 'B2', l1Id: 'b', tag_ids: [{ id: 4, name: 'B2' }], enabled: false, weight: 1, addedAt: 1 },
  { id: 'empty', name: '空组', l1Id: 'b', tag_ids: [], enabled: false, weight: 1, addedAt: 1 },
  { id: 'paused', name: '挂起', l1Id: 'b', tag_ids: [{ id: 5, name: '挂起' }], enabled: true, weight: 0, addedAt: 1 },
]

describe('精确二级组范围与抽样', () => {
  const create = (draft: Record<string, boolean>) => materializeTagRecGroupScopeDraft(draft, groups, l1s, themes)
  it('默认跟随父子保存开关；父停用时所有子组未选中', () => {
    expect(createTagRecGroupScopeDraft(groups, l1s, themes, {}, {}, [], [])).toEqual({
      a1: true,
      a2: false,
      b1: false,
      b2: false,
      empty: false,
      paused: false,
    })
  })
  it('仅看父子均停用的叶子，只临时开启它及其父，不开启兄弟，也不写保存状态', () => {
    const saved = JSON.stringify({ groups, l1s })
    const draft = Object.fromEntries(groups.map((g) => [g.id, g.id === 'b2']))
    const applied = create(draft)
    expect(applied.temporary).toEqual(['b'])
    expect(applied.temporaryGroups).toEqual(['b2'])
    expect(
      createTagRecGroupScopeDraft(
        groups,
        l1s,
        themes,
        applied.scope,
        applied.groupScope,
        applied.temporary,
        applied.temporaryGroups,
      ),
    ).toEqual(draft)
    const effective = withTagRecGroupScope(
      groups,
      tagRecViewedGroupIds(groups, applied.groupScope),
      applied.temporaryGroups,
    )
    const parents = withTagRecTempEnables(l1s, applied.temporary)
    const deck = new TagRecUnitsDeck((items) => items)
    expect(deck.drawUnits(effective, parents, 5).map((g) => g.id)).toEqual(['b2'])
    expect(JSON.stringify({ groups, l1s })).toBe(saved)
  })
  it('同一父组内换二级组会改变抽样指纹', () => {
    const before = withTagRecGroupScope(groups, new Set(['a1']))
    const after = withTagRecGroupScope(groups, new Set(['a2']), ['a2'])
    expect(unitsFingerprint(before, l1s)).not.toBe(unitsFingerprint(after, l1s))
    expect(new TagRecUnitsDeck((items) => items).drawUnits(after, l1s, 5).map((g) => g.id)).toEqual(['a2'])
  })
  it('临时覆盖也不能使空组或权重零的二级组进入抽取', () => {
    const effective = withTagRecGroupScope(groups, new Set(['empty', 'paused']), ['empty', 'paused'])
    expect(new TagRecUnitsDeck((items) => items).drawUnits(effective, withTagRecTempEnables(l1s, ['b']), 5)).toEqual([])
  })
  it('默认草稿不产生额外限制，新启用的子组跟随收藏表加入', () => {
    const draft = createTagRecGroupScopeDraft(groups, l1s, themes, {}, {}, [], [])
    const applied = create(draft)
    // 父停用的分支没有额外叶子限制，不影响以后显式开启父组。
    expect(applied.groupScope.a).toBeUndefined()
    const newGroup = { ...groups[0], id: 'new' }
    expect(
      createTagRecGroupScopeDraft([...groups, newGroup], l1s, themes, applied.scope, applied.groupScope, [], []).new,
    ).toBe(true)
  })
})

describe('观看范围草稿', () => {
  it('缺省跟随收藏表，不把停用组显示成已勾选', () => {
    expect(createTagRecThemeScopeDraft(l1s, themes, {}, [])).toEqual({ a: true, b: false, c: true })
  })
  it('编辑不改收藏表或生效范围，提交后同时支持临时开启和临时关闭', () => {
    const scope = {}
    const draft = createTagRecThemeScopeDraft(l1s, themes, scope, [])
    draft.a = false
    draft.b = true
    expect(scope).toEqual({})
    expect(l1s.map((l) => l.enabled)).toEqual([true, false, true])
    const applied = materializeTagRecThemeScopeDraft(draft, l1s, themes)
    expect(applied).toEqual({ scope: { t: ['b'] }, temporary: ['b'] })
    expect(createTagRecThemeScopeDraft(l1s, themes, applied.scope, applied.temporary)).toEqual(draft)
  })
  it('恢复启用状态后移除覆盖，新收藏的启用组默认仍加入', () => {
    const draft = createTagRecThemeScopeDraft(l1s, themes, {}, [])
    expect(materializeTagRecThemeScopeDraft(draft, l1s, themes)).toEqual({ scope: {}, temporary: [] })
    expect(materializeTagRecThemeScopeDraft(draft, [...l1s, { ...l1s[0], id: 'new' }], themes)).toEqual({
      scope: {},
      temporary: [],
    })
  })
})
