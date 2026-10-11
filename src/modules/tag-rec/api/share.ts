import { fetchLoginInfo } from '$modules/bilibili/user/login-info'
import { normalizeShareRejections, type ShareRejectItem } from '../model/share'
import type { TagRecConfigExportV1 as ExportPayload } from '../model/import-export'

/**
 * [tag-rec] 分享平台 API 通道 (tag-share-platform spec §5 / 票 16)
 * - GM_xhr 直连分享域 (跨域不吃 CORS); anonymous:true —— 不携 bilibili cookie 出域
 * - 不复用 $request 的 gmrequest: 其拦截器注入 appkey/access_key/sign (B 站凭据) 会泄给第三方;
 *   与 api/request.ts 「不引 gmrequest」同口径
 * - meta `connect` 须含该域 —— vite.config.ts [tag-rec] connect 数组同步维护
 */

/**
 * 平台基址 (同域部署 => API 与网站同根):
 * - dev 联调改指 http://localhost:8787 (wrangler dev) / SITE_BASE → http://localhost:8000
 * - 改这里 + vite.config.ts connect 两处即完成换域
 */
export const TAG_REC_SHARE_API_BASE = 'https://www.tagrec.cn'
/** 分享网站基址 (「复制链接/打开分享页」拼接源; 同域部署与 API 同根; 规范域=www, apex 重定向至此) */
export const TAG_REC_SHARE_SITE_BASE = 'https://www.tagrec.cn'

// #region 身份 (spec §5: x/web-interface/nav 取 mid+uname+face; 未登录拒传)
export type ShareUploader = { mid: number; nickname: string; avatar?: string }

/**
 * [tag-rec] UIUX-U1-8: 上传者身份三态 —— 「确认未登录」与「登录态读取失败」分流
 * (原同压成 undefined, 失败态出不了「重试」): user=就绪 / not-logged-in=确认未登录 / error=拉取失败或响应畸形
 */
export type ShareUploaderOutcome = { kind: 'user'; user: ShareUploader } | { kind: 'not-logged-in' } | { kind: 'error' }

/**
 * 上传者身份: 复用 nav 拉取点 fetchLoginInfo (axios withCredentials, 页面登录态);
 * 未登录 => not-logged-in (调用侧引导登录); 请求失败/Result Err/响应畸形 => error (调用侧给重试);
 * uname 缺 => UID 回落;
 * 票34: face 同字段顺带上送为头像 —— 服务端零 B 站调用,仅做域白名单归一 (非法值服务端置 null)
 */
export async function fetchShareUploader(): Promise<ShareUploaderOutcome> {
  const res = await fetchLoginInfo().catch(() => undefined)
  const info = res?.isOk() ? res.value : undefined
  if (!info) return { kind: 'error' }
  if (!info.isLogin) return { kind: 'not-logged-in' }
  // LoginInfo | AnonymousLoginInfo 联合: mid/uname/face 只在登录档有 —— 逐字段取防收窄歧义
  const mid = (info as { mid?: unknown }).mid
  const uname = (info as { uname?: unknown }).uname
  const face = (info as { face?: unknown }).face
  if (typeof mid !== 'number' || !Number.isSafeInteger(mid) || mid <= 0) return { kind: 'error' }
  return {
    kind: 'user',
    user: {
      mid,
      nickname: (typeof uname === 'string' && uname.trim()) || `UID:${mid}`,
      ...(typeof face === 'string' && face.trim() ? { avatar: face.trim() } : {}),
    },
  }
}
// #endregion

// #region POST /api/shares
export type ShareUploadBody = {
  mid: number
  nickname: string
  /** 头像 URL (nav.face 顺字段); 服务端仅收 B 站图床域 (hdslb/biliimg), 非法值落 null 不阻断上传 (票34) */
  avatar?: string
  title: string
  description?: string
  payload: ExportPayload
}

export type ShareUploadOutcome =
  | { kind: 'ok'; id: string; mgmtToken: string; status: string }
  | { kind: 'rejected'; issues: ShareRejectItem[] } // 400/422 结构化拒绝 (防护档/审核; 票35起内容类拒绝归 422), 逐条列
  | { kind: 'failed'; message: string } // 网络错/超时/非预期响应 —— 兜底 toast

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type ShareHttpOutcome = { kind: 'response'; status: number; json: unknown } | { kind: 'failed'; message: string }

