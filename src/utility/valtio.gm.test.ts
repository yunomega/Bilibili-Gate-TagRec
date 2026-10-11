import { afterEach, describe, expect, it, vi } from 'vitest'
import { appWarn } from '$common'
import { reciveGmValueUpdatesFromOtherTab } from '$modules/gm'

/**
 * [tag-rec] 卡顿治理回归 (票 30): proxyXxxWithGmStorage 落盘合并器
 * - 突变风暴 => 合并成 ≤3 笔全量写 (修复前 = 每 mutation 一笔, 沉淀池/已看集曾把主线程+IPC 打满)
 * - 远端恒等应用 => 零 mutation 零回写 (跨 tab 回声链收敛)
 * - 首变 leading 立即写: 离散动作 (收藏/保存) 落盘零延迟
 * 持久层审计回归: AUDIT-01 浅合并落盘 / AUDIT-02 水合无回声写 / AUDIT-07 水合窗口竞态
 */

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))

const gmKv = new Map<string, unknown>()
const getValueMock = vi.fn((key: string) => Promise.resolve(gmKv.get(key)))
const setValueMock = vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val)))
vi.stubGlobal('GM', {
  getValue: getValueMock,
  setValue: setValueMock,
})

const {
  proxyMapWithGmStorage,
  proxySetWithGmStorage,
  proxyWithGmStorage,
  proxyMapWithGmStorageLazy,
  proxySetWithGmStorageLazy,
  proxyWithGmStorageLazy,
} = await import('./valtio')

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms)) // subscribe 挂载走 setTimeout

describe('$utility/valtio GM 落盘合并器 (票 30)', () => {
  it('proxyMap 突变风暴 => 落盘合并 (200 次 set ≠ 200 笔写)', async () => {
    const { map } = await proxyMapWithGmStorage<string, number>('test:storm-map')
    await tick()
    setValueMock.mockClear()

    for (let i = 0; i < 200; i++) map.set(`k${i}`, i)

    await vi.waitFor(() => expect(gmKv.get('test:storm-map')).toBeTruthy(), { timeout: 2000 })
    await tick(700) // trailing flush 窗口消化
    expect(setValueMock.mock.calls.filter(([k]) => k === 'test:storm-map').length).toBeLessThanOrEqual(3)
    expect((gmKv.get('test:storm-map') as [string, number][]).length).toBe(200)
  })

  it('proxySet 连击 => 同上合并; 且最终值完整', async () => {
    const { set } = await proxySetWithGmStorage<string>('test:storm-set')
    await tick()
    setValueMock.mockClear()

    for (let i = 0; i < 100; i++) set.add(`bv${i}`)

    await vi.waitFor(() => expect(gmKv.get('test:storm-set')).toBeTruthy(), { timeout: 2000 })
    await tick(700)
    expect(setValueMock.mock.calls.filter(([k]) => k === 'test:storm-set').length).toBeLessThanOrEqual(3)
    expect((gmKv.get('test:storm-set') as string[]).length).toBe(100)
  })

  it('远端恒等应用 => 不产生回写 (回声收敛)', async () => {
    const { map, replaceAllWith } = await proxyMapWithGmStorage<string, number>('test:echo-map')
    await tick()
    map.set('a', 1)
    await vi.waitFor(() => expect(setValueMock.mock.calls.some(([k]) => k === 'test:echo-map')).toBe(true), {
      timeout: 2000,
    })
    await tick(700)
    setValueMock.mockClear()

    replaceAllWith([['a', 1]]) // 恒等 => 无 mutation => 无落盘
    await tick(700)
    expect(setValueMock.mock.calls.filter(([k]) => k === 'test:echo-map').length).toBe(0)

    replaceAllWith([
      ['a', 1],
      ['b', 2],
    ]) // 真实增量 => 回写一笔
    await vi.waitFor(() => expect(setValueMock.mock.calls.some(([k]) => k === 'test:echo-map')).toBe(true), {
      timeout: 2000,
    })
    const saved = new Map(gmKv.get('test:echo-map') as [string, number][])
    expect(saved.get('b')).toBe(2)
  })

  it('proxyObject 首变 leading 立即写 (离散动作零延迟)', async () => {
    const store = await proxyWithGmStorage({ n: 0 }, 'test:leading')
    await tick()
    setValueMock.mockClear()

    store.n = 42
    await vi.waitFor(() => expect(setValueMock.mock.calls.some(([k]) => k === 'test:leading')).toBe(true), {
      timeout: 2000,
    })
    expect((gmKv.get('test:leading') as { n: number }).n).toBe(42)
  })
})

