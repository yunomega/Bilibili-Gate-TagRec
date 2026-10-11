/**
 * [tag-rec] 风控命中观测记录器 (票 10 设计稿 / 票 11 落码)
 *
 * - 目的: 为后续「查明风控规律」供数 —— 命中事件的原始证据 + 上下文 + 命中前速率窗
 * - 内存请求账 (ring, 不落盘): 匿名通道每请求 {ts, endpoint, outcome}; 命中时才快照进事件
 * - 事件 (仅命中/可疑码): 命中时快照请求账窗口 + 退避态 + 指纹态, 写 GM 每页键
 * - 存储: `tag-rec:risk-events:{pageId}` (每页 ring 100; 启动清理保留最近 KEEP_PAGE_KEYS 个)
 * - 读取: `window.__tagRecRiskLog = { dump, summary, clear }` (后续 agent 经 CDP evaluate 取数)
 * - 隐私白名单: 不记账号态数据 (mid/uname/cookie/access_key); body 截断; pageId 随机会话值不持久
 * - 观测器纪律: 全链路 fail-open —— 任何异常都不得影响请求主路径
 */
import { appWarn } from '$common'
import { isRiskControlResponse, tagRecBackoff } from './backoff'
import { getTagRecFingerprintStats } from './fingerprint'

export type TagRecRiskChannel = 'anon' | 'logged-in' | 'app'
export type TagRecRiskOutcome = 'ok' | 'risk' | 'suspicious' | 'error'

export const RISK_LOG_REQUEST_LEDGER_MAX = 512
export const RISK_LOG_EVENT_RING_MAX = 100
export const RISK_LOG_KEEP_PAGE_KEYS = 10
export const RISK_LOG_WINDOW_MS = 10 * 60_000
export const RISK_LOG_RECENT_SEQ_MAX = 60
export const RISK_LOG_BODY_SNIPPET_MAX = 200
/** 业务参数白名单 (可记; 分析要素) —— 其余参数一律不入事件 */
const PARAM_WHITELIST: ReadonlySet<string> = new Set([
  'keyword',
  'bvid',
  'tid',
  'tag_name',
  'tag_id',
  'term',
  'page',
  'pn', // tag/top、UP 投稿搜索等用 pn 分页 —— 缺它无法核对重复分页请求
])
/** 可疑码 (非风控判定, 但值得记录) —— 票 10 设计稿 Q1 */
const SUSPICIOUS_CODES: ReadonlySet<number> = new Set([-352, -799, -403, -101])

export type TagRecRiskEvent = {
  ts: number
  pageId: string
  channel: TagRecRiskChannel
  endpoint: string
  attempt?: number
  outcome: 'risk' | 'suspicious'
  status?: number
  code?: number
  message?: string
  bodySnippet?: string
  /** 业务参数白名单子集 */
  params?: Record<string, string>
  /** 命中时刻退避态快照 (记录于 onRiskControl 之前 = 命中发生时态) */
  backoff: { engaged: boolean; intervalMs: number; polite: boolean; politeMs: number; consecutiveHits: number }
  fingerprint: { has: boolean; disabled: boolean }
  /** 命中前 10min 内存请求账快照 */
  window: {
    windowMs: number
    total: number
    perEndpoint: Record<string, number>
    /** 最近 RECENT_SEQ_MAX 条: [agoMs, endpoint, outcome, 白名单参数 JSON?] —— 参数让重复分页可核对 */
    recent: [number, string, TagRecRiskOutcome, string?][]
  }
}

export type TagRecRiskSummary = {
  total: number
  byOutcome: Record<string, number>
  byEndpoint: Record<string, number>
  byChannel: Record<string, number>
  firstTs?: number
  lastTs?: number
}

/** 随机会话值: 每次页面加载新生成, 不持久、不可关联到用户 */
const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const STORAGE_KEY = `tag-rec:risk-events:${pageId}`
const STORAGE_KEY_PREFIX = 'tag-rec:risk-events:'

type LedgerEntry = { ts: number; endpoint: string; outcome: TagRecRiskOutcome; params?: Record<string, string> }
const ledger: LedgerEntry[] = []
const events: TagRecRiskEvent[] = []
let pruneStarted = false

