import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType, ETab } from '$enums'
import { filterRecItems } from '$modules/filter'
import { refreshForGrid } from '$modules/rec-services'
import { settings } from '$modules/settings'
import { fetchTagTop, fetchVideoPartition } from '../api/endpoints'
import { rememberTagRecPartition } from '../api/partition-cache'
import { fetchTagRecVideoEvidence } from '../api/video-evidence'
import {
  addTagRecCondition,
  evalTagRecCombination,
  excludeTagRecCondition,
  newTagRecCombination,
  tagRecConditionAtom,
} from '../model/combination'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { normalizeAllV2Item } from '../model/normalize-item'
import { favorites, favoritesL1 } from '../store'
import { emptyTagRecFilterStats, tagRecCustomSession, tagRecFavSession } from '../store/session'
import {
  computeTagRecCustomContextSignature,
  computeTagRecCustomFilterSignature,
  resetTagRecCustomSharedState,
  TagRecCustomService,
} from './tag-rec-custom'
import { computeTagRecFavFilterSignature, resetTagRecFavSharedState, TagRecFavService } from './tag-rec-fav'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type * as VideoEvidenceApi from '../api/video-evidence'
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

const services = [
  { name: '主题推荐', Service: TagRecFavService, session: tagRecFavSession, tab: ETab.TagRecFav },
  { name: '标签发掘', Service: TagRecCustomService, session: tagRecCustomSession, tab: ETab.TagRecCustom },
]
let serial = 0
const item = (
  suffix: string,
  fields: Record<string, unknown> = {},
  via: 'all-v2-exact' | 'all-v2-related' = 'all-v2-exact',
) =>
  normalizeAllV2Item(
    { bvid: `partition-${++serial}-${suffix}`, title: 'alpha', typeid: 65, ...fields },
    {
      via,
      groupIds: ['A'],
      groupNames: ['A'],
      srcRank: serial,
    },
  )
const signal = () => new AbortController().signal

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(filterRecItems)
    .mockReset()
    .mockImplementation((items) => items)
  vi.mocked(fetchVideoPartition).mockReset().mockResolvedValue(undefined)
  vi.mocked(fetchTagRecVideoEvidence).mockReset().mockResolvedValue(undefined)
  favorites.list.length = 0
  favoritesL1.list.length = 0
  resetTagRecCustomSharedState()
  resetTagRecFavSharedState()
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.draftGroup = undefined
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.selectedGroupIds = ['A']
  tagRecCustomSession.filterOverride = undefined
  tagRecFavSession.filterOverride = undefined
  tagRecCustomSession.workingGroup = undefined
  tagRecCustomSession.allowUnverified = false
  tagRecCustomSession.supplyPaused = false
  tagRecCustomSession.filterStats = emptyTagRecFilterStats()
  tagRecFavSession.filterStats = emptyTagRecFilterStats()
  settings.tagRec.filter = { ...createTagRecFactoryFilterCore(), activePreset: '', presets: [] }
  settings.tagRec.ladder = { ...settings.tagRec.ladder, mode: 'fixed', autoDigMax: 0 }
  settings.tagRec.filter.dims.likeRate.enabled = false
  settings.tagRec.filter.dims.partitionAllow = { enabled: true, list: [{ name: '游戏', v2: 1008, level: 'parent' }] }
  favoritesL1.list.push({ id: 'P', name: 'P', enabled: true, weight: 1, addedAt: 0 })
  favorites.list.push({
    id: 'A',
    name: 'A',
    l1Id: 'P',
    enabled: true,
    weight: 1,
    addedAt: 0,
    tag_ids: [{ id: 1, name: 'alpha' }],
  })
})

