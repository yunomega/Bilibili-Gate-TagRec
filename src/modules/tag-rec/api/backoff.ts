import { isAxiosError } from 'axios'
import { pLimit } from 'promise.map'
import { abortableDelay } from './abortable-delay'

/**
 * [tag-rec] 节流与退避 (spec §2.3)
 * - 首次请求立即放行, 后续请求至少间隔 350ms; 并发上限 4 (pLimit)
 * - 命中 -412 / HTTP 412 / 非 JSON 响应 => 指数退避, 请求间隔 >= 4s 起步
 */

/** 命中风控 (HTTP 412/429、风控业务码、验证码特征体、非 JSON 响应) 抛出的错误 */
export class RiskControlError extends Error {
  constructor(public response?: { status: number; data: unknown }) {
    super('[tag-rec] hit risk-control (-412 / non-JSON response)')
    this.name = 'RiskControlError'
  }
}

type RiskShapedBody = {
  code?: number
  v_voucher?: unknown
  data?: { is_risk?: unknown; gaia_res_type?: unknown; gaia_data?: unknown; v_voucher?: unknown }
}

/**
 * 判定响应命中风控 —— 与 up-search.isUpSearchRisk 同口径 (两通道分级一致):
 * HTTP 412/429、业务码 -412/-352/-401/-101、顶层或 data.data 下的验证码特征
 * (v_voucher / is_risk / gaia_res_type / gaia_data)、响应体非 JSON (风控页返回 HTML)。
 * code=0 的验证载荷也在这里拦截 —— 不放行给各端点解析成「空结果」污染干态/exhausted。
 */
export function isRiskControlResponse(res: { status: number; data: unknown }): boolean {
  if (res.status === 412 || res.status === 429) return true
  const data = res.data as RiskShapedBody | undefined
  if (!data || typeof data !== 'object') return true // 非 JSON body (HTML 风控页等)
  if (typeof data.code === 'number' && [-412, -352, -401, -101].includes(data.code)) return true
  if (data.v_voucher) return true
  const body = data.data
  if (body && typeof body === 'object' && (body.is_risk || body.gaia_res_type || body.gaia_data || body.v_voucher))
    return true
  return false
}

/** 判定抛出的错误命中风控 */
export function isRiskControlError(err: unknown): boolean {
  if (err instanceof RiskControlError) return true
  if (isAxiosError(err) && err.response) return isRiskControlResponse(err.response)
  return false
}

/**
 * 退避闸门: 记录"是否处于风控退避态"与请求时隙 (票 16 决议)
 * - 正常态亦按实际发送时间留出 350ms 基线间隔, 不积累突发额度
 * - 退避态 waitTurn 排队到 >= intervalMs 的下一个时隙; 连续命中 interval 指数翻倍
 * - 当前代次的有效请求成功才退出退避态
 * - 粘性节流 (票 16 ④): 会话内命中过一次风控后, 正常态也强加 polite 基线间隔
 * - polite 自适应阶梯: 首撞落 500ms; 阶梯内再撞逐级升档 (800/1200/2000 顶),
 *   连续成功 DECAY 次降一档 —— 谨慎恢复, 不把单次成功当作无限速许可
 * - polite 时隙 ±30% 抖动: 分散恢复后的集中负载; 退避时隙不抖且始终尊重服务端等待时间
 * - consecutiveHits: 连续命中计数 (仅诊断使用; 不轮换身份)
 * - onStateChange: 退避态进出回调 (横幅槽位消费, 票 16 ③)
 * 时间源与 sleep 可注入, 便于单测
 */
export class BackoffGate {
  static readonly NORMAL_INTERVAL_MS = 350 // Local conservative pacing, not an upstream quota.
  static readonly BASE_INTERVAL_MS = 4_000 // spec: 退避至 >=4s 间隔
  static readonly MAX_INTERVAL_MS = 60_000
  /** 粘性节流阶梯: 首撞落阶 0; 阶梯内再撞逐级升档; 连续成功 POLITE_DECAY_SUCCESSES 次降一档 */
  static readonly POLITE_INTERVAL_MS = 500
  static readonly POLITE_STEPS_MS = [500, 800, 1200, 2000] as const
  static readonly POLITE_DECAY_SUCCESSES = 30
  /** polite 间隔抖动 ±30% (rand=0.5 时不抖 —— 测试注入定值) */
  static readonly POLITE_JITTER = 0.3

  private engaged = false
  private intervalMs = BackoffGate.BASE_INTERVAL_MS
  private nextSlotAt = 0
  private lastStartedAt = -Infinity
  private serverNotBefore = 0
  private turnActive = false
  private readonly turnQueue = new Set<() => void>()
  private polite = false
  private politeLevel = 0
  private successStreak = 0
  private hits = 0
  private recoveryProbePending = false
  /** 风控代次: 每次 onRiskControl 递增 —— 旧代次发出的回包不算本代恢复证据, 睡醒复检用 */
  private epoch = 0
  /** 上次退避解除时刻 (onSuccess 从退避态退出时记; 0 = 本会话未恢复过) —— 票 38 D */
  private recoveredAt = 0

