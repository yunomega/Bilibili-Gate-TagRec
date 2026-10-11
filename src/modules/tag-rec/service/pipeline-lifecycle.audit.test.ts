import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { fetchTagTop } from '../api/endpoints'
import { fetchUpSearchPage } from '../api/up-search'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver } from '../model/filter-engine'
import { runTagRecRound, TagRecTidDryTracker } from './_pipeline'
import { TagRecDeferredCandidates } from './deferred-candidates'
import { runTagRecRecallRound, TagRecUpSearchPool, type UpSearchSource } from './up-search'
import type { TagRecItemExtend } from '$define'
import type { TagRecRecallPlan } from './recall-plan'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
vi.mock('../api/up-search', () => ({ fetchUpSearchPage: vi.fn() }))
vi.mock('../api/dry-tids-store', () => ({ isPersistedDryTid: () => false, persistDryTid: vi.fn() }))

const item = (bvid: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['A'], tagIds: [1] },
})
const topSource = { tid: 1, groupNames: ['A'], consumers: [{ key: 'A', name: 'A' }] }
const upSource: UpSearchSource = { tid: 1, mid: 7, keyword: 'alpha', groupNames: ['A'] }
const plan: TagRecRecallPlan = { tagTop: [topSource], up: [upSource], dig: [], archiveConsumers: [], blocked: [] }
const resolve = createTagRecScopeResolver({ core: createTagRecFactoryFilterCore() })
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.mocked(fetchTagTop)
    .mockReset()
    .mockResolvedValue([{ bvid: 'BV-top' }])
  vi.mocked(fetchUpSearchPage).mockReset().mockResolvedValue({ items: [], hasMore: false })
})
afterEach(() => vi.useRealTimers())

describe('recall commit lifecycle', () => {
  it.each(['abort', 'stale'] as const)('does not consume fetched inventory while the UP leg is %s', async (mode) => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof fetchUpSearchPage>>>()
    vi.mocked(fetchUpSearchPage).mockReturnValueOnce(held.promise)
    const signal = new AbortController()
    let current = true
    const seenBvids = new Set<string>()
    const stages = { filterStage: vi.fn((items: TagRecItemExtend[]) => items) }
    const pending = runTagRecRecallRound({
      sources: [topSource],
      resolve,
      plan,
      upPool: new TagRecUpSearchPool(),
      dryTids: new TagRecTidDryTracker(),
      seenBvids,
      signal: signal.signal,
      isCurrent: () => current,
      stages,
    })
    await flush()
    expect(fetchUpSearchPage).toHaveBeenCalledTimes(1)
    const prematureCommit = seenBvids.has('BV-top')
    if (mode === 'abort') signal.abort()
    else current = false
    held.resolve({ items: [], hasMore: false })
    const result = await pending
    expect(prematureCommit).toBe(false)
    expect(seenBvids.size).toBe(0)
    expect(result.items).toEqual([])
    expect(result.sourceStats).toEqual([])
    expect(stages.filterStage).not.toHaveBeenCalled()
  })

  it('keeps the successful top leg when the UP leg fails', async () => {
    vi.mocked(fetchUpSearchPage).mockRejectedValueOnce(new Error('offline'))
    const seenBvids = new Set<string>()
    const result = await runTagRecRecallRound({
      sources: [topSource],
      resolve,
      plan,
      upPool: new TagRecUpSearchPool(),
      dryTids: new TagRecTidDryTracker(),
      seenBvids,
    })
    expect(result.items.map((it) => it.bvid)).toEqual(['BV-top'])
    expect(seenBvids.has('BV-top')).toBe(true)
    expect(result.sourceStats[0]).toMatchObject({ ok: true, contributed: 1 })
  })

  it('does not consume fresh IDs when a pipeline stage throws', async () => {
    const seenBvids = new Set<string>()
    await expect(
      runTagRecRound({
        sources: [topSource],
        seenBvids,
        stages: {
          filterStage: () => {
            throw new Error('broken filter')
          },
        },
      }),
    ).rejects.toThrow('broken filter')
    expect(seenBvids.size).toBe(0)
  })

  it('does not even enqueue requests for a pre-aborted round', async () => {
    const controller = new AbortController()
    controller.abort()
    await runTagRecRound({ sources: [topSource], seenBvids: new Set(), signal: controller.signal })
    expect(fetchTagTop).not.toHaveBeenCalled()
  })
})

