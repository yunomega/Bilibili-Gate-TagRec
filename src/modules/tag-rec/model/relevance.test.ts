import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { TagRecDeferredCandidates } from '../service/deferred-candidates'
import { previewTagRecFairSlice, TagRecFairState } from '../service/fair-queue'
import { compareTagRecGroupItems } from '../service/item-order'
import { refilterTagRecStock } from '../service/refilter-stock'
import { migrateTagRecDefaultQualityGate } from './defaults'
import { selectCooccurSeeds } from './dig'
import { makeTagGroup, makeTagL1Group } from './favorites'
import {
  createTagRecBuiltinPresets,
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  resolveTagRecSeedMinScore,
  runTagRecFilter,
  runTagRecScoreStage,
} from './filter-engine'
import { mergeTagRecCandidate, tagRecGroupKey, tagRecRelevanceOf } from './relevance'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagGroup } from './types'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const entry = { id: 1, name: 'alpha' }
const video = (
  bvid: string,
  group = 'A',
  via: TagRecItemExtend['source']['via'] = 'all-v2-related',
): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: '普通视频',
  pic: '',
  stat: { view: 1000, like: 0, favorite: 0, coin: 0, danmaku: 0, reply: 0 },
  source: { via, groupNames: [group], groupIds: [group] },
})
const group = (id: string, tag = entry): TagGroup => makeTagGroup({ id, name: id, l1Id: 'P', tag_ids: [tag] })!
const resolver = (core = createTagRecFactoryFilterCore(), groups = [group('A')]) =>
  createTagRecScopeResolver({
    core,
    groupsById: new Map(groups.map((g) => [g.id, g])),
    groupsByName: new Map(groups.map((g) => [g.name, g])),
  })
const rich = { view: 1e6, like: 2e5, favorite: 1e5, coin: 5e4, danmaku: 5e4, reply: 5e4 }