describe.each(services)('$name 的实际分区交付', ({ Service, session, tab }) => {
  it('有马加奈→加入原神→移出有马加奈：旧候选不能挡住原神 tag/top 的首屏', async () => {
    if (tab !== ETab.TagRecCustom) return
    settings.tagRec.filter.enabled = false
    const kana = { id: 11, name: '有马加奈' }
    const genshin = { id: 22, name: '原神' }
    const setWorking = (entries: (typeof kana)[]) => {
      const combination = newTagRecCombination()
      for (const entry of entries) addTagRecCondition(combination, tagRecConditionAtom('tag', entry))
      tagRecCustomSession.workingGroup = {
        ...favorites.list[0],
        id: '__tagrec_working__',
        tag_ids: entries,
        combination,
      }
    }
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve(
        Array.from({ length: 62 }, (_, i) => ({
          bvid: `query-switch-${tid}-${i}`,
          title: `${tid === 11 ? '有马加奈' : '原神'} 视频 ${i}`,
          stat: { view: 1000 },
        })),
      ),
    )
    setWorking([kana])
    const first = new TagRecCustomService()
    expect(
      (await first.loadMore(signal()))?.some((v) => v.api === EApiType.TagRec && v.bvid.startsWith('query-switch-11')),
    ).toBe(true)
    setWorking([kana, genshin])
    await new TagRecCustomService().loadMore(signal())
    setWorking([genshin])
    const final = new TagRecCustomService()
    const videos = await final.loadMore(signal())
    expect(fetchTagTop).toHaveBeenCalledWith(22, expect.anything())
    expect(videos?.some((v) => v.api === EApiType.TagRec && v.bvid.startsWith('query-switch-22'))).toBe(true)
    expect(videos?.some((v) => v.api === EApiType.TagRec && v.bvid.startsWith('query-switch-11'))).toBe(false)
    // tag/top 本身足以证明正向标签；无需放开未知，也无需对原神结果逐条补查。
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    expect(vi.mocked(fetchTagRecVideoEvidence).mock.calls.some(([bvid]) => bvid.startsWith('query-switch-22'))).toBe(
      false,
    )
  })
  it('只剩待核实库存时，续批仍会推进来源，暂存条目不会堵死下一页', async () => {
    if (tab !== ETab.TagRecCustom) return
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__', combination }
    const svc = new TagRecCustomService()
    const unknown = item('held-before-next-page')
    svc.qs.bufferQueue.push(unknown)
    const next = item('next-page', { description: '人物分析' })
    next.fieldEvidence = { desc: 'complete' }
    const fetchNext = vi.spyOn(svc, 'fetchMore').mockResolvedValue([next])
    // 待核实不占库存: 库存视图低于水位即触发取新, 不等队列物理见底或手动重试
    expect((await svc.loadMore(signal()))?.map((entry) => entry.api === EApiType.TagRec && entry.bvid)).toEqual([
      next.bvid,
    ])
    expect(fetchNext).toHaveBeenCalledTimes(1)
    expect(svc.qs.bufferQueue).toContain(unknown)
    expect(session.partitionPending).toBe(1)
    // 暂存条目继续不阻断: 无新产出时按既有暂存语义暂停自动加载
    fetchNext.mockResolvedValue([])
    svc.retryPartitions()
    expect(await svc.loadMore(signal())).toEqual([])
    expect(fetchNext).toHaveBeenCalledTimes(2)
    expect(session.partitionPaused).toBe(true)
  })
  it('个别待核实条目不阻断后面的已知视频，继续核实只追加且不重复交付', async () => {
    if (tab !== ETab.TagRecCustom) return
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__', combination }
    const svc = new TagRecCustomService()
    svc.hasMoreExceptQueue = false
    const unknown = item('held')
    const known = Array.from({ length: 28 }, (_, i) => {
      const video = item(`known-${i}`, { description: '人物分析' })
      video.fieldEvidence = { desc: 'complete' }
      return video
    })
    svc.qs.bufferQueue.push(unknown, ...known)
    const first = await svc.loadMore(signal())
    expect(first?.length).toBeGreaterThan(0)
    expect(session.partitionPending).toBe(1)
    expect(svc.autoLoadPaused).toBe(false)
    const second = await svc.loadMore(signal())
    expect([...(first ?? []), ...(second ?? [])].filter((entry) => entry.api === EApiType.TagRec)).toHaveLength(28)
    expect(session.partitionPending).toBe(1)
    svc.retryPartitions()
    vi.mocked(fetchTagRecVideoEvidence).mockResolvedValue({ desc: '人物分析', fieldEvidence: { desc: 'complete' } })
    const third = await svc.loadMore(signal())
    expect(third?.map((entry) => entry.api === EApiType.TagRec && entry.bvid)).toEqual([unknown.bvid])
    expect(session.partitionPending).toBe(0)
  })
  it('按池批量补查只查未知项，每批最多20条，不取新视频；已核实项下次复用', async () => {
    if (tab !== ETab.TagRecCustom) return
    const svc = new TagRecCustomService()
    const videos = Array.from({ length: 27 }, (_, i) =>
      item(`batch-${i}`, {}, i === 26 ? 'all-v2-related' : 'all-v2-exact'),
    )
    videos[0].ownTagIds = [1]
    svc.qs.bufferQueue.push(...videos)
    vi.mocked(fetchTagRecVideoEvidence).mockResolvedValue({ ownTagIds: [2], ownTagNames: ['人物'] })
    const first = await svc.completeDiscoveryTags('allV2', signal())
    expect(first).toEqual({ attempted: 20, updated: 20, stale: false })
    expect(fetchTagRecVideoEvidence).toHaveBeenCalledTimes(20)
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(fetchTagRecVideoEvidence).not.toHaveBeenCalledWith(videos[26].bvid, expect.anything())
    const second = await svc.completeDiscoveryTags('allV2', signal())
    expect(second).toEqual({ attempted: 5, updated: 5, stale: false })
    expect(svc.getDiscoveryStatus().find((entry) => entry.pool === 'allV2')).toMatchObject({
      cached: 26,
      tagsPending: 0,
    })
    expect(svc.getDiscoveryStatus().find((entry) => entry.pool === 'allV2Related')).toMatchObject({
      cached: 1,
      tagsPending: 1,
    })
  })
  it('缓存浏览只停取新，核验照常；证据未齐的未知仍暂存', async () => {
    if (tab !== ETab.TagRecCustom) return
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__', combination }
    tagRecCustomSession.supplyPaused = true
    const svc = new TagRecCustomService()
    svc.hasMoreExceptQueue = false
    const known = item('cached-known', { description: '人物分析' })
    known.fieldEvidence = { desc: 'complete' }
    const unknown = item('cached-unknown')
    svc.qs.bufferQueue.push(known, unknown)
    const delivered = await svc.loadMore(signal())
    expect(delivered?.map((entry) => entry.api === EApiType.TagRec && entry.bvid)).toEqual([known.bvid])
    // 「先看缓存」只停取新 —— 核验照常跑; 证据返回 undefined 的未知条照旧暂存
    expect(fetchTagRecVideoEvidence).toHaveBeenCalled()
    expect(fetchVideoPartition).not.toHaveBeenCalled()
    expect(tagRecCustomSession.partitionPending).toBe(1)
    expect(svc.qs.bufferQueue.some((entry) => entry.api === EApiType.TagRec && entry.bvid === unknown.bvid)).toBe(true)
    tagRecCustomSession.supplyPaused = false
    svc.retryPartitions()
    vi.mocked(fetchTagRecVideoEvidence).mockResolvedValue({ desc: '阅读分析', fieldEvidence: { desc: 'complete' } })
    const supplied = await svc.loadMore(signal())
    expect(supplied?.some((entry) => entry.api === EApiType.TagRec && entry.bvid === unknown.bvid)).toBe(true)
    expect(fetchTagRecVideoEvidence).toHaveBeenCalledTimes(2)
  })

  it('停牌尝试账按复活冷却自清：自动续批不清零（上限真实生效），明令重试或冷却到期才复活', async () => {
    if (tab !== ETab.TagRecCustom) return
    settings.tagRec.filter.enabled = false
    settings.tagRec.ladder = {
      ...settings.tagRec.ladder,
      mode: 'fixed',
      autoDigMax: 0,
      heldMaxAttempts: 2,
      heldRetryQuota: 1,
    }
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__', combination }
    const svc = new TagRecCustomService()
    svc.hasMoreExceptQueue = false
    svc.qs.bufferQueue.push(item('held-ttl'))
    await svc.loadMore(signal())
    expect(tagRecCustomSession.partitionPending).toBe(1)
    await svc.loadMore(signal())
    expect(tagRecCustomSession.partitionAbandoned).toBe(1) // 真查两轮 => 封顶
    const calls = vi.mocked(fetchTagRecVideoEvidence).mock.calls.length
    svc.retryPartitions(false) // 冷却未到: 封顶条不动
    await svc.loadMore(signal())
    expect(vi.mocked(fetchTagRecVideoEvidence).mock.calls.length).toBe(calls) // 封顶条不再白吃核验额度
    svc.retryPartitions(true) // 明令重试 => 即刻复活
    await svc.loadMore(signal())
    expect(vi.mocked(fetchTagRecVideoEvidence).mock.calls.length).toBeGreaterThan(calls)
    await svc.loadMore(signal()) // 再次封顶 (capAt 重记)
    const afterManual = vi.mocked(fetchTagRecVideoEvidence).mock.calls.length
    svc.retryPartitions(false)
    await svc.loadMore(signal())
    expect(vi.mocked(fetchTagRecVideoEvidence).mock.calls.length).toBe(afterManual) // 冷却内仍不复活
    try {
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1)
      svc.retryPartitions(false) // 封顶冷却到期 => 自动复活 (无需手动)
    } finally {
      vi.useRealTimers()
    }
    await svc.loadMore(signal())
    expect(vi.mocked(fetchTagRecVideoEvidence).mock.calls.length).toBeGreaterThan(afterManual) // 重获轮转资格
  })
  const stock = () => {
    const svc = new Service()
    svc.hasMoreExceptQueue = false
    return svc
  }

  it('临时过滤轻应用: 存货队列与已上屏条目原位重滤, 不重建不重拉', () => {
    const svc = stock()
    const keep = item('live-keep') // 工厂默认 title 'alpha'
    const drop = item('live-drop', { title: 'beta' })
    svc.qs.bufferQueue.push(keep, drop)
    // 旧过滤滤空留下的硬见底闩: 轻应用须复位 —— 否则补货被 hasMore 永久挡住 (取消仅看也刷不出来)
    svc.hasMoreExceptQueue = false
    session.hardBottom = true
    session.filterOverride = { dims: { titleAllow: { enabled: true, list: ['alpha'] } } }
    // 镜像把过滤编辑并入组合对象 (combination 换身): 组合签名计入 filters 入语境签名 =>
    //   实例钉点漂移后 isSessionStale() 恒真、交付循环静默空转; 轻应用须与重建同口径重钉
    if (tab === ETab.TagRecCustom) {
      const combination = newTagRecCombination()
      addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
      tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__', combination }
      tagRecCustomSession.workingGroup.combination = { ...combination, filters: session.filterOverride as never }
      expect(svc.contextSignature).not.toBe(computeTagRecCustomContextSignature())
    }
    expect(svc.applySessionFilterLive()).toBe(true)
    if (tab === ETab.TagRecCustom) {
      expect(svc.contextSignature).toBe(computeTagRecCustomContextSignature()) // isSessionStale 不再恒真
      expect(svc.filterSignature).toBe(computeTagRecCustomFilterSignature()) // drift 判定不再恒漂移
    } else {
      expect(svc.filterSignature).toBe(computeTagRecFavFilterSignature())
    }
    expect(svc.hasMoreExceptQueue).toBe(true) // 硬见底闩复位 (新过滤下仍零产会由 exhaustRound 复置)
    expect(session.hardBottom).toBe(false)
    const queueBvids = svc.qs.bufferQueue.map((entry) => entry.api === EApiType.TagRec && entry.bvid)
    expect(queueBvids).toContain(keep.bvid)
    expect(queueBvids).not.toContain(drop.bvid) // 存货按新生效链重滤
    expect(svc.refilterDisplayed([keep, drop]).map((entry) => entry.bvid)).toEqual([keep.bvid]) // 已上屏条目重滤
    expect(svc.applySessionFilterLive()).toBe(false) // 生效过滤未变 => no-op 跳过 (零画面变化)
    expect(fetchTagTop).not.toHaveBeenCalled() // 零请求
  })

  it('辅助过滤关闭时仍守完整组合，必要补查后交付，失败的未知保留库存', async () => {
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    favorites.list[0].combination = combination
    if (tab === ETab.TagRecCustom) tagRecCustomSession.workingGroup = { ...favorites.list[0], id: '__tagrec_working__' }
    const svc = stock()
    const confirmed = item('confirmed', { description: '作品分析' })
    confirmed.fieldEvidence = { desc: 'complete' }
    const rejected = item('rejected', { description: '动画作品' })
    const unknown = item('unknown')
    const supplied = item('supplied')
    vi.mocked(fetchTagRecVideoEvidence).mockImplementation((bvid) =>
      Promise.resolve(
        bvid === supplied.bvid ? { desc: '阅读分析', fieldEvidence: { desc: 'complete' }, ownTagIds: [] } : undefined,
      ),
    )
    svc.qs.bufferQueue.push(rejected, confirmed, unknown, supplied)
    const out = await svc.loadMore(signal())
    expect(out?.map((entry) => entry.api === EApiType.TagRec && entry.bvid)).toEqual([confirmed.bvid, supplied.bvid])
    expect(svc.qs.bufferQueue.map((entry) => entry.api === EApiType.TagRec && entry.bvid)).toContain(unknown.bvid)
    expect(session.partitionPending).toBe(1)
    expect(fetchTagRecVideoEvidence).toHaveBeenCalledTimes(2)
    expect(fetchVideoPartition).not.toHaveBeenCalled()
    if (tab === ETab.TagRecCustom) {
      tagRecCustomSession.allowUnverified = true
      svc.retryPartitions()
      const temporary = await svc.loadMore(signal())
      const bvids = temporary?.map((entry) => entry.api === EApiType.TagRec && entry.bvid)
      expect(bvids).toContain(unknown.bvid)
      expect(temporary?.find((entry) => entry.api === EApiType.TagRec && entry.bvid === unknown.bvid)).toMatchObject({
        combinationUnverified: true,
      })
      expect(bvids).not.toContain(rejected.bvid)
      expect(fetchTagRecVideoEvidence).toHaveBeenCalledTimes(2)
    }
  })

  it.each(['all-v2-exact', 'all-v2-related'] as const)('%s 的现代字段零补查，浅数据相关内容仍可交付', async (via) => {
    const svc = stock()
    const game = item('game', { tidv2: 2071, pid_v2: 1008 }, via)
    const history = item('history', { tidv2: 2090, pid_v2: 1010 }, via)
    svc.qs.bufferQueue.push(history, game)
    const out = await svc.loadMore(signal())
    expect(out?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual([game.bvid])
    expect(session.filterStats.byDim.partitionAllow).toBe(1)
    expect(fetchVideoPartition).not.toHaveBeenCalled()
    expect(session.partitionPaused).toBe(false)
  })

  it('旧缓存只有 typeid 时补查后排除新版知识，保留新版游戏', async () => {
    const svc = stock()
    const game = item('game')
    const history = item('history')
    svc.qs.bufferQueue.push(game, history)
    vi.mocked(fetchVideoPartition).mockImplementation((bvid) =>
      Promise.resolve(bvid === game.bvid ? { tidv2: 2071, pid_v2: 1008 } : { tidv2: 2090, pid_v2: 1010 }),
    )
    expect((await svc.loadMore(signal()))?.map((it) => it.api === EApiType.TagRec && it.bvid)).toEqual([game.bvid])
    expect(fetchVideoPartition).toHaveBeenCalledTimes(2)
    expect(session.filterStats.byDim.partitionAllow).toBe(1)
  })

  it('已更新缓存的新版叶不能继承队列里的旧父分区', async () => {
    const svc = stock()
    const old = item('old-parent', { tidv2: 2071, pid_v2: 1008 })
    rememberTagRecPartition(old.bvid, { tid_v2: 2090 })
    svc.qs.bufferQueue.push(old)
    expect(await svc.loadMore(signal())).toEqual([])
    expect(fetchVideoPartition).not.toHaveBeenCalled()
    expect(session.filterStats.byDim.partitionAllow).toBe(1)
  })

  it('另一允许组已确认通过时无需为未知链补查，交付只归到允许组', async () => {
    settings.tagRec.filter.dims.partitionAllow.enabled = false
    favorites.list[0].overrides = {
      negative: { partitionAllow: { enabled: true, list: [{ name: '游戏', v2: 1008 }] } },
    }
    favorites.list.push({
      id: 'B',
      name: 'B',
      l1Id: 'P',
      enabled: true,
      weight: 1,
      addedAt: 0,
      tag_ids: [{ id: 2, name: 'alpha' }],
    })
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    const svc = stock()
    const shared = item('both')
    shared.source.groupIds = ['A', 'B']
    shared.source.groupNames = ['A', 'B']
    svc.qs.bufferQueue.push(shared)
    const out = await svc.loadMore(signal())
    expect(out).toHaveLength(1)
    const video = out![0]
    expect(video.api === EApiType.TagRec && video.eligibleGroupKeys).toEqual(['id:B'])
    expect(fetchVideoPartition).not.toHaveBeenCalled()
  })

  if (Service === TagRecFavService)
    it('大池待检不会挤掉小池中已经确认相关的内容', async () => {
      favorites.list[0].weight = 30
      favorites.list.push({
        id: 'B',
        name: 'B',
        l1Id: 'P',
        enabled: true,
        weight: 1,
        addedAt: 0,
        tag_ids: [{ id: 2, name: 'alpha' }],
      })
      tagRecCustomSession.selectedGroupIds = ['A', 'B']
      const svc = stock()
      const cold = item('cold', { tidv2: 2071, pid_v2: 1008 })
      cold.source.groupIds = ['B']
      cold.source.groupNames = ['B']
      svc.qs.bufferQueue.push(...Array.from({ length: 40 }, (_, i) => item(`hot-${i}`)), cold)
      const out = await svc.loadMore(signal())
      expect(out?.some((video) => video.api === EApiType.TagRec && video.bvid === cold.bvid)).toBe(true)
      expect(session.filterStats.dropped).toBe(0)
      expect(svc.qs.bufferQueue.some((video) => video.api === EApiType.TagRec && video.bvid !== cold.bvid)).toBe(true)
    })

  it('继续筛选会推进后续候选，不被前面的待检内容永久挡住', async () => {
    const svc = stock()
    const unknown = Array.from({ length: 40 }, (_, i) => item(`unknown-${i}`))
    const later = item('later', { tidv2: 2071, pid_v2: 1008 })
    svc.qs.bufferQueue.push(...unknown, later)
    expect(await svc.loadMore(signal())).toEqual([])
    svc.retryPartitions()
    const out = await svc.loadMore(signal())
    expect(out?.some((video) => video.api === EApiType.TagRec && video.bvid === later.bvid)).toBe(true)
    expect(session.filterStats.dropped).toBe(0)
  })

  it('查不清保留库存、暂停自动补足；手动继续能再次核验并交付', async () => {
    const svc = stock()
    const pending = item('pending')
    svc.qs.bufferQueue.push(pending)
    expect(await refreshForGrid({ tab, service: svc, abortSignal: signal() })).toEqual([])
    expect(fetchVideoPartition).toHaveBeenCalledTimes(1)
    expect(svc.qs.bufferQueue).toHaveLength(1)
    expect(svc.hasMore).toBe(true)
    expect(session.partitionPaused).toBe(true)
    expect(session.partitionPending).toBe(1)
    expect(session.hardBottom).toBe(false)
    expect(session.filterStats.dropped).toBe(0)
    vi.mocked(fetchVideoPartition).mockResolvedValue({ tidv2: 2071, pid_v2: 1008 })
    svc.retryPartitions()
    expect(await svc.loadMore(signal())).toHaveLength(1)
    expect(svc.qs.bufferQueue).toHaveLength(0)
    expect(session.partitionPaused).toBe(false)
    svc.restore()
    expect(svc.qs.bufferQueue).toHaveLength(1)
  })

  it('关闭仅看即时恢复待检库存，不重新召回原页', async () => {
    const svc = stock()
    svc.qs.bufferQueue.push(item('recover'))
    expect(await svc.loadMore(signal())).toEqual([])
    settings.tagRec.filter.dims.partitionAllow.enabled = false
    expect(svc.autoLoadPaused).toBe(false)
    expect(await svc.loadMore(signal())).toHaveLength(1)
    expect(fetchVideoPartition).toHaveBeenCalledTimes(1)
    expect(fetchTagTop).not.toHaveBeenCalled()
  })

  it('切回推荐时能恢复已确认的展示内容，待检暂停不会阻止恢复', async () => {
    const svc = stock()
    const known = item('restore-known', { tidv2: 2071, pid_v2: 1008 })
    svc.qs.bufferQueue.push(known, item('restore-pending'))
    expect(await svc.loadMore(signal())).toHaveLength(1)
    expect(session.partitionPaused).toBe(true)
    expect(fetchVideoPartition).toHaveBeenCalledTimes(1)
    svc.restore()
    expect(svc.autoLoadPaused).toBe(false)
    expect(
      (await svc.loadMore(signal()))?.some((video) => video.api === EApiType.TagRec && video.bvid === known.bvid),
    ).toBe(true)
    // 票 005: 停牌条随新货轮转重试一轮 (有界: 每轮配额+尝试上限), 恢复内容不重复交付
    expect(fetchVideoPartition).toHaveBeenCalledTimes(tab === ETab.TagRecCustom ? 2 : 1)
  })

  it('待检期间缓存补齐的新事实可以立即使用', async () => {
    const svc = stock()
    const pending = item('new-facts')
    svc.qs.bufferQueue.push(pending)
    expect(await svc.loadMore(signal())).toEqual([])
    rememberTagRecPartition(pending.bvid, { tid_v2: 2064 })
    svc.qs.bufferQueue.push(...Array.from({ length: 40 }, (_, i) => item(`new-stock-${i}`)))
    svc.retryPartitions()
    expect(
      (await svc.loadMore(signal()))?.some((video) => video.api === EApiType.TagRec && video.bvid === pending.bvid),
    ).toBe(true)
    expect(session.filterStats.dropped).toBe(0)
  })

  it('核验期间改仅看条件，旧结果不能出队或进入恢复队列', async () => {
    const svc = stock()
    svc.qs.bufferQueue.push(item('stale'))
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof fetchVideoPartition>>>()
    vi.mocked(fetchVideoPartition).mockReturnValue(deferred.promise)
    const loading = svc.loadMore(signal())
    await vi.waitFor(() => expect(fetchVideoPartition).toHaveBeenCalledTimes(1))
    settings.tagRec.filter.dims.partitionAllow.list = [{ name: '音乐', v2: 1003 }]
    deferred.resolve({ tidv2: 2071, pid_v2: 1008 })
    expect(await loading).toBeUndefined()
    expect(svc.qs.bufferQueue).toHaveLength(1)
    svc.restore()
    expect(svc.qs.bufferQueue).toHaveLength(1)
  })

  it('真正的 refreshForGrid 外层补足不能续领预算连续补查', async () => {
    settings.tagRec.ladder.verifyRequests = 20
    const svc = stock()
    svc.qs.bufferQueue.push(...Array.from({ length: 120 }, (_, i) => item(`limit-${i}`)))
    vi.mocked(fetchVideoPartition).mockResolvedValue({ tidv2: 2090, pid_v2: 1010 })
    expect(await refreshForGrid({ tab, service: svc, abortSignal: signal() })).toEqual([])
    expect(fetchVideoPartition).toHaveBeenCalledTimes(20)
    expect(session.filterStats.dropped).toBe(20)
    expect(svc.qs.bufferQueue).toHaveLength(100)
    expect(session.partitionPaused).toBe(true)
    expect(svc.hasMore).toBe(true)
  })

  it('外层因通用过滤而多次补足时，同一刷新仍只用一份补查预算', async () => {
    settings.tagRec.ladder.verifyRequests = 20
    const svc = stock()
    svc.qs.bufferQueue.push(
      ...Array.from({ length: 120 }, (_, i) => item(`outer-${i}`, i % 2 ? {} : { tidv2: 2071, pid_v2: 1008 })),
    )
    vi.mocked(fetchVideoPartition).mockResolvedValue({ tidv2: 2071, pid_v2: 1008 })
    vi.mocked(filterRecItems).mockImplementation((items) => items.slice(0, 1))
    const load = vi.spyOn(svc, 'loadMore')
    const out = await refreshForGrid({ tab, service: svc, abortSignal: signal() })
    expect(out).toHaveLength(5)
    expect(load).toHaveBeenCalledTimes(7)
    expect(fetchVideoPartition).toHaveBeenCalledTimes(20)
    expect(session.partitionPaused).toBe(true)
    expect(svc.qs.bufferQueue).toHaveLength(40)
  })

  it('整次刷新补查共享五秒时间盒，截止后保留未核验内容', async () => {
    vi.useFakeTimers()
    try {
      const svc = stock()
      svc.qs.bufferQueue.push(...Array.from({ length: 20 }, (_, i) => item(`slow-${i}`)))
      vi.mocked(fetchVideoPartition).mockImplementation((_bvid, { signal } = {}) => {
        const deferred = Promise.withResolvers<Awaited<ReturnType<typeof fetchVideoPartition>>>()
        const onAbort = () => {
          clearTimeout(timer)
          deferred.reject(new DOMException('Aborted', 'AbortError'))
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          deferred.resolve({ tidv2: 2071, pid_v2: 1008 })
        }, 1_500)
        signal?.addEventListener('abort', onAbort, { once: true })
        return deferred.promise
      })
      const loading = refreshForGrid({ tab, service: svc, abortSignal: signal() })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(await loading).toHaveLength(6)
      expect(fetchVideoPartition).toHaveBeenCalledTimes(8)
      expect(svc.qs.bufferQueue).toHaveLength(14)
      expect(session.partitionPending).toBe(14)
      expect(session.filterStats.dropped).toBe(0)
      expect(session.partitionPaused).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('来源与证据旅程', () => {
  const workingTag = (tag: { id: number; name: string }) => {
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', tag))
    tagRecCustomSession.workingGroup = {
      ...favorites.list[0],
      id: '__tagrec_working__',
      tag_ids: [tag],
      combination,
    }
    return combination
  }
  const tagRec = (items: RecItemTypeOrSeparator[] | undefined) =>
    (items ?? []).filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)

  it('tag/top 交付同时带顶层 tagIds 与逐消费者 claims，组合直接判命中', async () => {
    settings.tagRec.filter.enabled = false
    const tag = { id: 11, name: '有马加奈' }
    const combination = workingTag(tag)
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'evidence-top-1', title: '有马加奈 视频', stat: { view: 1000 } }])
    const videos = tagRec(await new TagRecCustomService().loadMore(signal()))
    const delivered = videos.find((video) => video.bvid === 'evidence-top-1')
    expect(delivered).toBeDefined()
    expect(delivered!.source.via).toBe('tag-top')
    expect(delivered!.source.tagIds).toContain(11)
    expect(delivered!.source.claims?.some((claim) => claim.via === 'tag-top' && claim.tagIds?.includes(11))).toBe(true)
    expect(evalTagRecCombination(delivered!, combination).state).toBe('match')
    // 证据链直接成立 => 无需逐条补查
    expect(fetchTagRecVideoEvidence).not.toHaveBeenCalled()
  })

  it('作用域重查补写的证据链让条目重新命中组合，而不是退回未知', async () => {
    settings.tagRec.filter.enabled = false
    const tag = { id: 11, name: '有马加奈' }
    const combination = workingTag(tag)
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'recheck-hit', title: '有马加奈 视频', stat: { view: 1000 } }])
    const svc = new TagRecCustomService()
    const option = svc.getRecheckOptions().find((entry) => entry.pools.includes('tagTop'))
    expect(option).toBeDefined()
    const result = await svc.recheck(option!, signal())
    expect(result.added).toBeGreaterThan(0)
    const queued = tagRec(svc.qs.bufferQueue).find((video) => video.bvid === 'recheck-hit')
    expect(queued).toBeDefined()
    expect(queued!.source.tagIds).toContain(11)
    expect(queued!.source.claims?.some((claim) => claim.via === 'tag-top' && claim.tagIds?.includes(11))).toBe(true)
    expect(evalTagRecCombination(queued!, combination).state).toBe('match')
    expect(tagRec(await svc.loadMore(signal())).some((video) => video.bvid === 'recheck-hit')).toBe(true)
  })

  it('同一 BV 被两个来源组召回：只画一张卡，两个来源都保留归因', async () => {
    settings.tagRec.filter.enabled = false
    favorites.list.push({
      id: 'B',
      name: 'B',
      l1Id: 'P',
      enabled: true,
      weight: 1,
      addedAt: 0,
      tag_ids: [{ id: 2, name: 'beta' }],
    })
    tagRecCustomSession.selectedGroupIds = ['A', 'B']
    vi.mocked(fetchTagTop).mockImplementation((tid) =>
      Promise.resolve([{ bvid: 'shared-bv', title: 'shared', stat: { view: 1000 } }]),
    )
    const videos = tagRec(await new TagRecCustomService().loadMore(signal()))
    const shared = videos.filter((video) => video.bvid === 'shared-bv')
    expect(shared).toHaveLength(1)
    expect(new Set(shared[0].source.claims?.map((claim) => claim.groupIds?.[0]))).toEqual(new Set(['A', 'B']))
    expect(new Set(shared[0].source.groupIds)).toEqual(new Set(['A', 'B']))
    expect(shared[0].source.attributionLabels).toHaveLength(2)
    expect(new Set(shared[0].source.attributionLabels).size).toBe(2)
    expect(
      vi
        .mocked(fetchTagTop)
        .mock.calls.map((call) => call[0])
        .sort(),
    ).toEqual([1, 2])
  })
})

