import { describe, expect, it } from 'vitest'
import {
  formatTagRecDroppedText,
  resolveTagRecBannerState,
  TAG_REC_DROP_DIM_LABELS,
  tagRecHoldReasonText,
  type TagRecBannerSource,
} from './banner-helpers'
import type { TagRecDropDimKey, TagRecFilterRoundStats } from '../model/filter-engine'

/** [tag-rec] 横幅槽位纯逻辑 (spec §5.4, 票 09): 三态互斥优先级 + 滤除计数文案 */

function makeStats(partial: Partial<TagRecFilterRoundStats> = {}): TagRecFilterRoundStats {
  return { dropped: 0, byDim: {}, degraded: false, ...partial }
}

function makeSource(partial: Partial<TagRecBannerSource> = {}): TagRecBannerSource {
  return { hardBottom: false, softBottom: false, filterStats: makeStats(), ...partial }
}

describe('resolveTagRecBannerState (互斥: 硬 > 深挖待决 > 软 > 池浅降级)', () => {
  it('分区待检与批次暂停先于池底提示，保留继续筛选入口', () => {
    expect(resolveTagRecBannerState(makeSource({ partitionPaused: true, partitionPending: 3, hardBottom: true }))).toBe(
      'partition-pending',
    )
    expect(resolveTagRecBannerState(makeSource({ partitionPaused: true, partitionPending: 0, digPending: true }))).toBe(
      'partition-pending',
    )
    expect(resolveTagRecBannerState(makeSource({ partitionPending: 3 }))).toBe('none')
  })
  it('空态: 全无标记 => none', () => {
    expect(resolveTagRecBannerState(makeSource())).toBe('none')
    expect(resolveTagRecBannerState(makeSource({ filterStats: makeStats({ dropped: 3 }) }))).toBe('none')
  })

  it('深挖待决: 票 13 中间态 (自动深挖 K 尽但流未尽, 非硬见底)', () => {
    expect(resolveTagRecBannerState(makeSource({ digPending: true }))).toBe('dig-pending')
    // 待决压过软见底与池浅降级; 硬见底仍压待决
    expect(
      resolveTagRecBannerState(
        makeSource({ digPending: true, softBottom: true, filterStats: makeStats({ degraded: true }) }),
      ),
    ).toBe('dig-pending')
    expect(resolveTagRecBannerState(makeSource({ digPending: true, hardBottom: true }))).toBe('hard-bottom')
  })

  it('池浅降级: 仅 filterStats.degraded => degraded', () => {
    expect(resolveTagRecBannerState(makeSource({ filterStats: makeStats({ degraded: true }) }))).toBe('degraded')
  })

  it('软见底压过池浅降级', () => {
    const s = makeSource({ softBottom: true, filterStats: makeStats({ degraded: true }) })
    expect(resolveTagRecBannerState(s)).toBe('soft-bottom')
  })

  it('硬见底压过软见底与池浅降级', () => {
    const s = makeSource({
      hardBottom: true,
      softBottom: true,
      filterStats: makeStats({ degraded: true, dropped: 9 }),
    })
    expect(resolveTagRecBannerState(s)).toBe('hard-bottom')
    expect(resolveTagRecBannerState(makeSource({ hardBottom: true }))).toBe('hard-bottom')
  })
})

