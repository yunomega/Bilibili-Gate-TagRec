import { addFav, createFavFolder, renameFavFolder } from '$modules/rec-services/fav/api'
import { matchFavFoldersByTheme, type FavThemeFolderMatch } from '$modules/rec-services/fav/fav-theme-match'
import { favStore, updateFavFolderList } from '$modules/rec-services/fav/store'
import {
  noteTagRecFavThemeFolderCreated,
  tagRecFavThemeFolderCreatedTodayCount,
  tagRecFavThemeFolderRecordOf,
  updateTagRecFavThemeFolderName,
} from '../api/fav-theme-folder-store'
import { resolveTagRecThemeNameOfGroups } from '../model/attribution'
import { stripRelatedSuffix } from '../model/dig'
import { favorites, favoritesL1, themes } from '../store'

/**
 * [tag-rec] R9 「收藏到主题夹」编排 (右键菜单/小弹层共用)
 * - 设计定案 (map.md Round 1~3): 单位=主题; 默认裸主题名; 优先匹配已有夹 (主题名子串);
 *   无匹配提示建夹; 撞名=精确复用; 夹 ↔ 主题不做持续同步 (命名即映射 + 动作时一次性对齐)
 * - 风控: 收藏面 = 登录态通道 (账号维度) —— 只在显式点击时发, 零自动化; 夹列表复用 favStore 缓存 (5min)
 * - 配额: B站每日建夹上限约 5 个 (社区口径, 含手动建夹); 达上限/建夹失败 => 降级到匹配夹
 */

/** B站每日建夹上限 (社区口径 ~5; 仅作前置提示, 真实限制以 API 拒绝为准) */
export const TAG_REC_FAV_THEME_FOLDER_DAILY_HINT = 5

export type FavThemeFolderActionResult = {
  ok: boolean
  message: string
  folderTitle?: string
  /** 本次是否真的新建了夹 */
  created?: boolean
}

/** 卡片归属主题名 (tab1 组源; 组→L1→themeId→主题表; 多认领取首个命中) */
export function resolveCardThemeName(groupNames: readonly string[] | undefined): string | undefined {
  const names = [...new Set((groupNames ?? []).map(stripRelatedSuffix))]
  const l1ById = new Map(favoritesL1.list.map((l) => [l.id, l]))
  const themeById = new Map(themes.list.map((t) => [t.id, t]))
  return resolveTagRecThemeNameOfGroups(names, favorites.list, l1ById, themeById)
}

/** 主题夹匹配 (读 favStore 缓存, 5min 内零请求; 缓存缺失/过期才发一次 list-all) */
export async function matchThemeFolders(themeName: string): Promise<FavThemeFolderMatch[]> {
  try {
    await updateFavFolderList()
  } catch {
    /* fail-open: 用现有缓存 */
  }
  return matchFavFoldersByTheme(themeName, favStore.folders)
}

/** 旧名夹识别 (改名对齐): 记账名 ≠ 当前主题名 => 返回旧名 */
export async function legacyThemeNameOf(folderId: number, themeName: string): Promise<string | undefined> {
  const rec = await tagRecFavThemeFolderRecordOf(folderId)
  return rec && rec.themeName !== themeName ? rec.themeName : undefined
}

function errorReasonOf(err: unknown): string {
  const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code
  if (code === -509) return '操作过快 (-509)'
  if (code === -412) return '触发风控 (-412)'
  if (code === -101) return '未登录 (-101)'
  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
  return msg ? `创建失败: ${msg}` : '创建失败'
}

/** 降级候选: 精确 > 前缀 > 包含 的首个匹配夹 */
async function firstFallback(themeName: string): Promise<FavThemeFolderMatch | undefined> {
  const ms = await matchThemeFolders(themeName)
  return ms.find((m) => m.kind === 'exact') ?? ms[0]
}

/** 收藏到指定夹 (菜单「匹配夹」项/弹层「全部夹」项共用) */
export async function favToThemeFolder(
  avid: string,
  folderId: number,
  folderTitle: string,
): Promise<FavThemeFolderActionResult> {
  const r = await addFav(avid, [folderId])
  return r.isOk()
    ? { ok: true, message: `已收藏到「${folderTitle}」`, folderTitle }
    : { ok: false, message: '收藏失败, 请稍后再试' }
}

/**
 * 创建并收藏 (V3 弹层 [创建并收藏]):
 * 配额前置检查 → 建夹 (intro 写来源标记) → 记账 → 收藏;
 * 达上限/建夹失败 => 降级到匹配夹; 无匹配 => 明确报错
 */
export async function createThemeFolderAndFav(
  avid: string,
  themeName: string,
  opts: { title: string; privacy?: 0 | 1 },
): Promise<FavThemeFolderActionResult> {
  const today = await tagRecFavThemeFolderCreatedTodayCount()
  if (today >= TAG_REC_FAV_THEME_FOLDER_DAILY_HINT) {
    const fb = await firstFallback(themeName)
    if (fb) {
      const r = await addFav(avid, [fb.folder.id])
      if (r.isOk()) {
        return {
          ok: true,
          message: `今日建夹已达上限 (约 5/日) → 已收藏到「${fb.folder.title}」`,
          folderTitle: fb.folder.title,
        }
      }
    }
    return { ok: false, message: '今日建夹已达上限 (约 5/日), 且无匹配收藏夹 —— 明天再来' }
  }

  const res = await createFavFolder({
    title: opts.title,
    intro: `tag-rec · 主题「${themeName}」`,
    privacy: opts.privacy,
  })
  if (res.isErr()) {
    const reason = errorReasonOf(res.error)
    const fb = await firstFallback(themeName)
    if (fb) {
      const r = await addFav(avid, [fb.folder.id])
      if (r.isOk()) {
        return { ok: true, message: `${reason} → 已收藏到「${fb.folder.title}」`, folderTitle: fb.folder.title }
      }
    }
    return { ok: false, message: reason }
  }

  const { id } = res.value
  if (id) noteTagRecFavThemeFolderCreated({ folderId: id, themeName, createdAt: Date.now() })
  const addRes = await addFav(avid, id ? [id] : undefined)
  if (addRes.isErr()) return { ok: false, message: '收藏夹已创建, 但收藏失败, 请重试' }
  return { ok: true, message: `已创建并收藏到「${opts.title}」`, folderTitle: opts.title, created: true }
}

/** 旧名对齐 (一次性, 用户显式点): 把夹改名为当前主题名 + 同步记账 */
export async function alignThemeFolderName(folderId: number, themeName: string): Promise<FavThemeFolderActionResult> {
  const r = await renameFavFolder(folderId, themeName)
  if (r.isErr()) return { ok: false, message: '改名失败, 请稍后再试' }
  updateTagRecFavThemeFolderName(folderId, themeName)
  return { ok: true, message: `已把夹改名为「${themeName}」`, folderTitle: themeName }
}
