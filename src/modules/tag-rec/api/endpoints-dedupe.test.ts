import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAllV2Search, fetchArchiveRelated, fetchTagTop, fetchVideoPartition, fetchVideoTags } from './endpoints'
import { gmAnonGet } from './request'
import { fetchTagRecVideoEvidence } from './video-evidence'

// 在途去重 (复用审查 #6 残余): 真 SessionFetchCache —— 同参数并发合并成一次底层请求;
// 落定结果 (含失败) dedupeMs=0 不复用, tag/top 同页重采样不被冻结
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$request', () => ({ isWebApiSuccess: (j: { code?: number }) => j?.code === 0 }))
vi.mock('./request', () => ({ gmAnonGet: vi.fn(() => Promise.resolve({ status: 200, data: { code: 0 } })) }))
vi.mock('./fingerprint', () => ({
  ensureTagRecFingerprint: vi.fn(() => Promise.resolve()),
  fingerprintCookieHeader: vi.fn(() => ''),
  hasTagRecFingerprint: vi.fn(() => false),
  getTagRecFingerprintStats: vi.fn(() => ({ has: false, disabled: false })),
}))
vi.mock('./backoff', async () => {
  const { pLimit } = await import('promise.map')
  return {
    tagRecBackoff: {
      waitTurn: vi.fn(() => Promise.resolve()),
      withRecoveryProbe: <T>(request: () => Promise<T>) => request(),
      onRiskControl: vi.fn(),
      onSuccess: vi.fn(),
      consecutiveHits: 0,
      isEngaged: false,
      lastRecoveredAt: 0,
      recentlyRecovered: vi.fn(() => false),
    },
    tagRecLimit: pLimit(4),
    allV2Limit: <T>(run: () => Promise<T>) => run(),
    isRiskControlError: vi.fn(() => false),
    isRiskControlResponse: vi.fn(() => false),
    RiskControlError: class RiskControlError extends Error {},
  }
})
vi.mock('./tag-info-store', () => ({
  getPersistedTagInfoById: vi.fn(),
  getPersistedTagInfoByName: vi.fn(),
  persistTagInfo: vi.fn(),
}))
vi.mock('./video-tags-store', () => ({
  evictPersistedVideoTags: vi.fn(),
  getPersistedVideoTags: vi.fn(),
  persistVideoTags: vi.fn(),
}))
vi.mock('./partition-cache', () => ({
  getCachedTagRecPartition: vi.fn(() => undefined),
  rememberTagRecPartition: vi.fn(),
}))
vi.mock('./video-evidence-store', () => ({
  getCachedTagRecVideoEvidence: vi.fn(() => undefined),
  rememberTagRecVideoEvidence: vi.fn((_bvid: string, data: { View?: unknown }) => data?.View),
}))

const pending = <T>() => {
  let release!: (v: T) => void
  const promise = new Promise<T>((r) => (release = r))
  return { promise, release }
}
const topJson = (items: unknown[] = []) => ({ status: 200, data: { code: 0, data: items } })
const searchJson = (items: unknown[] = []) => ({
  status: 200,
  data: { code: 0, data: { result: [{ result_type: 'video', data: items }] } },
})

