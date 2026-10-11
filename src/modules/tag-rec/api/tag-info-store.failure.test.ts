import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('optional GM persistence fail-open', () => {
  it('missing GM cannot prevent tag resolution from continuing without persistence', async () => {
    vi.stubGlobal('GM', undefined)
    const store = await import('./tag-info-store')
    expect(await store.getPersistedTagInfoById(7)).toBeUndefined()
    await expect(store.persistTagInfo({ id: 7, name: 'alpha' }, 'alpha')).resolves.toBeUndefined()
  })

  it('a synchronous read failure does not permanently poison initialization', async () => {
    const getValue = vi.fn(() => {
      throw new Error('manager unavailable')
    })
    vi.stubGlobal('GM', { getValue })
    const store = await import('./tag-info-store')
    expect(await store.getPersistedTagInfoById(7)).toBeUndefined()
    vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve([['i:7', { id: 7, name: 'alpha' }]])) })
    expect(await store.getPersistedTagInfoById(7)).toEqual({ id: 7, name: 'alpha' })
  })

  it('malformed stored rows are treated as a cache miss rather than a fatal request error', async () => {
    vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve('corrupt')) })
    const store = await import('./tag-info-store')
    expect(await store.getPersistedTagInfoByName('alpha')).toBeUndefined()
  })

  it.each(['synchronous', 'asynchronous'])('%s write failures do not discard the useful session data', async (mode) => {
    vi.useFakeTimers()
    const setValue = vi.fn(() => {
      if (mode === 'synchronous') throw new Error('read-only')
      return Promise.reject(new Error('quota'))
    })
    vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve([])), setValue })
    const store = await import('./tag-info-store')
    await store.persistTagInfo({ id: 7, name: 'alpha' }, 'alpha')
    await vi.advanceTimersByTimeAsync(1_001)
    expect(setValue).toHaveBeenCalledOnce()
    expect(await store.getPersistedTagInfoById(7)).toEqual({ id: 7, name: 'alpha' })
  })
})
