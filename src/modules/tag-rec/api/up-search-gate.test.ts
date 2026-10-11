import { describe, expect, it } from 'vitest'
import { UpSearchGate, UpSearchPausedError } from './up-search-gate'

describe('UP 投稿请求限速与暂停', () => {
  it('串行执行并在请求开始之间留至少 2 秒，不并发突发', async () => {
    let now = 1_000
    const gate = new UpSearchGate(
      () => now,
      (ms) => {
        now += ms
        return Promise.resolve()
      },
    )
    const held = Promise.withResolvers<void>()
    const starts: number[] = []
    const first = gate.run(() => {
      starts.push(now)
      return held.promise
    })
    const second = gate.run(() => {
      starts.push(now)
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(starts).toEqual([1_000])
    held.resolve()
    await Promise.all([first, second])
    expect(starts).toEqual([1_000, 3_000])
  })

  it('命中后立即拒绝已排队请求，冷却结束才允许再次发送', async () => {
    let now = 1_000
    const gate = new UpSearchGate(() => now)
    let calls = 0
    const blocked = gate.run(() => {
      calls++
      return Promise.reject(gate.pause())
    })
    const queued = gate.run(() => {
      calls++
      return Promise.resolve()
    })
    await expect(blocked).rejects.toBeInstanceOf(UpSearchPausedError)
    await expect(queued).rejects.toBeInstanceOf(UpSearchPausedError)
    expect(calls).toBe(1)
    now += UpSearchGate.COOLDOWN_MS
    await gate.run(() => {
      calls++
      return Promise.resolve()
    })
    expect(calls).toBe(2)
  })

  it('切换查询时取消排队请求，不占下一次请求的时隙', async () => {
    let now = 0
    const sleep = Promise.withResolvers<void>()
    const gate = new UpSearchGate(
      () => now,
      () => sleep.promise,
    )
    await gate.run(() => Promise.resolve())
    const ctl = new AbortController()
    let called = false
    const next = gate.run(() => {
      called = true
      return Promise.resolve()
    }, ctl.signal)
    await Promise.resolve()
    ctl.abort()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(called).toBe(false)
    now = 2_000
    await gate.run(() => Promise.resolve())
    sleep.resolve()
  })
})
