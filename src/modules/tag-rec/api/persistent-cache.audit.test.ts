import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getValue: vi.fn(), setValue: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.getValue.mockReset().mockResolvedValue([])
  mocks.setValue.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('GM', mocks)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('persistent cache no-op write coalescing', () => {
  it('does not serialize the whole video-tag pool again for identical observations', async () => {
    const { persistVideoTags, getPersistedVideoTags } = await import('./video-tags-store')
    const tags = [
      { tag_id: 1, tag_name: 'A' },
      { tag_id: 2, tag_name: 'B' },
    ]
    await persistVideoTags('BV-audit', tags)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.setValue).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      await persistVideoTags('BV-audit', [{ tag_name: 'A' }])
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(mocks.setValue).toHaveBeenCalledTimes(1)
    expect(await getPersistedVideoTags('BV-audit')).toEqual(tags)
    await persistVideoTags('BV-audit', [], { partial: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.setValue).toHaveBeenCalledTimes(2)
    expect(await getPersistedVideoTags('BV-audit')).toEqual([])
  })

  it('promotes identical tag-info records without rewriting storage, but persists changed counts', async () => {
    const { persistTagInfo, getPersistedTagInfoById } = await import('./tag-info-store')
    const info = { id: 1, name: 'A', use: 10, atten: 2 }
    await persistTagInfo(info, 'a')
    await vi.advanceTimersByTimeAsync(1_000)
    for (let i = 0; i < 20; i++) {
      await persistTagInfo({ ...info }, 'a')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(mocks.setValue).toHaveBeenCalledTimes(1)
    await persistTagInfo({ ...info, use: 11 }, 'a')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.setValue).toHaveBeenCalledTimes(2)
    expect((await getPersistedTagInfoById(1))?.use).toBe(11)
  })
})

describe('persistent cache hydration boundaries', () => {
  it('drops an invalid video-tag row as unknown, not as an authoritative empty list', async () => {
    mocks.getValue.mockResolvedValue([
      ['bad-null', null],
      ['bad-entry', [null]],
      null,
      ['bad-type', [{ tag_id: '1', tag_name: 'A' }]],
      ['good', [{ tag_id: 1, tag_name: 'A', jump_url: 'unused' }]],
      ['empty', []],
    ])
    const { getPersistedVideoTags } = await import('./video-tags-store')
    for (const key of ['bad-null', 'bad-entry', 'bad-type']) expect(await getPersistedVideoTags(key)).toBeUndefined()
    expect(await getPersistedVideoTags('good')).toEqual([{ tag_id: 1, tag_name: 'A' }])
    expect(await getPersistedVideoTags('empty')).toEqual([])
  })

  it('caps hydrated video-tag rows before any new network result is written', async () => {
    mocks.getValue.mockResolvedValue(Array.from({ length: 2_005 }, (_, i) => [`BV-${i}`, [{ tag_name: 'A' }]]))
    const { getPersistedVideoTags } = await import('./video-tags-store')
    expect(await getPersistedVideoTags('BV-0')).toBeUndefined()
    expect(await getPersistedVideoTags('BV-2004')).toEqual([{ tag_name: 'A' }])
  })

  it('isolates corrupt tag-info rows instead of discarding other reusable mappings', async () => {
    mocks.getValue.mockResolvedValue([
      null,
      ['i:2', { id: '2', name: 'bad' }],
      ['i:3', { id: 3, name: 123 }],
      ['i:1', { id: 1, name: 'A' }],
      ['n:a', { id: 1, name: 'A' }],
    ])
    const { getPersistedTagInfoById, getPersistedTagInfoByName } = await import('./tag-info-store')
    expect(await getPersistedTagInfoById(2)).toBeUndefined()
    expect(await getPersistedTagInfoById(3)).toBeUndefined()
    expect(await getPersistedTagInfoById(1)).toEqual({ id: 1, name: 'A' })
    expect(await getPersistedTagInfoByName('a')).toEqual({ id: 1, name: 'A' })
  })

  it('caps hydrated tag-info rows before any new mapping is written', async () => {
    mocks.getValue.mockResolvedValue(Array.from({ length: 2_005 }, (_, i) => [`i:${i + 1}`, { id: i + 1, name: 'A' }]))
    const { getPersistedTagInfoById } = await import('./tag-info-store')
    expect(await getPersistedTagInfoById(1)).toBeUndefined()
    expect(await getPersistedTagInfoById(2_005)).toEqual({ id: 2_005, name: 'A' })
  })
})