describe('$modules/tag-rec/api/endpoints — 在途去重 (同参并发合一请求)', () => {
  beforeEach(() => {
    vi.mocked(gmAnonGet).mockReset()
  })

  it('tag/top: 同 tid+pn+ps 并发 => 一次底层请求, 两调用方同结果', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const p1 = fetchTagTop(7, { pn: 2 })
    const p2 = fetchTagTop(7, { pn: 2 })
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1)) // 经调度微任务队列落地层
    gate.release(topJson([{ bvid: 'BVx' }]) as never)
    await expect(p1).resolves.toEqual([{ bvid: 'BVx' }])
    await expect(p2).resolves.toEqual([{ bvid: 'BVx' }])
  })

  it('tag/top: 参数不同不合并 (tid/pn/ps 全维入键)', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue(topJson() as never)
    await Promise.all([fetchTagTop(7), fetchTagTop(8), fetchTagTop(7, { pn: 2 }), fetchTagTop(7, { ps: 50 })])
    expect(gmAnonGet).toHaveBeenCalledTimes(4)
  })

  it('archive/related: 同 bvid 并发 => 一次底层请求', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const p1 = fetchArchiveRelated('BV1')
    const p2 = fetchArchiveRelated('BV1')
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    gate.release(topJson([]) as never)
    await Promise.all([p1, p2])
  })

  it('all/v2: 同 keyword+page 并发 => 一次底层请求; 页不同不合并', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const p1 = fetchAllV2Search('三体', { page: 3 })
    const p2 = fetchAllV2Search('三体', { page: 3 })
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    gate.release(searchJson([]) as never)
    await Promise.all([p1, p2])
    vi.mocked(gmAnonGet).mockResolvedValue(searchJson() as never)
    await Promise.all([fetchAllV2Search('三体', { page: 1 }), fetchAllV2Search('三体', { page: 2 })])
    expect(gmAnonGet).toHaveBeenCalledTimes(3)
  })

  it('落定结果不复用: 同参串行两发各自到底层 (浅池重采样语义)', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue(topJson([]) as never)
    await fetchTagTop(7)
    await fetchTagTop(7)
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
  })

  it('失败不复用: 同参串行重试各自到底层 (gap 页重挖不被失败快照挡)', async () => {
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: { code: -504 } } as never)
    await expect(fetchTagTop(7)).rejects.toThrow()
    await expect(fetchTagTop(7)).rejects.toThrow()
    expect(gmAnonGet).toHaveBeenCalledTimes(2)
  })

  it('单方 abort 只解自己的等待: 共享在途仍送达另一方', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const ctrl = new AbortController()
    const p1 = fetchTagTop(7, { signal: ctrl.signal })
    const p2 = fetchTagTop(7)
    ctrl.abort()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    gate.release(topJson([{ bvid: 'BVy' }]) as never)
    await expect(p2).resolves.toEqual([{ bvid: 'BVy' }])
  })

  it('/view/detail 单一在途: 分区核验与素材证据并发同 BV => 一次底层整包请求 (审计 §8-1)', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const p1 = fetchVideoPartition('BVshare')
    const p2 = fetchTagRecVideoEvidence('BVshare')
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    expect(vi.mocked(gmAnonGet).mock.calls[0][0]).toContain('/view/detail')
    gate.release({ status: 200, data: { code: 0, data: { View: { bvid: 'BVshare' }, Tags: [] } } } as never)
    await Promise.all([p1, p2])
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('/view/detail 单一在途: 批量道标签名单与分区核验同 BV 并发 => 一次整包请求 (审计 §8-2)', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const p1 = fetchVideoTags('BVtagshare') // 非 interactive => 批量道走整包 detail
    const p2 = fetchVideoPartition('BVtagshare')
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    expect(vi.mocked(gmAnonGet).mock.calls[0][0]).toContain('/view/detail')
    gate.release({
      status: 200,
      data: { code: 0, data: { View: { bvid: 'BVtagshare' }, Tags: [{ tag_id: 7, tag_name: 'alpha' }] } },
    } as never)
    await expect(p1).resolves.toEqual([{ tag_id: 7, tag_name: 'alpha' }])
    await p2
    expect(gmAnonGet).toHaveBeenCalledTimes(1)
  })

  it('/view/detail/tag 交互道: 弹层专用端点独立发送; 最后等待者离开 => 在途取数被取消 (弹层/详情关闭不留孤儿请求)', async () => {
    const gate = pending<never>()
    vi.mocked(gmAnonGet).mockImplementation(() => gate.promise as never)
    const ctrl = new AbortController()
    const p = fetchVideoTags('BVx', { interactive: true, signal: ctrl.signal })
    await vi.waitFor(() => expect(gmAnonGet).toHaveBeenCalledTimes(1))
    expect(vi.mocked(gmAnonGet).mock.calls[0][0]).toBe('/x/web-interface/view/detail/tag')
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    // 取消闸下传到底层: gmAnonGet 实收的 signal 已被 abort (排队/在途请求不再发出)
    expect((vi.mocked(gmAnonGet).mock.calls[0][2] as AbortSignal | undefined)?.aborted).toBe(true)
  })
})