// #region 开关 (懒读 settings, 防模块环; 默认开)
let enabledGetter: (() => boolean) | undefined
function riskLogEnabled(): boolean {
  if (!enabledGetter) {
    enabledGetter = () => true
    void import('$modules/settings')
      .then(({ settings }) => {
        enabledGetter = () => settings.tagRec?.riskLog?.enabled ?? true
      })
      .catch(() => undefined)
  }
  return enabledGetter()
}
// #endregion

// #region GM 存取 (fail-open; 测试环境无 GM 时静默降级为纯内存)
type GmSafe = {
  getValue?: (key: string, fallback: unknown) => Promise<unknown>
  setValue?: (key: string, value: unknown) => Promise<void>
  deleteValue?: (key: string) => Promise<void>
  listValues?: () => Promise<string[]>
}
function gmSafe(): GmSafe | undefined {
  try {
    return typeof GM === 'undefined' ? undefined : (GM as unknown as GmSafe)
  } catch {
    return undefined
  }
}
async function gmGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const gm = gmSafe()
    if (!gm?.getValue) return fallback
    return ((await gm.getValue(key, fallback)) ?? fallback) as T
  } catch {
    return fallback
  }
}
function gmSet(key: string, value: unknown): void {
  try {
    void gmSafe()
      ?.setValue?.(key, value)
      ?.catch(() => undefined)
  } catch {
    /* ignore */
  }
}
function gmDelete(key: string): void {
  try {
    void gmSafe()
      ?.deleteValue?.(key)
      ?.catch(() => undefined)
  } catch {
    /* ignore */
  }
}
// #endregion

/** 清理旧页键: 保留最近 KEEP_PAGE_KEYS 个 risk-events 键 (按键内最新事件 ts 排序; 本页键不在此刻存在) */
async function pruneOldPageKeys(): Promise<void> {
  const gm = gmSafe()
  if (!gm?.listValues) return
  const keys = (await gm.listValues().catch(() => [])).filter((k) => k.startsWith(STORAGE_KEY_PREFIX))
  if (keys.length <= RISK_LOG_KEEP_PAGE_KEYS) return
  const rows: { key: string; latest: number }[] = []
  for (const key of keys) {
    const list = await gmGet<TagRecRiskEvent[]>(key, [])
    rows.push({ key, latest: list.at(-1)?.ts ?? 0 })
  }
  rows.sort((a, b) => b.latest - a.latest)
  for (const row of rows.slice(RISK_LOG_KEEP_PAGE_KEYS)) gmDelete(row.key)
}

function pushLedger(entry: LedgerEntry): void {
  ledger.push(entry)
  if (ledger.length > RISK_LOG_REQUEST_LEDGER_MAX) ledger.splice(0, ledger.length - RISK_LOG_REQUEST_LEDGER_MAX)
}

function endpointOf(url: unknown): string {
  const s = String(url ?? '')
  const q = s.indexOf('?')
  return q !== -1 ? s.slice(0, q) : s
}

function bodySnippetOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data.slice(0, RISK_LOG_BODY_SNIPPET_MAX)
  if (data === undefined || data === null) return undefined
  if (typeof data !== 'object') return String(data).slice(0, RISK_LOG_BODY_SNIPPET_MAX)
  return undefined
}

function filterParams(params: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!params) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (PARAM_WHITELIST.has(k) && v !== undefined && v !== null) out[k] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

type ClassifyResult = { outcome: 'ok' | 'risk' | 'suspicious'; status?: number; code?: number; message?: string }

/** 匿名通道响应分类: 风控判定复用 backoff.isRiskControlResponse (单一事实源, 含非 JSON 规则);
 *  2xx 零字节空体 (tag/top 深页池底) 非风控特征, 先豁免防假命中入账 */
