import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// 外围替身: fav api / fav store / tag-rec store / 账本 —— 被测件 (fav-theme-folder) 保持真身
const api = vi.hoisted(() => ({
  addFav: vi.fn(),
  createFavFolder: vi.fn(),
  renameFavFolder: vi.fn(),
}))
vi.mock('$modules/rec-services/fav/api', () => api)

const favStoreMock = vi.hoisted(() => ({ folders: [] as unknown[] }))
vi.mock('$modules/rec-services/fav/store', () => ({
  favStore: favStoreMock,
  updateFavFolderList: vi.fn(() => Promise.resolve()),
}))

const tagRecStore = vi.hoisted(() => ({
  favorites: { list: [] as unknown[] },
  favoritesL1: { list: [] as unknown[] },
  themes: { list: [] as unknown[] },
}))
vi.mock('../store', () => tagRecStore)

const bookkeeping = vi.hoisted(() => ({
  tagRecFavThemeFolderCreatedTodayCount: vi.fn(),
  tagRecFavThemeFolderRecordOf: vi.fn(),
  noteTagRecFavThemeFolderCreated: vi.fn(),
  updateTagRecFavThemeFolderName: vi.fn(),
}))
vi.mock('../api/fav-theme-folder-store', () => bookkeeping)

const svc = await import('./fav-theme-folder')

const folder = (id: number, title: string) => ({ id, fid: 0, mid: 1, attr: 0, title, fav_state: 0, media_count: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  favStoreMock.folders = []
  tagRecStore.favorites.list = []
  tagRecStore.favoritesL1.list = []
  tagRecStore.themes.list = []
  bookkeeping.tagRecFavThemeFolderCreatedTodayCount.mockResolvedValue(0)
  bookkeeping.tagRecFavThemeFolderRecordOf.mockResolvedValue(undefined)
})

describe('R9 主题名解析 (resolveCardThemeName)', () => {
  it('组→L1→themeId→主题表; 多认领取首个命中; 无主题/组不存在 => undefined', () => {
    tagRecStore.favorites.list = [{ name: '类恶魔城', l1Id: 'l1a' }]
    tagRecStore.favoritesL1.list = [{ id: 'l1a', name: '银河城', themeId: 'th1' }]
    tagRecStore.themes.list = [{ id: 'th1', name: '独立游戏' }]
    expect(svc.resolveCardThemeName(['类恶魔城'])).toBe('独立游戏')
    expect(svc.resolveCardThemeName(['不存在', '类恶魔城'])).toBe('独立游戏')
    expect(svc.resolveCardThemeName(['不存在'])).toBeUndefined()
    tagRecStore.favorites.list = [{ name: '裸组', l1Id: undefined }]
    expect(svc.resolveCardThemeName(['裸组'])).toBeUndefined()
  })

  it('去 ·相关 后缀 (深挖条目旁路归因) 再解析', () => {
    tagRecStore.favorites.list = [{ name: '类恶魔城', l1Id: 'l1a' }]
    tagRecStore.favoritesL1.list = [{ id: 'l1a', name: '银河城', themeId: 'th1' }]
    tagRecStore.themes.list = [{ id: 'th1', name: '独立游戏' }]
    expect(svc.resolveCardThemeName(['类恶魔城·相关'])).toBe('独立游戏')
  })
})

describe('R9 编排 (createThemeFolderAndFav / 降级)', () => {
  it('正常建夹: create → 记账 → addFav(新 id)', async () => {
    api.createFavFolder.mockResolvedValue(Result.ok({ id: 7, title: '独立游戏' }))
    api.addFav.mockResolvedValue(Result.ok({}))
    const r = await svc.createThemeFolderAndFav('BV1', '独立游戏', { title: '独立游戏' })
    expect(r.ok).toBe(true)
    expect(r.created).toBe(true)
    expect(api.createFavFolder).toHaveBeenCalledWith({
      title: '独立游戏',
      intro: 'tag-rec · 主题「独立游戏」',
      privacy: undefined,
    })
    expect(bookkeeping.noteTagRecFavThemeFolderCreated).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 7, themeName: '独立游戏' }),
    )
    expect(api.addFav).toHaveBeenCalledWith('BV1', [7])
  })

  it('配额达上限: 不建夹, 降级到精确匹配夹', async () => {
    bookkeeping.tagRecFavThemeFolderCreatedTodayCount.mockResolvedValue(5)
    favStoreMock.folders = [folder(1, '独立游戏'), folder(2, '独立游戏合集')]
    api.addFav.mockResolvedValue(Result.ok({}))
    const r = await svc.createThemeFolderAndFav('BV1', '独立游戏', { title: '独立游戏' })
    expect(r.ok).toBe(true)
    expect(api.createFavFolder).not.toHaveBeenCalled()
    expect(api.addFav).toHaveBeenCalledWith('BV1', [1]) // 精确优先
    expect(r.message).toContain('上限')
  })

  it('配额达上限 + 无匹配: 明确报错 (不静默)', async () => {
    bookkeeping.tagRecFavThemeFolderCreatedTodayCount.mockResolvedValue(5)
    const r = await svc.createThemeFolderAndFav('BV1', '新主题', { title: '新主题' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('明天再来')
  })

  it('建夹失败 (-509): 错误码映射 + 降级到匹配夹', async () => {
    api.createFavFolder.mockResolvedValue(Result.err({ response: { data: { code: -509 } } }))
    favStoreMock.folders = [folder(3, '独立游戏合集')]
    api.addFav.mockResolvedValue(Result.ok({}))
    const r = await svc.createThemeFolderAndFav('BV1', '独立游戏', { title: '独立游戏' })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('-509')
    expect(api.addFav).toHaveBeenCalledWith('BV1', [3])
  })

  it('建夹失败 + 无匹配: 报错不降级', async () => {
    api.createFavFolder.mockResolvedValue(Result.err({ response: { data: { code: -412 } } }))
    const r = await svc.createThemeFolderAndFav('BV1', '新主题', { title: '新主题' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('-412')
    expect(api.addFav).not.toHaveBeenCalled()
  })

  it('收藏到指定夹 / 改名对齐', async () => {
    api.addFav.mockResolvedValue(Result.ok({}))
    expect((await svc.favToThemeFolder('BV1', 9, '独立游戏')).ok).toBe(true)

    api.renameFavFolder.mockResolvedValue(Result.ok({}))
    const r = await svc.alignThemeFolderName(9, '恶魔城')
    expect(r.ok).toBe(true)
    expect(api.renameFavFolder).toHaveBeenCalledWith(9, '恶魔城')
    expect(bookkeeping.updateTagRecFavThemeFolderName).toHaveBeenCalledWith(9, '恶魔城')

    api.renameFavFolder.mockResolvedValue(Result.err('x'))
    expect((await svc.alignThemeFolderName(9, '恶魔城')).ok).toBe(false)
  })

  it('旧名夹识别: 记账名 ≠ 当前主题名 => 返回旧名', async () => {
    bookkeeping.tagRecFavThemeFolderRecordOf.mockResolvedValue({ folderId: 9, themeName: '类恶魔城', createdAt: 1 })
    expect(await svc.legacyThemeNameOf(9, '恶魔城')).toBe('类恶魔城')
    expect(await svc.legacyThemeNameOf(9, '类恶魔城')).toBeUndefined()
  })
})
