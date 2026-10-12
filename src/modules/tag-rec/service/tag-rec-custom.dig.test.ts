import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { settings } from '$modules/settings'
import {
  fetchAllV2Search,
  fetchArchiveRelated,
  fetchTagInfoByName,
  fetchTagTop,
  fetchVideoTagNames,
} from '../api/endpoints'
import { addTagRecCondition, newTagRecCombination, tagRecConditionAtom } from '../model/combination'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { favorites, sediment, seen } from '../store'
import { beginTagRecCustomQuery, tagRecCustomSession, tagRecSharedSession } from '../store/session'
import { tagRecWorkbench } from '../store/workbench-state'
import { computeTagRecCustomFilterSignature, resetTagRecCustomSharedState, TagRecCustomService } from './tag-rec-custom'
import type { TagRecItemExtend } from '$define'
import type { AllV2VideoItem } from '../model/normalize-item'
import type { SedimentNode } from '../model/sediment'
import type { TagGroup } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// IO 边界 mock (同 fallback-ladder.test.ts 手法): endpoints/backoff/store/video-tags-store + UI/settings
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_CLS_TAB_BAR: 'x' }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(() => Promise.resolve([])),
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchArchiveRelated: vi.fn(() => Promise.resolve([])),
  fetchVideoTagNames: vi.fn(() => Promise.resolve(undefined)),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve()) }))
vi.mock('../api/backoff', () => ({
  tagRecBackoff: { isEngaged: false },
  isRiskControlError: (e: unknown) => e instanceof Error && e.name === 'RiskControlError',
}))
vi.mock('../store', async () => {
  // sediment.map = 原生 Map; 票 36: noteDig 走真写口委托 (水合读端经 map.get 原生可读)
  const { sedimentNoteDig } = await import('../model/sediment')
  const pool = new Map<string, SedimentNode>()
  return {
    sediment: {
      map: pool,
      merge: vi.fn(),
      confirm: vi.fn(),
      noteDig: vi.fn((norm: string, dig: { keyword: string; nextPage: number; exhausted?: boolean }) =>
        sedimentNoteDig(pool, norm, dig),
      ),
    },
    seen: new Set<string>(),
    favorites: { list: [] },
    favoritesStore: { list: [] },
    favoritesL1: { list: [] },
    favoritesL1Store: { list: [] },
  }
})
vi.mock(import('./negative-slice'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ensureTagRecNegativePools: vi.fn<typeof actual.ensureTagRecNegativePools>(() => Promise.resolve()),
    tagRecNegativePools: vi.fn<typeof actual.tagRecNegativePools>(() => new Map<number, ReadonlySet<string>>()),
    dropTagRecStrictNegativeHits: vi.fn<typeof actual.dropTagRecStrictNegativeHits>((items) =>
      Promise.resolve({ items, dropped: 0, unchecked: 0 }),
    ),
  }
})
vi.mock('../ui/tabbar-custom', () => ({ TagRecCustomTabbarView: () => null }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return { settings: { tagRec: { filter: createTagRecFactoryFilterCore(), diversityGuard: false, k: 3 } } }
})

const video = (bvid: string, tag?: string): AllV2VideoItem => ({ bvid, title: bvid, tag })

