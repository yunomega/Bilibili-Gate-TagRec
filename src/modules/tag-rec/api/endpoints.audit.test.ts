import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  anonGetJson,
  fetchAllV2Search,
  fetchArchiveRelated,
  fetchSuggest,
  fetchTagTop,
  fetchVideoTags,
  hasCompleteTagIds,
  type ViewDetailTagItem,
} from './endpoints'
import { gmAnonGet } from './request'
import { getPersistedVideoTags } from './video-tags-store'

// Real shared caches; only transport, fingerprinting and persistence are mocked.
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$request', () => ({ isWebApiSuccess: (j: { code?: number }) => j?.code === 0 }))
vi.mock('./request', () => ({ gmAnonGet: vi.fn(() => Promise.resolve({ status: 200, data: { code: 0 } })) }))
vi.mock('./fingerprint', () => ({
  ensureTagRecFingerprint: vi.fn(() => Promise.resolve()),
  fingerprintCookieHeader: vi.fn(() => ''),
  hasTagRecFingerprint: vi.fn(() => false),
  getTagRecFingerprintStats: vi.fn(() => ({ has: false, disabled: false })),
}))
vi.mock('./backoff', async () => {
  const { pLimit } = await import('promise.map')
  return {
    tagRecBackoff: {
      waitTurn: vi.fn(() => Promise.resolve()),
      withRecoveryProbe: <T>(request: () => Promise<T>) => request(),
      onRiskControl: vi.fn(),
      onSuccess: vi.fn(),
      consecutiveHits: 0,
      isEngaged: false,
      lastRecoveredAt: 0,
      recentlyRecovered: vi.fn(() => false),
    },
    tagRecLimit: pLimit(4),
    allV2Limit: <T>(run: () => Promise<T>) => run(),
    isRiskControlError: vi.fn(() => false),
    isRiskControlResponse: vi.fn(() => false),
    RiskControlError: class RiskControlError extends Error {},
  }
})
vi.mock('./tag-info-store', () => ({
  getPersistedTagInfoById: vi.fn(),
  getPersistedTagInfoByName: vi.fn(),
  persistTagInfo: vi.fn(),
}))
vi.mock('./video-tags-store', () => ({
  evictPersistedVideoTags: vi.fn(),
  getPersistedVideoTags: vi.fn(),
  persistVideoTags: vi.fn(),
}))
vi.mock('./partition-cache', () => ({
  getCachedTagRecPartition: vi.fn(() => undefined),
  rememberTagRecPartition: vi.fn(),
}))
vi.mock('./video-evidence-store', () => ({
  getCachedTagRecVideoEvidence: vi.fn(() => undefined),
  rememberTagRecVideoEvidence: vi.fn((_bvid: string, data: { View?: unknown }) => data?.View),
}))

afterEach(() => vi.useRealTimers())
beforeEach(() => vi.mocked(gmAnonGet).mockReset())
const search = { status: 200, data: { code: 0, data: { result: [] } } }

describe('endpoint correctness and reuse audit', () => {
  it('reuses successful search pages for 60 seconds but retries transient failures after 3 seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(gmAnonGet).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(search)
    await expect(fetchAllV2Search('audit-retry')).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(3_001)
    expect(await fetchAllV2Search('audit-retry')).toEqual([])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(await fetchAllV2Search('audit-retry')).toEqual([])
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await fetchAllV2Search('audit-retry')
    expect(gmAnonGet).toHaveBeenCalledTimes(3)
  })

  it('deduplicates suggestions across concurrent and immediate repeated consumers', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({
      status: 200,
      data: { code: 0, data: { result: { tag: [{ value: 'alpha' }] } } },
    })
    expect(await Promise.all([fetchSuggest('audit-suggest'), fetchSuggest('audit-suggest')])).toEqual([
      ['alpha'],
      ['alpha'],
    ])
    expect(await fetchSuggest('audit-suggest')).toEqual(['alpha'])
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null, {}])(
    'does not turn a malformed successful pool payload into exhaustion: %j',
    async (data) => {
      vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0, data } })
      await expect(fetchTagTop(9001)).rejects.toThrow()
      await expect(fetchArchiveRelated('audit-malformed')).rejects.toThrow()
    },
  )

  it('does not permanently cache missing interactive tag data as an authoritative empty list', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0 } })
    expect(await fetchVideoTags('audit-missing-tags', { interactive: true })).toBeUndefined()
  })

  it.each([0, -1, NaN, Infinity, 1.5, null, '7'])(
    'does not accept invalid tag IDs as complete evidence: %j',
    (tag_id) => {
      const invalid: unknown = { tag_id }
      expect(hasCompleteTagIds([invalid as ViewDetailTagItem])).toBe(false)
    },
  )

  it('HTTP failure cannot be accepted solely because the body says code zero', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 503, data: { code: 0, data: [] } })
    await expect(anonGetJson('/audit', {})).rejects.toThrow()
  })
})

describe('authoritative cache updates across consumers', () => {
  afterEach(() => vi.mocked(getPersistedVideoTags).mockReset())

  it('a newer authoritative empty list supersedes an older successful session entry', async () => {
    const oldTags = [{ tag_id: 1, tag_name: 'removed' }]
    vi.mocked(getPersistedVideoTags).mockResolvedValue(undefined)
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0, data: oldTags } })
    expect(await fetchVideoTags('audit-authority', { interactive: true })).toEqual(oldTags)
    // Another consumer has completed /view/detail and written its authoritative list.
    vi.mocked(getPersistedVideoTags).mockResolvedValue([])
    expect(await fetchVideoTags('audit-authority', { interactive: true })).toEqual([])
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('new partial observations cannot be hidden behind an older complete session entry', async () => {
    vi.mocked(getPersistedVideoTags).mockResolvedValue(undefined)
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0, data: [{ tag_id: 1, tag_name: 'old' }] } })
    await fetchVideoTags('audit-partial-update', { interactive: true })
    vi.mocked(getPersistedVideoTags).mockResolvedValue([{ tag_name: 'new' }])
    const tags = [{ tag_id: 2, tag_name: 'new' }]
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0, data: tags } })
    expect(await fetchVideoTags('audit-partial-update', { interactive: true })).toEqual(tags)
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
  })

  it('a malformed video block cannot become a falsely exhausted search page', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({
      status: 200,
      data: { code: 0, data: { result: [{ result_type: 'video' }] } },
    })
    await expect(fetchAllV2Search('audit-incomplete-video-block')).rejects.toThrow()
  })
})