/** One anonymous transport for sharing. Writes are never retried automatically. */
function shareHttpRequest(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
    body?: unknown
    headers?: Record<string, string>
    timeout?: number
    signal?: AbortSignal
  } = {},
): Promise<ShareHttpOutcome> {
  const { signal } = options
  if (signal?.aborted) return Promise.resolve({ kind: 'failed', message: '请求已取消' })
  return new Promise((resolve) => {
    let settled = false
    let handle: { abort: () => void } | undefined
    let handleAborted = false
    const finish = (outcome: ShareHttpOutcome) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const fail = (message: string) => finish({ kind: 'failed', message })
    const abortHandle = () => {
      if (!handle || handleAborted) return
      handleAborted = true
      try {
        handle.abort()
      } catch {
        /* Local cancellation has already settled. */
      }
    }
    const onAbort = () => {
      fail('请求已取消')
      abortHandle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const data = options.body === undefined ? undefined : JSON.stringify(options.body)
      handle = GM.xmlHttpRequest({
        method: options.method ?? 'GET',
        url: `${TAG_REC_SHARE_API_BASE}${path}`,
        anonymous: true,
        responseType: 'text',
        timeout: options.timeout ?? 15_000,
        headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
        ...(data === undefined ? {} : { data }),
        onload(res) {
          let json: unknown
          try {
            json = JSON.parse(res.responseText ?? '')
          } catch {
            json = undefined
          }
          finish({ kind: 'response', status: res.status, json })
        },
        onerror: () => fail('网络请求失败'),
        ontimeout: () => fail('请求超时'),
        onabort: () => fail('请求已取消'),
      })
      if (signal?.aborted) onAbort()
    } catch {
      // Includes absent GM APIs and serialization failures; never expose credentials.
      fail('请求无法发起')
    }
  })
}

/**
 * POST {API_BASE}/api/shares —— 成功 201 {id, mgmtToken, status};
 * 400/422 {error, field?, reason, word?, category?} 或 {reasons:[...]} => rejected 逐条;
 * 其余状态码/网络失败 => failed 兜底
 */
export async function uploadShare(body: ShareUploadBody): Promise<ShareUploadOutcome> {
  const res = await shareHttpRequest('/api/shares', { method: 'POST', body, timeout: 20_000 })
  if (res.kind === 'failed') return res
  const { status, json } = res
  if (status >= 200 && status < 300) {
    const d = isObj(json) ? json : {}
    if (typeof d.id === 'string' && d.id && typeof d.mgmtToken === 'string' && d.mgmtToken)
      return {
        kind: 'ok',
        id: d.id,
        mgmtToken: d.mgmtToken,
        status: typeof d.status === 'string' ? d.status : 'published',
      }
    return { kind: 'failed', message: `服务端响应不完整 (HTTP ${status})` }
  }
  if (status === 400 || status === 422) {
    const issues = normalizeShareRejections(json)
    if (issues.length) return { kind: 'rejected', issues }
  }
  const reason = isObj(json) && typeof json.reason === 'string' ? json.reason : ''
  return { kind: 'failed', message: reason || `HTTP ${status}` }
}
// #endregion

// #region GET /api/shares/:id (spec §3 / 票 18 深链导入)
/**
 * 分享详情 (meta + 完整 payload): payload 为服务端已解析的导出格式对象,
 * 结构校验不归此层 —— 调用侧经 parseTagRecConfig(JSON.stringify(payload)) 走同一归一层
 */
export type ShareDetail = {
  id: string
  mid: number
  nickname: string
  avatar?: string | null
  title: string
  description?: string
  likesCount: number
  groupCount: number
  idCount: number
  createdAt?: number
  /**
   * 行状态 (pending|published|removed): meta 字段, 「我的分享」reconcile 探测消费 (票 17);
   * 非 published 仅持有效 X-Mgmt-Token 的请求才看得到 (worker getShare 口径)
   */
  status?: string
  payload: unknown
}

