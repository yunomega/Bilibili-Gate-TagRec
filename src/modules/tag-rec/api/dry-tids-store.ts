/**
 * [tag-rec] dry tid 持久层 (票 39): tag/top 空响应源跨会话记忆
 * - GM key `tag-rec:dry-tids` `{tid → emptyUntil}`; TTL 60min (票面区间 30~120min 取中值)
 * - 语义分裂: 只落 `empty` 一支 —— tag/top 响应空是**源的属性**, 跨会话可复用;
 *   `zeroNewStreak` 零新增连击相对**本会话 seenBvids** 判定, F5 后语义不成立 => 维持会话级不落盘
 * - `isDry` 读侧 = TagRecTidDryTracker 内存图 ∪ 本持久图并集 (tracker 侧 persistEmpty 门控)
 * - 惰性加载 + 防抖批量落盘 (video-tags-store.ts:21-39 同款模板);
 *   模块加载即惰性读盘 (store/index.ts 顶层 Promise.all 同款先点火, 不占冷启动链)
 * - 签名变只清内存干态, **持久图保留** (票面裁「留更省」: tid 干是源属性不是组属性,
 *   TTL 兜底复活 —— 到期读侧自然放行, 重探仍空则再续一期)
 * - GM 读写失败 => fail-open 退化为纯会话干态, 不传染取数链路
 */

/** 空源干态 TTL: 票面区间 30~120min 取 60min —— 冷 tag 池会回填, TTL 即自然复活 */
export const DRY_TID_TTL_MS = 60 * 60_000
const STORAGE_KEY = 'tag-rec:dry-tids'
/** 落盘聚合窗口: 窗口内多次标干合并为一次 GM.setValue */
const FLUSH_DEBOUNCE_MS = 1_000

let map: Map<number, number> | undefined // tid → emptyUntil; undefined = 尚未加载完成
let mapPromise: Promise<Map<number, number> | undefined> | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined

function pool(): Promise<Map<number, number> | undefined> {
  mapPromise ??= Promise.resolve()
    // Promise.resolve().then 起步: GM 未注入 (测试/node 环境) 时 ReferenceError 落入 catch 不炸模块
    .then(() => GM.getValue<[number, number][]>(STORAGE_KEY, []))
    .then((rows) => {
      const now = Date.now()
      // 惰性过期: 读盘即弃 TTL 到期项 (过期空源重获一轮探测机会)
      map = new Map(rows.filter(([, until]) => until > now))
      return map
    })
    .catch(() => {
      mapPromise = undefined // 读取失败不锁死, 下次重试
      return undefined
    })
  return mapPromise
}

// 模块加载即惰性读盘: 首个 fetchMore 前持久图大概率已就位; 未就位时 isPersistedDryTid 退化为 false
void pool()

/** 惰性读盘入口 (顶层已点火; 导出供测试/调用侧等待持久图就位; resolve undefined = 读失败/无 GM) */
export function loadDryTids(): Promise<unknown> {
  return pool()
}

function scheduleFlush(m: Map<number, number>) {
  if (flushTimer) return // 已有待落盘批次, 聚合窗口内合并
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    // [tag-rec] AUDIT-26: 落盘前滤 TTL 死项 —— 读盘过滤只在载入跑, 不滤则过期 emptyUntil 被全量回写携尸
    const now = Date.now()
    for (const [tid, until] of m) if (until <= now) m.delete(tid)
    GM.setValue(STORAGE_KEY, Array.from(m)).catch(() => undefined)
  }, FLUSH_DEBOUNCE_MS)
}

/** isDry 并集的持久支 (同步读已加载图): 未加载完成 / 无记录 / TTL 到期 => false (自然复活) */
export function isPersistedDryTid(tid: number): boolean {
  const until = map?.get(tid)
  return until !== undefined && until > Date.now()
}

/** empty 落盘: emptyUntil = now + TTL; 返回 promise 供测试/调用侧可观测 (调用侧可 void) */
export function persistDryTid(tid: number): Promise<void> {
  return pool().then((m) => {
    if (!m) return
    m.set(tid, Date.now() + DRY_TID_TTL_MS)
    scheduleFlush(m)
  })
}