describe('服务级用户旅程', () => {
  const tagRec = (items: RecItemTypeOrSeparator[] | undefined) =>
    (items ?? []).filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
  const setWorking = (combination: ReturnType<typeof newTagRecCombination>, tag: { id: number; name: string }) => {
    tagRecCustomSession.workingGroup = {
      ...favorites.list[0],
      id: '__tagrec_working__',
      tag_ids: [tag],
      combination,
    }
  }

  it('待核实不阻断已知内容 → 改条件重置暂存 → 临时查看放出未知', async () => {
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    setWorking(combination, { id: 1, name: 'alpha' })
    const svc = new TagRecCustomService()
    svc.hasMoreExceptQueue = false
    const known = item('journey-known', { description: '人物分析' })
    known.fieldEvidence = { desc: 'complete' }
    const unknown = item('journey-unknown')
    svc.qs.bufferQueue.push(unknown, known)

    // 1) 未知只暂存：已知内容照常交付，不被待核实挡住
    expect(tagRec(await svc.loadMore(signal())).map((video) => video.bvid)).toEqual([known.bvid])
    expect(tagRecCustomSession.partitionPending).toBe(1)
    expect(tagRecCustomSession.partitionPaused).toBe(true)

    // 2) 改条件：旧待核实暂存随之重置，不再卡在旧证据
    tagRecCustomSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['alpha'] } } }
    expect(svc.autoLoadPaused).toBe(false)
    expect(tagRecCustomSession.partitionPending).toBe(0)

    // 3) 临时查看：未知条目以「未核实」标记放出，不做额外补查
    tagRecCustomSession.allowUnverified = true
    svc.retryPartitions()
    const temporary = tagRec(await svc.loadMore(signal()))
    expect(temporary.find((video) => video.bvid === unknown.bvid)?.combinationUnverified).toBe(true)
  })

  it('关闭 tag/top 池不再取该源；重开后同一 BV 只交付一次', async () => {
    settings.tagRec.filter.enabled = false
    const groupA = favorites.list[0]
    groupA.overrides = { poolsEnabled: { tagTop: false, allV2: false, allV2Related: false, archiveRelated: false } }
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'pool-bv', title: 'alpha', stat: { view: 1 } }])
    const closed = new TagRecCustomService()
    await closed.loadMore(signal())
    expect(fetchTagTop).not.toHaveBeenCalled()
    expect(tagRec(closed.qs.bufferQueue).some((video) => video.bvid === 'pool-bv')).toBe(false)

    groupA.overrides.poolsEnabled = { tagTop: true }
    const open = new TagRecCustomService()
    const out = tagRec(await open.loadMore(signal()))
    expect(out.filter((video) => video.bvid === 'pool-bv')).toHaveLength(1)
    expect(fetchTagTop).toHaveBeenCalledTimes(1)
  })

  it('组合 A→B→A：回到 A 时 A 的旧在途响应不复活', async () => {
    settings.tagRec.filter.enabled = false
    const comboA = newTagRecCombination()
    addTagRecCondition(comboA, tagRecConditionAtom('tag', { id: 11, name: '有马加奈' }))
    const comboB = newTagRecCombination()
    addTagRecCondition(comboB, tagRecConditionAtom('tag', { id: 22, name: '原神' }))
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof fetchTagTop>>>()
    vi.mocked(fetchTagTop).mockImplementation(() => deferred.promise)
    setWorking(comboA, { id: 11, name: '有马加奈' })
    const svcA = new TagRecCustomService()
    const pending = svcA.loadMore(signal())
    await vi.waitFor(() => expect(fetchTagTop).toHaveBeenCalledTimes(1))
    setWorking(comboB, { id: 22, name: '原神' })
    new TagRecCustomService()
    setWorking(comboA, { id: 11, name: '有马加奈' })
    const back = new TagRecCustomService()
    deferred.resolve([{ bvid: 'stale-a', title: '有马加奈', stat: { view: 1 } }])
    expect(tagRec(await pending).some((video) => video.bvid === 'stale-a')).toBe(false)
    expect(tagRec(back.qs.bufferQueue).some((video) => video.bvid === 'stale-a')).toBe(false)
    expect(fetchTagTop).toHaveBeenCalledTimes(1)
  })
})

