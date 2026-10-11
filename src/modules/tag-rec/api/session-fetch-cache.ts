/**
 * [tag-rec] 会话级取数缓存 (零依赖叶子模块, 可测)
 * 用于 `view/detail/tag` 之类「按需调用」端点 (spec §2.3):
 * - 成功(可缓存)结果按 key 会话级缓存, 永不再取
 * - 在途请求按 key 去重 (不限时长)
 * - 失败/不可缓存结果只在 dedupeMs 窗口内去重, 窗口外允许重试
 */

export type SessionFetchCacheEntryState = 'pending' | 'ok' | 'failed'

type Entry<V> = {
  at: number // 结果落定时刻; 排队/网络等待不消耗缓存 TTL
  promise: Promise<V>
  state: SessionFetchCacheEntryState
  /** 底层取数的取消闸: 最后一个等待者离开时置 aborted (loader 可绑定以取消未发送/在途请求) */
  controller: AbortController
  /** 存活等待者数 —— 无 signal 的调用方也不可被取消, 照样计一个等待者 */
  waiters: number
}

export class SessionFetchCache<K, V> {
  private readonly map = new Map<K, Entry<V>>()

  constructor(
    private readonly options: {
      /** 失败结果的去重窗口 (ms): 窗口内同 key 复用旧 promise, 不再发请求 */
      dedupeMs: number
      /** 判定 resolved 值是否可会话级缓存; 缺省 = 全部缓存 */
      isCacheable?: (v: V) => boolean
      now?: () => number
      maxAgeMs?: number
      maxEntries?: number
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  get size() {
    return this.map.size
  }

  private trim() {
    const cap = this.options.maxEntries
    if (cap === undefined) return
    for (const [key, entry] of this.map) {
      if (this.map.size <= cap) break
      if (entry.state !== 'pending') this.map.delete(key)
    }
  }

  /**
   * 命中缓存/在途/去重窗口 => 复用旧 promise; 否则调 loader 并登记。
   * [tag-rec] AUDIT-33: pending 是共享资源 —— loader 不得绑单调用方 signal; signal 只做本
   *   await 方的 abort 判: aborted => 拒 AbortError, 共享 fetch 不被任一调用方单独取消。
   * [tag-rec] 等待者计数 (与 up-search fetchUpSearchPage 同款): **最后**一个等待者离开且
   *   entry 仍 pending => abort entry.controller 并把 entry 摘出 map —— 排在并发闸里
   *   尚未发送的任务不再发出, 在途请求 abort 传播到底层 xhr; 已落定的结果不受影响。
   *   loader 收到的 signal 即 entry.controller.signal, 愿意支持取消的底层自取。
   */
  fetch(key: K, loader: (signal: AbortSignal) => Promise<V>, signal?: AbortSignal): Promise<V> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

    const prev = this.map.get(key)
    let entry: Entry<V>
    let shared: Promise<V>
    if (
      prev &&
      (prev.state === 'pending' ||
        (prev.state === 'ok' &&
          (this.options.maxAgeMs === undefined || this.now() - prev.at < this.options.maxAgeMs)) ||
        (prev.state === 'failed' && this.now() - prev.at < this.options.dedupeMs))
    ) {
      entry = prev
      shared = prev.promise
      this.map.delete(key)
      this.map.set(key, prev)
    } else {
      entry = {
        at: this.now(),
        state: 'pending',
        controller: new AbortController(),
        waiters: 0,
        promise: undefined as unknown as Promise<V>, // 下面立即赋值
      }
      shared = Promise.resolve()
        .then(() => {
          if (entry.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          return loader(entry.controller.signal)
        })
        .then((v) => {
          entry.state = this.options.isCacheable && !this.options.isCacheable(v) ? 'failed' : 'ok'
          entry.at = this.now()
          return v
        })
        .catch((err: unknown) => {
          entry.state = 'failed'
          entry.at = this.now()
          // Cancellation is not a cached network failure. An old request must not erase its replacement.
          if (err instanceof Error && err.name === 'AbortError' && this.map.get(key) === entry) this.map.delete(key)
          throw err
        })
        .finally(() => this.trim())
      entry.promise = shared
      this.map.delete(key) // A refreshed key becomes MRU, just like a cache hit.
      this.map.set(key, entry)
      this.trim()
    }

    entry.waiters++
    return new Promise<V>((resolve, reject) => {
      let released = false
      const release = () => {
        if (released) return
        released = true
        signal?.removeEventListener('abort', onAbort)
        if (--entry.waiters === 0 && entry.state === 'pending') {
          if (this.map.get(key) === entry) this.map.delete(key)
          entry.controller.abort()
        }
      }
      const onAbort = () => {
        release()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      shared.then(
        (v) => {
          release()
          resolve(v)
        },
        (err) => {
          release()
          reject(err)
        },
      )
    })
  }

  /** Explicit refresh replaces settled data but must join an already running request. */
  invalidateSettled(key: K) {
    const entry = this.map.get(key)
    return entry !== undefined && entry.state !== 'pending' && this.map.delete(key)
  }

  invalidate(key: K) {
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }
}
