import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setFingerprintFetcherForTest,
  ensureTagRecFingerprint,
  fingerprintCookieHeader,
  hasTagRecFingerprint,
  TAG_REC_FINGERPRINT_TTL_MS,
} from './fingerprint'

const FP = { buvid3: 'B3-TEST', buvid4: 'B4-TEST' }
const STORAGE_KEY = 'tag-rec:fingerprint'

// request 桩 —— 默认 fetcher 不真发; W4-4 用例靠它观测模块求值是否有偷跑调用
vi.mock('./request', () => ({
  gmAnonGet: vi.fn(() => Promise.resolve({ status: 200, data: {} })),
}))

// GM 桩内存 kv (同 dry-tids-store.test.ts 手法)
const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, def?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : def)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
})

afterEach(() => {
  gmKv.clear()
  __setFingerprintFetcherForTest() // 复位默认 fetcher + 状态 (含持久存档清空)
})

describe('$modules/tag-rec/api/fingerprint (票 16)', () => {
  it('ensure: 惰性拉取一次, 并发共享同一 inflight', async () => {
    const fetcher = vi.fn(() => Promise.resolve(FP))
    __setFingerprintFetcherForTest(fetcher)

    const [a, b] = await Promise.all([ensureTagRecFingerprint(), ensureTagRecFingerprint()])
    expect(a).toEqual(FP)
    expect(b).toEqual(FP)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(hasTagRecFingerprint()).toBe(true)
    expect(fingerprintCookieHeader()).toBe('buvid3=B3-TEST; buvid4=B4-TEST')
  })

  it('spi 失败 => 本会话 fail-open 禁用, 不再重试', async () => {
    const fetcher = vi.fn(() => Promise.resolve(undefined))
    __setFingerprintFetcherForTest(fetcher)

    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fingerprintCookieHeader()).toBeUndefined()
  })

  it('fetcher 抛错 => fail-open, 不传染调用方', async () => {
    __setFingerprintFetcherForTest(() => Promise.reject(new Error('net')))
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(hasTagRecFingerprint()).toBe(false)
  })

  it('W4-4: 模块求值不发指纹请求 —— 预热摘帽, 无关页面/特性不背匿名 spi', async () => {
    // 重载模块: 若模块顶层还有 ensure 预热, 默认 fetcher 会触 (mock 的) gmAnonGet
    const { gmAnonGet } = await import('./request')
    vi.mocked(gmAnonGet).mockClear()
    vi.resetModules()
    await import('./fingerprint')
    expect(vi.mocked(gmAnonGet)).not.toHaveBeenCalled()
  })

  it('AUDIT-32: spi 拉取不绑调用方 signal (ensure 零参, fetcher 收不到 signal)', async () => {
    const fetcher = vi.fn(() => Promise.resolve(FP))
    __setFingerprintFetcherForTest(fetcher)
    await ensureTagRecFingerprint()
    expect(fetcher).toHaveBeenCalledWith() // 零参 —— 无调用方 signal 可传入, abort 不致死铸指纹
  })
})

describe('指纹持久化 (稳定回访设备观感)', () => {
  const rec = (untilOffset: number) => ({ ...FP, until: Date.now() + untilOffset })
  /** reset 的清存档写是微任务 —— 播种存档前须排空, 否则被迟到清空覆盖 */
  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('新鲜存档直接复用, 不铸新指纹', async () => {
    const fetcher = vi.fn(() => Promise.resolve({ buvid3: 'B3-NEW', buvid4: 'B4-NEW' }))
    __setFingerprintFetcherForTest(fetcher)
    await flushMicrotasks()
    gmKv.set(STORAGE_KEY, rec(60_000)) // 未到期

    const got = await ensureTagRecFingerprint()
    expect(got).toEqual(FP)
    expect(fetcher).not.toHaveBeenCalled()
    expect(fingerprintCookieHeader()).toBe('buvid3=B3-TEST; buvid4=B4-TEST')
  })

  it('过期存档 => 铸新并落盘 (until = now + TTL)', async () => {
    const minted = { buvid3: 'B3-NEW', buvid4: 'B4-NEW' }
    const fetcher = vi.fn(() => Promise.resolve(minted))
    __setFingerprintFetcherForTest(fetcher)
    await flushMicrotasks()
    gmKv.set(STORAGE_KEY, rec(-1)) // 已过期

    const got = await ensureTagRecFingerprint()
    expect(got).toEqual(minted)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => {
      const saved = gmKv.get(STORAGE_KEY) as { buvid3: string; until: number } | undefined
      expect(saved?.buvid3).toBe('B3-NEW')
      expect(saved!.until).toBeGreaterThan(Date.now() + TAG_REC_FINGERPRINT_TTL_MS - 10_000)
      expect(saved!.until).toBeLessThanOrEqual(Date.now() + TAG_REC_FINGERPRINT_TTL_MS)
    })
  })

  it('过期存档 + spi 失败 => 回退存档本会话照用 (不判 disabled)', async () => {
    const fetcher = vi.fn(() => Promise.resolve(undefined))
    __setFingerprintFetcherForTest(fetcher)
    await flushMicrotasks()
    gmKv.set(STORAGE_KEY, rec(-1))

    expect(await ensureTagRecFingerprint()).toEqual(FP)
    expect(hasTagRecFingerprint()).toBe(true)
    // 再次 ensure 命中内存 fp, 不重查存档
    expect(await ensureTagRecFingerprint()).toEqual(FP)
  })

  it('无存档 + spi 失败 => 本会话 disabled (原 fail-open 语义)', async () => {
    const fetcher = vi.fn(() => Promise.resolve(undefined))
    __setFingerprintFetcherForTest(fetcher)

    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('存档记录畸形 => 当无存档走铸新', async () => {
    const fetcher = vi.fn(() => Promise.resolve(FP))
    __setFingerprintFetcherForTest(fetcher)
    await flushMicrotasks()
    gmKv.set(STORAGE_KEY, { buvid3: 'B3-TEST' }) // 缺 buvid4/until

    expect(await ensureTagRecFingerprint()).toEqual(FP)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
