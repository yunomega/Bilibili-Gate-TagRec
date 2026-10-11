import { pLimit } from 'promise.map'
import { appWarn } from '$common'
import { isWebApiSuccess } from '$request'
import { normalizeTagRecPartition, type TagRecPartitionFields } from '../model/partition'
import { normalizeTagName } from '../model/tag-norm'
import {
  allV2Limit,
  isRiskControlError,
  isRiskControlResponse,
  RiskControlError,
  tagRecBackoff,
  tagRecLimit,
} from './backoff'
import { ensureTagRecFingerprint, fingerprintCookieHeader } from './fingerprint'
import { getCachedTagRecPartition, rememberTagRecPartition } from './partition-cache'
import { tagRecRecallScheduler } from './recall-scheduler'
import { gmAnonGet, type GmAnonResponse } from './request'
import { retryAfterDelay } from './retry-after'
import { recordAnonRequest } from './risk-log'
import { SessionFetchCache } from './session-fetch-cache'
import { getPersistedTagInfoById, getPersistedTagInfoByName, persistTagInfo } from './tag-info-store'
import { rememberTagRecVideoEvidence } from './video-evidence-store'
import { evictPersistedVideoTags, getPersistedVideoTags, persistVideoTags } from './video-tags-store'
import type { AllV2VideoItem } from '../model/normalize-item'
import type { TagIdEntry } from '../model/types'

/**
 * [tag-rec] 端点封装 (spec §2.2 / 票 16)
 * 全部经 anonGetJson 单一入口: GM_xhr 匿名通道 + buvid 指纹 + pLimit(4) 并发上限 + 风控退避
 * 不轮换指纹: 命中风控只退避等待, 不重铸指纹换身份 (规避风控手段, 已移除)
 * all/v2 / view/detail/tag / suggest 归票 03/05
 */

/** 风控命中后退避重试上限: 等待退避时隙后自动重试 ≤2 次再上抛 */
const RC_MAX_RETRIES = 2

/**
 * 业务码非 0 且非风控的响应 (W1-2): 与「源真空」分流 —— reject 由调用方计入失败/缺口,
 * 不产「空成功」: tag/top 不落持久干态、all/v2 页位图记 gap 不推进游标不判 exhausted。
 */
export class TagRecApiCodeError extends Error {
  constructor(
    public readonly url: string,
    public readonly code: number | undefined,
  ) {
    super(`[tag-rec] ${url} code=${code}`)
    this.name = 'TagRecApiCodeError'
  }
}
export class TagRecHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`[tag-rec] ${url} HTTP ${status}`)
    this.name = 'TagRecHttpError'
  }
}

export async function anonGetJson(
  url: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  limit: ReturnType<typeof pLimit> = tagRecLimit,
  maxRiskRetries = RC_MAX_RETRIES,
  opts?: { allowEmptyBody?: boolean },
): Promise<unknown> {
  // [tag-rec] AUDIT-32: ensure 不随调用方 signal —— abort 本会话级请求不该致残指纹支路
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await ensureTagRecFingerprint(signal) // Cancel this waiter promptly without cancelling shared SPI.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return limit(async () => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= maxRiskRetries; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        return await tagRecBackoff.withRecoveryProbe(async () => {
          const sentEpoch = await tagRecBackoff.waitTurn(signal)
          let res: GmAnonResponse
          try {
            res = await gmAnonGet(url, params, signal, fingerprintCookieHeader())
          } catch (e) {
            recordAnonRequest({ endpoint: url, attempt, params, err: e })
            if (isRiskControlError(e)) tagRecBackoff.onRiskControl()
            throw e
          }
          // 快照取命中发生时态; 被恢复闸拒绝的请求不记成实际发送/命中。
          recordAnonRequest({ endpoint: url, attempt, params, res })
          const retryAfterMs = retryAfterDelay(res.responseHeaders)
          // 2xx + 零字节空体 ≠ 风控页: tag/top 深页探底实测定型 (pn≈3 起 Content-Length:0),
          // opt-in 端点按「空结果」放行给调用方; 不记有效成功 (无 code=0 证据, 不当恢复探针)
          if (opts?.allowEmptyBody && res.emptyBody && res.status >= 200 && res.status < 300) return undefined
          if (isRiskControlResponse(res)) {
            tagRecBackoff.onRiskControl(retryAfterMs)
            throw new RiskControlError(res)
          }
          if (res.status === 503 && retryAfterMs !== undefined) tagRecBackoff.onRiskControl(retryAfterMs)
          if (res.status < 200 || res.status >= 300) throw new TagRecHttpError(url, res.status)
          // 审计 6.1/6.2: code!==0 的业务失败不算有效成功; 命中前发出的旧回包由代次配对判掉
          if ((res.data as { code?: number } | undefined)?.code === 0) tagRecBackoff.onSuccess(sentEpoch)
          return res.data
        })
      } catch (e) {
        if (isRiskControlError(e)) {
          lastErr = e
          continue
        }
        throw e
      }
    }
    throw lastErr
  })
}