  /** 退避态进出回调 (横幅订阅) */
  onStateChange?: (engaged: boolean, intervalMs: number) => void

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep?: (ms: number) => Promise<void>,
    private readonly rand: () => number = () => 0.5,
  ) {}

  /** 当前 polite 阶梯档间隔; 未命中过风控 => 0 */
  get politeIntervalMs() {
    return this.polite ? BackoffGate.POLITE_STEPS_MS[this.politeLevel] : 0
  }

  /** 当前生效的请求间隔; 0 = 未在退避态 */
  get currentIntervalMs() {
    return this.engaged ? Math.max(this.intervalMs, this.serverNotBefore - this.now()) : 0
  }

  /** 是否处于退避态 (横幅/直通判定) */
  get isEngaged() {
    return this.engaged
  }

  /** 连续风控命中数 (诊断使用; 成功清零) */
  get consecutiveHits() {
    return this.hits
  }

  /** 本会话是否命中过风控 (粘性位; 记录器快照用, 票 11) */
  get isPolite() {
    return this.polite
  }

  /** 当前风控代次 (waitTurn 放行时刻回传给 onSuccess 配对用) */
  get riskEpoch() {
    return this.epoch
  }

  /** 上次退避解除时刻 (0 = 本会话未恢复过; 供消费侧按时刻去重, 票 38 D) */
  get lastRecoveredAt() {
    return this.recoveredAt
  }

  /**
   * 距上次退避解除 <= ms 为真 (票 38 D: 恢复后首个 digPass 半批探活)
   * 只读位不消费 —— 「首个 pass」的一次性语义由消费侧持标记保证
   */
  recentlyRecovered(ms: number) {
    return this.recoveredAt > 0 && this.now() - this.recoveredAt <= ms
  }

  /** 退避期只允许一个恢复请求等待/发送, 其余请求立即失败, 不堆积整批退避时隙。 */
  async withRecoveryProbe<T>(request: () => Promise<T>): Promise<T> {
    if (!this.engaged) return request()
    if (this.recoveryProbePending) throw new RiskControlError()
    this.recoveryProbePending = true
    try {
      return await request()
    } finally {
      this.recoveryProbePending = false
    }
  }

  /**
   * Serialize permits, not HTTP requests. Only an actual permit consumes a slot.
   * Queued cancellation removes its task immediately; a delayed browser timer cannot
   * release several overdue reservations as one burst. Old-epoch tasks must return to
   * withRecoveryProbe after a new risk response rather than sending without admission.
   */
  waitTurn(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    const requestedEpoch = this.epoch
    return new Promise<number>((resolve, reject) => {
      const detach = () => signal?.removeEventListener('abort', onAbort)
      const onAbort = () => {
        if (!this.turnQueue.delete(start)) return
        detach()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const start = () => {
        this.turnActive = true
        detach()
        this.takeTurn(requestedEpoch, signal)
          .then(resolve, reject)
          .finally(() => {
            this.turnActive = false
            this.drainTurns()
          })
      }
      this.turnQueue.add(start)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.drainTurns()
    })
  }

  private drainTurns() {
    if (this.turnActive) return
    const next = this.turnQueue.values().next().value
    if (next) {
      this.turnQueue.delete(next)
      next()
    }
  }

  private async takeTurn(requestedEpoch: number, signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (this.epoch !== requestedEpoch && this.engaged) throw new RiskControlError()
      const epoch = this.epoch
      const delay = Math.max(this.nextSlotAt, this.serverNotBefore) - this.now()
      if (delay > 0) {
        // setTimeout overflows above 2^31-1; recheck long server deadlines in bounded chunks.
        await this.sleepAbortable(Math.min(delay, 2_147_483_647), signal)
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (this.epoch !== epoch && this.engaged) throw new RiskControlError()
        continue // Recheck actual time after timer throttling or clock changes.
      }
      const base = this.engaged ? this.intervalMs : this.politeIntervalMs || BackoffGate.NORMAL_INTERVAL_MS
      const gap =
        this.engaged || !this.polite
          ? base
          : Math.max(
              BackoffGate.NORMAL_INTERVAL_MS,
              Math.round(base * (1 + (this.rand() - 0.5) * 2 * BackoffGate.POLITE_JITTER)),
            )
      this.lastStartedAt = this.now()
      this.nextSlotAt = this.lastStartedAt + gap
      return this.epoch
    }
  }

  private sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const detach = () => {
        signal?.removeEventListener('abort', onAbort)
        if (timer !== undefined) clearTimeout(timer)
      }
      const onAbort = () => {
        detach()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (this.sleep) {
        Promise.resolve()
          .then(() => {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            return this.sleep!(ms)
          })
          .then(
            () => {
              detach()
              resolve()
            },
            (error: unknown) => {
              detach()
              reject(error)
            },
          )
      } else {
        timer = setTimeout(() => {
          detach()
          resolve()
        }, ms)
      }
    })
  }

  /**
   * 当前代次收到有效业务成功后退出退避态，但保留探针后的 polite 间隔和服务端等待期限。
   * 正常态成功不重置下一发送时刻，防止串行请求因每次成功清零而绕过节流。
   */
  onSuccess(sentEpoch?: number) {
    // 审计 6.1: 命中发生前发出 (旧代次) 的回包不算本代恢复证据 —— 只有本代准发的
    //   请求 (恢复探针/睡醒复检后按新时隙发送者) 拿到有效成功才确认恢复
    if (sentEpoch !== undefined && sentEpoch !== this.epoch) return
    const was = this.engaged
    this.engaged = false
    this.intervalMs = BackoffGate.BASE_INTERVAL_MS
    this.hits = 0
    this.successStreak += 1
    if (this.politeLevel > 0 && this.successStreak >= BackoffGate.POLITE_DECAY_SUCCESSES) {
      this.politeLevel -= 1
      this.successStreak = 0
    }
    if (was) {
      this.nextSlotAt = Math.max(this.now(), this.lastStartedAt + this.politeIntervalMs, this.serverNotBefore)
      this.recoveredAt = this.now() // 票 38 D: 记恢复时刻 (recentlyRecovered/lastRecoveredAt 消费)
      this.onStateChange?.(false, 0)
    }
  }

  /**
   * 命中风控后调用: 进入退避态, 已处退避态则间隔翻倍 (封顶 MAX_INTERVAL_MS); 并开启本会话粘性节流。
   * 首次命中提高本地间隔至阶 0，后续命中逐级降低负载。
   * 这些是本地保守策略，不推断服务端的风控原因或承诺安全请求配额。
   */
  onRiskControl(retryAfterMs = 0) {
    this.epoch += 1
    if (this.polite) this.politeLevel = Math.min(this.politeLevel + 1, BackoffGate.POLITE_STEPS_MS.length - 1)
    this.polite = true
    this.successStreak = 0
    this.hits += 1
    // 连续退避逐级加深: 第 2 次直接跳 30s 档, 第 3 次起 60s —— 更快进入低负载平稳态
    this.intervalMs = this.engaged
      ? Math.min(Math.max(this.intervalMs * 2, 30_000), BackoffGate.MAX_INTERVAL_MS)
      : BackoffGate.BASE_INTERVAL_MS
    this.engaged = true
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0)
      this.serverNotBefore = Math.max(this.serverNotBefore, this.now() + retryAfterMs)
    this.nextSlotAt = Math.max(this.now() + this.intervalMs, this.serverNotBefore)
    this.onStateChange?.(true, this.currentIntervalMs)
  }
}

