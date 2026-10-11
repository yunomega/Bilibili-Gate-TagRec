import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import {
  previewTagRecFairSlice,
  spliceTagRecAtomFairSlice,
  TagRecFairState,
  tagRecStockCounts,
  trimTagRecStock,
  WeightedTurns,
} from './fair-queue'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagGroup, TagL1Group } from '../model/types'

const parent = (id: string, weight = 1): TagL1Group => ({ id, name: id, enabled: true, weight, addedAt: 0 })
const group = (id: string, l1Id = 'p', weight = 1): TagGroup => ({
  id,
  l1Id,
  name: id,
  weight,
  enabled: true,
  addedAt: 0,
  tag_ids: [{ id: 1, name: 'tag' }],
})
const stock = (id: string, count: number): TagRecItemExtend[] =>
  Array.from({ length: count }, (_, n) => ({
    api: EApiType.TagRec,
    bvid: `${id}-${n}`,
    uniqId: `${id}-${n}`,
    title: id,
    pic: '',
    stat: {},
    score: count - n,
    source: { via: 'tag-top', groupIds: [id], groupNames: [id] },
  }))
const counts = (items: RecItemTypeOrSeparator[]) => {
  const result: Record<string, number> = {}
  for (const item of items)
    if (item.api === EApiType.TagRec) {
      const id = item.source.groupIds![0]
      result[id] = (result[id] ?? 0) + 1
    }
  return result
}
const take = (
  queue: RecItemTypeOrSeparator[],
  groups: TagGroup[],
  parents: TagL1Group[],
  state: TagRecFairState,
  n = 20,
) => {
  const preview = previewTagRecFairSlice(queue, groups, parents, state, n)
  const selected = new Set(preview.items)
  state.commit(preview.turns, selected)
  for (let i = queue.length - 1; i >= 0; i--) if (selected.has(queue[i])) queue.splice(i, 1)
  return preview.items
}

describe('收藏推荐按实际交付分层轮换', () => {
  it('A200/B20/C20/D20/E20：前五批各组各4条，余量保留，不受标签数影响', () => {
    const groups = ['A', 'B', 'C', 'D', 'E'].map((id) => group(id))
    groups[0].tag_ids = Array.from({ length: 100 }, (_, id) => ({ id, name: `${id}` }))
    const queue = groups.flatMap((g) => stock(g.id, g.id === 'A' ? 200 : 20))
    const state = new TagRecFairState()
    const seen = new Set<string>()
    for (let page = 0; page < 5; page++) {
      const items = take(queue, groups, [parent('p')], state)
      expect(counts(items)).toEqual({ A: 4, B: 4, C: 4, D: 4, E: 4 })
      for (const item of items as TagRecItemExtend[]) {
        expect(seen.has(item.bvid)).toBe(false)
        seen.add(item.bvid)
      }
    }
    expect(queue).toHaveLength(180)
    expect(counts(take(queue, groups, [parent('p')], state))).toEqual({ A: 20 })
  })

  it('父组各一份：A下10个二级组，B下1个，父组仍各10条', () => {
    const groups = [...Array.from({ length: 10 }, (_, i) => group(`A${i}`, 'A')), group('B0', 'B')]
    const queue = groups.flatMap((g) => stock(g.id, 100))
    const items = take(queue, groups, [parent('A'), parent('B')], new TagRecFairState())
    const n = counts(items)
    expect(n.B0).toBe(10)
    expect(
      Object.entries(n)
        .filter(([id]) => id.startsWith('A'))
        .reduce((sum, [, count]) => sum + count, 0),
    ).toBe(10)
    for (let i = 0; i < 10; i++) expect(n[`A${i}`]).toBe(1)
  })

  it('父组和二级组权重分别影响展示份额，不叠乘标签数', () => {
    const groups = [group('a', 'A', 5), group('b', 'A'), group('c', 'B')]
    const queue = groups.flatMap((g) => stock(g.id, 500))
    const state = new TagRecFairState()
    const all = Array.from({ length: 36 }, () => take(queue, groups, [parent('A', 5), parent('B')], state)).flat()
    expect(counts(all)).toEqual({ a: 500, b: 100, c: 120 })
  })

  it('缺货自动补位且不积累无限欠额', () => {
    const groups = [group('A'), group('B')]
    const queue = [...stock('A', 80), ...stock('B', 2)]
    const state = new TagRecFairState()
    expect(counts(take(queue, groups, [parent('p')], state))).toEqual({ A: 18, B: 2 })
    expect(counts(take(queue, groups, [parent('p')], state))).toEqual({ A: 20 })
    queue.push(...stock('B', 50))
    expect(counts(take(queue, groups, [parent('p')], state))).toEqual({ A: 10, B: 10 })
  })

  it('预演不修改库存或进度；严格校验拒绝不消耗展示名额', () => {
    const groups = [group('A'), group('B')]
    const queue = [...stock('A', 30), ...stock('B', 30)]
    const state = new TagRecFairState()
    const preview = previewTagRecFairSlice(queue, groups, [parent('p')], state, 2)
    expect(queue).toHaveLength(60)
    expect(previewTagRecFairSlice(queue, groups, [parent('p')], state, 2).items).toEqual(preview.items)
    state.commit(preview.turns, new Set([preview.items[1]]))
    expect(counts(previewTagRecFairSlice(queue, groups, [parent('p')], state, 1).items)).toEqual({ A: 1 })
  })

  it('同一视频多组认领仍只交付一次，完整归因不变', () => {
    const groups = [group('A'), group('B')]
    const shared = stock('shared', 30)
    for (const item of shared) {
      item.source.groupIds = ['A', 'B']
      item.source.groupNames = ['A', 'B']
    }
    const queue = [...shared]
    expect([...tagRecStockCounts(queue, groups).values()]).toEqual([15, 15])
    const result = take(queue, groups, [parent('p')], new TagRecFairState()) as TagRecItemExtend[]
    expect(new Set(result.map((it) => it.bvid)).size).toBe(20)
    expect(result.every((it) => it.source.groupIds?.join(',') === 'A,B')).toBe(true)
  })

  it('总缓存满时削最大库存，保留小组内容，淘汰尾部低分候选', () => {
    const groups = [group('A'), group('B')]
    const queue = [...stock('A', 50), ...stock('B', 10)]
    const removed = trimTagRecStock(queue, groups, 100, 20)
    expect(removed).toHaveLength(40)
    expect(counts(queue)).toEqual({ A: 10, B: 10 })
    expect((queue[0] as TagRecItemExtend).bvid).toBe('A-0')
  })

  it('UP护栏作用于实际混排批，而非每个组自己的虚拟切片', () => {
    const groups = [group('A'), group('B')]
    const a = stock('A', 100).map((it) => ({ ...it, owner: { mid: 1 } }))
    const b = stock('B', 100).map((it, mid) => ({ ...it, owner: { mid: mid + 10 } }))
    const result = previewTagRecFairSlice([...a, ...b], groups, [parent('p')], new TagRecFairState(), 20, {
      group: { enabled: true, maxShare: 0.6 },
      up: { enabled: true, max: 4 },
    }).items as TagRecItemExtend[]
    expect(result.filter((it) => it.owner?.mid === 1)).toHaveLength(4)
    expect(result).toHaveLength(20)
  })
})

