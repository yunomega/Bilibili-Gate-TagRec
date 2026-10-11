import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { fetchTagTop } from '../api/endpoints'
import {
  computeTagRecFilterSignature,
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  runTagRecFilter,
  runTagRecScoreStage,
  tagRecPoolSizes,
} from '../model/filter-engine'
import { mergeTagRecCandidate } from '../model/relevance'
import { runTagRecRound } from './_pipeline'
import { TagRecDeferredCandidates } from './deferred-candidates'
import { tagRecSupplyView } from './supply'
import { planTagRecRecall } from './up-search'
import type { TagRecItemExtend } from '$define'
import type { TagGroup } from '../model/types'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const group = (id: string, poolsEnabled: Record<string, boolean>): TagGroup => ({
  id,
  name: id,
  tag_ids: [{ id: 1, name: 'alpha' }],
  weight: 1,
  enabled: true,
  addedAt: 0,
  overrides: { poolsEnabled },
})
const video = (via: TagRecItemExtend['source']['via'], owner = 'A'): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'tag-rec:BV1',
  bvid: 'BV1',
  title: '普通视频',
  pic: '',
  stat: { view: 1000, like: 1 },
  source: { via, groupIds: [owner], groupNames: [owner], ...(via === 'tag-top' ? { tagIds: [1] } : {}) },
})
const setup = (groups: TagGroup[], content = true) => {
  const core = createTagRecFactoryFilterCore()
  core.enabled = content
  const resolve = createTagRecScopeResolver({
    core,
    groupsById: new Map(groups.map((g) => [g.id, g])),
    groupsByName: new Map(groups.map((g) => [g.name, g])),
  })
  return { core, resolve }
}