describe('formatTagRecDroppedText (滤除计数文案)', () => {
  it('已看跳过单独说明，避免“滤除零条但没有结果”的误解', () => {
    expect(formatTagRecDroppedText(makeStats({ seenDropped: 12 }))).toBe('本轮滤除 0 条 · 已看跳过 12 条')
    expect(formatTagRecDroppedText(makeStats({ dropped: 2, byDim: { viewMin: 2 }, seenDropped: 12 }), true)).toBe(
      '滤除 2 条(播放下限 2) · 已看跳过 12 条',
    )
  })

  it('dropped=0 => 简洁文案', () => {
    expect(formatTagRecDroppedText(makeStats())).toBe('本轮滤除 0 条')
    expect(formatTagRecDroppedText(makeStats({ degraded: true }))).toBe('本轮滤除 0 条')
  })

  it('按 byDim 分维度分解, 保持插入序 (黑名单维在前)', () => {
    const stats = makeStats({
      dropped: 5,
      byDim: { blacklist: 2, likeRate: 3 },
    })
    expect(formatTagRecDroppedText(stats)).toBe('本轮滤除 5 条(负向 2·点赞率 3)')
  })

  it('计数为 0 的维度不进明细', () => {
    const stats = makeStats({ dropped: 2, byDim: { likeRate: 2, viewMin: 0 } })
    expect(formatTagRecDroppedText(stats)).toBe('本轮滤除 2 条(点赞率 2)')
  })

  it('dropped>0 但 byDim 空 => 无明细括号', () => {
    expect(formatTagRecDroppedText(makeStats({ dropped: 4 }))).toBe('本轮滤除 4 条')
  })

  it('unchecked>0 => 尾附「未校验 N」 (严格校验放行条数, 票 14)', () => {
    expect(formatTagRecDroppedText(makeStats({ unchecked: 3 }))).toBe('本轮滤除 0 条 · 未校验 3')
    expect(formatTagRecDroppedText(makeStats({ dropped: 2, byDim: { blacklist: 2 }, unchecked: 1 }))).toBe(
      '本轮滤除 2 条(负向 2) · 未校验 1',
    )
  })

  it('维度键全有中文名 (含标签屏蔽/仅看)', () => {
    const dims: TagRecDropDimKey[] = [
      'combination',
      'blacklist',
      'viewMin',
      'viewMax',
      'likeMin',
      'likeMax',
      'favMin',
      'favMax',
      'coinMin',
      'coinMax',
      'danmakuMin',
      'danmakuMax',
      'replyMin',
      'replyMax',
      'shareMin',
      'shareMax',
      'likeRate',
      'favRate',
      'coinRate',
      'interactRate',
      'shareRate',
      'duration',
      'pubdate',
      'upBlacklist',
      'descKeywords',
      'partitionBlock',
      'partitionAllow',
      'titleKeywords',
      'upAllow',
      'titleAllow',
      'descAllow',
      'tagBlock',
      'tagAllow',
      'poolFilter',
      'minScore',
    ]
    for (const d of dims) expect(TAG_REC_DROP_DIM_LABELS[d]).toBeTruthy()
    expect(Object.keys(TAG_REC_DROP_DIM_LABELS)).toHaveLength(dims.length)
  })
})

describe('票 006 停牌原因文案 (tagRecHoldReasonText)', () => {
  it('风控退避: 说明在等什么 + 恢复后自动继续', () => {
    expect(tagRecHoldReasonText({}, true)).toContain('退避')
    expect(tagRecHoldReasonText({ supplyPaused: true }, true)).toContain('退避') // 退避优先
  })
  it('供给暂停(先看缓存): 点出开关名与解除动作', () => {
    const text = tagRecHoldReasonText({ supplyPaused: true })
    expect(text).toContain('先看缓存')
    expect(text).toContain('取消')
  })
  it('额度用尽: 已核实的照常交付，后续自动续查', () => {
    const text = tagRecHoldReasonText({ partitionBudgetExhausted: true })
    expect(text).toContain('额度')
    expect(text).toContain('自动')
  })
  it('放弃计数: 多轮未核实降频轮转，核实通过自动放行', () => {
    const text = tagRecHoldReasonText({ partitionAbandoned: 3 })
    expect(text).toContain('3')
    expect(text).toContain('自动')
  })
  it('无闸无放弃 => undefined (不编造原因)', () => {
    expect(tagRecHoldReasonText({})).toBeUndefined()
    expect(tagRecHoldReasonText({ partitionAbandoned: 0 })).toBeUndefined()
  })
})
