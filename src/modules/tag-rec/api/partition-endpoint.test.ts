import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evalTagRecPartitionEntry } from '../model/partition'
import { tagRecBackoff } from './backoff'
import { fetchAllV2Search, fetchVideoPartition, fetchVideoTags } from './endpoints'
import { rememberTagRecPartition } from './partition-cache'
import { gmAnonGet, type GmAnonResponse } from './request'
import { fetchTagRecVideoEvidence } from './video-evidence'
import { getPersistedVideoTags, persistVideoTags } from './video-tags-store'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$request', () => ({ isWebApiSuccess: (json: { code?: number }) => json?.code === 0 }))
vi.mock('./request', () => ({ gmAnonGet: vi.fn() }))
vi.mock('./fingerprint', () => ({
  ensureTagRecFingerprint: vi.fn(() => Promise.resolve()),
  fingerprintCookieHeader: () => '',
  hasTagRecFingerprint: () => false,
  getTagRecFingerprintStats: () => ({ has: false, disabled: false }),
}))
vi.mock('./backoff', async () => {
  const { pLimit } = await import('promise.map')
  class RiskControlError extends Error {
    constructor() {
      super('risk')
    }
  }
  return {
    RiskControlError,
    tagRecLimit: pLimit(4),
    allV2Limit: <T>(run: () => Promise<T>) => run(),
    tagRecSearchGate: { acquire: () => Promise.resolve(), reset: () => undefined },
    isRiskControlError: (error: unknown) => error instanceof RiskControlError,
    isRiskControlResponse: (response: { status: number }) => response.status === 412,
    tagRecBackoff: {
      waitTurn: vi.fn(() => Promise.resolve()),
      withRecoveryProbe: <T>(request: () => Promise<T>) => request(),
      onRiskControl: vi.fn(),
      onSuccess: vi.fn(),
      consecutiveHits: 0,
      isEngaged: false,
      currentIntervalMs: 0,
      lastRecoveredAt: 0,
      recentlyRecovered: () => false,
    },
  }
})
vi.mock('./tag-info-store', () => ({
  getPersistedTagInfoById: vi.fn(),
  getPersistedTagInfoByName: vi.fn(),
  persistTagInfo: vi.fn(),
}))
vi.mock('./video-tags-store', () => ({
  getPersistedVideoTags: vi.fn(),
  persistVideoTags: vi.fn(),
  evictPersistedVideoTags: vi.fn(),
}))