describe('$utility/valtio 持久层审计回归 (AUDIT-01/02/07)', () => {
  // GM 读慢于 setTimeout(subscribe) 挂载 (~0ms) —— 水合回填必落在订阅就位后, 才验得出 persist 门
  const slowGetValue = (ms = 20) =>
    getValueMock.mockImplementation((key: string) => new Promise((r) => setTimeout(() => r(gmKv.get(key)), ms)))

  const onUpdateOf = (key: string) =>
    vi.mocked(reciveGmValueUpdatesFromOtherTab).mock.calls.find((c) => c[0].storageKey === key)?.[0].onUpdate

  afterEach(() => {
    getValueMock.mockImplementation((key: string) => Promise.resolve(gmKv.get(key)))
  })

  it('AUDIT-01: 数组中段删/尾删/清空全量落盘 (浅合并整体替换, 无 toMerged 错位/幽灵)', async () => {
    gmKv.set('test:audit01', {
      list: [
        { id: 'a', w: 1 },
        { id: 'b', w: 2 },
        { id: 'c', w: 3 },
      ],
    })
    const { proxy: p, hydrated } = proxyWithGmStorageLazy({ list: [] as { id: string; w: number }[] }, 'test:audit01')
    await hydrated
    await tick() // subscribe 挂载
    expect(p.list.map((x) => x.id)).toEqual(['a', 'b', 'c'])

    // 中段删: toMerged 逐位合并会产出 [a, c∪b残, c] 同 id 畸形 —— 浅合并须落干净 [a,c]
    p.list.splice(1, 1)
    await vi.waitFor(() => expect((gmKv.get('test:audit01') as any).list.map((x: any) => x.id)).toEqual(['a', 'c']), {
      timeout: 2000,
    })
    expect((gmKv.get('test:audit01') as any).list).toHaveLength(2) // 无尾部残留/重复

    // 尾删: toMerged 保留 target 尾部 => 'c' 幽灵复活; 浅合并须真删
    p.list.splice(-1, 1)
    await vi.waitFor(() => expect((gmKv.get('test:audit01') as any).list.map((x: any) => x.id)).toEqual(['a']), {
      timeout: 2000,
    })

    // 清空: toMerged 下空数组不覆盖旧值 => 永不落盘; 浅合并须落 []
    p.list.push({ id: 'd', w: 4 })
    await vi.waitFor(() => expect((gmKv.get('test:audit01') as any).list.map((x: any) => x.id)).toEqual(['a', 'd']), {
      timeout: 2000,
    })
    p.list = []
    await vi.waitFor(() => expect((gmKv.get('test:audit01') as any).list).toEqual([]), { timeout: 2000 })
  })

  it('AUDIT-01: 嵌套键删除落盘 (themeId 解绑不回魂)', async () => {
    gmKv.set('test:audit01-del', { list: [{ id: 'l1', themeId: 't1' }] })
    const { proxy: p, hydrated } = proxyWithGmStorageLazy(
      { list: [] as { id: string; themeId?: string }[] },
      'test:audit01-del',
    )
    await hydrated
    await tick()
    expect(p.list[0].themeId).toBe('t1')

    delete p.list[0].themeId
    await vi.waitFor(
      () => {
        const saved = (gmKv.get('test:audit01-del') as any).list[0]
        expect('themeId' in saved).toBe(false)
      },
      { timeout: 2000 },
    )
  })

  it('AUDIT-02: subscribe 就位后的水合回填不触发回声写 (object/set/map 三变体)', async () => {
    gmKv.set('test:audit02-obj', { n: 7 })
    gmKv.set('test:audit02-set', ['a', 'b'])
    gmKv.set('test:audit02-map', [['k', 1]])
    slowGetValue()
    setValueMock.mockClear()

    const obj = proxyWithGmStorageLazy({ n: 0 }, 'test:audit02-obj')
    const st = proxySetWithGmStorageLazy<string>('test:audit02-set')
    const mp = proxyMapWithGmStorageLazy<string, number>('test:audit02-map')
    await Promise.all([obj.hydrated, st.hydrated, mp.hydrated])
    expect(obj.proxy.n).toBe(7)
    expect([...st.set].sort()).toEqual(['a', 'b'])
    expect(mp.map.get('k')).toBe(1)

    await tick(700) // 消化 coalescer trailing 窗口 —— 旧同步复位会在此窗口内回声写一笔全量
    expect(setValueMock.mock.calls.filter(([k]) => (k as string).startsWith('test:audit02-'))).toHaveLength(0)
  })

  it('AUDIT-07(b): 回放先于水合落定 => 陈旧水合行丢弃 (set/map)', async () => {
    gmKv.set('test:audit07b-set', ['stale'])
    gmKv.set('test:audit07b-map', [['stale-k', 0]])
    slowGetValue()

    const st = proxySetWithGmStorageLazy<string>('test:audit07b-set')
    const mp = proxyMapWithGmStorageLazy<string, number>('test:audit07b-map')
    // 模拟远端回放在水合 resolve 前已应用 (mock 掉的 recive 只捕获注册参数, 直调 onUpdate)
    onUpdateOf('test:audit07b-set')!(['remote-new'])
    onUpdateOf('test:audit07b-map')!([['remote-k', 9]])
    await Promise.all([st.hydrated, mp.hydrated])

    expect([...st.set]).toEqual(['remote-new']) // 'stale' 不得回盖已应用的回放
    expect([...mp.map.keys()]).toEqual(['remote-k'])
    expect(mp.map.get('remote-k')).toBe(9)
  })

  it('AUDIT-07(c): 水合窗口内本地写不被回填抹掉, 且补落盘 (object/set/map)', async () => {
    gmKv.set('test:audit07c-obj', { list: [{ id: 'r' }], n: 1 })
    gmKv.set('test:audit07c-set', ['remote-a'])
    gmKv.set('test:audit07c-map', [['remote-k', 1]])
    slowGetValue()

    const obj = proxyWithGmStorageLazy({ list: [] as { id: string }[], n: 0 }, 'test:audit07c-obj')
    obj.proxy.n = 5 // 标量脏 => 本地优先
    obj.proxy.list.push({ id: 'l' }) // 数组脏 => 远端铺底 + 本地独有追加
    const st = proxySetWithGmStorageLazy<string>('test:audit07c-set')
    st.set.add('local-b')
    const mp = proxyMapWithGmStorageLazy<string, number>('test:audit07c-map')
    mp.map.set('local-k', 2)
    await Promise.all([obj.hydrated, st.hydrated, mp.hydrated])

    expect(obj.proxy.n).toBe(5)
    expect(obj.proxy.list.map((x) => x.id).sort()).toEqual(['l', 'r'])
    expect([...st.set].sort()).toEqual(['local-b', 'remote-a'])
    expect(mp.map.get('local-k')).toBe(2)
    expect(mp.map.get('remote-k')).toBe(1)

    // 重放进内存的本地写补一笔落盘 => GM 终态含双边
    await vi.waitFor(
      () => expect((gmKv.get('test:audit07c-set') as string[]).sort()).toEqual(['local-b', 'remote-a']),
      { timeout: 2000 },
    )
    await vi.waitFor(
      () => expect((gmKv.get('test:audit07c-obj') as any).list.map((x: any) => x.id).sort()).toEqual(['l', 'r']),
      { timeout: 2000 },
    )
    await vi.waitFor(
      () => expect(new Map(gmKv.get('test:audit07c-map') as [string, number][]).get('local-k')).toBe(2),
      { timeout: 2000 },
    )
  })

  it('AUDIT-23: flush 写失败 => 批重武装+界内自动重试一次, 变更最终落盘', async () => {
    const { map } = await proxyMapWithGmStorage<string, number>('test:audit23')
    await tick()
    setValueMock.mockClear()
    vi.mocked(appWarn).mockClear()
    setValueMock.mockImplementationOnce(() => Promise.reject(new Error('gm-down')))

    map.set('x', 1) // leading 写即拒 => 重武装; ~MIN_INTERVAL 后重试成功
    await vi.waitFor(() => expect(gmKv.get('test:audit23')).toEqual([['x', 1]]), { timeout: 3000 })
    expect(vi.mocked(appWarn)).toHaveBeenCalled()
  })

  it('AUDIT-23: GM 持续故障 => 每轮 flush 至多「首写+一重试」, 不死循环空转', async () => {
    const { map } = await proxyMapWithGmStorage<string, number>('test:audit23-loop')
    await tick()
    setValueMock.mockClear()
    setValueMock.mockImplementation(() => Promise.reject(new Error('gm-down')))
    try {
      map.set('a', 1)
      await tick(1_600) // 首写即拒 + ~500ms 后一次重试再拒 => 停轮等下一 mutation
      const calls = () => setValueMock.mock.calls.filter(([k]) => k === 'test:audit23-loop').length
      expect(calls()).toBe(2)

      map.set('b', 2) // 下一 mutation 带全量快照再发一轮 (仍封顶 2 笔)
      await tick(1_600)
      expect(calls()).toBe(4)
    } finally {
      setValueMock.mockImplementation((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val)))
    }
  })

  it('AUDIT-24: 远端应用作废已 armed 的 pending —— 不把远端态回声写回; 后续本地写照常落盘', async () => {
    const { map } = await proxyMapWithGmStorage<string, number>('test:audit24')
    await tick()
    const reg = vi
      .mocked(reciveGmValueUpdatesFromOtherTab)
      .mock.calls.find((c) => c[0].storageKey === 'test:audit24')![0]

    map.set('a', 1) // leading 立即写
    await vi.waitFor(() => expect(setValueMock.mock.calls.some(([k]) => k === 'test:audit24')).toBe(true), {
      timeout: 2000,
    })
    setValueMock.mockClear()

    map.set('b', 2) // 窗口内第二变 => armed pending, flush 等 ~500ms
    await tick(50)
    // 模拟 gm applyPending: persist 门包住回放 (防回放自身 mutation 再 arm)
    reg.setPersist(false)
    reg.onUpdate([['r', 9]])
    void Promise.resolve().then(() => reg.setPersist(true))
    await tick(800) // 消化 flush 窗口

    // 修复前: 到点把 {r:9} 写回 (纯回声+本地写已丢); 修复后: 零写, 磁盘留 leading 值
    expect(setValueMock.mock.calls.filter(([k]) => k === 'test:audit24')).toHaveLength(0)
    expect(map.get('r')).toBe(9)
    expect(gmKv.get('test:audit24')).toEqual([['a', 1]])

    // 远端接管后的新本地写 = 新基线上的增量 => 正常落盘 (epoch 不误伤)
    map.set('z', 3)
    await vi.waitFor(
      () => {
        const saved = new Map(gmKv.get('test:audit24') as [string, number][])
        expect(saved.get('r')).toBe(9)
        expect(saved.get('z')).toBe(3)
      },
      { timeout: 2000 },
    )
  })
})
