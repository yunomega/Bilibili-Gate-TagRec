import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetTagRecSearchGateForTest, RiskControlError, tagRecBackoff } from './backoff'
import { anonGetJson, fetchAllV2Search, fetchTagTop } from './endpoints'
import { tagRecRecallScheduler } from './recall-scheduler'
import { gmAnonGet, type GmAnonResponse } from './request'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$request', () => ({ isWebApiSuccess: (j: { code?: number }) => j?.code === 0 }))
vi.mock('./request', () => ({ gmAnonGet: vi.fn() }))
vi.mock('./fingerprint', () => ({
  ensureTagRecFingerprint: vi.fn(() => Promise.resolve()),
  fingerprintCookieHeader: () => '',
  hasTagRecFingerprint: () => false,
}))
vi.mock('./risk-log', () => ({ recordAnonRequest: vi.fn() }))
vi.mock('./tag-info-store', () => ({}))
vi.mock('./video-tags-store', () => ({}))

const successFor = (url: string): GmAnonResponse =>
  // all/v2 成功体必带 data.result (缺块即截断/降级按失败计); tag/top 直取 data 数组
  url.includes('all/v2')
    ? { status: 200, data: { code: 0, data: { result: [] } } }
    : { status: 200, data: { code: 0, data: [] } }

describe('匿名请求调度', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(gmAnonGet).mockReset()
    __resetTagRecSearchGateForTest()
    tagRecBackoff.onSuccess()
    vi.spyOn(tagRecBackoff, 'waitTurn').mockResolvedValue(0)
  })

  it('后台仅占两个槽, 四个前台请求仍可立即进入主闸的余下两个槽', async () => {
    const releases: (() => void)[] = []
    vi.mocked(gmAnonGet).mockImplementation(
      (url) =>
        new Promise((resolve) => {
          releases.push(() => resolve(successFor(url as string)))
        }),
    )
    const background = Array.from({ length: 6 }, (_, i) => fetchAllV2Search(`kw${i}`))
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(2))
    const foreground = Array.from({ length: 4 }, (_, i) => fetchTagTop(i + 1))
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(4))
    const urls = vi.mocked(gmAnonGet).mock.calls.map(([url]) => url)
    expect(urls.filter((url) => url.endsWith('/all/v2'))).toHaveLength(2)
    expect(urls.filter((url) => url.endsWith('/tag/top'))).toHaveLength(2)
    // 放行在途请求, 确认各批均能完成, 主闸全局并发仍为四。
    for (let total = 4; total < 10;) {
      releases.splice(0).forEach((release) => release())
      const next = Math.min(total + 4, 10)
      await vi.waitFor(() => expect(vi.mocked(gmAnonGet).mock.calls.length).toBeGreaterThanOrEqual(next))
      total = vi.mocked(gmAnonGet).mock.calls.length
    }
    releases.splice(0).forEach((release) => release())
    await Promise.all([...background, ...foreground])
  })

  it('退避批次只发送一个恢复探针, 成功后下一次正常请求可发送', async () => {
    tagRecBackoff.onRiskControl()
    const { promise, resolve: release } = Promise.withResolvers<number>()
    vi.mocked(tagRecBackoff.waitTurn).mockReturnValueOnce(promise)
    vi.mocked(gmAnonGet).mockImplementation((url) => Promise.resolve(successFor(url as string)))
    const batch = Promise.allSettled(Array.from({ length: 8 }, (_, i) => fetchTagTop(i + 1)))
    await vi.waitFor(() => expect(tagRecBackoff.waitTurn).toHaveBeenCalledTimes(1))
    expect(gmAnonGet).not.toHaveBeenCalled()
    release(tagRecBackoff.riskEpoch) // 放行时刻回传当前代次 —— 探针成功才有本代解除权
    const results = await batch
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof RiskControlError)).toHaveLength(7)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
    expect(tagRecBackoff.isEngaged).toBe(false)
    await expect(fetchTagTop(100)).resolves.toEqual([])
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
  })

  it('等待补货提升召回调度至四发, 但 allV2 专用闸仍封顶两发', async () => {
    const releases: (() => void)[] = []
    vi.mocked(gmAnonGet).mockImplementation(
      (url) =>
        new Promise((resolve) => {
          releases.push(() => resolve(successFor(url as string)))
        }),
    )
    // 交集窄化后召回量全压 allV2 —— 该道常驻 pLimit(2), 前台提速不得突破
    const batch = Array.from({ length: 6 }, (_, i) => fetchAllV2Search(`urgent${i}`))
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(2))
    // tag/top 不走召回调度、直发主闸 —— 占满主闸余下两槽
    const foreground = Array.from({ length: 4 }, (_, i) => fetchTagTop(100 + i))
    const supply = tagRecRecallScheduler.withForegroundSupply(() => Promise.allSettled([...batch, ...foreground]))
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(4))
    const inflight = vi.mocked(gmAnonGet).mock.calls.map(([url]) => url)
    expect(inflight.filter((url) => url.endsWith('/all/v2'))).toHaveLength(2)
    expect(inflight.filter((url) => url.endsWith('/tag/top'))).toHaveLength(2)
    for (let total = 4; total < 10;) {
      releases.splice(0).forEach((release) => release())
      const next = Math.min(total + 2, 10)
      await vi.waitFor(() => expect(vi.mocked(gmAnonGet).mock.calls.length).toBeGreaterThanOrEqual(next))
      total = vi.mocked(gmAnonGet).mock.calls.length
    }
    releases.splice(0).forEach((release) => release())
    await supply
    expect(gmAnonGet).toHaveBeenCalledTimes(10)
  })

  it('补货提速期间仍只允许一个风控恢复请求', async () => {
    tagRecBackoff.onRiskControl()
    const { promise, resolve: release } = Promise.withResolvers<number>()
    vi.mocked(tagRecBackoff.waitTurn).mockReturnValueOnce(promise)
    vi.mocked(gmAnonGet).mockImplementation((url) => Promise.resolve(successFor(url as string)))
    const batch = Array.from({ length: 6 }, (_, i) => fetchAllV2Search(`risk${i}`))
    const supply = tagRecRecallScheduler.withForegroundSupply(() => Promise.allSettled(batch))
    await vi.waitFor(() => expect(tagRecBackoff.waitTurn).toHaveBeenCalledTimes(1))
    expect(gmAnonGet).not.toHaveBeenCalled()
    release(tagRecBackoff.riskEpoch)
    const results = await supply
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('持续风控仍限制为首发加两次重试, 不无限恢复探测', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 412, data: {} })
    await expect(fetchTagTop(1)).rejects.toBeInstanceOf(RiskControlError)
    expect(gmAnonGet).toHaveBeenCalledTimes(3)
    expect(tagRecBackoff.isEngaged).toBe(true)
  })
})

