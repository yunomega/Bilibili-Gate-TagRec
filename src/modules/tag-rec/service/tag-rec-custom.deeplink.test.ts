import { describe, expect, it, vi } from 'vitest'
import {
  fetchAllV2Search,
  fetchArchiveRelated,
  fetchTagInfoByName,
  fetchTagTop,
  fetchVideoTagNames,
} from '../api/endpoints'
import { tagRecCustomSession } from '../store/session'
import { resetTagRecCustomSharedState, TagRecCustomService } from './tag-rec-custom'
import type { SedimentNode } from '../model/sediment'

vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// IO 边界 mock (同 tag-rec-custom.dig.test.ts 手法)
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
// 深链消费惰性加载的工作台模块 (生产路径 `await import('../store/workbench')`)
const activate = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const seed = vi.hoisted(() => vi.fn(() => true))
vi.mock('../store/workbench', () => ({ activateTagRecWorkbench: activate, seedTagRecNewTrialWithTag: seed }))
// workbench-state 模块级 GM 水合 (与本文件断言无关, 垫住防 unhandled 噪音)
vi.hoisted(() => {
  vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve(undefined)), setValue: vi.fn() })
})

describe('$modules/tag-rec/service/tag-rec-custom 深链消费 (consumeTagRecDeepLink)', () => {
  // tagRecDeepLinkConsumed 是模块级 latch —— 本文件首个 service 构造即消费, 用例只有这一条
  it('tag-rec-new+tag-rec-id => 激活后落成新试验组合, 不走直输, 参数全清', async () => {
    vi.mocked(fetchAllV2Search).mockResolvedValue([])
    vi.mocked(fetchTagTop).mockResolvedValue([])
    vi.mocked(fetchArchiveRelated).mockResolvedValue([])
    vi.mocked(fetchVideoTagNames).mockResolvedValue(undefined)
    vi.mocked(fetchTagInfoByName).mockResolvedValue(undefined)
    tagRecCustomSession.inputText = ''
    tagRecCustomSession.digPending = false
    resetTagRecCustomSharedState()

    const href = 'https://www.bilibili.com/?gate-tab=tag-rec-custom&tag-rec-new=%E5%8E%9F%E7%A5%9E&tag-rec-id=9975923'
    const loc = { href, search: new URL(href).search }
    // 消费循环逐参 `new URL(location.href)` 后 replaceState —— 真实浏览器里 replaceState 会更新 location, 桩须同步
    const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
      loc.href = url
      loc.search = new URL(url).search
    })
    vi.stubGlobal('location', loc)
    vi.stubGlobal('history', { replaceState })
    try {
      new TagRecCustomService()
      await vi.waitFor(() => expect(seed).toHaveBeenCalled())
      expect(activate).toHaveBeenCalledTimes(1)
      expect(seed).toHaveBeenCalledWith({ id: 9975923, name: '原神' })
      // 直输管线未触发: inputText 保持空 (beginTagRecCustomQuery 会写入)
      expect(tagRecCustomSession.inputText).toBe('')
      // 4 个二级参逐参 replaceState 清除; 最终只剩 gate-tab
      expect(loc.search).toBe('?gate-tab=tag-rec-custom')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
