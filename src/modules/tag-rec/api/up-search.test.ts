import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUpSearchPage, isUpSearchRisk } from './up-search'
import { UpSearchPausedError, type UpSearchGate } from './up-search-gate'

const mocks = vi.hoisted(() => ({ get: vi.fn(), now: 1_000 }))
vi.mock('$request', () => ({
  request: { get: mocks.get },
  isWebApiSuccess: (json: { code: number }) => json.code === 0,
}))
vi.mock('./up-search-gate', async (original) => {
  const actual = await original<{ UpSearchGate: typeof UpSearchGate }>()
  return {
    ...actual,
    upSearchGate: new actual.UpSearchGate(
      () => mocks.now,
      (ms) => {
        mocks.now += ms
        return Promise.resolve()
      },
    ),
  }
})
const response = (mid: number, count = 1) => ({
  status: 200,
  data: {
    code: 0,
    message: '0',
    data: {
      is_risk: false,
      gaia_res_type: 0,
      gaia_data: null,
      list: {
        vlist: count
          ? [
              {
                bvid: `BV-${mid}`,
                aid: 1,
                mid,
                author: '真实作者',
                title: '投稿',
                description: '简介',
                pic: '//cover',
                length: '1:02',
                created: 1_000,
                typeid: 1,
                play: 200,
                video_review: 3,
                comment: 4,
              },
            ]
          : [],
      },
      page: { pn: 1, ps: 30, count },
    },
  },
})

beforeEach(() => {
  mocks.get.mockReset()
  mocks.now += 360_000
})

