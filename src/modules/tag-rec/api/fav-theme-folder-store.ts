/**
 * [tag-rec] R9 主题夹账本 (GM `tag-rec:fav-theme-folders`)
 * - 记录「本脚本创建的主题夹」: {folderId, themeName, createdAt} —— 两个用途:
 *   ① 每日建夹配额计数 (B站上限约 5/日, 社区口径; 手动建夹也占配额, 本地账只算脚本建的)
 *   ② 旧名夹识别 (改名对齐): folderId 在账 ∧ 记账名 ≠ 当前主题名 => 旧名夹
 * - 惰性读盘 + 防抖批量落盘 (dry-tids-store.ts 同款模板); GM 失败 fail-open (退化为空账)
 */
export type TagRecFavThemeFolderRecord = { folderId: number; themeName: string; createdAt: number }

const STORAGE_KEY = 'tag-rec:fav-theme-folders'
/** 账本保留窗口 (旧记录仅服务改名对齐, 90 天足够) */
const KEEP_MS = 90 * 86400_000
const FLUSH_DEBOUNCE_MS = 1_000
const MAX_ROWS = 500

let rows: TagRecFavThemeFolderRecord[] | undefined
let rowsPromise: Promise<TagRecFavThemeFolderRecord[] | undefined> | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined

function pool(): Promise<TagRecFavThemeFolderRecord[] | undefined> {
  rowsPromise ??= Promise.resolve()
    // Promise.resolve().then 起步: GM 未注入 (测试/node 环境) 时 ReferenceError 落入 catch 不炸模块
    .then(() => GM.getValue<TagRecFavThemeFolderRecord[]>(STORAGE_KEY, []))
    .then((list) => {
      const now = Date.now()
      rows = (list ?? []).filter((x) => x && x.createdAt > now - KEEP_MS).slice(-MAX_ROWS)
      return rows
    })
    .catch(() => {
      rowsPromise = undefined // 读取失败不锁死, 下次重试
      return undefined
    })
  return rowsPromise
}

// 模块加载即惰性读盘 (首个使用前大概率已就位)
void pool()

export function loadTagRecFavThemeFolderRecords(): Promise<TagRecFavThemeFolderRecord[] | undefined> {
  return pool()
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void Promise.resolve()
      .then(() => GM.setValue(STORAGE_KEY, rows ?? []))
      .catch(() => undefined)
  }, FLUSH_DEBOUNCE_MS)
}

/** 记账: 本脚本新建了一个主题夹 */
export function noteTagRecFavThemeFolderCreated(rec: TagRecFavThemeFolderRecord): void {
  void pool().then((r) => {
    if (!r) return
    r.push(rec)
    scheduleFlush()
  })
}

/** 改名对齐后同步记账名 (旧名夹转正) */
export function updateTagRecFavThemeFolderName(folderId: number, themeName: string): void {
  void pool().then((r) => {
    const hit = r?.find((x) => x.folderId === folderId)
    if (!hit) return
    hit.themeName = themeName
    scheduleFlush()
  })
}

/** 今日已建数 (本地账口径; B站上限约 5/日 且含手动建夹) */
export async function tagRecFavThemeFolderCreatedTodayCount(): Promise<number> {
  const r = (await pool()) ?? []
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return r.filter((x) => x.createdAt >= start.getTime()).length
}

/** 账本记录查询 (旧名夹识别用; undefined = 非本脚本创建/无账) */
export async function tagRecFavThemeFolderRecordOf(folderId: number): Promise<TagRecFavThemeFolderRecord | undefined> {
  const r = (await pool()) ?? []
  return r.find((x) => x.folderId === folderId)
}