export type ShareDetailOutcome =
  | { kind: 'ok'; detail: ShareDetail }
  | { kind: 'not-found' } // 404 (不存在/已下架/非 published 无 token —— 服务端不暴露存在性, 同一语义)
  | { kind: 'failed'; message: string } // 网络错/超时/非预期响应 —— 兜底 toast

const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 响应体逐字段归一: 关键字段 (id/mid/title/payload) 畸形 => undefined (响应不完整); 计数缺省 0 */
function normalizeShareDetail(d: Record<string, unknown>): ShareDetail | undefined {
  if (typeof d.id !== 'string' || !d.id) return undefined
  if (typeof d.mid !== 'number' || !Number.isSafeInteger(d.mid) || d.mid <= 0) return undefined
  if (typeof d.title !== 'string' || !d.title) return undefined
  if (!isObj(d.payload)) return undefined
  const createdAt = numOr0(d.created_at)
  return {
    id: d.id,
    mid: d.mid,
    title: d.title,
    nickname: typeof d.nickname === 'string' && d.nickname ? d.nickname : `UID:${d.mid}`,
    avatar: typeof d.avatar === 'string' && d.avatar ? d.avatar : undefined,
    description: typeof d.description === 'string' && d.description ? d.description : undefined,
    likesCount: numOr0(d.likes_count),
    groupCount: numOr0(d.group_count),
    idCount: numOr0(d.id_count),
    ...(createdAt && { createdAt }),
    ...(typeof d.status === 'string' && d.status ? { status: d.status } : {}),
    payload: d.payload,
  }
}

/**
 * GET {API_BASE}/api/shares/<id> —— 200 => ok; 404 => not-found (存在性不区分: 不存在/下架/待审同态);
 * 其余状态码/网络失败 => failed 兜底 (调用侧 toast 不崩)
 * 票 17: opts.mgmtToken 在 => 携 X-Mgmt-Token 头 (「我的分享」reconcile 探测 pending/removed 可见性,
 * 响应 meta 带 status); 不带 token 的公开档行为不变
 */
export async function getShareDetail(
  shareId: string,
  opts?: { mgmtToken?: string; signal?: AbortSignal },
): Promise<ShareDetailOutcome> {
  const res = await shareHttpRequest(`/api/shares/${encodeURIComponent(shareId)}`, {
    signal: opts?.signal,
    ...(opts?.mgmtToken ? { headers: { 'X-Mgmt-Token': opts.mgmtToken } } : {}),
  })
  if (res.kind === 'failed') return res
  const { status, json } = res
  if (status === 404) return { kind: 'not-found' }
  if (status >= 200 && status < 300) {
    const detail = isObj(json) ? normalizeShareDetail(json) : undefined
    return detail?.id === shareId
      ? { kind: 'ok', detail }
      : { kind: 'failed', message: `服务端响应不完整 (HTTP ${status})` }
  }
  const reason = isObj(json) && typeof json.reason === 'string' ? json.reason : ''
  return { kind: 'failed', message: reason || `HTTP ${status}` }
}
// #endregion

// #region PATCH/DELETE /api/shares/:id (spec §3 / 票 17「我的分享」管理)
/**
 * PATCH 可改字段 (worker validatePatchBody 同口径): title/description/payload 至少其一;
 * description=null = 显式清空; 携 payload => 服务端防护档校验 + 全量重审 (过→published/故障→回 pending)
 */
export type SharePatchFields = { title?: string; description?: string | null; payload?: Record<string, unknown> }

export type SharePatchOutcome =
  | { kind: 'ok'; id: string; title?: string; description?: string | null; status?: string } // 返 meta
  | { kind: 'rejected'; issues: ShareRejectItem[] } // 400/422 结构化拒绝 (防护/审核; 票35 同上传双认), 逐条列
  | { kind: 'unauthorized' } // 401/403 X-Mgmt-Token 失效 (服务端已删或 GM 被清)
  | { kind: 'not-found' } // 404 服务端不存在
  | { kind: 'conflict' } // 409 已 removed 不可再编辑
  | { kind: 'failed'; message: string } // 网络错/超时/其余状态码 —— 兜底 toast

/**
 * PATCH {API_BASE}/api/shares/<id> —— 携 X-Mgmt-Token 改 title/description/payload;
 * 200 => ok (meta 回填本地记账); 400/422 => rejected 逐条 (票35 双认); 401/403 => unauthorized; 404 => not-found;
 * 409 => conflict (removed 态不可编辑); 503 (审核暂不可用) 及其余 => failed
 */