describe('A02/A03/A08/D01: design probes for active claims', () => {
  it('closed top contributes neither relevance nor pool depth to an open search claim', () => {
    const { core, resolve } = setup([group('A', { tagTop: false })])
    const item = mergeTagRecCandidate(video('tag-top'), video('all-v2-related'))
    runTagRecFilter([item], { resolve })
    runTagRecScoreStage([item], core, { resolve })
    expect(item.relevance?.tier).toBe(0)
    expect(Object.keys(tagRecPoolSizes([item]))).toEqual(['["id:A","allV2Related"]'])
    expect(item.source.claims).toHaveLength(2)
  })
  it('turning off content filters still blocks a closed source', () => {
    const { resolve } = setup([group('A', { tagTop: false })], false)
    expect(runTagRecFilter([video('tag-top')], { resolve }).items).toEqual([])
  })
  it('shared tid is requested only for its permitted consumer; all closed creates no request', () => {
    const groups = [group('A', { tagTop: false }), group('B', {})]
    const { resolve } = setup(groups)
    const sources = groups.map((g) => ({ tid: 1, keyword: 'alpha', groupIds: [g.id], groupNames: [g.name] }))
    expect(planTagRecRecall(sources, resolve).tagTop.map((s) => s.groupIds)).toEqual([['B']])
    groups[1].overrides = { poolsEnabled: { tagTop: false } }
    expect(planTagRecRecall(sources, setup(groups).resolve).tagTop).toEqual([])
  })

  it('A07: nearest explicit declaration wins through global/L1/L2/session; source-only equivalent syntax keeps content signature', () => {
    const declarations = [undefined, false, true]
    for (const global of declarations)
      for (const parent of declarations)
        for (const child of declarations)
          for (const session of declarations) {
            const core = createTagRecFactoryFilterCore()
            core.poolsEnabled = { tagTop: global }
            const g = group('A', { tagTop: child! })
            g.l1Id = 'P'
            const l1 = {
              id: 'P',
              name: 'P',
              enabled: true,
              weight: 1,
              addedAt: 0,
              overrides: { poolsEnabled: { tagTop: parent } },
            }
            const resolve = createTagRecScopeResolver({
              core,
              groupsById: new Map([[g.id, g]]),
              l1ById: new Map([['P', l1]]),
              sessionCore: { dims: {}, poolsEnabled: { tagTop: session } },
            })
            const expected = [session, child, parent, global].find((value) => value !== undefined) ?? true
            expect(resolve({ id: 'A' }, 'tagTop').poolsEnabled.tagTop).toBe(expected)
          }
    const core = createTagRecFactoryFilterCore()
    const g = group('A', {})
    g.overrides = undefined
    const before = computeTagRecFilterSignature({ core, groups: [g], withoutSources: true })
    g.overrides = { poolsEnabled: { tagTop: true } }
    expect(computeTagRecFilterSignature({ core, groups: [g], withoutSources: true })).toBe(before)
  })

  it('D01/D02/D03: hard-rejected depth does not become inventory; alternative stock and shared BV are counted once', () => {
    const a = group('A', {})
    const b = group('B', { tagTop: false })
    const { core, resolve } = setup([a, b])
    core.strictMode = true
    core.dims.titleAllow = { enabled: true, list: ['required'] }
    const raw = mergeTagRecCandidate(video('tag-top'), video('all-v2-exact'))
    const rejected = runTagRecFilter([raw], { resolve }).items
    expect(rejected).toHaveLength(0)
    const empty = tagRecSupplyView([raw], rejected, resolve, 1)
    expect([...empty.depth.values()].map((pool) => pool.size)).toEqual([1, 1])
    expect(empty.needs('id:A')).toBe(true)
    raw.title = 'required'
    const ready = runTagRecFilter([raw], { resolve }).items
    const supplied = tagRecSupplyView([raw], ready, resolve, 1)
    expect(supplied.groups.get('id:A')?.size).toBe(1)
    expect(supplied.inventory.size).toBe(2)
    expect(supplied.needs('id:A')).toBe(false)
    expect(supplied.needs('id:B')).toBe(true)
    expect(supplied.depth.has('["id:B","tagTop"]')).toBe(false)
  })

  it('A11: dormant observations obey per-source/total limits and cannot evict open cold stock', () => {
    const { resolve } = setup([group('A', { tagTop: false }), group('B', {})], false)
    const cache = new TagRecDeferredCandidates(2, 3)
    cache.resolve = resolve
    const cold = Array.from({ length: 2 }, (_, i) => ({ ...video('tag-top', 'B'), bvid: `cold-${i}` }))
    cache.record(cold)
    cache.record(Array.from({ length: 10 }, (_, i) => ({ ...video('tag-top'), bvid: `dormant-${i}` })))
    expect(cache.size).toBe(3)
    expect(
      cache
        .values()
        .filter((item) => item.source.groupIds?.includes('B'))
        .map((item) => item.bvid),
    ).toEqual(['cold-0', 'cold-1'])
    expect(cache.values().filter((item) => !item.activeSourceClaims?.length)).toHaveLength(1)
  })

  it('A03/A17: same physical top request preserves each stable consumer and its own query evidence', async () => {
    const { resolve } = setup([group('A', {}), group('B', {})], false)
    const plan = planTagRecRecall(
      [
        { tid: 1, keyword: 'alpha', groupIds: ['A'], groupNames: ['old name'] },
        { tid: 1, keyword: 'beta', groupIds: ['B'], groupNames: ['B'] },
      ],
      resolve,
    )
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'shared' }])
    const result = await runTagRecRound({ sources: plan.tagTop, seenBvids: new Set() })
    expect(plan.tagTop).toHaveLength(1)
    expect(result.items[0].source.claims?.map((claim) => [claim.groupIds, claim.queryKeyword])).toEqual([
      [['A'], 'alpha'],
      [['B'], 'beta'],
    ])
  })

  it('A16: an input named like a favorite uses its own fallback chain', () => {
    const g = group('A', { tagTop: false })
    g.name = 'alpha'
    const { resolve } = setup([g], false)
    const item = { ...video('tag-top'), source: { via: 'tag-top' as const, input: true, groupNames: ['alpha'] } }
    expect(runTagRecFilter([item], { resolve }).items).toHaveLength(1)
    expect(item.eligibleGroupKeys).toEqual(['name:'])
  })
})
