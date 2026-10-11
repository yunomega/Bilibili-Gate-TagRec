import { isAxiosError } from 'axios'
import { parseAllV2Duration } from '../model/normalize-item'
import { retryAfterDelay } from './retry-after'
import { SessionFetchCache } from './session-fetch-cache'
import { upSearchGate } from './up-search-gate'
import type { SpaceUploadJson } from '$modules/rec-services/space-upload/api/space-upload.api'
import type { TagTopItem } from './endpoints'

export type UpSearchPage = { items: TagTopItem[]; hasMore: boolean }
const PAGE_SIZE = 30
const CACHE_CAP = 200
/** 完成页有效期: 会话内同参数合并复用; 超时后同页重查拿新数据, 不再无限期返回旧对象 */
const CACHE_TTL_MS = 5 * 60_000
// Share cancellation, completion-based TTL, pending-safe trimming and LRU behavior with anonymous endpoints.
const cache = new SessionFetchCache<string, UpSearchPage>({
  dedupeMs: 0,
  maxAgeMs: CACHE_TTL_MS,
  maxEntries: CACHE_CAP,
})

/** 包含 code=0 的验证码/风控空页，不能误报成关键词没有结果。 */
export function isUpSearchRisk(response: { status?: number; data?: unknown }) {
  const data = response.data as Partial<SpaceUploadJson> & { v_voucher?: unknown }
  const body = data?.data as (Partial<SpaceUploadJson['data']> & { v_voucher?: unknown }) | undefined
  return (
    response.status === 412 ||
    response.status === 429 ||
    !data ||
    typeof data !== 'object' ||
    [-401, -352, -412, -101].includes(data.code!) ||
    !!data.v_voucher ||
    !!body?.is_risk ||
    !!body?.gaia_res_type ||
    !!body?.gaia_data ||
    !!body?.v_voucher
  )
}

function checkRecoveryResponse(response: { status?: number; data?: unknown; headers?: Record<string, unknown> }) {
  const retryAfterMs = retryAfterDelay(response.headers)
  if (isUpSearchRisk(response) || (response.status === 503 && retryAfterMs !== undefined))
    throw upSearchGate.pause(retryAfterMs)
}

function requestPage(mid: number, keyword: string, page: number, signal: AbortSignal): Promise<UpSearchPage> {
  return upSearchGate.run(async () => {
    // 复用现有空间投稿通道与 WBI 签名；不套 tryGetSpaceUpload 的五次自动重试。
    const { request, isWebApiSuccess } = await import('$request')
    let response
    try {
      response = await request.get<SpaceUploadJson>('/x/space/wbi/arc/search', {
        params: { mid, keyword, pn: page, ps: PAGE_SIZE, order: 'pubdate', tid: 0 },
        signal,
        timeout: 15_000,
      })
    } catch (err) {
      if (isAxiosError(err) && err.response) checkRecoveryResponse(err.response)
      throw err
    }
    checkRecoveryResponse(response)
    if (!isWebApiSuccess(response.data))
      throw new Error(`UP 投稿搜索失败：${response.data?.message ?? response.data?.code}`)
    const data = response.data.data
    if (!Array.isArray(data?.list?.vlist) || !data.page) throw new Error('UP 投稿搜索返回了不完整的数据，请稍后重试。')
    const items: TagTopItem[] = data.list.vlist
      .filter((it) => !!it.bvid && !it.is_lesson_video && !(it.is_avoided && it.meta))
      .map((it) => ({
        aid: it.aid,
        bvid: it.bvid,
        title: it.title,
        desc: it.description,
        pic: it.pic,
        pubdate: it.created,
        duration: parseAllV2Duration(it.length),
        tid: it.typeid,
        // 合作投稿保留真实作者，不把查询 MID 写成视频作者。
        owner: { mid: it.mid, name: it.author },
        stat: { view: it.play, reply: it.comment, danmaku: it.video_review },
      }))
    const { pn, ps, count } = data.page
    if (
      !Number.isSafeInteger(pn) ||
      pn < 1 ||
      !Number.isSafeInteger(ps) ||
      ps < 1 ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new Error('UP 投稿搜索返回了不完整的分页信息，请稍后重试。')
    return { items, hasMore: data.list.vlist.length > 0 && pn * ps < count }
  }, signal)
}

/**
 * 同 UP/词/页并发合并；最后一位等待者离开时取消排队/在途请求，不继续刷旧查询。
 * 完成页缓存 TTL=CACHE_TTL_MS; opts.fresh (定向重查) 弃完成档换新页 —— 在途档不算陈旧照常合并。
 */
export function fetchUpSearchPage(
  mid: number,
  keyword: string,
  page: number,
  signal?: AbortSignal,
  opts?: { fresh?: boolean },
): Promise<UpSearchPage> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (!Number.isSafeInteger(mid) || mid <= 0 || typeof keyword !== 'string' || !Number.isSafeInteger(page) || page < 1)
    return Promise.reject(new Error('UP 投稿搜索需要有效的 UID 和页码。'))
  const key = JSON.stringify([mid, keyword.trim(), page])
  if (opts?.fresh) cache.invalidateSettled(key)
  return cache.fetch(key, (entrySignal) => requestPage(mid, keyword.trim(), page, entrySignal), signal)
}