export async function patchShare(
  shareId: string,
  mgmtToken: string,
  fields: SharePatchFields,
): Promise<SharePatchOutcome> {
  const res = await shareHttpRequest(`/api/shares/${encodeURIComponent(shareId)}`, {
    method: 'PATCH',
    body: fields,
    timeout: 20_000,
    headers: { 'X-Mgmt-Token': mgmtToken },
  })
  if (res.kind === 'failed') return res
  const { status, json } = res
  if (status >= 200 && status < 300) {
    const d = isObj(json) ? json : {}
    return {
      kind: 'ok',
      id: typeof d.id === 'string' && d.id ? d.id : shareId,
      ...(typeof d.title === 'string' && d.title ? { title: d.title } : {}),
      ...(typeof d.description === 'string' || d.description === null ? { description: d.description } : {}),
      ...(typeof d.status === 'string' && d.status ? { status: d.status } : {}),
    }
  }
  if (status === 400 || status === 422) {
    const issues = normalizeShareRejections(json)
    if (issues.length) return { kind: 'rejected', issues }
  }
  if (status === 401 || status === 403) return { kind: 'unauthorized' }
  if (status === 404) return { kind: 'not-found' }
  if (status === 409) return { kind: 'conflict' }
  const reason = isObj(json) && typeof json.reason === 'string' ? json.reason : ''
  return { kind: 'failed', message: reason || `HTTP ${status}` }
}

export type ShareDeleteOutcome =
  | { kind: 'ok' } // 200 {id, status:'removed'} (软删幂等: 已 removed 再删同样 200)
  | { kind: 'unauthorized' } // 401/403 token 失效
  | { kind: 'not-found' } // 404 服务端不存在
  | { kind: 'failed'; message: string }

/**
 * DELETE {API_BASE}/api/shares/<id> —— 携 X-Mgmt-Token 软删 (status=removed);
 * 服务端幂等: 已 removed 再删 => 200 原状返回
 */
