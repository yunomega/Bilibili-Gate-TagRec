import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import {
  runTagRecFilter,
  runTagRecScoreStage,
  type TagRecFilterCore,
  type TagRecScopeResolve,
} from '../model/filter-engine'
import { refilterTagRecStock } from './refilter-stock'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagRecDeferredCandidates } from './deferred-candidates'

vi.mock('../model/filter-engine', () => ({ runTagRecFilter: vi.fn(), runTagRecScoreStage: vi.fn() }))
const opaqueCore: unknown = {} // Stage bodies are mocked; only orchestration is under test.
const core = opaqueCore as TagRecFilterCore
const resolve = vi.fn() as unknown as TagRecScopeResolve
const item = (): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'a',
  bvid: 'a',
  title: 'a',
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: [] },
})
const candidates = () =>
  ({
    needsRefilter: true,
    values: () => [],
    absorbRetouched: vi.fn(),
    record: vi.fn(),
    flushMerged: vi.fn(),
  }) as unknown as TagRecDeferredCandidates
beforeEach(() => {
  const filter = (items: TagRecItemExtend[]) => ({ items, stats: { dropped: 0, byDim: {}, degraded: false } })
  vi.mocked(runTagRecFilter).mockImplementation(filter)
  const score = (items: TagRecItemExtend[]) => ({ items, deferred: { group: 0, up: 0 } })
  vi.mocked(runTagRecScoreStage).mockImplementation(score)
})

describe('stock refilter transaction boundaries', () => {
  it.each(['filter', 'score'])('retains the retry flag and inventory after a %s stage throws', (stage) => {
    const queue: RecItemTypeOrSeparator[] = [item()]
    const held = candidates()
    const fail = () => {
      throw new Error('stage failed')
    }
    if (stage === 'filter') vi.mocked(runTagRecFilter).mockImplementationOnce(fail)
    else vi.mocked(runTagRecScoreStage).mockImplementationOnce(fail)
    expect(() => refilterTagRecStock(queue, core, resolve, { candidates: held })).toThrow('stage failed')
    expect(held.needsRefilter).toBe(true)
    expect(queue).toHaveLength(1)
    refilterTagRecStock(queue, core, resolve, { candidates: held })
    expect(held.needsRefilter).toBe(false)
  })

  it('deduplicates repeated object references without inserting undefined into the queue', () => {
    const card = item()
    const separator = { api: EApiType.Separator as const, uniqId: 'separator', content: 'end' }
    const queue: RecItemTypeOrSeparator[] = [card, separator, card]
    refilterTagRecStock(queue, core, resolve)
    expect(queue).toEqual([card, separator])
  })
})