function classifyAnonResponse(res: { status?: number; data?: unknown; emptyBody?: boolean }): ClassifyResult {
  const status = res.status
  if (res.emptyBody && status !== undefined && status >= 200 && status < 300) return { outcome: 'ok', status }
  const data = res.data as { code?: number; message?: string } | undefined
  if (isRiskControlResponse({ status: status ?? 0, data })) {
    return {
      outcome: 'risk',
      status,
      code: data && typeof data === 'object' ? data.code : undefined,
      message: data?.message,
    }
  }
  if (data && typeof data === 'object' && typeof data.code === 'number' && SUSPICIOUS_CODES.has(data.code)) {
    return { outcome: 'suspicious', status, code: data.code, message: data.message }
  }
  return { outcome: 'ok', status }
}

/**
 * 上游通道响应分类 (最小钩子): 只认 HTTP 412 / code -412 / 可疑码 ——
 * 不用非 JSON 规则 (上游含 responseType:'text' 的页面抓取, 会误报)
 */
function classifyUpstreamResponse(res: { status?: number; data?: unknown }): ClassifyResult {
  const status = res.status
  const data = res.data as { code?: number; message?: string } | undefined
  if (status === 412) return { outcome: 'risk', status }
  if (data && typeof data === 'object' && typeof data.code === 'number') {
    if (data.code === -412) return { outcome: 'risk', status, code: data.code, message: data.message }
    if (SUSPICIOUS_CODES.has(data.code))
      return { outcome: 'suspicious', status, code: data.code, message: data.message }
  }
  return { outcome: 'ok', status }
}

function buildEvent(args: {
  channel: TagRecRiskChannel
  endpoint: string
  attempt?: number
  outcome: 'risk' | 'suspicious'
  status?: number
  code?: number
  message?: string
  bodySnippet?: string
  params?: Record<string, string>
}): TagRecRiskEvent {
  const now = Date.now()
  const total = ledger.length
  const perEndpoint: Record<string, number> = {}
  for (const e of ledger) perEndpoint[e.endpoint] = (perEndpoint[e.endpoint] ?? 0) + 1
  const recent: [number, string, TagRecRiskOutcome, string?][] = ledger
    .slice(-RISK_LOG_RECENT_SEQ_MAX)
    .map((e): [number, string, TagRecRiskOutcome, string?] =>
      e.params ? [now - e.ts, e.endpoint, e.outcome, JSON.stringify(e.params)] : [now - e.ts, e.endpoint, e.outcome],
    )
  let fingerprint = { has: false, disabled: false }
  try {
    fingerprint = getTagRecFingerprintStats()
  } catch {
    /* ignore */
  }
  return {
    ts: now,
    pageId,
    channel: args.channel,
    endpoint: args.endpoint,
    attempt: args.attempt,
    outcome: args.outcome,
    status: args.status,
    code: args.code,
    message: args.message,
    bodySnippet: args.bodySnippet,
    params: args.params,
    backoff: {
      engaged: !!tagRecBackoff?.isEngaged,
      intervalMs: tagRecBackoff?.currentIntervalMs ?? 0,
      polite: tagRecBackoff?.isPolite ?? false,
      politeMs: tagRecBackoff?.politeIntervalMs ?? 0,
      consecutiveHits: tagRecBackoff?.consecutiveHits ?? 0,
    },
    fingerprint,
    window: { windowMs: RISK_LOG_WINDOW_MS, total, perEndpoint, recent },
  }
}

function pushEvent(event: TagRecRiskEvent): void {
  events.push(event)
  if (events.length > RISK_LOG_EVENT_RING_MAX) events.splice(0, events.length - RISK_LOG_EVENT_RING_MAX)
  if (!pruneStarted) {
    pruneStarted = true
    void pruneOldPageKeys().catch(() => undefined)
  }
  gmSet(STORAGE_KEY, events)
}

/**
 * 匿名通道每请求记账 (endpoints.ts anonGetJson 调用)。
 * - 所有结果进内存请求账; 命中/可疑码另建事件 (快照在 onRiskControl 之前 = 命中发生时态)
 * - abort 不入账 (未出网, 纯噪音); 网络失败入账 outcome='error' 不建事件
 */
