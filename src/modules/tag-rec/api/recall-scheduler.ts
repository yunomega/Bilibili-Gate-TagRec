/** 空闲召回并发 2; 用户正在等补货时升到 4, 同时提升已经排队的预挖。 */
export class RecallScheduler {
  private active = 0
  private foregroundWaiters = 0
  private readonly pending = new Set<() => void>()

  /** Queued cancellation is immediate and O(1); running requests keep their slot until settled. */
  run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const detach = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (!this.pending.delete(start)) return
      detach()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const start = () => {
      detach()
      this.active++
      Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          return request()
        })
        .then(resolve, reject)
        .finally(() => {
          this.active--
          this.drain()
        })
    }
    this.pending.add(start)
    signal?.addEventListener('abort', onAbort, { once: true })
    this.drain()
    return promise
  }

  async withForegroundSupply<T>(supply: () => Promise<T>): Promise<T> {
    this.foregroundWaiters++
    this.drain()
    try {
      return await supply()
    } finally {
      this.foregroundWaiters--
      this.drain()
    }
  }

  private drain() {
    const limit = this.foregroundWaiters ? 4 : 2
    while (this.active < limit && this.pending.size) {
      const start = this.pending.values().next().value!
      this.pending.delete(start)
      start()
    }
  }
}

/** 两个标签 tab 共享; 所有召回请求仍经 anonGetJson 的全局并发与风控闸。 */
export const tagRecRecallScheduler = new RecallScheduler()
