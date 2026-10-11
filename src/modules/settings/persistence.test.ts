import { snapshot } from 'valtio'
import { describe, expect, it, vi } from 'vitest'
import { settings } from './index'

const boundary = vi.hoisted(() => {
  const write = vi.fn(() => Promise.resolve())
  const backup = vi.fn(() => Promise.resolve())
  vi.stubGlobal('GM', { getValue: () => Promise.resolve(undefined), setValue: write })
  return {
    write,
    backup,
    receive: undefined as
      | { setPersist: (value: boolean) => void; onUpdate: (value: { pureRecommend: boolean }) => void }
      | undefined,
  }
})
vi.mock('$common', () => ({
  appWarn: vi.fn(),
  appError: vi.fn(),
  baseDebug: { extend: () => vi.fn() },
  IN_BILIBILI_HOMEPAGE: false,
}))
vi.mock('../tag-rec/api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$components/VideoCard/index.shared', () => ({ EVideoLinkOpenMode: { Normal: 'normal' } }))
vi.mock('$modules/gm', () => ({
  reciveGmValueUpdatesFromOtherTab: (options: typeof boundary.receive) => {
    boundary.receive = options
  },
}))
vi.mock('./cloud-backup', () => ({ saveToDraft: boundary.backup }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))

describe('设置跨标签页同步', () => {
  it('远端更新应用到内存但不回写或备份，随后本地编辑正常持久化', async () => {
    const receive = boundary.receive!
    const before = settings.pureRecommend
    boundary.write.mockClear()
    boundary.backup.mockClear()
    receive.setPersist(false)
    try {
      receive.onUpdate({ pureRecommend: !before })
    } finally {
      void Promise.resolve().then(() => receive.setPersist(true))
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(settings.pureRecommend).toBe(!before)
    expect(boundary.write).not.toHaveBeenCalled()
    expect(boundary.backup).not.toHaveBeenCalled()
    settings.pureRecommend = before
    await vi.waitFor(() => expect(boundary.backup).toHaveBeenCalledOnce())
    expect(boundary.write).toHaveBeenCalledExactlyOnceWith('settings', snapshot(settings))
    expect(boundary.backup).toHaveBeenCalledExactlyOnceWith(snapshot(settings))
  })
})
