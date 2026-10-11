import { AxiosHeaders } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('$request', () => ({
  request: { get: mocks.get },
  isWebApiSuccess: (json: { code?: number }) => json?.code === 0,
}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('Thu, 08 Oct 2026 00:00:00 GMT'))
  mocks.get.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('UP search respects server recovery deadlines', () => {
  it.each([
    { status: 429, rejected: false },
    { status: 429, rejected: true },
    { status: 503, rejected: false },
    { status: 503, rejected: true },
  ])('honors Retry-After without automatic retries: %j', async ({ status, rejected }) => {
    const { fetchUpSearchPage } = await import('./up-search')
    const now = Date.now()
    const response = { status, data: { code: -500 }, headers: new AxiosHeaders({ 'Retry-After': '900' }) }
    if (rejected)
      mocks.get.mockRejectedValue(Object.assign(new Error('HTTP failure'), { isAxiosError: true, response }))
    else mocks.get.mockResolvedValue(response)
    await expect(fetchUpSearchPage(1, 'audit', 1)).rejects.toMatchObject({
      name: 'UpSearchPausedError',
      retryAt: now + 900_000,
    })
    await vi.advanceTimersByTimeAsync(300_000)
    await expect(fetchUpSearchPage(2, 'audit', 1)).rejects.toMatchObject({ retryAt: now + 900_000 })
    expect(mocks.get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600_000)
    mocks.get.mockResolvedValue({
      status: 200,
      data: { code: 0, data: { list: { vlist: [] }, page: { pn: 1, ps: 30, count: 0 } } },
    })
    await expect(fetchUpSearchPage(2, 'audit', 1)).resolves.toEqual({ items: [], hasMore: false })
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
})