describe('相关性、质量与小池的独立语义', () => {
  it('真实标签命中 > 标题命中 > 无命中，同层才按质量排序', () => {
    const core = createTagRecFactoryFilterCore()
    const exact = { ...video('exact-low'), ownTagNames: ['alpha'] }
    const title = { ...video('title-mid'), title: 'alpha 实况', stat: rich }
    const unrelated = { ...video('unrelated-high'), stat: rich, ownTagNames: ['other'] }
    const direct = video('direct-low', 'A', 'tag-top')
    direct.source.tagIds = [1]
    const out = runTagRecScoreStage([unrelated, title, exact, direct], core, { resolve: resolver(core) }).items
    expect(out.map((it) => it.bvid)).toEqual(['direct-low', 'exact-low', 'title-mid', 'unrelated-high'])
    expect(exact.score).toBeLessThan(title.score!)
  })

  it('缺少统计使用中性排序值，保留公开分数为空，不抹掉标签证据', () => {
    const core = createTagRecFactoryFilterCore()
    const missing = { ...video('missing'), stat: { view: 10 }, ownTagNames: ['alpha'] }
    const low = { ...video('low'), ownTagNames: ['alpha'] }
    const high = { ...video('high'), stat: rich, ownTagNames: ['alpha'] }
    const out = runTagRecScoreStage([low, missing, high], core, { resolve: resolver(core) }).items
    expect(out.map((it) => it.bvid)).toEqual(['high', 'missing', 'low'])
    expect(missing.score).toBeUndefined()
    expect(missing.qualitySortScore).toBeCloseTo((low.score! + high.score!) / 2)
  })

  it('归因名不作相关性证据，标签 id 与名字不会重复计命中', () => {
    const it = { ...video('own'), ownTagIds: [1], ownTagNames: ['alpha'] }
    expect(tagRecRelevanceOf(it, [entry])).toEqual({ tier: 2, hits: 1 })
    expect(tagRecRelevanceOf(video('none'), [entry])).toEqual({ tier: 0, hits: 0 })
  })

  it('B 组的命中不能提升该视频在 A 组的排序', () => {
    const core = createTagRecFactoryFilterCore()
    const both = video('both')
    both.source.groupIds = ['A', 'B']
    both.source.groupNames = ['A', 'B']
    both.ownTagNames = ['beta']
    both.stat = rich
    const exactA = { ...video('exact-a'), ownTagNames: ['alpha'] }
    runTagRecScoreStage([both, exactA], core, {
      resolve: resolver(core, [group('A'), group('B', { id: 2, name: 'beta' })]),
    })
    expect(both.relevance?.tier).toBe(2)
    expect(compareTagRecGroupItems('A', exactA, both)).toBeLessThan(0)
  })

  it('同相关性层的质量按各组自己的参数排序，另一组的高分不能替代本组分数', () => {
    const core = createTagRecFactoryFilterCore()
    const a = group('A')
    const b = group('B', { id: 2, name: 'beta' })
    a.overrides = { score: { weights: { view: 1, likeRate: 0, favRate: 0, coinRate: 0, interactRate: 0 } } }
    b.overrides = { score: { weights: { view: 0, likeRate: 1, favRate: 0, coinRate: 0, interactRate: 0 } } }
    const both = { ...video('both'), ownTagNames: ['alpha'], stat: { view: 1000, like: 120 } }
    both.source.groupIds = ['A', 'B']
    both.source.groupNames = ['A', 'B']
    const onlyA = { ...video('a-view'), ownTagNames: ['alpha'], stat: { view: 1e5, like: 0 } }
    runTagRecScoreStage([both, onlyA], core, { resolve: resolver(core, [a, b]) })
    expect(both.score).toBeGreaterThan(onlyA.score!)
    expect(compareTagRecGroupItems('A', onlyA, both)).toBeLessThan(0)
  })

  it('同 BV 后来的直接命中提升候选，保留旧来源且不会因重复召回无限增加记录', () => {
    const related = { ...video('same'), ownTagNames: ['other'] }
    const direct = video('same', 'A', 'tag-top')
    direct.source.tagIds = [1]
    mergeTagRecCandidate(related, direct)
    direct.srcRank = 7
    mergeTagRecCandidate(related, direct)
    expect(related.source.via).toBe('tag-top')
    expect(related.source.claims).toHaveLength(2)
    expect(tagRecRelevanceOf(related, [entry], { id: 'A' })).toEqual({ tier: 2, hits: 1 })
    expect(related.ownTagNames).toEqual(['other'])
  })

  it('审计 §5: 同 BV 后到的完整行回填残缺字段 —— 简介/UP/时长不再被丢, 强证据升级盖值', () => {
    const row = video('same-bv') // 行级数据: 无 desc/owner/duration
    const enriched = {
      ...video('same-bv'),
      desc: '完整简介',
      owner: { mid: 42, name: 'UP' },
      duration: 600,
      fieldEvidence: { title: 'complete' as const, desc: 'complete' as const },
    }
    mergeTagRecCandidate(row, enriched)
    expect(row.desc).toBe('完整简介')
    expect(row.owner).toEqual({ mid: 42, name: 'UP' })
    expect(row.duration).toBe(600)
    expect(row.fieldEvidence).toEqual({ title: 'complete', desc: 'complete' })
    // 强证据升级连带覆盖字段值: 详情回包的完整标题盖掉行级残缺标题
    const partial = { ...video('same-bv2'), title: '残', fieldEvidence: { title: 'partial' as const } }
    mergeTagRecCandidate(partial, {
      ...video('same-bv2'),
      title: '完整标题',
      fieldEvidence: { title: 'complete' as const },
    })
    expect(partial.title).toBe('完整标题')
    // 已有完整证据不被后来响应的缺字段 (missing) 降级, 字段值也不被抹
    mergeTagRecCandidate(row, { ...video('same-bv'), fieldEvidence: { desc: 'missing' as const } })
    expect(row.desc).toBe('完整简介')
    expect(row.fieldEvidence?.desc).toBe('complete')
  })

  it.each(['group', 'source'])('大池不取消小池照顾：按 %s 独立计算，硬条件仍生效', (axis) => {
    const core = createTagRecFactoryFilterCore()
    core.dims.likeRate.enabled = true
    core.dims.viewMin = { enabled: true, value: 500 }
    const hot = Array.from({ length: 40 }, (_, i) => video(`hot-${i}`))
    const coldGroup = axis === 'group' ? 'B' : 'A'
    const cold = video('cold', coldGroup, 'tag-top')
    const hardFail = video('hard-fail', coldGroup, 'tag-top')
    hardFail.stat.view = 100
    const all = [...hot, cold, hardFail]
    const result = runTagRecFilter(all, {
      resolve: resolver(core, [group('A'), group('B')]),
      poolItems: all,
      poolSize: 42,
    })
    expect(result.items.map((it) => it.bvid)).toEqual(['cold'])
    expect(result.stats).toMatchObject({ degraded: true, byDim: { likeRate: 40, viewMin: 1 } })
  })

  it('默认允许相关低质量内容；显式质量档与选种门槛仍可排除', () => {
    const low = { ...video('low'), ownTagNames: ['alpha'] }
    const core = createTagRecFactoryFilterCore()
    core.smallPoolThreshold = 0
    expect(runTagRecFilter([low], { resolve: resolver(core) }).items).toHaveLength(1)
    const highOnly = createTagRecBuiltinPresets().find((p) => p.name === '只看高质量')!.config
    highOnly.smallPoolThreshold = 0
    expect(runTagRecFilter([low], { resolve: resolver(highOnly) }).items).toHaveLength(0)
    expect(resolveTagRecSeedMinScore(low, resolver(highOnly))).toBe(50)
    const seeds = [
      { bvid: 'strong-low', cooccur: 9, score: 10 },
      { bvid: 'missing', cooccur: 8, score: undefined },
      { bvid: 'weak-high', cooccur: 1, score: 90 },
    ]
    expect(selectCooccurSeeds(seeds)).toEqual(['strong-low', 'missing', 'weak-high'])
    expect(selectCooccurSeeds(seeds, { minScore: 50 })).toEqual(['weak-high'])
  })

  it('仅迁移未定制的旧默认质量门槛', () => {
    const old = createTagRecFactoryFilterCore()
    old.dims.likeRate.enabled = true
    expect(migrateTagRecDefaultQualityGate(old)).toBe(true)
    expect(old.dims.likeRate.enabled).toBe(false)
    expect(migrateTagRecDefaultQualityGate(old)).toBe(false)
    const custom = createTagRecFactoryFilterCore()
    custom.dims.likeRate.enabled = true
    custom.dims.viewMin.value = 10
    expect(migrateTagRecDefaultQualityGate(custom)).toBe(false)
    expect(custom.dims.likeRate.enabled).toBe(true)
  })
})

