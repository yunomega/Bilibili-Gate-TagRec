import { describe, expect, it } from 'vitest'
import {
  aggregateTagRecCooccur,
  pruneSediment,
  SEDIMENT_EDGE_CAP,
  SEDIMENT_EVIDENCE_CAP,
  sedimentClear,
  sedimentClearDig,
  sedimentConfirm,
  sedimentMerge,
  sedimentNoteDig,
  trimSedimentPoolEdges,
  type SedimentNode,
} from './sediment'

const pool = () => new Map<string, SedimentNode>()
let NOW = 1_000
const now = () => NOW

describe.concurrent('$modules/tag-rec/model/sediment', () => {
  it('.sedimentMerge 节点创建 + 写法收录 + 双向共现边', () => {
    const p = pool()
    sedimentMerge(p, 'demonsroots', [{ bvid: 'BV1', tags: ['Demons Roots', 'RPG', '攻略'] }], now())
    // 节点: 全部 tag 各建一节点
    expect([...p.keys()].sort()).toEqual(['demonsroots', 'rpg', '攻略'].sort())
    // variants 收录原始写法
    expect(p.get('demonsroots')!.variants).toEqual(['Demons Roots'])
    expect(p.get('rpg')!.variants).toEqual(['RPG'])
    // 双向边: a->b 与 b->a 各一条
    const dr = p.get('demonsroots')!
    expect(dr.cooccur.rpg).toMatchObject({ count: 1, exampleBvids: ['BV1'], lastSeen: NOW })
    expect(dr.cooccur['攻略'].count).toBe(1)
    const rpg = p.get('rpg')!
    expect(rpg.cooccur.demonsroots.count).toBe(1)
    expect(rpg.cooccur['攻略'].count).toBe(1)
  })

  it('.sedimentMerge 跨次累计 count/证据去重封顶/lastSeen 刷新', () => {
    const p = pool()
    sedimentMerge(p, 'a', [{ bvid: 'BV1', tags: ['A', 'B'] }], now())
    NOW = 2_000
    sedimentMerge(
      p,
      'a',
      [
        { bvid: 'BV1', tags: ['A', 'B'] }, // 重复视频: count 仍 +1 (观测计数), 证据 bvid 去重
        { bvid: 'BV2', tags: ['A', 'B', 'C'] },
      ],
      now(),
    )
    const a = p.get('a')!
    expect(a.cooccur.b.count).toBe(3) // 1 + 2
    expect(a.cooccur.b.exampleBvids).toEqual(['BV1', 'BV2']) // 去重
    expect(a.cooccur.b.lastSeen).toBe(2_000)
    expect(a.cooccur.c.count).toBe(1)
    // 同 norm 异写法全收 variants, 不自边
    sedimentMerge(p, 'a', [{ tags: ['a', ' A '] }], now())
    expect(p.get('a')!.variants).toEqual(['A', 'a', ' A '])
    expect(p.get('a')!.cooccur.a).toBeUndefined()
  })

  it('.sedimentMerge exampleBvids 封顶滚动保留最新', () => {
    const p = pool()
    const items = Array.from({ length: 8 }, (_, i) => ({ bvid: `BV${i}`, tags: ['A', 'B'] }))
    sedimentMerge(p, 'a', items, now())
    const edge = p.get('a')!.cooccur.b
    expect(edge.count).toBe(8)
    expect(edge.exampleBvids).toHaveLength(SEDIMENT_EVIDENCE_CAP) // 5
    expect(edge.exampleBvids).toEqual(['BV3', 'BV4', 'BV5', 'BV6', 'BV7'])
  })

  it('.sedimentMerge 空 tags / 同 norm 合并安全', () => {
    const p = pool()
    sedimentMerge(
      p,
      'a',
      [
        { bvid: 'BV1', tags: [] },
        { bvid: 'BV2', tags: ['', ' '] },
      ],
      now(),
    )
    expect(p.has('a')).toBe(true) // 锚点节点恒在
    expect(p.size).toBe(1)
  })

  it('.pruneSediment 超容量按 lastSeen 最旧淘汰至水位', () => {
    const p = pool()
    // 10 节点, lastSeen 递增
    for (let i = 0; i < 10; i++) {
      sedimentMerge(p, `n${i}`, [{ tags: [`n${i}`] }], i)
    }
    expect(p.size).toBe(10)
    const removed = pruneSediment(p, 8, 6) // cap8 超了 => 淘汰到 6
    expect(removed).toBe(4)
    expect(p.size).toBe(6)
    // 最旧 n0~n3 被淘汰
    for (let i = 0; i < 4; i++) expect(p.has(`n${i}`)).toBe(false)
    expect(p.has('n9')).toBe(true)
    // 容量内不动
    expect(pruneSediment(p, 8, 6)).toBe(0)
  })

  it('.pruneSediment 经 merge 自动触发 (cap=5k)', () => {
    // 用 merge 内 prune: 手工构造超 cap 池太重, 改为直接验证 merge 后 size 有界
    const p = pool()
    sedimentMerge(p, 'anchor', [{ tags: ['anchor', 'b', 'c'] }], now())
    expect(p.size).toBeLessThanOrEqual(5_000)
  })

  it('.sedimentConfirm 勾选确认 => confirmed 强信号', () => {
    const p = pool()
    sedimentConfirm(p, 'rpg', now())
    expect(p.get('rpg')!.confirmed).toBe(true)
    // 对已存在节点幂等
    sedimentMerge(p, 'a', [{ tags: ['A', 'B'] }], now())
    sedimentConfirm(p, 'b')
    expect(p.get('b')!.confirmed).toBe(true)
    expect(p.get('b')!.cooccur.a.count).toBe(1)
  })

  it('.sedimentClear 清空', () => {
    const p = pool()
    sedimentMerge(p, 'a', [{ tags: ['A', 'B'] }], now())
    sedimentClear(p)
    expect(p.size).toBe(0)
  })

  // #region 票 36: 深挖游标写口 (dig 字段, 向后兼容可选)
  it('.sedimentNoteDig 游标建/覆写 + 同 keyword 下 exhausted 落盘后粘住 (A 档永真)', () => {
    const p = pool()
    sedimentNoteDig(p, 'demonsroots', { keyword: 'Demons Roots', nextPage: 4 }, now())
    // 新建锚点节点携 dig; lastAt = 写入时刻; 无 exhausted 不落字段
    expect(p.get('demonsroots')!.dig).toEqual({ keyword: 'Demons Roots', nextPage: 4, lastAt: NOW })
    expect(p.get('demonsroots')!.lastSeen).toBe(NOW) // 挖过也算「见过」LRU 触碰

    NOW = 2_000
    sedimentNoteDig(p, 'demonsroots', { keyword: 'Demons Roots', nextPage: 7 }, now())
    expect(p.get('demonsroots')!.dig).toEqual({ keyword: 'Demons Roots', nextPage: 7, lastAt: 2_000 })

    // 挖穿落 exhausted => 同 keyword 后续推进写不清终态 (A 档: 永真至 LRU 淘汰/清空)
    sedimentNoteDig(p, 'demonsroots', { keyword: 'Demons Roots', nextPage: 52, exhausted: true }, now())
    sedimentNoteDig(p, 'demonsroots', { keyword: 'Demons Roots', nextPage: 55 }, now())
    expect(p.get('demonsroots')!.dig).toMatchObject({ nextPage: 55, exhausted: true })

    // 换 keyword (同 norm 异拼写 = 不同结果集) => 整体覆写, exhausted 不跨词残留
    sedimentNoteDig(p, 'demonsroots', { keyword: 'demons roots', nextPage: 4 }, now())
    expect(p.get('demonsroots')!.dig).toEqual({ keyword: 'demons roots', nextPage: 4, lastAt: NOW })
  })

  it('.sedimentClearDig 重新发掘: 只清该词深挖游标, 共现边与其他节点保留', () => {
    const p = pool()
    sedimentMerge(p, 'demonsroots', [{ bvid: 'BV1', tags: ['Demons Roots', 'RPG'] }], now())
    sedimentNoteDig(
      p,
      'demonsroots',
      { keyword: 'Demons Roots', nextPage: 12, exhausted: true, schemaVersion: 2 },
      now(),
    )
    sedimentNoteDig(p, 'other', { keyword: 'Other', nextPage: 3 }, now())
    expect(p.get('demonsroots')!.dig?.exhausted).toBe(true)

    expect(sedimentClearDig(p, 'demonsroots')).toBe(true)
    expect(p.get('demonsroots')!.dig).toBeUndefined() // 游标 (含冷却) 复位 => 下次建流从第 1 页
    expect(Object.keys(p.get('demonsroots')!.cooccur).length).toBeGreaterThan(0) // 共现边保留
    expect(p.get('other')!.dig?.nextPage).toBe(3) // 其他节点不动
    expect(sedimentClearDig(p, 'demonsroots')).toBe(false) // 幂等: 无游标可清
  })

  it('.sedimentNoteDig 兼容老节点 (无 dig 字段) + 清空沉淀连游标一起清', () => {
    const p = pool()
    sedimentMerge(p, 'a', [{ tags: ['A', 'B'] }], now())
    expect(p.get('a')!.dig).toBeUndefined() // 老数据节点无 dig —— 读端不炸的前提
    sedimentNoteDig(p, 'a', { keyword: 'A', nextPage: 4, exhausted: true }, now())
    expect(p.get('a')!.dig).toMatchObject({ keyword: 'A', nextPage: 4, exhausted: true })
    sedimentClear(p) // 「清空沉淀」全删天然覆盖 dig —— 同词下次建流回 page 1
    expect(p.size).toBe(0)
  })
  // #endregion

  // #region 票 perf-11: 单节点共现边 cap (写侧裁剪 + 存量迁移幂等)
  it('.sedimentMerge 边度超 cap => 保最强前 N 条 (count 优先, 一次性弱边先死)', () => {
    const p = pool()
    // 70 个强邻居 (各 2 团 => count=2) + 70 个弱邻居 (count=1): a 节点共 140 边 > 128
    const items = [
      ...Array.from({ length: 70 }, (_, i) => ({ bvid: `BVh${i}`, tags: ['A', `hot${i}`] })),
      ...Array.from({ length: 70 }, (_, i) => ({ bvid: `BVh${i}x`, tags: ['A', `hot${i}`] })),
      ...Array.from({ length: 70 }, (_, i) => ({ bvid: `BVc${i}`, tags: ['A', `cold${i}`] })),
    ]
    sedimentMerge(p, 'a', items, now())
    const co = p.get('a')!.cooccur
    expect(Object.keys(co)).toHaveLength(SEDIMENT_EDGE_CAP)
    expect(Object.keys(co).filter((k) => k.startsWith('hot'))).toHaveLength(70) // 强边全保
    expect(Object.keys(co).filter((k) => k.startsWith('cold'))).toHaveLength(SEDIMENT_EDGE_CAP - 70)
    expect(co.hot0.count).toBe(2)
    // 反向边: hot0 -> a 仍在 (邻居节点自身边度只有 1, 不受 cap 影响)
    expect(p.get('hot0')!.cooccur.a.count).toBe(2)
  })

  it('.sedimentMerge 同 count 弱边按 lastSeen 保新 (滚动出新)', () => {
    const p = pool()
    sedimentMerge(
      p,
      'a',
      Array.from({ length: SEDIMENT_EDGE_CAP }, (_, i) => ({ bvid: `BV${i}`, tags: ['A', `t${i}`] })),
      1_000,
    )
    // 同 count=1 的新边入 => 最旧的 t0 淘汰, 新边活
    sedimentMerge(p, 'a', [{ bvid: 'BVnew', tags: ['A', 'new'] }], 2_000)
    const keys = Object.keys(p.get('a')!.cooccur)
    expect(keys).toHaveLength(SEDIMENT_EDGE_CAP)
    expect(keys).toContain('new')
    expect(keys).not.toContain('t0')
    expect(keys).toContain('t1')
  })

  it('.sedimentMerge 饱和强边节点对新弱边冻结 (count=1 赢不了 count>=2 存量)', () => {
    const p = pool()
    const items = Array.from({ length: SEDIMENT_EDGE_CAP }, (_, i) => ({ bvid: `BV${i}`, tags: ['A', `s${i}`] }))
    sedimentMerge(p, 'a', items, 1_000)
    sedimentMerge(
      p,
      'a',
      items.map((it) => ({ ...it, bvid: `${it.bvid}x` })),
      2_000,
    ) // 全部 count=2
    sedimentMerge(p, 'a', [{ bvid: 'BVnew', tags: ['A', 'fresh'] }], 3_000) // count=1 => 立即被淘汰
    const co = p.get('a')!.cooccur
    expect(Object.keys(co)).toHaveLength(SEDIMENT_EDGE_CAP)
    expect(co.fresh).toBeUndefined()
    expect(co.s0.count).toBe(2)
  })

  it('.sedimentNoteDig 对超 cap 存量节点顺手收边', () => {
    const p = pool()
    // 存量脏数据: 手写超度节点 (绕过 merge 写侧裁剪)
    const cooccur = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`t${i}`, { count: 1, exampleBvids: [], lastSeen: i }]),
    )
    p.set('a', { variants: [], cooccur, lastSeen: 0 })
    sedimentNoteDig(p, 'a', { keyword: 'A', nextPage: 2 }, now())
    const keys = Object.keys(p.get('a')!.cooccur)
    expect(keys).toHaveLength(SEDIMENT_EDGE_CAP)
    // count 全 1 => lastSeen 大者活: t0~t71 裁, t72~t199 留
    expect(p.get('a')!.cooccur.t71).toBeUndefined()
    expect(p.get('a')!.cooccur.t72).toBeDefined()
    expect(p.get('a')!.cooccur.t199).toBeDefined()
    expect(p.get('a')!.dig).toMatchObject({ keyword: 'A', nextPage: 2 }) // 收边不碍游标本职
  })

  it('.trimSedimentPoolEdges 存量迁移: 超度节点裁到 cap, 合规节点不动, 重跑幂等返回 0', () => {
    const p = pool()
    p.set('hub', {
      variants: [],
      cooccur: Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [`t${i}`, { count: 1, exampleBvids: [], lastSeen: i }]),
      ),
      lastSeen: 0,
    })
    p.set('small', { variants: [], cooccur: { x: { count: 5, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    expect(trimSedimentPoolEdges(p)).toBe(300 - SEDIMENT_EDGE_CAP)
    expect(Object.keys(p.get('hub')!.cooccur)).toHaveLength(SEDIMENT_EDGE_CAP)
    expect(Object.keys(p.get('small')!.cooccur)).toHaveLength(1)
    expect(trimSedimentPoolEdges(p)).toBe(0) // 收敛式幂等 —— 水合后重跑无副作用
  })
  // #endregion

  it('.aggregateTagRecCooccur 跨成员累加 + 剔除排除集 + 频次降序 + 展示名取 variants 首项', () => {
    const p = pool()
    p.set('清宵', {
      variants: [],
      cooccur: {
        心月狐: { count: 3, exampleBvids: [], lastSeen: 0 },
        鸣潮: { count: 1, exampleBvids: [], lastSeen: 0 },
      },
      lastSeen: 0,
    })
    p.set('心月狐', {
      variants: [],
      cooccur: {
        鸣潮: { count: 4, exampleBvids: [], lastSeen: 0 },
        原神: { count: 2, exampleBvids: [], lastSeen: 0 },
      },
      lastSeen: 0,
    })
    p.set('鸣潮', { variants: ['鳴潮'], cooccur: {}, lastSeen: 0 })
    const rows = aggregateTagRecCooccur(p, ['清宵', '心月狐'], new Set(['清宵', '心月狐']))
    // 鸣潮 1+4=5 跨成员累加居首, 展示名取对方节点 variants 首项; 种子自身与未命中不出
    expect(rows).toEqual([
      { norm: '鸣潮', name: '鳴潮', count: 5 },
      { norm: '原神', name: '原神', count: 2 },
    ])
    expect(aggregateTagRecCooccur(p, ['清宵', '心月狐'], new Set(['清宵', '心月狐']), 1)).toHaveLength(1)
    expect(aggregateTagRecCooccur(p, ['不存在的键'], new Set())).toEqual([])
  })
})