// #region x/tag/info —— tag 名 ⇄ id
export type TagInfoJson = {
  code: number
  message: string
  data?: {
    tag_id?: number
    tag_name?: string
    // 计数在 data.count.{use,atten} 下 —— 顶层读取 = null 陷阱 (spec §2.2)
    count?: {
      view?: number
      use?: number
      atten?: number
    }
    // type 为数值且与 tag_type 枚举不对应, 不映射 (spec §3.1)
  }
}

export type TagInfo = TagIdEntry & {
  use?: number // 使用数 (data.count.use)
  atten?: number // 关注数 (data.count.atten)
}

function extractTagInfo(json: TagInfoJson): TagInfo | undefined {
  const data = json.data
  const id = data?.tag_id
  const name = data?.tag_name
  if (!id || !name) return undefined
  return { id, name, use: data?.count?.use, atten: data?.count?.atten }
}

/**
 * tag/info 三级缓存 (票 18 决议②③): 持久层 (GM ~2k LRU) => 会话缓存 (含并发去重) => 网络
 * - 会话缓存 key = 归一化名/id, 同批内撞名/撞 id 的请求天然合并 (解析前去重在这层生效)
 * - 一次成功解析双向落盘 (n:/i: 两键); undefined (未解析到) 不持久化, 仅会话窗口内去重
 */
const TAG_INFO_DEDUPE_MS = 3_000
const tagInfoNameCache = new SessionFetchCache<string, TagInfo | undefined>({
  dedupeMs: TAG_INFO_DEDUPE_MS,
  maxEntries: 2_000,
  isCacheable: (v) => v !== undefined,
})
const tagInfoIdCache = new SessionFetchCache<number, TagInfo | undefined>({
  dedupeMs: TAG_INFO_DEDUPE_MS,
  maxEntries: 2_000,
  isCacheable: (v) => v !== undefined,
})

/** tag_name => id+use (Phase 1 锚点解析 / 候选行惰性解析) */
export function fetchTagInfoByName(tagName: string, signal?: AbortSignal): Promise<TagInfo | undefined> {
  const norm = normalizeTagName(tagName)
  // [tag-rec] AUDIT-33: pending 是共享资源 —— loader 不绑本调用方 signal, signal 只作本 await 方的 abort 判
  return tagInfoNameCache.fetch(
    norm,
    async (entrySignal) => {
      const persisted = await getPersistedTagInfoByName(norm)
      if (persisted) return persisted
      const json = (await anonGetJson('/x/tag/info', { tag_name: tagName }, entrySignal)) as TagInfoJson
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] tag/info?tag_name=%s failed: %o', tagName, json)
        return undefined
      }
      const info = extractTagInfo(json)
      if (info) void persistTagInfo(info, normalizeTagName(info.name))
      return info
    },
    signal,
  )
}

/** tag_id => name 反查 (数字直输逃生口 / CSV id 列, spec §4.1) */
export function fetchTagInfoById(tagId: number, signal?: AbortSignal): Promise<TagInfo | undefined> {
  // [tag-rec] AUDIT-33: 同上 —— abort 判上移到调用方 await, 底层共享取数不绑 signal
  return tagInfoIdCache.fetch(
    tagId,
    async (entrySignal) => {
      const persisted = await getPersistedTagInfoById(tagId)
      if (persisted) return persisted
      const json = (await anonGetJson('/x/tag/info', { tag_id: tagId }, entrySignal)) as TagInfoJson
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] tag/info?tag_id=%s failed: %o', tagId, json)
        return undefined
      }
      const info = extractTagInfo(json)
      if (info) void persistTagInfo(info, normalizeTagName(info.name))
      return info
    },
    signal,
  )
}
// #endregion

