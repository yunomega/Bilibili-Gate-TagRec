import type { FavFolder } from './types/folders/list-all-folders'

export type FavThemeFolderMatchKind = 'exact' | 'prefix' | 'contains'
export type FavThemeFolderMatch = { folder: FavFolder; kind: FavThemeFolderMatchKind }

const RANK: Record<FavThemeFolderMatchKind, number> = { exact: 0, prefix: 1, contains: 2 }

/**
 * R9: 主题名匹配收藏夹 (「收藏到主题夹」用)
 * - 排序: 精确 > 前缀 > 包含; 同档保持列表原序 (sort 稳定)
 * - 上限 3 (设计定案; 更多走「选择其他文件夹…」原弹层)
 * - 大小写不敏感; 空主题/空夹名跳过
 * - 不依赖 `tag-rec·` 前缀 (命名软化定案): 手建夹与旧前缀夹都能被匹配到
 */
export function matchFavFoldersByTheme(theme: string, folders: readonly FavFolder[], limit = 3): FavThemeFolderMatch[] {
  const t = theme.trim().toLowerCase()
  if (!t) return []
  const out: FavThemeFolderMatch[] = []
  for (const folder of folders) {
    const title = folder.title.trim().toLowerCase()
    if (!title) continue
    const kind: FavThemeFolderMatchKind | undefined =
      title === t ? 'exact' : title.startsWith(t) ? 'prefix' : title.includes(t) ? 'contains' : undefined
    if (kind) out.push({ folder, kind })
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind]).slice(0, limit)
}
