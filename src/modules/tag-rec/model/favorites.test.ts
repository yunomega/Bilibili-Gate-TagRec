import { describe, expect, it } from 'vitest'
import {
  blacklistHas,
  canSplitTagId,
  clampWeight,
  computeMergeGroups,
  computeNegativeAdd,
  dedupeTagIdEntries,
  findGroupByTagId,
  findGroupsByNegativeTagId,
  findGroupsByTagId,
  findGroupsByTagIds,
  groupState,
  intersectCheck,
  makeTagGroup,
  pickNewBlacklistEntries,
  pickTagGroupsByIds,
  removeTagIdFromGroup,
  shouldShowTagRecCustomDot,
  summarizeGroupNames,
  unionTagIdsOfGroups,
} from './favorites'
import type { TagBlacklistEntry, TagGroup, TagIdEntry } from './types'

const e = (id: number, name = `tag${id}`): TagIdEntry => ({ id, name })
const g = (id: string, ids: number[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: id,
  tag_ids: ids.map((id) => e(id)),
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})

describe.concurrent('$modules/tag-rec/model/favorites', () => {
  it('.groupState 三态归类: 停用 > 挂起 > 正常', () => {
    expect(groupState({ weight: 1, enabled: true })).toBe('normal')
    expect(groupState({ weight: 0, enabled: true })).toBe('suspended')
    expect(groupState({ weight: 3, enabled: false })).toBe('disabled')
    expect(groupState({ weight: 0, enabled: false })).toBe('disabled') // 停用优先呈现
  })

  it('.clampWeight 取整 + clamp 0~5 + 非数回落 1', () => {
    expect(clampWeight(-1)).toBe(0)
    expect(clampWeight(0)).toBe(0)
    expect(clampWeight(3)).toBe(3)
    expect(clampWeight(2.6)).toBe(3)
    expect(clampWeight(9)).toBe(5)
    expect(clampWeight(NaN)).toBe(1)
  })

  it('.dedupeTagIdEntries 按 id 去重保序', () => {
    expect(dedupeTagIdEntries([e(1, 'a'), e(2), e(1, 'b'), e(3)])).toEqual([e(1, 'a'), e(2), e(3)])
  })

  it('.findGroupByTagId / .intersectCheck 交集查重', () => {
    const groups = [g('a', [1, 2]), g('b', [3]), g('c', [4, 5])]
    expect(findGroupByTagId(groups, 3)?.id).toBe('b')
    expect(findGroupByTagId(groups, 99)).toBeUndefined()
    // 任一 id 命中 => 返回宿主导组
    expect(intersectCheck(groups, [8, 5])?.id).toBe('c')
    expect(intersectCheck(groups, [8, 9])).toBeUndefined()
    // excludeGroupId: 变更自身组不算冲突
    expect(intersectCheck(groups, [1], 'a')).toBeUndefined()
    expect(intersectCheck(groups, [1, 3], 'a')?.id).toBe('b')
  })

  it('.findGroupsByTagId / .findGroupsByTagIds 全宿主枚举 (票 12「已在组」素材)', () => {
    const groups = [g('a', [1, 2]), g('b', [3]), g('c', [2, 4])] // 跨组重复 id 合法 (票 14)
    expect(findGroupsByTagId(groups, 2).map((x) => x.id)).toEqual(['a', 'c'])
    expect(findGroupsByTagId(groups, 3).map((x) => x.id)).toEqual(['b'])
    expect(findGroupsByTagId(groups, 99)).toEqual([])
    // 任一 id 命中 => 全部宿主导组, 表序去重
    expect(findGroupsByTagIds(groups, [3, 4]).map((x) => x.id)).toEqual(['b', 'c'])
    expect(findGroupsByTagIds(groups, [2, 4]).map((x) => x.id)).toEqual(['a', 'c'])
    expect(findGroupsByTagIds(groups, [9])).toEqual([])
  })

  it('.summarizeGroupNames ≤3 全列, 超出「等 n 组」封顶 (票 12 toast 粒度)', () => {
    expect(summarizeGroupNames(['a'])).toBe('「a」')
    expect(summarizeGroupNames(['a', 'b', 'c'])).toBe('「a」「b」「c」')
    expect(summarizeGroupNames(['a', 'b', 'c', 'd', 'e'])).toBe('「a」「b」「c」等 5 组')
    expect(summarizeGroupNames([])).toBe('')
  })

  it('有名字的空组可保存，强制停用；无名空组拒建', () => {
    expect(makeTagGroup({ name: ' x ', tag_ids: [], enabled: true })).toMatchObject({
      name: 'x',
      tag_ids: [],
      enabled: false,
    })
    expect(makeTagGroup({ name: '  ', tag_ids: [] })).toBeUndefined()
    expect(makeTagGroup({ tag_ids: [] })).toBeUndefined()
  })

  it('.makeTagGroup 默认值 + 去重 + name 回落首 id 名', () => {
    const group = makeTagGroup({ name: '  ', tag_ids: [e(1, 'Demons Roots'), e(1, 'dup'), e(2)] })
    expect(group).toMatchObject({ name: 'Demons Roots', weight: 1, enabled: true })
    expect(group!.tag_ids).toEqual([e(1, 'Demons Roots'), e(2)])
    expect(group!.id).toBeTruthy()
    expect(group!.addedAt).toBeGreaterThan(0)
  })

  it('.makeTagGroup weight clamp + name trim + 覆盖默认', () => {
    const group = makeTagGroup({ name: ' x ', tag_ids: [e(1)], weight: 9, enabled: false, addedAt: 7 })
    expect(group).toMatchObject({ name: 'x', weight: 5, enabled: false, addedAt: 7 })
  })

  it('.computeMergeGroups <2 组拒并; 并入最早 addedAt 组, id 并集去重', () => {
    expect(computeMergeGroups([g('a', [1])])).toBeUndefined()
    const res = computeMergeGroups([
      g('newer', [3, 9], { addedAt: 200 }),
      g('older', [1, 2], { addedAt: 100 }),
      g('mid', [2, 4], { addedAt: 150 }),
    ])!
    expect(res.keepId).toBe('older')
    expect(res.absorbedIds).toEqual(['mid', 'newer'])
    expect(res.tag_ids.map((x) => x.id)).toEqual([1, 2, 4, 3, 9]) // keep 组序优先
  })

  it('移出最后一个标签返回空成员，不删除组实体', () => {
    const one = g('a', [1])
    expect(removeTagIdFromGroup(one, 1)).toEqual({ ok: true, tag_ids: [] })
    expect(one.tag_ids).toEqual([e(1)]) // 纯函数不改输入
    expect(removeTagIdFromGroup(one, 99)).toEqual({ ok: false, reason: 'not-found' })
    const two = g('b', [1, 2])
    const res = removeTagIdFromGroup(two, 1)
    expect(res).toEqual({ ok: true, tag_ids: [e(2)] })
  })

  it('.canSplitTagId 单 id 组不可拆', () => {
    expect(canSplitTagId(g('a', [1]))).toBe(false)
    expect(canSplitTagId(g('b', [1, 2]))).toBe(true)
  })

  it('.pickNewBlacklistEntries 表内已有 + 入参重复 皆滤除', () => {
    const list: TagBlacklistEntry[] = [{ id: 1, name: 'a' }]
    expect(blacklistHas(list, 1)).toBe(true)
    expect(blacklistHas(list, 2)).toBe(false)
    expect(pickNewBlacklistEntries(list, [e(1), e(2), e(2), e(3)])).toEqual([
      { id: 2, name: 'tag2' },
      { id: 3, name: 'tag3' },
    ])
  })

  it('.pickTagGroupsByIds tab2 选中组: 正常+挂起可列, 停用防御剔除, 按表序返回', () => {
    const groups = [
      g('normal', [1, 2]),
      g('suspended', [3], { weight: 0 }),
      g('disabled', [4], { enabled: false }),
      g('other', [5]),
    ]
    // 传入序乱序 => 返回仍按收藏表序; 停用组即使被选中也不进
    expect(pickTagGroupsByIds(groups, ['suspended', 'normal', 'disabled', 'ghost']).map((x) => x.id)).toEqual([
      'normal',
      'suspended',
    ])
    expect(pickTagGroupsByIds(groups, [])).toEqual([])
    expect(pickTagGroupsByIds(groups, ['disabled'])).toEqual([])
  })

  it('.unionTagIdsOfGroups 选中组 tag_id 并集去重保序 (预算小字 M 素材)', () => {
    const groups = [g('a', [1, 2]), g('b', [3]), g('c', [2, 4])] // 跨组重复 id 合法 (票 14)
    expect(unionTagIdsOfGroups(groups).map((x) => x.id)).toEqual([1, 2, 3, 4])
    expect(unionTagIdsOfGroups([])).toEqual([])
  })

  // #region 组内负向 (票 14)
  it('.makeTagGroup 负向字段: 组内互斥 (与正向同 id 剔除) + negative_strict 透传', () => {
    const group = makeTagGroup({
      name: 'x',
      tag_ids: [e(1), e(2)],
      negative_tag_ids: [e(2, 'collide'), e(7), e(7, 'dup')],
      negative_strict: true,
    })!
    expect(group.tag_ids.map((x) => x.id)).toEqual([1, 2])
    expect(group.negative_tag_ids).toEqual([e(7)])
    expect(group.negative_strict).toBe(true)
    expect(makeTagGroup({ name: 'y', tag_ids: [e(1)] })!.negative_tag_ids).toBeUndefined()
    expect(makeTagGroup({ name: 'y', tag_ids: [e(1)] })!.negative_strict).toBeUndefined()
  })

  it('.computeNegativeAdd 组内互斥: 已是负向跳过; 撞正向转负向; 唯一正向拒移 (不变式1)', () => {
    const grp = g('a', [1, 2], { negative_tag_ids: [e(7)] })
    const r = computeNegativeAdd(grp, [e(7), e(2), e(9), e(9)])
    expect(r.added).toBe(1) // 9
    expect(r.moved).toBe(1) // 2 从正向转负向
    expect(r.skipped).toBe(1) // 7 已是负向
    expect(r.refusedSole).toEqual([])
    expect(r.tag_ids.map((x) => x.id)).toEqual([1])
    expect(r.negative_tag_ids.map((x) => x.id)).toEqual([7, 2, 9])
    // 唯一正向拒转 (组至少留 1 个正向)
    const sole = computeNegativeAdd(g('s', [1]), [e(1)])
    expect(sole.refusedSole).toEqual([e(1)])
    expect(sole.tag_ids.map((x) => x.id)).toEqual([1])
    expect(sole.negative_tag_ids).toEqual([])
  })

  it('.findGroupsByNegativeTagId 多组命中全返回 (弹层「负向@组名」素材)', () => {
    const groups = [
      g('a', [1], { negative_tag_ids: [e(7)] }),
      g('b', [2]),
      g('c', [3], { negative_tag_ids: [e(7), e(8)] }),
    ]
    expect(findGroupsByNegativeTagId(groups, 7).map((x) => x.id)).toEqual(['a', 'c'])
    expect(findGroupsByNegativeTagId(groups, 8).map((x) => x.id)).toEqual(['c'])
    expect(findGroupsByNegativeTagId(groups, 99)).toEqual([])
  })

  it('.computeMergeGroups 负向并入: 并集去重 + 与合并后正向重叠者剔除 (互斥)', () => {
    const res = computeMergeGroups([
      g('older', [1], { addedAt: 100, negative_tag_ids: [e(7)] }),
      g('newer', [2, 7], { addedAt: 200, negative_tag_ids: [e(7), e(8), e(2)] }),
    ])!
    expect(res.tag_ids.map((x) => x.id)).toEqual([1, 2, 7])
    // 7/2 进了合并后正向 => 负向里剔除; 仅 8 留
    expect(res.negative_tag_ids.map((x) => x.id)).toEqual([8])
  })

  it('.shouldShowTagRecCustomDot 「指定标签」红点: 收藏表非空且未见过 => 亮; 见过/空表 => 灭', () => {
    expect(shouldShowTagRecCustomDot(false, 0)).toBe(false) // 空收藏表不亮
    expect(shouldShowTagRecCustomDot(false, 1)).toBe(true) // 非空+未见 => 亮
    expect(shouldShowTagRecCustomDot(true, 1)).toBe(false) // 激活过一次 => 永不再现
    expect(shouldShowTagRecCustomDot(true, 0)).toBe(false)
  })
  // #endregion
})
