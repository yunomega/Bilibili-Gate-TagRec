import { waitForAbortable } from './abortable-promise'
import { isRiskControlResponse, tagRecBackoff, tagRecLimit } from './backoff'
import { gmAnonGet } from './request'
import { retryAfterDelay } from './retry-after'

/**
 * [tag-rec] Anonymous SPI credentials, separate from the browser's logged-in cookie jar.
 * Fresh persisted values avoid an extra startup request. The 30-day TTL is a local cache
 * policy, not a statement about server-side validity or risk-control thresholds.
 * A failed refresh may reuse a structurally valid expired record for this session only;
 * its expiry is not extended. Risk responses reduce load, never trigger identity rotation.
 */
export type TagRecFingerprint = Readonly<{ buvid3: string; buvid4: string }>
type FingerSpiJson = { code?: number; data?: { b_3?: unknown; b_4?: unknown } }
type FingerprintRecord = TagRecFingerprint & { until: number }

export const TAG_REC_FINGERPRINT_TTL_MS = 30 * 24 * 60 * 60_000
const STORAGE_KEY = 'tag-rec:fingerprint'
const CLOCK_SKEW_MS = 5 * 60_000
// RFC 6265 section 4.1.1 cookie-octet; the length cap is a local defensive bound.
const COOKIE_VALUE = /^[\u{21}\u{23}-\u{2B}\u{2D}-\u{3A}\u{3C}-\u{5B}\u{5D}-\u{7E}]{1,512}$/u
const cookieValue = (value: unknown): value is string => typeof value === 'string' && COOKIE_VALUE.test(value)

function validateFingerprint(value: unknown): TagRecFingerprint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!cookieValue(candidate.buvid3) || !cookieValue(candidate.buvid4)) return undefined
  return Object.freeze({ buvid3: candidate.buvid3, buvid4: candidate.buvid4 })
}

let fp: TagRecFingerprint | undefined
let inflight: Promise<TagRecFingerprint | undefined> | undefined
let disabled = false
let generation = 0

/** Shared initialization has no consumer-owned signal, but obeys the same send/cooldown gates. */
const defaultFetcher = (): Promise<TagRecFingerprint | undefined> =>
  tagRecLimit(() =>
    tagRecBackoff.withRecoveryProbe(async () => {
      const sentEpoch = await tagRecBackoff.waitTurn()
      const res = await gmAnonGet('/x/frontend/finger/spi', {})
      const retryAfterMs = retryAfterDelay(res.responseHeaders)
      if (isRiskControlResponse(res)) {
        tagRecBackoff.onRiskControl(retryAfterMs)
        return undefined
      }
      if (res.status === 503 && retryAfterMs !== undefined) tagRecBackoff.onRiskControl(retryAfterMs)
      if (res.status < 200 || res.status >= 300) return undefined
      const json = res.data as FingerSpiJson | undefined
      if (json?.code !== 0) return undefined
      const value = validateFingerprint({ buvid3: json.data?.b_3, buvid4: json.data?.b_4 })
      if (value) tagRecBackoff.onSuccess(sentEpoch)
      return value
    }),
  )
let fetcher = defaultFetcher

/** Corrupt, missing or unavailable storage must not break the request chain. */
function readPersisted(): Promise<FingerprintRecord | undefined> {
  return Promise.resolve()
    .then(() => GM.getValue<unknown>(STORAGE_KEY, undefined))
    .then((rec) => {
      const value = validateFingerprint(rec)
      const until = (rec as Partial<FingerprintRecord> | undefined)?.until
      if (
        !value ||
        typeof until !== 'number' ||
        !Number.isSafeInteger(until) ||
        until <= 0 ||
        until > Date.now() + TAG_REC_FINGERPRINT_TTL_MS + CLOCK_SKEW_MS
      )
        return undefined
      return { ...value, until }
    })
    .catch(() => undefined)
}

function persist(value: TagRecFingerprint, epoch: number) {
  const rec: FingerprintRecord = { ...value, until: Date.now() + TAG_REC_FINGERPRINT_TTL_MS }
  void Promise.resolve()
    .then(() => {
      if (generation === epoch) return GM.setValue(STORAGE_KEY, rec)
    })
    .catch(() => undefined)
}

export function fingerprintCookieHeader(): string | undefined {
  return fp ? `buvid3=${fp.buvid3}; buvid4=${fp.buvid4}` : undefined
}

/**
 * Lazy single-flight initialization. A signal cancels only this waiter, never shared SPI.
 * Preference: fresh storage -> one refresh -> valid expired storage -> session fail-open.
 */
export function ensureTagRecFingerprint(signal?: AbortSignal): Promise<TagRecFingerprint | undefined> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (fp) return waitForAbortable(Promise.resolve(fp), signal)
  if (disabled) return waitForAbortable(Promise.resolve(undefined), signal)
  if (!inflight) {
    const epoch = generation
    const mint = fetcher
    const p = readPersisted()
      .then(async (stored) => {
        if (generation !== epoch) return undefined
        if (stored && stored.until > Date.now()) return { value: stored, minted: false }
        // Promise boundary also handles synchronous throws from an implementation/adapter.
        const raw = await Promise.resolve()
          .then(() => mint())
          .catch(() => undefined)
        const value = validateFingerprint(raw)
        if (value) return { value, minted: true }
        return stored ? { value: stored, minted: false } : undefined
      })
      .then((result) => {
        // Check BEFORE both publishing and persisting; stale work must do neither.
        if (inflight !== p || generation !== epoch) return undefined
        inflight = undefined
        fp = validateFingerprint(result?.value)
        disabled = !fp
        if (fp && result?.minted) persist(fp, epoch)
        return fp
      })
    inflight = p
  }
  return waitForAbortable(inflight, signal)
}

export function hasTagRecFingerprint() {
  return !!fp
}
export function getTagRecFingerprintStats() {
  return { has: !!fp, disabled }
}

/** Test-only reset; production never rotates credentials in response to risk signals. */
export function __setFingerprintFetcherForTest(f?: typeof defaultFetcher) {
  const epoch = ++generation
  fp = undefined
  inflight = undefined
  disabled = false
  fetcher = f ?? defaultFetcher
  void Promise.resolve()
    .then(() => {
      if (generation === epoch) return GM.setValue(STORAGE_KEY, undefined)
    })
    .catch(() => undefined)
}