describe('UP pagination lifecycle', () => {
  it('serializes overlapping loads instead of spending budget twice on the same page', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof fetchUpSearchPage>>>()
    vi.mocked(fetchUpSearchPage)
      .mockReturnValueOnce(held.promise)
      .mockImplementationOnce((_m, _k, pn) => Promise.resolve({ items: [{ bvid: `BV-page-${pn}` }], hasMore: true }))
    const pool = new TagRecUpSearchPool()
    const a = pool.load([upSource])
    const b = pool.load([upSource])
    held.resolve({ items: [{ bvid: 'BV-page-1' }], hasMore: true })
    const pages = await Promise.all([a, b])
    expect(vi.mocked(fetchUpSearchPage).mock.calls.map((call) => call[2])).toEqual([1, 2])
    expect(pages.flat().map((it) => it.bvid)).toEqual(['BV-page-1', 'BV-page-2'])
    expect(pool.hasMore([upSource])).toBe(true)
  })

  it('ignores a stale call before it registers sources or spends budget', async () => {
    const pool = new TagRecUpSearchPool()
    await pool.load([upSource], undefined, () => false)
    expect(fetchUpSearchPage).not.toHaveBeenCalled()
    expect(pool.active).toBe(false)
    expect(pool.snapshot().budget).toBe(TagRecUpSearchPool.PAGE_BUDGET)
  })

  it('deduplicates repeated BV IDs within a successful page', async () => {
    vi.mocked(fetchUpSearchPage).mockResolvedValue({ items: [{ bvid: 'BV-one' }, { bvid: 'BV-one' }], hasMore: true })
    const pool = new TagRecUpSearchPool()
    expect((await pool.load([upSource])).map((it) => it.bvid)).toEqual(['BV-one'])
  })
})

describe('inventory snapshots and delivery', () => {
  it('does not resurrect delivered retouched candidates on the next record', () => {
    const candidates = new TagRecDeferredCandidates()
    const queued = item('BV-delivered')
    candidates.record([queued])
    candidates.mergeQueued(queued, item('BV-delivered'), (items) => items)
    candidates.delivered([queued])
    candidates.record([])
    expect(candidates.has('BV-delivered')).toBe(false)
  })

  it('clears deferred ranking work when restoring another trial', () => {
    const candidates = new TagRecDeferredCandidates()
    const snap = candidates.snapshot()
    const rank = vi.fn((items: TagRecItemExtend[]) => items)
    candidates.mergeQueued(item('BV-old'), item('BV-old'), rank)
    candidates.restore(snap)
    candidates.flushMerged()
    expect(rank).not.toHaveBeenCalled()
  })

  it('candidate snapshots are detached values in both directions', () => {
    const candidates = new TagRecDeferredCandidates()
    candidates.record([item('BV-copy')])
    const snap = candidates.snapshot()
    candidates.values()[0].title = 'mutated live value'
    expect(snap.items.get('BV-copy')?.title).toBe('BV-copy')
    candidates.restore(snap)
    candidates.values()[0].source.tagIds!.push(9)
    expect(snap.items.get('BV-copy')?.source.tagIds).toEqual([1])
  })

  it('an expired empty deep page rechecks the first page, not the old pool bottom', () => {
    vi.useFakeTimers()
    const dry = new TagRecTidDryTracker()
    dry.note([{ tid: 1, pn: 1, fetched: 1, contributed: 0, ok: true }])
    dry.note([{ tid: 1, pn: 1, fetched: 1, contributed: 0, ok: true }])
    dry.note([{ tid: 1, pn: 2, fetched: 0, contributed: 0, ok: true }])
    expect(dry.isDry(1)).toBe(true)
    vi.advanceTimersByTime(60 * 60_000)
    expect(dry.isDry(1)).toBe(false)
    expect(dry.pageOf(1)).toBe(1)
  })
})
