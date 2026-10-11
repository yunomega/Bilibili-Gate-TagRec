import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import { fetchTagTop, fetchVideoTags, type TagTopItem, type ViewDetailTagItem } from '../api/endpoints'
import { dropTagRecStrictNegativeHits, ensureTagRecNegativePools, tagRecNegativePools } from './negative-slice'
import type { ItemsSeparator, TagRecItemExtend } from '$define'

// $common / endpoints / backoff 触浏览器环境; 纯逻辑测试以 mock 隔掉 (同 _pipeline.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchVideoTags: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { currentIntervalMs: 0 },
}))

const item = (bvid: string, extra: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['G'] },
  ...extra,
})
const sep = (): ItemsSeparator => ({ api: EApiType.Separator, uniqId: `sep:${Math.random()}`, content: null })
const top = (bvid: string): TagTopItem => ({ bvid })
const tagEntry = (tag_id: number, name = 't'): ViewDetailTagItem => ({ tag_id, tag_name: name })

// 退避态开关: mock 是普通对象, 真实类型 currentIntervalMs 为 get-only => 断言可写
const setBackoffEngaged = (on: boolean) => {
  ;(tagRecBackoff as unknown as { currentIntervalMs: number }).currentIntervalMs = on ? 4_000 : 0
}

beforeEach(() => vi.clearAllMocks())

describe('$modules/tag-rec/service/negative-slice', () => {
  it('.ensureTagRecNegativePools: 非空池沉淀; 空池带 15min TTL 入缓存 —— TTL 内零重取, 过期重探', async () => {
    vi.useFakeTimers()
    try {
      const mockFetch = vi.mocked(fetchTagTop)
      mockFetch.mockResolvedValueOnce([top('BVpool1'), top('BVpool2')])
      await ensureTagRecNegativePools([91001])
      expect(tagRecNegativePools().get(91001)).toEqual(new Set(['BVpool1', 'BVpool2']))

      // 票 39: 空池也沉淀 (emptyUntil TTL) —— 旧 3s 窗口外不再每轮重打, 恒定滴漏截停
      mockFetch.mockResolvedValue([])
      await ensureTagRecNegativePools([91002])
      expect(tagRecNegativePools().get(91002)).toEqual(new Set())
      await vi.advanceTimersByTimeAsync(3_100) // 过旧去重窗口但远未到 TTL
      await ensureTagRecNegativePools([91002])
      expect(mockFetch.mock.calls.filter((c) => c[0] === 91002)).toHaveLength(1) // 零新增发数

      // TTL 到期 => 读时过期即弃, ensure 重探拿到回填的新池
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 100)
      mockFetch.mockResolvedValueOnce([top('BVlate')])
      await ensureTagRecNegativePools([91002])
      expect(tagRecNegativePools().get(91002)).toEqual(new Set(['BVlate']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('.ensureTagRecNegativePools: A4-7 非空池带 60min TTL —— 期内零重取, 到期重探收中途上新', async () => {
    vi.useFakeTimers()
    try {
      const mockFetch = vi.mocked(fetchTagTop)
      mockFetch.mockResolvedValueOnce([top('BVv1')])
      await ensureTagRecNegativePools([92001])
      expect(tagRecNegativePools().get(92001)).toEqual(new Set(['BVv1']))

      // 期内 (过空池 15min TTL 仍远未到 60min) => 零新增发数
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      await ensureTagRecNegativePools([92001])
      expect(mockFetch.mock.calls.filter((c) => c[0] === 92001)).toHaveLength(1)

      // 60min 到期 => 弃旧快照重探, 中途上新的 bvid 进交集快照
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 100)
      mockFetch.mockResolvedValueOnce([top('BVv1'), top('BVnew')])
      await ensureTagRecNegativePools([92001])
      expect(tagRecNegativePools().get(92001)).toEqual(new Set(['BVv1', 'BVnew']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('.ensureTagRecNegativePools: 取数失败 reject 不沉淀快照 —— 3s 去重窗口内不重打, 窗口外重试 (真空池≠失败分流)', async () => {
    vi.useFakeTimers()
    try {
      const mockFetch = vi.mocked(fetchTagTop)
      mockFetch.mockRejectedValueOnce(new Error('risk-control'))
      await ensureTagRecNegativePools([91003])
      expect(tagRecNegativePools().has(91003)).toBe(false) // 失败不落池 (风控期不误存空快照)
      await ensureTagRecNegativePools([91003]) // failed 态 3s 窗口内去重 => 不重打
      expect(mockFetch.mock.calls.filter((c) => c[0] === 91003)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_100)
      mockFetch.mockResolvedValueOnce([top('BVok')])
      await ensureTagRecNegativePools([91003]) // 窗口外重试成功沉淀
      expect(tagRecNegativePools().get(91003)).toEqual(new Set(['BVok']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('.dropTagRecStrictNegativeHits: negIdsOf 空 => 不校验零请求; 命中剔除; 失败 fail-open+unchecked', async () => {
    const mockTags = vi.mocked(fetchVideoTags)
    mockTags.mockImplementation((bvid) => {
      if (bvid === 'hit') return Promise.resolve([tagEntry(7, 'neg')])
      if (bvid === 'fail') return Promise.reject(new Error('net'))
      return Promise.resolve([tagEntry(8, 'ok')])
    })
    const negIdsOf = (it: TagRecItemExtend) => (it.bvid === 'noneed' ? [] : [7])
    const slice = [item('hit'), item('ok'), item('fail'), sep(), item('noneed')]
    const r = await dropTagRecStrictNegativeHits(slice, negIdsOf)
    expect(r.items.map((x) => x.uniqId)).toEqual(['tag-rec:ok', 'tag-rec:fail', slice[3].uniqId, 'tag-rec:noneed'])
    expect(r.dropped).toBe(1)
    expect(r.unchecked).toBe(1) // fail 未能核查
    expect(mockTags).toHaveBeenCalledTimes(3) // noneed 不发请求
  })

  it('.dropTagRecStrictNegativeHits: 退避态整切片直通 (unchecked=需检条数, 零请求)', async () => {
    const mockTags = vi.mocked(fetchVideoTags)
    setBackoffEngaged(true)
    try {
      const r = await dropTagRecStrictNegativeHits([item('a'), item('b'), sep()], () => [7])
      expect(r.items).toHaveLength(3)
      expect(r.dropped).toBe(0)
      expect(r.unchecked).toBe(2)
      expect(mockTags).not.toHaveBeenCalled()
    } finally {
      setBackoffEngaged(false)
    }
  })

  it('.dropTagRecStrictNegativeHits: 时间盒超时未完成 => fail-open 放行 (unchecked)', async () => {
    vi.useFakeTimers()
    try {
      const mockTags = vi.mocked(fetchVideoTags)
      // 永不 resolve, 但响应 abort signal => reject
      mockTags.mockImplementation(
        (_bvid, opts) =>
          new Promise((_, rej) => {
            opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
          }),
      )
      const pending = dropTagRecStrictNegativeHits([item('slow1'), item('slow2')], () => [7])
      await vi.advanceTimersByTimeAsync(5_100)
      const r = await pending
      expect(r.items).toHaveLength(2) // 全放行
      expect(r.dropped).toBe(0)
      expect(r.unchecked).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('separator/非 tagrec 条目直通不校验', async () => {
    const r = await dropTagRecStrictNegativeHits([sep(), sep()], () => [7])
    expect(r.items).toHaveLength(2)
    expect(r.dropped).toBe(0)
    expect(r.unchecked).toBe(0)
    expect(vi.mocked(fetchVideoTags)).not.toHaveBeenCalled()
  })
})