// #region x/web-interface/tag/top —— 标签推荐池
// 参数名 tid (不是 tag_id); data 直接是数组; ps=100 可用; 浅池每请求重采样 (spec §2.2)
export type TagTopJson = {
  code: number
  message: string
  data?: TagTopItem[]
}

/** tag/top 条目 = archive 标准结构 (stat 七字段全) */
export type TagTopItem = {
  aid?: number
  bvid?: string
  cid?: number
  tid?: number
  tname?: string
  tidv2?: number
  tid_v2?: number
  tnamev2?: string
  tname_v2?: string
  pid_v2?: number // v2 一级分区 id (=一级分区本体, 分区名单直判原料)
  pid_name_v2?: string
  pic?: string
  title?: string
  desc?: string
  duration?: number
  pubdate?: number
  owner?: {
    mid?: number
    name?: string
    face?: string
  }
  stat?: {
    view?: number
    danmaku?: number
    reply?: number
    favorite?: number
    coin?: number
    share?: number
    like?: number
  }
}

// 浅池列表页在途合并: 只合并「同参数同时在途」的重复取数 —— dedupeMs=0 => 落定结果 (含失败)
//   绝不复用, 同页重采样不冻结新内容; isCacheable=false 防 ok 态被当长缓存; maxEntries 收死条目
const tagTopCache = new SessionFetchCache<string, TagTopItem[]>({
  dedupeMs: 0,
  isCacheable: () => false,
  maxEntries: 256,
})

export function fetchTagTop(
  tid: number,
  { pn = 1, ps = 100, signal }: { pn?: number; ps?: number; signal?: AbortSignal } = {},
): Promise<TagTopItem[]> {
  return tagTopCache.fetch(
    `${tid}:${pn}:${ps}`,
    async (entrySignal) => {
      const json = (await anonGetJson(
        '/x/web-interface/tag/top',
        { tid, pn, ps },
        entrySignal,
        tagRecLimit,
        RC_MAX_RETRIES,
        { allowEmptyBody: true },
      )) as TagTopJson | undefined
      // 深页空体 (池底): fetched=0/ok=true —— 干池账按「深页空体 = 池底, 仅会话级」语义落
      if (json === undefined) return []
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] tag/top?tid=%s failed: %o', tid, json)
        throw new TagRecApiCodeError('/x/web-interface/tag/top', json?.code) // W1-2: 瞬态错 ≠ 空池 (空池会落持久干态)
      }
      if (!Array.isArray(json.data)) throw new TagRecApiCodeError('/x/web-interface/tag/top', json?.code)
      const items = json.data
      for (const item of items) rememberTagRecPartition(item.bvid, item)
      return items
    },
    signal,
  )
}
// #endregion

// #region x/web-interface/archive/related —— 视频相关推荐 (票 13 D2 兜底选种产出源)
// 匿名可用; 固定 ~40 条无分页; archive 对象与 TagTopItem 同形 (全 stat+duration+mid/face), 无 tag 名单
export type ArchiveRelatedJson = {
  code: number
  message: string
  data?: TagTopItem[]
}

const archiveRelatedCache = new SessionFetchCache<string, TagTopItem[]>({
  dedupeMs: 0,
  isCacheable: () => false,
  maxEntries: 256,
})

export function fetchArchiveRelated(bvid: string, { signal }: { signal?: AbortSignal } = {}): Promise<TagTopItem[]> {
  return archiveRelatedCache.fetch(
    bvid,
    async (entrySignal) => {
      const json = (await tagRecRecallScheduler.run(
        () => anonGetJson('/x/web-interface/archive/related', { bvid }, entrySignal),
        entrySignal,
      )) as ArchiveRelatedJson
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] archive/related?bvid=%s failed: %o', bvid, json)
        throw new TagRecApiCodeError('/x/web-interface/archive/related', json?.code) // W1-2: 同口径
      }
      if (!Array.isArray(json.data)) throw new TagRecApiCodeError('/x/web-interface/archive/related', json?.code)
      const items = json.data
      for (const item of items) rememberTagRecPartition(item.bvid, item)
      return items
    },
    signal,
  )
}
// #endregion

