import { describe, expect, it } from 'vitest'
import { buildTagQueryPlan, groupTagMatches, tagPeekPickedCount, tagPeekRows, toggleTagSelection } from './tag-peek'
import type { TagIdEntry } from './types'

const e = (id: number, name = `tag${id}`): TagIdEntry => ({ id, name })
const group = { tag_ids: [e(11, 'CHIP-A'), e(12, 'CHIP-B'), e(13, 'CHIP-C')] }

describe('组内标签勾选 / 查询计划', () => {
  it('勾选累积保序，重复 id 再点即取消', () => {
    let picked: TagIdEntry[] = []
    picked = toggleTagSelection(picked, e(1))
    picked = toggleTagSelection(picked, e(2))
    expect(picked.map((x) => x.id)).toEqual([1, 2])
    picked = toggleTagSelection(picked, e(1))
    expect(picked.map((x) => x.id)).toEqual([2])
  })

  it('空选 => 无计划（不发起查询）', () => {
    expect(buildTagQueryPlan([])).toBeUndefined()
  })

  it('单标签 => 锚点即它，无扩选', () => {
    const plan = buildTagQueryPlan([e(7, '鸣潮')])
    expect(plan).toEqual({ anchor: { id: 7, name: '鸣潮' }, expanded: [] })
  })

  it('多标签 => 首个当锚点，其余进扩选（顺序保留）', () => {
    const plan = buildTagQueryPlan([e(7, '鸣潮'), e(8, '心月狐'), e(9, '漂泊者')])
    expect(plan?.anchor.name).toBe('鸣潮')
    expect(plan?.expanded.map((x) => x.name)).toEqual(['心月狐', '漂泊者'])
  })
})

describe('组内标签 chip 行投影', () => {
  it('未选时全为未选中，且保组内原序', () => {
    expect(tagPeekRows(group, [])).toEqual([
      { id: 11, name: 'CHIP-A', picked: false },
      { id: 12, name: 'CHIP-B', picked: false },
      { id: 13, name: 'CHIP-C', picked: false },
    ])
  })

  it('跨组选中态正确投影到本组（只影响本组该行）', () => {
    const picked = [e(12, 'CHIP-B'), e(99, '别组的')]
    expect(tagPeekRows(group, picked).map((r) => r.picked)).toEqual([false, true, false])
    expect(tagPeekPickedCount(group, picked)).toBe(1)
  })

  it('无标签组 => 空行、计数 0', () => {
    expect(tagPeekRows({ tag_ids: [] }, [e(11)])).toEqual([])
    expect(tagPeekPickedCount({ tag_ids: [] }, [e(11)])).toBe(0)
  })

  it('q 非空时命中 chip 排前（稳定序），q 空保原序', () => {
    const g = { tag_ids: [e(1, '魔剑姬'), e(2, '学生会也有洞'), e(3, '学生会!'), e(4, '今村亮')] }
    expect(tagPeekRows(g, [], '学生会').map((r) => r.name)).toEqual(['学生会也有洞', '学生会!', '魔剑姬', '今村亮'])
    expect(tagPeekRows(g, []).map((r) => r.name)).toEqual(['魔剑姬', '学生会也有洞', '学生会!', '今村亮'])
  })
})

describe('组级搜索命中（组名 or 组内标签名）', () => {
  const twGroup = { name: '學生會也有洞', tag_ids: [e(1, '學生會也有洞'), e(2, '学生会也有洞'), e(3, '魔剑姬')] }

  it('简体词命中简体 tag 变体 => 繁体组名也能搜出来', () => {
    expect(groupTagMatches(twGroup, '学生会')).toBe(true)
    expect(groupTagMatches(twGroup, '學生會')).toBe(true)
    expect(groupTagMatches(twGroup, '流浪')).toBe(false)
  })

  it('组名直接命中', () => {
    expect(groupTagMatches({ name: '鸣潮', tag_ids: [] }, '鸣潮')).toBe(true)
  })

  it('大小写不敏感；空 q => false', () => {
    expect(groupTagMatches({ name: 'abc', tag_ids: [e(1, 'XYZ')] }, 'xyz')).toBe(true)
    expect(groupTagMatches(twGroup, '')).toBe(false)
    expect(groupTagMatches(twGroup, ' '.repeat(3))).toBe(false)
  })
})
