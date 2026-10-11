import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagGroup } from '../model/types'

// GM/IO 边界 mock (同 _pipeline.test.ts 手法): GM 桩内存 kv; toast/settings/gm 跨 tab 同步全隔
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))

const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string) => Promise.resolve(gmKv.get(key))),
  setValue: vi.fn((key: string, val: unknown) => void gmKv.set(key, val)),
})

// store 顶层 await proxyWithGmStorage + setTimeout 挂载 subscribe/一次性迁移 => 假定时器消化干净再跑断言
vi.useFakeTimers()
const { favorites, favoritesL1, favoritesStore, favoritesL1Store, themes, themesStore, migrateFavoritesToL1 } =
  await import('./index')
vi.runAllTimers() // subscribe 挂载 + migrateFavoritesToL1 首跑 (空表 no-op, 置 migrated)
vi.useRealTimers()

const g = (id: string, ids: number[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: `组${id}`,
  tag_ids: ids.map((id) => ({ id, name: `tag${id}` })),
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})

describe('$modules/tag-rec/store favorites-l1 (票 17)', () => {
  beforeEach(() => {
    favoritesStore.list = []
    favoritesL1Store.list = []
    favoritesL1Store.migrated = false
  })

  it('.migrateFavoritesToL1: 旧组各套自动 L1 (同名/默认不启用/weight 继承旧组)', () => {
    favoritesStore.list.push(g('a', [1], { weight: 3 }), g('b', [2]))
    migrateFavoritesToL1()
    expect(favoritesL1Store.migrated).toBe(true)
    expect(favoritesL1Store.list).toHaveLength(2)
    const [g1, g2] = favoritesStore.list
    expect(g1.l1Id).toBeTruthy()
    expect(g2.l1Id).toBeTruthy()
    expect(g1.l1Id).not.toBe(g2.l1Id) // 各套一个, 不共享
    expect(favoritesL1Store.list.find((l) => l.id === g1.l1Id)).toMatchObject({
      name: g1.name,
      enabled: false,
      weight: 3,
    })
    expect(favoritesL1Store.list.find((l) => l.id === g2.l1Id)).toMatchObject({
      name: g2.name,
      enabled: false,
      weight: 1,
    })
  })

  it('.migrateFavoritesToL1 幂等: migrated flag 置位即短路, 重跑不重复建', () => {
    favoritesStore.list.push(g('a', [1]))
    migrateFavoritesToL1()
    const l1Ids = favoritesL1Store.list.map((l) => l.id)
    migrateFavoritesToL1() // flag 已置 => no-op
    expect(favoritesL1Store.list.map((l) => l.id)).toEqual(l1Ids)
    // flag 置位时新裸奔组也不补 (不走本迁路径; 裸奔由 addGroup/addGroups 门面收口)
    favoritesStore.list.push(g('x', [9]))
    migrateFavoritesToL1()
    expect(favoritesL1Store.list.map((l) => l.id)).toEqual(l1Ids)
    // flag 复位后再跑 => 只补漏网组 (x), 已归属的 a 不重复套
    favoritesL1Store.migrated = false
    migrateFavoritesToL1()
    expect(favoritesL1Store.list).toHaveLength(2)
    expect(favoritesStore.list.find((x) => x.id === 'a')!.l1Id).toBe(l1Ids[0])
    expect(favoritesStore.list.find((x) => x.id === 'x')!.l1Id).toBe(favoritesL1Store.list[1].id)
  })

  it('.addGroup 缺省 l1Id => 自动套同名新 L1 (默认不启用, weight 继承组), 返回 {group,l1}', () => {
    const res = favorites.addGroup({ name: '音乐', tag_ids: [{ id: 1, name: 't1' }], weight: 4 })
    expect(res).toBeTruthy()
    const { group, l1 } = res!
    expect(group.l1Id).toBe(l1.id)
    expect(l1).toMatchObject({ name: '音乐', enabled: false, weight: 4 })
    expect(favoritesL1Store.list).toHaveLength(1)
    expect(favoritesL1Store.list[0].id).toBe(l1.id)
  })

  it('.addGroup 指定合法 l1Id => 直接归属不新建; 失效 l1Id => 回落自动套', () => {
    const host = favoritesL1.addL1({ name: '既有L1', enabled: true, weight: 2 })!
    const res = favorites.addGroup({ name: 'G', l1Id: host.id, tag_ids: [{ id: 1, name: 't1' }] })!
    expect(res.group.l1Id).toBe(host.id)
    expect(res.l1.id).toBe(host.id)
    expect(favoritesL1Store.list).toHaveLength(1)
    const res2 = favorites.addGroup({ name: 'G2', l1Id: 'ghost', tag_ids: [{ id: 2, name: 't2' }] })!
    expect(res2.group.l1Id).toBe(res2.l1.id)
    expect(res2.l1.id).not.toBe(host.id)
    expect(favoritesL1Store.list).toHaveLength(2)
  })

  it('.addGroups 批量入表: 携合法 l1Id 保留归属, 缺省逐组 auto-wrap', () => {
    const host = favoritesL1.addL1({ name: 'H' })!
    const n = favorites.addGroups([g('a', [1], { l1Id: host.id }), g('b', [2])])
    expect(n).toBe(2)
    expect(favoritesStore.list).toHaveLength(2)
    expect(favoritesStore.list[0].l1Id).toBe(host.id) // 已归属 => 保留不新建
    expect(favoritesStore.list[1].l1Id).toBeTruthy()
    expect(favoritesL1Store.list).toHaveLength(2) // host + b 的自动 L1
  })

  it('.assignGroupToL1: 指认既有 L1 / undefined 自动套新 L1 / 失效目标拒', () => {
    const res = favorites.addGroup({ name: 'G', tag_ids: [{ id: 1, name: 't1' }] })!
    const target = favoritesL1.addL1({ name: 'T', enabled: true })!
    // 指认既有
    expect(favoritesL1.assignGroupToL1(res.group.id, target.id)?.id).toBe(target.id)
    expect(favoritesStore.list[0].l1Id).toBe(target.id)
    // undefined => 自动套同名新 L1
    const rewrap = favoritesL1.assignGroupToL1(res.group.id)
    expect(rewrap).toBeTruthy()
    expect(rewrap!.id).not.toBe(target.id)
    expect(rewrap!.name).toBe('G')
    expect(rewrap!.enabled).toBe(false)
    expect(favoritesStore.list[0].l1Id).toBe(rewrap!.id)
    // 失效目标 => 拒, 归属不变
    expect(favoritesL1.assignGroupToL1(res.group.id, 'ghost')).toBeUndefined()
    expect(favoritesStore.list[0].l1Id).toBe(rewrap!.id)
    // 组不存在 => undefined
    expect(favoritesL1.assignGroupToL1('ghost', target.id)).toBeUndefined()
  })

  it('.removeL1 非空阻塞: 麾下还有 L2 拒删; 清空后可删', () => {
    const res = favorites.addGroup({ name: 'G', tag_ids: [{ id: 1, name: 't1' }] })!
    expect(favoritesL1.removeL1(res.l1.id)).toBe(false) // 非空阻塞
    expect(favoritesL1Store.list).toHaveLength(1)
    expect(favorites.removeGroup(res.group.id)).toBe(true) // 组删后 L1 空置
    expect(favoritesL1.removeL1(res.l1.id)).toBe(true)
    expect(favoritesL1Store.list).toHaveLength(0)
    expect(favoritesL1.removeL1('ghost')).toBe(false)
  })

  it('.mergeL1IntoL1 (票 29): 源麾下 L2 全归目标 + 源壳删; 空源仅删壳; 自身/失效端拒', () => {
    const src = favoritesL1.addL1({ name: 'S' })!
    const dst = favoritesL1.addL1({ name: 'D' })!
    const g1 = favorites.addGroup({ name: 'G1', l1Id: src.id, tag_ids: [{ id: 1, name: 't1' }] })!.group
    const g2 = favorites.addGroup({ name: 'G2', l1Id: src.id, tag_ids: [{ id: 2, name: 't2' }] })!.group
    const g3 = favorites.addGroup({ name: 'G3', l1Id: dst.id, tag_ids: [{ id: 3, name: 't3' }] })!.group
    expect(favoritesL1Store.list).toHaveLength(2)
    // 并入: 源麾下 2 组改指 dst, 源壳删, dst 原有组不动
    expect(favoritesL1.mergeL1IntoL1(src.id, dst.id)).toBe(2)
    expect(favoritesStore.list.find((g) => g.id === g1.id)!.l1Id).toBe(dst.id)
    expect(favoritesStore.list.find((g) => g.id === g2.id)!.l1Id).toBe(dst.id)
    expect(favoritesStore.list.find((g) => g.id === g3.id)!.l1Id).toBe(dst.id)
    expect(favoritesL1Store.list.map((l) => l.id)).toEqual([dst.id])
    // 空源并入 = 仅删壳, 返回 0
    const empty = favoritesL1.addL1({ name: 'E' })!
    expect(favoritesL1.mergeL1IntoL1(empty.id, dst.id)).toBe(0)
    expect(favoritesL1Store.list).toHaveLength(1)
    // 自身 / 失效端 => 拒, 两侧不动
    expect(favoritesL1.mergeL1IntoL1(dst.id, dst.id)).toBeUndefined()
    expect(favoritesL1.mergeL1IntoL1('ghost', dst.id)).toBeUndefined()
    expect(favoritesL1.mergeL1IntoL1(dst.id, 'ghost')).toBeUndefined()
    expect(favoritesL1Store.list).toHaveLength(1)
    expect(favoritesStore.list).toHaveLength(3)
  })

  it('.moveGroupsToL1 (票 31): 批量改挂既有 L1 + 源空壳删; 缺省目标 => 首组 auto-wrap; 失效目标/空集拒', () => {
    const srcA = favoritesL1.addL1({ name: 'SA' })!
    const srcB = favoritesL1.addL1({ name: 'SB' })!
    const dst = favoritesL1.addL1({ name: 'D' })!
    const g1 = favorites.addGroup({ name: 'G1', l1Id: srcA.id, tag_ids: [{ id: 1, name: 't1' }] })!.group
    const g2 = favorites.addGroup({ name: 'G2', l1Id: srcA.id, tag_ids: [{ id: 2, name: 't2' }] })!.group
    const g3 = favorites.addGroup({ name: 'G3', l1Id: srcB.id, tag_ids: [{ id: 3, name: 't3' }] })!.group
    favorites.addGroup({ name: 'K', l1Id: dst.id, tag_ids: [{ id: 4, name: 't4' }] })
    const l1Of = (gid: string) => favoritesStore.list.find((x) => x.id === gid)!.l1Id
    // 部分改挂: srcA 余 g2 不删, srcB 空壳删 (汇总删壳名)
    const res = favoritesL1.moveGroupsToL1([g1.id, g3.id], dst.id)!
    expect(res.moved).toBe(2)
    expect(res.l1.id).toBe(dst.id)
    expect(res.removedShells).toEqual(['SB'])
    expect(l1Of(g1.id)).toBe(dst.id)
    expect(l1Of(g3.id)).toBe(dst.id)
    expect(favoritesL1Store.list.map((l) => l.id).sort()).toEqual([srcA.id, dst.id].sort())
    // g2 也移走 => srcA 变空壳同样被清
    const res2 = favoritesL1.moveGroupsToL1([g2.id], dst.id)!
    expect(res2.removedShells).toEqual(['SA'])
    expect(favoritesL1Store.list.map((l) => l.id)).toEqual([dst.id])
    // 缺省目标 => 首组 auto-wrap 套同名新 L1 (默认停用), 余组同挂; dst 尚有 g3/K 不删
    const res3 = favoritesL1.moveGroupsToL1([g1.id, g2.id])!
    expect(res3.l1).toMatchObject({ name: 'G1', enabled: false })
    expect(l1Of(g1.id)).toBe(res3.l1.id)
    expect(l1Of(g2.id)).toBe(res3.l1.id)
    expect(res3.removedShells).toEqual([])
    expect(favoritesL1Store.list).toHaveLength(2)
    // 失效目标 => 拒, 归属不动; 空集/全失效 ids => undefined
    expect(favoritesL1.moveGroupsToL1([g3.id], 'ghost')).toBeUndefined()
    expect(l1Of(g3.id)).toBe(dst.id)
    expect(favoritesL1.moveGroupsToL1([], dst.id)).toBeUndefined()
    expect(favoritesL1.moveGroupsToL1(['ghost'], dst.id)).toBeUndefined()
  })

  it('.addL1 / .updateL1: 空名拒建拒改; 行内编辑 name/weight/enabled/note', () => {
    expect(favoritesL1.addL1({ name: '  ' })).toBeUndefined()
    const l1 = favoritesL1.addL1({ name: 'A' })!
    expect(l1.enabled).toBe(false) // 默认不启用 (spec)
    expect(favoritesL1.updateL1(l1.id, { name: 'A2', weight: 3, enabled: true, note: 'n' })).toBe(true)
    expect(favoritesL1Store.list[0]).toMatchObject({ name: 'A2', weight: 3, enabled: true, note: 'n' })
    expect(favoritesL1.updateL1(l1.id, { name: ' ' })).toBe(false) // 空名拒改
    expect(favoritesL1Store.list[0].name).toBe('A2')
    expect(favoritesL1.updateL1('ghost', { name: 'x' })).toBe(false)
  })
})