// #region x/web-interface/search/all/v2 —— 关键词搜索 (Phase 2 召回源, spec §2.2)
// 恒 20 条/页; `order`/`page_size` 被忽略; 相关性截断 ~50 页; 聚合 result 按类型分块, 视频在 result_type==='video' 块
export const ALLV2_PAGE_CAP = 50
export type AllV2SearchJson = {
  code: number
  message: string
  data?: {
    numResults?: number
    numPages?: number
    pagesize?: number
    result?: {
      result_type?: string
      data?: AllV2VideoItem[]
    }[]
  }
}

// Successful pages are reusable for 60s; transient failures only coalesce for 3s.
// TTL starts at settlement, so queueing and backoff cannot consume the reuse window.
const allV2Cache = new SessionFetchCache<string, AllV2VideoItem[]>({
  dedupeMs: 3_000,
  maxAgeMs: 60_000,
  maxEntries: 256,
})

export function fetchAllV2Search(
  keyword: string,
  { page = 1, signal }: { page?: number; signal?: AbortSignal } = {},
): Promise<AllV2VideoItem[]> {
  return allV2Cache.fetch(
    `${keyword}:${page}`,
    async (entrySignal) => {
      const json = (await tagRecRecallScheduler.run(
        // allV2Limit 外套 (不替换 limit 参): 搜索请求同时占 tagRecLimit 槽 —— 全局并发上限不被绕过
        () => allV2Limit(() => anonGetJson('/x/web-interface/search/all/v2', { keyword, page }, entrySignal)),
        entrySignal,
      )) as AllV2SearchJson
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] search/all/v2?keyword=%s&page=%s failed: %o', keyword, page, json)
        throw new TagRecApiCodeError('/x/web-interface/search/all/v2', json?.code) // W1-2: 页位图记 gap 不推进游标
      }
      const blocks = json.data?.result
      // code=0 但缺 result 块是截断/降级响应 (正常空页也带 result:[]) —— 按失败记 gap,
      //   不能产「假空页」喂给深挖流判 exhausted 沉淀持久态
      if (!Array.isArray(blocks)) {
        appWarn('[tag-rec] search/all/v2?keyword=%s&page=%s missing result blocks: %o', keyword, page, json)
        throw new TagRecApiCodeError('/x/web-interface/search/all/v2', json?.code)
      }
      if (blocks.some((block) => block?.result_type === 'video' && !Array.isArray(block.data)))
        throw new TagRecApiCodeError('/x/web-interface/search/all/v2', json?.code)
      const items = blocks.flatMap((blk) => (blk?.result_type === 'video' && Array.isArray(blk.data) ? blk.data : []))
      for (const item of items) rememberTagRecPartition(item.bvid, item)
      return items
    },
    signal,
  )
}
// #endregion

// #region x/web-interface/suggest —— api 域联想词 (变体第三优先级补充, spec §2.2)
export type SuggestJson = {
  code: number
  message: string
  data?: {
    result?: {
      tag?: { value?: string; term?: string }[]
    }
  }
}

const suggestCache = new SessionFetchCache<string, string[] | undefined>({
  dedupeMs: 3_000,
  maxAgeMs: 60_000,
  maxEntries: 256,
  isCacheable: (value) => value !== undefined,
})

/** Repeated suggestion consumers share one request; failures remain optional UI hints. */
export async function fetchSuggest(term: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return (
      (await suggestCache.fetch(
        term,
        async (entrySignal) => {
          const json = (await tagRecRecallScheduler.run(
            () => anonGetJson('/x/web-interface/suggest', { term }, entrySignal),
            entrySignal,
          )) as SuggestJson
          if (!isWebApiSuccess(json)) return undefined
          const tags = json.data?.result?.tag
          if (!Array.isArray(tags)) return undefined
          const vals = tags
            .map((tag) => tag?.value ?? tag?.term)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
          return [...new Set(vals)]
        },
        signal,
      )) ?? []
    )
  } catch (e) {
    if (isRiskControlError(e)) appWarn('[tag-rec] suggest?term=%s risk-control', term)
    return []
  }
}
// #endregion

