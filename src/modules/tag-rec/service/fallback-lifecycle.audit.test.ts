import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { fetchArchiveRelated } from '../api/endpoints'
import {
  createTagRecFactoryFilterCore,
  createTagRecFactoryScoreParams,
  createTagRecScopeResolver,
} from '../model/filter-engine'
import { runPhase2Round } from '../model/resolve'
import { sediment } from '../store'
import { newTagRecLadderState, TagRecFallbackLadder, type FallbackLadderHooks } from './fallback-ladder'
import type { TagRecItemExtend } from '$define'
import type { AllV2VideoItem } from '../model/normalize-item'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, lastRecoveredAt: 0, recentlyRecovered: () => false },
}))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchArchiveRelated: vi.fn(),
  fetchVideoTagNames: vi.fn(),
  fetchTagTop: vi.fn(),
}))
vi.mock('../model/resolve', () => ({ PHASE2_PAGE_BATCH: 3, runPhase2Round: vi.fn() }))
vi.mock('../store', async () => {
  const { sedimentNoteDig } = await import('../model/sediment')
  const map: Parameters<typeof sedimentNoteDig>[0] = new Map()
  return {
    sediment: {
      map,
      merge: vi.fn(),
      noteDig: (norm: string, dig: Parameters<typeof sedimentNoteDig>[2]) => sedimentNoteDig(map, norm, dig),
    },
  }
})
const page = (videos: AllV2VideoItem[] = []): Awaited<ReturnType<typeof runPhase2Round>> =>
  ({
    videos,
    analysis: { exact: videos, related: [], cliques: [] },
    variantEntries: [],
    newCandidates: [],
    pagesFetched: 1,
    allPagesFailed: false,
  }) as unknown as Awaited<ReturnType<typeof runPhase2Round>>
const card = (id: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: id,
  bvid: id,
  title: id,
  pic: '',
  stat: {},
  source: { via: 'all-v2-related', groupNames: [] },
})
const setup = (overrides: Partial<FallbackLadderHooks> = {}) => {
  const state = newTagRecLadderState()
  const queue: TagRecItemExtend[] = []
  const ladder = new TagRecFallbackLadder(
    {
      seenBvids: new Set(),
      applyStages: (items) => items,
      pushQueue: (items) => queue.push(...items),
      queueSize: () => queue.length,
      scoreParams: () => createTagRecFactoryScoreParams(),
      bypassSeen: () => false,
      ...overrides,
    },
    undefined,
    state,
  )
  ladder.addStream({ key: 'a', keyword: 'a', attribution: ['a'], input: true })
  return { ladder, state, queue, stream: ladder.streams.get('a')! }
}
beforeEach(() => {
  vi.clearAllMocks()
  sediment.map.clear()
  vi.mocked(runPhase2Round).mockResolvedValue(page())
})

describe('fallback lifecycle and retained work', () => {
  it('retains a physical page when its stage throws', () => {
    const applyStages = vi.fn((items: TagRecItemExtend[]) => items)
    const { ladder } = setup({ applyStages })
    ladder.heap.push(card('a'), card('b'))
    applyStages.mockImplementationOnce(() => {
      throw new Error('stage failed')
    })
    expect(() => ladder.releasePage()).toThrow('stage failed')
    expect(ladder.heap.map((item) => item.bvid)).toEqual(['a', 'b'])
    expect(ladder.releasePage()).toHaveLength(2)
    expect(ladder.heap).toHaveLength(0)
  })

  it('resetting cursors invalidates old page results even without an existing persisted cursor', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof runPhase2Round>>>()
    vi.mocked(runPhase2Round).mockReturnValue(held.promise)
    const { ladder, stream, queue } = setup()
    const pending = ladder.digPass('auto')
    ladder.resetDigCursors()
    held.resolve(page([{ bvid: 'old', title: 'a', tag: 'a' }]))
    await pending
    expect(stream.nextPage).toBe(1)
    expect(stream.okPages?.size ?? 0).toBe(0)
    expect(queue).toHaveLength(0)
    expect(ladder.earlyStopped).toBe(false)
    expect(sediment.map.get('a')?.dig).toBeUndefined()
  })

  it('persists a productivity-based cap lift before the old cap has been reached', async () => {
    const { ladder, stream } = setup()
    stream.pageCap = 5
    vi.mocked(runPhase2Round).mockImplementation(({ fromPage }) =>
      Promise.resolve(page(Array.from({ length: 3 }, (_, i) => ({ bvid: `p${fromPage}-${i}`, title: 'a', tag: 'a' })))),
    )
    await ladder.digPass('auto')
    expect(stream.nextPage).toBe(4)
    expect(stream.capLifted).toBe(true)
    expect(sediment.map.get('a')?.dig?.capLifted).toBe(true)
  })

  it('does not let a stale all-skipped batch publish an empty-stop decision', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof runPhase2Round>>>()
    vi.mocked(runPhase2Round).mockReturnValue(held.promise)
    const { ladder } = setup()
    const pending = ladder.digPass('auto')
    sediment.noteDig('a', { keyword: 'a', nextPage: 1, schemaVersion: 2 })
    held.resolve(page())
    await pending
    expect(ladder.earlyStopped).toBe(false)
  })

  it('foreground cancellation stops waiting for a shared prefetch without cancelling that prefetch', async () => {
    const held = Promise.withResolvers<number>()
    const { ladder, state } = setup()
    state.digRunning = held.promise
    const controller = new AbortController()
    const outcome = vi.fn()
    const pending = ladder.runLadder({ signal: controller.signal }).then(outcome)
    controller.abort()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const beforePrefetchFinishes = outcome.mock.calls[0]?.[0]
    held.resolve(0)
    await pending
    expect(beforePrefetchFinishes).toEqual({ kind: 'aborted' })
  })

  it('serves existing demand stock without an expired-empty probe', async () => {
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    const resolve = createTagRecScopeResolver({ core })
    const { ladder, stream, queue } = setup({ resolve: () => resolve })
    queue.push(card('in-stock'))
    stream.exhausted = true
    stream.stopReason = 'empty'
    stream.retryAt = 0
    expect((await ladder.runLadder()).kind).toBe('items')
    expect(runPhase2Round).not.toHaveBeenCalled()
    expect(fetchArchiveRelated).not.toHaveBeenCalled()
  })
})

describe('local inventory and scoped recheck costs', () => {
  it('serves available stock immediately while an unrelated prefetch is still pending', async () => {
    const held = Promise.withResolvers<number>()
    const { ladder, state, queue } = setup()
    queue.push(card('already-ready'))
    state.digRunning = held.promise
    const done = vi.fn()
    const task = ladder.runLadder().then(done)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const early = done.mock.calls[0]?.[0]
    held.resolve(0)
    await task
    expect(early).toEqual({ kind: 'items', items: [] })
    expect(runPhase2Round).not.toHaveBeenCalled()
  })

  it('does not inspect seed stock for a recheck that cannot use archive-related', async () => {
    const poolItems = vi.fn(() => [card('seed')])
    const { ladder } = setup({ poolItems })
    await ladder.recheck(
      { key: undefined, pools: ['allV2'] },
      {
        tagTop: [],
        up: [],
        dig: [],
        archiveConsumers: [],
        blocked: [],
      },
    )
    expect(poolItems).not.toHaveBeenCalled()
  })
})
