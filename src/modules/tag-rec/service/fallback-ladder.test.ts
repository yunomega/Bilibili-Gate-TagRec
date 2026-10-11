import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import {
  fetchAllV2Search,
  fetchArchiveRelated,
  fetchTagInfoByName,
  fetchVideoTagNames,
  type TagTopItem,
} from '../api/endpoints'
import { tagRecRecallScheduler } from '../api/recall-scheduler'
import { persistVideoTags } from '../api/video-tags-store'
import { addTagRecCondition, newTagRecCombination, tagRecConditionAtom } from '../model/combination'
import { TAG_REC_AUTO_DIG_MAX } from '../model/dig'
import { makeTagGroup } from '../model/favorites'
import {
  createTagRecFactoryFilterCore,
  createTagRecFactoryScoreParams,
  createTagRecScopeResolver,
  runTagRecFilter,
} from '../model/filter-engine'
import { sediment } from '../store'
import { tagRecCustomSession } from '../store/session'
import {
  FALLBACK_LADDER_STRATEGY_AGGRESSIVE,
  FALLBACK_LADDER_STRATEGY_CONSERVATIVE,
  newTagRecLadderState,
  resetTagRecLadderState,
  TagRecFallbackLadder,
  type FallbackLadderHooks,
  type FallbackLadderStrategy,
  type TagRecLadderSharedState,
} from './fallback-ladder'
import type { TagRecItemExtend } from '$define'
import type { AllV2VideoItem } from '../model/normalize-item'
import type { SedimentNode } from '../model/sediment'
import type { TagIdEntry } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// endpoints/video-tags-store/backoff/store 是 IO 边界; 以 mock 隔掉网络与 GM (同 _pipeline.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve()) }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, lastRecoveredAt: 0, recentlyRecovered: vi.fn(() => false) },
  isRiskControlError: (e: unknown) => e instanceof Error && e.name === 'RiskControlError',
}))
vi.mock('../store', async () => {
  // sediment.map = 原生 Map; 票 36: noteDig 走真写口委托 —— 跨实例水合/清空链路可测; merge 仍 vi.fn 隔离
  const { sedimentNoteDig } = await import('../model/sediment')
  const pool = new Map<string, SedimentNode>()
  return {
    sediment: {
      map: pool,
      merge: vi.fn(),
      noteDig: vi.fn((norm: string, dig: { keyword: string; nextPage: number; exhausted?: boolean }) =>
        sedimentNoteDig(pool, norm, dig),
      ),
    },
  }
})

const video = (bvid: string, tag?: string): AllV2VideoItem => ({ bvid, title: bvid, tag })
const entry = (id: number, name: string): TagIdEntry => ({ id, name })

const mk = (
  extraHooks: Partial<FallbackLadderHooks> = {},
  strategy?: FallbackLadderStrategy,
  shared?: TagRecLadderSharedState,
) => {
  const queue: TagRecItemExtend[] = []
  const seenBvids = new Set<string>()
  const candidates: unknown[] = []
  const variants: unknown[] = []
  const ladder = new TagRecFallbackLadder(
    {
      seenBvids,
      applyStages: (items) => items,
      pushQueue: (items) => queue.push(...items),
      queueSize: () => queue.length,
      scoreParams: () => createTagRecFactoryScoreParams(),
      bypassSeen: () => tagRecCustomSession.bypassSeen,
      mergeCandidates: (rows) => candidates.push(...rows),
      mergeVariants: (rows) => variants.push(...rows),
      ...extraHooks,
    },
    strategy,
    shared, // undefined => 构造器缺省 newTagRecLadderState()
  )
  return { ladder, queue, seenBvids, candidates, variants }
}

const heapItem = (bvid: string, score = 0): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: { view: 1e5 },
  source: { via: 'all-v2-related', groupNames: [] },
  score,
})

const inputStream = () => ({
  key: 'demonsroots',
  keyword: 'Demons Roots',
  attribution: ['Demons Roots'],
  withVariants: true,
  anchor: { id: 1, name: 'Demons Roots' },
})