describe('UP 投稿页请求', () => {
  it('同 UP/词/页共用一次请求和缓存，保持返回作者，不补视频标签或虚构统计', async () => {
    mocks.get.mockResolvedValue(response(999, 50))
    const [one, two] = await Promise.all([fetchUpSearchPage(7, '医生', 1), fetchUpSearchPage(7, '医生', 1)])
    expect(one).toBe(two)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.get).toHaveBeenCalledWith(
      '/x/space/wbi/arc/search',
      expect.objectContaining({ params: { mid: 7, keyword: '医生', pn: 1, ps: 30, order: 'pubdate', tid: 0 } }),
    )
    expect(one.items[0]).toMatchObject({
      owner: { mid: 999, name: '真实作者' },
      duration: 62,
      stat: { view: 200, reply: 4, danmaku: 3 },
    })
    expect(one.items[0]?.stat?.like).toBeUndefined()
    expect(one.hasMore).toBe(true)
    await fetchUpSearchPage(7, '医生', 1)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('正常零命中缓存空页，直接结束，不自动重试', async () => {
    mocks.get.mockResolvedValue(response(8, 0))
    expect(await fetchUpSearchPage(8, '无结果', 1)).toEqual({ items: [], hasMore: false })
    await fetchUpSearchPage(8, '无结果', 1)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it.each([-401, -352, -412, -101])('业务码 %s 立即暂停，不重试', async (code) => {
    mocks.get.mockResolvedValue({ status: 200, data: { code, message: 'blocked' } })
    await expect(fetchUpSearchPage(20 - code, '受限', 1)).rejects.toBeInstanceOf(UpSearchPausedError)
    await expect(fetchUpSearchPage(20 - code, '受限', 1)).rejects.toBeInstanceOf(UpSearchPausedError)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('code=0 的风险/验证空页也暂停，不能缓存为正常无结果', async () => {
    const blocked = response(9, 0)
    blocked.data.data.is_risk = true
    mocks.get.mockResolvedValue(blocked)
    await expect(fetchUpSearchPage(9, '风险空页', 1)).rejects.toBeInstanceOf(UpSearchPausedError)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('一个等待者离开不取消别人，最后一个离开才取消底层请求', async () => {
    const deferred = Promise.withResolvers<ReturnType<typeof response>>()
    mocks.get.mockImplementation((_url, config) => {
      config.signal.addEventListener('abort', () => deferred.reject(new DOMException('Aborted', 'AbortError')))
      return deferred.promise
    })
    const a = new AbortController()
    const b = new AbortController()
    const one = fetchUpSearchPage(10, '共享', 1, a.signal)
    const two = fetchUpSearchPage(10, '共享', 1, b.signal)
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
    const networkSignal = mocks.get.mock.calls[0]![1].signal as AbortSignal
    a.abort()
    await expect(one).rejects.toMatchObject({ name: 'AbortError' })
    expect(networkSignal.aborted).toBe(false)
    b.abort()
    await expect(two).rejects.toMatchObject({ name: 'AbortError' })
    expect(networkSignal.aborted).toBe(true)
  })

  it('完成页超过有效期后同参数重新请求', async () => {
    vi.useFakeTimers()
    try {
      mocks.get.mockResolvedValue(response(12, 5))
      expect((await fetchUpSearchPage(12, '时效', 1)).items.length).toBe(1)
      await fetchUpSearchPage(12, '时效', 1)
      expect(mocks.get).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      await fetchUpSearchPage(12, '时效', 1)
      expect(mocks.get).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('定向重查 (fresh) 弃完成档换新页；在途档不算陈旧照常合并', async () => {
    mocks.get.mockResolvedValue(response(13, 3))
    await fetchUpSearchPage(13, '重查', 1)
    await fetchUpSearchPage(13, '重查', 1, undefined, { fresh: true })
    expect(mocks.get).toHaveBeenCalledTimes(2)
    // fresh 后完成档已换新 —— 普通调用吃到新档不再发请求
    await fetchUpSearchPage(13, '重查', 1)
    expect(mocks.get).toHaveBeenCalledTimes(2)
    // 在途档: fresh 调用照样并进未完成的请求
    const held = Promise.withResolvers<ReturnType<typeof response>>()
    mocks.get.mockImplementation(() => held.promise)
    const inflight = fetchUpSearchPage(13, '在途', 1)
    const joined = fetchUpSearchPage(13, '在途', 1, undefined, { fresh: true })
    held.resolve(response(13, 1))
    await expect(inflight).resolves.toMatchObject({ hasMore: false })
    await expect(joined).resolves.toMatchObject({ hasMore: false })
    expect(mocks.get).toHaveBeenCalledTimes(3)
  })

  it('分页字段不完整时抛错，不把查询当成末页', async () => {
    const bad = response(11)
    bad.data.data.page.ps = 0
    mocks.get.mockResolvedValue(bad)
    await expect(fetchUpSearchPage(11, '坏页', 1)).rejects.toThrow('分页信息')
  })
})

describe('风险响应分类', () => {
  it.each([
    { status: 412, data: {} },
    { status: 429, data: {} },
    { status: 200, data: 'HTML' },
    { status: 200, data: { code: 0, v_voucher: 'verify' } },
    { status: 200, data: { code: 0, data: { gaia_res_type: 1 } } },
    { status: 200, data: { code: 0, data: { gaia_data: {} } } },
  ])('识别 HTTP、验证载荷和非 JSON 响应：%j', (res) => expect(isUpSearchRisk(res)).toBe(true))
  it('正常空页不误判风控', () => expect(isUpSearchRisk(response(1, 0))).toBe(false))
})

describe('UP search shared-cache retention', () => {
  it('hot pages survive cold-page eviction rather than behaving as FIFO', async () => {
    mocks.get.mockResolvedValue(response(80_000))
    const hot = () => fetchUpSearchPage(80_000, 'lru-audit', 1)
    await hot()
    for (let i = 1; i < 200; i++) await fetchUpSearchPage(80_000 + i, 'lru-audit', 1)
    await hot()
    await fetchUpSearchPage(90_000, 'lru-audit', 1)
    const calls = mocks.get.mock.calls.length
    await hot()
    expect(mocks.get).toHaveBeenCalledTimes(calls)
    await fetchUpSearchPage(80_001, 'lru-audit', 1)
    expect(mocks.get).toHaveBeenCalledTimes(calls + 1)
  })

  it('shrinks a large pending batch after settlement, without evicting in-flight requests', async () => {
    const held = Promise.withResolvers<ReturnType<typeof response>>()
    mocks.get.mockReturnValue(held.promise)
    const batch = Array.from({ length: 205 }, (_, i) => fetchUpSearchPage(100_000 + i, 'batch-audit', 1))
    const shared = fetchUpSearchPage(100_000, 'batch-audit', 1)
    held.resolve(response(100_000))
    await Promise.all([...batch, shared])
    expect(mocks.get).toHaveBeenCalledTimes(205)
    await fetchUpSearchPage(100_000, 'batch-audit', 1)
    expect(mocks.get).toHaveBeenCalledTimes(206)
  })
})
