import { normalizeTagName } from '../model/tag-norm'
import { readCacheRows } from './cache-rows'
import type { ViewDetailTagItem } from './endpoints'

/**
 * [tag-rec] 视频→tags 持久缓存 (票 16 决议⑤b): 跨会话摊薄 view/detail/tag 成本
 * - GM key `tag-rec:video-tags`, ~2000 条 LRU (Map 迭代序=插入序, 淘汰最旧)
 * - 视频的 tag 列表上传后基本不改 => 命中即免请求, 严格校验边际成本趋近零
 * - 惰性初始化 (首次 fetchVideoTags 才 await GM), 避免模块顶层 await 阻塞测试
 * - **防抖批量落盘** (真机深挖期崩溃修复): 裸 Map + ~1s 聚合写, 避免 proxyMap
 *   subscribe-per-mutation 导致的「每条视频全量序列化 ~2k 项写 GM」主线程风暴
 * - GM 读写失败 => fail-open 退化为纯会话缓存, 不传染取数链路
 * - 持久化裁剪: 只留 {tag_id, tag_name, tag_type} (jump_url/music_id 无用不存)
 */

export const VIDEO_TAGS_STORE_CAP = 2_000
const STORAGE_KEY = 'tag-rec:video-tags'
/** 落盘聚合窗口: 窗口内的多次写入合并为一次 GM.setValue */
const FLUSH_DEBOUNCE_MS = 1_000

export type VideoTagEntry = Pick<ViewDetailTagItem, 'tag_id' | 'tag_name' | 'tag_type'>

let mapPromise: Promise<Map<string, VideoTagEntry[]> | undefined> | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined

function decodeTags(value: unknown): VideoTagEntry[] | undefined {
  if (!Array.isArray(value)) return
  const tags: VideoTagEntry[] = []
  for (const item of value) {
    // Never drop a malformed member and turn the remaining subset into complete evidence.
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const tag = item as VideoTagEntry
    if (tag.tag_id !== undefined && (!Number.isSafeInteger(tag.tag_id) || tag.tag_id <= 0)) return
    if (tag.tag_name !== undefined && typeof tag.tag_name !== 'string') return
    if (tag.tag_type !== undefined && typeof tag.tag_type !== 'string') return
    if (tag.tag_id === undefined && !tag.tag_name) return
    tags.push({ tag_id: tag.tag_id, tag_name: tag.tag_name, tag_type: tag.tag_type })
  }
  return tags
}

function pool(): Promise<Map<string, VideoTagEntry[]> | undefined> {
  mapPromise ??= Promise.resolve()
    .then(() => {
      // 测试/异常环境无 GM => 抛进 catch 降级为纯会话内不写 (fail-open), 不产未处理拒绝
      if (typeof GM === 'undefined' || !GM.getValue) throw new Error('GM unavailable')
      return GM.getValue<unknown>(STORAGE_KEY, [])
    })
    .then((rows) => readCacheRows(rows, VIDEO_TAGS_STORE_CAP, decodeTags))
    .catch(() => {
      mapPromise = undefined // 读取失败不锁死, 下次重试
      return undefined
    })
  return mapPromise
}

function scheduleFlush(map: Map<string, VideoTagEntry[]>) {
  if (flushTimer) return // 已有待落盘批次, 聚合窗口内合并
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    try {
      if (typeof GM !== 'undefined') void GM.setValue(STORAGE_KEY, Array.from(map)).catch(() => undefined)
    } catch {
      /* GM 不可用时静默 (fail-open) */
    }
  }, FLUSH_DEBOUNCE_MS)
}