describe('$modules/tag-rec/service/tag-rec-custom digMore (票13 真机修复)', () => {
  beforeEach(() => {
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    sediment.map.clear()
    tagRecCustomSession.inputText = ''
    tagRecCustomSession.digPending = false
    tagRecCustomSession.digRunning = false
    tagRecCustomSession.hardBottom = false
    tagRecCustomSession.phase2 = { status: 'idle', pagesFetched: 0, exhausted: false, autoDigs: 0, lastDigYield: 0 }
    resetTagRecCustomSharedState() // 票 32: 模块级干态跨 service 存活, 用例间需清
  })

  it('纯组模式 (无锚点输入): 组簇深挖流在时 digMore 必须能挖 —— anchorEntry 不得拦死', async () => {
    const svc = new TagRecCustomService()
    // prepareStreams 登记的组簇流同款形状 (无输入锚点流, anchorEntry 恒 undefined)
    ;(svc as any).ladder.addStream({ key: 'g1', keyword: '组名', attribution: ['G'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'foo')])
    await svc.digMore()
    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalled()
  })

  it('手动挖穿流尽 (yield=0 且无 due 流) => hardBottom 收尾, 非静默消失', async () => {
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'g1', keyword: '组名', attribution: ['G'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([]) // 空页 => 流 exhausted
    await svc.digMore()
    expect(tagRecCustomSession.hardBottom).toBe(true)
    expect(tagRecCustomSession.digPending).toBe(false)
    expect(tagRecCustomSession.digRunning).toBe(false)
  })

  it('挖了没出货且流未尽 => digPending 待决回显', async () => {
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'g1', keyword: '组名', attribution: ['G'] })
    ;(svc as any).seenBvids.add('BV1') // 命中已见 => 净增 0
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'foo')])
    await svc.digMore()
    expect(tagRecCustomSession.hardBottom).toBe(false)
    expect(tagRecCustomSession.digPending).toBe(true)
  })

  it('审计 §5: 滚动续批 digMore(true) 走 auto 档扣自动配额; 手动 digMore() 不消耗', async () => {
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'g1', keyword: '组名', attribution: ['G'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'foo')])

    await svc.digMore(true) // 滚动触发的自动续批
    expect((svc as any).ladder.autoDigs).toBe(1) // 计入自动配额 (旧: 误走 manual, 恒 0)

    await svc.digMore() // 用户主动「继续深挖」=> manual 档不动自动配额
    expect((svc as any).ladder.autoDigs).toBe(1)
  })

  it('审计 §5: 自动纪律耗尽 (低产连停满限) => digMore(true) 停发转待决, 手动仍可挖', async () => {
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'g1', keyword: '组名', attribution: ['G'] })
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'foo')])
    ;(svc as any).ladder.lowYieldStreak = 2 // adaptive: 连续低产达 lowYieldStreakLimit

    const calls = vi.mocked(fetchAllV2Search).mock.calls.length
    await svc.digMore(true)
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBe(calls) // 自动档被拦, 零新增请求
    expect(tagRecCustomSession.digPending).toBe(true) // 转手动待决 (横幅等用户点)

    tagRecCustomSession.digPending = false
    await svc.digMore() // manual 档不受自动纪律限
    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBeGreaterThan(calls)
  })
})

const heapItem = (bvid: string): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: { view: 1e5 },
  source: { via: 'all-v2-related', groupNames: [] },
})

const resetCustomSession = () => {
  tagRecCustomSession.inputText = ''
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.selectedGroupIds = []
  tagRecCustomSession.draftGroup = undefined
  tagRecCustomSession.candidates = []
  tagRecCustomSession.digPending = false
  tagRecCustomSession.digRunning = false
  tagRecCustomSession.hardBottom = false
  tagRecCustomSession.softBottom = false
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.phase2 = { status: 'idle', pagesFetched: 0, exhausted: false, autoDigs: 0, lastDigYield: 0 }
  resetTagRecCustomSharedState() // 票 32: 模块级干态跨 service 存活, 用例间需清
}

