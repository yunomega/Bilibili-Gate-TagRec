import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCandidateRows, type CandidateRow } from '../model/resolve'
import { tagRecCustomSession } from '../store/session'
import { resetTagRecCustomSharedState, TagRecCustomService } from './tag-rec-custom'

import type { TagGroup, TagIdEntry } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

/**
 * [tag-rec] UIUX-U1-10 回归: resolveCandidateInBackground (勾选即后台预解析) 顶层失败
 * 不再静默吞 —— 对应候选行打 resolveFailed=true (复用红徽通道) 且 resolving 落位, 可再勾重试
 */

// IO 边界 mock (同 tag-rec-custom.save.test.ts 手法): endpoints/backoff/store/video-tags-store + UI/settings
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
  const { dedupeTagIdEntries, makeTagGroup } = await import('../model/favorites')
  const list: TagGroup[] = []
  return {
    sediment: { map: new Map(), merge: vi.fn(), confirm: vi.fn() },
    seen: new Set<string>(),
    favorites: {
      get list() {
        return list
      },
      addGroup: vi.fn((input: Parameters<typeof makeTagGroup>[0]) => {
        const group = makeTagGroup(input)
        return group && { group, l1: { id: 'l1-auto', name: group.name, enabled: false, weight: 1, addedAt: 0 } }
      }),
      addTagIdsToGroup: vi.fn((groupId: string, entries: readonly TagIdEntry[]) => {
        const res = { added: 0, skipped: 0, moved: 0, alsoIn: [] as string[] }
        const g = list.find((x) => x.id === groupId)
        if (!g) return res
        const inGroup = new Set(g.tag_ids.map((e) => e.id))
        for (const e of dedupeTagIdEntries(entries)) {
          if (inGroup.has(e.id)) {
            res.skipped++
            continue
          }
          const ni = (g.negative_tag_ids ?? []).findIndex((n) => n.id === e.id)
          if (ni !== -1) {
            g.negative_tag_ids!.splice(ni, 1)
            res.moved++
          }
          const hit = list.find((x) => x.tag_ids.some((t) => t.id === e.id))
          if (hit) res.alsoIn.push(hit.name)
          g.tag_ids.push({ ...e })
          inGroup.add(e.id)
          res.added++
        }
        return res
      }),
    },
    favoritesStore: { list },
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
// 顶层解析通道单独接管 —— 其余 model/resolve 导出保持真实现
vi.mock('../model/resolve', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>()
  return { ...mod, resolveCandidateRows: vi.fn((rows: readonly CandidateRow[]) => Promise.resolve([...rows])) }
})

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const pendingRow = (key: string): CandidateRow => ({ key, tag_name: `tag-${key}`, badge: 'cooccur', checked: true })

describe('resolveCandidateInBackground — UIUX-U1-10: 顶层失败打 resolveFailed 红徽', () => {
  beforeEach(() => {
    vi.mocked(resolveCandidateRows).mockClear()
    tagRecCustomSession.candidates = []
    tagRecCustomSession.draftGroup = undefined
    tagRecCustomSession.expandedIds = []
    tagRecCustomSession.selectedGroupIds = []
    tagRecCustomSession.anchor = undefined
    tagRecCustomSession.candidatesCollapsed = true
    resetTagRecCustomSharedState()
  })

  it('resolveCandidateRows reject => 该行 resolveFailed=true + resolving 落位 (原静默吞, 徽标永不亮)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.candidates = [pendingRow('k1')]
    vi.mocked(resolveCandidateRows).mockRejectedValueOnce(new Error('风控/网络顶层异常'))

    svc.resolveCandidateInBackground('k1')
    expect(tagRecCustomSession.candidates[0].resolving).toBe(true)

    await flush()
    const live = tagRecCustomSession.candidates[0]
    expect(live.resolving).toBe(false)
    expect(live.resolveFailed).toBe(true)
    expect(live.tag_id).toBeUndefined() // 未解析态保留, 再勾可重试
  })

  it('成功路径不受影响: 回填 tag_id/use + resolveFailed=false', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.candidates = [pendingRow('k1')]
    vi.mocked(resolveCandidateRows).mockResolvedValueOnce([
      { key: 'k1', tag_name: '官方名', tag_id: 42, badge: 'exact', checked: true, use: 7, resolveFailed: false },
    ])

    svc.resolveCandidateInBackground('k1')
    await flush()
    const live = tagRecCustomSession.candidates[0]
    expect(live).toMatchObject({ tag_id: 42, tag_name: '官方名', use: 7, resolveFailed: false, resolving: false })
  })

  it('已解析行/在途行不重入 (护栏原样)', () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.candidates = [
      { key: 'k1', tag_name: 'x', tag_id: 1, badge: 'exact', checked: true },
      { key: 'k2', tag_name: 'y', badge: 'cooccur', checked: true, resolving: true },
    ]
    svc.resolveCandidateInBackground('k1')
    svc.resolveCandidateInBackground('k2')
    expect(resolveCandidateRows).not.toHaveBeenCalled()
  })
})