describe('$modules/tag-rec/store 批量删除与清空 (票 44)', () => {
  beforeEach(() => {
    favoritesStore.list = []
    favoritesL1Store.list = []
    favoritesL1Store.migrated = false
    themesStore.list = []
  })

  it('.favorites.removeGroups: 一遍删多组返回实删数; 失效 id 静默跳过; 空集=0', () => {
    const a = favorites.addGroup({ name: 'A', tag_ids: [{ id: 1, name: 't1' }] })!.group
    const b = favorites.addGroup({ name: 'B', tag_ids: [{ id: 2, name: 't2' }] })!.group
    favorites.addGroup({ name: 'C', tag_ids: [{ id: 3, name: 't3' }] })
    expect(favorites.removeGroups([a.id, b.id, 'ghost'])).toBe(2)
    expect(favoritesStore.list.map((g) => g.name)).toEqual(['C'])
    expect(favorites.removeGroups([])).toBe(0)
    expect(favorites.removeGroups([a.id])).toBe(0) // 已删再删 = 0 (幂等)
    expect(favoritesStore.list).toHaveLength(1)
    // A/B 被删后其自动套 L1 成空壳但仍在 (不级联 —— 壳由 L1 删除路径管): 3 addGroup 各套 1 个 L1
    expect(favoritesL1Store.list).toHaveLength(3)
  })

  it('.clearAll 双门面: L2/L1 各清各返回各自数; 主题名册不动', () => {
    favorites.addGroup({ name: 'A', tag_ids: [{ id: 1, name: 't1' }] })
    favorites.addGroup({ name: 'B', tag_ids: [{ id: 2, name: 't2' }] })
    favoritesL1.addL1({ name: '手动L1' })
    themes.addTheme({ name: 'T' })
    expect(favorites.clearAll()).toBe(2)
    expect(favoritesL1.clearAll()).toBe(3) // 2 组各自动套 1 个同名 L1 + 手动建的 1 个
    expect(favoritesStore.list).toHaveLength(0)
    expect(favoritesL1Store.list).toHaveLength(0)
    expect(themesStore.list).toHaveLength(1) // 主题是无依附独立实体, 清表不连坐
    // 幂等: 再清 = 0
    expect(favorites.clearAll()).toBe(0)
    expect(favoritesL1.clearAll()).toBe(0)
  })

  it('.favoritesL1.removeL1Tree: 级联删 —— 麾下 L2 一并清; 他组不动; 失效 id 拒', () => {
    const a = favorites.addGroup({ name: 'A', tag_ids: [{ id: 1, name: 't1' }] })!
    const b = favorites.addGroup({ name: 'B', tag_ids: [{ id: 2, name: 't2' }] })!
    favorites.addGroup({ name: 'C', l1Id: a.l1.id, tag_ids: [{ id: 3, name: 't3' }] })
    // a.l1 麾下 A+C 两组; b.l1 麾下 B
    expect(favoritesL1.removeL1Tree(a.l1.id)).toBe(true)
    expect(favoritesL1Store.list.map((l) => l.id)).toEqual([b.l1.id])
    expect(favoritesStore.list.map((g) => g.name)).toEqual(['B']) // 麾下 A/C 随壳清, B 组不动
    expect(favoritesL1.removeL1Tree('ghost')).toBe(false)
  })
})
