import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpSearchGate, UpSearchPausedError } from './up-search-gate'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('UP search queue lifecycle', () => {
  it.each([false, true])('cancellation settles behind an unresolved request (already aborted: %s)', async (already) => {
    const gate = new UpSearchGate()
    const held = Promise.withResolvers<void>()
    const first = gate.run(() => held.promise)
    const controller = new AbortController()
    if (already) controller.abort()
    const request = vi.fn(() => Promise.resolve())
    let cancelled: unknown
    const second = gate.run(request, controller.signal).catch((error: unknown) => {
      cancelled = error
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelled).toMatchObject({ name: 'AbortError' })
      expect(request).not.toHaveBeenCalled()
    } finally {
      held.resolve()
      await first
      await second
    }
  })

  it('clears the active pacing timer and abort listener as soon as its consumer leaves', async () => {
    const gate = new UpSearchGate()
    await gate.run(() => Promise.resolve())
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const request = vi.fn(() => Promise.resolve())
    const pending = gate.run(request, controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(request).not.toHaveBeenCalled()
  })

  it('rechecks the pacing deadline after an early timer or wall-clock adjustment', async () => {
    let now = 1_000
    let sleeps = 0
    const gate = new UpSearchGate(
      () => now,
      (ms) => {
        now += ++sleeps === 1 ? ms - 500 : ms
        return Promise.resolve()
      },
    )
    const starts: number[] = []
    const request = () => {
      starts.push(now)
      return Promise.resolve()
    }
    await gate.run(request)
    await gate.run(request)
    expect(starts).toEqual([1_000, 3_000])
    expect(sleeps).toBe(2)
  })

  it('keeps a longer server cooldown even when pause is called again with a shorter one', async () => {
    const gate = new UpSearchGate()
    expect(gate.pause(900_000).retryAt).toBe(901_000)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(gate.pause(1_000).retryAt).toBe(901_000)
    const request = vi.fn(() => Promise.resolve())
    await expect(gate.run(request)).rejects.toBeInstanceOf(UpSearchPausedError)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600_000)
    await gate.run(request)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('refuses new work immediately while paused, even if another request is still running', async () => {
    const gate = new UpSearchGate()
    const held = Promise.withResolvers<void>()
    const first = gate.run(() => held.promise)
    await vi.advanceTimersByTimeAsync(0)
    gate.pause()
    let paused: unknown
    const second = gate
      .run(() => Promise.resolve())
      .catch((error: unknown) => {
        paused = error
      })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(paused).toBeInstanceOf(UpSearchPausedError)
    } finally {
      held.resolve()
      await first
      await second
    }
  })
})
