import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unitsFingerprint } from '../service/deck'
import type { TagGroup, TagL1Group } from '../model/types'

// GM/IO 边界 mock (同 favorites-l1.test.ts 手法): GM 桩内存 kv; toast/settings/跨 tab 同步全隔
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))

const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string) => Promise.resolve(gmKv.get(key))),
  setValue: vi.fn((key: string, val: unknown) => void gmKv.set(key, val)),
})

// store 顶层 await proxyWithGmStorage + setTimeout 挂载 subscribe/迁移 => 假定时器消化干净再跑
vi.useFakeTimers()
const { favoritesL1Store, favoritesStore, themes, themesStore, viewScope } = await import('./index')
vi.runAllTimers()
vi.useRealTimers()

const l1 = (id: string, extra: Partial<TagL1Group> = {}): TagL1Group => ({
  id,
  name: `L1-${id}`,
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})
const g = (id: string, ids: number[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: `组${id}`,
  l1Id: 'A',
  tag_ids: ids.map((id) => ({ id, name: `tag${id}` })),
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})

describe('$modules/tag-rec/store themes 门面 (票 26/票 43)', () => {
  beforeEach(() => {
    themesStore.list = []
    favoritesL1Store.list = []
    favoritesStore.list = []
    viewScope.selectAll()
  })

  it('.addTheme/.updateTheme 空名拒建拒改; 改名走 trim', () => {
    expect(themes.addTheme({ name: '  ' })).toBeUndefined()
    const t = themes.addTheme({ name: ' 动画 ' })!
    expect(t.name).toBe('动画')
    expect(themes.updateTheme(t.id, { name: '  ' })).toBe(false)
    expect(themes.updateTheme(t.id, { name: ' 番剧 ' })).toBe(true)
    expect(themesStore.list[0].name).toBe('番剧')
    expect(themes.updateTheme('no-such', { name: 'x' })).toBe(false)
  })

  it('.assignL1ToTheme 指认/清回/无效主题拒', () => {
    favoritesL1Store.list.push(l1('A'))
    const t = themes.addTheme({ name: 'T1' })!
    expect(themes.assignL1ToTheme('A', t.id)).toBe(true)
    expect(favoritesL1Store.list[0].themeId).toBe(t.id)
    expect(themes.assignL1ToTheme('A', 'no-such')).toBe(false) // 失效主题 id 拒
    expect(favoritesL1Store.list[0].themeId).toBe(t.id) // 拒后原归属不动
    expect(themes.assignL1ToTheme('A', undefined)).toBe(true) // 清回未归属
    expect(favoritesL1Store.list[0].themeId).toBeUndefined()
  })

  it('.removeTheme 麾下 L1 落回未归属 (组/启用不动); 查看范围桶并入未归属 (视图保续)', () => {
    favoritesL1Store.list.push(l1('A'), l1('B'))
    favoritesStore.list.push(g('a', [1]))
    const t = themes.addTheme({ name: 'T1' })!
    themes.assignL1ToTheme('A', t.id)
    themes.assignL1ToTheme('B', t.id)
    themes.setActive(t.id) // 只看该主题
    expect(viewScope.legacyActiveThemeId()).toBe(t.id)

    expect(themes.removeTheme(t.id)).toBe(true)
    expect(themesStore.list).toHaveLength(0)
    // 麾下 L1 themeId 清回 undefined, 组本身/启用/权重不动
    expect(favoritesL1Store.list.every((l) => l.themeId === undefined)).toBe(true)
    expect(favoritesL1Store.list.map((l) => l.enabled)).toEqual([true, true])
    expect(favoritesStore.list).toHaveLength(1)
    // 删的恰是当前主题 => 桶并入「未归属」=> A/B 仍在查看范围 (视图保续), legacy 单主题字段回落 null
    expect(viewScope.isViewed({ id: 'A' })).toBe(true)
    expect(viewScope.isViewed({ id: 'B' })).toBe(true)
    expect(viewScope.legacyActiveThemeId()).toBeNull()
  })

  it('.removeTheme 非当前主题 => 查看范围不动 (target 桶不受影响)', () => {
    const t1 = themes.addTheme({ name: 'T1' })!
    const t2 = themes.addTheme({ name: 'T2' })!
    themes.setActive(t1.id)
    themes.removeTheme(t2.id)
    expect(viewScope.legacyActiveThemeId()).toBe(t1.id)
  })

  it('票 43 指纹-脏语义: 归属/建+指/删主题 => 指纹变; 纯改名/空主题删除 => 不变', () => {
    favoritesL1Store.list.push(l1('A'), l1('B'))
    // A1-2 收窄指纹后, B 需有可抽 L2 才实际入堆 —— 空 L1 的归属/字段变不再脏 (不影响抽取结果)
    favoritesStore.list.push(g('a', [1]), g('b', [2], { l1Id: 'B' }))
    const t = themes.addTheme({ name: 'T1' })!
    themes.setActive(t.id)

    const fp0 = () => unitsFingerprint(favoritesStore.list, favoritesL1Store.list, viewScope.viewedL1Ids())
    const base = fp0()

    // 指认归属 => 脏
    themes.assignL1ToTheme('A', t.id)
    expect(fp0()).not.toBe(base)
    const afterAssign = fp0()

    // 改名 => 不脏 (显示名不入指纹, feed 资格不变, 关 modal 不刷 —— 有意语义)
    themes.updateTheme(t.id, { name: '改名' })
    expect(fp0()).toBe(afterAssign)

    // 多次连续编辑 => 仍只一份脏 (diff 语义天然合并, 关 modal 刷一次)
    themes.assignL1ToTheme('B', t.id)
    themes.updateTheme(t.id, { name: '再改' })
    expect(fp0()).not.toBe(afterAssign)
    const afterMore = fp0()

    // 删当前主题 => 麾下 themeId 清 + 查看范围桶并入未归属 => 视图保续, 抽取集合不变 => 不脏 (R7 语义)
    themes.removeTheme(t.id)
    expect(fp0()).toBe(afterMore)
  })

  it('票 43: 删除空主题且非当前 => 指纹不变 (资格零变更, 不刷 feed)', () => {
    favoritesL1Store.list.push(l1('A'))
    favoritesStore.list.push(g('a', [1]))
    const fp = () => unitsFingerprint(favoritesStore.list, favoritesL1Store.list, viewScope.viewedL1Ids())
    const base = fp()
    const t = themes.addTheme({ name: '空壳' })!
    expect(fp()).toBe(base) // 主题实体本身不入指纹 (它是筛子不是资格项)
    themes.removeTheme(t.id)
    expect(fp()).toBe(base)
  })

  it('.mergeThemesInto 并入 (feat: 复选并入): 源麾下 L1 改挂目标 + 源壳删 + active 指目标', () => {
    favoritesL1Store.list.push(l1('A'), l1('B'), l1('C'))
    const t1 = themes.addTheme({ name: 'T1' })!
    const t2 = themes.addTheme({ name: 'T2' })!
    const t3 = themes.addTheme({ name: 'T3' })!
    themes.assignL1ToTheme('A', t1.id)
    themes.assignL1ToTheme('B', t2.id)
    themes.assignL1ToTheme('C', t3.id)
    themes.setActive(t1.id)

    // T1+T2 并入 T3: A/B 的 themeId => t3, C 不动; 源壳删; active 从被删源改指目标
    expect(themes.mergeThemesInto([t1.id, t2.id], t3.id)).toBe(2)
    expect(themesStore.list.map((t) => t.id)).toEqual([t3.id])
    expect(favoritesL1Store.list.map((l) => l.themeId)).toEqual([t3.id, t3.id, t3.id])
    expect(viewScope.legacyActiveThemeId()).toBe(t3.id)
  })

  it('.mergeThemesInto 目标在源列表内 => 其余并入它; 目标失效 => undefined', () => {
    const t1 = themes.addTheme({ name: 'T1' })!
    const t2 = themes.addTheme({ name: 'T2' })!
    // 并入自己 = 其余并入它
    expect(themes.mergeThemesInto([t1.id, t2.id], t1.id)).toBe(1)
    expect(themesStore.list.map((t) => t.id)).toEqual([t1.id])
    expect(themes.mergeThemesInto([t1.id], 'ghost')).toBeUndefined()
    // 唯一源=目标 => 0 无操作
    expect(themes.mergeThemesInto([t1.id], t1.id)).toBe(0)
  })

  it('.removeThemes 批删 (名册勾选「删除」): 麾下 L1 落回未归属; 含当前主题 => active 复位; 失效 id 跳过', () => {
    favoritesL1Store.list.push(l1('A'), l1('B'), l1('C'))
    const t1 = themes.addTheme({ name: 'T1' })!
    const t2 = themes.addTheme({ name: 'T2' })!
    const t3 = themes.addTheme({ name: 'T3' })!
    themes.assignL1ToTheme('A', t1.id)
    themes.assignL1ToTheme('B', t2.id)
    themes.assignL1ToTheme('C', t3.id)
    themes.setActive(t2.id)

    expect(themes.removeThemes([t1.id, t2.id, 'ghost'])).toBe(2)
    expect(themesStore.list.map((t) => t.id)).toEqual([t3.id])
    expect(favoritesL1Store.list.map((l) => l.themeId)).toEqual([undefined, undefined, t3.id])
    expect(viewScope.legacyActiveThemeId()).toBeNull() // 删的含当前主题 => 桶并入未归属, 单主题档不再成立
    expect(viewScope.isViewed({ id: 'A' })).toBe(true) // 视图保续: A/B 仍看 (C 属幸存主题 t3 且未被看)
    expect(viewScope.isViewed({ id: 'C', themeId: t3.id })).toBe(false)
    expect(favoritesL1Store.list.map((l) => l.enabled)).toEqual([true, true, true]) // 启用不动
  })

  it('.clearAll 「清空收藏表」配套: 名册全清 + L1 themeId 清回 + active 复位, 返回删除数', () => {
    favoritesL1Store.list.push(l1('A'), l1('B'))
    const t = themes.addTheme({ name: 'T1' })!
    themes.assignL1ToTheme('A', t.id)
    themes.setActive(t.id)

    expect(themes.clearAll()).toBe(1)
    expect(themesStore.list).toHaveLength(0)
    expect(favoritesL1Store.list.every((l) => l.themeId === undefined)).toBe(true)
    expect(viewScope.legacyActiveThemeId()).toBeNull()
    expect(themes.clearAll()).toBe(0) // 幂等
  })
})
