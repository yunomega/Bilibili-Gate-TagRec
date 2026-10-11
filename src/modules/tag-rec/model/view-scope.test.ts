import { describe, expect, it } from 'vitest'
import {
  TAG_REC_VIEW_UNASSIGNED,
  tagRecViewBucketOf,
  tagRecViewScopeAbsorb,
  tagRecViewScopeCovers,
  tagRecViewScopeLegacyActiveTheme,
  tagRecViewScopeSummary,
  tagRecViewScopeViewedIds,
  type TagRecViewScope,
} from './view-scope'

/** L1 简形 (只取 id/themeId) */
const l1 = (id: string, themeId?: string) => ({ id, themeId })
const THEMES = new Set(['T1', 'T2'])
const L1S = [l1('a', 'T1'), l1('b', 'T1'), l1('c', 'T2'), l1('u')] // u = 未归属

describe('$modules/tag-rec/model/view-scope (R7 查看范围纯逻辑)', () => {
  it('.bucketOf: 主题存在用主题 id; 无主题/悬挂 (已删主题) 归未归属', () => {
    expect(tagRecViewBucketOf({ themeId: 'T1' }, THEMES)).toBe('T1')
    expect(tagRecViewBucketOf({ themeId: undefined }, THEMES)).toBe(TAG_REC_VIEW_UNASSIGNED)
    expect(tagRecViewBucketOf({ themeId: 'ghost' }, THEMES)).toBe(TAG_REC_VIEW_UNASSIGNED)
  })

  it('.covers: 缺键/“all” = 全看; 数组 = 包含; 空数组 = 不看', () => {
    const scope: TagRecViewScope = { T1: 'all', T2: ['c'], [TAG_REC_VIEW_UNASSIGNED]: [] }
    expect(tagRecViewScopeCovers(scope, 'T1', 'a')).toBe(true)
    expect(tagRecViewScopeCovers(scope, 'T2', 'c')).toBe(true)
    expect(tagRecViewScopeCovers(scope, 'T2', 'x')).toBe(false)
    expect(tagRecViewScopeCovers(scope, TAG_REC_VIEW_UNASSIGNED, 'u')).toBe(false)
    expect(tagRecViewScopeCovers(scope, 'missing', 'anything')).toBe(true) // 缺键 = 全看
  })

  it('.viewedIds: 默认全看; 主题 [] 整桶取消; 数组细选; 悬挂 L1 归未归属桶', () => {
    expect([...tagRecViewScopeViewedIds({}, L1S, THEMES)].sort()).toEqual(['a', 'b', 'c', 'u'])
    expect([...tagRecViewScopeViewedIds({ T1: [] }, L1S, THEMES)].sort()).toEqual(['c', 'u'])
    expect([...tagRecViewScopeViewedIds({ T1: ['b'], T2: [] }, L1S, THEMES)].sort()).toEqual(['b', 'u'])
    expect([...tagRecViewScopeViewedIds({ [TAG_REC_VIEW_UNASSIGNED]: [] }, L1S, THEMES)].sort()).toEqual([
      'a',
      'b',
      'c',
    ])
    // 悬挂主题的 L1 按未归属桶判定
    const dangling = [l1('d', 'ghost')]
    expect([...tagRecViewScopeViewedIds({ [TAG_REC_VIEW_UNASSIGNED]: [] }, dangling, THEMES)]).toEqual([])
    expect([...tagRecViewScopeViewedIds({}, dangling, THEMES)]).toEqual(['d'])
  })

  it('.absorb (删/并主题): 并集语义 —— from 全看(含缺键) => to 全看; 数组取并; to 已全看不动', () => {
    // from 缺键 (全看) => to 提升全看
    const s1: TagRecViewScope = { T2: [] }
    tagRecViewScopeAbsorb(s1, 'T1', TAG_REC_VIEW_UNASSIGNED)
    expect(s1[TAG_REC_VIEW_UNASSIGNED]).toBe('all')
    // from 'all' => to 'all'
    const s2: TagRecViewScope = { T1: 'all', T2: [] }
    tagRecViewScopeAbsorb(s2, 'T1', 'T2')
    expect(s2.T2).toBe('all')
    expect('T1' in s2).toBe(false)
    // from 数组 => to 并集
    const s3: TagRecViewScope = { T1: ['a'], T2: ['c'] }
    tagRecViewScopeAbsorb(s3, 'T1', 'T2')
    expect([...s3.T2].sort()).toEqual(['a', 'c'])
    // to 已全看 => 不动
    const s4: TagRecViewScope = { T1: ['a'], T2: 'all' }
    tagRecViewScopeAbsorb(s4, 'T1', 'T2')
    expect(s4.T2).toBe('all')
  })

  it('.legacyActiveTheme (导出兼容): 恰好只看单主题 => 该 id; 其余 => null', () => {
    expect(tagRecViewScopeLegacyActiveTheme({}, ['T1', 'T2'])).toBeNull() // 全看
    expect(tagRecViewScopeLegacyActiveTheme({ T1: 'all', T2: [], [TAG_REC_VIEW_UNASSIGNED]: [] }, ['T1', 'T2'])).toBe(
      'T1',
    )
    expect(tagRecViewScopeLegacyActiveTheme({ T1: ['a'], T2: [], [TAG_REC_VIEW_UNASSIGNED]: [] }, ['T1', 'T2'])).toBe(
      'T1',
    ) // 部分细选也算「只看该主题」(该主题有可看内容)
    expect(tagRecViewScopeLegacyActiveTheme({ T1: 'all', T2: 'all' }, ['T1', 'T2'])).toBeNull() // 多主题
    expect(
      tagRecViewScopeLegacyActiveTheme({ T1: [], T2: [], [TAG_REC_VIEW_UNASSIGNED]: 'all' }, ['T1', 'T2']),
    ).toBeNull() // 只看未归属不算单主题
  })

  it('.summary: 全选/未选/部分/超 3 折叠', () => {
    const buckets = [
      { id: 'T1', name: 'A', l1Count: 2 },
      { id: 'T2', name: 'B', l1Count: 2 }, // ['x'] 只覆盖一半 => 部分
      { id: 'T3', name: 'C', l1Count: 1 },
      { id: 'T4', name: 'D', l1Count: 1 },
      { id: TAG_REC_VIEW_UNASSIGNED, name: '未归属', l1Count: 1 },
    ]
    expect(tagRecViewScopeSummary({}, buckets)).toBe('主题：全选')
    const none: TagRecViewScope = { T1: [], T2: [], T3: [], T4: [], [TAG_REC_VIEW_UNASSIGNED]: [] }
    expect(tagRecViewScopeSummary(none, buckets)).toBe('主题：未选 (点此全选)')
    expect(
      tagRecViewScopeSummary({ T1: 'all', T2: ['x'], T3: [], T4: [], [TAG_REC_VIEW_UNASSIGNED]: [] }, buckets),
    ).toBe('主题：A、B(部分)')
    // 超 3 个折叠「等 N 个」
    expect(
      tagRecViewScopeSummary({ T1: 'all', T2: 'all', T3: 'all', T4: 'all', [TAG_REC_VIEW_UNASSIGNED]: [] }, buckets),
    ).toBe('主题：A、B、C 等4个')
    // 部分细选覆盖满桶 => full
    expect(
      tagRecViewScopeSummary({ T1: ['a', 'b'], T2: [], T3: [], T4: [], [TAG_REC_VIEW_UNASSIGNED]: [] }, buckets),
    ).toBe('主题：A')
  })
})