/** 持久层读取; 未命中/读失败 => undefined (空数组是合法「无标签」结果, 命中返回) */
export async function getPersistedVideoTags(bvid: string): Promise<VideoTagEntry[] | undefined> {
  const map = await pool()
  const hit = map?.get(bvid)
  // W1-7: 读命中促活 —— 头注自称 LRU, 裸 get 不挪位实为 FIFO, 常读旧条目会被新写挤掉 (AUDIT-27 姊妹库同型漏移)
  if (map && hit !== undefined) {
    map.delete(bvid)
    map.set(bvid, hit)
    // A5: 促活不再单排落盘 —— 严格校验期读密集时每读一笔 1s 防抖后全量 2k 序列化写;
    //   顺序变更搭下一次真写 (persist/evict) 的 coalesced flush 便车持久化, 会话内 LRU 不受影响
  }
  return hit
}

/**
 * 写穿: 成功结果持久化 + LRU 淘汰最旧; 同 key 覆盖时移到最新位; 防抖批量落盘。
 * AUDIT-11 降级保护: 新写入缺 tag_id 的条目按归一化 tag_name 向旧条目借 id/tag_type 补齐
 * (深挖流 all/v2 `tag` 字段只产 name-only —— 无条件覆盖会把完整条目打回 miss 态,
 * hasCompleteTagIds 判 miss 重拉 => name-only↔complete 乒乓 + 丢 tag_type);
 * 新条目自带 id 的不动, 旧名单外的条目不落 (新名单定成员)。
 * 观察写 vs 权威写 (partial):
 *   显式 opts.partial=true/false 优先; 缺省按「是否携带 tag_id」推断 —— 全条目无 id
 *   (all/v2 `tag` 字段/较旧搜索快照晚到) 视为投影观察写 **合并而非替换**: 保留旧名单
 *   中未出现的成员 (防子集快照把完整名单截成子集、再被借 id 伪装成完整而跳过重查)。
 *   权威写 (view/detail 系, 显式 partial:false, 含空名单) 仍整名单替换 —— 上游名单
 *   收缩的语义只在权威通道生效。
 */
export async function persistVideoTags(
  bvid: string,
  items: ViewDetailTagItem[],
  opts?: { partial?: boolean },
): Promise<void> {
  const map = await pool()
  if (!map) return
  const previous = map.get(bvid)
  const prev = previous ?? []
  const prevByNorm = new Map<string, VideoTagEntry>()
  for (const e of prev) {
    if (e.tag_id !== undefined && e.tag_name !== undefined) prevByNorm.set(normalizeTagName(e.tag_name), e)
  }
  const entries: VideoTagEntry[] = items.map((t) => {
    const old = t.tag_name === undefined ? undefined : prevByNorm.get(normalizeTagName(t.tag_name))
    return {
      tag_id: t.tag_id ?? old?.tag_id,
      tag_name: t.tag_name,
      tag_type: t.tag_type ?? old?.tag_type,
    }
  })
  const partial = opts?.partial ?? !items.some((t) => t.tag_id !== undefined)
  if (partial && prev.length) {
    const incoming = new Set(entries.flatMap((e) => (e.tag_name === undefined ? [] : [normalizeTagName(e.tag_name)])))
    for (const e of prev) if (e.tag_name === undefined || !incoming.has(normalizeTagName(e.tag_name))) entries.push(e)
  }
  const unchanged =
    previous !== undefined &&
    entries.length === prev.length &&
    entries.every((entry, i) => {
      const old = prev[i]!
      return entry.tag_id === old.tag_id && entry.tag_name === old.tag_name && entry.tag_type === old.tag_type
    })
  if (map.has(bvid)) map.delete(bvid)
  map.set(bvid, entries)
  while (map.size > VIDEO_TAGS_STORE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  // Replayed search pages still promote LRU, but do not serialize the entire pool again.
  if (!unchanged) scheduleFlush(map)
}

/** 失效: 手动重试时清持久层 (与会话缓存 invalidateVideoTagsCache 配套) */
export async function evictPersistedVideoTags(bvid?: string): Promise<void> {
  const map = await pool()
  if (!map) return
  if (bvid === undefined) map.clear()
  else map.delete(bvid)
  scheduleFlush(map)
}
