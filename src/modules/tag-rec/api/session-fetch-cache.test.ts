import { describe, expect, it } from 'vitest'
import { SessionFetchCache } from './session-fetch-cache'

const ok =
  <T>(v: T) =>
  () =>
    Promise.resolve(v)

describe.concurrent('$modules/tag-rec/api/session-fetch-cache', () => {
  it('配置成功 TTL 后到期重新取，缺省仍维持会话缓存', async () => {
    let now = 0
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 10, maxAgeMs: 100, now: () => now })
    const load = () => Promise.resolve(++calls)
    expect(await cache.fetch('a', load)).toBe(1)
    now = 99
    expect(await cache.fetch('a', load)).toBe(1)
    now = 100
    expect(await cache.fetch('a', load)).toBe(2)
  })

  it('容量按 LRU 淘汰已落定条目，命中会保留热条目', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 10, maxEntries: 2 })
    const load = () => Promise.resolve(++calls)
    await cache.fetch('a', load)
    await cache.fetch('b', load)
    expect(await cache.fetch('a', load)).toBe(1)
    await cache.fetch('c', load)
    expect(cache.size).toBe(2)
    expect(await cache.fetch('a', load)).toBe(1)
    expect(await cache.fetch('b', load)).toBe(4)
  })

  it('容量不能淘汰在途请求产生重复取数，落定后再收缩', async () => {
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 10, maxEntries: 1 })
    const deferredA = Promise.withResolvers<number>()
    const deferredB = Promise.withResolvers<number>()
    const loadA = () => deferredA.promise
    const loadB = () => deferredB.promise
    const a = cache.fetch('a', loadA)
    const b = cache.fetch('b', loadB)
    const sharedA = cache.fetch('a', loadA)
    await Promise.resolve()
    deferredA.resolve(1)
    deferredB.resolve(2)
    expect(await a).toBe(1)
    expect(await sharedA).toBe(1)
    expect(await b).toBe(2)
    expect(cache.size).toBe(1)
  })
  it('成功结果会话级缓存: 同 key 永不再取', async () => {
    let t = 0
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000, now: () => t })
    const loader = () => {
      calls++
      return Promise.resolve(calls)
    }
    await expect(cache.fetch('a', loader)).resolves.toBe(1)
    await expect(cache.fetch('a', loader)).resolves.toBe(1) // 复用缓存
    t += 60_000
    await expect(cache.fetch('a', loader)).resolves.toBe(1) // 会话内不再取
    expect(calls).toBe(1)
  })

  it('在途请求按 key 去重, 不同 key 互不影响', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    const loader = () => {
      calls++
      return new Promise<number>((resolve) => setTimeout(() => resolve(calls), 10))
    }
    const [r1, r2] = await Promise.all([cache.fetch('a', loader), cache.fetch('a', loader)])
    expect(r1).toBe(r2)
    expect(calls).toBe(1)
    await cache.fetch('b', loader)
    expect(calls).toBe(2)
  })

  it('失败结果仅在 dedupeMs 窗口内去重, 窗口外可重试', async () => {
    let t = 0
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000, now: () => t })
    const loader = () => {
      calls++
      return calls < 3 ? Promise.reject(new Error('boom')) : Promise.resolve(calls)
    }

    await expect(cache.fetch('a', loader)).rejects.toThrow('boom') // calls=1, failed
    await expect(cache.fetch('a', ok(999))).rejects.toThrow('boom') // 窗口内复用失败 promise
    expect(calls).toBe(1)

    t += 2_999
    await expect(cache.fetch('a', loader)).rejects.toThrow('boom') // 仍在窗口内? 2999 < 3000 => 复用
    expect(calls).toBe(1)

    t += 1 // t = 3000, 出窗口
    await expect(cache.fetch('a', loader)).rejects.toThrow('boom') // calls=2, 仍失败
    expect(calls).toBe(2)

    t += 3_000 // t = 6000
    await expect(cache.fetch('a', loader)).resolves.toBe(3) // calls=3, 成功后转会话缓存
    await expect(cache.fetch('a', loader)).resolves.toBe(3)
    expect(calls).toBe(3)
  })

  it('isCacheable=false 的 resolved 值等同失败: 去重窗口后重试', async () => {
    let t = 0
    let calls = 0
    const cache = new SessionFetchCache<string, number | undefined>({
      dedupeMs: 3_000,
      isCacheable: (v) => v !== undefined,
      now: () => t,
    })
    const loader = () => Promise.resolve(calls++ === 0 ? undefined : calls)
    await expect(cache.fetch('a', loader)).resolves.toBeUndefined()
    await expect(cache.fetch('a', loader)).resolves.toBeUndefined() // 窗口内去重
    expect(calls).toBe(1)
    t += 3_001
    await expect(cache.fetch('a', loader)).resolves.toBe(2)
    await expect(cache.fetch('a', loader)).resolves.toBe(2)
    expect(calls).toBe(2)
  })

  it('.invalidate 强制下次重新取', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    const loader = () => Promise.resolve(++calls)
    await cache.fetch('a', loader)
    cache.invalidate('a')
    await expect(cache.fetch('a', loader)).resolves.toBe(2)
  })

  it('AUDIT-33: 首调用方 abort 只退自身 await —— 共享 pending 与其它 await 方不受传染', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    let resolveLoader!: (v: number) => void
    const loader = () => {
      calls++
      return new Promise<number>((r) => (resolveLoader = r))
    }

    const c1 = new AbortController()
    const p1 = cache.fetch('a', loader, c1.signal) // 首调用方
    const p2 = cache.fetch('a', loader) // 共享方 (无 signal)
    const p3 = cache.fetch('a', loader, new AbortController().signal) // 共享方 (带 signal)

    c1.abort()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' }) // 仅 c1 被拒
    expect(calls).toBe(1) // 共享 pending 只起一发 (loader 经微任务调度, 此时已跑)

    resolveLoader(7) // 共享 fetch 照常落定, entry 落 'ok'
    await expect(p2).resolves.toBe(7)
    await expect(p3).resolves.toBe(7)
    await expect(cache.fetch('a', loader)).resolves.toBe(7) // 结果已沉淀会话缓存
    expect(calls).toBe(1)
  })

  it('AUDIT-33: 调用前已 abort => 拒 AbortError 且不发起底层取数', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(cache.fetch('a', () => Promise.resolve(++calls), ctrl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toBe(0)
    expect(cache.size).toBe(0)
  })

  it('最后一个等待者离开 => 取消 pending 取数并摘出缓存 (排队任务不再发出)', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    const signals: AbortSignal[] = []
    let resolveLoader!: (v: number) => void
    const loader = (sig: AbortSignal) => {
      calls++
      signals.push(sig)
      return new Promise<number>((r) => (resolveLoader = r))
    }

    const c1 = new AbortController()
    const p1 = cache.fetch('a', loader, c1.signal)
    await Promise.resolve() // Start the loader; same-turn abandonment is tested separately.
    c1.abort() // 唯一等待者离开 —— 共享 fetch 未落定 => 取消
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(true) // 取消闸下传到 loader
    expect(cache.size).toBe(0) // entry 摘除 —— 不沉淀也不占失败去重窗

    resolveLoader(9) // 未绑取消闸的孤儿照常落定, 但不进缓存
    const p2 = cache.fetch('a', loader)
    await Promise.resolve() // loader 经微任务调度, 先让它登记新 deferred
    resolveLoader(10)
    await expect(p2).resolves.toBe(10) // 重新取数
    expect(calls).toBe(2)
  })

  it('AUDIT-33: 尚有其它等待者时单调用方 abort => 共享 pending 照常落定并沉淀', async () => {
    let calls = 0
    const cache = new SessionFetchCache<string, number>({ dedupeMs: 3_000 })
    const signals: AbortSignal[] = []
    let resolveLoader!: (v: number) => void
    const loader = (sig: AbortSignal) => {
      calls++
      signals.push(sig)
      return new Promise<number>((r) => (resolveLoader = r))
    }

    const c1 = new AbortController()
    const p1 = cache.fetch('a', loader, c1.signal)
    const p2 = cache.fetch('a', loader) // 无 signal 的共享方钉住在途请求
    c1.abort()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(false) // 共享方还在 => 取消闸不动

    resolveLoader(9) // 底层取数继续跑完, entry 落 'ok'
    await expect(p2).resolves.toBe(9)
    await expect(cache.fetch('a', loader)).resolves.toBe(9) // 结果照常沉淀会话缓存
    expect(calls).toBe(1)
  })
})