let serial = 0
const nextBvid = () => `partition-endpoint-${++serial}`
const response = (data: unknown, status = 200): GmAnonResponse => ({ status, data })
const detail = (bvid: string) => ({
  code: 0,
  // Actual first-party response shape rechecked anonymously on 2026-10-03.
  data: { View: { bvid, tid: 172, tid_v2: 2064, tname_v2: '' }, Tags: [{ tag_id: 1, tag_name: 'alpha' }] },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gmAnonGet).mockReset()
  vi.mocked(getPersistedVideoTags).mockReset().mockResolvedValue(undefined)
  vi.mocked(persistVideoTags).mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('实际元数据端点与会话缓存', () => {
  it('当前 View.tid_v2 可确认父分区，返回的 Tags 与严格标签校验共用', async () => {
    const bvid = nextBvid()
    const tags = detail(bvid).data.Tags
    vi.mocked(gmAnonGet).mockResolvedValue(response(detail(bvid)))
    vi.mocked(persistVideoTags).mockImplementation(() => {
      vi.mocked(getPersistedVideoTags).mockResolvedValue(tags)
      return Promise.resolve()
    })
    const fields = await fetchVideoPartition(bvid)
    expect(fields?.tidv2).toBe(2064)
    expect(evalTagRecPartitionEntry(fields!, { name: '游戏', v2: 1008 })).toBe('match')
    expect(await fetchVideoTags(bvid)).toEqual(tags)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
    expect(vi.mocked(gmAnonGet).mock.calls[0][0]).toBe('/x/web-interface/view/detail')
  })

  it('同 BV 在途与成功缓存只请求一次', async () => {
    const bvid = nextBvid()
    vi.mocked(gmAnonGet).mockResolvedValue(response(detail(bvid)))
    const [a, b] = await Promise.all([fetchVideoPartition(bvid), fetchVideoPartition(bvid)])
    expect(a).toEqual(b)
    expect(await fetchVideoPartition(bvid)).toEqual(a)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('搜索来源已有新版字段时直接复用，不再查详情', async () => {
    const bvid = nextBvid()
    vi.mocked(gmAnonGet).mockResolvedValue(
      response({
        code: 0,
        data: { result: [{ result_type: 'video', data: [{ bvid, typeid: 65, tidv2: 2090, pid_v2: 1010 }] }] },
      }),
    )
    await fetchAllV2Search('alpha')
    expect((await fetchVideoPartition(bvid))?.pid_v2).toBe(1010)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: '缺新版字段', json: (bvid: string) => ({ code: 0, data: { View: { bvid, tid: 65 } } }) },
    { label: '错误业务码', json: () => ({ code: -404 }) },
    { label: 'BV 不一致', json: () => detail('another-bv') },
  ])('$label 不会作为成功命中缓存，短期去重后允许重试', async ({ json }) => {
    vi.useFakeTimers()
    const bvid = nextBvid()
    vi.mocked(gmAnonGet).mockResolvedValue(response(json(bvid)))
    const first = await fetchVideoPartition(bvid)
    expect(first?.tidv2).toBeUndefined()
    vi.mocked(gmAnonGet).mockResolvedValue(response(detail(bvid)))
    expect((await fetchVideoPartition(bvid))?.tidv2).toBeUndefined()
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 15_001)
    expect((await fetchVideoPartition(bvid))?.tidv2).toBe(2064)
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
  })

  it('取消一个调用者不会取消同 BV 的其他调用者', async () => {
    const bvid = nextBvid()
    const deferred = Promise.withResolvers<GmAnonResponse>()
    vi.mocked(gmAnonGet).mockReturnValue(deferred.promise)
    const controller = new AbortController()
    const cancelled = fetchVideoPartition(bvid, { signal: controller.signal }).catch((error: unknown) => error)
    const survivor = fetchVideoPartition(bvid)
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await cancelled).toMatchObject({ name: 'AbortError' })
    deferred.resolve(response(detail(bvid)))
    expect((await survivor)?.tidv2).toBe(2064)
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('详情补查遇到风控立即结束，不在端点内部追加重试', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue(response({ code: -412 }, 412))
    await expect(fetchVideoPartition(nextBvid())).rejects.toThrow('risk')
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
    expect(tagRecBackoff.onRiskControl).toHaveBeenCalledTimes(1)
  })

  it('共享请求本身也有超时，单独调用不会永久等待', async () => {
    vi.useFakeTimers()
    vi.mocked(gmAnonGet).mockImplementation(
      (_url, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        }),
    )
    const result = fetchVideoPartition(nextBvid()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await result).toMatchObject({ name: 'AbortError' })
  })

  it('分区补查的同一详情响应直接服务组合证据，不再重复请求', async () => {
    const bvid = nextBvid()
    vi.mocked(gmAnonGet).mockResolvedValue(response(detail(bvid)))
    expect((await fetchVideoPartition(bvid))?.tidv2).toBe(2064)
    // 同一 /view/detail 响应已把字段全量入证据缓存 —— 组合证据补查 0 次新请求
    const evidence = await fetchTagRecVideoEvidence(bvid)
    expect(evidence?.tidv2).toBe(2064)
    expect(evidence?.ownTagIds).toEqual([1])
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('来源更新父分区会覆盖旧成功结果，新版叶变化不会继承旧父分区', async () => {
    const bvid = nextBvid()
    vi.mocked(gmAnonGet).mockResolvedValue(response(detail(bvid)))
    await fetchVideoPartition(bvid)
    rememberTagRecPartition(bvid, { tidv2: 2071, pid_v2: 1008 })
    rememberTagRecPartition(bvid, { tid_v2: 2090 })
    const fields = await fetchVideoPartition(bvid)
    expect(fields?.pid_v2).toBeUndefined()
    expect(evalTagRecPartitionEntry(fields!, { name: '游戏', v2: 1008 })).toBe('mismatch')
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })
})
