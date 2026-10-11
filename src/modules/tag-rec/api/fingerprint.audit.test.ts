import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRecBackoff } from './backoff'
import {
  __setFingerprintFetcherForTest,
  ensureTagRecFingerprint,
  fingerprintCookieHeader,
  TAG_REC_FINGERPRINT_TTL_MS,
  type TagRecFingerprint,
} from './fingerprint'
import { gmAnonGet } from './request'

vi.mock('./request', () => ({ gmAnonGet: vi.fn() }))
vi.mock('./backoff', async (load) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await load<typeof import('./backoff')>()
  return {
    ...actual,
    tagRecLimit: <T>(run: () => Promise<T>) => run(),
    tagRecBackoff: {
      waitTurn: vi.fn(() => Promise.resolve(0)),
      withRecoveryProbe: <T>(run: () => Promise<T>) => run(),
      onSuccess: vi.fn(),
      onRiskControl: vi.fn(),
    },
  }
})
const key = 'tag-rec:fingerprint'
const FP = { buvid3: 'B3-safe', buvid4: 'B4-safe' }
const kv = new Map<string, unknown>()
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
beforeEach(async () => {
  vi.stubGlobal('GM', {
    getValue: vi.fn((k: string) => Promise.resolve(kv.get(k))),
    setValue: vi.fn((k: string, v: unknown) => {
      kv.set(k, v)
      return Promise.resolve()
    }),
  })
  vi.clearAllMocks()
  kv.clear()
  __setFingerprintFetcherForTest()
  await flush()
})
afterEach(async () => {
  __setFingerprintFetcherForTest()
  await flush()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fingerprint input and storage boundaries', () => {
  it.each([123, {}, [], 'a;b=x', 'a\r\nx-header: bad', 'a,b', 'a b', '"bad"', 'bad\\value', 'x'.repeat(513)])(
    'rejects unsafe persisted cookie values: %j',
    async (buvid3) => {
      const mint = vi.fn(() => Promise.resolve(FP))
      __setFingerprintFetcherForTest(mint)
      await flush()
      kv.set(key, { buvid3, buvid4: 'B4', until: Date.now() + 60_000 })
      expect(await ensureTagRecFingerprint()).toEqual(FP)
      expect(mint).toHaveBeenCalledTimes(1)
      expect(fingerprintCookieHeader()).toBe('buvid3=B3-safe; buvid4=B4-safe')
    },
  )

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid or implausible expiry: %j',
    async (until) => {
      const mint = vi.fn(() => Promise.resolve(FP))
      __setFingerprintFetcherForTest(mint)
      await flush()
      kv.set(key, { buvid3: 'old3', buvid4: 'old4', until })
      expect(await ensureTagRecFingerprint()).toEqual(FP)
      expect(mint).toHaveBeenCalledTimes(1)
    },
  )

  it('handles a synchronous fetcher failure as one fail-open attempt', async () => {
    const mint = vi.fn(() => {
      throw new Error('sync failure')
    })
    __setFingerprintFetcherForTest(mint)
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('does not publish or persist malformed minted values', async () => {
    __setFingerprintFetcherForTest(() => Promise.resolve({ ...FP, buvid4: 'bad;extra=cookie' }))
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    await flush()
    expect(fingerprintCookieHeader()).toBeUndefined()
    expect(kv.get(key)).toBeUndefined()
  })

  it('old in-flight completion cannot overwrite newer persisted credentials', async () => {
    const old = Promise.withResolvers<TagRecFingerprint | undefined>()
    __setFingerprintFetcherForTest(() => old.promise)
    const pending = ensureTagRecFingerprint()
    await flush()
    __setFingerprintFetcherForTest(() => Promise.resolve(FP))
    await ensureTagRecFingerprint()
    await flush()
    old.resolve({ buvid3: 'OLD3', buvid4: 'OLD4' })
    await pending
    await flush()
    expect(kv.get(key)).toMatchObject(FP)
    expect(fingerprintCookieHeader()).toBe('buvid3=B3-safe; buvid4=B4-safe')
  })

  it('cannot mutate the shared cookie through a returned object', async () => {
    __setFingerprintFetcherForTest(() => Promise.resolve(FP))
    const result = await ensureTagRecFingerprint()
    Reflect.set(result!, 'buvid3', 'changed')
    expect(fingerprintCookieHeader()).toBe('buvid3=B3-safe; buvid4=B4-safe')
  })

  it('reuses valid fresh storage without network or rewritten expiry', async () => {
    kv.set(key, { ...FP, until: Date.now() + TAG_REC_FINGERPRINT_TTL_MS })
    const before = kv.get(key)
    vi.mocked(GM.setValue).mockClear()
    expect(await ensureTagRecFingerprint()).toEqual(FP)
    expect(gmAnonGet).not.toHaveBeenCalled()
    expect(GM.setValue).not.toHaveBeenCalled()
    expect(kv.get(key)).toBe(before)
  })
})

describe('SPI transport discipline', () => {
  it.each([429, 503])('rejects HTTP %i even if a body claims success', async (status) => {
    vi.mocked(gmAnonGet).mockResolvedValue({
      status,
      responseHeaders: 'Retry-After: 120',
      data: { code: 0, data: { b_3: 'B3', b_4: 'B4' } },
    })
    expect(await ensureTagRecFingerprint()).toBeUndefined()
    expect(tagRecBackoff.onRiskControl).toHaveBeenCalledWith(120_000)
    expect(tagRecBackoff.onSuccess).not.toHaveBeenCalled()
  })

  it('waits for the shared pacing gate before starting SPI', async () => {
    const turn = Promise.withResolvers<number>()
    vi.mocked(tagRecBackoff.waitTurn).mockReturnValueOnce(turn.promise)
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: 0, data: { b_3: FP.buvid3, b_4: FP.buvid4 } } })
    const pending = ensureTagRecFingerprint()
    await flush()
    const prematureRequest = vi.mocked(gmAnonGet).mock.calls.length
    turn.resolve(0)
    expect(await pending).toEqual(FP)
    expect(prematureRequest).toBe(0)
    expect(tagRecBackoff.onSuccess).toHaveBeenCalledWith(0)
  })
})