describe('组合组内原子级公平选片 (spliceTagRecAtomFairSlice)', () => {
  // bvid 前缀 = 命中原子集: 'ab-1' 命中 a+b, 'x-1' 无命中 (未判定/无证据)
  const atomKeys = (item: TagRecItemExtend) => {
    const prefix = item.bvid.split('-', 1)[0]
    return prefix === 'x' ? [] : [...prefix]
  }
  const pick = (working: RecItemTypeOrSeparator[], n: number, turns: WeightedTurns) =>
    spliceTagRecAtomFairSlice(working, n, turns, atomKeys)

  it('新加原子排在源序末尾也不被压住: 首屏三桶各取公平份额', () => {
    const working: RecItemTypeOrSeparator[] = [...stock('a', 20), ...stock('b', 20), ...stock('c', 20)]
    const turns = new WeightedTurns()
    const slice = pick(working, 20, turns)
    // 等权轮转: 20 取 = 7/7/6, 与队列内源序 (c 在最后) 无关
    expect(counts(slice)).toEqual({ a: 7, b: 7, c: 6 })
    expect(working).toHaveLength(40)
  })

  it('跨页欠额平滑: 第二页从上次落点继续, 不每页从首桶重开', () => {
    const working: RecItemTypeOrSeparator[] = [...stock('a', 20), ...stock('b', 20), ...stock('c', 20)]
    const turns = new WeightedTurns()
    expect(counts(pick(working, 2, turns))).toEqual({ a: 1, b: 1 })
    // 欠额记账: 上一页 a/b 各欠 1, 本页先补 c 再回 a
    expect(counts(pick(working, 2, turns))).toEqual({ a: 1, c: 1 })
  })

  it('多命中条归当前最短板; 无命中条不参与轮转, 兜底按原序补足', () => {
    const working: RecItemTypeOrSeparator[] = [...stock('a', 5), ...stock('ab', 4), ...stock('x', 10)]
    const turns = new WeightedTurns()
    const slice = pick(working, 12, turns) as TagRecItemExtend[]
    // ab 条 (a+b 双命中) 归空桶 b; 公平位 a5+b4 取完 9 条后, x 条按原序补 3 条
    expect(counts(slice)).toEqual({ a: 5, ab: 4, x: 3 })
    expect(slice.slice(9).map((it) => it.bvid)).toEqual(['x-0', 'x-1', 'x-2'])
  })

  it('桶内先按质量序取条, 且死桶跨页自动失效', () => {
    const working: RecItemTypeOrSeparator[] = [...stock('a', 3)]
    const turns = new WeightedTurns()
    // stock 的 score 降序 = 序号升序, 桶内质量序应取 a-0 而非队尾条
    const first = pick(working, 1, turns) as TagRecItemExtend[]
    expect(first[0].bvid).toBe('a-0')
    // a 桶取空后新到 b 桶: 欠额记账对死键自动失效, b 照常轮转
    pick(working, 2, turns)
    working.push(...stock('b', 3))
    expect(counts(pick(working, 3, turns))).toEqual({ b: 3 })
  })
})
