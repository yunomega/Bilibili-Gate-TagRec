import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCachedTagRecVideoEvidence, rememberTagRecVideoEvidence } from './video-evidence-store'
import { getPersistedVideoTags, persistVideoTags } from './video-tags-store'

vi.stubGlobal('GM', {
  getValue: vi.fn((_key, fallback) => Promise.resolve(fallback)),
  setValue: vi.fn(() => Promise.resolve()),
})
afterEach(() => vi.useRealTimers())

describe('authoritative video evidence audit', () => {
  it('an authoritative empty detail tag list replaces old tags rather than merging them back', async () => {
    vi.useFakeTimers()
    const bvid = 'audit-authoritative-empty'
    await persistVideoTags(bvid, [{ tag_id: 1, tag_name: 'removed' }])
    const fields = await rememberTagRecVideoEvidence(bvid, { View: { bvid }, Tags: [] })
    expect(fields?.ownTagIds).toEqual([])
    expect(await getPersistedVideoTags(bvid)).toEqual([])
  })

  it('a later detail response missing fields cannot downgrade complete cached evidence', async () => {
    const bvid = 'audit-no-downgrade'
    await rememberTagRecVideoEvidence(bvid, {
      View: { bvid, title: 'full', desc: 'd', duration: 60, tid_v2: 2064, pid_v2: 1008 },
      Tags: [{ tag_id: 1, tag_name: 'alpha' }],
    })
    await rememberTagRecVideoEvidence(bvid, { View: { bvid, tid_v2: 2090 } })
    const fields = getCachedTagRecVideoEvidence(bvid)
    expect(fields?.title).toBe('full')
    expect(fields?.desc).toBe('d')
    expect(fields?.ownTagIds).toEqual([1])
    expect(fields?.fieldEvidence?.desc).toBe('complete')
    // Present fields still update, and a changed leaf does not inherit the old parent.
    expect(fields?.tidv2).toBe(2090)
    expect(fields?.pid_v2).toBeUndefined()
  })

  it('a partial-id Tags array still replaces id evidence rather than keeping stale ids', async () => {
    const bvid = 'audit-partial-tags'
    await rememberTagRecVideoEvidence(bvid, {
      View: { bvid },
      Tags: [{ tag_id: 1, tag_name: 'alpha' }],
    })
    await rememberTagRecVideoEvidence(bvid, { View: { bvid }, Tags: [{ tag_name: 'noname' }] })
    const fields = getCachedTagRecVideoEvidence(bvid)
    expect(fields?.ownTagIds).toBeUndefined()
    expect(fields?.ownTagNames).toEqual(['noname'])
  })
})