/**
 * [tag-rec] search 专用滑动窗平滑器: 收敛连续深挖的请求突发, 批次排队通过、节奏更平稳
 *   (体验优化面; 与全局平滑节流同族)。越窗请求等待最老时间戳滑出, 宽窗批次自动摊平。
 *   接入 fetchAllV2Search 唯一入口。
 */
export class TagRecSlidingWindowGate {
  private stamps: number[] = []
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** 测试/语境重置用 */
  reset() {
    this.stamps = []
  }
  /** 窗口内取一席; 满窗则等最老时间戳滑出 (可中止) */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const t = this.now()
      while (this.stamps.length && t - this.stamps[0]! >= this.windowMs) this.stamps.shift()
      if (this.stamps.length < this.limit) {
        this.stamps.push(t)
        return
      }
      await abortableDelay(Math.max(1, this.stamps[0]! + this.windowMs - t), signal)
    }
  }
}

/** 本特性共享平滑限速、退避与并发上限 (tag/top 等池拉取并发 <=4) */
export const tagRecBackoff = new BackoffGate(undefined, undefined, Math.random)
export const tagRecLimit = pLimit(4)
/** all/v2 搜索道专用并发: 叠加在 tagRecLimit/RecallScheduler 内层取严 —— 体验向更稳节奏, 前台等待态也封顶 2 */
export const allV2Limit = pLimit(2)
/** search 滑动窗平滑器单例 */
export const tagRecSearchGate = new TagRecSlidingWindowGate(12, 10_000)
/** 测试用: 清滑动窗账 (模块级单例跨用例累计会误触发等待) */
export function __resetTagRecSearchGateForTest() {
  tagRecSearchGate.reset()
}