describe('标签仅看保留原查询范围', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockReset().mockResolvedValue(undefined)
    sediment.map.clear()
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
    settings.tagRec.filter = { ...createTagRecFactoryFilterCore(), activePreset: '', presets: [] }
    settings.tagRec.filter.dims.tagAllow = { enabled: true, list: [{ id: 8, name: 'cosplay' }] }
    ;(favorites.list as TagGroup[]).push({
      id: 'doctor',
      name: '医生组',
      tag_ids: [{ id: 7, name: '医生' }],
      weight: 1,
      enabled: true,
      addedAt: 0,
    })
    tagRecCustomSession.selectedGroupIds = ['doctor']
  })

  it('旅游标题仅看上海/杭州后换电影，电影不再受城市词限制，长期屏蔽仍生效', async () => {
    tagRecCustomSession.selectedGroupIds = []
    settings.tagRec.filter.dims.tagAllow.enabled = false
    settings.tagRec.filter.dims.titleKeywords = { enabled: true, list: ['广告'] }
    const globalBefore = JSON.stringify(settings.tagRec.filter)
    vi.mocked(fetchTagInfoByName).mockImplementation((name) =>
      Promise.resolve({ id: name === '旅游' ? 7 : 8, name, use: 10 }),
    )
    vi.mocked(fetchAllV2Search).mockImplementation((keyword) =>
      Promise.resolve(
        keyword === '旅游'
          ? [video('travel-shanghai', '旅游'), video('travel-hiking', '旅游')].map((v, i) => ({
              ...v,
              title: i ? '徒步游记' : '上海旅行',
            }))
          : [video('movie-review', '电影'), video('movie-ad', '电影')].map((v, i) => ({
              ...v,
              title: i ? '电影广告' : '电影影评',
            })),
      ),
    )
    const loadBvids = async () => {
      const svc = new TagRecCustomService()
      const first = await svc.loadMore(new AbortController().signal)
      const second = await svc.loadMore(new AbortController().signal)
      return [...(first ?? []), ...(second ?? [])]
        .filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
        .map((item) => item.bvid)
    }

    beginTagRecCustomQuery('旅游')
    tagRecCustomSession.filterOverride = createTagRecFactoryFilterCore()
    tagRecCustomSession.filterOverride.dims.titleAllow = { enabled: true, list: ['上海', '杭州'] }
    tagRecCustomSession.filterOverride.dims.titleKeywords = { enabled: true, list: ['广告'] }
    expect(await loadBvids()).toEqual(['travel-shanghai'])

    beginTagRecCustomQuery('电影')
    expect(await loadBvids()).toEqual(['movie-review'])
    expect(tagRecCustomSession.anchor).toEqual({ id: 8, name: '电影' })
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(JSON.stringify(settings.tagRec.filter)).toBe(globalBefore)
  })

  it('医生池深挖后仅看 cosplay: 保留交集, 拒绝只有 cosplay 的搜索相关视频', async () => {
    vi.mocked(fetchAllV2Search).mockResolvedValue([
      video('doctor-only', '医生'),
      video('doctor-cosplay', '医生,cosplay'),
      video('cosplay-only', 'cosplay'),
    ])
    const svc = new TagRecCustomService()
    const first = await svc.loadMore(new AbortController().signal)
    const second = await svc.loadMore(new AbortController().signal)
    const bvids = [...(first ?? []), ...(second ?? [])]
      .filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
      .map((item) => item.bvid)
    expect(bvids).toEqual(['doctor-cosplay'])
    expect(fetchTagTop).toHaveBeenCalledWith(7, expect.anything())
    expect(vi.mocked(fetchTagTop).mock.calls.every(([id]) => id === 7)).toBe(true)
    expect(tagRecCustomSession.selectedGroupIds).toEqual(['doctor'])
    expect(tagRecCustomSession.expandedIds).toEqual([])
  })

  it.each([false, true])('直接输入医生, 仅看 cosplay (严格=%s) 不替换查询词', async (strict) => {
    tagRecCustomSession.selectedGroupIds = []
    tagRecCustomSession.inputText = '医生'
    settings.tagRec.filter.dims.tagAllow.strict = strict
    vi.mocked(fetchTagInfoByName).mockResolvedValue({ id: 7, name: '医生', use: 10 })
    vi.mocked(fetchAllV2Search).mockResolvedValue([
      video('doctor-only', '医生'),
      video('doctor-cosplay', '医生,cosplay'),
      video('cosplay-only', 'cosplay'),
    ])
    const svc = new TagRecCustomService()
    const first = await svc.loadMore(new AbortController().signal)
    const second = await svc.loadMore(new AbortController().signal)
    expect(
      [...(first ?? []), ...(second ?? [])]
        .filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
        .map((item) => item.bvid),
    ).toEqual(['doctor-cosplay'])
    expect(tagRecCustomSession.inputText).toBe('医生')
    expect(tagRecCustomSession.anchor).toEqual({ id: 7, name: '医生' })
    expect(tagRecCustomSession.expandedIds).toEqual([])
    expect(vi.mocked(fetchTagTop).mock.calls.every(([id]) => id === 7)).toBe(true)
  })

  it('刷新过滤会重查旧队列; 关闭仅看仍保留原来的相关补召回', () => {
    settings.tagRec.filter.dims.tagAllow.enabled = false
    const svc = new TagRecCustomService()
    const unrelated: TagRecItemExtend = { ...heapItem('cosplay-only'), ownTagNames: ['cosplay'] }
    const intersection: TagRecItemExtend = { ...heapItem('doctor-cosplay'), ownTagNames: ['医生', 'cosplay'] }
    svc.qs.bufferQueue.push(unrelated, intersection)
    const unfiltered = new TagRecCustomService()
    expect(unfiltered.qs.bufferQueue).toHaveLength(2)
    settings.tagRec.filter.dims.tagAllow.enabled = true
    const narrowed = new TagRecCustomService()
    expect(narrowed.qs.bufferQueue.map((item) => (item as TagRecItemExtend).bvid)).toEqual(['doctor-cosplay'])
  })

  it('原查询的显式扩选仍参与交集, 组内仅看也遵循原查询范围', () => {
    settings.tagRec.filter.dims.tagAllow.enabled = false
    const group = favorites.list[0] as TagGroup
    group.overrides = { negative: { tagAllow: { enabled: true, list: [{ id: 8, name: 'cosplay' }] } } }
    tagRecCustomSession.expandedIds = [{ id: 9, name: '护士' }]
    const svc = new TagRecCustomService()
    const source = { via: 'archive-related' as const, groupIds: ['doctor'], groupNames: ['医生·相关'] }
    svc.qs.bufferQueue.push(
      { ...heapItem('nurse-cosplay'), source, ownTagNames: ['护士', 'cosplay'] },
      { ...heapItem('cosplay-only'), source, ownTagNames: ['cosplay'] },
    )
    const refreshed = new TagRecCustomService()
    expect(refreshed.qs.bufferQueue.map((item) => (item as TagRecItemExtend).bvid)).toEqual(['nurse-cosplay'])
  })
})

