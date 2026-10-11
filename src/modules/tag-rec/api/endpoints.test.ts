import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRiskControlError, isRiskControlResponse, tagRecBackoff } from './backoff'
import { fetchAllV2Search, fetchArchiveRelated, fetchTagTop, TagRecApiCodeError } from './endpoints'
import { gmAnonGet } from './request'

// IO/指纹/退避/持久化全隔离 —— 只测「响应业务码 → resolve/reject」分流 (W1-2)
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
vi.mock('./session-fetch-cache', () => ({
  // 透传替身: 本文件测「响应业务码分流」非去重 —— 每次调用直发 loader, 不共享在途
  SessionFetchCache: class {
    fetch(_key: unknown, loader: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal) {
      return loader(signal ?? new AbortController().signal)
    }
  },
}))
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

const mockJson = (json: unknown) => vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: json } as never)

describe('$modules/tag-rec/api/endpoints — W1-2 业务码分流', () => {
  beforeEach(() => {
    vi.mocked(gmAnonGet).mockReset()
    vi.mocked(isRiskControlResponse).mockReturnValue(false)
    vi.mocked(isRiskControlError).mockReturnValue(false)
  })

  it('非风控非零码 => reject TagRecApiCodeError (不再冒充空池)', async () => {
    mockJson({ code: -504, message: '服务器错误' })
    await expect(fetchTagTop(1)).rejects.toBeInstanceOf(TagRecApiCodeError)
    await expect(fetchArchiveRelated('BV1')).rejects.toBeInstanceOf(TagRecApiCodeError)
    await expect(fetchAllV2Search('kw')).rejects.toBeInstanceOf(TagRecApiCodeError)
  })

  it('code=0 且 data 合法 => resolve 数组 (tag/top 直取 / allv2 只收 video 块)', async () => {
    mockJson({ code: 0, data: [{ bvid: 'BVt' }] })
    await expect(fetchTagTop(1)).resolves.toEqual([{ bvid: 'BVt' }])
    await expect(fetchArchiveRelated('BV1')).resolves.toEqual([{ bvid: 'BVt' }])

    mockJson({
      code: 0,
      data: {
        result: [
          { result_type: 'video', data: [{ bvid: 'BVv' }] },
          { result_type: 'bili_user', data: [{ mid: 1 }] },
        ],
      },
    })
    await expect(fetchAllV2Search('kw')).resolves.toEqual([{ bvid: 'BVv' }]) // 非 video 块不混入
  })

  it('code=0 缺 data 仍是未知; 显式空结果才是真空', async () => {
    mockJson({ code: 0, data: undefined })
    await expect(fetchTagTop(1)).rejects.toBeInstanceOf(TagRecApiCodeError)
    mockJson({ code: 0, data: [] })
    await expect(fetchTagTop(1)).resolves.toEqual([])
    mockJson({ code: 0, data: { result: [] } })
    await expect(fetchAllV2Search('kw')).resolves.toEqual([])
  })

  it('code=0 但 all/v2 缺 result 块 => reject (截断/降级响应不产假空页判 exhausted)', async () => {
    mockJson({ code: 0, message: '0', data: undefined })
    await expect(fetchAllV2Search('kw')).rejects.toBeInstanceOf(TagRecApiCodeError)
    mockJson({ code: 0, message: '0', data: { numPages: 0 } }) // data 在但无 result 同口径
    await expect(fetchAllV2Search('kw')).rejects.toBeInstanceOf(TagRecApiCodeError)
  })

  it('TagRecApiCodeError 带 url+code 便于归因', async () => {
    mockJson({ code: -799 })
    const err = await fetchTagTop(9).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TagRecApiCodeError)
    expect((err as TagRecApiCodeError).code).toBe(-799)
    expect((err as TagRecApiCodeError).url).toBe('/x/web-interface/tag/top')
  })

  it('审计6.2: 业务失败 (code!==0) 不算有效成功 —— onSuccess 不记恢复证据', async () => {
    mockJson({ code: -400, message: '请求错误' })
    await expect(fetchTagTop(1)).rejects.toBeInstanceOf(TagRecApiCodeError)
    expect(tagRecBackoff.onSuccess).not.toHaveBeenCalled()
  })

  it('tag/top 深页 200+零字节空体 => 空页 [] (池底语义), 不进风控判定/退避', async () => {
    // 真实 isRiskControlResponse 对 data=undefined 判风控 —— 替身还原该口径, 验证空体在判定之前被接走
    vi.mocked(isRiskControlResponse).mockReturnValue(true)
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: undefined, emptyBody: true } as never)
    await expect(fetchTagTop(1)).resolves.toEqual([])
    expect(tagRecBackoff.onRiskControl).not.toHaveBeenCalled()
  })

  it('未 opt-in 端点的空体仍走风控判定 (口径不放宽)', async () => {
    vi.mocked(isRiskControlResponse).mockReturnValue(true)
    vi.mocked(isRiskControlError).mockReturnValue(true)
    vi.mocked(gmAnonGet).mockResolvedValue({ status: 200, data: undefined, emptyBody: true } as never)
    await expect(fetchArchiveRelated('BV1')).rejects.toThrow()
    expect(tagRecBackoff.onRiskControl).toHaveBeenCalled()
  })

  it('审计6.1: 有效成功回传 waitTurn 放行代次 —— 旧预约回包在闸内被代次配对判掉', async () => {
    vi.mocked(tagRecBackoff.waitTurn).mockResolvedValueOnce(7)
    mockJson({ code: 0, data: [] })
    await fetchTagTop(1)
    expect(tagRecBackoff.onSuccess).toHaveBeenCalledWith(7)
  })
})
