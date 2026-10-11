import { abortableDelay } from './abortable-delay'

export class UpSearchPausedError extends Error {
  constructor(public readonly retryAt: number) {
    super('UP 投稿搜索已暂停，请稍后重试；如 B 站要求验证，请先在 B 站页面完成验证。')
    this.name = 'UpSearchPausedError'
  }
}

/** 本地保守限速，不是 B 站的安全配额；所有 UP 投稿搜索共用一条串行队列。 */
export class UpSearchGate {
  static readonly INTERVAL_MS = 2_000
  static readonly COOLDOWN_MS = 5 * 60_000
  private active = false
  private readonly pending = new Set<() => void>()
  private nextAt = 0
  private pausedUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  pause(retryAfterMs = 0) {
    const serverDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.max(UpSearchGate.COOLDOWN_MS, serverDelay))
    return new UpSearchPausedError(this.pausedUntil)
  }

  run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (this.now() < this.pausedUntil) return Promise.reject(new UpSearchPausedError(this.pausedUntil))
    const check = () => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (this.now() < this.pausedUntil) throw new UpSearchPausedError(this.pausedUntil)
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const detach = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (!this.pending.delete(start)) return
      detach()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const start = () => {
      this.active = true
      detach()
      Promise.resolve()
        .then(async () => {
          for (;;) {
            check()
            const delay = this.nextAt - this.now()
            if (delay <= 0) break
            await abortableDelay(Math.min(delay, 2_147_483_647), signal, this.sleep)
          }
          check()
          this.nextAt = this.now() + UpSearchGate.INTERVAL_MS
          return request()
        })
        .then(resolve, reject)
        .finally(() => {
          this.active = false
          this.drain()
        })
    }
    // Cancellation removes queued closures in O(1), without waiting for the current HTTP request.
    this.pending.add(start)
    signal?.addEventListener('abort', onAbort, { once: true })
    this.drain()
    return promise
  }

  private drain() {
    if (this.active) return
    const next = this.pending.values().next().value
    if (!next) return
    this.pending.delete(next)
    next()
  }
}

export const upSearchGate = new UpSearchGate()
