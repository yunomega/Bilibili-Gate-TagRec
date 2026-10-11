import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { settings } from '$modules/settings'
import { fetchTagTop } from '../api/endpoints'
import {
  addTagRecCondition,
  newTagRecCombination,
  tagRecConditionAtom,
  type TagRecCombination,
} from '../model/combination'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { favorites, favoritesL1 } from '../store'
import { tagRecCustomSession } from '../store/session'
import { tagRecWorkbench } from '../store/workbench-state'
import {
  resetTagRecCustomSharedState,
  TagRecCustomService,
  tagRecCustomSharedBufferQueue,
  tagRecCustomSharedDeliveryReplay,
  tagRecCustomSharedSeenBvids,
  tagRecDeliveryReplayKey,
  tagRecLocalConditionImpact,
} from './tag-rec-custom'
import type { TagRecItemExtend } from '$define'
import type * as VideoEvidenceApi from '../api/video-evidence'
import type { TagGroup } from '../model/types'
vi.hoisted(() => {
  // workbench-state 的 GM 惰性水合在测试环境需桩, 否则未处理拒绝 (同 workbench.test.ts 手法)
  vi.stubGlobal('GM', {
    getValue: vi.fn(() => Promise.resolve(undefined)),
    setValue: vi.fn(() => Promise.resolve()),
  })
})
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

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
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve(undefined)) }))
vi.mock('../api/video-evidence', async (original) => {
  const actual = await original<typeof VideoEvidenceApi>()
  return { ...actual, fetchTagRecVideoEvidence: vi.fn(), getCachedTagRecVideoEvidence: vi.fn(() => undefined) }
})
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false, currentIntervalMs: 0, lastRecoveredAt: 0, recentlyRecovered: () => false },
  isRiskControlError: () => false,
}))
vi.mock('../store', () => ({
  favorites: { list: [] },
  favoritesL1: { list: [] },
  themes: { list: [], active: undefined },
  viewScope: { viewedL1Ids: () => undefined, viewedGroupIds: () => undefined },
  seen: new Set<string>(),
  sediment: { map: new Map(), merge: vi.fn(), noteDig: vi.fn() },
}))
vi.mock('../ui/tabbar-fav', () => ({ TagRecFavTabbarView: () => null }))
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('./share-like', () => ({ noteShareLikeDelivered: vi.fn() }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return {
    settings: {
      tagRec: {
        filter: createTagRecFactoryFilterCore(),
        diversityGuard: false,
        k: 3,
        ladder: { mode: 'fixed', autoDigMax: 0 },
      },
    },
  }
})

const workingGroup = (name: string, tags: { id: number; name: string }[]): TagGroup => {
  const combination: TagRecCombination = newTagRecCombination()
  for (const tag of tags) addTagRecCondition(combination, tagRecConditionAtom('tag', tag))
  return { id: '__tagrec_working__', name, enabled: true, weight: 1, addedAt: 0, tag_ids: tags, combination }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTagRecCustomSharedState()
  favorites.list.length = 0
  favoritesL1.list.length = 0
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.selectedGroupIds = []
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.workingGroup = undefined
  tagRecCustomSession.allowUnverified = false
  tagRecCustomSession.bypassSeen = true
  settings.tagRec.filter = { ...createTagRecFactoryFilterCore(), activePreset: '', presets: [] }
})