describe('$modules/tag-rec/service/tag-rec-custom A4-1 被动漂移重钉', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockReset().mockResolvedValue(undefined)
    sediment.map.clear()
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
  })

  it('A4-3 filterSignature 构造期钉住不随轮重钉 —— 收紧型过滤编辑后钉点漂移供 drift 判定', () => {
    const svc = new TagRecCustomService()
    const pinned = svc.filterSignature
    // 会话层过滤覆盖变更 (strict 位) —— 生效链输入变 => 计算签名变, 钉点保持旧值
    tagRecCustomSession.draftGroup = { name: 'd', negative_tag_ids: [], strict: true }
    expect(svc.filterSignature).toBe(pinned)
    // drift checker 的输入对: pinned vs computeTagRecCustomFilterSignature() 现时值必须不同
    expect(svc.filterSignature).not.toBe(computeTagRecCustomFilterSignature())
  })

  it('无 emit 被动扩选后 fetchMore 重钉 contextSignature —— isSessionStale 不再永真楔死深挖链', async () => {
    const svc = new TagRecCustomService() // 空语境构造: 钉点为 ''
    expect(svc.contextSignature).toBe('')
    // 被动漂移 (chip ★/扩选直写 session, 不走 emit): 签名变但实例钉点仍旧
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'] })
    await svc.fetchMore(new AbortController().signal)
    // A4-1 回归: 钉点随共享态重置重钉; 旧实现恒 '' => isSessionStale 永真
    expect(svc.contextSignature).not.toBe('')
    // 深挖链不被 stale 门挡死: digMore 真发 all/v2 (旧楔死时 Promise.resolve(0) 直返)
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVd1', 'foo')])
    await svc.digMore()
    expect(fetchAllV2Search).toHaveBeenCalled()
  })
})

