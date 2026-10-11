import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { tagRecBackoff } from '../api/backoff'
import { fetchTagTop, fetchVideoTags } from '../api/endpoints'
import { makeTagGroup } from '../model/favorites'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver } from '../model/filter-engine'
import { dropTagRecStrictNegativeHits, dropTagRecStrictTagListHits } from './negative-slice'
import type { ItemsSeparator, TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchVideoTags: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../api/backoff', () => ({ tagRecBackoff: { currentIntervalMs: 0 } }))

const ai = { id: 7, name: 'AI漫剧' }
const neg = { id: 8, name: '屏蔽标签' }
const video = (bvid: string, ownTagNames?: string[]): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['原神组'] },
  ownTagNames,
})
const separator: ItemsSeparator = { api: EApiType.Separator, uniqId: 'sep', content: null }
const strictCore = () => {
  const c = createTagRecFactoryFilterCore()
  c.dims.tagAllow = { enabled: true, strict: true, list: [ai] }
  return c
}
const setBackoff = (value: number) => {
  ;(tagRecBackoff as unknown as { currentIntervalMs: number }).currentIntervalMs = value
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchVideoTags).mockResolvedValue([])
  setBackoff(0)
})

describe('上屏切片严格标签校验', () => {
  it('普通模式/关闸/空名单不补查, 不额外取视频', async () => {
    const c = strictCore()
    c.dims.tagAllow.strict = false
    const slice = [video('a'), separator]
    const result = await dropTagRecStrictTagListHits(slice, c, createTagRecScopeResolver({ core: c }))
    expect(result.items).toBe(slice)
    expect(fetchVideoTags).not.toHaveBeenCalled()
    c.dims.tagAllow.strict = true
    c.dims.tagAllow.list = []
    await dropTagRecStrictTagListHits(slice, c, createTagRecScopeResolver({ core: c }))
    c.dims.tagAllow.list = [ai]
    c.enabled = false
    await dropTagRecStrictTagListHits(slice, c, createTagRecScopeResolver({ core: c }))
    expect(fetchVideoTags).not.toHaveBeenCalled()
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('缺标签逐视频补查, 两侧屏蔽优先, 确认无标签与非命中视频从仅看滤掉', async () => {
    const c = strictCore()
    c.dims.tagBlock = { enabled: true, strict: false, list: [neg] }
    vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
      Promise.resolve(
        bvid === 'empty'
          ? []
          : [{ tag_id: 7, tag_name: 'ＡＩ 漫剧' }, ...(bvid === 'blocked' ? [{ tag_id: 8, tag_name: neg.name }] : [])],
      ),
    )
    const result = await dropTagRecStrictTagListHits(
      [video('keep'), video('blocked'), video('empty'), separator],
      c,
      createTagRecScopeResolver({ core: c }),
    )
    expect(result.items.map((v) => v.uniqId)).toEqual(['tag-rec:keep', 'sep'])
    expect(result.stats.byDim).toEqual({ tagBlock: 1, tagAllow: 1 })
    expect(result.stats.byScope).toEqual({ 'tagBlock@全局': 1, 'tagAllow@全局': 1 })
    expect(fetchVideoTags).toHaveBeenCalledTimes(3)
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('自带标签的搜索/相关视频零补查; 查询组正向成员不成为仅看限制', async () => {
    const c = strictCore()
    const group = makeTagGroup({ name: '原神组', tag_ids: [{ id: 1, name: '原神' }] })!
    const resolve = createTagRecScopeResolver({ core: c, groupsByName: new Map([[group.name, group]]) })
    const videos = (['all-v2-exact', 'all-v2-related', 'archive-related'] as const).map((via) => ({
      ...video(via, [ai.name]),
      source: { via, groupNames: [group.name] },
    }))
    const result = await dropTagRecStrictTagListHits(videos, c, resolve)
    expect(result.items).toHaveLength(3)
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('仅看补查仍复核查询组负向; 后续组严格校验复用补齐 id 不重复调用接口', async () => {
    const c = strictCore()
    const group = makeTagGroup({
      name: '原神组',
      tag_ids: [{ id: 1, name: '原神' }],
      negative_tag_ids: [neg],
      negative_strict: true,
    })!
    vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
      Promise.resolve([
        { tag_id: 7, tag_name: ai.name },
        ...(bvid === 'hit-negative' ? [{ tag_id: 8, tag_name: neg.name }] : []),
      ]),
    )
    const resolve = createTagRecScopeResolver({ core: c, fallbackGroup: group })
    const result = await dropTagRecStrictTagListHits([video('keep'), video('hit-negative')], c, resolve)
    expect(result.stats.byDim).toEqual({ blacklist: 1 })
    const groupChecked = await dropTagRecStrictNegativeHits(result.items, () => [8])
    expect(groupChecked.items).toHaveLength(1)
    expect(fetchVideoTags).toHaveBeenCalledTimes(2)
  })

  it('标签补查不重新执行数值阈值, 保持原有小池降级决定', async () => {
    const c = strictCore()
    c.strictMode = true
    c.dims.viewMin = { enabled: true, value: 100_000 }
    const result = await dropTagRecStrictTagListHits([video('a', [ai.name])], c, createTagRecScopeResolver({ core: c }))
    expect(result.items).toHaveLength(1)
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('失败/退避放行未知并记未校验, 已有标签仍正常判定', async () => {
    const c = strictCore()
    c.strictMode = true
    vi.mocked(fetchVideoTags).mockRejectedValue(new Error('network'))
    const resolve = createTagRecScopeResolver({ core: c })
    const result = await dropTagRecStrictTagListHits([video('unknown'), video('known', ['其他'])], c, resolve)
    expect(result.items.map((v) => v.uniqId)).toEqual(['tag-rec:unknown'])
    expect(result.stats.unchecked).toBe(1)
    vi.mocked(fetchVideoTags).mockClear()
    setBackoff(4_000)
    const backedOff = await dropTagRecStrictTagListHits([video('unknown'), video('known', ['其他'])], c, resolve)
    expect(backedOff.items.map((v) => v.uniqId)).toEqual(['tag-rec:unknown'])
    expect(backedOff.stats.unchecked).toBe(1)
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('5s 时间盒结束放行未核查; 外部取消不交付旧查询视频', async () => {
    vi.useFakeTimers()
    try {
      const c = strictCore()
      vi.mocked(fetchVideoTags).mockImplementation(
        (_bvid, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      )
      const result = dropTagRecStrictTagListHits([video('slow')], c, createTagRecScopeResolver({ core: c }))
      await vi.advanceTimersByTimeAsync(5_100)
      expect((await result).stats.unchecked).toBe(1)
      const controller = new AbortController()
      const cancelled = dropTagRecStrictTagListHits(
        [video('cancel')],
        c,
        createTagRecScopeResolver({ core: c }),
        controller.signal,
      )
      controller.abort()
      expect((await cancelled).items).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('组/L1 标签严格开关按视频的归因链生效, 无此规则的来源零补查', async () => {
    const c = createTagRecFactoryFilterCore()
    const group = makeTagGroup({ name: '原神组', tag_ids: [{ id: 1, name: '原神' }] })!
    group.l1Id = 'l1'
    group.overrides = { negative: { tagAllow: { enabled: true, strict: true, list: [ai] } } }
    const l1 = {
      id: 'l1',
      name: '一级',
      enabled: true,
      weight: 1,
      addedAt: 1,
      overrides: { negative: { tagBlock: { enabled: true, strict: true, list: [neg] } } },
    }
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map([[group.name, group]]),
      l1ById: new Map([[l1.id, l1]]),
    })
    vi.mocked(fetchVideoTags).mockImplementation((bvid) =>
      Promise.resolve([
        { tag_id: 7, tag_name: ai.name },
        ...(bvid === 'blocked' ? [{ tag_id: 8, tag_name: neg.name }] : []),
      ]),
    )
    const other = { ...video('other'), source: { via: 'tag-top' as const, groupNames: ['别组'] } }
    const result = await dropTagRecStrictTagListHits([video('keep'), video('blocked'), other], c, resolve)
    expect(result.items.map((item) => item.uniqId)).toEqual(['tag-rec:keep', 'tag-rec:other'])
    expect(result.stats.byScope).toEqual({ 'tagBlock@一级': 1 })
    expect(fetchVideoTags).toHaveBeenCalledTimes(2)
  })

  it('最近一层的软标签仅看遮蔽上层严格名单, 不借用上层开关补查', async () => {
    const c = strictCore()
    const group = makeTagGroup({ name: '原神组', tag_ids: [{ id: 1, name: '原神' }] })!
    group.overrides = { negative: { tagAllow: { enabled: true, strict: false, list: [neg] } } }
    const resolve = createTagRecScopeResolver({ core: c, groupsByName: new Map([[group.name, group]]) })
    const result = await dropTagRecStrictTagListHits([video('soft')], c, resolve)
    expect(result.items).toHaveLength(1)
    expect(fetchVideoTags).not.toHaveBeenCalled()
  })

  it('万条名单仍按视频取一次完整标签; 失败后的组内负向校验不重复查询或记账', async () => {
    const c = strictCore()
    c.dims.tagAllow.list = Array.from({ length: 10_000 }, (_, i) => ({ id: i + 1, name: `标签${i + 1}` }))
    vi.mocked(fetchVideoTags).mockResolvedValue([{ tag_id: 7, tag_name: '标签7' }])
    const resolve = createTagRecScopeResolver({ core: c })
    const checked = await dropTagRecStrictTagListHits([video('same'), video('same')], c, resolve)
    expect(checked.items).toHaveLength(2)
    expect(fetchVideoTags).toHaveBeenCalledTimes(1)
    expect(fetchTagTop).not.toHaveBeenCalled()

    vi.mocked(fetchVideoTags).mockClear().mockRejectedValue(new Error('failed'))
    const failed = await dropTagRecStrictTagListHits([video('failed')], c, resolve)
    const legacy = await dropTagRecStrictNegativeHits(failed.items, () => [8], undefined, failed.checkedBvids)
    expect(legacy.items).toHaveLength(1)
    expect(failed.stats.unchecked).toBe(1)
    expect(legacy.unchecked).toBe(0)
    expect(fetchVideoTags).toHaveBeenCalledTimes(1)
  })
})