describe('server-directed cooldown integration', () => {
  it('forwards a 429 Retry-After to the shared gate', async () => {
    vi.restoreAllMocks()
    tagRecBackoff.onSuccess()
    vi.spyOn(tagRecBackoff, 'waitTurn').mockResolvedValue(tagRecBackoff.riskEpoch)
    const hit = vi.spyOn(tagRecBackoff, 'onRiskControl')
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 429, data: {}, responseHeaders: 'Retry-After: 120' })
    await expect(anonGetJson('/audit-rate', {}, undefined, undefined, 0)).rejects.toBeInstanceOf(RiskControlError)
    expect(hit).toHaveBeenCalledWith(120_000)
  })
  it('respects a 503 Retry-After without interpreting the body as successful content', async () => {
    vi.restoreAllMocks()
    tagRecBackoff.onSuccess()
    vi.spyOn(tagRecBackoff, 'waitTurn').mockResolvedValue(tagRecBackoff.riskEpoch)
    const hit = vi.spyOn(tagRecBackoff, 'onRiskControl')
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 503, data: { code: 0 }, responseHeaders: 'Retry-After: 90' })
    await expect(anonGetJson('/audit-unavailable', {}, undefined, undefined, 0)).rejects.toMatchObject({ status: 503 })
    expect(hit).toHaveBeenCalledWith(90_000)
  })
})