describe('$modules/tag-rec/service/tag-rec-custom 浅水位预挖 (票17 策略分家)', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockReset().mockResolvedValue(undefined)
    sediment.map.clear()
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
  })

  it('浅水位轮 (产出 1~9): 同轮顺手一发深挖 —— 只跑 digPass, 不选种不放兜底堆', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' }) // 查询单元 (无锚点走 expandedIds 路径)
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'] })
    ;(svc as any).ladder.heap.push(heapItem('stock')) // 兜底堆存货 —— 预挖不得提前放行
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVt1' }, { bvid: 'BVt2' }, { bvid: 'BVt3' }])
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVd1', 'foo'), video('BVd2')])

    const items = await svc.fetchMore(new AbortController().signal)
    expect(items?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['BVt1', 'BVt2', 'BVt3']) // 本轮只交主池产出
    // 票 perf-06: 浅水位 preDig 已后台化 —— fetchMore 不再押在 dig 批后, 断言前先等在途 digPass
    await (svc as any).ladder.digRunning
    expect(fetchAllV2Search).toHaveBeenCalled() // 本轮深挖真跑了一发
    // 票 37: 预播种流使流表非空 => 首载预热 (manual 档) 不点火, 浅水位 preDig 独占记 auto 档
    expect((svc as any).ladder.autoDigs).toBe(1)
    // exact => bufferQueue 下轮直放; related => 堆内留存 (旧存货不动)
    expect(svc.qs.bufferQueue.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['BVd1'])
    expect((svc as any).ladder.heap.map((x: TagRecItemExtend) => x.bvid)).toEqual(['stock', 'BVd2'])
    expect(fetchArchiveRelated).not.toHaveBeenCalled() // D2 related 选种不跑
    expect(fetchVideoTagNames).not.toHaveBeenCalled()
  })

  it('丰产轮 (产出 >=30): 不预挖 —— 阈值 triggerYield 守门', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    ;(svc as any).ladder.addStream({ key: 'foo', keyword: 'foo', attribution: ['foo'] })
    vi.mocked(fetchTagTop).mockResolvedValue(Array.from({ length: 32 }, (_, i) => ({ bvid: `BVt${i}` })))
    const items = await svc.fetchMore(new AbortController().signal)
    expect(items?.length).toBe(32)
    // 票 32: 首载预热 (manual 档) 仍会后台挖一发; 判据是 auto 档未被消耗 (preDig/自动深挖未跑)
    expect((svc as any).ladder.autoDigs).toBe(0)
  })

  it('组模式浅水位: 预挖 prepareStreams 前移补登记组簇流 (原 D7 干轮才补)', async () => {
    const svc = new TagRecCustomService()
    const group: TagGroup = {
      id: 'g1',
      name: '组G',
      tag_ids: [{ id: 7, name: 'foo' }],
      weight: 1,
      enabled: true,
      addedAt: 0,
    }
    ;(favorites.list as TagGroup[]).push(group)
    tagRecCustomSession.selectedGroupIds = ['g1']
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'BVt1' }, { bvid: 'BVt2' }]) // 产出 2 => 浅水位
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BVg1', 'foo')])
    const items = await svc.fetchMore(new AbortController().signal)
    expect(items?.length).toBe(2)
    // 票 perf-06: 浅水位 preDig 后台化 —— 等 warmup manual dig / preDig 在途 pass 落定再断言
    await (svc as any).ladder.digRunning
    // 组簇流干轮前就成立并被预挖消费 (流 key = 成员规范名 'foo', 归因组名)
    const stream = (svc as any).ladder.streams.get('foo')
    expect(stream).toBeTruthy()
    expect(stream.attribution).toEqual(['组G'])
    expect(fetchAllV2Search).toHaveBeenCalled()
    expect(svc.qs.bufferQueue.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['BVg1'])
    expect((svc.qs.bufferQueue[0] as TagRecItemExtend).source.groupNames).toEqual(['组G'])
  })

  it('干轮对照: 兜底堆存货仍照常放行 (梯队前段干轮专属的对偶侧)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.expandedIds.push({ id: 7, name: 'foo' })
    ;(svc as any).ladder.heap.push(heapItem('stock'))
    vi.mocked(fetchTagTop).mockResolvedValue([]) // 产出 0 => 干轮
    const items = await svc.fetchMore(new AbortController().signal)
    expect(items?.map((x) => (x as TagRecItemExtend).bvid)).toEqual(['stock']) // releasePage 真跑
    expect((svc as any).ladder.heap.length).toBe(0)
    // 堆有货放行后不再深挖；此前自动预热的已付轮次保留。
    expect((svc as any).ladder.autoDigs).toBe(1)
  })
})

/**
 * 小池真机回归 (kingexit 2026-10-06): 深链输入阶段注册的锚点流 (input:true) 在工作台切换后
 * 被同名组簇流就地合并 (ensureCliqueStreams 按 streamIdentity 撞车合并, 只并 attribution/groupIds)。
 * 原实现 tagRecConsumers 见 input:true 就只回输入消费者 —— 而工作台已无输入消费者,
 * plannedStream 作用域闸把它判成「不可挖」→ 深挖整链停摆: 搜索池 0 请求、10 条后硬见底。
 * 修后合并流同时服务输入与组消费者, 搜索照常开挖。
 */
