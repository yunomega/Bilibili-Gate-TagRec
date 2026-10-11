/** API 域 (内联常量而非 $common: $common 顶层求值 location, vitest 无 DOM 会炸) */
const HOST_API = 'https://api.bilibili.com'

/**
 * [tag-rec] 匿名通道 (spec §2.1 / 票 16 决议①)
 * 标签、全站搜索与视频标签调用走 GM_xmlHttpRequest；UP 定向投稿搜索复用既有空间页 request 通道。
 * - `anonymous:true` => 不携浏览器 cookie jar (零登录态, 与用户真实浏览指纹隔离)
 * - 指纹经手动 Cookie header 注入 (XHR/fetch 的 forbidden header, 只有 GM_xhr 能设)
 * - 不复用 Gate `request` (withCredentials:true), 不引 `gmrequest` (面向 app.bilibili.com 且注入 TV key/access_key)
 * - meta 需 `connect: api.bilibili.com` (vite.config.ts [tag-rec])
 */

export type GmAnonResponse = { status: number; data: unknown; emptyBody?: boolean; responseHeaders?: string }

/**
 * 匿名 GET → JSON 响应 (与 axios AxiosResponse 同形: isRiskControlResponse 直接消费)。
 * 非 JSON body (HTML 风控页) => data=undefined, 由上层 isRiskControlResponse 判定风控;
 *   零字节 body (tag/top 深页池底实测定型) => emptyBody=true —— 与非 JSON 分开,
 *   由 opt-in 调用方按「空结果」处理, 不混进风控判定。
 * 网络失败/超时/中止 => reject (非风控错误语义, 不进退避); timeout 15s 兜底防挂死 pLimit 槽位。
 */
export function gmAnonGet(
  path: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  cookie?: string,
): Promise<GmAnonResponse> {
  // 前置 abort 判 (AUDIT-18): 对已 aborted 的 signal 只挂 addEventListener 永不触发 => 孤儿请求照发烧配额
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v))
  }
  const url = `${HOST_API}${path}${qs.size ? `?${qs}` : ''}`
  return new Promise((resolve, reject) => {
    let settled = false
    let handle: { abort: () => void } | undefined
    let handleAborted = false
    const detach = () => signal?.removeEventListener('abort', onAbort)
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      detach()
      reject(error)
    }
    const abortHandle = () => {
      if (!handle || handleAborted) return
      handleAborted = true
      try {
        handle.abort()
      } catch {
        /* Local cancellation already settled the promise. */
      }
    }
    const onAbort = () => {
      // Do not depend on the userscript manager emitting onabort to free our slot.
      fail(new DOMException('Aborted', 'AbortError'))
      abortHandle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      handle = GM.xmlHttpRequest({
        method: 'GET',
        url,
        anonymous: true,
        responseType: 'text',
        timeout: 15_000,
        headers: cookie ? { Cookie: cookie } : {},
        onload(res) {
          if (settled) return
          const text = res.responseText ?? ''
          const emptyBody = text.trim() === ''
          let data: unknown
          if (!emptyBody) {
            try {
              data = JSON.parse(text)
            } catch {
              data = undefined
            }
          }
          settled = true
          detach()
          resolve({
            status: res.status,
            data,
            ...(emptyBody ? { emptyBody } : {}),
            ...(res.responseHeaders ? { responseHeaders: res.responseHeaders } : {}),
          })
        },
        onerror() {
          fail(new TypeError(`[tag-rec] gm anon GET failed: ${path}`))
        },
        ontimeout() {
          fail(new TypeError(`[tag-rec] gm anon GET timeout: ${path}`))
        },
        onabort() {
          fail(new DOMException('Aborted', 'AbortError'))
        },
      })
      // Cancellation may occur synchronously inside a userscript-manager implementation.
      if (signal?.aborted) onAbort()
    } catch (error) {
      fail(error)
    }
  })
}