describe('切尝试重开收集 (工作台共享存货复用)', () => {
  it('切尝试清拉取去重; 同尝试编辑配方保留 (no reflowed deliveries)', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    new TagRecCustomService()
    tagRecCustomSharedSeenBvids().add('BV-keep')
    // 同尝试编辑配方 (组合变, trial 不变): 保 seen —— 编辑不重放已交付内容
    addTagRecCondition(
      tagRecCustomSession.workingGroup.combination!,
      tagRecConditionAtom('tag', { id: 2, name: '心月狐' }),
    )
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().has('BV-keep')).toBe(true)
    // 切尝试: 清 seen —— 重拉的头页/续挖货能再入队, 切回旧尝试不再净增≈0
    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 3, name: '原神' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().size).toBe(0)
  })

  it('切走再切回: 有界库存暂存原地恢复 (深挖游标对应的存货不再永久丢失)', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    new TagRecCustomService()
    tagRecCustomSharedSeenBvids().add('BV-seen-a')
    tagRecCustomSharedBufferQueue().push({
      api: EApiType.TagRec,
      uniqId: 'tag-rec:BV-stock-a',
      bvid: 'BV-stock-a',
      title: 'A 的未上屏存货',
      pic: '',
      stat: {},
      source: { via: 'tag-top', groupNames: ['试验A'], tagIds: [1] },
    } as TagRecItemExtend)
    // 切走: B 无暂存档 => 原清场语义 (seen/存货清空)
    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 3, name: '原神' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().size).toBe(0)
    expect(tagRecCustomSharedBufferQueue().length).toBe(0)
    // 切回 A: 暂存命中 => seen 与未上屏存货原地恢复 (已付费页对应的货仍可交付)
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().has('BV-seen-a')).toBe(true)
    expect(tagRecCustomSharedBufferQueue().some((it) => (it as TagRecItemExtend).bvid === 'BV-stock-a')).toBe(true)
  })

  it('显示已看 关→开 只切显示态: seen 记忆保留 (票 002/003)', () => {
    tagRecCustomSession.bypassSeen = false
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    new TagRecCustomService()
    tagRecCustomSharedSeenBvids().add('BV-seen')
    // 关→关: 不清
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().has('BV-seen')).toBe(true)
    // 关→开: 不再清 seen —— 清掉只会丢"看过的记忆"; 要看的旧内容由回放池零请求供给
    tagRecCustomSession.bypassSeen = true
    new TagRecCustomService()
    expect(tagRecCustomSharedSeenBvids().has('BV-seen')).toBe(true)
  })

  it('票 002/003: 显示已看开着切回: 零请求回放已交付内容 (第一次什么样, 切回来就什么样)', async () => {
    tagRecCustomSession.bypassSeen = true
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const local = (bvid: string): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: {},
      source: {
        via: 'tag-top',
        groupNames: ['试验A'],
        groupIds: ['__tagrec_working__'],
        tagIds: [1],
        claims: [{ via: 'tag-top', groupNames: ['试验A'], groupIds: ['__tagrec_working__'], tagIds: [1] }],
      },
    })
    const first = new TagRecCustomService()
    tagRecCustomSharedBufferQueue().push(local('BV-first-1'), local('BV-first-2'))
    const delivered = await first.loadMore(new AbortController().signal)
    const bvids = (items?: typeof delivered) =>
      (items ?? []).flatMap((it) => (it.api === EApiType.TagRec && it.bvid ? [it.bvid] : []))
    expect(bvids(delivered)).toEqual(['BV-first-1', 'BV-first-2'])

    // 切走 (试验 B) → 切回 (试验 A): 队列已空 (内容都已交付), 只剩回放池有货
    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 3, name: '原神' }])
    new TagRecCustomService()
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const back = new TagRecCustomService()
    vi.mocked(fetchTagTop).mockClear()
    const replayed = await back.loadMore(new AbortController().signal)
    expect(fetchTagTop).not.toHaveBeenCalled() // 零请求
    expect(bvids(replayed)).toEqual(['BV-first-1', 'BV-first-2'])
  })

  it('票 006: 回放内容可解释 —— 回放条打「回放」标、计数上屏、池子不被污染', async () => {
    tagRecCustomSession.bypassSeen = true
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const local = (bvid: string): TagRecItemExtend => ({
      api: EApiType.TagRec,
      uniqId: `tag-rec:${bvid}`,
      bvid,
      title: bvid,
      pic: '',
      stat: {},
      source: {
        via: 'tag-top',
        groupNames: ['试验A'],
        groupIds: ['__tagrec_working__'],
        tagIds: [1],
        claims: [{ via: 'tag-top', groupNames: ['试验A'], groupIds: ['__tagrec_working__'], tagIds: [1] }],
      },
    })
    const first = new TagRecCustomService()
    tagRecCustomSharedBufferQueue().push(local('BV-first-1'), local('BV-first-2'))
    await first.loadMore(new AbortController().signal)

    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 3, name: '原神' }])
    new TagRecCustomService()
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const back = new TagRecCustomService()
    const replayed = await back.loadMore(new AbortController().signal)

    // 回放条带「回放」标 + 计数上屏
    const recItems = (replayed ?? []).flatMap((it) => (it.api === EApiType.TagRec ? [it] : []))
    expect(recItems.length).toBe(2)
    expect(recItems.every((it) => it.tagRecReplayed)).toBe(true)
    expect(tagRecCustomSession.replayDelivered).toBe(2)
    // 池内条目不被标污染 (审计修复: 原断言 replay('__missing__') 对未知键返回 [] 恒真 —— 用真键)
    expect(
      tagRecCustomSharedDeliveryReplay()
        .replay(tagRecDeliveryReplayKey())
        .every((it) => !it.tagRecReplayed),
    ).toBe(true)
  })
})

describe('加词成本控制 (Q5b 本地先行 / Q8a 成本预览)', () => {
  const signal = () => new AbortController().signal
  const tagTopItem = (bvid: string, tid: number, title = 'local'): TagRecItemExtend => ({
    api: EApiType.TagRec,
    uniqId: `tag-rec:${bvid}`,
    bvid,
    title,
    pic: '',
    stat: {},
    source: {
      via: 'tag-top',
      groupNames: ['新试验'],
      groupIds: ['__tagrec_working__'],
      tagIds: [tid],
      claims: [{ via: 'tag-top', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], tagIds: [tid] }],
    },
  })

  it('本地先行闸: 本地有可交付存量时不发远程取数; 存量耗尽后放行', async () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const svc = new TagRecCustomService()
    tagRecCustomSharedBufferQueue().push(tagTopItem('BV-local', 1))
    tagRecCustomSession.localFirst = true
    vi.mocked(fetchTagTop).mockClear()
    const first = await svc.loadMore(signal())
    expect(fetchTagTop).not.toHaveBeenCalled() // 加词后先吃本地存量 (零请求)
    expect(first?.some((it) => it.api === EApiType.TagRec && (it as TagRecItemExtend).bvid === 'BV-local')).toBe(true)
    // 存量已交付耗尽 => 自动放行远程取数
    await svc.loadMore(signal())
    expect(fetchTagTop).toHaveBeenCalled()
  })

  it('成本预览: 本地存量命中估算 + 并入「或」/ 跨字段「且」', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    new TagRecCustomService()
    tagRecCustomSharedBufferQueue().push(tagTopItem('BV-a', 1, '三体 解说'), tagTopItem('BV-b', 1, '别的视频'))
    const titleImpact = tagRecLocalConditionImpact(tagRecConditionAtom('title', '三体'))
    expect(titleImpact.join).toBe('all') // 无同字段行 => 跨字段「且」
    expect(titleImpact.hits).toBe(1) // 只有 BV-a 同时满足 标签清宵 且 标题含三体
    const tagImpact = tagRecLocalConditionImpact(tagRecConditionAtom('tag', { id: 9, name: '原神' }))
    expect(tagImpact.join).toBe('any') // 已有 tag 行 => 并入「或」组
  })
})