describe('$modules/tag-rec/service/tag-rec-custom 小池: 深链输入→工作台切换后深挖链仍可用', () => {
  beforeEach(() => {
    vi.mocked(fetchTagTop).mockReset().mockResolvedValue([])
    vi.mocked(fetchAllV2Search).mockReset().mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockReset().mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockReset().mockResolvedValue(undefined)
    vi.mocked(fetchTagInfoByName).mockReset().mockResolvedValue(undefined)
    sediment.map.clear()
    seen.clear()
    tagRecCustomSession.bypassSeen = false
    tagRecSharedSession.recoveryRevision = 0
    ;(favorites.list as TagGroup[]).length = 0
    resetCustomSession()
  })

  it('同名簇流合并锚点流后: 搜索照常开挖, 小池不再 10 条卡死', async () => {
    // 小池: tag/top 只有 10 条; 搜索前 3 页有打标内容 (与真机 kingexit 同形)
    vi.mocked(fetchTagTop).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ bvid: `tt-${i}`, title: `kingexit ${i}` })),
    )
    vi.mocked(fetchAllV2Search).mockImplementation((_keyword, { page = 1 } = {}) =>
      Promise.resolve(
        page <= 3
          ? Array.from({ length: 20 }, (_, i) => ({
              bvid: `v2-p${page}-${i}`,
              title: `kingexit v2 ${page}-${i}`,
              tag: i < 10 ? 'kingexit,RPG' : 'RPG,剧情',
            }))
          : [],
      ),
    )
    vi.mocked(fetchTagInfoByName).mockResolvedValue({ id: 9975923, name: 'kingexit' })

    // 阶段 1: 深链输入路径 —— 注册锚点流 (key=kingexit, input: true)
    tagRecCustomSession.inputText = 'kingexit'
    const phase1 = new TagRecCustomService()
    const first = (await phase1.loadMore(new AbortController().signal)) ?? []
    expect(first.length).toBe(10)
    expect((phase1 as any).ladder.streams.get('kingexit')?.input).toBe(true)

    // 阶段 2: 工作台激活 (真机 synchronize: 清输入 + workingGroup 就位), 重建 service
    tagRecCustomSession.inputText = ''
    tagRecCustomSession.anchor = undefined
    tagRecCustomSession.draftGroup = undefined
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 9975923, name: 'kingexit' }))
    tagRecCustomSession.workingGroup = {
      id: '__tagrec_working__',
      name: 'kingexit',
      tag_ids: [{ id: 9975923, name: 'kingexit' }],
      enabled: true,
      weight: 1,
      addedAt: 0,
      combination,
    }
    vi.mocked(fetchAllV2Search).mockClear()
    const phase2 = new TagRecCustomService()
    const delivered = new Set<string>()
    for (let i = 0; i < 8; i++)
      for (const item of (await phase2.loadMore(new AbortController().signal)) ?? [])
        if (item.api === EApiType.TagRec && item.bvid) delivered.add(item.bvid)

    expect(vi.mocked(fetchAllV2Search).mock.calls.length).toBeGreaterThan(0) // 深挖链不再停摆
    expect([...delivered].some((bvid) => bvid.startsWith('v2-'))).toBe(true) // 搜索内容上屏
  })

  it('小池降级: 兜底堆里的「相关」条目放行上屏 (恢复工作台之前的带「相关」徽标交付)', async () => {
    vi.mocked(fetchTagTop).mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ bvid: `tt-${i}` })))
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 9975923, name: 'kingexit' }))
    tagRecCustomSession.workingGroup = {
      id: '__tagrec_working__',
      name: 'kingexit',
      tag_ids: [{ id: 9975923, name: 'kingexit' }],
      enabled: true,
      weight: 1,
      addedAt: 0,
      combination,
    }
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.heap.push(
      ...['rel-a', 'rel-b', 'rel-c'].map((bvid) => ({
        api: EApiType.TagRec,
        uniqId: `tag-rec:${bvid}`,
        bvid,
        title: bvid,
        pic: '',
        stat: { view: 1e5 },
        source: { via: 'all-v2-related', groupNames: ['kingexit·相关'] },
        ownTagNames: ['RPG'], // 已确认不含 kingexit => 组合 mismatch (兜底豁免的对象)
      })),
    )
    const delivered: string[] = []
    for (let i = 0; i < 8; i++)
      for (const item of (await svc.loadMore(new AbortController().signal)) ?? [])
        if (item.api === EApiType.TagRec && item.bvid) delivered.push(item.bvid)

    expect(delivered).toContain('rel-a') // 池浅降级 => 相关条放行 (徽标仍为「kingexit·相关」)
    expect(tagRecCustomSession.filterStats.degraded).toBe(true) // 降级灯在
  })

  it('切试验: 上一试验的兜底堆/候选/存货不漂到新试验 (相似条不再跨试验串味)', async () => {
    // 试验 A (山西): 兜底堆里已有它的「相似」条 (archive-related, 无名单 => 对新组合是 unknown)
    const combinationA = newTagRecCombination()
    addTagRecCondition(combinationA, tagRecConditionAtom('tag', { id: 166866, name: '山西' }))
    tagRecCustomSession.workingGroup = {
      id: '__tagrec_working__',
      name: '山西',
      tag_ids: [{ id: 166866, name: '山西' }],
      enabled: true,
      weight: 1,
      addedAt: 0,
      combination: combinationA,
    }
    tagRecWorkbench.activeId = 'trial-shanxi'
    const svcA = new TagRecCustomService()
    ;(svcA as any).ladder.heap.push({
      api: EApiType.TagRec,
      uniqId: 'tag-rec:BV-stale-food',
      bvid: 'BV-stale-food',
      title: '山西美食探店',
      pic: '',
      stat: { view: 1e6 },
      source: { via: 'archive-related', groupNames: ['山西·相关'] },
    })
    tagRecCustomSession.allowUnverified = true // 用户开着「暂时查看未核实内容」=> 堆里的 unknown 条会放行上屏

    // 切试验 B (kingexit): 组 id 恒 __tagrec_working__, 仅凭它分不开两个试验
    const combinationB = newTagRecCombination()
    addTagRecCondition(combinationB, tagRecConditionAtom('tag', { id: 3104344, name: 'kingexit' }))
    tagRecCustomSession.workingGroup = {
      id: '__tagrec_working__',
      name: 'kingexit',
      tag_ids: [{ id: 3104344, name: 'kingexit' }],
      enabled: true,
      weight: 1,
      addedAt: 0,
      combination: combinationB,
    }
    tagRecWorkbench.activeId = 'trial-kingexit'
    vi.mocked(fetchTagTop).mockResolvedValue([{ bvid: 'tt-kingexit' }])
    const svcB = new TagRecCustomService()
    const delivered: string[] = []
    for (let i = 0; i < 6; i++)
      for (const item of (await svcB.loadMore(new AbortController().signal)) ?? [])
        if (item.api === EApiType.TagRec && item.bvid) delivered.push(item.bvid)

    expect(delivered).toContain('tt-kingexit') // 新试验自己的池照常上屏
    expect(delivered).not.toContain('BV-stale-food') // 上一试验的相似条不漂过来
  })

  it('重新发掘: 复位已挖穿的深挖游标 (含持久沉淀冷却) 并重挖 —— 不再等 TTL/清空沉淀', async () => {
    const svc = new TagRecCustomService()
    ;(svc as any).ladder.addStream({ key: 'kingexit', keyword: 'kingexit', attribution: ['kingexit'] })
    const stream = (svc as any).ladder.streams.get('kingexit')
    stream.nextPage = 12
    stream.exhausted = true
    stream.stopReason = 'empty'
    stream.retryAt = Date.now() + 3_600_000
    // 上次会话挖穿留下的持久游标 (冷却中): 原实现要等 TTL 或去设置里清空沉淀
    sediment.map.set('kingexit', {
      variants: [],
      cooccur: {},
      lastSeen: Date.now(),
      dig: { keyword: 'kingexit', nextPage: 12, exhausted: true, lastAt: Date.now(), retryAt: Date.now() + 3_600_000 },
    } as unknown as SedimentNode)
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV-redig', 'kingexit')])

    await svc.redigQuery()
    await (svc as any).ladder.digRunning

    expect(vi.mocked(fetchAllV2Search)).toHaveBeenCalled() // 重挖点火
    expect(stream.exhausted).toBe(false)
    expect(stream.nextPage).toBeGreaterThan(1) // 已按新游标挖到下一页
    expect(sediment.map.get('kingexit')?.dig?.exhausted).not.toBe(true) // 持久冷却已解除
  })
})
