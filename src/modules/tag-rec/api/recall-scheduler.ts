/** 空闲召回并发 2; 用户正在等补货时升到 4, 同时提升已经排队的预挖。 */
export class RecallScheduler {
  private active = 0
  private foregroundWaiters = 0
  private readonly pending = new Set<() => void>()
  /** 交互动作专用队列 —— 用户等在按钮上的取数排在后台批量任务之前, 不被深挖流饿死 */
  private readonly pendingForeground = new Set<() => void>()

  /** Queued cancellation is immediate and O(1); running requests keep their slot until settled. */
  run<T>(request: () => Promise<T>, signal?: AbortSignal, opts?: { foreground?: boolean }): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    const lane = opts?.foreground ? this.pendingForeground : this.pending
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const detach = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (!lane.delete(start)) return
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
    lane.add(start)
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
    while (this.active < limit && (this.pendingForeground.size || this.pending.size)) {
      const lane = this.pendingForeground.size ? this.pendingForeground : this.pending
      const start = lane.values().next().value!
      lane.delete(start)
      start()
    }
  }
}

/** 两个标签 tab 共享; 所有召回请求仍经 anonGetJson 的全局并发与风控闸。 */
export const tagRecRecallScheduler = new RecallScheduler()
