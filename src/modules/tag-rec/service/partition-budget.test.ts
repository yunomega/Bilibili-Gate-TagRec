import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRecBackoff } from '../api/backoff'
import { fetchVideoPartition, fetchVideoTags } from '../api/endpoints'
import { getCachedTagRecPartition } from '../api/partition-cache'
import { fetchTagRecVideoEvidence, getCachedTagRecVideoEvidence } from '../api/video-evidence'
import { getPersistedVideoTags } from '../api/video-tags-store'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver } from '../model/filter-engine'
import { normalizeTagTopItem } from '../model/normalize-item'
import { dropTagRecStrictTagListHits } from './negative-slice'
import { TagRecPartitionBudget } from './partition-slice'
import type { TagRecItemExtend } from '$define'
import type { TagGroup } from '../model/types'

// 审计 §1 回归: 严格核验并入整次刷新预算 —— 端点/持久层/邻层全 mock, 只测额度记账与 fail-open 语义
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/backoff', () => ({ tagRecBackoff: { currentIntervalMs: 0, isEngaged: false } }))
vi.mock('../api/endpoints', () => ({
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchVideoTags: vi.fn(() => Promise.resolve([])),
  fetchVideoPartition: vi.fn(() => Promise.resolve(undefined)),
  hasCompleteTagIds: (items: readonly { tag_id?: number }[]) => items.every((t) => t.tag_id !== undefined),
}))
vi.mock('../api/partition-cache', () => ({
  getCachedTagRecPartition: vi.fn(() => undefined),
  rememberTagRecPartition: vi.fn(),
}))
vi.mock('../api/video-tags-store', () => ({
  getPersistedVideoTags: vi.fn(() => Promise.resolve(undefined)),
  persistVideoTags: vi.fn(() => Promise.resolve()),
  evictPersistedVideoTags: vi.fn(() => Promise.resolve()),
}))
vi.mock('../api/video-evidence', () => ({
  fetchTagRecVideoEvidence: vi.fn(() => Promise.resolve(undefined)),
  getCachedTagRecVideoEvidence: vi.fn(() => undefined),
  mergeTagRecVideoEvidence: (item: TagRecItemExtend) => item,
}))

let seq = 0
const mkItem = () =>
  normalizeTagTopItem(
    { bvid: `BV${++seq}`, title: 'alpha', stat: { view: 10_000, like: 1_000 } },
    { groupNames: ['G'], srcRank: 0 },
  )
const mkSlice = (n: number) => Array.from({ length: n }, mkItem)

// 组 G 开 negative_strict + 负向标签 [77]: 上屏条目需逐条核查标签名单 (批量道经整包 detail)
const core = createTagRecFactoryFilterCore()
core.dims.likeRate.enabled = false
const group: TagGroup = {
  id: 'G',
  name: 'G',
  weight: 1,
  enabled: true,
  addedAt: 0,
  tag_ids: [{ id: 1, name: 'alpha' }],
  overrides: { negative: { tagIds: [{ id: 77, name: 'blocked' }], strict: true } },
}
const resolve = createTagRecScopeResolver({ core, groupsByName: new Map([['G', group]]) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPersistedVideoTags).mockResolvedValue(undefined)
  vi.mocked(getCachedTagRecPartition).mockReturnValue(undefined)
  vi.mocked(getCachedTagRecVideoEvidence).mockReturnValue(undefined)
  ;(tagRecBackoff as unknown as { currentIntervalMs: number }).currentIntervalMs = 0
})

