import { beforeEach, describe, expect, it, vi } from 'vitest'

// GM 替身 (多键 store); 无 GM 的 fail-open 用 resetModules 另起实例
const store = new Map<string, unknown>()
const gmStub = () => ({
  getValue: (k: string, d: unknown) => Promise.resolve(store.has(k) ? store.get(k) : d),
  setValue: (k: string, v: unknown) => {
    store.set(k, v)
    return Promise.resolve()
  },
})
vi.stubGlobal('GM', gmStub())

const KEY = 'tag-rec:fav-theme-folders'
const today = () => Date.now()
const dayAgo = (n: number) => Date.now() - n * 86400_000

const load = async () => {
  vi.resetModules()
  return await import('./fav-theme-folder-store')
}

beforeEach(() => {
  store.clear()
  vi.useRealTimers()
})

describe('R9 主题夹账本 (fav-theme-folder-store)', () => {
  it('今日计数 / 记录查询 / 改名同步 (内存路径)', async () => {
    store.set(KEY, [
      { folderId: 1, themeName: '独立游戏', createdAt: today() },
      { folderId: 2, themeName: '独立游戏', createdAt: today() },
      { folderId: 3, themeName: '银河城', createdAt: dayAgo(1) },
    ])
    const m = await load()
    expect(await m.tagRecFavThemeFolderCreatedTodayCount()).toBe(2)
    expect(await m.tagRecFavThemeFolderRecordOf(3)).toMatchObject({ themeName: '银河城' })

    m.noteTagRecFavThemeFolderCreated({ folderId: 9, themeName: '恶魔城', createdAt: today() })
    await Promise.resolve()
    expect(await m.tagRecFavThemeFolderCreatedTodayCount()).toBe(3)

    m.updateTagRecFavThemeFolderName(9, '恶魔城·新')
    await Promise.resolve()
    expect(await m.tagRecFavThemeFolderRecordOf(9)).toMatchObject({ themeName: '恶魔城·新' })
  })

  it('note 后防抖落盘 (1s 窗口合并)', async () => {
    const m = await load()
    vi.useFakeTimers()
    m.noteTagRecFavThemeFolderCreated({ folderId: 5, themeName: 'A', createdAt: today() })
    m.noteTagRecFavThemeFolderCreated({ folderId: 6, themeName: 'B', createdAt: today() })
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1100)
    await Promise.resolve()
    await Promise.resolve()
    const persisted = store.get(KEY) as { folderId: number }[]
    expect(persisted.map((x) => x.folderId)).toEqual([5, 6]) // 两次合并为一次落盘
  })

  it('超 90 天记录读盘即剪枝', async () => {
    store.set(KEY, [
      { folderId: 1, themeName: '新', createdAt: today() },
      { folderId: 2, themeName: '旧', createdAt: dayAgo(100) },
    ])
    const m = await load()
    expect(await m.tagRecFavThemeFolderRecordOf(2)).toBeUndefined()
    expect(await m.tagRecFavThemeFolderRecordOf(1)).toBeTruthy()
  })

  it('无 GM: fail-open (计数 0, 记账不抛)', async () => {
    vi.stubGlobal('GM', undefined)
    const m = await load()
    expect(await m.tagRecFavThemeFolderCreatedTodayCount()).toBe(0)
    expect(await m.tagRecFavThemeFolderRecordOf(1)).toBeUndefined()
    expect(() => m.noteTagRecFavThemeFolderCreated({ folderId: 1, themeName: 'A', createdAt: today() })).not.toThrow()
    vi.stubGlobal('GM', gmStub()) // 复原给后续用例
  })
})