// 串行: 全 suite 共享 endpoints/sediment mock, mockResolvedValueOnce 队列与 mockReset 不可并发
describe('$modules/tag-rec/service/fallback-ladder (票13)', () => {
  it('滚动等补货时提升已经在途的预挖, 继续共享同一批页请求', async () => {
    const { ladder, queue } = mk()
    ladder.addStream({ key: 'a', keyword: 'a', attribution: ['a'] })
    ladder.addStream({ key: 'b', keyword: 'b', attribution: ['b'] })
    const releases: (() => void)[] = []
    let nextBvid = 0
    const request = vi.fn(
      (keyword: string) =>
        new Promise<AllV2VideoItem[]>((resolve) => {
          const bvid = `foreground-${nextBvid++}`
          releases.push(() => resolve([video(bvid, keyword)]))
        }),
    )
    vi.mocked(fetchAllV2Search).mockImplementation((keyword) => tagRecRecallScheduler.run(() => request(keyword)))
    const prefetch = ladder.preDig()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    const supply = ladder.runLadder()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6))
    releases.splice(0).forEach((release) => release())
    await prefetch
    expect((await supply).kind).toBe('items')
    expect(queue).toHaveLength(6)
    expect(fetchAllV2Search).toHaveBeenCalledTimes(6) // 原批次两流各三页, 不重发
  })

  it('filters empty leading pages and returns remaining eligible heap videos without new IO', async () => {
    const core = createTagRecFactoryFilterCore()
    core.dims.likeRate.enabled = false
    core.dims.titleKeywords = { enabled: true, list: ['blocked'] }
    const resolve = createTagRecScopeResolver({ core })
    const { ladder } = mk({ applyStages: (items, ctx) => runTagRecFilter(items, { resolve, ...ctx }).items })
    ladder.heap.push(
      ...Array.from({ length: 20 }, (_, i) => ({ ...heapItem(`bad${i}`), title: 'blocked', stat: { view: 1e6 } })),
      ...Array.from({ length: 20 }, (_, i) => ({ ...heapItem(`good${i}`), stat: { view: 1000 } })),
    )
    const result = await ladder.runLadder()
    expect(result.kind).toBe('items')
    if (result.kind === 'items')
      expect(result.items.map((it) => it.bvid)).toEqual(Array.from({ length: 20 }, (_, i) => `good${i}`).sort())
    expect(ladder.heap).toHaveLength(0)
    expect(fetchAllV2Search).not.toHaveBeenCalled()
  })

  it('checks an entirely rejected bounded heap once and terminates at real bottom', async () => {
    const applyStages = vi.fn((_items: TagRecItemExtend[]) => [])
    const { ladder } = mk({ applyStages })
    ladder.heap.push(...Array.from({ length: 500 }, (_, i) => heapItem(`reject${i}`)))
    expect((await ladder.runLadder()).kind).toBe('hard-bottom')
    expect(ladder.heap).toHaveLength(0)
    expect(applyStages.mock.calls.reduce((n, args) => n + (args[0] as TagRecItemExtend[]).length, 0)).toBe(500)
    expect(fetchAllV2Search).not.toHaveBeenCalled()
  })

  it('delivers the first nonempty result without filling the page or consuming later candidates', () => {
    const core = createTagRecFactoryFilterCore()
    core.dims.likeRate.enabled = false
    core.dims.titleKeywords = { enabled: true, list: ['blocked'] }
    const resolve = createTagRecScopeResolver({ core })
    const { ladder } = mk({ applyStages: (items, ctx) => runTagRecFilter(items, { resolve, ...ctx }).items })
    ladder.heap.push(
      ...Array.from({ length: 20 }, (_, i) => ({
        ...heapItem(`first${i}`),
        title: i === 0 ? 'allowed' : 'blocked',
        stat: { view: 1e6 },
      })),
      heapItem('later', 0),
    )
    expect(ladder.releasePage().map((it) => it.bvid)).toEqual(['first0'])
    expect(ladder.heap.map((it) => it.bvid)).toEqual(['later'])
  })

  it('keeps new-context heap items intact when a stage resets the shared context', () => {
    const shared = newTagRecLadderState()
    const { ladder } = mk(
      {
        applyStages: () => {
          resetTagRecLadderState(shared)
          shared.heap.push(heapItem('new-context'))
          return []
        },
      },
      undefined,
      shared,
    )
    ladder.heap.push(heapItem('old-context'))
    expect(ladder.releasePage()).toEqual([])
    expect(ladder.heap.map((it) => it.bvid)).toEqual(['new-context'])
  })

  it('clique exact and related videos both retain stable group identity', async () => {
    const { ladder, queue } = mk()
    ladder.ensureCliqueStreams([{ id: 'stable', name: 'Display', tag_ids: [entry(1, 'alpha')] }])
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('exact', 'alpha'), video('related', 'other')])
    await ladder.digPass('manual')
    expect(queue[0].source.groupIds).toEqual(['stable'])
    expect(ladder.heap[0].source.groupIds).toEqual(['stable'])
  })

  it('aborts after an automatically dug page changes context without consuming new-context items', async () => {
    const shared = newTagRecLadderState()
    const { ladder } = mk(
      {
        applyStages: (items) => {
          if (!items.length) return []
          resetTagRecLadderState(shared)
          shared.heap.push(heapItem('new-context'))
          return []
        },
      },
      undefined,
      shared,
    )
    ladder.addStream(inputStream())
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('old-related', 'other')])
    expect((await ladder.runLadder()).kind).toBe('aborted')
    expect(ladder.heap.map((it) => it.bvid)).toEqual(['new-context'])
  })
  beforeEach(() => {
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockReset().mockResolvedValue(undefined)
    vi.mocked(fetchTagInfoByName).mockClear()
    vi.mocked(persistVideoTags).mockClear()
    vi.mocked(sediment.merge).mockClear()
    vi.mocked(sediment.noteDig).mockClear()
    sediment.map.clear()
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false
    ;(tagRecBackoff as { lastRecoveredAt: number }).lastRecoveredAt = 0
    vi.mocked(tagRecBackoff.recentlyRecovered).mockReset().mockReturnValue(false)
    tagRecCustomSession.bypassSeen = false
  })

  // #region D4 深挖流 (all/v2)
  it('digPass: exact=>队(过阶段), related=>堆, tag字段落盘, cliques=>sediment, 页游标推进', async () => {
    const { ladder, queue, candidates } = mk()
    ladder.addStream(inputStream())
    vi.mocked(fetchAllV2Search).mockResolvedValue([
      video('BV-exact', 'demonsroots, labyrinths'),
      video('BV-rel', 'labyrinths'),
    ])

    const yieldN = await ladder.digPass('manual')
    expect(yieldN).toBe(2)
    expect(queue.map((x) => x.bvid)).toEqual(['BV-exact'])
    expect(queue[0].source).toMatchObject({
      via: 'all-v2-exact',
      groupNames: ['Demons Roots'],
      queryKeyword: 'Demons Roots',
    })
    expect(queue[0].source.claims).toHaveLength(1)
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['BV-rel'])
    expect(ladder.heap[0].source.via).toBe('all-v2-related')
    expect(ladder.heap[0].source.groupNames).toEqual(['Demons Roots·相关'])
    expect(persistVideoTags).toHaveBeenCalled()
    expect(sediment.merge).toHaveBeenCalledWith('demonsroots', expect.any(Array))
    expect(ladder.streams.get('demonsroots')?.nextPage).toBe(4) // PHASE2_PAGE_BATCH=3
    expect(ladder.pagesFetched).toBe(3)
    // 共现别名进候选清单 (labyrinths 与锚点共现)
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('digPass: 组流不解析变体 (withVariants 缺省), 归因为组名', async () => {
    const { ladder, queue, variants } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['组A'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'a')])
    await ladder.digPass('manual')
    expect(variants).toHaveLength(0)
    expect(fetchTagInfoByName).not.toHaveBeenCalled() // 组流零变体解析请求
    expect(queue.map((x) => x.source.groupNames)).toEqual([['组A']])
  })

  it('D4 自动深挖: 净增 0 早停 + K=3 上限 + 风控门', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })

    // 上轮产 0 => earlyStopped, canAutoDig 关闭
    await ladder.digPass('auto')
    expect(ladder.autoDigs).toBe(1)
    expect(ladder.earlyStopped).toBe(true)
    expect(ladder.canAutoDig()).toBe(false)

    // manual 不计 autoDigs; 产出>0 不解除 earlyStopped 但 manual 不受限
    sediment.map.clear() // 票 36: 上一梯队的 exhausted 游标已落盘 —— 本子场景独立计数以净池起步
    const { ladder: l2 } = mk()
    l2.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    for (let i = 0; i < 3; i++) {
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce([video(`B${i}`)])
      await l2.digPass('auto')
    }
    expect(l2.autoDigs).toBe(3)
    expect(l2.canAutoDig()).toBe(false) // 达 K 上限
    await l2.digPass('manual')
    expect(l2.autoDigs).toBe(3) // manual 不计

    // 风控门
    sediment.map.clear() // 同上: l2 的游标落盘不得带入本子场景
    const { ladder: l3 } = mk()
    l3.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    expect(l3.canAutoDig()).toBe(false)
    await expect(l3.digPass('manual')).resolves.toBeTypeOf('number') // manual 不受风控门
  })

  it('digPass: 流 exhausted = 空页到底, 不再参与后续 dig', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    await ladder.digPass('manual') // 全部空页
    expect(ladder.streams.get('a')?.exhausted).toBe(true)
    expect(ladder.hasDueStreams()).toBe(false)
    const calls = vi.mocked(fetchAllV2Search).mock.calls.length
    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(calls) // 无新请求
  })

  it('digPass: 带帽流高产摘帽续挖, 低产到帽即干 —— 页帽是试探不是天花板', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 't', keyword: 't', attribution: ['T'], pageCap: 2 })
    // 2 页试探批产 ≥5 条交付 => 摘帽; applyStages 透传 => staged=exact 数; 每页不同 bvid 防去重
    let n = 0
    vi.mocked(fetchAllV2Search).mockImplementation(() =>
      Promise.resolve([video(`x${n++}`, 't'), video(`x${n++}`, 't'), video(`x${n++}`, 't')]),
    )
    await ladder.digPass('manual')
    const stream = ladder.streams.get('t')!
    expect(stream.capLifted).toBe(true)
    expect(stream.pageCap).toBeUndefined()
    expect(stream.exhausted).toBe(false) // cap 判死被摘帽复活
    expect(stream.nextPage).toBe(3) // 试探两页已付
    // 摘帽后续挖 —— 越过原帽位照常翻页
    await ladder.digPass('manual')
    expect(stream.nextPage).toBe(6) // PHASE2_PAGE_BATCH=3
    // 低产对照: 到帽即干 (staged 不达摘帽线)
    sediment.map.clear()
    const { ladder: l2 } = mk()
    l2.addStream({ key: 'u', keyword: 'u', attribution: ['U'], pageCap: 2 })
    vi.mocked(fetchAllV2Search).mockImplementation(() => Promise.resolve([video('only', 'u')]))
    await l2.digPass('manual')
    const lean = l2.streams.get('u')!
    expect(lean.capLifted).toBeUndefined()
    expect(lean.exhausted).toBe(true)
    expect(lean.stopReason).toBe('cap')
  })
  // #endregion

  // #region D3 兜底堆分批放行
  it('releasePage: 堆按分排序放行一页 (<=20), 阶段管线过手', () => {
    const staged: string[] = []
    const { ladder } = mk({
      applyStages: (items) => {
        staged.push(...items.map((x) => x.bvid))
        return items.filter((x) => x.bvid !== 'drop')
      },
    })
    const heapItem = (bvid: string, score: number): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: { view: 1e5, like: 9e3, favorite: 9e3, coin: 9e3, danmaku: 900, reply: 900 },
      source: { via: 'archive-related', groupNames: [] },
      score,
    })
    ladder.heap.push(
      heapItem('low', 10),
      heapItem('hi1', 95),
      ...Array.from({ length: 25 }, (_, i) => heapItem(`m${i}`, 50)),
      heapItem('drop', 99),
    )
    const page = ladder.releasePage()
    expect(page.map((x) => x.bvid)).not.toContain('drop') // 被阶段滤掉
    expect(staged.length).toBe(20) // 一页 = 20
    expect(ladder.heap.length).toBe(8) // 28-20
    expect(staged[0]).toBe('drop') // 最高分先放行
    expect(staged[1]).toBe('hi1')
  })
  // #endregion

  // #region D2 related 共现选种
  it('maybeSeedRelated: 池<12 + 词表就绪 => 选种喂 archive/related 入堆 (票10: 滚动重估)', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const poolItem = (bvid: string, stat: TagRecItemExtend['stat']): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat,
      source: { via: 'tag-top', groupNames: ['A'] },
    })
    // 池内 2 条 (均带高分 stat)
    const richStat = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    ladder.poolItems.push(poolItem('seed1', richStat), poolItem('seed2', richStat))
    seenBvids.add('seed1').add('seed2')
    vi.mocked(fetchVideoTagNames).mockImplementation((bvid) =>
      Promise.resolve(bvid === 'seed1' ? ['x1', 'zzz'] : bvid === 'seed3' ? ['x1'] : ['zzz']),
    )
    const related: TagTopItem[] = [{ bvid: 'rel1', stat: { view: 100 } }, { bvid: 'seed1' }]
    vi.mocked(fetchArchiveRelated).mockResolvedValue(related)

    await ladder.maybeSeedRelated()
    // seed1 共现1条命中词表 (score 足够) => 唯一种子; seed2 零共现落选
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(fetchArchiveRelated).toHaveBeenCalledWith('seed1', expect.anything())
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['rel1']) // seed1 自身已在 seenBvids 去重
    expect(ladder.heap[0].source).toEqual({ via: 'archive-related', groupNames: ['A·相关'] })
    // 票10: 执行过不置 relatedSeeded 终态; 已选种子记 seededBvids
    expect(ladder.relatedSeeded).toBe(false)
    expect([...shared.seededBvids]).toEqual(['seed1'])

    // 滚动重估: seed1 已选排除, seed2 重评零共现 => 无新种子, related 不重复抓
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)

    // 票10: 池里新到的货下一轮可当选 (选种不随首 12 条锁死)
    ladder.poolItems.push(poolItem('seed3', richStat))
    seenBvids.add('seed3')
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(2)
    expect(fetchArchiveRelated).toHaveBeenNthCalledWith(2, 'seed3', expect.anything())
    expect(shared.seededBvids.has('seed3')).toBe(true)
  })

  it('maybeSeedRelated: 交集链下只从已证明 match 的条目选种, 单边货落选且不烧补查', async () => {
    // 交集组合: (至冬) ∩ (cos) —— 种子收窄只认「已证明完整命中」的条目
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '至冬' }))
    combo.include.children.push({
      kind: 'group',
      id: 'sub-cos',
      mode: 'any',
      children: [tagRecConditionAtom('tag', { id: 2, name: 'cos' })],
    })
    const group = makeTagGroup({
      id: 'g1',
      name: 'G',
      tag_ids: [entry(1, '至冬'), entry(2, 'cos')],
      combination: combo,
    })!
    const resolver = createTagRecScopeResolver({
      // 交集下相关池缺省收窄 —— related 选种/兜底路由只在显式开回池时有来路
      core: { ...createTagRecFactoryFilterCore(), poolsEnabled: { archiveRelated: true } },
      groupsById: new Map([['g1', group]]),
    })
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({ resolve: () => resolver }, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const richStat = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    const poolItem = (bvid: string, names?: string[]): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: richStat,
      ownTagNames: names,
      source: { via: 'all-v2-exact', groupNames: ['G'], groupIds: ['g1'] },
    })
    // both: 双分支都证 => 可种; oneside: 单边命中 (无收窄也会凭共现度当选); unknown: 待核实
    ladder.poolItems.push(
      poolItem('both', ['至冬', 'cos', 'x1']),
      poolItem('oneside', ['至冬', 'x1']),
      poolItem('unknown'),
    )
    for (const b of ['both', 'oneside', 'unknown']) seenBvids.add(b)
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel1', stat: { view: 100 } }])

    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(fetchArchiveRelated).toHaveBeenCalledWith('both', expect.anything())
    // 未证明候选连名单补查资格都没有 (火力留给搜索)
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
    expect([...shared.seededBvids]).toEqual(['both'])
  })

  it('maybeSeedRelated: relatedSeedingAllowed=false => 整轮跳过 (交集+兜底门闭 = 死库存闸); 放开照常', async () => {
    const shared = newTagRecLadderState()
    const allowed = { current: false }
    const { ladder, seenBvids } = mk({ relatedSeedingAllowed: () => allowed.current }, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const richStat = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    ladder.poolItems.push({
      api: EApiType.TagRec,
      uniqId: 'tag-rec:seed1',
      bvid: 'seed1',
      title: 'seed1',
      pic: '',
      stat: richStat,
      ownTagNames: ['x1', 'zzz'],
      source: { via: 'tag-top', groupNames: ['A'] },
    })
    seenBvids.add('seed1')
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel1', stat: { view: 100 } }])

    // 门闭: 词表/候选都就绪也整轮跳过 —— 不发 archive, 也不烧名单补查
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).not.toHaveBeenCalled()
    expect(fetchVideoTagNames).not.toHaveBeenCalled()

    // 门开: 同状态照常选种
    allowed.current = true
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledWith('seed1', expect.anything())
  })

  it('maybeSeedRelated: 衍生条继承种子命中词与认领组; tagIds 召回证据不下传 (徽标显标签名)', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const richStat = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    const seed: TagRecItemExtend = {
      api: EApiType.TagRec,
      uniqId: 'tag-rec:seed1',
      bvid: 'seed1',
      title: 'seed1',
      pic: '',
      stat: richStat,
      ownTagNames: ['x1', '清霄'],
      source: {
        via: 'all-v2-related',
        groupNames: ['新试验·相关'],
        groupIds: ['__tagrec_working__'],
        queryKeyword: '清霄',
        claims: [
          {
            via: 'all-v2-related',
            groupNames: ['新试验'],
            groupIds: ['__tagrec_working__'],
            queryKeyword: '清霄',
            tagIds: [9],
          },
        ],
      },
    }
    ladder.poolItems.push(seed)
    seenBvids.add('seed1')
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel1', stat: { view: 100 } }])

    await ladder.maybeSeedRelated()
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['rel1'])
    // 命中词下传 => 徽标 matchedTagNames=['清霄'], 不再回落「新试验·相关」占位组名;
    // tagIds 保留为归因证据 —— eval 消费点全走 via==='tag-top' 闸借不到种子命中,
    //   但旧语境判定 (票004 stale 谓词) 要靠它识别「只因被删原子召回」的衍生残留
    expect(ladder.heap[0].source.queryKeyword).toBe('清霄')
    expect(ladder.heap[0].source.claims).toEqual([
      {
        via: 'archive-related',
        groupNames: ['新试验'],
        groupIds: ['__tagrec_working__'],
        queryKeyword: '清霄',
        tagIds: [9],
      },
    ])
  })

  it('maybeSeedRelated: 闸门判累计产出非原料 (票③实修); 词表空不烧请求留待下轮', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    const poolItem = (bvid: string, stat: TagRecItemExtend['stat']): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat,
      source: { via: 'tag-top', groupNames: ['A'] },
    })
    const richStat = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }

    // 票③: 原料池满 12 条但本语境零产出 (重过滤饿死者) => 旧判据会闭闸, 新判据照常选种
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.poolItems.push(
      poolItem('seed1', richStat),
      ...Array.from({ length: 11 }, (_, i) => poolItem(`p${i}`, richStat)),
    )
    seenBvids.add('seed1')
    vi.mocked(fetchVideoTagNames).mockImplementation((bvid) =>
      Promise.resolve(bvid === 'seed1' ? ['x1', 'zzz'] : ['zzz']),
    )
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel1', stat: { view: 100 } }])
    expect(ladder.poolItems).toHaveLength(12)
    expect(shared.producedTotal).toBe(0) // 原料满产出零 = 冷池, 闸门不得闭
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledWith('seed1', expect.anything()) // 选种照常执行
    expect(ladder.relatedSeeded).toBe(false)

    // 其他组累计产出不能全局关闭选种；空原料仍不烧请求。
    const shared2 = newTagRecLadderState()
    shared2.producedTotal = 12
    const { ladder: l2 } = mk({}, undefined, shared2)
    l2.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    await l2.maybeSeedRelated()
    expect(fetchVideoTagNames).toHaveBeenCalledTimes(12) // 仅有上面 12 条扫描的名单请求
    expect(l2.relatedSeeded).toBe(false)

    // 词表空: 不发 tag 名单请求, 且不算已执行 (首轮深挖前 sediment 未就绪)
    const { ladder: l3 } = mk()
    l3.poolItems.push(poolItem('p0', {}))
    l3.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    await l3.maybeSeedRelated()
    expect(l3.relatedSeeded).toBe(false)
    // noteProduce 记账接口存在性冒烟
    l3.noteProduce(3)
  })
  // #endregion

  // #region D1 梯队编排
  it('runLadder: 干轮 => 自动深挖落货放行; K耗尽+流未尽 => 手动待决; 全尽+堆光 => 硬见底', async () => {
    const { ladder, queue } = mk()
    ladder.addStream(inputStream())

    // K=3 次自动深挖: 每次产 1 条 related => 放行, 流未尽
    for (let i = 0; i < 3; i++) {
      queue.length = 0 // 模拟切片消费
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce([video(`B${i}`)]) // 无 tag => related 档入堆
      const r = await ladder.runLadder({})
      expect(r.kind).toBe('items')
    }
    expect(ladder.autoDigs).toBe(3)
    queue.length = 0
    const r2 = await ladder.runLadder({})
    expect(r2.kind).toBe('manual-pending') // K 耗尽但流未尽 => 手动横幅
    expect(ladder.earlyStopped).toBe(false)

    // 手动把流挖尽后 => 硬见底
    vi.mocked(fetchAllV2Search).mockResolvedValue([])
    await ladder.digPass('manual') // 空页 => exhausted
    const r3 = await ladder.runLadder({})
    expect(r3.kind).toBe('hard-bottom')
  })

  it('runLadder: 首干轮自动深挖落 exact => 放行', async () => {
    const { ladder, queue } = mk()
    ladder.addStream(inputStream())
    vi.mocked(fetchAllV2Search).mockResolvedValueOnce([video('BV-e', 'demonsroots')])
    const r1 = await ladder.runLadder({})
    expect(r1.kind).toBe('items')
    expect(queue.map((x) => x.bvid)).toEqual(['BV-e'])
    expect(ladder.autoDigs).toBe(1)
  })

  it('runLadder: 深挖净增0早停 => 同轮判停 (流尽转硬见底)', async () => {
    const { ladder } = mk()
    ladder.addStream(inputStream())
    const r = await ladder.runLadder({})
    // 自动深挖一轮 yield0 => earlyStopped + 空页 exhausted => 硬见底
    expect(r.kind).toBe('hard-bottom')
    expect(ladder.autoDigs).toBe(1)
    expect(ladder.earlyStopped).toBe(true)
  })

  it('R5-P2-18: 全页失败批不锁早停 —— 瞬态失败与「真挖穿零产出」分流', async () => {
    const { ladder } = mk()
    ladder.addStream(inputStream())
    vi.mocked(fetchAllV2Search).mockRejectedValue(new Error('net')) // 整批失败
    const r = await ladder.runLadder({})
    expect(ladder.lastDigError).toBe(true)
    expect(ladder.earlyStopped).toBe(false) // 旧实现此处锁死 => auto 档永拒只剩手动
    expect(r.kind).toBe('manual-pending') // 流未尽 => 手动待决 (非硬见底)

    // 恢复成功后自动深挖仍可继续 (预算未被瞬态批烧掉)
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVok')])
    const r2 = await ladder.runLadder({})
    expect(r2.kind).toBe('items')
    expect(ladder.autoDigs).toBe(2)
  })

  it('runLadder: 队列有货直接放行轮 (在途深挖刚落不重复挖)', async () => {
    const { ladder, queue } = mk()
    ladder.addStream(inputStream())
    queue.push({
      api: EApiType.TagRec,
      uniqId: 'x',
      bvid: 'x',
      title: 'x',
      pic: '',
      stat: {},
      source: { via: 'all-v2-exact', groupNames: [] },
    })
    const r = await ladder.runLadder({})
    expect(r.kind).toBe('items')
    expect(ladder.autoDigs).toBe(0)
    expect(fetchAllV2Search).not.toHaveBeenCalled()
  })

  it('runLadder: prepareStreams 在干轮补组簇流 (D7 饿才挖)', async () => {
    const { ladder, queue } = mk()
    const groups = [{ name: '组A', tag_ids: [entry(1, 'a'), entry(2, 'b')] }]
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx', 'a')])
    const r = await ladder.runLadder({ prepareStreams: () => ladder.ensureCliqueStreams(groups) })
    expect(r.kind).toBe('items')
    expect(ladder.streams.size).toBe(2) // 簇 a/b 各一流
    expect(queue.length).toBe(1)
    expect(queue[0].source.groupNames).toEqual(['组A'])
  })

  it('ensureCliqueStreams: 已存在的 key 合并归属组名, 不重复建流', () => {
    const { ladder } = mk()
    const groups = [{ name: '组A', tag_ids: [entry(1, 'x')] }]
    expect(ladder.ensureCliqueStreams(groups)).toBe(1)
    expect(ladder.ensureCliqueStreams([{ name: '组B', tag_ids: [entry(2, 'x')] }])).toBe(0)
    expect(ladder.streams.get('x')?.attribution).toEqual(['组A', '组B'])
  })
  // #endregion

  // #region 票 17 策略分家: 缺省 = tab1 保守等价
  it('策略缺省 = tab1 保守: triggerYield=1 + fixed K=3 (票 13 行为等价)', async () => {
    const { ladder, queue } = mk()
    expect(ladder.strategy).toEqual(FALLBACK_LADDER_STRATEGY_CONSERVATIVE)
    expect(ladder.strategy.triggerYield).toBe(1) // 语义等价「仅干轮」: 产出<1 才介入
    expect(ladder.strategy.autoDig).toEqual({ mode: 'fixed', max: TAG_REC_AUTO_DIG_MAX })

    // fixed 档与票 13 同路径: 3 发后 canAutoDig 关闸 (adaptive 低产计数不参判, 恒 0)
    ladder.addStream(inputStream())
    for (let i = 0; i < 3; i++) {
      queue.length = 0
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce([video(`K${i}`, 'demonsroots')])
      await ladder.runLadder({})
    }
    expect(ladder.autoDigs).toBe(3)
    expect(ladder.lowYieldStreak).toBe(0)
    expect(ladder.canAutoDig()).toBe(false)
  })
  // #endregion

  // #region 票 17 策略分家: 浅水位预挖 (preDig)
  it('preDig: 顺手一发 = digPass(auto) 一档 —— exact 入队 related 留堆, 不选种不放堆', async () => {
    const { ladder, queue } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    ladder.addStream(inputStream())
    ladder.heap.push(heapItem('stock')) // 兜底堆预置存货 —— 预挖不得提前放行
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV-e', 'demonsroots'), video('BV-r')])

    const y = await ladder.preDig({})
    expect(y).toBe(2)
    expect(ladder.autoDigs).toBe(1) // 预挖消费一发 auto 深挖 (遥测计数)
    expect(queue.map((x) => x.bvid)).toEqual(['BV-e']) // exact 过阶段入队, 下轮直放
    // 兜底堆只增不减: 旧存货 + 新 related 俱在 —— releasePage 没跑
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['stock', 'BV-r'])
    expect(fetchArchiveRelated).not.toHaveBeenCalled() // D2 选种不跑
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
  })

  it('preDig: prepareStreams 补登记组簇流 —— 组模式深挖流借此前移成立', async () => {
    const { ladder } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    const groups = [{ name: '组A', tag_ids: [entry(1, 'a')] }]
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx', 'a')])
    const y = await ladder.preDig({ prepareStreams: () => ladder.ensureCliqueStreams(groups) })
    expect(ladder.streams.size).toBe(1) // 簇 a 一条流 (原 D7 只在干轮补, 预挖同款前移)
    expect(y).toBe(1)
  })

  it('preDig: 门槛与深挖档同构 —— 无流/队列有货/风控/早停 => 不挖', async () => {
    // 无可挖流 => 空转
    const { ladder: l0 } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    expect(await l0.preDig()).toBe(0)
    expect(fetchAllV2Search).not.toHaveBeenCalled()

    // 队列有货 (在途深挖刚落) => 本轮不加挖 (同 runLadder「队列有货直接放行轮」判据)
    const { ladder: l1, queue } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    l1.addStream(inputStream())
    queue.push(heapItem('q1'))
    expect(await l1.preDig()).toBe(0)
    expect(fetchAllV2Search).not.toHaveBeenCalled()

    // 风控退避 => 预挖关闸 (风控门显式覆盖预挖路径)
    const { ladder: l2 } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    l2.addStream(inputStream())
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    expect(await l2.preDig()).toBe(0)
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false

    // 零产出早停 => 预挖关闸
    const { ladder: l3, seenBvids } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    l3.addStream(inputStream())
    seenBvids.add('BV-dup')
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV-dup')]) // 全已见 => 净增0 => 早停
    await l3.digPass('auto')
    expect(l3.earlyStopped).toBe(true)
    const calls = vi.mocked(fetchAllV2Search).mock.calls.length
    expect(await l3.preDig()).toBe(0)
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(calls)
  })
  // #endregion

  // #region 票 17 策略分家: adaptive 自动深挖 (无 K 硬顶 + 三停)
  it('adaptive: 丰产 (>=3) 持续挖无硬上限 —— autoDigs 超 K=3 仍计数遥测', async () => {
    const { ladder, queue } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    ladder.addStream(inputStream())
    for (let i = 0; i < 4; i++) {
      queue.length = 0
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce([
        video(`F${i}a`, 'demonsroots'),
        video(`F${i}b`, 'demonsroots'),
        video(`F${i}c`, 'demonsroots'),
      ])
      const r = await ladder.runLadder({})
      expect(r.kind).toBe('items')
    }
    expect(ladder.autoDigs).toBe(4) // > fixed K=3 —— adaptive 无硬顶的证据
    expect(ladder.lowYieldStreak).toBe(0)
    expect(ladder.canAutoDig()).toBe(true) // 有产出就继续
  })

  it('adaptive: 连续 2 发低产 (<3) 停自动 => 流未尽转手动待决; 丰产轮清零连停', async () => {
    const { ladder, queue } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    ladder.addStream(inputStream())

    // 低产 1 发 => streak 1; 丰产 1 发 => 清零; 再低产 2 发 => streak 2 停
    const yields = [1, 4, 1, 1]
    for (const [i, n] of yields.entries()) {
      queue.length = 0
      vi.mocked(fetchAllV2Search).mockResolvedValueOnce(
        Array.from({ length: n }, (_, j) => video(`Y${i}x${j}`, 'demonsroots')),
      )
      await ladder.runLadder({})
    }
    expect(ladder.autoDigs).toBe(4)
    expect(ladder.lowYieldStreak).toBe(2)
    expect(ladder.canAutoDig()).toBe(false)

    // 深挖流未尽 => 干轮不再挖 => 手动待决横幅
    queue.length = 0
    const r = await ladder.runLadder({})
    expect(r.kind).toBe('manual-pending')
    expect(ladder.autoDigs).toBe(4) // 关闸后不再消耗
  })

  it('adaptive: 零产出早停 (流未尽 => 手动待决) 与风控停 —— 三停另两条同构', async () => {
    // 零产出早停
    const { ladder: lz, seenBvids } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    lz.addStream(inputStream())
    seenBvids.add('BV-dup')
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV-dup')]) // 全已见 => 净增0
    const rz = await lz.runLadder({})
    expect(rz.kind).toBe('manual-pending') // 流未尽 (videos 非空不 exhausted) => 转手动
    expect(lz.earlyStopped).toBe(true)

    // 风控停: engaged 时预挖/自动挖均不跑
    const { ladder: lb, queue } = mk({}, FALLBACK_LADDER_STRATEGY_AGGRESSIVE)
    lb.addStream(inputStream())
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    expect(lb.canAutoDig()).toBe(false)
    expect(await lb.preDig()).toBe(0)
    const rb = await lb.runLadder({})
    expect(rb.kind).toBe('manual-pending') // 不挖不放 => 有流可挖 => 手动待决
    expect(lb.autoDigs).toBe(0)
    expect(queue.length).toBe(0)
  })
  // #endregion

  // #region 票 32: digPass 深挖流并行
  it('digPass: 多流并行发射 —— 慢流挂起不挡快流 (总闸仍下游 tagRecLimit)', async () => {
    const { ladder, queue } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.addStream({ key: 'b', keyword: 'B', attribution: ['B'] })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation((kw) =>
      kw === 'A' ? new Promise<AllV2VideoItem[]>((r) => waiters.push(r)) : Promise.resolve([video(`BV-${kw}`)]),
    )
    const p = ladder.digPass('manual')
    // A 流三页全挂起时 B 流的请求已发出 —— 串行实现下此刻只有 A 的 3 发
    expect(vi.mocked(fetchAllV2Search).mock.calls.filter((c) => c[0] === 'A')).toHaveLength(3)
    expect(vi.mocked(fetchAllV2Search).mock.calls.filter((c) => c[0] === 'B')).toHaveLength(3)

    waiters.forEach((r) => r([video('BVx', 'a')]))
    const y = await p
    expect(y).toBe(2) // BVx 精确入队 + BV-B 空 tag 留堆
    expect(queue.map((x) => x.bvid)).toEqual(['BVx'])
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['BV-B'])
    expect(ladder.streams.get('a')?.nextPage).toBe(4) // 慢流落地后页游标照常推进
    expect(ladder.streams.get('b')?.nextPage).toBe(4)
  })

  it('digPass 并行: 单流失败不拖死其它流 (逐流记账)', async () => {
    const { ladder, queue } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.addStream({ key: 'b', keyword: 'B', attribution: ['B'] })
    vi.mocked(fetchAllV2Search).mockImplementation((kw) =>
      kw === 'A' ? Promise.reject(new Error('network')) : Promise.resolve([video('BV-B', 'b')]),
    )
    const y = await ladder.digPass('manual')
    expect(y).toBe(1) // B 流照常产出
    expect(queue.map((x) => x.bvid)).toEqual(['BV-B'])
    expect(ladder.streams.get('a')?.nextPage).toBe(1) // 失败流页游标不推进, 下轮同页重试
    expect(ladder.streams.get('a')?.exhausted).toBeFalsy()
    expect(ladder.lastDigError).toBe(false) // 非全灭
  })
  // #endregion

  // #region 票 32: 选种扫描 cap12 (池内 score 前 12)
  it('maybeSeedRelated: 未知标签限量轮转扫描，质量高低不影响获取标签的资格', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const richStat = (view: number): TagRecItemExtend['stat'] => ({
      view,
      like: view / 10,
      favorite: view / 10,
      coin: view / 20,
      danmaku: view / 50,
      reply: view / 50,
    })
    const mkItem = (bvid: string, view: number): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: richStat(view),
      source: { via: 'all-v2-exact', groupNames: ['A'] },
    })
    // 去重池 21 条，每轮最多补查 12 个；低质量 p0 仍取得共现评估资格。
    ladder.poolItems.push(mkItem('p0', 1e3))
    ladder.exactPoolItems.push(...Array.from({ length: 20 }, (_, i) => mkItem(`e${i}`, (i + 1) * 1e4)))
    for (const it of [...ladder.poolItems, ...ladder.exactPoolItems]) seenBvids.add(it.bvid)
    vi.mocked(fetchVideoTagNames).mockResolvedValue(['x1'])
    await ladder.maybeSeedRelated()

    expect(fetchVideoTagNames).toHaveBeenCalledTimes(12)
    const called = vi
      .mocked(fetchVideoTagNames)
      .mock.calls.map((c) => c[0])
      .sort()
    expect(called).toEqual(['p0', ...Array.from({ length: 11 }, (_, i) => `e${i}`)].sort())
    expect(ladder.relatedSeeded).toBe(false)
    expect(shared.seededBvids.size).toBe(3)
    expect(shared.seededBvids.has('e10')).toBe(true)
    await ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).toHaveBeenCalledTimes(21)
    expect(shared.seededBvids.has('e19')).toBe(true)
  })
  // #endregion

  // #region 票 38: due 流窗口 + 退避恢复半批 + 退避期避让
  it('digPass: due 流窗口 <=4 —— nextPage 升序取头, 未批流游标不动, 下轮轮转补齐', async () => {
    const { ladder } = mk()
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
      ladder.addStream({ key: k, keyword: k.toUpperCase(), attribution: [k] })
    }
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx', 'x')])
    const callsOf = (k: string) => vi.mocked(fetchAllV2Search).mock.calls.filter((c) => c[0] === k.toUpperCase()).length

    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(12) // 单 pass 封顶 PHASE2_PAGE_BATCH×窗口
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(callsOf)).toEqual([3, 3, 3, 3, 0, 0]) // 同页按迭代序取头 4 条
    expect(ladder.streams.get('a')?.nextPage).toBe(4)
    expect(ladder.streams.get('e')?.nextPage).toBe(1) // 窗外流页游标/exhausted 不碰
    expect(ladder.hasDueStreams()).toBe(true) // 窗外流留待下个 digPass

    await ladder.digPass('manual')
    // 轮转: e/f 页少先挖, 余 2 槽给 a/b —— 公平推进
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(callsOf)).toEqual([6, 6, 3, 3, 3, 3])
    expect(ladder.streams.get('e')?.nextPage).toBe(4)
    expect(ladder.streams.get('a')?.nextPage).toBe(7)
    expect(ladder.streams.get('c')?.nextPage).toBe(4)
  })

  it('digPass: 退避恢复后首个 pass 半批 (4=>2, 页数仍 3) —— 按恢复时刻一次性消费', async () => {
    const { ladder } = mk()
    for (const k of ['a', 'b', 'c', 'd']) ladder.addStream({ key: k, keyword: k.toUpperCase(), attribution: [k] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx', 'x')])
    ;(tagRecBackoff as { lastRecoveredAt: number }).lastRecoveredAt = 100
    vi.mocked(tagRecBackoff.recentlyRecovered).mockReturnValue(true)

    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(6) // 半批 2 流 × 3 页
    expect(ladder.streams.get('a')?.nextPage).toBe(4)
    expect(ladder.streams.get('c')?.nextPage).toBe(1)

    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(6 + 12) // 已消费 => 满窗口 (c,d 补挖 + a,b 续页)

    // 新一次恢复 (新时刻) => 半批重新生效 (时刻比较, 非永久标记)
    ;(tagRecBackoff as { lastRecoveredAt: number }).lastRecoveredAt = 200
    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(6 + 12 + 6)
  })

  it('maybeSeedRelated: 退避期避让 —— 不置 relatedSeeded/不抓名单, 解退避后下轮照跑', async () => {
    const shared = newTagRecLadderState()
    const { ladder } = mk({}, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.poolItems.push({
      api: EApiType.TagRec,
      uniqId: 'tag-rec:p0',
      bvid: 'p0',
      title: 'p0',
      pic: '',
      stat: {},
      source: { via: 'tag-top', groupNames: ['A'] },
    })
    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = true
    await ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
    expect(fetchArchiveRelated).not.toHaveBeenCalled()
    expect(ladder.relatedSeeded).toBe(false) // 「词表未就绪」同款下轮再试语义

    ;(tagRecBackoff as { isEngaged: boolean }).isEngaged = false
    await ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).toHaveBeenCalled() // 恢复后正常进选种流程
    // 票10: p0 名单缺 => 零种子; 执行过不置终态 (热池闭闸才置位)
    expect(ladder.relatedSeeded).toBe(false)
    expect(shared.seededBvids.size).toBe(0)
  })
  // #endregion

  // #region 票 36: 深挖游标入沉淀池 (跨刷新/跨签名续挖; A 档 exhausted 永真至清空/LRU)
  it('digPass 成功推进 => sediment.noteDig 回写 {keyword,nextPage}; 重建流从 dig.nextPage 续起不重付', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx', 'a')])
    await ladder.digPass('manual')
    expect(sediment.noteDig).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ keyword: 'A', nextPage: 4, schemaVersion: 2 }),
    ) // 3页批 => 下次页4
    expect(sediment.map.get('a')?.dig).toMatchObject({ keyword: 'A', nextPage: 4 })

    // 新梯队 (= F5/签名变后重建): 同词建流水合续挖 —— 首个 digPass 从页4起, 不重付 pages 1..3
    const { ladder: l2 } = mk()
    l2.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    expect(l2.streams.get('a')?.nextPage).toBe(4)
    vi.mocked(fetchAllV2Search).mockClear()
    await l2.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([4, 5, 6])
  })

  it('挖穿 exhausted 持久化 (真空页到底): 重建流水合 exhausted => A 档永真不再自动重扫', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    await ladder.digPass('manual') // 全空页 => exhausted
    expect(ladder.streams.get('a')?.exhausted).toBe(true)
    expect(sediment.noteDig).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ keyword: 'A', nextPage: 4, exhausted: true, stopReason: 'empty' }),
    )
    expect(sediment.map.get('a')?.dig?.exhausted).toBe(true)

    const { ladder: l2 } = mk()
    l2.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    expect(l2.streams.get('a')?.exhausted).toBe(true)
    expect(l2.hasDueStreams()).toBe(false)
    const calls = vi.mocked(fetchAllV2Search).mock.calls.length
    await l2.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(calls) // 跨会话零重扫
  })

  it('显示已看从第一页重访已挖尽的词，并保留正常浏览的持久进度', async () => {
    sediment.map.set('a', {
      variants: [],
      cooccur: {},
      lastSeen: 0,
      dig: { keyword: 'A', nextPage: 51, exhausted: true, lastAt: 100 },
    })
    tagRecCustomSession.bypassSeen = true
    try {
      const { ladder } = mk()
      ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
      expect(ladder.streams.get('a')).toMatchObject({ nextPage: 1, exhausted: false })
      await ladder.digPass('manual')
      expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([1, 2, 3])
      expect(sediment.noteDig).not.toHaveBeenCalled()
      expect(sediment.map.get('a')?.dig).toEqual({ keyword: 'A', nextPage: 51, exhausted: true, lastAt: 100 })
    } finally {
      tagRecCustomSession.bypassSeen = false
    }
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    expect(ladder.streams.get('a')).toMatchObject({ nextPage: 51, exhausted: true })
  })

  it('显示已看时，主题推荐的组簇流也从头召回', () => {
    sediment.map.set('x', {
      variants: [],
      cooccur: {},
      lastSeen: 0,
      dig: { keyword: 'X', nextPage: 51, exhausted: true, lastAt: 100 },
    })
    tagRecCustomSession.bypassSeen = true
    try {
      const { ladder } = mk()
      ladder.ensureCliqueStreams([{ name: '组A', tag_ids: [entry(1, 'X')] }])
      expect(ladder.streams.get('x')).toMatchObject({ nextPage: 1, exhausted: false })
    } finally {
      tagRecCustomSession.bypassSeen = false
    }
  })

  it('防呆: 全页失败 (allPagesFailed) 整流跳过 noteDig —— API 抽风空批不落 exhausted/游标', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockRejectedValue(new Error('network')) // 全页 reject
    await ladder.digPass('manual')
    expect(ladder.streams.get('a')?.nextPage).toBe(1) // 游标不动, 下次同页重试
    expect(ladder.streams.get('a')?.exhausted).toBe(false)
    expect(sediment.noteDig).not.toHaveBeenCalled()
    expect(sediment.map.get('a')?.dig).toBeUndefined()
  })

  it('水合门槛 = keyword 精确等值: 同 norm 异拼写不误续, 挖时覆盖写回 dig', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx')])
    await ladder.digPass('manual') // dig.keyword='A' 落盘

    const { ladder: l2 } = mk()
    l2.addStream({ key: 'a', keyword: 'a ', attribution: ['a '] }) // 同 norm (key='a') 异拼写
    expect(l2.streams.get('a')?.nextPage).toBe(1) // keyword 不等 => 按新流
    await l2.digPass('manual')
    expect(sediment.map.get('a')?.dig).toMatchObject({ keyword: 'a ', nextPage: 4 }) // 覆盖写
  })

  it('ensureCliqueStreams 新建流同款水合; 撞 key 合并归属不重建不碰活游标', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'x', keyword: 'X', attribution: ['组A'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx')])
    await ladder.digPass('manual') // x 活游标 => nextPage 4
    // sediment 里有更「深」的旧游标 (例: 别 tab 写) —— 撞 key 合并路径不得回写活流
    sediment.map.set('x', {
      variants: [],
      cooccur: {},
      lastSeen: 0,
      dig: { keyword: 'X', nextPage: 9, lastAt: 0 },
    })
    expect(ladder.ensureCliqueStreams([{ name: '组B', tag_ids: [entry(2, 'X')] }])).toBe(0) // 实际同词只并归属
    expect(ladder.streams.get('x')?.nextPage).toBe(4) // 活游标原样
    expect(ladder.streams.get('x')?.attribution).toEqual(['组A', '组B'])

    // 簇流新建点水合
    sediment.map.set('y', {
      variants: [],
      cooccur: {},
      lastSeen: 0,
      dig: { keyword: 'Y', nextPage: 9, exhausted: true, lastAt: 0 },
    })
    expect(ladder.ensureCliqueStreams([{ name: '组C', tag_ids: [entry(3, 'Y')] }])).toBe(1)
    expect(ladder.streams.get('y')).toMatchObject({ nextPage: 9, exhausted: true })
  })

  it('「清空沉淀」连深挖记忆一起清: map 清空后同词回 page 1', async () => {
    const { ladder } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVx')])
    await ladder.digPass('manual') // 落 dig.nextPage=4
    sediment.map.clear() // 清空沉淀 (危险区) —— sedimentClear 全删天然覆盖 dig
    const { ladder: l2 } = mk()
    l2.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    expect(l2.streams.get('a')?.nextPage).toBe(1)
  })
  // #endregion

  // #region AUDIT-10: digRunning 升共享盒 —— 跨实例单飞
  it('AUDIT-10: 并发 digPass 跨实例单飞 —— 同享在途 promise, 共享流游标不被双推进', async () => {
    const shared = newTagRecLadderState()
    const { ladder: l1 } = mk({}, undefined, shared)
    const { ladder: l2 } = mk({}, undefined, shared) // service 重建 => 新 ladder 同共享盒
    l1.addStream({ key: 'a', keyword: 'A', attribution: ['A'] }) // l2.streams 即同一 Map
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p1 = l1.digPass('manual')
    const p2 = l2.digPass('manual') // 旧实现实例级 digRunning => 此处会并发第二条 doDigPass
    expect(p2).toBe(p1)
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(3) // 只发一批 3 页, 非双倍

    waiters.forEach((r) => r([video('BVx', 'a')]))
    await p1
    expect(l1.streams.get('a')?.nextPage).toBe(4) // 推进一次而非两次
    expect(l1.digRunning).toBeUndefined() // 落定后清位, 下轮可再挖
  })

  it('AUDIT-10: 语境重置清在途位放新 pass 即刻开挖 —— 旧 pass 落定不误摘新 pass', async () => {
    const shared = newTagRecLadderState()
    const { ladder: l1 } = mk({}, undefined, shared)
    const { ladder: l2 } = mk({}, undefined, shared)
    l1.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p1 = l1.digPass('manual')
    resetTagRecLadderState(shared) // 签名变 => 清 digRunning/streams/游标 (新语境即刻可挖)
    l2.addStream({ key: 'b', keyword: 'B', attribution: ['B'] })
    const p2 = l2.digPass('manual')
    expect(p2).not.toBe(p1)
    expect(shared.digRunning).toBe(p2)
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalledTimes(6) // 旧批 3 页 + 新批 3 页

    waiters.forEach((r) => r([])) // 两批同时落定: p1.finally 先跑 (不得误摘 p2), p2.finally 自清
    await Promise.all([p1, p2])
    expect(shared.digRunning).toBeUndefined()
  })

  it('W1-1: 滞留批跨纪元落定 —— 游标/noteDig/聚合账一概不污染新语境', async () => {
    const shared = newTagRecLadderState()
    const { ladder: l1 } = mk({}, undefined, shared)
    const { ladder: l2 } = mk({}, undefined, shared)
    l1.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p1 = l1.digPass('manual') // 旧纪元批: stream a, 占 waiters[0..2]
    resetTagRecLadderState(shared) // 纪元++: streams 清空, a 流对象已离盒
    l2.addStream({ key: 'b', keyword: 'B', attribution: ['B'] })
    const p2 = l2.digPass('manual') // 新纪元批: stream b, 占 waiters[3..5]

    // 旧批带货落定 => 跨纪元: 货不进队列, a 游标不推进不落盘
    waiters.slice(0, 3).forEach((r) => r([video('BV-old', 'a')]))
    // 新批整批空 => b 流推进+exhausted 照常 (新语境语义无损)
    waiters.slice(3).forEach((r) => r([]))
    await Promise.all([p1, p2])

    expect(vi.mocked(sediment.noteDig).mock.calls.map((c) => c[0])).toEqual(['b']) // a 批不落盘
    expect(shared.streams.has('a')).toBe(false) // a 早已离盒
    expect(shared.streams.get('b')?.exhausted).toBe(true) // 新批正常走账
    // 聚合账不烧新语境: yieldN 旧批口径不归新; manual 档不碰 autoDigs/earlyStopped, lastDigYield 只记新批
    expect(shared.lastDigYield).toBe(0)
    expect(shared.pagesFetched).toBe(3) // 仅新批 3 页入账 (旧批 pagesFetched 被纪元门挡)
  })

  it('收编票: 同股批 epoch++ 不作废 —— 已付页照常收编 (游标/noteDig/队列全落)', async () => {
    const shared = newTagRecLadderState()
    const { ladder: l1, queue } = mk({}, undefined, shared)
    l1.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const waiters: ((v: AllV2VideoItem[]) => void)[] = []
    vi.mocked(fetchAllV2Search).mockImplementation(() => new Promise<AllV2VideoItem[]>((r) => waiters.push(r)))

    const p1 = l1.digPass('manual')
    // 同试验配方编辑口径: 只 bump epoch (盒体未清) —— 在途批仍是本盒货, 不作废不重拉
    shared.epoch++
    waiters.forEach((r) => r([video('BV-ok', 'a')]))
    await p1

    expect(queue.map((x) => x.bvid)).toEqual(['BV-ok']) // 已付页收编进队
    expect(l1.streams.get('a')?.nextPage).toBe(4) // 游标照进 —— 不再同页重拉
    expect(sediment.noteDig).toHaveBeenCalledWith('a', expect.objectContaining({ nextPage: 4 }))
    expect(shared.lastDigYield).toBeGreaterThan(0) // 聚合账同股照记
    expect(shared.pagesFetched).toBe(3)
  })
  // #endregion

  // #region AUDIT-12: 页位图游标 —— 批内页失败不跳页
  it('AUDIT-12: 中间页被拒不跳挖 —— 游标只推进最高连续成功前缀, 断点后成功页的货仍收', async () => {
    const { ladder, queue } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockImplementation((_kw, opts) => {
      const page = opts?.page ?? 1
      if (page === 2) return Promise.reject(new Error('page2 boom'))
      return Promise.resolve([video(`BV-p${page}`, 'a')])
    })

    const y = await ladder.digPass('manual')
    // 页1 ok / 页2 拒 / 页3 ok => advance=1; p3 已付代价的货照常入队, 但游标停在断点
    expect(y).toBe(2)
    expect(queue.map((x) => x.bvid).sort()).toEqual(['BV-p1', 'BV-p3'])
    expect(ladder.streams.get('a')?.nextPage).toBe(2) // 旧实现整批 +3 => 页2 永久跳挖
    expect(ladder.streams.get('a')?.exhausted).toBe(false) // 有缺口 => 不得盖终态
    expect(sediment.noteDig).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ keyword: 'A', nextPage: 2, schemaVersion: 2 }),
    )
    expect(ladder.lastDigError).toBe(false)

    // 下个 pass 从缺口重挖: 页2 重试, 页3 已付跳过 => 补 4,5 —— 拒页重获机会且成功页不重付
    vi.mocked(fetchAllV2Search).mockClear()
    vi.mocked(fetchAllV2Search).mockImplementation((_kw, opts) =>
      Promise.resolve([video(`BV2-p${opts?.page ?? 1}`, 'a')]),
    )
    await ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([2, 4, 5])
    expect(ladder.streams.get('a')?.nextPage).toBe(6) // 游标顺吃 2,3,4,5 连续成功段
  })

  it('AUDIT-12: 首页失败即零推进 —— 批内余页货仍收, 下轮同页段重试', async () => {
    const { ladder, queue } = mk()
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    vi.mocked(fetchAllV2Search).mockImplementation((_kw, opts) => {
      const page = opts?.page ?? 1
      if (page === 1) return Promise.reject(new Error('page1 boom'))
      return Promise.resolve([video(`BV-p${page}`, 'a')])
    })

    await ladder.digPass('manual')
    expect(ladder.streams.get('a')?.nextPage).toBe(1) // 断点在首位 => 游标原地
    expect(queue.map((x) => x.bvid).sort()).toEqual(['BV-p2', 'BV-p3']) // 成功页的货不丢
    expect(ladder.streams.get('a')?.exhausted).toBe(false)

    vi.mocked(fetchAllV2Search).mockClear()
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVr')])
    await ladder.digPass('manual')
    // 页位图: 页1 重试 + 页2,3 已付跳过 => 补 4,5 (旧语义同页段全段重付)
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([1, 4, 5])
  })
  // #endregion

  // #region AUDIT-A3: 选种风控账 —— 失败不落账 + 名单预算闸
  it('A3-5: archive/related 请求失败 => 种子不落 seededBvids (下轮可重选); 真空响应才记账', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const poolItem = (bvid: string): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 },
      source: { via: 'tag-top', groupNames: ['A'], groupIds: ['g1'] },
    })
    ladder.poolItems.push(poolItem('s1'), poolItem('s2'))
    seenBvids.add('s1').add('s2')
    vi.mocked(fetchVideoTagNames).mockResolvedValue(['x1'])
    vi.mocked(fetchArchiveRelated).mockImplementation((bvid) =>
      bvid === 's1' ? Promise.reject(new Error('rc -352')) : Promise.resolve([{ bvid: `rel-${bvid}` }]),
    )

    await ladder.maybeSeedRelated()
    // s1 失败不记账 (下轮重获资格); s2 成功响应 (空不空都记) —— 与名单抓取「失败不记账」同口径
    expect(shared.seededBvids.has('s1')).toBe(false)
    expect(shared.seededBvids.has('s2')).toBe(true)
    expect(ladder.heap.map((x) => x.bvid)).toEqual(['rel-s2'])
    // A1-3: 衍生条继承种子 groupIds (名仍带 ·相关 后缀供展示)
    expect(ladder.heap[0].source.groupIds).toEqual(['g1'])
    expect(ladder.heap[0].source.groupNames).toEqual(['A·相关'])

    // 下轮: s1 重新参评并成功 (旧实现永久流失)
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel-s1' }])
    await ladder.maybeSeedRelated()
    expect(shared.seededBvids.has('s1')).toBe(true)
    expect(ladder.heap.some((x) => x.bvid === 'rel-s1')).toBe(true)
  })

  it('A3-3: 名单抓取每轮预算闸 —— 超预算条目本轮不参评, 不失资格 (下轮再评)', async () => {
    const shared = newTagRecLadderState()
    // 扫描深度调到 40 > TAG_REC_SEED_FETCH_BUDGET(30) —— 40 条全参评时预算闸必须截流
    const { ladder, seenBvids } = mk(
      {},
      { triggerYield: 1, autoDig: { mode: 'fixed', max: 3 }, ladder: () => ({ seedPoolMax: 40 }) },
      shared,
    )
    sediment.map.set('a', { variants: [], cooccur: { x1: { count: 1, exampleBvids: [], lastSeen: 0 } }, lastSeen: 0 })
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const poolItem = (bvid: string): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 },
      source: { via: 'tag-top', groupNames: ['A'] },
    })
    // 40 条全入扫描 (同分排序位序保持); 只有 p35 带共现词 —— 若它被预算闸卡掉,
    //   本轮零种子但下轮 budget 重置仍可参评 (不失资格)
    for (let i = 0; i < 40; i++) {
      ladder.poolItems.push(poolItem(`p${i}`))
      seenBvids.add(`p${i}`)
    }
    vi.mocked(fetchVideoTagNames).mockImplementation((bvid) => Promise.resolve(bvid === 'p35' ? ['x1'] : ['zzz']))
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'rel' }])

    await ladder.maybeSeedRelated()
    // 同分 sort 保持原序 => 扫描序 p0..p39; 预算 30 => p30..p39 本轮不抓名单
    const fetched = vi.mocked(fetchVideoTagNames).mock.calls.map((c) => c[0])
    expect(fetched.length).toBeLessThanOrEqual(30)
    expect(fetched).not.toContain('p35')
    expect(shared.seededBvids.has('p35')).toBe(false)
    await ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).toHaveBeenCalledTimes(40)
    expect(shared.seededBvids.has('p35')).toBe(true)
  })

  it.each(['group', 'source'])('堆满时优先削大池，低质量冷池按 %s 保留', (axis) => {
    const { ladder } = mk()
    const rich = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    const cold = {
      ...heapItem('cold'),
      stat: { view: 100, like: 0 },
      source: {
        via: axis === 'source' ? ('archive-related' as const) : ('all-v2-related' as const),
        groupNames: [axis === 'group' ? 'B' : 'A'],
      },
    }
    ;(ladder as any).pushHeap([
      ...Array.from({ length: 600 }, (_, i) => ({ ...heapItem(`hot-${i}`), stat: rich })),
      cold,
    ])
    expect(ladder.heap).toHaveLength(500)
    expect(ladder.heap.some((item) => item.bvid === 'cold')).toBe(true)
  })

  it('已知共现先于质量扫描窗口，低质量强共现候选不会被高质量候选挤掉', async () => {
    const shared = newTagRecLadderState()
    const { ladder, seenBvids } = mk({}, undefined, shared)
    sediment.map.set('a', { confirmed: false, cooccur: { x1: {}, x2: {}, x3: {} }, lastSeen: 0 } as any)
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    const rich = { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 }
    ladder.poolItems.push(
      ...Array.from({ length: 15 }, (_, i) => ({ ...heapItem(`weak-${i}`), stat: rich, ownTagNames: ['x1'] })),
    )
    ladder.poolItems.push({ ...heapItem('strong-low'), stat: { view: 100, like: 0 }, ownTagNames: ['x1', 'x2', 'x3'] })
    for (const item of ladder.poolItems) seenBvids.add(item.bvid)
    shared.producedTotal = 200 // 热组的历史产出不取消当前冷池的选种。
    await ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
    expect(fetchArchiveRelated).toHaveBeenNthCalledWith(1, 'strong-low', expect.anything())
    expect(shared.seededBvids.has('strong-low')).toBe(true)
  })

  it('给冷组补料时，热组的更强共现不抢种子名额，后来的原料也进入评估', async () => {
    const cold = {
      ...heapItem('cold-new'),
      source: { via: 'tag-top' as const, groupIds: ['B'], groupNames: ['B'] },
      ownTagNames: ['x1'],
      stat: { view: 100, like: 0 },
    }
    const { ladder } = mk({
      poolItems: () => [cold],
      candidateScope: () => ({ needed: new Set(['id:B']), all: new Set(['name:A', 'id:B']) }),
    })
    sediment.map.set('a', { confirmed: false, cooccur: { x1: {}, x2: {} }, lastSeen: 0 } as any)
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.poolItems.push({
      ...heapItem('hot-old'),
      source: { via: 'all-v2-related', groupNames: ['A'] },
      ownTagNames: ['x1', 'x2'],
      stat: { view: 1e6, like: 2e5, favorite: 1e5 },
    })
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(fetchArchiveRelated).toHaveBeenCalledWith('cold-new', expect.anything())
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
  })

  it('显式质量门槛仍排除低分种子', async () => {
    const { ladder } = mk({ seedMinScoreOf: () => 50 })
    sediment.map.set('a', { confirmed: false, cooccur: { x1: {}, x2: {} }, lastSeen: 0 } as any)
    ladder.addStream({ key: 'a', keyword: 'A', attribution: ['A'] })
    ladder.poolItems.push(
      { ...heapItem('strong-low'), stat: { view: 100, like: 0 }, ownTagNames: ['x1', 'x2'] },
      {
        ...heapItem('weak-high'),
        stat: { view: 1e6, like: 2e5, favorite: 1e5, coin: 1e5, danmaku: 5e4, reply: 5e4 },
        ownTagNames: ['x1'],
      },
    )
    await ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(fetchArchiveRelated).toHaveBeenCalledWith('weak-high', expect.anything())
  })

  it('堆内相关视频后来获得精确标签命中时升级并入队，不因跨页去重丢证据', async () => {
    const { ladder, queue } = mk()
    ladder.addStream(inputStream())
    vi.mocked(fetchAllV2Search)
      .mockResolvedValueOnce([video('BV-promoted', 'other')])
      .mockResolvedValueOnce([video('BV-promoted', 'demonsroots')])
      .mockResolvedValueOnce([])
    await ladder.digPass('manual')
    expect(queue.map((it) => it.bvid)).toEqual(['BV-promoted'])
    expect(queue[0].source.via).toBe('all-v2-exact')
    expect(queue[0].source.claims).toHaveLength(2)
    expect(queue[0].ownTagNames).toContain('other')
    expect(queue[0].ownTagNames).toContain('demonsroots')
    expect(ladder.heap).toEqual([])
  })
  // #endregion
})