describe('主题推荐用户旅程', () => {
  const tagRec = (items: RecItemTypeOrSeparator[] | undefined) =>
    (items ?? []).filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)

  it('tag/top 证据链在主题推荐同样成立：组合直接判命中，作用域重查仍命中', async () => {
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 1, name: 'alpha' }))
    favorites.list[0].combination = combination
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'fav-evidence', title: 'alpha', stat: { view: 1 } }])
    const svc = new TagRecFavService()
    const option = svc.getRecheckOptions().find((entry) => entry.pools.includes('tagTop'))
    expect(option).toBeDefined()
    const result = await svc.recheck(option!, signal())
    expect(result.added).toBeGreaterThan(0)
    const queued = tagRec(svc.qs.bufferQueue).find((video) => video.bvid === 'fav-evidence')
    expect(queued).toBeDefined()
    expect(queued!.source.tagIds).toContain(1)
    expect(queued!.source.claims?.some((claim) => claim.via === 'tag-top' && claim.tagIds?.includes(1))).toBe(true)
    expect(evalTagRecCombination(queued!, combination).state).toBe('match')

    const delivered = tagRec(await svc.loadMore(signal())).find((video) => video.bvid === 'fav-evidence')
    expect(delivered).toBeDefined()
    expect(evalTagRecCombination(delivered!, combination).state).toBe('match')
  })

  it('待核实不阻断已知内容；改条件后旧暂存重置', async () => {
    settings.tagRec.filter.enabled = false
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('title', 'alpha'))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '动画'))
    favorites.list[0].combination = combination
    const svc = new TagRecFavService()
    svc.hasMoreExceptQueue = false
    const known = item('fav-known', { description: '人物分析' })
    known.fieldEvidence = { desc: 'complete' }
    const unknown = item('fav-unknown')
    svc.qs.bufferQueue.push(unknown, known)

    expect(tagRec(await svc.loadMore(signal())).map((video) => video.bvid)).toEqual([known.bvid])
    expect(tagRecFavSession.partitionPending).toBe(1)
    expect(tagRecFavSession.partitionPaused).toBe(true)

    tagRecFavSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['alpha'] } } }
    expect(svc.autoLoadPaused).toBe(false)
    expect(tagRecFavSession.partitionPending).toBe(0)
  })

  it('主题 A→B→A：回到 A 时 A 的旧在途响应不复活', async () => {
    settings.tagRec.filter.enabled = false
    const groupA = favorites.list[0]
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof fetchTagTop>>>()
    vi.mocked(fetchTagTop).mockImplementation(() => deferred.promise)
    const svcA = new TagRecFavService()
    const pending = svcA.loadMore(signal())
    await vi.waitFor(() => expect(fetchTagTop).toHaveBeenCalledTimes(1))
    // 切到 B：停用 A，新增可抽组 B
    groupA.enabled = false
    favorites.list.push({
      id: 'B',
      name: 'B',
      l1Id: 'P',
      enabled: true,
      weight: 1,
      addedAt: 0,
      tag_ids: [{ id: 2, name: 'beta' }],
    })
    new TagRecFavService()
    // 切回 A：B 停用，A 恢复
    groupA.enabled = true
    favorites.list.find((group) => group.id === 'B')!.enabled = false
    const back = new TagRecFavService()
    deferred.resolve([{ bvid: 'fav-stale-a', title: 'alpha', stat: { view: 1 } }])
    expect(tagRec(await pending).some((video) => video.bvid === 'fav-stale-a')).toBe(false)
    expect(tagRec(back.qs.bufferQueue).some((video) => video.bvid === 'fav-stale-a')).toBe(false)
    expect(fetchTagTop).toHaveBeenCalledTimes(1)
  })
})
