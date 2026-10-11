import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRecBackoff } from '../api/backoff'
import { fetchAllV2Search, fetchArchiveRelated, fetchVideoTagNames } from '../api/endpoints'
import { deriveGroupCliques } from '../model/dig'
import {
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  runTagRecFilter,
  runTagRecScoreStage,
  tagRecPoolScopeKey,
  type TagRecLadderSettings,
} from '../model/filter-engine'
import { sedimentNoteDig, sedimentNoteProbe, type SedimentNode } from '../model/sediment'
import { sediment } from '../store'
import { tagRecCustomSession } from '../store/session'
import { TagRecDeferredCandidates } from './deferred-candidates'
import { newTagRecLadderState, TagRecFallbackLadder } from './fallback-ladder'
import { planTagRecRecall } from './recall-plan'
import type { TagRecItemExtend } from '$define'
import type { TagGroup } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

const backoff = tagRecBackoff as unknown as { isEngaged: boolean }

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve(undefined)) }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, lastRecoveredAt: 0 },
  isRiskControlError: () => false,
}))
vi.mock('../store', async () => {
  const { sedimentNoteDig } = await import('../model/sediment')
  const map = new Map<string, SedimentNode>()
  return {
    sediment: {
      map,
      merge: vi.fn(),
      noteDig: (key: string, dig: Parameters<typeof sedimentNoteDig>[2]) => sedimentNoteDig(map, key, dig),
    },
  }
})

const group = (id: string, words = ['alpha']): TagGroup => ({
  id,
  name: id,
  weight: 1,
  enabled: true,
  addedAt: 0,
  tag_ids: words.map((name, i) => ({ id: i + 1, name })),
})
const fixture = (
  groups = [group('A')],
  options: Partial<TagRecLadderSettings> = {},
  state = newTagRecLadderState(),
) => {
  const core = createTagRecFactoryFilterCore()
  core.enabled = false
  const resolve = () =>
    createTagRecScopeResolver({
      core,
      groupsById: new Map(groups.map((g) => [g.id, g])),
      groupsByName: new Map(groups.map((g) => [g.name, g])),
    })
  const queue: TagRecItemExtend[] = []
  const seen = new Set<string>()
  const candidates = new TagRecDeferredCandidates()
  const config: Partial<TagRecLadderSettings> = { ...options }
  let needed = new Set(groups.map((g) => `id:${g.id}`))
  const ladder = new TagRecFallbackLadder(
    {
      seenBvids: seen,
      resolve,
      policySignature: () => JSON.stringify(groups.map((g) => g.overrides)),
      candidateScope: () => ({ needed, all: new Set(groups.map((g) => `id:${g.id}`)) }),
      queueSize: () => queue.length,
      bypassSeen: () => tagRecCustomSession.bypassSeen,
      poolItems: () => candidates.values(),
      observe: (items) => {
        candidates.resolve = resolve()
        candidates.record(items)
      },
      applyStages: (items) => {
        candidates.resolve = resolve()
        candidates.record(items)
        return runTagRecFilter(items, { resolve: resolve() }).items
      },
      rankItems: (items) => runTagRecScoreStage(items, core, { resolve: resolve() }).items,
      scoreParams: () => core.score,
      pushQueue: (items) => queue.push(...items),
      mergeExisting: (item) =>
        candidates.mergeIncoming(
          item,
          queue,
          (items) => runTagRecScoreStage(items, core, { resolve: resolve() }).items,
          state.heap,
        ),
    },
    { triggerYield: 10, autoDig: { mode: 'adaptive', lowYield: 3, lowYieldStreakLimit: 2 }, ladder: () => config },
    state,
  )
  const plan = () => planTagRecRecall({ roundSources: [], digSources: deriveGroupCliques(groups, Infinity) }, resolve())
  return {
    ladder,
    queue,
    seen,
    candidates,
    config,
    state,
    plan,
    setNeeded: (keys: string[]) => {
      needed = new Set(keys)
    },
  }
}