describe('候选恢复与公平交付', () => {
  it('库存获得新标签数据后重新校验现有规则，不能绕过已开启的硬筛选', () => {
    const core = createTagRecFactoryFilterCore()
    core.dims.tagBlock = { enabled: true, list: [{ id: 9, name: 'blocked' }] }
    const cache = new TagRecDeferredCandidates()
    const original = video('same')
    const queue: RecItemTypeOrSeparator[] = [original]
    expect(cache.mergeIncoming({ ...video('same'), ownTagNames: ['blocked'] }, queue, (items) => items)).toBeUndefined()
    expect(cache.needsRefilter).toBe(true)
    refilterTagRecStock(queue, core, resolver(core), { candidates: cache })
    expect(queue).toEqual([])
    expect(cache.needsRefilter).toBe(false)
  })

  it('收紧时留下原料，放宽后重新筛选算分，已交付候选和已看内容不恢复', () => {
    const core = createTagRecFactoryFilterCore()
    const cache = new TagRecDeferredCandidates()
    const queue: RecItemTypeOrSeparator[] = [video('recover'), video('seen'), video('delivered')]
    cache.record(queue as TagRecItemExtend[])
    cache.delivered([queue.pop()!])
    core.dims.viewMin = { enabled: true, value: 2000 }
    refilterTagRecStock(queue, core, resolver(core), { candidates: cache })
    expect(queue).toEqual([])
    core.dims.viewMin.enabled = false
    refilterTagRecStock(queue, core, resolver(core), {
      candidates: cache,
      recover: (items) => items.filter((it) => it.bvid !== 'seen'),
    })
    expect(queue.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual(['recover'])
    expect((queue[0] as TagRecItemExtend).score).toBeDefined()
    cache.delivered(queue)
    queue.length = 0
    refilterTagRecStock(queue, core, resolver(core), { candidates: cache, recover: () => [] })
    expect(queue).toEqual([])
  })

  it('候选缓存按组×来源限量，总量削最大池时仍保留冷池', () => {
    const cache = new TagRecDeferredCandidates(5, 6)
    cache.record([video('cold', 'B'), ...Array.from({ length: 20 }, (_, i) => video(`hot-${i}`))])
    expect(cache.size).toBe(6)
    expect(cache.values().map((it) => it.bvid)).toContain('cold')
    cache.record(Array.from({ length: 5 }, (_, i) => video(`other-${i}`, 'C')))
    expect(cache.size).toBe(6)
    expect(cache.values().map((it) => it.bvid)).toContain('cold')
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it.each(['group', 'source'])('共享视频的冷池归属不被热门 %s 的容量淘汰连带清掉', (axis) => {
    const cache = new TagRecDeferredCandidates(5, 6)
    const shared = video('shared')
    if (axis === 'group') {
      shared.source.groupIds = ['A', 'B']
      shared.source.groupNames = ['A', 'B']
    } else {
      shared.source.claims = [
        { via: 'all-v2-related', groupIds: ['A'], groupNames: ['A'] },
        { via: 'archive-related', groupIds: ['A'], groupNames: ['A'] },
      ]
    }
    cache.record([shared, ...Array.from({ length: 20 }, (_, i) => video(`hot-${i}`))])
    expect(cache.size).toBe(5)
    expect(cache.values().map((it) => it.bvid)).toContain('shared')
    cache.record(Array.from({ length: 5 }, (_, i) => video(`other-${i}`, 'C')))
    expect(cache.size).toBe(6)
    expect(cache.values().map((it) => it.bvid)).toContain('shared')
  })

  it('只有通过筛选的归属组获得库存和交付份额', () => {
    const a = group('A')
    const b = group('B')
    const both = video('both')
    both.source.groupIds = ['A', 'B']
    both.source.groupNames = ['A', 'B']
    both.eligibleGroupKeys = [tagRecGroupKey({ id: 'B' })]
    const parent = makeTagL1Group({ id: 'P', name: 'P', enabled: true })!
    const preview = previewTagRecFairSlice([both], [a, b], [parent], new TagRecFairState(), 1)
    expect(preview.turns[0].group?.id).toBe('B')
  })

  it('严格复核改由 B 组放行后，只给 B 记已交付，下一次 A 获得应有份额', () => {
    const a = group('A')
    const b = group('B')
    const both = video('both')
    both.source.groupIds = ['A', 'B']
    both.source.groupNames = ['A', 'B']
    const parent = makeTagL1Group({ id: 'P', name: 'P', enabled: true })!
    const state = new TagRecFairState()
    const preview = previewTagRecFairSlice([both, video('other-b', 'B')], [a, b], [parent], state, 1)
    expect(preview.turns[0].group?.id).toBe('A')
    both.eligibleGroupKeys = [tagRecGroupKey({ id: 'B' })]
    state.commit(preview.turns, new Set([both]))
    const next = previewTagRecFairSlice([video('next-a'), video('next-b', 'B')], [a, b], [parent], state, 1)
    expect(next.turns[0].group?.id).toBe('A')
  })
})
