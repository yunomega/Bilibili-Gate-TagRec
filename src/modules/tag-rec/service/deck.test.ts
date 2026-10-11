import { describe, expect, it } from 'vitest'
import {
  buildDeckPile,
  deckFingerprint,
  isDeckDrawable,
  isL1Drawable,
  pickTagIdsForRound,
  TagRecDeck,
  TagRecUnitsDeck,
  unitsFingerprint,
  withTagRecTempEnables,
} from './deck'
import type { TagGroup, TagL1Group } from '../model/types'

const g = (id: string, ids: number[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: id,
  tag_ids: ids.map((id) => ({ id, name: `tag${id}` })),
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})

/** 确定性洗牌: 恒等 (堆序 = 组建堆序, pop 从尾抽) */
const identity = <T>(arr: T[]) => arr
const ids = (groups: TagGroup[]) => groups.map((x) => x.id)

describe.concurrent('$modules/tag-rec/service/deck', () => {
  it('.isDeckDrawable 三态过滤: 仅 enabled&&weight>0 入抽', () => {
    expect(isDeckDrawable({ weight: 1, enabled: true })).toBe(true)
    expect(isDeckDrawable({ weight: 5, enabled: true })).toBe(true)
    expect(isDeckDrawable({ weight: 0, enabled: true })).toBe(false) // 挂起
    expect(isDeckDrawable({ weight: 0, enabled: false })).toBe(false) // 停用
    expect(isDeckDrawable({ weight: 3, enabled: false })).toBe(false)
  })

  it('.buildDeckPile weight=张数入堆; 挂起/停用不入堆', () => {
    const pile = buildDeckPile(
      [
        g('a', [1], { weight: 2 }),
        g('b', [2], { weight: 0 }),
        g('c', [3], { weight: 3 }),
        g('d', [4], { enabled: false }),
      ],
      identity,
    )
    expect(pile).toEqual(['a', 'a', 'c', 'c', 'c'])
  })

  it('.deckFingerprint 资格指纹: name/note 不动, 资格字段变即变', () => {
    const groups = [g('a', [1]), g('b', [2], { weight: 2 })]
    const fp = deckFingerprint(groups)
    // name/note 改动不动指纹
    expect(deckFingerprint(groups.map((x) => ({ ...x, name: '改名', note: 'n' })))).toBe(fp)
    // 组序不敏感
    expect(deckFingerprint([...groups].reverse())).toBe(fp)
    // 资格字段 (enabled/weight/tag_ids/增删) 变即变
    expect(deckFingerprint(groups.map((x) => (x.id === 'a' ? { ...x, weight: 2 } : x)))).not.toBe(fp)
    expect(deckFingerprint(groups.map((x) => (x.id === 'a' ? { ...x, enabled: false } : x)))).not.toBe(fp)
    expect(
      deckFingerprint(groups.map((x) => (x.id === 'a' ? { ...x, tag_ids: [{ id: 9, name: 't9' }] } : x))),
    ).not.toBe(fp)
    expect(deckFingerprint([...groups, g('c', [3])])).not.toBe(fp)
  })

  it('.drawGroups 不放回抽 K 个不同组 (逐张抽, 同组重复卡即废)', () => {
    const deck = new TagRecDeck(identity)
    // pile = [a,a,b,c,c,c], pop 从尾: c,c,c,b,a,a —— k=1 每轮 1 组, 6 轮抽干
    const groups = [g('a', [1], { weight: 2 }), g('b', [2]), g('c', [3], { weight: 3 })]
    const drawn = Array.from({ length: 6 }, () => ids(deck.drawGroups(groups, 1)))
    expect(drawn).toEqual([['c'], ['c'], ['c'], ['b'], ['a'], ['a']])
    expect(deck.pileSize).toBe(0)
  })

  it('.drawGroups 一轮内返回 K 个不同组 + 残堆续抽/抽干补堆 (A1-1: 残堆不丢)', () => {
    const deck = new TagRecDeck(identity)
    const groups = [g('a', [1], { weight: 2 }), g('b', [2]), g('c', [3], { weight: 3 })]
    // k=2: 第1轮 pop c×3(废2)+b => {c,b}; 剩 [a,a] 残堆保留不丢
    expect(ids(deck.drawGroups(groups, 2))).toEqual(['c', 'b'])
    expect(deck.pileSize).toBe(2) // 抽剩 [a,a]
    // 第2轮: 残堆 pop a,a(1中1废) 抽干未凑够 => 剔除已中 a 补堆 [b,c,c,c] pop c => {a,c}
    expect(ids(deck.drawGroups(groups, 2))).toEqual(['a', 'c'])
    expect(deck.pileSize).toBe(3) // 补堆剩 [b,c,c]
    // 第3轮: pop c(中),c(废),b(中) => {c,b}, 抽干
    expect(ids(deck.drawGroups(groups, 2))).toEqual(['c', 'b'])
    expect(deck.pileSize).toBe(0)
    // 第4轮: 空堆 => 整副重建 [a,a,b,c,c,c] => {c,b}
    expect(ids(deck.drawGroups(groups, 2))).toEqual(['c', 'b'])
    expect(deck.pileSize).toBe(2)
  })

  it('.drawGroups 不放回跨轮保持: 残堆单位不跳员 (A1-1 回归: 3组w1/k2 旧实现恒丢 1 组)', () => {
    const deck = new TagRecDeck(identity)
    const groups = [g('a', [1]), g('b', [2]), g('c', [3])]
    // 旧实现: pile=[a,b,c] r1={c,b} 残堆[a]卡数<k 整副重洗 => a 永不中
    // 新实现: r2 残堆 a 先中, 补堆 [b,c] 续抽 => 三组 3 轮内全出镜
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) for (const id of ids(deck.drawGroups(groups, 2))) seen.add(id)
    expect(seen).toEqual(new Set(['a', 'b', 'c']))
  })

  it('.drawGroups 资格指纹变即重建牌堆; name/note 不动牌堆', () => {
    const deck = new TagRecDeck(identity)
    const groups = [g('a', [1]), g('b', [2])]
    // pile=[a,b]: 第1轮抽 b, 剩 [a]
    expect(ids(deck.drawGroups(groups, 1))).toEqual(['b'])
    expect(deck.pileSize).toBe(1)

    // name/note 改动 => 指纹不变 => 不重建 => 续抽剩 [a]
    const renamed = groups.map((x) => ({ ...x, name: `${x.id}-renamed`, note: 'n' }))
    expect(ids(deck.drawGroups(renamed, 1))).toEqual(['a'])
    expect(deck.pileSize).toBe(0)

    // weight 改动 => 指纹变 => 重建满堆 [a,a,b] => 抽 b
    const reweighted = groups.map((x) => (x.id === 'a' ? { ...x, weight: 2 } : x))
    expect(ids(deck.drawGroups(reweighted, 1))).toEqual(['b'])
    expect(deck.pileSize).toBe(2)

    // enabled=false => 指纹变 => 重建只剩新资格集 [b]
    const disabled = reweighted.map((x) => (x.id === 'a' ? { ...x, enabled: false } : x))
    expect(ids(deck.drawGroups(disabled, 1))).toEqual(['b'])
    expect(deck.pileSize).toBe(0)
  })

  it('.drawGroups 资格组不足 K => 返回全部资格组; 无资格组 => []', () => {
    const deck = new TagRecDeck(identity)
    const groups = [g('a', [1]), g('b', [2], { weight: 0 }), g('c', [3], { enabled: false })]
    expect(ids(deck.drawGroups(groups, 3))).toEqual(['a']) // 仅 a 可抽
    // 全挂起/停用
    const deck2 = new TagRecDeck(identity)
    expect(deck2.drawGroups([g('x', [1], { weight: 0 }), g('y', [2], { enabled: false })], 3)).toEqual([])
    // 空表
    expect(new TagRecDeck(identity).drawGroups([], 3)).toEqual([])
  })

  it('.drawGroups 停用/挂起组永不入抽 (多轮采样断言)', () => {
    const deck = new TagRecDeck() // 真洗牌: 10 轮采样内只应出现 a
    const groups = [g('a', [1]), g('b', [2], { weight: 0 }), g('c', [3], { enabled: false })]
    for (let i = 0; i < 10; i++) {
      for (const grp of deck.drawGroups(groups, 1)) {
        expect(grp.id).toBe('a')
      }
    }
  })
})

