import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BackoffGate,
  isRiskControlError,
  isRiskControlResponse,
  RiskControlError,
  TagRecSlidingWindowGate,
} from './backoff'
const fakeRes = (status: number, data: unknown) => ({ status, data })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => vi.useRealTimers())

describe('request pacing and backoff', () => {
  it('.isRiskControlResponse', () => {
    expect(isRiskControlResponse(fakeRes(412, {}))).toBe(true) // HTTP 412
    expect(isRiskControlResponse(fakeRes(200, '<html>风控页</html>'))).toBe(true) // 非 JSON
    expect(isRiskControlResponse(fakeRes(200, null))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: -412, message: 'risk' }))).toBe(true) // -412
    // 与 up-search.isUpSearchRisk 同口径: HTTP 429 / 风控业务码 / 验证码特征体
    expect(isRiskControlResponse(fakeRes(429, { code: 0 }))).toBe(true) // HTTP 429
    expect(isRiskControlResponse(fakeRes(200, { code: -352, message: '风控校验' }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: -401 }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: -101 }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, v_voucher: 'verify' }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, data: { is_risk: true } }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, data: { gaia_res_type: 1 } }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, data: { gaia_data: {} } }))).toBe(true)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, data: { v_voucher: 'x' } }))).toBe(true)
    // 正常体不误判 (字段存在但为 falsy)
    expect(
      isRiskControlResponse(
        fakeRes(200, {
          code: 0,
          message: '0',
          data: { is_risk: false, gaia_res_type: 0, gaia_data: null, result: [] },
        }),
      ),
    ).toBe(false)
    expect(isRiskControlResponse(fakeRes(200, { code: 0, message: '0', data: [] }))).toBe(false)
    expect(isRiskControlResponse(fakeRes(200, { code: -400, message: '请求错误' }))).toBe(false)
  })

  it('.isRiskControlError', () => {
    expect(isRiskControlError(new RiskControlError())).toBe(true)
    expect(isRiskControlError({ isAxiosError: true, response: fakeRes(412, {}) })).toBe(true)
    expect(isRiskControlError({ isAxiosError: true, response: fakeRes(200, { code: -412 }) })).toBe(true)
    expect(isRiskControlError({ isAxiosError: true, response: fakeRes(200, { code: 0 }) })).toBe(false)
    expect(isRiskControlError(new Error('network'))).toBe(false)
    expect(isRiskControlError('string')).toBe(false)
  })

  it('serves the first request immediately, then spaces actual starts by the normal baseline', async () => {
    const gate = new BackoffGate()
    const starts: number[] = []
    const batch = Array.from({ length: 5 }, () => gate.waitTurn().then(() => starts.push(Date.now())))
    await vi.runAllTimersAsync()
    await Promise.all(batch)
    expect(starts).toEqual([1_000, 1_350, 1_700, 2_050, 2_400])
    expect(gate.isEngaged).toBe(false)
  })

  it('does not release a catch-up burst after the browser suspends its timers', async () => {
    const gate = new BackoffGate()
    await gate.waitTurn()
    const starts: number[] = []
    const batch = Array.from({ length: 3 }, () => gate.waitTurn().then(() => starts.push(Date.now())))
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(61_000)
    await vi.advanceTimersByTimeAsync(350)
    expect(starts).toEqual([61_350])
    await vi.runAllTimersAsync()
    await Promise.all(batch)
    expect(starts).toEqual([61_350, 61_700, 62_050])
  })

  it('rejects an already aborted signal before reserving or sleeping', async () => {
    const gate = new BackoffGate()
    const controller = new AbortController()
    controller.abort()
    await expect(gate.waitTurn(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
    expect(await gate.waitTurn()).toBe(0)
  })

  it('removes a cancelled queued request immediately, without consuming its time slot', async () => {
    const gate = new BackoffGate()
    await gate.waitTurn()
    const head = gate.waitTurn()
    const controller = new AbortController()
    const cancelled = gate.waitTurn(controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    const tail = gate.waitTurn()
    await vi.runAllTimersAsync()
    await Promise.all([head, tail])
    expect(Date.now()).toBe(1_700)
  })

  it('cancels a sleeping request and clears its timer, leaving the next request the same slot', async () => {
    const gate = new BackoffGate()
    await gate.waitTurn()
    const controller = new AbortController()
    const cancelled = gate.waitTurn(controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
    const next = gate.waitTurn()
    await vi.runAllTimersAsync()
    await next
    expect(Date.now()).toBe(1_350)
  })

  it('backs off from 4 seconds, jumps to 30s on the second consecutive hit, caps at 60s, and reports transitions', () => {
    const gate = new BackoffGate()
    const change = vi.fn()
    gate.onStateChange = change
    gate.onRiskControl()
    expect(gate.currentIntervalMs).toBe(4_000)
    // 连续退避逐级加深: 第 2 次直接跳 30s 档, 第 3 次起 60s
    gate.onRiskControl()
    expect(gate.currentIntervalMs).toBe(30_000)
    gate.onRiskControl()
    expect(gate.currentIntervalMs).toBe(60_000)
    for (let i = 0; i < 10; i++) gate.onRiskControl()
    expect(gate.currentIntervalMs).toBe(60_000)
    expect(change).toHaveBeenCalledWith(true, 4_000)
    gate.onSuccess(gate.riskEpoch)
    expect(change).toHaveBeenLastCalledWith(false, 0)
  })

  it('never shortens a server Retry-After deadline even if a later response omits it', async () => {
    const gate = new BackoffGate()
    gate.onRiskControl(120_000)
    expect(gate.currentIntervalMs).toBe(120_000)
    gate.onRiskControl()
    const sent = vi.fn()
    const pending = gate.waitTurn().then(sent)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(sent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(sent).toHaveBeenCalledOnce()
  })

  it('uses bounded timers for server waits above the setTimeout integer limit', async () => {
    const gate = new BackoffGate()
    const controller = new AbortController()
    gate.onRiskControl(3_000_000_000)
    const pending = gate.waitTurn(controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })

  it('allows only one recovery probe, and releases its admission after failure or cancellation', async () => {
    const gate = new BackoffGate()
    gate.onRiskControl()
    const held = Promise.withResolvers<void>()
    const probe = gate.withRecoveryProbe(() => held.promise)
    await expect(gate.withRecoveryProbe(() => Promise.resolve())).rejects.toBeInstanceOf(RiskControlError)
    expect(gate.consecutiveHits).toBe(1)
    const checked = expect(probe).rejects.toMatchObject({ name: 'AbortError' })
    held.reject(new DOMException('Aborted', 'AbortError'))
    await checked
    expect(await gate.withRecoveryProbe(() => Promise.resolve('next'))).toBe('next')
  })

  it('spaces recovery traffic after the successful probe instead of resetting to a burst', async () => {
    const gate = new BackoffGate()
    gate.onRiskControl()
    const probe = gate.waitTurn()
    await vi.runAllTimersAsync()
    gate.onSuccess(await probe)
    const starts: number[] = []
    const batch = Array.from({ length: 3 }, () => gate.waitTurn().then(() => starts.push(Date.now())))
    await vi.runAllTimersAsync()
    await Promise.all(batch)
    expect(starts).toEqual([5_500, 6_000, 6_500])
    expect(gate.lastRecoveredAt).toBe(5_000)
    expect(gate.recentlyRecovered(2_000)).toBe(true)
  })

  it('old responses cannot clear a new cooldown or accelerate the recovery decay', async () => {
    const gate = new BackoffGate()
    const oldEpoch = await gate.waitTurn()
    gate.onRiskControl()
    gate.onRiskControl()
    gate.onSuccess(oldEpoch)
    expect(gate.isEngaged).toBe(true)
    gate.onSuccess(gate.riskEpoch)
    for (let i = 0; i < 100; i++) gate.onSuccess(oldEpoch)
    expect(gate.politeIntervalMs).toBe(800)
  })

  it('invalidates sleeping and queued old-epoch permits when a new risk response arrives', async () => {
    const gate = new BackoffGate()
    await gate.waitTurn()
    const first = gate.waitTurn().catch((error: unknown) => error)
    const second = gate.waitTurn().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    gate.onRiskControl()
    await vi.runAllTimersAsync()
    expect(await first).toBeInstanceOf(RiskControlError)
    expect(await second).toBeInstanceOf(RiskControlError)
  })

  it('requeues an old permit at the polite pace when a new epoch has already recovered', async () => {
    const gate = new BackoffGate()
    await gate.waitTurn()
    const old = gate.waitTurn()
    await vi.advanceTimersByTimeAsync(0)
    gate.onRiskControl()
    gate.onSuccess(gate.riskEpoch)
    await vi.runAllTimersAsync()
    expect(await old).toBe(gate.riskEpoch)
    expect(Date.now()).toBe(1_500)
  })

  it('raises the polite level on repeated risk and lowers only after sustained successful traffic', () => {
    const gate = new BackoffGate()
    for (const expected of [500, 800, 1200, 2000, 2000]) {
      gate.onRiskControl()
      expect(gate.politeIntervalMs).toBe(expected)
      gate.onSuccess(gate.riskEpoch)
    }
    for (let i = 1; i < BackoffGate.POLITE_DECAY_SUCCESSES; i++) gate.onSuccess(gate.riskEpoch)
    expect(gate.politeIntervalMs).toBe(1200)
    gate.onRiskControl()
    expect(gate.politeIntervalMs).toBe(2000)
  })

  it.each([0, 0.5, 0.999])('jitter never goes below the normal floor: random=%s', async (random) => {
    const gate = new BackoffGate(undefined, undefined, () => random)
    gate.onRiskControl()
    gate.onSuccess()
    await gate.waitTurn()
    const next = gate.waitTurn()
    await vi.runAllTimersAsync()
    await next
    expect(Date.now() - 1_000).toBe(Math.max(350, Math.round(500 * (1 + (random - 0.5) * 0.6))))
  })

  it('supports injectable time and sleep for deterministic simulations', async () => {
    let now = 0
    const gate = new BackoffGate(
      () => now,
      (ms) => {
        now += ms
        return Promise.resolve()
      },
    )
    await Promise.all(Array.from({ length: 20 }, () => gate.waitTurn()))
    expect(now).toBe(19 * BackoffGate.NORMAL_INTERVAL_MS)
  })
})

describe('search 滑动窗平滑', () => {
  it('窗内 12 发直通, 第 13 发等最老时间戳滑出后放行', async () => {
    const gate = new TagRecSlidingWindowGate(12, 10_000)
    for (let i = 0; i < 12; i++) await gate.acquire()
    let settled = false
    const blocked = gate.acquire().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(settled).toBe(false) // 最老发尚未滑出
    await vi.advanceTimersByTimeAsync(1_100)
    await blocked
    expect(settled).toBe(true)
  })

  it('等待中 abort 立即拒绝', async () => {
    const gate = new TagRecSlidingWindowGate(1, 10_000)
    await gate.acquire()
    const controller = new AbortController()
    const pending = gate.acquire(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