export async function deleteShare(shareId: string, mgmtToken: string): Promise<ShareDeleteOutcome> {
  const res = await shareHttpRequest(`/api/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: { 'X-Mgmt-Token': mgmtToken },
  })
  if (res.kind === 'failed') return res
  const { status, json } = res
  if (status >= 200 && status < 300) return { kind: 'ok' }
  if (status === 401 || status === 403) return { kind: 'unauthorized' }
  if (status === 404) return { kind: 'not-found' }
  const reason = isObj(json) && typeof json.reason === 'string' ? json.reason : ''
  return { kind: 'failed', message: reason || `HTTP ${status}` }
}
// #endregion

// #region 票 19 (tag-share): POST /api/shares/:id/like —— 回赞 (spec §3/§6)
/**
 * 回赞响应归一档 (worker 实测契约):
 * - 200 `{likes_count, liked:true, already:false|true}` => ok —— (share_id,mid) 主键幂等,
 *   already=true = 去重命中 (重复点不双计, 调用侧同样按成功收)
 * - 403 `{error:'like_rejected', status:'pending'|'removed'}` => rejected (待审/已下架拒赞)
 * - 404 not_found => not-found (不存在/不可见同态, 服务端不暴露存在性)
 * - 429 rate_limited => rate-limited (per-mid/IP 限频)
 * - 400 坏 mid / 其余状态码 / 非预期 => failed 兜底
 */
export type ShareLikeOutcome =
  | { kind: 'ok'; likesCount: number; already: boolean }
  | { kind: 'rejected'; status: string } // 'pending' | 'removed' (未知值原样透传)
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'failed'; message: string }

/**
 * (status, 已解析响应体) => ShareLikeOutcome 纯归一 —— 拆出便于单测;
 * 2xx 宽容档: liked 语义以状态码为准 (worker 契约保证 liked:true), 字段缺省不翻转成失败
 */
export function normalizeShareLikeOutcome(status: number, json: unknown): ShareLikeOutcome {
  if (status >= 200 && status < 300) {
    const d = isObj(json) ? json : {}
    return { kind: 'ok', likesCount: numOr0(d.likes_count), already: d.already === true }
  }
  if (status === 403) {
    const d = isObj(json) ? json : {}
    return { kind: 'rejected', status: typeof d.status === 'string' ? d.status : '' }
  }
  if (status === 404) return { kind: 'not-found' }
  if (status === 429) return { kind: 'rate-limited' }
  const d = isObj(json) ? json : {}
  const reason = (typeof d.reason === 'string' && d.reason) || (typeof d.error === 'string' && d.error) || ''
  return { kind: 'failed', message: reason || `HTTP ${status}` }
}

/**
 * POST {API_BASE}/api/shares/<id>/like body {mid} —— mid 为插件登录态取数 (fetchShareUploader);
 * anonymous:true 同通道其余端点: 不携 bilibili cookie 出域
 */
export async function likeShare(shareId: string, mid: number): Promise<ShareLikeOutcome> {
  const res = await shareHttpRequest(`/api/shares/${encodeURIComponent(shareId)}/like`, {
    method: 'POST',
    body: { mid },
  })
  return res.kind === 'failed' ? res : normalizeShareLikeOutcome(res.status, res.json)
}
// #endregion

// #region 票 31 (tag-share): POST /api/shares/dup-check —— 重复分享软提醒
/** dup-check 命中条目 (契约 {id,title,updated_at,similarity,title_match?} 至多 5 条降序; 逐字段归一后形态) */
export type ShareDupItem = {
  id: string
  title: string
  /** unix ms; 缺省/非法 => 缺席 (UI 回落「刚刚」) */
  updatedAt?: number
  /** 0..1 相似度; 缺省/非法 => 0 */
  similarity: number
  /** 标题同名命中标 (契约 title_match; 命中 => UI 显示「同名」替代百分比) */
  titleMatch?: boolean
}

/**
 * dup-check 结果归一档:
 * - ok   = 2xx 且解析出有效条目集 (可为空数组 —— 无命中同走 ok, 调用侧以 dups.length 判)
 * - failed = 非 2xx/非预期体/网络错/超时 —— 一律静默兜底: dup-check 挂了不挡上传, 调用侧直接放行
 */
export type ShareDupCheckOutcome = { kind: 'ok'; dups: ShareDupItem[] } | { kind: 'failed' }

const DUP_CHECK_MAX = 5 // 契约: dups 至多 5 条降序 —— 客户端同截断防御

/**
 * (status, 已解析响应体) => ShareDupCheckOutcome 纯归一 —— 拆出便于单测;
 * 条目逐字段校验: id/title 必填 (非字符串剔除), 其余字段缺省宽容; 非 2xx 一律 failed (软提醒静默语义)
 */
export function normalizeDupCheckOutcome(status: number, json: unknown): ShareDupCheckOutcome {
  if (status < 200 || status >= 300) return { kind: 'failed' }
  const d = isObj(json) ? json : {}
  const arr = Array.isArray(d.dups) ? d.dups : []
  const dups: ShareDupItem[] = []
  for (const e of arr) {
    if (!isObj(e)) continue
    if (typeof e.id !== 'string' || !e.id) continue
    if (typeof e.title !== 'string') continue
    dups.push({
      id: e.id,
      title: e.title,
      similarity: numOr0(e.similarity),
      ...(typeof e.updated_at === 'number' && Number.isFinite(e.updated_at) ? { updatedAt: e.updated_at } : {}),
      ...(e.title_match === true ? { titleMatch: true } : {}),
    })
    if (dups.length >= DUP_CHECK_MAX) break
  }
  return { kind: 'ok', dups }
}

/**
 * POST {API_BASE}/api/shares/dup-check body {mid,title,tagIds} —— 上传前重复分享探测;
 * 任何失败 => {kind:'failed'} (静默: 调用侧当作「无命中」继续原上传流程, 不给用户添错)
 */
export async function checkDupShare(body: {
  mid: number
  title: string
  tagIds: number[]
}): Promise<ShareDupCheckOutcome> {
  const res = await shareHttpRequest('/api/shares/dup-check', { method: 'POST', body, timeout: 10_000 })
  return res.kind === 'failed' ? { kind: 'failed' } : normalizeDupCheckOutcome(res.status, res.json)
}
// #endregion
