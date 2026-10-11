import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShareFactoryFilterConfig } from '../model/share'
import {
  checkDupShare,
  deleteShare,
  getShareDetail,
  likeShare,
  patchShare,
  uploadShare,
  type ShareUploadBody,
} from './share'

vi.mock('$modules/bilibili/user/login-info', () => ({ fetchLoginInfo: vi.fn() }))
type Request = {
  method: string
  data?: string
  timeout?: number
  url: string
  anonymous?: boolean
  headers?: Record<string, string>
  onload?: (r: { status: number; responseText: string }) => void
  onabort?: () => void
  onerror?: () => void
  ontimeout?: () => void
}
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const requests: Request[] = []
const abort = vi.fn()
const xhr = vi.fn((options: Request) => {
  requests.push(options)
  return { abort }
})
const body: ShareUploadBody = {
  mid: 7,
  nickname: 'UP',
  title: 'test',
  payload: {
    version: 2,
    l1: [],
    themes: [],
    favorites: [],
    blacklist: [],
    filterConfig: createShareFactoryFilterConfig(),
  },
}
const cases: { name: string; invoke: () => Promise<{ kind: string }> }[] = [
  { name: 'upload', invoke: () => uploadShare(body) },
  { name: 'detail', invoke: () => getShareDetail('abcdefghij') },
  { name: 'patch', invoke: () => patchShare('abcdefghij', 'secret', { title: 'new' }) },
  { name: 'delete', invoke: () => deleteShare('abcdefghij', 'secret') },
  { name: 'like', invoke: () => likeShare('abcdefghij', 7) },
  { name: 'duplicate check', invoke: () => checkDupShare({ mid: 7, title: 'test', tagIds: [1] }) },
]
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}
beforeEach(() => {
  requests.length = 0
  abort.mockReset()
  xhr.mockReset().mockImplementation((options) => {
    requests.push(options)
    return { abort }
  })
  vi.stubGlobal('GM', { xmlHttpRequest: xhr })
})
afterEach(() => vi.unstubAllGlobals())

describe('share transport settlement and isolation', () => {
  it.each(cases)(
    '$name reports synchronous transport failure as an outcome, not an unhandled rejection',
    async ({ invoke }) => {
      xhr.mockImplementation(() => {
        throw new Error('GM unavailable')
      })
      await expect(invoke()).resolves.toMatchObject({ kind: 'failed' })
      expect(xhr).toHaveBeenCalledTimes(1)
    },
  )

  it.each(cases)('$name settles on a userscript-manager abort without retries', async ({ invoke }) => {
    const done = vi.fn()
    void invoke().then(done, done)
    await flush()
    requests[0].onabort?.()
    await flush()
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed' }))
    expect(xhr).toHaveBeenCalledTimes(1)
  })

  it('cancels a detail request even when the manager does not emit onabort', async () => {
    const controller = new AbortController()
    const done = vi.fn()
    const task = getShareDetail('abcdefghij', { signal: controller.signal }).then(done)
    await flush()
    controller.abort()
    await flush()
    const immediate = done.mock.calls[0]?.[0]
    // Settle the old implementation too; this assertion does not depend on a wall-clock timeout.
    requests[0].onerror?.()
    await task
    expect(immediate).toMatchObject({ kind: 'failed' })
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('does not send a request for an already-cancelled detail read', async () => {
    xhr.mockImplementation((options) => {
      queueMicrotask(() => options.onerror?.())
      return { abort }
    })
    const controller = new AbortController()
    controller.abort()
    expect(await getShareDetail('abcdefghij', { signal: controller.signal })).toMatchObject({ kind: 'failed' })
    expect(xhr).not.toHaveBeenCalled()
  })

  it('rejects a detail response identifying a different share', async () => {
    const task = getShareDetail('abcdefghij')
    requests[0].onload?.({
      status: 200,
      responseText: JSON.stringify({
        id: 'klmnopqrst',
        mid: 7,
        title: 'wrong share',
        payload: {},
      }),
    })
    expect(await task).toMatchObject({ kind: 'failed' })
  })

  it('contains serialization errors without sending a write request', async () => {
    const cyclic = { ...body }
    ;(cyclic as unknown as Record<string, unknown>).self = cyclic
    await expect(uploadShare(cyclic)).resolves.toMatchObject({ kind: 'failed' })
    expect(xhr).not.toHaveBeenCalled()
  })

  it.each(cases)('$name does not attach a browser cookie or Bilibili credentials', async ({ invoke }) => {
    const task = invoke()
    expect(requests[0].anonymous).toBe(true)
    expect(requests[0].headers?.Cookie).toBeUndefined()
    expect(requests[0].url).not.toContain('access_key')
    requests[0].onerror?.()
    await task
  })
})

describe('share wire contract regression coverage', () => {
  it.each([
    {
      index: 0,
      method: 'POST',
      status: 201,
      json: { id: 'abcdefghij', mgmtToken: 'new-token', status: 'pending' },
      expected: { kind: 'ok', id: 'abcdefghij', mgmtToken: 'new-token', status: 'pending' },
    },
    {
      index: 1,
      method: 'GET',
      status: 200,
      json: { id: 'abcdefghij', mid: 7, title: 'read', payload: {}, likes_count: 9 },
      expected: { kind: 'ok', detail: { id: 'abcdefghij', title: 'read', likesCount: 9 } },
    },
    {
      index: 2,
      method: 'PATCH',
      status: 200,
      json: { id: 'abcdefghij', title: 'new', description: null, status: 'pending' },
      expected: { kind: 'ok', id: 'abcdefghij', description: null, status: 'pending' },
    },
    { index: 3, method: 'DELETE', status: 200, json: { status: 'removed' }, expected: { kind: 'ok' } },
    {
      index: 4,
      method: 'POST',
      status: 200,
      json: { liked: true, likes_count: 3, already: true },
      expected: { kind: 'ok', likesCount: 3, already: true },
    },
    {
      index: 5,
      method: 'POST',
      status: 200,
      json: { dups: [{ id: 'abcdefghij', title: 'match', similarity: 0.5 }] },
      expected: { kind: 'ok', dups: [{ id: 'abcdefghij', title: 'match', similarity: 0.5 }] },
    },
  ])('preserves endpoint $index success and method semantics', async ({ index, method, status, json, expected }) => {
    const task = cases[index].invoke()
    const request = requests[0]
    expect(request.method).toBe(method)
    expect(request.headers?.['X-Mgmt-Token']).toBe(index === 2 || index === 3 ? 'secret' : undefined)
    if (index === 0) expect(JSON.parse(request.data!)).toEqual(body)
    request.onload?.({ status, responseText: JSON.stringify(json) })
    expect(await task).toMatchObject(expected)
    expect(xhr).toHaveBeenCalledTimes(1)
  })

  it.each([400, 422])('preserves structured upload rejection for HTTP %s', async (status) => {
    const task = uploadShare(body)
    requests[0].onload?.({ status, responseText: JSON.stringify({ error: 'bad', field: 'title', reason: 'invalid' }) })
    expect(await task).toMatchObject({ kind: 'rejected', issues: [{ field: 'title', reason: 'invalid' }] })
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [409, 'conflict'],
  ] as const)('preserves PATCH HTTP %s handling', async (status, kind) => {
    const task = patchShare('abcdefghij', 'secret', { title: 'new' })
    requests[0].onload?.({ status, responseText: '{}' })
    expect(await task).toMatchObject({ kind })
  })
})