// #region x/web-interface/view/detail —— 整包详情 (分区核验/素材证据共用传输) + view/detail/tag
const videoPartitionLimit = pLimit(2)

export type ViewDetailData = { View?: TagTopItem; Tags?: ViewDetailTagItem[] }

/**
 * /view/detail 整包在途单飞 (审计 §8-1): 分区核验与素材证据共用同一发送 —
 *   并发补查同一 BV 不再各发一次整包; 落定结果不进本层会话缓存,
 *   复用仍走各自消费方的持久层/短缓存 (rememberTagRecVideoEvidence 统一入库)
 */
const videoDetailCache = new SessionFetchCache<string, ViewDetailData | undefined>({
  dedupeMs: 15_000,
  maxAgeMs: 0,
  maxEntries: 2_000,
  isCacheable: (d) => d?.View !== undefined,
})

export function fetchVideoDetail(bvid: string, signal?: AbortSignal): Promise<ViewDetailData | undefined> {
  return videoDetailCache.fetch(
    bvid,
    async (entrySignal) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      // 最后一个等待者离开 => entrySignal 置 aborted, 与 5s 超时同闸取消未发送/在途请求
      const onAbandon = () => controller.abort()
      entrySignal.addEventListener('abort', onAbandon, { once: true })
      try {
        const json = (await videoPartitionLimit(() =>
          anonGetJson('/x/web-interface/view/detail', { bvid }, controller.signal, tagRecLimit, 0),
        )) as { code?: number; data?: ViewDetailData }
        if (!isWebApiSuccess(json) || json.data?.View?.bvid !== bvid) return
        return json.data
      } finally {
        clearTimeout(timer)
        entrySignal.removeEventListener('abort', onAbandon)
      }
    },
    signal,
  )
}

const videoPartitionCache = new SessionFetchCache<string, TagRecPartitionFields | undefined>({
  dedupeMs: 15_000,
  // 成功事实由 partition-cache 统一管理，避免来源更新后又复用旧详情。
  maxAgeMs: 0,
  maxEntries: 2_000,
  isCacheable: (fields) => fields?.tidv2 !== undefined,
})

/** 分区仅看按需核验；成功但缺新版字段仍是未知，不缓存为已匹配。 */
export function fetchVideoPartition(
  bvid: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<TagRecPartitionFields | undefined> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const known = getCachedTagRecPartition(bvid)
  if (known?.tidv2 !== undefined) return Promise.resolve(known)
  return videoPartitionCache.fetch(
    bvid,
    async (entrySignal) => {
      const data = await fetchVideoDetail(bvid, entrySignal)
      if (!data?.View) return
      const fields = normalizeTagRecPartition(data.View)
      // 同一 /view/detail 响应的字段全量入库 (证据短缓存+分区+标签持久层) ——
      //   先分区后证据的两段补查不再为同一响应二次付费
      await rememberTagRecVideoEvidence(bvid, data)
      return fields
    },
    signal,
  )
}

// 按需调用 (点开弹层才发, 不预取); 每 bvid 会话缓存 + 同 bvid ≥3s 去重 (§2.3)
export const VIDEO_TAGS_DEDUPE_MS = 3_000

export type ViewDetailTagItem = {
  tag_id?: number
  tag_name?: string
  tag_type?: 'topic' | 'old_channel' | 'bgm' | (string & {}) // 枚举外取值防御性透传 (展示用; 入表过 parseTagType)
  jump_url?: string
  music_id?: string
}

export type ViewDetailTagJson = {
  code: number
  message: string
  data?: ViewDetailTagItem[]
}

/**
 * 缓存三层 (票 16 决议⑤b):
 * - 会话缓存: 成功结果会话级缓存; code!==0 => undefined (不进缓存, 仅 ≥3s 窗口内去重防连击)
 * - 持久缓存: 成功结果写穿 GM `tag-rec:video-tags` (~2000 LRU), 跨会话免请求
 * - 传输 (审计 §8-2): 批量道不再单买 view/detail/tag —— 同价改走整包 /view/detail,
 *   Tags 之外的分区/UP/简介经 rememberTagRecVideoEvidence 全量入库, 且与分区核验/素材证据
 *   共享同一在途 (videoDetailCache): 一条视频整轮核验+严格核查至多一次真实请求。
 *   交互道 (interactive:true, 弹层点开) 仍走专用端点 + videoTagInteractiveLimit(2) 独立闸口,
 *   不占批量闸、也不排在核验在途后面 —— Phase 2/兜底洪流期间弹层不被饿死
 */
