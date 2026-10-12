import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { settings } from '$modules/settings'
import { fetchAllV2Search, fetchArchiveRelated, fetchTagTop, fetchVideoTagNames } from '../api/endpoints'
import { fetchUpSearchPage } from '../api/up-search'
import { createTagRecFactoryFilterCore, TAG_REC_ALL_POOL_KEYS } from '../model/filter-engine'
import { favorites, favoritesL1, sediment, seen } from '../store'
import { tagRecCustomSession, tagRecFavSession, tagRecSharedSession } from '../store/session'
import { resetTagRecCustomSharedState, TagRecCustomService } from './tag-rec-custom'
import { resetTagRecFavSharedState, TagRecFavService } from './tag-rec-fav'
import type { TagRecItemExtend } from '$define'
import type { SedimentNode } from '../model/sediment'
import type { TagGroup } from '../model/types'
import type { TagRecFallbackLadder } from './fallback-ladder'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_CLS_TAB_BAR: 'x' }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('../ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/up-search', () => ({ fetchUpSearchPage: vi.fn(() => Promise.resolve({ items: [], hasMore: false })) }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, lastRecoveredAt: 0 },
  isRiskControlError: () => false,
}))
vi.mock('../api/dry-tids-store', () => ({
  isPersistedDryTid: () => false,
  persistDryTid: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve(undefined)) }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return {
    settings: {
      tagRec: {
        filter: createTagRecFactoryFilterCore(),
        k: 3,
        diversityGuard: false,
        ladder: { mode: 'fixed', autoDigMax: 1 },
      },
    },
  }
})
vi.mock('../store', async () => {
  const { sedimentNoteDig, sedimentMerge } = await import('../model/sediment')
  const map = new Map<string, SedimentNode>()
  const seenSet = new Set<string>()
  return {
    sediment: {
      map,
      merge: (key: string, cliques: Parameters<typeof sedimentMerge>[2]) => sedimentMerge(map, key, cliques),
      noteDig: (key: string, dig: Parameters<typeof sedimentNoteDig>[2]) => sedimentNoteDig(map, key, dig),
    },
    seen: { set: seenSet, clear: () => seenSet.clear(), has: (bvid: string) => seenSet.has(bvid) },
    favorites: { list: [] },
    favoritesL1: { list: [] },
    themes: { list: [] },
    viewScope: { viewedL1Ids: () => undefined, viewedGroupIds: () => undefined },
  }
})
vi.mock('./negative-slice', () => ({
  ensureTagRecNegativePools: vi.fn(() => Promise.resolve(undefined)),
  tagRecNegativePools: () => new Map(),
  dropTagRecStrictNegativeHits: vi.fn((items: unknown[]) => Promise.resolve({ items, dropped: 0, unchecked: 0 })),
}))

const group = (id = 'A'): TagGroup => ({
  id,
  name: id,
  l1Id: 'P',
  weight: 1,
  enabled: true,
  addedAt: 0,
  tag_ids: [{ id: 7, name: 'alpha' }],
})
const signal = () => new AbortController().signal
const services = [
  { name: '指定标签', Service: TagRecCustomService, session: tagRecCustomSession },
  { name: '标签收藏', Service: TagRecFavService, session: tagRecFavSession },
]
const ladderOf = (svc: TagRecCustomService | TagRecFavService) =>
  (svc as unknown as { ladder: TagRecFallbackLadder }).ladder

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
  vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
  vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
  vi.mocked(fetchUpSearchPage).mockReset().mockResolvedValue({ items: [], hasMore: false })
  favorites.list.length = 0
  favoritesL1.list.length = 0
  sediment.map.clear()
  seen.clear()
  tagRecFavSession.bypassSeen = false
  tagRecCustomSession.bypassSeen = false
  tagRecSharedSession.recoveryRevision = 0
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.selectedGroupIds = ['A']
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.draftGroup = undefined
  resetTagRecCustomSharedState()
  resetTagRecFavSharedState()
  settings.tagRec.filter = { ...createTagRecFactoryFilterCore(), enabled: false, activePreset: '', presets: [] }
  settings.tagRec.ladder.mode = 'fixed'
  settings.tagRec.ladder.autoDigMax = 1
  favoritesL1.list.push({ id: 'P', name: 'P', enabled: true, weight: 1, addedAt: 0 })
})

