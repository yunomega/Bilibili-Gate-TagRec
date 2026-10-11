import { describe, expect, it, vi } from 'vitest'
import { SessionFetchCache } from './session-fetch-cache'

describe('cache lifecycle audit', () => {
  it('starts the success TTL when the response settles, not while waiting in a queue', async () => {
    let now = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 100, maxAgeMs: 100, now: () => now })
    const pending = Promise.withResolvers<number>()
    const load = vi.fn(() => pending.promise)
    const result = cache.fetch('a', load)
    await Promise.resolve()
    now = 10_000
    pending.resolve(1)
    await result
    now += 99
    expect(await cache.fetch('a', load)).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps a full failure dedupe window after a slow failure', async () => {
    let now = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 100, now: () => now })
    const pending = Promise.withResolvers<number>()
    const failed = cache.fetch('a', () => pending.promise).catch((error: unknown) => error)
    await Promise.resolve()
    now = 10_000
    pending.reject(new Error('offline'))
    await failed
    now += 99
    const retry = vi.fn(() => Promise.resolve(2))
    await expect(cache.fetch('a', retry)).rejects.toThrow('offline')
    expect(retry).not.toHaveBeenCalled()
    now++
    expect(await cache.fetch('a', retry)).toBe(2)
  })

  it('promotes refreshed expired entries to the most recently used position', async () => {
    let now = 0
    let calls = 0
    const load = () => Promise.resolve(++calls)
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 0, maxAgeMs: 100, maxEntries: 2, now: () => now })
    await cache.fetch('a', load)
    now = 50
    await cache.fetch('b', load)
    now = 101
    expect(await cache.fetch('a', load)).toBe(3)
    await cache.fetch('c', load)
    expect(await cache.fetch('a', load)).toBe(3)
  })

  it('does not call a loader abandoned before its first microtask', async () => {
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 100 })
    const load = vi.fn(() => Promise.resolve(1))
    const controller = new AbortController()
    const result = cache.fetch('a', load, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(load).not.toHaveBeenCalled()
    expect(cache.size).toBe(0)
  })

  it('does not memoize an aborted loader as a network failure', async () => {
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 60_000 })
    await expect(cache.fetch('a', () => Promise.reject(new DOMException('Aborted', 'AbortError')))).rejects.toThrow()
    expect(await cache.fetch('a', () => Promise.resolve(2))).toBe(2)
  })

  it('cancels an invalidated entry when its final waiter leaves without deleting its replacement', async () => {
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 100 })
    const pending = Promise.withResolvers<number>()
    let underlying: AbortSignal | undefined
    const controller = new AbortController()
    const old = cache
      .fetch(
        'a',
        (signal) => {
          underlying = signal
          return pending.promise
        },
        controller.signal,
      )
      .catch((error: unknown) => error)
    await Promise.resolve()
    cache.invalidate('a')
    expect(await cache.fetch('a', () => Promise.resolve(2))).toBe(2)
    controller.abort()
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(underlying?.aborted).toBe(true)
    expect(await cache.fetch('a', () => Promise.resolve(3))).toBe(2)
    pending.resolve(1)
  })

  it('a throwing cache predicate cannot leave a permanently pending entry', async () => {
    let now = 0
    const cache = new SessionFetchCache<string, number>({
      dedupeMs: 100,
      now: () => now,
      isCacheable: (value) => {
        if (value === 1) throw new Error('invalid value')
        return true
      },
    })
    await expect(cache.fetch('a', () => Promise.resolve(1))).rejects.toThrow('invalid value')
    now = 101
    expect(await cache.fetch('a', () => Promise.resolve(2))).toBe(2)
  })
})

describe('explicit cache refresh', () => {
  it('refreshes settled data while preserving an in-flight single flight', async () => {
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 100 })
    const held = Promise.withResolvers<number>()
    const loader = vi.fn(() => held.promise)
    const first = cache.fetch('a', loader)
    expect(cache.invalidateSettled('a')).toBe(false)
    const second = cache.fetch('a', loader)
    held.resolve(1)
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(loader).toHaveBeenCalledOnce()
    expect(cache.invalidateSettled('a')).toBe(true)
    expect(await cache.fetch('a', () => Promise.resolve(2))).toBe(2)
    expect(cache.invalidateSettled('missing')).toBe(false)
  })
})
