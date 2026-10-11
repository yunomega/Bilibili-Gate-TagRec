import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { settings } from '$modules/settings'
import {
  addTagRecCondition,
  newTagRecCombination,
  tagRecConditionAtom,
  type TagRecCombination,
} from '../model/combination'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { favorites, favoritesL1 } from '../store'
import { tagRecCustomSession, tagRecSharedSession } from '../store/session'
import { tagRecWorkbench } from '../store/workbench-state'
import { tagRecPartitionHeldNext, tagRecPartitionWorkQueue } from './partition-slice'
import {
  resetTagRecCustomSharedState,
  TagRecCustomService,
  tagRecCustomSharedBufferQueue,
  tagRecCustomSharedRemovedAtoms,
  tagRecDeliveryReplayKey,
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

describe('票 004 旧语境存货降权', () => {
  const claimed = (bvid: string, via: TagRecItemExtend['source']['via'], tagIds: number[]): TagRecItemExtend => ({
    api: EApiType.TagRec,
    uniqId: `tag-rec:${bvid}`,
    bvid,
    title: bvid,
    pic: '',
    stat: {},
    source: { via, groupNames: ['试验A'], tagIds },
  })

  it('同试验删原子: 被删原子记入 removedAtoms (切试验不记)', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
    ])
    new TagRecCustomService()
    // 同试验编辑配方: 删清宵(1) 只留心月狐(2)
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    new TagRecCustomService()
    const removed = tagRecCustomSharedRemovedAtoms()
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ field: 'tag', value: { id: 1 } })
    // 切试验: removed 清空 (换语境不是删条件)
    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 9, name: '原神' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedRemovedAtoms()).toHaveLength(0)
  })

  it('连续删原子: 被删原子累计记账 —— 删 X 再删 Y 时 X 残留不解封 (审计)', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
      { id: 3, name: '星野' },
    ])
    new TagRecCustomService()
    // 删清宵(1) → removed={1}; 再删心月狐(2) → removed 应为 {1,2} 而非 {2}
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 2, name: '心月狐' },
      { id: 3, name: '星野' },
    ])
    new TagRecCustomService()
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 3, name: '星野' }])
    new TagRecCustomService()
    expect(
      tagRecCustomSharedRemovedAtoms()
        .map((a) => (a.field === 'tag' ? a.value.id : -1))
        .sort(),
    ).toEqual([1, 2])
    // 被删原子重新加回 => 从账本摘帽
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 3, name: '星野' },
    ])
    new TagRecCustomService()
    expect(tagRecCustomSharedRemovedAtoms().map((a) => (a.field === 'tag' ? a.value.id : -1))).toEqual([2])
  })

  it('删原子后: 只归因于被删原子的存货留在队尾不上屏, 命中当前原子的照常交付', async () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
    ])
    new TagRecCustomService()
    // 残留条: 相关池归因 (claims 的 via 不是 tag-top → 新配方下判 unknown 留队)
    tagRecCustomSharedBufferQueue().push(
      claimed('BV-residue', 'all-v2-related', [1]),
      claimed('BV-current', 'tag-top', [2]),
    )
    // 同试验删清宵 → 残留条只归因于 tag:1 → 旧语境
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    const edited = new TagRecCustomService()
    const out = await edited.loadMore(new AbortController().signal)
    const bvids = (out ?? []).flatMap((it) => (it.api === EApiType.TagRec && it.bvid ? [it.bvid] : []))
    expect(bvids).toEqual(['BV-current'])
    // 降权不是丢弃: 残留条还在队列里 (只作兜底)
    expect(tagRecCustomSharedBufferQueue().map((it) => (it as TagRecItemExtend).bvid)).toContain('BV-residue')
  })

  it('审计回填: all-v2 召回残留 (claims 只带词名无 tagIds) 按被删原子名归 stale —— 否则与 tagIds 剥除同型漏网', async () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
    ])
    new TagRecCustomService()
    const keywordClaimed: TagRecItemExtend = {
      api: EApiType.TagRec,
      uniqId: 'tag-rec:BV-kw',
      bvid: 'BV-kw',
      title: 'BV-kw',
      pic: '',
      stat: {},
      source: {
        via: 'all-v2-related',
        groupNames: ['试验A'],
        claims: [{ via: 'all-v2-related', groupNames: ['试验A'], queryKeyword: '清宵' }],
      },
    }
    tagRecCustomSharedBufferQueue().push(keywordClaimed, claimed('BV-current', 'tag-top', [2]))
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    const edited = new TagRecCustomService()
    const out = await edited.loadMore(new AbortController().signal)
    const bvids = (out ?? []).flatMap((it) => (it.api === EApiType.TagRec && it.bvid ? [it.bvid] : []))
    expect(bvids).toEqual(['BV-current'])
    expect(tagRecCustomSharedBufferQueue().map((it) => (it as TagRecItemExtend).bvid)).toContain('BV-kw')
  })

  it('审计回填: 删 UP 原子后 up-search 召回残留按词名归 stale —— 非 tag 原子残留不再结构性漏网', async () => {
    tagRecWorkbench.activeId = 'trial-a'
    const upGroup = (name: string): TagGroup => {
      const combination: TagRecCombination = newTagRecCombination()
      addTagRecCondition(combination, tagRecConditionAtom('up', { name: '某UP' }))
      addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 2, name: '心月狐' }))
      return { id: '__tagrec_working__', name, enabled: true, weight: 1, addedAt: 0, tag_ids: [], combination }
    }
    tagRecCustomSession.workingGroup = upGroup('试验A')
    new TagRecCustomService()
    const upClaimed: TagRecItemExtend = {
      api: EApiType.TagRec,
      uniqId: 'tag-rec:BV-up',
      bvid: 'BV-up',
      title: 'BV-up',
      pic: '',
      stat: {},
      source: {
        via: 'up-search',
        groupNames: ['试验A'],
        queryKeyword: '某UP',
        claims: [{ via: 'up-search', groupNames: ['试验A'], queryKeyword: '某UP' }],
      },
    }
    tagRecCustomSharedBufferQueue().push(upClaimed, claimed('BV-current', 'tag-top', [2]))
    // 删 UP 原子只留 tag
    const tagOnly = newTagRecCombination()
    addTagRecCondition(tagOnly, tagRecConditionAtom('tag', { id: 2, name: '心月狐' }))
    tagRecCustomSession.workingGroup = {
      ...upGroup('试验A'),
      combination: tagOnly,
    }
    const edited = new TagRecCustomService()
    expect(tagRecCustomSharedRemovedAtoms().some((a) => a.field === 'up')).toBe(true)
    const out = await edited.loadMore(new AbortController().signal)
    const bvids = (out ?? []).flatMap((it) => (it.api === EApiType.TagRec && it.bvid ? [it.bvid] : []))
    expect(bvids).toEqual(['BV-current'])
    expect(tagRecCustomSharedBufferQueue().map((it) => (it as TagRecItemExtend).bvid)).toContain('BV-up')
  })

  it('审计回填: 全 stale 队列 + 外部源尽 => hasMore=false 停 footer 空转; 落一条活货即复活', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
    ])
    new TagRecCustomService()
    tagRecCustomSharedBufferQueue().push(claimed('BV-stale', 'all-v2-related', [1]))
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    const edited = new TagRecCustomService()
    edited.hasMoreExceptQueue = false
    expect(edited.hasMore).toBe(false)
    // 活货落队 (写版本 bump => 记忆化扫描重算) => hasMore 复活
    tagRecCustomSharedBufferQueue().push(claimed('BV-fresh', 'tag-top', [2]))
    expect(edited.hasMore).toBe(true)
  })

  it('审计回填: 删原子账本随试验暂存往返 —— A删→切B→切回A 残留标记不丢 (D2)', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [
      { id: 1, name: '清宵' },
      { id: 2, name: '心月狐' },
    ])
    new TagRecCustomService()
    // 同试验删清宵 → removed={1}
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedRemovedAtoms()).toHaveLength(1)
    // 切到 B: A 暂存 (含账本); B 账本清零
    tagRecWorkbench.activeId = 'trial-b'
    tagRecCustomSession.workingGroup = workingGroup('试验B', [{ id: 9, name: '原神' }])
    new TagRecCustomService()
    expect(tagRecCustomSharedRemovedAtoms()).toHaveLength(0)
    // 切回 A (仍是删后配方): 暂存恢复 => 账本回到 {1}, 残留条仍按 stale 处理
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 2, name: '心月狐' }])
    new TagRecCustomService()
    const restored = tagRecCustomSharedRemovedAtoms()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ field: 'tag', value: { id: 1 } })
  })
})