describe('D04–D12: bounded discovery and scoped recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    sediment.map.clear()
    tagRecCustomSession.bypassSeen = false
    backoff.isEngaged = false
  })
  afterEach(() => vi.useRealTimers())
  it('D04/A15: more than 5 words rotate across rounds, shared consumers are complete, refresh resumes pages', async () => {
    const groups = [
      group(
        'A',
        Array.from({ length: 12 }, (_, i) => `word${i}`),
      ),
      group('B', ['word0']),
    ]
    const f = fixture(groups)
    vi.mocked(fetchAllV2Search).mockImplementation((kw, opts) =>
      Promise.resolve([{ bvid: `${kw}-${opts?.page}`, title: kw, tag: kw }]),
    )
    for (let round = 0; round < 5; round++) {
      f.ladder.ensureCliqueStreams(groups)
      const start = vi.mocked(fetchAllV2Search).mock.calls.length
      await f.ladder.digPass('manual')
      expect(vi.mocked(fetchAllV2Search).mock.calls.length - start).toBeLessThanOrEqual(12)
    }
    expect(new Set(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])).size).toBe(12)
    expect(f.state.wordCursor).toBeGreaterThan(5)
    const refreshed = fixture(groups, {}, f.state)
    expect(refreshed.state.wordCursor).toBe(f.state.wordCursor)
    expect(f.ladder.streams.get('word0')?.groupIds).toEqual(['A', 'B'])
    expect(f.ladder.streams.size).toBeLessThanOrEqual(64)
  })
  it('D04: the same norm with another actual keyword has independent memory pages and cannot borrow a cursor', async () => {
    const a = group('A', ['Alpha'])
    const b = group('B', ['alpha'])
    const f = fixture([a, b])
    vi.mocked(fetchAllV2Search).mockImplementation((kw, options) =>
      Promise.resolve([{ bvid: `${kw}-${options?.page}`, title: kw, tag: kw }]),
    )
    f.ladder.ensureCliqueStreams([a])
    await f.ladder.digPass('manual')
    f.ladder.ensureCliqueStreams([b])
    vi.mocked(fetchAllV2Search).mockClear()
    await f.ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => [c[0], c[1]?.page])).toEqual([
      ['alpha', 1],
      ['alpha', 2],
      ['alpha', 3],
    ])
    expect([...f.ladder.streams.values()].map((s) => [s.keyword, s.nextPage])).toEqual([
      ['Alpha', 4],
      ['alpha', 4],
    ])
  })

  it('D05/D11: mode and low yield settings change stopping; editing limits retains paid rounds', async () => {
    const f = fixture([group('A')], { lowYield: 4, lowYieldStreakLimit: 1 })
    f.ladder.ensureCliqueStreams([group('A')])
    vi.mocked(fetchAllV2Search).mockResolvedValue([{ bvid: 'one', title: 'alpha', tag: 'alpha' }])
    await f.ladder.digPass('auto')
    expect(f.ladder.autoDigs).toBe(1)
    expect(f.ladder.canAutoDig()).toBe(false)
    f.config.mode = 'fixed'
    f.config.autoDigMax = 1
    expect(f.ladder.canAutoDig()).toBe(false)
    f.config.autoDigMax = 2
    expect(f.ladder.canAutoDig()).toBe(true)
    expect(f.ladder.autoDigs).toBe(1)
  })
  it('D06/D07: recheck only A/related at page 1 retains shared normal cursor and B inventory', async () => {
    const a = group('A')
    const b = group('B')
    const f = fixture([a, b])
    f.ladder.ensureCliqueStreams([a, b])
    vi.mocked(fetchAllV2Search).mockImplementation((_kw, opts) =>
      Promise.resolve([{ bvid: `old-${opts?.page}`, title: 'alpha', tag: 'alpha' }]),
    )
    await f.ladder.digPass('manual')
    const before = f.queue.slice()
    const dig = { ...sediment.map.get('alpha')!.dig }
    f.candidates.delivered(f.queue)
    f.queue.length = 0
    vi.mocked(fetchAllV2Search)
      .mockClear()
      .mockResolvedValue([
        { bvid: 'old-1', title: 'old', tag: 'other' },
        { bvid: 'new', title: 'new', tag: 'other' },
      ])
    const result = await f.ladder.recheck({ key: { id: 'A' }, pools: ['allV2Related'], keyword: 'alpha' }, f.plan())
    expect(result.requests).toBe(1)
    expect(result.added).toBe(1)
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([1])
    expect(f.queue.map((i) => i.bvid)).toEqual(['new'])
    expect(f.queue[0].source.groupIds).toEqual(['A'])
    expect(f.ladder.streams.get('alpha')?.nextPage).toBe(4)
    expect(sediment.map.get('alpha')!.dig?.nextPage).toBe(dig.nextPage)
    expect(before.every((i) => i.source.groupIds?.includes('B'))).toBe(true)
    expect(Object.keys(sediment.map.get('alpha')!.dig?.probes ?? {})).toEqual([
      tagRecPoolScopeKey({ id: 'A' }, 'allV2Related'),
    ])
  })
  it('D08/A12: duplicate scoped probes merge, closing source while pending refilters old output out', async () => {
    const a = group('A')
    const f = fixture([a])
    let finish!: (videos: { bvid: string; title: string; tag: string }[]) => void
    vi.mocked(fetchAllV2Search).mockImplementation(() => {
      const response = Promise.withResolvers<{ bvid: string; title: string; tag: string }[]>()
      finish = response.resolve
      return response.promise
    })
    const selection = { key: { id: 'A' }, pools: ['allV2Related' as const], keyword: 'alpha' }
    const one = f.ladder.recheck(selection, f.plan())
    const two = f.ladder.recheck(selection, f.plan())
    expect(one).toBe(two)
    expect(fetchAllV2Search).toHaveBeenCalledTimes(1)
    a.overrides = { poolsEnabled: { allV2Related: false } }
    finish([{ bvid: 'late', title: 'late', tag: 'other' }])
    // 收编票: 池开关翻转不作废在途批 (同股盒) —— 收编后由活 resolver 按新闸过滤, 货照样出局
    expect((await one).stale).toBe(false)
    expect(f.queue).toEqual([])
    expect(f.seen.has('late')).toBe(false)
  })
  it('D08: cancel and a newer scoped state version invalidate late results before inventory/corpus writes', async () => {
    const f = fixture()
    let finish!: (items: { bvid: string; tag: string }[]) => void
    vi.mocked(fetchAllV2Search).mockImplementation(() => {
      const response = Promise.withResolvers<{ bvid: string; tag: string }[]>()
      finish = response.resolve
      return response.promise
    })
    const selection = { key: { id: 'A' }, pools: ['allV2' as const], keyword: 'alpha' }
    const controller = new AbortController()
    const cancelled = f.ladder.recheck(selection, f.plan(), controller.signal)
    controller.abort()
    finish([{ bvid: 'late', tag: 'alpha' }])
    expect((await cancelled).stale).toBe(true)
    expect(f.queue).toHaveLength(0)
    expect(sediment.merge).not.toHaveBeenCalled()
    const old = f.ladder.recheck(selection, f.plan())
    sedimentNoteProbe(sediment.map, 'alpha', 'alpha', tagRecPoolScopeKey({ id: 'A' }, 'allV2'), false, 300_000)
    finish([{ bvid: 'older', tag: 'alpha' }])
    expect((await old).stale).toBe(true)
    expect(f.seen.has('older')).toBe(false)
    expect(f.queue).toHaveLength(0)
  })

  it('D09/D10: failed expired probe stays unknown with cooldown; a repeated run neither recharges nor rescans', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const a = group('A')
    const f = fixture([a], { emptyTtlMinutes: 5 })
    f.ladder.ensureCliqueStreams([a])
    await f.ladder.digPass('auto')
    vi.setSystemTime(1_300_001)
    vi.mocked(fetchAllV2Search).mockClear().mockRejectedValue(new Error('network'))
    await f.ladder.runLadder()
    expect(fetchAllV2Search).toHaveBeenCalledTimes(1)
    expect(sediment.map.get('alpha')!.dig?.probes?.[tagRecPoolScopeKey({ id: 'A' }, 'allV2')]).toMatchObject({
      empty: undefined,
      retryAt: 1_600_001,
    })
    await f.ladder.runLadder()
    expect(fetchAllV2Search).toHaveBeenCalledTimes(1)
    expect(f.ladder.autoDigs).toBe(2)
  })

  it('A05/A10: paid archive response can serve a newly reopened legitimate seed consumer without another request', async () => {
    const a = group('A')
    const b = group('B')
    a.overrides = { poolsEnabled: { archiveRelated: false } }
    const f = fixture([a, b])
    f.ladder.ensureCliqueStreams([a, b])
    sediment.map.set('alpha', {
      variants: [],
      cooccur: { shared: { count: 1, exampleBvids: [], lastSeen: 0 } },
      lastSeen: 0,
    })
    const seed: TagRecItemExtend = {
      api: 'tag-rec' as TagRecItemExtend['api'],
      uniqId: 'seed',
      bvid: 'seed',
      title: 'seed',
      pic: '',
      stat: {},
      ownTagNames: ['shared'],
      source: { via: 'tag-top', groupIds: ['A', 'B'], groupNames: ['A', 'B'] },
    }
    f.candidates.record([seed])
    vi.mocked(fetchArchiveRelated).mockResolvedValue([{ bvid: 'related', title: 'related' }])
    await f.ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(f.ladder.heap[0].source.groupIds).toEqual(['B'])
    a.overrides.poolsEnabled!.archiveRelated = true
    await f.ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
    expect(f.ladder.heap[0].source.groupIds?.sort()).toEqual(['A', 'B'])
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
  })

  it('A14: cached paid archive responses are bounded by raw rows, not just seed count', async () => {
    const a = group('A')
    const f = fixture([a])
    f.ladder.ensureCliqueStreams([a])
    sediment.map.set('alpha', {
      variants: [],
      cooccur: { shared: { count: 1, exampleBvids: [], lastSeen: 0 } },
      lastSeen: 0,
    })
    f.candidates.record([
      {
        api: 'tag-rec' as TagRecItemExtend['api'],
        uniqId: 'seed',
        bvid: 'seed',
        title: 'seed',
        pic: '',
        stat: {},
        ownTagNames: ['shared'],
        source: { via: 'tag-top', groupIds: ['A'], groupNames: ['A'] },
      },
    ])
    vi.mocked(fetchArchiveRelated).mockResolvedValue(
      Array.from({ length: 600 }, (_, i) => ({ bvid: `related-${i}`, title: 'related' })),
    )
    await f.ladder.maybeSeedRelated()
    expect(f.state.seedRequests.size).toBe(0)
    expect(f.ladder.heap.length).toBeLessThanOrEqual(500)
    await f.ladder.maybeSeedRelated()
    expect(fetchArchiveRelated).toHaveBeenCalledTimes(1)
  })

  it('D09/D11: expired empty with no demand/closed/backoff/paid fixed limit makes zero requests; demand probes one page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const a = group('A')
    const f = fixture([a], { mode: 'fixed', autoDigMax: 2, emptyTtlMinutes: 5 })
    f.ladder.ensureCliqueStreams([a])
    await f.ladder.digPass('auto')
    vi.mocked(fetchAllV2Search).mockClear()
    vi.setSystemTime(1_300_001)
    f.setNeeded([])
    await f.ladder.runLadder()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    f.setNeeded(['id:A'])
    backoff.isEngaged = true
    await f.ladder.runLadder()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    backoff.isEngaged = false
    await f.ladder.runLadder()
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([1])
    expect(f.ladder.autoDigs).toBe(2)
    vi.setSystemTime(1_600_002)
    await f.ladder.runLadder()
    expect(fetchAllV2Search).toHaveBeenCalledTimes(1)
    expect(f.ladder.streams.get('alpha')?.nextPage).toBe(4)
  })
  it('D10: cap issues only page 50, marks cap independently; failures keep unknown cursor', async () => {
    const f = fixture()
    f.ladder.ensureCliqueStreams([group('A')])
    f.ladder.streams.get('alpha')!.nextPage = 50
    vi.mocked(fetchAllV2Search).mockResolvedValue([{ bvid: 'cap', title: 'alpha', tag: 'alpha' }])
    await f.ladder.digPass('manual')
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[1]?.page)).toEqual([50])
    expect(f.ladder.streams.get('alpha')?.stopReason).toBe('cap')
    const failed = fixture([group('B', ['beta'])])
    failed.ladder.ensureCliqueStreams([group('B', ['beta'])])
    vi.mocked(fetchAllV2Search).mockRejectedValue(new Error('network'))
    await failed.ladder.digPass('auto')
    expect(failed.ladder.streams.get('beta')?.nextPage).toBe(1)
    expect(sediment.map.get('beta')?.dig).toBeUndefined()
    expect(failed.ladder.autoDigs).toBe(1)
  })
  it('D12: scoped probe preserves old cursor and corpus; legacy exhausted cannot overwrite migrated state', () => {
    sedimentNoteDig(sediment.map, 'alpha', { keyword: 'alpha', nextPage: 8, exhausted: true }, 100)
    const old = { ...sediment.map.get('alpha')!.dig! }
    sedimentNoteProbe(sediment.map, 'alpha', 'alpha', 'A/related', false, 300_000, 0, 200)
    sedimentNoteDig(sediment.map, 'alpha', { keyword: 'alpha', nextPage: 2, exhausted: true }, 300)
    expect(sediment.map.get('alpha')!.lastSeen).toBe(200)
    expect(sediment.map.get('alpha')!.dig?.nextPage).toBe(old.nextPage)
    expect(sediment.map.get('alpha')!.dig?.probes?.['A/related']).toMatchObject({
      empty: false,
      revision: 1,
      retryAt: 300_200,
    })
    expect(sediment.map.get('alpha')!.cooccur).toEqual({})
  })
  it('A05: archive disabled precedes seed tag scanning and related requests', async () => {
    const a = group('A')
    a.overrides = { poolsEnabled: { archiveRelated: false } }
    const f = fixture([a])
    f.ladder.ensureCliqueStreams([a])
    sediment.map.set('alpha', {
      variants: [],
      cooccur: { other: { count: 1, lastSeen: 1, exampleBvids: [] } },
      lastSeen: 1,
    })
    f.ladder.poolItems.push({
      api: 'tag-rec' as TagRecItemExtend['api'],
      uniqId: 'tag-rec:seed',
      bvid: 'seed',
      title: 'alpha',
      pic: '',
      stat: {},
      source: { via: 'tag-top', groupNames: ['A'], groupIds: ['A'] },
    })
    await f.ladder.maybeSeedRelated()
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
    expect(fetchArchiveRelated).not.toHaveBeenCalled()
  })
})
