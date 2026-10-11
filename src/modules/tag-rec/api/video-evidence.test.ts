import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { excludeTagRecCondition, newTagRecCombination, tagRecConditionAtom } from '../model/combination'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver } from '../model/filter-engine'
import { checkTagRecPartitionSlice, TagRecPartitionBudget } from '../service/partition-slice'
import { anonGetJson, fetchVideoPartition } from './endpoints'
import { fetchTagRecVideoEvidence, getCachedTagRecVideoEvidence, mergeTagRecVideoEvidence } from './video-evidence'
import type { TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('./endpoints', () => {
  const anonGetJson = vi.fn()
  return {
    anonGetJson,
    // 审计 §8-1: 素材证据现经共享 fetchVideoDetail 取整包 —— mock 内保真实传输语义
    //   (单发 /view/detail, View.bvid 对不上/code!==0 => undefined), 本组用例仍按 anonGetJson 计数
    fetchVideoDetail: vi.fn(async (bvid: string, signal?: AbortSignal) => {
      const json = (await anonGetJson('/x/web-interface/view/detail', { bvid }, signal)) as {
        code?: number
        data?: { View?: { bvid?: string } }
      }
      if (json?.code !== 0 || json.data?.View?.bvid !== bvid) return undefined
      return json.data
    }),
    fetchVideoPartition: vi.fn(),
    fetchTagTop: vi.fn(),
  }
})
vi.mock('./backoff', () => ({
  tagRecLimit: (run: () => unknown) => run(),
  allV2Limit: (run: () => unknown) => run(),
  tagRecBackoff: { currentIntervalMs: 0 },
}))
vi.mock('./video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve()) }))
let serial = 0
const bvid = () => `evidence-${++serial}`
const response = (id: string, view: Record<string, unknown> = {}, tags: unknown = []) => ({
  code: 0,
  data: { View: { bvid: id, title: '三体', desc: '', ...view }, Tags: tags },
})
const video = (id: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: id,
  bvid: id,
  title: '三体',
  pic: '',
  stat: {},
  partial: true,
  source: { via: 'all-v2-exact', groupNames: [] },
  srcRank: 0,
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('组合必要证据的缓存和请求预算', () => {
  it('补查省略的字段不抹去已有完整证据，新完整标签覆盖召回线索', () => {
    const original = { ...video(bvid()), desc: '', fieldEvidence: { desc: 'complete' as const } }
    const merged = mergeTagRecVideoEvidence(original, { ownTagIds: [], fieldEvidence: { desc: 'missing' } })
    expect(merged.desc).toBe('')
    expect(merged.fieldEvidence?.desc).toBe('complete')
    expect(merged.ownTagIds).toEqual([])
  })
  it('切走一份试验只取消它的等待，另一份同 BV 的补查继续且只发一请求', async () => {
    const id = bvid()
    const deferred = Promise.withResolvers<unknown>()
    vi.mocked(anonGetJson).mockImplementation(() => deferred.promise)
    const first = new AbortController()
    const a = fetchTagRecVideoEvidence(id, first.signal)
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const b = fetchTagRecVideoEvidence(id)
    await Promise.resolve()
    first.abort()
    await rejected
    expect(vi.mocked(anonGetJson).mock.calls[0][2]?.aborted).toBe(false)
    deferred.resolve(response(id))
    expect(await b).toMatchObject({ desc: '', ownTagIds: [], fieldEvidence: { desc: 'complete' } })
    expect(anonGetJson).toHaveBeenCalledTimes(1)
    expect(await fetchTagRecVideoEvidence(id)).toMatchObject({ ownTagIds: [] })
    expect(anonGetJson).toHaveBeenCalledTimes(1)
  })
  it('缺完整标签和简介不能被缓存成已确认不存在；短期缓存到期后可再核实', async () => {
    const id = bvid()
    vi.mocked(anonGetJson).mockResolvedValue({ code: 0, data: { View: { bvid: id, title: '三体' } } })
    expect(await fetchTagRecVideoEvidence(id)).toMatchObject({ fieldEvidence: { desc: 'missing' } })
    expect(getCachedTagRecVideoEvidence(id)?.ownTagIds).toBeUndefined()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(getCachedTagRecVideoEvidence(id)).toBeUndefined()
    vi.mocked(anonGetJson).mockResolvedValue(response(id))
    expect(await fetchTagRecVideoEvidence(id)).toMatchObject({ ownTagIds: [], desc: '' })
    expect(anonGetJson).toHaveBeenCalledTimes(2)
  })
  it('API 失败或 BV 对不上均不形成内容事实，去重窗口外允许重试', async () => {
    const id = bvid()
    vi.mocked(anonGetJson).mockResolvedValue(response('other'))
    expect(await fetchTagRecVideoEvidence(id)).toBeUndefined()
    expect(await fetchTagRecVideoEvidence(id)).toBeUndefined()
    expect(getCachedTagRecVideoEvidence(id)).toBeUndefined()
    expect(anonGetJson).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_001)
    vi.mocked(anonGetJson).mockResolvedValue({ code: -404 })
    expect(await fetchTagRecVideoEvidence(id)).toBeUndefined()
    expect(anonGetJson).toHaveBeenCalledTimes(2)
  })
  it('必要补查共用上限，剩余未知保留；临时查看不补查也不解除已证实排除', async () => {
    const combo = newTagRecCombination()
    excludeTagRecCondition(combo, tagRecConditionAtom('desc', '动画'))
    const group = { id: 'g', name: '组', enabled: true, weight: 1, addedAt: 0, tag_ids: [], combination: combo }
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    const resolve = createTagRecScopeResolver({ core, fallbackGroup: group })
    const items = Array.from({ length: 5 }, () => video(bvid()))
    vi.mocked(anonGetJson).mockImplementation((_url, params) => Promise.resolve(response(params.bvid as string)))
    const budget = new TagRecPartitionBudget(new AbortController().signal, { requests: 2, candidates: 40, ms: 5_000 })
    const result = await checkTagRecPartitionSlice(items, resolve, budget)
    budget.dispose()
    expect(result.items).toHaveLength(2)
    expect(result.pending.size).toBe(3)
    expect(anonGetJson).toHaveBeenCalledTimes(2)
    expect(fetchVideoPartition).not.toHaveBeenCalled()
    const temporary = createTagRecScopeResolver({ core, fallbackGroup: group, allowUnverified: true })
    const blocked = { ...video(bvid()), desc: '动画', fieldEvidence: { desc: 'complete' as const } }
    const noRequests = new TagRecPartitionBudget(new AbortController().signal, {
      requests: 0,
      candidates: 40,
      ms: 5_000,
    })
    const viewed = await checkTagRecPartitionSlice([...result.pending.values(), blocked], temporary, noRequests)
    noRequests.dispose()
    expect(viewed.items).toHaveLength(3)
    expect(viewed.pending.size).toBe(0)
    expect(anonGetJson).toHaveBeenCalledTimes(2)
  })
  /**
   * 「未核实」角标契约: 角标 == 「这条只是被临时查看放出来的」。
   *   开关开 + 证据缺失 => 放出且打标; 开关开 + 已核实 => 不打标; 开关关 => 回暂存且无标。
   *   (角标落在交付副本上 —— slice 内 mergeTagRecVideoEvidence 产出新对象, 原对象不在交付链)
   */
  it('临时查看角标只标「靠开关放行」的条目', async () => {
    const combo = newTagRecCombination()
    combo.include.children.push(tagRecConditionAtom('tag', { id: 999, name: '某标签' }))
    const group = { id: 'g', name: '组', enabled: true, weight: 1, addedAt: 0, tag_ids: [], combination: combo }
    const core = createTagRecFactoryFilterCore()
    const withBudget = () =>
      new TagRecPartitionBudget(new AbortController().signal, { requests: 0, candidates: 40, ms: 5_000 })

    const unverified = video(bvid())
    const on = createTagRecScopeResolver({ core, fallbackGroup: group, allowUnverified: true })
    const b1 = withBudget()
    const shown = await checkTagRecPartitionSlice([unverified], on, b1)
    b1.dispose()
    expect(shown.items).toHaveLength(1)
    expect((shown.items[0] as TagRecItemExtend).combinationUnverified).toBe(true)

    const verified = video(bvid())
    verified.ownTagIds = [999]
    const b2 = withBudget()
    const legit = await checkTagRecPartitionSlice([verified], on, b2)
    b2.dispose()
    expect(legit.items).toHaveLength(1)
    expect((legit.items[0] as TagRecItemExtend).combinationUnverified).toBeUndefined()

    const held = video(bvid())
    const off = createTagRecScopeResolver({ core, fallbackGroup: group, allowUnverified: false })
    const b3 = withBudget()
    const kept = await checkTagRecPartitionSlice([held], off, b3)
    b3.dispose()
    expect(kept.items).toHaveLength(0)
    expect(kept.pending.size).toBe(1)
    expect([...kept.pending.values()][0]!.combinationUnverified).toBeUndefined()
  })
})
