import { beforeEach, describe, expect, it, vi } from 'vitest'
import toast from '$utility/toast'
import { getShareDetail, type ShareDetailOutcome } from '../api/share'
import { decodeSharePkgCode } from '../model/share-pkg'
import { tagRecSharedSession } from '../store/session'
import { closeShareImportDraft, requestShareImport, requestShareImportPkg } from './share-import'

vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/share', () => ({ getShareDetail: vi.fn(), TAG_REC_SHARE_SITE_BASE: 'https://example.invalid' }))
vi.mock('../model/import-export', () => ({
  parseTagRecConfig: (text: string) => ({ ok: true, data: JSON.parse(text) }),
}))
vi.mock('../model/share', () => ({
  SHARE_ID_RE: /^[\w-]{10}$/,
  buildSharePageUrl: (base: string, id: string) => `${base}/?share=${id}`,
  isShareFactoryFilterConfig: () => true,
  planShareImport: () => ({ plan: { favoritesToAdd: [] }, missingGroupCount: 0 }),
}))
vi.mock('../model/share-pkg', () => ({ decodeSharePkgCode: vi.fn() }))
vi.mock('../store', () => ({
  favorites: { list: [] },
  blacklist: { list: [] },
  favoritesL1Store: { list: [] },
  themesStore: { list: [] },
}))
vi.mock('../store/session', () => ({ tagRecSharedSession: { shareImport: {} } }))
vi.mock('../store/share-tokens', () => ({ rememberPendingShareLike: vi.fn() }))

const detail = (title = 'current'): ShareDetailOutcome => ({
  kind: 'ok',
  detail: {
    id: 'abcdefghij',
    mid: 7,
    nickname: 'UP',
    title,
    likesCount: 0,
    groupCount: 1,
    idCount: 1,
    payload: { version: 2, favorites: [] },
  },
})
beforeEach(() => {
  closeShareImportDraft()
  vi.clearAllMocks()
  vi.mocked(getShareDetail).mockReset()
  vi.mocked(decodeSharePkgCode).mockReset()
})

describe('share import lifetime and failure recovery', () => {
  it('contains rejected reads and resets loading with one user-visible error', async () => {
    vi.mocked(getShareDetail).mockRejectedValue(new Error('offline'))
    await expect(requestShareImport('abcdefghij', undefined, 'paste')).resolves.toBeUndefined()
    expect(tagRecSharedSession.shareImport.loading).toBe(false)
    expect(tagRecSharedSession.shareImport.draft).toBeUndefined()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('contains decoder failures rather than rejecting the UI action', async () => {
    vi.mocked(decodeSharePkgCode).mockRejectedValue(new Error('decoder failed'))
    await expect(requestShareImportPkg('z.example', 'paste')).resolves.toBeUndefined()
    expect(tagRecSharedSession.shareImport.loading).toBe(false)
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('closing the draft cancels its read and ignores a late successful response', async () => {
    const held = Promise.withResolvers<ShareDetailOutcome>()
    vi.mocked(getShareDetail).mockReturnValue(held.promise)
    const task = requestShareImport('abcdefghij', undefined, 'paste')
    const signal = vi.mocked(getShareDetail).mock.calls[0]?.[1]?.signal
    closeShareImportDraft()
    held.resolve(detail())
    await task
    expect(signal?.aborted).toBe(true)
    expect(tagRecSharedSession.shareImport.draft).toBeUndefined()
    expect(tagRecSharedSession.shareImport.loading).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })

  it('a replacement cancels the old read and old failures cannot close or overwrite the new draft', async () => {
    const held = Promise.withResolvers<ShareDetailOutcome>()
    vi.mocked(getShareDetail).mockReturnValueOnce(held.promise).mockResolvedValue(detail('new'))
    const first = requestShareImport('abcdefghij', undefined, 'paste')
    const done = expect(first).resolves.toBeUndefined()
    const oldSignal = vi.mocked(getShareDetail).mock.calls[0]?.[1]?.signal
    await requestShareImport('abcdefghij', undefined, 'deeplink')
    held.reject(new Error('old failure'))
    await done
    expect(oldSignal?.aborted).toBe(true)
    expect(tagRecSharedSession.shareImport.draft?.title).toBe('new')
    expect(tagRecSharedSession.shareImport.origin).toBe('deeplink')
    expect(toast).not.toHaveBeenCalled()
  })
})
