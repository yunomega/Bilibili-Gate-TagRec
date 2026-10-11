import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { compareTagRecItems, tagRecDeliveryTierOf } from './item-order'
import type { TagRecItemExtend } from '$define'

/**
 * 票 001: 交付档位排序 —— 首屏必须按来源档位出
 * (tag/top → 精确搜索 → 搜索相关 → 推荐相关/相似垫底), 档位优先于相关性/质量分。
 */
const item = (via: TagRecItemExtend['source']['via'], extra: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  bvid: `bv-${via ?? 'unknown'}`,
  uniqId: `u-${via ?? 'unknown'}`,
  title: 't',
  pic: '',
  stat: {},
  source: { via, groupNames: [] },
  ...extra,
})

describe('交付档位 (001)', () => {
  it('档位优先于质量分: 高分相似条不得压过低分 tag/top', () => {
    const sorted = [
      item('archive-related', { score: 999 }),
      item('all-v2-related', { score: 500 }),
      item('all-v2-exact', { score: 100 }),
      item('tag-top', { score: 1 }),
    ].sort(compareTagRecItems)
    expect(sorted.map((i) => i.source.via)).toEqual(['tag-top', 'all-v2-exact', 'all-v2-related', 'archive-related'])
  })

  it('up-search 与精确搜索同档; 未知 via 归 tagTop 档 (与 poolOfVia 同口径)', () => {
    expect(tagRecDeliveryTierOf(item('up-search'))).toBe(tagRecDeliveryTierOf(item('all-v2-exact')))
    expect(tagRecDeliveryTierOf(item(undefined as never))).toBe(tagRecDeliveryTierOf(item('tag-top')))
  })

  it('同档内保持质量分顺序 (档位只做外层键)', () => {
    const low = item('tag-top', { score: 10, bvid: 'b' })
    const high = item('tag-top', { score: 20, bvid: 'a' })
    expect([low, high].sort(compareTagRecItems).map((i) => i.score)).toEqual([20, 10])
  })
})