const workItem = (bvid: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: [] },
})

describe('票 004 workQueue 兜底语义', () => {
  it('旧语境条不参与取条也不进兜底 —— 否则鲜货空窗 (删原子后的首屏) 仍被残留占满 (真机回归)', () => {
    const stale = workItem('BV-old')
    const fresh = workItem('BV-new')
    const isStale = (it: TagRecItemExtend) => it.bvid === 'BV-old'
    const working = tagRecPartitionWorkQueue([stale, fresh], new Set(), isStale)
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-new'])
    // 全是旧语境 => 兜底返回空; 队列本体仍留条 (证据补齐翻 match 时自愈), 只是不再上屏
    const fallback = tagRecPartitionWorkQueue([stale], new Set(), isStale)
    expect(fallback).toEqual([])
  })

  it('isStale 缺省: 兜底语义与旧签名一致 (fav 侧全量兜底)', () => {
    const working = tagRecPartitionWorkQueue([workItem('BV-a')], new Set(['BV-a']))
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-a'])
  })

  it('isStale 缺省: 与旧签名行为一致 (held 语义不变)', () => {
    const working = tagRecPartitionWorkQueue([workItem('BV-a'), workItem('BV-b')], new Set(['BV-a']))
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-b'])
  })
})

describe('票 005 停牌条目轮转与放弃', () => {
  it('轮转: 停牌条随新货补位重试 (不只在队列空时), 且排在新货之后', () => {
    const held = new Map([['BV-held', 1]])
    const working = tagRecPartitionWorkQueue([workItem('BV-held'), workItem('BV-new')], held, undefined, 4)
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-new', 'BV-held'])
  })

  it('quota=0 与旧语义一致: 停牌条只在新货耗尽时出现', () => {
    const held = new Map([['BV-held', 1]])
    expect(
      tagRecPartitionWorkQueue([workItem('BV-held'), workItem('BV-new')], held).map(
        (it) => (it as TagRecItemExtend).bvid,
      ),
    ).toEqual(['BV-new'])
    expect(tagRecPartitionWorkQueue([workItem('BV-held')], held).map((it) => (it as TagRecItemExtend).bvid)).toEqual([
      'BV-held',
    ])
  })

  it('quota 截断: 轮转条数不超上限', () => {
    const held = new Map([
      ['BV-h1', 1],
      ['BV-h2', 1],
      ['BV-h3', 1],
    ])
    const working = tagRecPartitionWorkQueue(
      [workItem('BV-h1'), workItem('BV-h2'), workItem('BV-h3'), workItem('BV-new')],
      held,
      undefined,
      2,
    )
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-new', 'BV-h1', 'BV-h2'])
  })

  it('到上限不轮转 (评审#1): canRetryHeld=false 的停牌条不进取条分区、不吃补查额度', () => {
    const held = new Map([
      ['BV-capped', 3], // 已到上限
      ['BV-held', 1],
    ])
    const working = tagRecPartitionWorkQueue(
      [workItem('BV-capped'), workItem('BV-held'), workItem('BV-new')],
      held,
      undefined,
      4,
      (bvid) => (held.get(bvid) ?? 0) < 3, // 与 custom 同款谓词
    )
    // 封顶条被留在账目里等自愈, 只轮转还有资格的
    expect(working.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-new', 'BV-held'])
    // 只剩封顶条 => 兜底**不**再带上它们 (审计: 「放弃」后每次「重试核实」都白烧一轮);
    //   可重试的兜底仍放行, 封顶的被排掉 —— 复活走「重试核实」尝试归零或缓存自愈
    const fallback = tagRecPartitionWorkQueue(
      [workItem('BV-capped'), workItem('BV-held')],
      held,
      undefined,
      4,
      (bvid) => (held.get(bvid) ?? 0) < 3,
    )
    expect(fallback.map((it) => (it as TagRecItemExtend).bvid)).toEqual(['BV-held'])
    expect(
      tagRecPartitionWorkQueue([workItem('BV-capped')], held, undefined, 4, (bvid) => (held.get(bvid) ?? 0) < 3),
    ).toEqual([])
    // canRetryHeld 缺省 (fav 侧无尝试账): 兜底旧语义全量放行
    expect(tagRecPartitionWorkQueue([workItem('BV-capped')], held).map((it) => (it as TagRecItemExtend).bvid)).toEqual([
      'BV-capped',
    ])
  })

  it('账目推进: 只给真查过的 +1 (闸挡不计), 封顶钳在上限, 离队列清账', () => {
    const prev = new Map([
      ['BV-a', 1],
      ['BV-b', 2],
      ['BV-gate', 1], // 本轮被暂停但根本没查 (闸挡)
      ['BV-gone', 5],
    ])
    const next = tagRecPartitionHeldNext(
      prev,
      [workItem('BV-a'), workItem('BV-b'), workItem('BV-gate'), workItem('BV-new')],
      new Set(['BV-a', 'BV-b', 'BV-gate', 'BV-new']),
      3,
      new Set(['BV-a', 'BV-b', 'BV-new']), // attempted: gate 不在其中
    )
    expect(next.get('BV-a')).toBe(2)
    expect(next.get('BV-b')).toBe(3) // 恰好到上限
    expect(next.get('BV-new')).toBe(1)
    expect(next.get('BV-gate')).toBe(1) // 闸挡根本没查 => 不计尝试
    expect(next.has('BV-gone')).toBe(false) // 已不在队列 => 清账
    // 再过一轮 (又真查又重挂): 封顶钳在上限不再涨
    const second = tagRecPartitionHeldNext(next, [workItem('BV-b')], new Set(['BV-b']), 3, new Set(['BV-b']))
    expect(second.get('BV-b')).toBe(3)
    // 「重试核实」归零语义由 retryPartitions 侧完成 (尝试数清 0 => 放弃计数归零)
  })
})

describe('审计: 回放键语境隔离', () => {
  it('非工作台语境随选组分键 —— 原实现退化成 [null,null,null] 全语境串池', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = undefined
    tagRecCustomSession.selectedGroupIds = ['g-a']
    const keyA = tagRecDeliveryReplayKey()
    tagRecCustomSession.selectedGroupIds = ['g-b']
    const keyB = tagRecDeliveryReplayKey()
    expect(keyA).not.toBe('')
    expect(keyB).not.toBe('')
    expect(keyA).not.toBe(keyB)
  })

  it('「显示已看」开关不换键; 「清空已看」换代际换键', () => {
    tagRecWorkbench.activeId = 'trial-a'
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    const before = tagRecDeliveryReplayKey()
    tagRecCustomSession.bypassSeen = false
    expect(tagRecDeliveryReplayKey()).toBe(before)
    tagRecCustomSession.bypassSeen = true
    try {
      tagRecSharedSession.recoveryRevision++
      expect(tagRecDeliveryReplayKey()).not.toBe(before)
    } finally {
      tagRecSharedSession.recoveryRevision--
    }
  })

  it('同组合跨试验不串池 (试验身份在键里)', () => {
    tagRecCustomSession.workingGroup = workingGroup('试验A', [{ id: 1, name: '清宵' }])
    tagRecWorkbench.activeId = 'trial-a'
    const keyA = tagRecDeliveryReplayKey()
    tagRecWorkbench.activeId = 'trial-b'
    expect(tagRecDeliveryReplayKey()).not.toBe(keyA)
  })
})
