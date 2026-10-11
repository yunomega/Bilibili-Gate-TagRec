import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterRecItems } from '$modules/filter'
import { fetchTagTop } from '../api/endpoints'
import { favorites, favoritesL1 } from '../store'
import { emptyTagRecFilterStats, tagRecCustomSession, tagRecFavSession } from '../store/session'
import { resetTagRecCustomSharedState } from './tag-rec-custom'
import { resetTagRecFavSharedState, TagRecFavService } from './tag-rec-fav'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type * as VideoEvidenceApi from '../api/video-evidence'
import type * as FilterEngine from '../model/filter-engine'
import type * as DeferredModule from './deferred-candidates'
import type * as RecallPlan from './recall-plan'
import type * as SupplyModule from './supply'

const resolverBuilds = { n: 0 }
const planCalls = { n: 0 }
const supplyScans = { calls: 0, items: 0 }
const mergeScans = { calls: 0, queue: 0 }
const scoreScans = { calls: 0, items: 0 }
vi.mock('../model/filter-engine', async (original) => {
  const actual = await original<typeof FilterEngine>()
  return {
    ...actual,
    createTagRecScopeResolver: vi.fn((opts: Parameters<typeof actual.createTagRecScopeResolver>[0]) => {
      resolverBuilds.n++
      return actual.createTagRecScopeResolver(opts)
    }),
    runTagRecScoreStage: vi.fn((...args: Parameters<typeof actual.runTagRecScoreStage>) => {
      scoreScans.calls++
      scoreScans.items += args[0].length
      return actual.runTagRecScoreStage(...args)
    }),
  }
})
vi.mock('./supply', async (original) => {
  const actual = await original<typeof SupplyModule>()
  return {
    ...actual,
    tagRecSupplyView: vi.fn((...args: Parameters<typeof actual.tagRecSupplyView>) => {
      supplyScans.calls++
      supplyScans.items += args[0].length + args[1].length
      return actual.tagRecSupplyView(...args)
    }),
  }
})
vi.mock('./deferred-candidates', async (original) => {
  const actual = await original<typeof DeferredModule>()
  class Counted extends actual.TagRecDeferredCandidates {
    override mergeIncoming(
      item: TagRecItemExtend,
      queue: readonly RecItemTypeOrSeparator[] | ReadonlyMap<string, TagRecItemExtend>,
      rank: (items: TagRecItemExtend[]) => TagRecItemExtend[],
      heap?: TagRecItemExtend[],
      heapIndex?: ReadonlyMap<string, TagRecItemExtend>,
    ) {
      mergeScans.calls++
      mergeScans.queue += Array.isArray(queue) ? queue.length : 1 // Map 索引命中记 1, 数组线性扫记长度
      return super.mergeIncoming(item, queue, rank, heap, heapIndex)
    }
  }
  return { ...actual, TagRecDeferredCandidates: Counted }
})
vi.mock('./recall-plan', async (original) => {
  const actual = await original<typeof RecallPlan>()
  return {
    ...actual,
    planTagRecRecall: vi.fn(
      (a: Parameters<typeof actual.planTagRecRecall>[0], b: Parameters<typeof actual.planTagRecRecall>[1]) => {
        planCalls.n++
        return actual.planTagRecRecall(a, b)
      },
    ),
  }
})
vi.mock('../store/combination-blocks', async () => {
  const { proxy } = await import('valtio')
  return { tagRecCombinationBlocks: proxy({ list: [] }) }
})
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_CLS_TAB_BAR: 'test', baseDebug: { extend: () => vi.fn() } }))
vi.mock('$components/RecGrid/useShortcut', () => ({ getColumnCount: () => 7 }))
vi.mock('$modules/filter', () => ({ filterRecItems: vi.fn((items: unknown[]) => items) }))
vi.mock('$modules/filter/normalize', () => ({ normalizeCardData: (item: { bvid: string }) => ({ bvid: item.bvid }) }))
vi.mock('$modules/rec-services/app', () => ({ AppRecService: class {} }))
vi.mock('$modules/rec-services/pc', () => ({ PcRecService: class {} }))
vi.mock('$modules/rec-services/service-map', () => ({ isRecTab: () => false }))
vi.mock('$modules/rec-services/dynamic-feed/api/enums', () => ({ DynamicFeedItemHelper: {} }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoPartition: vi.fn(() => Promise.resolve(undefined)),
  fetchVideoTags: vi.fn(() => Promise.resolve(undefined)),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/up-search', () => ({ fetchUpSearchPage: vi.fn(() => Promise.resolve({ items: [], hasMore: false })) }))
vi.mock('../api/dry-tids-store', () => ({
  isPersistedDryTid: () => false,
  persistDryTid: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({
  getPersistedVideoTags: vi.fn(() => Promise.resolve(undefined)),
  persistVideoTags: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-evidence', async (original) => {
  const actual = await original<typeof VideoEvidenceApi>()
  return { ...actual, fetchTagRecVideoEvidence: vi.fn(), getCachedTagRecVideoEvidence: vi.fn(() => undefined) }
})
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, currentIntervalMs: 0, lastRecoveredAt: 0, recentlyRecovered: () => false },
  isRiskControlError: () => false,
}))
vi.mock('../store', async () => {
  const { proxy } = await import('valtio')
  return {
    favorites: proxy({
      list: [] as {
        id: string
        name: string
        l1Id: string
        tag_ids: { id: number; name: string }[]
        weight: number
        enabled: boolean
        addedAt: number
      }[],
    }),
    favoritesL1: proxy({
      list: [] as { id: string; name: string; enabled: boolean; weight: number; addedAt: number }[],
    }),
    themes: proxy({ list: [] as unknown[], active: undefined }),
    viewScope: { scope: proxy({}), viewedL1Ids: () => undefined, viewedGroupIds: () => undefined },
    seen: new Set<string>(),
    sediment: { map: new Map(), merge: vi.fn(), noteDig: vi.fn() },
  }
})
vi.mock('../ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('./share-like', () => ({ noteShareLikeDelivered: vi.fn() }))
vi.mock('$modules/settings', async () => {
  const { proxy } = await import('valtio')
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return {
    settings: proxy({
      tagRec: {
        filter: createTagRecFactoryFilterCore(),
        diversityGuard: false,
        k: 3,
        ladder: { mode: 'fixed', autoDigMax: 0 },
      },
    }),
  }
})

const signal = () => new AbortController().signal
const timed = async <T>(label: string, run: () => Promise<T> | T): Promise<T> => {
  const t0 = performance.now()
  const out = await run()
  console.log(
    `[scale] ${label}: ${(performance.now() - t0).toFixed(0)}ms | resolvers=${resolverBuilds.n} plans=${planCalls.n} ` +
      `supply=${supplyScans.calls}call/${supplyScans.items}items merge=${mergeScans.calls}call/${mergeScans.queue}scan ` +
      `score=${scoreScans.calls}call/${scoreScans.items}items (cum)`,
  )
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(filterRecItems)
    .mockReset()
    .mockImplementation((items) => items)
  favorites.list.length = 0
  favoritesL1.list.length = 0
  resetTagRecCustomSharedState()
  resetTagRecFavSharedState()
  tagRecCustomSession.filterStats = emptyTagRecFilterStats()
  tagRecFavSession.filterStats = emptyTagRecFilterStats()
})

/**
 * 合成巨型收藏夹: 73 个一级组 / 535 个全开二级组 / ~930 个标签,
 * 与实机崩过的交付文件同量级 (IP·二次元男性向.tagrec.json)。
 */
const makeGiantFixture = () => {
  const l1s = Array.from({ length: 73 }, (_, i) => ({
    id: `L1-${i}`,
    name: `一级组${i}`,
    enabled: true,
    weight: 1,
    addedAt: i,
  }))
  let tid = 1000
  const groups = Array.from({ length: 535 }, (_, i) => {
    // 实机收藏包口径 395×2+140×1=930 个标签 (原 5+(i%10) 实产 5070, 与「约930」标注不符)
    const count = i < 395 ? 2 : 1
    return {
      id: `G-${i}`,
      name: `标签组${i}`,
      l1Id: l1s[i % l1s.length].id,
      tag_ids: Array.from({ length: count }, () => ({ id: ++tid, name: `tag${tid}` })),
      weight: 1,
      enabled: true,
      addedAt: i,
    }
  })
  return { groups, l1s, tagCount: tid - 1000 }
}

describe('巨型收藏夹规模回归 (535 组 / 73 一级组)', () => {
  it('fetchMore 三轮: 求解器构建有界 (曾 ~1150/轮) 且不崩溃', async () => {
    const { groups, l1s } = makeGiantFixture()
    favorites.list.push(...groups)
    favoritesL1.list.push(...l1s)
    // 同番/同声优族标签的 tag/top 结果实机高度重叠 —— 各 tid 共享 60 条池, 去重后库存有界;
    // 响应带完整互动统计 —— 覆盖真实算分路径 (stat 仅 view 时 computeScore 走 partial 直返)
    vi.mocked(fetchTagTop).mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: 60 }, (_, i) => ({
          bvid: `scale-${i}`,
          title: 'alpha',
          stat: { view: 1000, like: 40, favorite: 20, coin: 10, danmaku: 5, reply: 8 },
        })),
      ),
    )
    const svc = new TagRecFavService()
    const first = await timed('loadMore#1', () => svc.loadMore(signal()))
    console.log('[scale] delivered:', first?.length, 'fetchTagTop calls:', vi.mocked(fetchTagTop).mock.calls.length)
    await timed('loadMore#2', () => svc.loadMore(signal()))
    await timed('loadMore#3', () => svc.loadMore(signal()))
    console.log('[scale] fetchTagTop total:', vi.mocked(fetchTagTop).mock.calls.length)
    expect(first).toBeDefined()
    expect(first!.filter((it) => !('bvid' in it && !it.bvid)).length).toBeGreaterThan(0)
    // 回归锚: 版号缓存前单轮 ~1150 次全表重建 (535组×hasAllowedSupply/hasUpSupply 各建 resolver)
    expect(resolverBuilds.n).toBeLessThanOrEqual(30)
    // 回归锚: mergeQueued 逐条 rank 批化前 200 条重叠池单轮 ~2900 次评分阶段调用;
    //   批化后每轮 = 主轮分 + 重滤分 + flush 合并分, 与批次数同级而非到达物数同级
    expect(scoreScans.calls).toBeLessThanOrEqual(400)
  }, 120_000)
})