const videoTagsCache = new SessionFetchCache<string, ViewDetailTagItem[] | undefined>({
  dedupeMs: VIDEO_TAGS_DEDUPE_MS,
  maxEntries: 2_000,
  maxAgeMs: 15 * 60_000,
  isCacheable: (v) => v !== undefined && hasCompleteTagIds(v),
})
const videoTagInteractiveLimit = pLimit(2)

/** 持久条目完整性: 全条带 tag_id (all/v2 落盘的 name-only 条目对 id 消费按 miss 处理, 票 13 D10) */
export function hasCompleteTagIds(items: readonly ViewDetailTagItem[]): boolean {
  return items.every((t) => t != null && Number.isSafeInteger(t.tag_id) && t.tag_id! > 0)
}

/** 视频 tag 列表 (含 tag_id); 失败 => undefined (空数组 = 该视频无 tag 属正常结果);
 *  interactive=true 走交互专用道 (弹层点开等用户等候路径), 不占 tagRecLimit 批量闸 */
export async function fetchVideoTags(
  bvid: string,
  { signal, interactive }: { signal?: AbortSignal; interactive?: boolean } = {},
): Promise<ViewDetailTagItem[] | undefined> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  // A fresh authoritative write from another detail consumer beats an older session result.
  // The GM pool is already memory-backed; unavailable persistence falls back to the session cache.
  const known = await getPersistedVideoTags(bvid)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (known !== undefined && hasCompleteTagIds(known)) return known
  if (known !== undefined) videoTagsCache.invalidateSettled(bvid)
  return videoTagsCache.fetch(
    bvid,
    async (entrySignal) => {
      const persisted = await getPersistedVideoTags(bvid)
      if (persisted !== undefined && hasCompleteTagIds(persisted)) return persisted
      if (!interactive) {
        // 批量道 (审计 §8-2): 整包一次付费, Tags + View 全字段入库, 与核验/证据在途合一
        const data = await fetchVideoDetail(bvid, entrySignal)
        if (!data) return undefined
        await rememberTagRecVideoEvidence(bvid, data)
        return Array.isArray(data.Tags) ? data.Tags : undefined
      }
      const json = (await anonGetJson(
        '/x/web-interface/view/detail/tag',
        { bvid },
        entrySignal,
        videoTagInteractiveLimit,
      )) as ViewDetailTagJson
      if (!isWebApiSuccess(json)) {
        appWarn('[tag-rec] view/detail/tag?bvid=%s failed: %o', bvid, json)
        return undefined
      }
      if (!Array.isArray(json.data)) return undefined // Missing evidence is not an empty authoritative list.
      const items = json.data
      void persistVideoTags(bvid, items, { partial: false })
      return items
    },
    signal,
  )
}

/**
 * 视频 tag 名名单消费路径 (票 13 共现选种等不需要 tag_id 的场景):
 * 持久层 name-only 条目也命中 (all/v2 落盘白嫖); 未命中才走 fetchVideoTags 完整拉取
 */
export async function fetchVideoTagNames(bvid: string, signal?: AbortSignal): Promise<string[] | undefined> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const persisted = await getPersistedVideoTags(bvid)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (persisted !== undefined) return persisted.map((t) => t.tag_name).filter((n): n is string => !!n)
  const items = await fetchVideoTags(bvid, { signal })
  return items?.map((t) => t.tag_name).filter((n): n is string => !!n)
}

/** 手动重试前清掉失败缓存 + 持久层 (去重窗口内立即重试不再发请求) */
export function invalidateVideoTagsCache(bvid?: string) {
  if (bvid === undefined) videoTagsCache.clear()
  else videoTagsCache.invalidate(bvid)
  void evictPersistedVideoTags(bvid)
}
// #endregion
