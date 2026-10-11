import { describe, expect, it } from 'vitest'
import { matchFavFoldersByTheme } from './fav-theme-match'
import type { FavFolder } from './types/folders/list-all-folders'

const folder = (id: number, title: string): FavFolder => ({
  id,
  fid: 0,
  mid: 1,
  attr: 0,
  title,
  fav_state: 0,
  media_count: 0,
})

const FOLDERS = [
  folder(0, '默认收藏夹'),
  folder(1, '独立游戏'),
  folder(2, '独立游戏合集'),
  folder(3, '我的·独立游戏'),
  folder(4, '游戏合集'),
  folder(5, 'tag-rec·独立游戏'),
  folder(6, '学习'),
]

describe('matchFavFoldersByTheme (R9 主题名匹配)', () => {
  it('排序: 精确 > 前缀 > 包含; 上限 3', () => {
    const ms = matchFavFoldersByTheme('独立游戏', FOLDERS)
    // 同档保原序: contains 档按列表原序 (我的·独立游戏 在 tag-rec·独立游戏 前)
    expect(ms.map((m) => m.folder.title)).toEqual(['独立游戏', '独立游戏合集', '我的·独立游戏'])
    expect(ms.map((m) => m.kind)).toEqual(['exact', 'prefix', 'contains'])
  })

  it('不依赖前缀: 手建/旧前缀夹都能中; 无匹配 => 空', () => {
    expect(matchFavFoldersByTheme('游戏合集', FOLDERS).map((m) => m.folder.id)).toEqual([4, 2]) // 精确 + 包含(独立游戏合集)
    expect(matchFavFoldersByTheme('新主题', FOLDERS)).toEqual([])
  })

  it('大小写不敏感 + 空主题/空夹名跳过', () => {
    const fs = [folder(9, 'GALGAME'), folder(10, ' '.repeat(3))]
    expect(matchFavFoldersByTheme('galgame', fs).map((m) => m.kind)).toEqual(['exact'])
    expect(matchFavFoldersByTheme('', FOLDERS)).toEqual([])
    expect(matchFavFoldersByTheme(' '.repeat(3), FOLDERS)).toEqual([])
  })

  it('同档保持原序 (稳定排序)', () => {
    const ms = matchFavFoldersByTheme('独立游戏', FOLDERS, 5)
    expect(ms.map((m) => m.folder.id)).toEqual([1, 2, 3, 5])
  })
})
