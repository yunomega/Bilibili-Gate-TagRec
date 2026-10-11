import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { createTagRecDeliveryReplay } from './delivery-replay'
import type { TagRecItemExtend } from '$define'

/**
 * 票 002: 已交付内容的**有界回放池**。
 * 契约: 记住"这个条件交付过什么"(含顺序) → 「显示已看」打开时零请求回放, 第一次什么样切回来还什么样。
 */
const item = (bvid: string, via: TagRecItemExtend['source']['via'] = 'tag-top'): TagRecItemExtend => ({
  api: EApiType.TagRec,
  bvid,
  uniqId: `tag-rec:${bvid}`,
  title: bvid,
  pic: '',
  stat: {},
  source: { via, groupNames: [] },
})

describe('交付回放池 (002)', () => {
  it('回放保持交付顺序 (第一次什么样, 切回来就什么样)', () => {
    const replay = createTagRecDeliveryReplay()
    replay.remember('cond-a', [item('b1'), item('b2'), item('b3')])
    expect(replay.replay('cond-a').map((i) => i.bvid)).toEqual(['b1', 'b2', 'b3'])
  })

  it('同条件内按 bvid 去重且保留首次位置', () => {
    const replay = createTagRecDeliveryReplay()
    replay.remember('cond-a', [item('b1'), item('b2')])
    replay.remember('cond-a', [item('b2'), item('b3')])
    expect(replay.replay('cond-a').map((i) => i.bvid)).toEqual(['b1', 'b2', 'b3'])
  })

  it('按条件签名分组: 不同条件互不串味', () => {
    const replay = createTagRecDeliveryReplay()
    replay.remember('cond-a', [item('a1')])
    replay.remember('cond-b', [item('b1')])
    expect(replay.replay('cond-a').map((i) => i.bvid)).toEqual(['a1'])
    expect(replay.replay('cond-b').map((i) => i.bvid)).toEqual(['b1'])
  })

  it('有界: 超每条件上限保留最早的（首屏语义 = 第一次看到的那批）', () => {
    const replay = createTagRecDeliveryReplay({ maxConditions: 4, maxItemsPerCondition: 3 })
    replay.remember('cond-a', [item('a1'), item('a2'), item('a3'), item('a4'), item('a5')])
    expect(replay.replay('cond-a').map((i) => i.bvid)).toEqual(['a1', 'a2', 'a3'])
  })

  it('有界: 超条件数上限按 LRU 淘汰最久未写的条件', () => {
    const replay = createTagRecDeliveryReplay({ maxConditions: 2, maxItemsPerCondition: 5 })
    replay.remember('cond-a', [item('a1')])
    replay.remember('cond-b', [item('b1')])
    replay.remember('cond-c', [item('c1')]) // 挤掉最久未写的 cond-a
    expect(replay.replay('cond-a')).toEqual([])
    expect(replay.replay('cond-b').map((i) => i.bvid)).toEqual(['b1'])
    expect(replay.replay('cond-c').map((i) => i.bvid)).toEqual(['c1'])
  })

  it('回放返回副本: 调用方改动不污染池子', () => {
    const replay = createTagRecDeliveryReplay()
    replay.remember('cond-a', [item('a1')])
    const first = replay.replay('cond-a')
    first.length = 0
    expect(replay.replay('cond-a').map((i) => i.bvid)).toEqual(['a1'])
  })

  it('存深克隆快照: 交付后 enrich/证据合并不再改池内内容 (审计)', () => {
    const replay = createTagRecDeliveryReplay()
    const original = item('a1')
    replay.remember('cond-a', [original])
    // 交付后的原地改写: 证据合并 Object.assign (顶层字段) / enrich 重写归因 (嵌套 source)
    original.tidv2 = 999
    original.source.tagIds = [42]
    const pooled = replay.replay('cond-a')[0]
    expect(pooled.tidv2).toBeUndefined()
    expect(pooled.source.tagIds).toBeUndefined()
  })

  it('未知条件回放空数组; forget/clear 生效', () => {
    const replay = createTagRecDeliveryReplay()
    expect(replay.replay('nope')).toEqual([])
    replay.remember('cond-a', [item('a1')])
    replay.forget('cond-a')
    expect(replay.replay('cond-a')).toEqual([])
    replay.remember('cond-a', [item('a1')])
    replay.clear()
    expect(replay.replay('cond-a')).toEqual([])
  })
})