export function recordAnonRequest(args: {
  endpoint: string
  attempt: number
  params?: Record<string, unknown>
  res?: { status: number; data: unknown; emptyBody?: boolean }
  err?: unknown
}): void {
  try {
    if (!riskLogEnabled()) return
    const endpoint = endpointOf(args.endpoint)
    if (args.err !== undefined) {
      if (args.err instanceof DOMException && args.err.name === 'AbortError') return
      pushLedger({ ts: Date.now(), endpoint, outcome: 'error', params: filterParams(args.params) })
      return
    }
    if (!args.res) return
    const c = classifyAnonResponse(args.res)
    pushLedger({ ts: Date.now(), endpoint, outcome: c.outcome, params: filterParams(args.params) })
    if (c.outcome === 'ok') return
    pushEvent(
      buildEvent({
        channel: 'anon',
        endpoint,
        attempt: args.attempt,
        outcome: c.outcome,
        status: c.status,
        code: c.code,
        message: c.message,
        bodySnippet: bodySnippetOf(args.res.data),
        params: filterParams(args.params),
      }),
    )
  } catch (e) {
    try {
      appWarn('[tag-rec] risk-log record failed: %o', e)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 上游通道最小钩子 (request.tsx 拦截器调用): 只记命中/可疑码事件, 无流水。
 */
export function recordUpstreamResponse(
  channel: 'logged-in' | 'app',
  url: unknown,
  res: { status?: number; data?: unknown },
): void {
  try {
    if (!riskLogEnabled()) return
    const c = classifyUpstreamResponse(res)
    if (c.outcome === 'ok') return
    pushEvent(
      buildEvent({
        channel,
        endpoint: endpointOf(url),
        outcome: c.outcome,
        status: c.status,
        code: c.code,
        message: c.message,
        bodySnippet: bodySnippetOf(res.data),
      }),
    )
  } catch (e) {
    try {
      appWarn('[tag-rec] risk-log upstream record failed: %o', e)
    } catch {
      /* ignore */
    }
  }
}

// #region 读取面 (window.__tagRecRiskLog; 后续 agent 经 CDP evaluate 取数)
/** 合并所有页键 (含本页内存态) 的全部事件, 按 ts 升序 */
export async function dump(): Promise<{ generatedAt: number; pageCount: number; events: TagRecRiskEvent[] }> {
  const gm = gmSafe()
  const keys = gm?.listValues
    ? (await gm.listValues().catch(() => [])).filter((k) => k.startsWith(STORAGE_KEY_PREFIX))
    : []
  const pages: TagRecRiskEvent[][] = []
  let hasSelf = false
  for (const key of keys) {
    if (key === STORAGE_KEY) {
      hasSelf = true
      pages.push([...events])
      continue
    }
    pages.push(await gmGet<TagRecRiskEvent[]>(key, []))
  }
  if (!hasSelf && events.length) pages.push([...events])
  const all = pages.flat().sort((a, b) => a.ts - b.ts)
  return { generatedAt: Date.now(), pageCount: pages.length, events: all }
}

export async function summary(): Promise<TagRecRiskSummary> {
  const { events: all } = await dump()
  const byOutcome: Record<string, number> = {}
  const byEndpoint: Record<string, number> = {}
  const byChannel: Record<string, number> = {}
  for (const e of all) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1
    byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] ?? 0) + 1
    byChannel[e.channel] = (byChannel[e.channel] ?? 0) + 1
  }
  return {
    total: all.length,
    byOutcome,
    byEndpoint,
    byChannel,
    firstTs: all[0]?.ts,
    lastTs: all.at(-1)?.ts,
  }
}

/** 清空本页记录 (内存 + 本页 GM 键); 其它页键不动 */
export function clear(): void {
  events.length = 0
  ledger.length = 0
  gmDelete(STORAGE_KEY)
}

function installGlobal(): void {
  try {
    // [tag-rec] TM 沙箱下 window 为 proxy, 写不到页面主世界 —— 暴露须走 unsafeWindow
    //   (同 components/RecGrid/unsafe-window-export 模式; 票 12 实机发现: window 写入不可达)
    const win = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : globalThis) as Record<string, unknown>
    win.__tagRecRiskLog = { dump, summary, clear }
  } catch {
    /* ignore */
  }
}
installGlobal()
// #endregion
