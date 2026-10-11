import { readCacheRows } from './cache-rows'
import type { TagInfo } from './endpoints'

/**
 * [tag-rec] tag_name/tag_id → TagInfo 持久缓存 (票 18 决议②): 跨会话摊薄 tag/info 成本
 * - GM key `tag-rec:tag-info`, ~2000 条 LRU (Map 迭代序=插入序, 淘汰最旧)
 * - tag 名⇄id 映射稳定不改 => 命中即免请求; 同输入反复搜/共享共现邻居时解析成本趋零
 * - 双向键: `n:{norm}` 按名查 / `i:{id}` 按 id 反查 (一次成功解析双向落盘)
 * - 惰性初始化 + 防抖批量落盘 + 读写失败 fail-open (同 video-tags-store 模式)
 */

export const TAG_INFO_STORE_CAP = 2_000
const STORAGE_KEY = 'tag-rec:tag-info'
const FLUSH_DEBOUNCE_MS = 1_000

let mapPromise: Promise<Map<string, TagInfo> | undefined> | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined

function decodeInfo(value: unknown, key: string): TagInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const info = value as TagInfo
  if (!Number.isSafeInteger(info.id) || info.id <= 0 || typeof info.name !== 'string' || !info.name) return
  if (key !== `i:${info.id}` && !(key.startsWith('n:') && key.length > 2)) return
  return {
    id: info.id,
    name: info.name,
    ...(typeof info.use === 'number' && Number.isFinite(info.use) && info.use >= 0 && { use: info.use }),
    ...(typeof info.atten === 'number' && Number.isFinite(info.atten) && info.atten >= 0 && { atten: info.atten }),
    ...(['topic', 'old_channel', 'bgm'].includes(info.tag_type!) && { tag_type: info.tag_type }),
  }
}

function pool(): Promise<Map<string, TagInfo> | undefined> {
  mapPromise ??= Promise.resolve()
    .then(() => GM.getValue<unknown>(STORAGE_KEY, []))
    .then((rows) => readCacheRows(rows, TAG_INFO_STORE_CAP, decodeInfo))
    .catch(() => {
      mapPromise = undefined
      return undefined
    })
  return mapPromise
}

function scheduleFlush(map: Map<string, TagInfo>) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void Promise.resolve()
      .then(() => GM.setValue(STORAGE_KEY, Array.from(map)))
      .catch(() => undefined)
  }, FLUSH_DEBOUNCE_MS)
}

function set(map: Map<string, TagInfo>, key: string, info: TagInfo) {
  const prev = map.get(key)
  const changed =
    !prev ||
    prev.id !== info.id ||
    prev.name !== info.name ||
    prev.tag_type !== info.tag_type ||
    prev.use !== info.use ||
    prev.atten !== info.atten
  if (map.has(key)) map.delete(key)
  map.set(key, info)
  return changed
}

// [tag-rec] AUDIT-27: 读命中亦 delete+set 促活 —— Map 迭代序即 LRU 淘汰序, 原只写路径移尾,
// 热键会被冷写顶到头部淘汰; 促活只动内存序不 scheduleFlush (读路径不值得付落盘)
function get(map: Map<string, TagInfo>, key: string): TagInfo | undefined {
  const info = map.get(key)
  if (info !== undefined) {
    map.delete(key)
    map.set(key, info)
  }
  return info
}

/** 按归一化名读持久层 (`n:{norm}` 键); 未命中/读失败 => undefined */
export async function getPersistedTagInfoByName(norm: string): Promise<TagInfo | undefined> {
  const map = await pool()
  return map && get(map, `n:${norm}`)
}

/** 按 id 读持久层 (`i:{id}` 键) */
export async function getPersistedTagInfoById(id: number): Promise<TagInfo | undefined> {
  const map = await pool()
  return map && get(map, `i:${id}`)
}

/** 写穿: 一次成功解析双向落盘 (norm 键由调用侧给, 防重复 normalize) */
export async function persistTagInfo(info: TagInfo, norm: string): Promise<void> {
  const map = await pool()
  if (!map) return
  const nameChanged = set(map, `n:${norm}`, info)
  const idChanged = set(map, `i:${info.id}`, info)
  while (map.size > TAG_INFO_STORE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  // LRU-only movement piggybacks on the next real write, just like a read hit.
  if (nameChanged || idChanged) scheduleFlush(map)
}

// [tag-rec] perf 票 06: 模块级预热持久池 (同 fingerprint.ts 会话预热手法) ——
//   深链/首查的锚点解析不再串行等一次 GM.getValue; 池小 (~2000 LRU) 预热代价可忽略
if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') void pool()
