import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecallScheduler } from './recall-scheduler'

afterEach(() => vi.useRealTimers())

describe('按补货需求调度召回', () => {
  it('空闲并发 2, 用户等待时在途批次升到 4, 不重复取数', async () => {
    const scheduler = new RecallScheduler()
    const releases: (() => void)[] = []
    const request = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(1))
        }),
    )
    const batch = Array.from({ length: 8 }, () => scheduler.run(request))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    const supply = scheduler.withForegroundSupply(() => Promise.all(batch))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8))
    releases.splice(0).forEach((release) => release())
    expect(await supply).toEqual(Array.from({ length: 8 }, () => 1))
    expect(request).toHaveBeenCalledTimes(8)

    // 补货完成回到并发 2。
    const idle = Array.from({ length: 4 }, () => scheduler.run(request))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(10))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(12))
    releases.splice(0).forEach((release) => release())
    await Promise.all(idle)
  })

  it('同样八个 100ms 请求, 等补货时两批完成, 空闲预挖四批完成', async () => {
    vi.useFakeTimers()
    const measure = async (foreground: boolean) => {
      const scheduler = new RecallScheduler()
      const start = Date.now()
      const batch = Array.from({ length: 8 }, () =>
        scheduler.run(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 100)
            }),
        ),
      )
      const done = foreground ? scheduler.withForegroundSupply(() => Promise.all(batch)) : Promise.all(batch)
      let elapsed = 0
      const result = done.then(() => {
        elapsed = Date.now() - start
      })
      await vi.runAllTimersAsync()
      await result
      return elapsed
    }
    expect(await measure(false)).toBe(400)
    expect(await measure(true)).toBe(200)
  })

  it('多个等待方独立释放; 失败或中止也恢复空闲并发', async () => {
    const scheduler = new RecallScheduler()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const firstSupply = scheduler.withForegroundSupply(() => first.promise)
    const secondSupply = scheduler.withForegroundSupply(() => second.promise)
    first.resolve()
    await firstSupply

    const releases: (() => void)[] = []
    const request = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    )
    const batch = Array.from({ length: 4 }, () => scheduler.run(request))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    const check = expect(secondSupply).rejects.toThrow('Aborted')
    second.reject(new DOMException('Aborted', 'AbortError'))
    await check
    releases.splice(0).forEach((release) => release())
    await Promise.all(batch)

    const idle = Array.from({ length: 4 }, () => scheduler.run(request))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(6))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8))
    releases.splice(0).forEach((release) => release())
    await Promise.all(idle)
  })
})

describe('recall queue cancellation audit', () => {
  it('does not call an already-cancelled request', async () => {
    const scheduler = new RecallScheduler()
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn(() => Promise.resolve())
    await expect(scheduler.run(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('removes abandoned queued work without waiting for unrelated active requests', async () => {
    const scheduler = new RecallScheduler()
    const held = Promise.withResolvers<void>()
    const active = [scheduler.run(() => held.promise), scheduler.run(() => held.promise)]
    const controller = new AbortController()
    const abandoned = vi.fn(() => Promise.resolve())
    const queued = scheduler.run(abandoned, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await queued).toMatchObject({ name: 'AbortError' })
    expect(abandoned).not.toHaveBeenCalled()
    const live = vi.fn(() => Promise.resolve('live'))
    const next = scheduler.run(live)
    held.resolve()
    await Promise.all(active)
    expect(await next).toBe('live')
    expect(abandoned).not.toHaveBeenCalled()
  })

  it('does not start work cancelled before its first execution microtask', async () => {
    const scheduler = new RecallScheduler()
    const controller = new AbortController()
    const request = vi.fn(() => Promise.resolve())
    const pending = scheduler.run(request, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(request).not.toHaveBeenCalled()
  })

  it('a running non-cancellable operation retains its concurrency slot until it actually finishes', async () => {
    const scheduler = new RecallScheduler()
    const held = Promise.withResolvers<void>()
    const controller = new AbortController()
    const first = scheduler.run(() => held.promise, controller.signal)
    const second = scheduler.run(() => held.promise)
    await Promise.resolve()
    controller.abort()
    const next = vi.fn(() => Promise.resolve())
    const pending = scheduler.run(next)
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
    held.resolve()
    await Promise.all([first, second, pending])
    expect(next).toHaveBeenCalledOnce()
  })

  it('a rejected request frees the slot and removes its signal listener', async () => {
    const scheduler = new RecallScheduler()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(
      scheduler.run(() => {
        throw new Error('failed')
      }, controller.signal),
    ).rejects.toThrow('failed')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(await scheduler.run(() => Promise.resolve(1))).toBe(1)
  })
})
