import { proxy, snapshot } from 'valtio'
import { describe, expect, it } from 'vitest'
import { lookupSnapshotCardOwners } from './card-owners'
import { resolveLandingGroups } from './tag-status'

describe('卡片认领组快照索引', () => {
  const groups = Object.freeze([
    { id: 'a', name: 'A' },
    { id: 'b', name: '重名' },
    { id: 'c', name: '重名' },
    { id: 'd', name: 'D' },
  ])

  it.each([
    { names: ['D', 'A·相关', 'A'], ids: undefined },
    { names: ['重名'], ids: undefined },
    { names: ['D', '不存在'], ids: undefined },
    { names: ['A'], ids: ['d', 'b', 'd'] },
    { names: ['A'], ids: ['已删除'] },
    { names: [], ids: undefined },
  ])('保持名称消歧、稳定 ID 与收藏表顺序：%j', ({ names, ids }) => {
    expect(lookupSnapshotCardOwners(groups, names, ids).matched).toEqual(resolveLandingGroups(groups, [], names, ids))
  })

  it('未归属名称允许草稿兜底，同名歧义和缺失稳定 ID 不误落草稿', () => {
    expect(lookupSnapshotCardOwners(groups, ['未知·相关']).hasUnowned).toBe(true)
    expect(lookupSnapshotCardOwners(groups, ['重名']).hasUnowned).toBe(false)
    expect(lookupSnapshotCardOwners(groups, ['未知'], ['已删除']).hasUnowned).toBe(false)
  })

  it('收藏修改后的新快照更新名称、消歧和已删除组', () => {
    const store = proxy({
      list: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    })
    const before = snapshot(store).list
    expect(lookupSnapshotCardOwners(before, ['A']).matched.map((g) => g.id)).toEqual(['a'])
    store.list[0]!.name = 'B'
    const renamed = snapshot(store).list
    expect(lookupSnapshotCardOwners(renamed, ['A']).hasUnowned).toBe(true)
    expect(lookupSnapshotCardOwners(renamed, ['B']).matched).toEqual([])
    expect(lookupSnapshotCardOwners(renamed, [], ['a']).matched[0]!.name).toBe('B')
    store.list.splice(0, 1)
    expect(lookupSnapshotCardOwners(snapshot(store).list, ['B']).matched.map((g) => g.id)).toEqual(['b'])
    expect(lookupSnapshotCardOwners(snapshot(store).list, [], ['a']).matched).toEqual([])
    // 历史快照不被后来的编辑污染。
    expect(lookupSnapshotCardOwners(before, ['A']).matched[0]!.name).toBe('A')
  })

  it('大收藏表加载不同来源的卡片，不再逐卡全表扫描', () => {
    let nameReads = 0
    const large = Object.freeze(
      Array.from({ length: 2000 }, (_, i) =>
        Object.freeze({
          id: `${i}`,
          get name() {
            nameReads++
            return `组${i}`
          },
        }),
      ),
    )
    for (let i = 0; i < 100; i++) {
      expect(lookupSnapshotCardOwners(large, [`组${i}`]).matched[0]!.id).toBe(`${i}`)
    }
    expect(nameReads).toBeLessThan(5000) // 未缓存时 100 张卡至少读取 20 万次组名。
  })
})