describe.each(services)('$name pool gate integration', ({ Service, session }) => {
  it.each(Array.from({ length: 16 }, (_, mask) => [mask]))(
    'A01/A04/A06/A08: mask %i gates first load, automatic prefetch and manual continuation',
    async (mask) => {
      const g = group()
      g.overrides = {
        poolsEnabled: Object.fromEntries(TAG_REC_ALL_POOL_KEYS.map((pool, i) => [pool, !!(mask & (1 << i))])),
      }
      favorites.list.push(g)
      const svc = new Service()
      const ladder = ladderOf(svc)
      await svc.fetchMore(signal())
      await ladder.digRunning
      const searched = !!(mask & 6)
      expect(fetchTagTop).toHaveBeenCalledTimes(mask & 1 ? 1 : 0)
      expect(fetchAllV2Search).toHaveBeenCalledTimes(searched ? 3 : 0)
      expect(fetchArchiveRelated).not.toHaveBeenCalled()
      expect(fetchVideoTagNames).not.toHaveBeenCalled()
      expect(ladder.autoDigs).toBe(searched ? 1 : 0)
      expect(g.enabled).toBe(true)
      expect(g.weight).toBe(1)
      if (!mask || mask === 8) expect(session.hardBottom).toBe(false)
      await svc.digMore()
      expect(fetchAllV2Search).toHaveBeenCalledTimes(searched ? 3 : 0)
      expect(fetchTagTop).toHaveBeenCalledTimes(mask & 1 ? 1 : 0)
    },
  )

  it('A02/A03: shared tid has one request, retains only B and keeps per-consumer query evidence', async () => {
    const a = group()
    const b = group('B')
    a.overrides = { poolsEnabled: { tagTop: false, allV2: false, allV2Related: false, archiveRelated: false } }
    b.tag_ids[0].name = 'beta'
    b.overrides = { poolsEnabled: { allV2: false, allV2Related: false, archiveRelated: false } }
    favorites.list.push(a, b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    vi.mocked(fetchTagTop).mockResolvedValue(
      Array.from({ length: 32 }, (_, i) => ({ bvid: `top-${i}`, title: 'video' })),
    )
    const svc = new Service()
    const items = await svc.fetchMore(signal())
    expect(fetchTagTop).toHaveBeenCalledTimes(1)
    expect(items?.filter((i) => i.api === EApiType.TagRec).every((i) => i.source.groupIds?.join(',') === 'B')).toBe(
      true,
    )
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(ladderOf(svc).autoDigs).toBe(0)
  })

  it('A09: disabled UP route never falls back to ordinary search; another group supplies normally', async () => {
    settings.tagRec.filter.enabled = true
    const a = group()
    a.overrides = {
      negative: { upAllow: { enabled: true, list: [{ mid: 123, name: 'UP' }] } },
      poolsEnabled: { allV2: false, allV2Related: true },
    }
    const b = group('B')
    b.tag_ids = [{ id: 8, name: 'beta' }]
    b.overrides = { poolsEnabled: { allV2: false, allV2Related: false, archiveRelated: false } }
    favorites.list.push(a, b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    const svc = new Service()
    await svc.fetchMore(signal())
    await ladderOf(svc).digRunning
    expect(fetchUpSearchPage).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(vi.mocked(fetchTagTop).mock.calls.map((c) => c[0])).toEqual([8])
  })

  it('D04/A09: UP supply covers a full 12-word list under the existing three-page batches', async () => {
    settings.tagRec.filter.enabled = true
    const a = group()
    a.tag_ids = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `up-word-${i}` }))
    a.overrides = { negative: { upAllow: { enabled: true, list: [{ mid: 123, name: 'UP' }] } } }
    favorites.list.push(a)
    const svc = new Service()
    for (let round = 0; round < 12; round++) {
      if (session.digPending) await svc.digMore()
      await svc.fetchMore(signal())
    }
    expect(new Set(vi.mocked(fetchUpSearchPage).mock.calls.map((c) => c[1])).size).toBe(12)
    expect(vi.mocked(fetchUpSearchPage).mock.calls.every((c) => c[2] === 1)).toBe(true)
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchAllV2Search).not.toHaveBeenCalled()
    expect(ladderOf(svc).autoDigs).toBe(0)
  })

  it('A10/A11/D11: source-only close/reopen preserves pages and paid budget and recovers dormant raw without replay', async () => {
    const a = group()
    a.overrides = { poolsEnabled: { tagTop: false, allV2: true, allV2Related: false, archiveRelated: false } }
    favorites.list.push(a)
    vi.mocked(fetchAllV2Search).mockImplementation((_kw, options) =>
      Promise.resolve([{ bvid: `related-${options?.page}`, title: 'other', tag: 'other' }]),
    )
    const svc = new Service()
    await svc.fetchMore(signal())
    await ladderOf(svc).digRunning
    const ladder = ladderOf(svc)
    const next = ladder.streams.get('alpha')!.nextPage
    expect(ladder.autoDigs).toBe(1)
    expect(ladder.heap).toHaveLength(0)
    a.overrides.poolsEnabled = { tagTop: false, allV2: false, allV2Related: false, archiveRelated: false }
    const closed = new Service()
    await closed.fetchMore(signal())
    expect(ladderOf(closed).autoDigs).toBe(1)
    a.overrides.poolsEnabled.allV2Related = true
    const reopened = new Service()
    expect(ladderOf(reopened).streams.get('alpha')!.nextPage).toBe(next)
    expect(ladderOf(reopened).autoDigs).toBe(1)
    const recovered = await reopened.loadMore(signal())
    expect(
      recovered
        ?.filter((i) => i.api === EApiType.TagRec)
        .map((i) => i.bvid)
        .sort(),
    ).toEqual(['related-1', 'related-2', 'related-3'])
    expect(fetchAllV2Search).toHaveBeenCalledTimes(3)
    expect(fetchTagTop).not.toHaveBeenCalled()
    tagRecSharedSession.recoveryRevision++
    expect(ladderOf(new Service()).autoDigs).toBe(1)
  })

  it('D02: hot A stock never suppresses a cold B search-only supply route', async () => {
    const a = group()
    const b = group('B')
    b.tag_ids = [{ id: 8, name: 'beta' }]
    a.overrides = { poolsEnabled: { allV2: false, allV2Related: false, archiveRelated: false } }
    b.overrides = { poolsEnabled: { tagTop: false, allV2: false, allV2Related: true, archiveRelated: false } }
    favorites.list.push(a, b)
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    const svc = new Service()
    svc.qs.bufferQueue.push(
      ...Array.from({ length: 20 }, (_, i): TagRecItemExtend => ({
        api: EApiType.TagRec,
        uniqId: `A-${i}`,
        bvid: `A-${i}`,
        title: 'alpha',
        pic: '',
        stat: {},
        source: { via: 'tag-top', groupIds: ['A'], groupNames: ['A'] },
      })),
    )
    vi.mocked(fetchAllV2Search).mockResolvedValue([{ bvid: 'B-new', title: 'other', tag: 'other' }])
    const supplied = await svc.fetchMore(signal())
    await ladderOf(svc).digRunning
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(vi.mocked(fetchAllV2Search).mock.calls.map((c) => c[0])).toEqual(['beta', 'beta', 'beta'])
    const raw =
      ladderOf(svc).heap.find((item) => item.bvid === 'B-new') ??
      [...(supplied ?? []), ...svc.qs.bufferQueue].find((item) => item.api === EApiType.TagRec && item.bvid === 'B-new')
    expect(raw).toBeDefined()
    expect(
      raw && raw.api === EApiType.TagRec && raw.activeSourceClaims?.every((claim) => claim.groupIds?.join(',') === 'B'),
    ).toBe(true)
  })

  it('A12: close during an awaited top response drops seen/cursor/output and preserves no fake empty state', async () => {
    const a = group()
    a.overrides = { poolsEnabled: { allV2: false, allV2Related: false, archiveRelated: false } }
    favorites.list.push(a)
    let finish!: (items: { bvid: string }[]) => void
    vi.mocked(fetchTagTop).mockImplementation(() => {
      const response = Promise.withResolvers<{ bvid: string }[]>()
      finish = response.resolve
      return response.promise
    })
    const svc = new Service()
    const pending = svc.fetchMore(signal())
    await vi.waitFor(() => expect(fetchTagTop).toHaveBeenCalledTimes(1))
    a.overrides.poolsEnabled!.tagTop = false
    const current = new Service()
    finish([{ bvid: 'late' }])
    await pending
    expect(current.qs.bufferQueue).toHaveLength(0)
    expect(ladderOf(current).autoDigs).toBe(0)
    expect(sediment.map.get('alpha')?.dig).toBeUndefined()
    a.overrides.poolsEnabled!.tagTop = true
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'late' }])
    const returned = await new Service().fetchMore(signal())
    expect(returned?.some((i) => i.api === EApiType.TagRec && i.bvid === 'late')).toBe(true)
  })

  it('A13: restored already-delivered cache is checked before display and never enters deferred candidates', async () => {
    const a = group()
    a.overrides = { poolsEnabled: { allV2: false, allV2Related: false, archiveRelated: false } }
    favorites.list.push(a)
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'delivered', title: 'alpha' }])
    const svc = new Service()
    await svc.loadMore(signal())
    a.overrides.poolsEnabled!.tagTop = false
    svc.restore()
    expect(svc.qs.bufferQueue.filter((i) => i.api === EApiType.TagRec)).toHaveLength(0)
    a.overrides.poolsEnabled!.tagTop = true
    const restored = new Service()
    expect(restored.qs.bufferQueue.filter((i) => i.api === EApiType.TagRec)).toHaveLength(0)
    expect(await restored.recheck({ key: { id: 'A' }, pools: ['tagTop'] })).toMatchObject({ added: 0 })
    expect(seen.set.size).toBe(0) // 服务交付不伪造曝光事实。
  })
})
