import { describe, expect, it, vi } from 'vitest'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver, runTagRecFilter } from './filter-engine'
import { normalizeAllV2Item, normalizeTagTopItem } from './normalize-item'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
vi.mock('../api/dry-tids-store', () => ({ isPersistedDryTid: () => false, persistDryTid: vi.fn() }))

const resolve = (list: { name: string; v1?: number; v2?: number }[]) => {
  const core = createTagRecFactoryFilterCore()
  core.dims.likeRate.enabled = false
  core.dims.partitionAllow = { enabled: true, list }
  return createTagRecScopeResolver({ core })
}

describe('分区仅看的实际归一化与过滤回归', () => {
  it('新版知识的真实样本不会因为旧网络游戏分区而通过仅看新版游戏', () => {
    // Saved first-party tag/top response, 2026-10-02: tid=65, tidv2=2090, pid_v2=1010.
    const video = normalizeTagTopItem(
      { bvid: 'BV1voYP6xEuH', tid: 65, tidv2: 2090, pid_v2: 1010 },
      { groupNames: [], srcRank: 0 },
    )
    const result = runTagRecFilter([video], { resolve: resolve([{ name: '游戏', v1: 4, v2: 1008 }]) })
    expect(result.items).toHaveLength(0)
    expect(result.stats.byDim.partitionAllow).toBe(1)
  })

  it.each(['all-v2-exact', 'all-v2-related'] as const)('%s 保留来源新版字段并执行纯新版分区仅看', (via) => {
    const raw = { bvid: 'BV-modern-game', typeid: 65, tidv2: 2071, pid_v2: 1008 }
    const video = normalizeAllV2Item(raw, { via, groupNames: [], srcRank: 0 })
    const result = runTagRecFilter([video], { resolve: resolve([{ name: '音乐', v2: 1003 }]) })
    expect(result.items).toHaveLength(0)
    expect(video.tidv2).toBe(2071)
    expect(video.pid_v2).toBe(1008)
  })
})