describe('$modules/tag-rec/service TagRecPartitionBudget — 整次刷新共享预算 (审计 §1)', () => {
  it('分区/素材/严格标签三种补查共用同一请求额度', async () => {
    const budget = new TagRecPartitionBudget(new AbortController().signal, { requests: 3, candidates: 40, ms: 5_000 })
    try {
      vi.mocked(fetchVideoPartition).mockResolvedValue({ bvid: 'BVp' } as never)
      vi.mocked(fetchTagRecVideoEvidence).mockResolvedValue({ title: 't' } as never)
      vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 88, tag_name: 'ok' }])
      await budget.lookup('BVp')
      await budget.lookupEvidence('BVe')
      await budget.lookupTags('BVt')
      expect(budget.exhausted).toBe(true)
      // 第 4 次取数被拒: 未校验 fail-open, 不再发请求
      await expect(budget.lookupTags('BVx')).resolves.toBeUndefined()
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fetchVideoPartition)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fetchTagRecVideoEvidence)).toHaveBeenCalledTimes(1)
    } finally {
      budget.dispose()
    }
  })

  it('同 BV 并发 lookupTags 只发一次底层取数; 持久层完整命中不占额度', async () => {
    const budget = new TagRecPartitionBudget(new AbortController().signal, { requests: 1, candidates: 40, ms: 5_000 })
    try {
      vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 88, tag_name: 'ok' }])
      const [a, b] = await Promise.all([budget.lookupTags('BVz'), budget.lookupTags('BVz')])
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(1)
      expect(a).toEqual(b)

      // 额度已尽 (spent=1); 持久层命中仍免费放行不烧额度
      vi.mocked(getPersistedVideoTags).mockImplementation((bvid) =>
        Promise.resolve(bvid === 'BVcached' ? [{ tag_id: 9, tag_name: 'hit' }] : undefined),
      )
      const free = await budget.lookupTags('BVcached')
      expect(free).toEqual([{ tag_id: 9, tag_name: 'hit' }])
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(1)
      // 但额度外的新 BV (持久层未命中) 仍被拒
      await expect(budget.lookupTags('BVw')).resolves.toBeUndefined()
    } finally {
      budget.dispose()
    }
  })

  it('严格核查共享整次刷新预算: 耗尽后余量 fail-open, 同预算二次调用零新增请求', async () => {
    const budget = new TagRecPartitionBudget(new AbortController().signal, { requests: 4, candidates: 40, ms: 5_000 })
    try {
      vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 88, tag_name: 'ok' }])
      // 旧行为对照面: 不传预算则本批自立时间盒, 6 条全付费
      const first = await dropTagRecStrictTagListHits(mkSlice(6), core, resolve, undefined, undefined, true, budget)
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(4) // 只付 4 条额度
      expect(first.stats.unchecked).toBe(2) // 余量未校验
      expect(first.items).toHaveLength(6) // 已核通过 + 未校验 fail-open 全放行

      const second = await dropTagRecStrictTagListHits(mkSlice(6), core, resolve, undefined, undefined, true, budget)
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(4) // 同预算不再发 —— 外层补足循环不能重领额度
      expect(second.stats.unchecked).toBe(6)
      expect(second.items).toHaveLength(6)

      // 对照: 不带预算的调用走旧路径 (每批自立时间盒), 全额付费
      await dropTagRecStrictTagListHits(mkSlice(6), core, resolve)
      expect(vi.mocked(fetchVideoTags)).toHaveBeenCalledTimes(10)
    } finally {
      budget.dispose()
    }
  })

  it('严格核查仍剔除真命中: 共享预算不削弱排除语义', async () => {
    const budget = new TagRecPartitionBudget(new AbortController().signal, { requests: 20, candidates: 40, ms: 5_000 })
    try {
      vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
        Promise.resolve(
          bvid === 'BV-blocked' ? [{ tag_id: 77, tag_name: 'blocked' }] : [{ tag_id: 88, tag_name: 'ok' }],
        ),
      )
      const items = [...mkSlice(2), { ...mkItem(), bvid: 'BV-blocked', uniqId: 'tag-rec:BV-blocked' }, ...mkSlice(2)]
      const r = await dropTagRecStrictTagListHits(items, core, resolve, undefined, undefined, true, budget)
      expect(r.items.map((x) => (x as TagRecItemExtend).bvid)).not.toContain('BV-blocked')
      expect(r.stats.dropped).toBe(1)
      expect(r.items).toHaveLength(4)
    } finally {
      budget.dispose()
    }
  })
})