const l1 = (id: string, extra: Partial<TagL1Group> = {}): TagL1Group => ({
  id,
  name: `L1-${id}`,
  enabled: true,
  weight: 1,
  addedAt: 0,
  ...extra,
})

describe.concurrent('$modules/tag-rec/service/deck 三层抽样 (票 17)', () => {
  it('预取窗口在父组间分配多个不同二级组，同时遵守父组数和总组数上限', () => {
    const groups = [
      ...Array.from({ length: 6 }, (_, n) => g(`a${n}`, [n], { l1Id: 'A' })),
      ...Array.from({ length: 6 }, (_, n) => g(`b${n}`, [10 + n], { l1Id: 'B' })),
    ]
    const l1s = [l1('A'), l1('B')]
    const deck = new TagRecUnitsDeck(identity)
    const both = deck.drawUnits(groups, l1s, 2, undefined, undefined, 5)
    expect(both).toHaveLength(5)
    expect(new Set(both.map((g) => g.id)).size).toBe(5)
    expect(both.filter((g) => g.l1Id === 'A')).toHaveLength(2)
    expect(both.filter((g) => g.l1Id === 'B')).toHaveLength(3)
    const single = deck.drawUnits(groups, l1s, 1, undefined, undefined, 5)
    expect(single).toHaveLength(5)
    expect(new Set(single.map((g) => g.l1Id)).size).toBe(1)
    expect(deck.drawUnits(groups, l1s, 2, undefined, undefined, 1)).toHaveLength(1)
  })

  it('.isL1Drawable: 语义同 L2 —— enabled && weight>0', () => {
    expect(isL1Drawable({ id: 'A', enabled: true, weight: 1 })).toBe(true)
    expect(isL1Drawable({ id: 'A', enabled: true, weight: 0 })).toBe(false)
    expect(isL1Drawable({ id: 'A', enabled: false, weight: 3 })).toBe(false)
  })

  it('.isL1Drawable 查看范围 (R7): viewedL1Ids 非空 => 还要求 L1 在范围内; undefined=不过滤', () => {
    const base = { id: 'A', enabled: true, weight: 1 }
    expect(isL1Drawable(base, new Set(['A']))).toBe(true)
    expect(isL1Drawable(base, new Set(['X']))).toBe(false) // 范围外不入
    expect(isL1Drawable(base, undefined)).toBe(true) // 不筛
    expect(isL1Drawable({ ...base, enabled: false }, new Set(['A']))).toBe(false) // 停用先出局
    expect(isL1Drawable({ ...base, weight: 0 }, new Set(['A']))).toBe(false) // 挂起同理
  })

  it('.withTagRecTempEnables: 临时集内 L1 视同 enabled (映射副本, 不改原表)', () => {
    const l1s = [l1('A', { enabled: false }), l1('B')]
    const merged = withTagRecTempEnables(l1s, ['A'])
    expect(merged.find((x) => x.id === 'A')!.enabled).toBe(true)
    expect(merged.find((x) => x.id === 'B')!.enabled).toBe(true)
    expect(l1s[0].enabled).toBe(false) // 原表不动
    expect(withTagRecTempEnables(l1s, undefined)[0].enabled).toBe(false)
    expect(withTagRecTempEnables(l1s, [])[0].enabled).toBe(false)
  })

  it('.unitsFingerprint 资格指纹: L1 三态 + l1Id 归属 + L2 资格项全覆盖; name/note 不动; 序不敏感', () => {
    const groups = [g('a', [1], { l1Id: 'A' }), g('b', [2], { l1Id: 'B', weight: 2 })]
    const l1s = [l1('A'), l1('B')]
    const fp = unitsFingerprint(groups, l1s)
    // 显示字段 (name/note) 不动指纹
    expect(
      unitsFingerprint(
        groups.map((x) => ({ ...x, name: '改名', note: 'n' })),
        l1s.map((l) => ({ ...l, name: 'L改名' })),
      ),
    ).toBe(fp)
    // 序不敏感
    expect(unitsFingerprint([...groups].reverse(), [...l1s].reverse())).toBe(fp)
    // L1 三态变即变
    expect(
      unitsFingerprint(
        groups,
        l1s.map((l) => (l.id === 'A' ? { ...l, enabled: false } : l)),
      ),
    ).not.toBe(fp)
    expect(
      unitsFingerprint(
        groups,
        l1s.map((l) => (l.id === 'A' ? { ...l, weight: 2 } : l)),
      ),
    ).not.toBe(fp)
    expect(unitsFingerprint(groups, [...l1s, l1('C')])).not.toBe(fp)
    // 归属 (l1Id) 变即变
    expect(
      unitsFingerprint(
        groups.map((x) => (x.id === 'a' ? { ...x, l1Id: 'B' } : x)),
        l1s,
      ),
    ).not.toBe(fp)
    // L2 自身资格项 (enabled/weight/tag_ids) 变即变
    expect(
      unitsFingerprint(
        groups.map((x) => (x.id === 'a' ? { ...x, enabled: false } : x)),
        l1s,
      ),
    ).not.toBe(fp)
    expect(
      unitsFingerprint(
        groups.map((x) => (x.id === 'a' ? { ...x, weight: 0 } : x)),
        l1s,
      ),
    ).not.toBe(fp)
    expect(
      unitsFingerprint(
        groups.map((x) => (x.id === 'a' ? { ...x, tag_ids: [{ id: 9, name: 't9' }] } : x)),
        l1s,
      ),
    ).not.toBe(fp)
  })

  it('.unitsFingerprint 含查看范围 (R7): 范围变即重建; 范围外 L1 字段折叠; 序不敏感', () => {
    const groups = [g('a', [1], { l1Id: 'A' }), g('b', [2], { l1Id: 'B' })]
    const l1s = [l1('A'), l1('B')]
    const fpAll = unitsFingerprint(groups, l1s) // 无筛
    const fpA = unitsFingerprint(groups, l1s, new Set(['A']))
    expect(fpA).not.toBe(fpAll) // 范围收窄 => 指纹变
    expect(unitsFingerprint(groups, l1s, new Set(['B']))).not.toBe(fpA)
    expect(unitsFingerprint(groups, l1s, new Set(['A', 'B']))).not.toBe(fpAll) // 显式全量 ≠ 无筛段
    // 范围外 L1 的字段变 (weight) 折叠不影响 (off 位)
    expect(
      unitsFingerprint(
        groups,
        l1s.map((l) => (l.id === 'B' ? { ...l, weight: 5 } : l)),
        new Set(['A']),
      ),
    ).toBe(fpA)
    // 序不敏感
    expect(unitsFingerprint(groups, [...l1s].reverse(), new Set(['A']))).toBe(fpA)
  })

  it('.drawUnits 查看范围过滤 (R7): 只抽范围内 L1; undefined=不筛; 空范围 => []', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [l1('A'), l1('B'), l1('C')]
    const groups = [g('a1', [1], { l1Id: 'A' }), g('b1', [2], { l1Id: 'B' }), g('c1', [3], { l1Id: 'C' })]
    // 范围 {A} => 只有 A 可入堆
    for (let i = 0; i < 3; i++) expect(ids(deck.drawUnits(groups, l1s, 3, new Set(['A'])))).toEqual(['a1'])
    // 切到 {C} => 指纹变 => 重建只剩 C
    expect(ids(deck.drawUnits(groups, l1s, 3, new Set(['C'])))).toEqual(['c1'])
    // 空范围 => 空集
    expect(ids(deck.drawUnits(groups, l1s, 3, new Set()))).toEqual([])
    // 回不筛 => 指纹变 => 重建全量 (identity pop 从尾: C,B)
    expect(ids(deck.drawUnits(groups, l1s, 2))).toEqual(['c1', 'b1'])
  })

  it('.drawUnits 范围内 L1 停用 => 无可抽单位 => [] (零写入: 查看范围不动 enabled)', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [l1('A', { enabled: false }), l1('B')]
    const groups = [g('a1', [1], { l1Id: 'A' }), g('b1', [2], { l1Id: 'B' })]
    expect(ids(deck.drawUnits(groups, l1s, 2, new Set(['A', 'B'])))).toEqual(['b1']) // A 停用不入, B 照常
    expect(ids(deck.drawUnits(groups, [l1('A', { enabled: false })], 2, new Set(['A'])))).toEqual([])
  })

  it('.drawUnits 外层单位过滤: 无可抽 L2 的 L1 / 停用 / weight=0 / 裸奔组 皆不入堆', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [
      l1('A'), // 麾下 a1 正常 => 唯一可抽单位
      l1('B'), // 麾下 L2 全挂起 => 不成单位
      l1('C'), // 空 L1 (保留但无资格, spec)
      l1('D', { enabled: false }), // 停用 => 麾下 d1 正常也不入
      l1('E', { weight: 0 }), // weight=0 => 不入
    ]
    const groups = [
      g('a1', [1], { l1Id: 'A' }),
      g('b1', [2], { l1Id: 'B', weight: 0 }), // 挂起
      g('d1', [3], { l1Id: 'D' }),
      g('e1', [4], { l1Id: 'E' }),
      g('x', [5]), // 裸奔 => 防御不入
      g('y', [6], { l1Id: 'ghost' }), // 悬挂已删 L1 => 不成单位
    ]
    for (let i = 0; i < 5; i++) {
      expect(ids(deck.drawUnits(groups, l1s, 3))).toEqual(['a1'])
    }
  })

  it('.drawUnits 外层不放回抽 K 个不同 L1 => 各解析 1 个麾下 L2; 无可抽单位 => []', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [l1('A'), l1('B'), l1('C')]
    const groups = [g('a1', [1], { l1Id: 'A' }), g('b1', [2], { l1Id: 'B' }), g('c1', [3], { l1Id: 'C' })]
    // 外层 pile=[A,B,C] (各1张) pop 从尾 => C,B => 中层各抽独苗 c1,b1
    expect(ids(deck.drawUnits(groups, l1s, 2))).toEqual(['c1', 'b1'])
    expect(deck.pileSize).toBe(1) // 剩 [A]
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['a1']) // k=1 不大于余量 => 余堆续抽
    expect(ids(deck.drawUnits(groups, l1s, 2))).toEqual(['c1', 'b1']) // 空堆 <K => 整副重洗
    expect(new TagRecUnitsDeck(identity).drawUnits(groups, [], 3)).toEqual([]) // 无 L1 表
    expect(new TagRecUnitsDeck(identity).drawUnits([], l1s, 3)).toEqual([]) // 无 L2
  })

  it('.drawUnits 中层按 L2 weight 分布抽 1 (确定性洗牌: 满堆周期内命中 = weight 张数)', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [l1('A')]
    const groups = [g('big', [1], { l1Id: 'A', weight: 3 }), g('small', [2], { l1Id: 'A', weight: 1 })]
    // 中层 pile=[big,big,big,small] identity pop => small,big,big,big 循环 => 4 轮 3:1
    const counts = new Map<string, number>()
    for (let i = 0; i < 8; i++) {
      for (const x of deck.drawUnits(groups, l1s, 1)) counts.set(x.id, (counts.get(x.id) ?? 0) + 1)
    }
    expect(counts.get('big')).toBe(6)
    expect(counts.get('small')).toBe(2)
  })

  it('.drawUnits 中层小堆随麾下资格集重建 (成员进出/资格字段变即重建)', () => {
    const deck = new TagRecUnitsDeck(identity)
    const l1s = [l1('A')]
    let groups = [g('x', [1], { l1Id: 'A' }), g('y', [2], { l1Id: 'A' })]
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['y']) // pile=[x,y] pop y, 剩 [x]
    // y 挂起 => 指纹变 => 重建只剩 x
    groups = groups.map((x) => (x.id === 'y' ? { ...x, weight: 0 } : x))
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['x'])
    // 新组 z 挂进 A => 指纹变 => 重建 [x,z] pop z
    groups = [...groups, g('z', [3], { l1Id: 'A' })]
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['z'])
  })

  it('.drawUnits L1 停用 => 外层指纹变 => 重建剔除 (麾下正常 L2 也不出)', () => {
    const deck = new TagRecUnitsDeck(identity)
    let l1s = [l1('A'), l1('B')]
    const groups = [g('a1', [1], { l1Id: 'A' }), g('b1', [2], { l1Id: 'B' })]
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['b1']) // pile=[A,B] pop B
    // B 停用 => 外层重建只剩 A => 续抽 a1 (非上轮余堆)
    l1s = l1s.map((l) => (l.id === 'B' ? { ...l, enabled: false } : l))
    expect(ids(deck.drawUnits(groups, l1s, 1))).toEqual(['a1'])
    expect(deck.pileSize).toBe(0)
  })

  it('.pickTagIdsForRound: ≤10 全量; >10 轮转取 10 切片, 游标推进回绕覆盖全量', () => {
    const ids12 = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `t${i + 1}` }))
    const few = ids12.slice(0, 5)
    expect(pickTagIdsForRound(few, 3)).toEqual({ entries: few, nextCursor: 0 }) // ≤10 全量, 游标归零
    let r = pickTagIdsForRound(ids12, 0)
    expect(r.entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(r.nextCursor).toBe(10)
    r = pickTagIdsForRound(ids12, r.nextCursor) // 回绕切片 [11,12,1..8]
    expect(r.entries.map((e) => e.id)).toEqual([11, 12, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(r.nextCursor).toBe(8)
    // 逐轮推进切片并集覆盖全量
    const seen = new Set<number>()
    let cur = 0
    for (let i = 0; i < 4; i++) {
      const p = pickTagIdsForRound(ids12, cur)
      cur = p.nextCursor
      for (const e of p.entries) seen.add(e.id)
    }
    expect(seen.size).toBe(12)
  })
})
