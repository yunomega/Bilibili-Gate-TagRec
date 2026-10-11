import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTagGroup } from '../model/favorites'
import { favorites } from '../store'
import {
  beginTagRecCustomQuery,
  removeExpandedId,
  switchTagRecGroupContext,
  tagRecCustomSession,
} from '../store/session'
import { resetTagRecCustomSharedState, TagRecCustomService } from './tag-rec-custom'
import type { CandidateRow } from '../model/resolve'
import type { TagGroup, TagIdEntry } from '../model/types'
vi.mock('../store/combination-blocks', () => ({ tagRecCombinationBlocks: { list: [] } }))

// IO 边界 mock (同 tag-rec-custom.dig.test.ts 手法): endpoints/backoff/store/video-tags-store + UI/settings
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
  // addGroup/addTagIdsToGroup 走真纯逻辑语义: 组内正负互斥/去重全真, 仅隔离持久层
  const { dedupeTagIdEntries, makeTagGroup } = await import('../model/favorites')
  const list: TagGroup[] = []
  return {
    sediment: { map: new Map(), merge: vi.fn(), confirm: vi.fn() },
    seen: new Set<string>(),
    favorites: {
      get list() {
        return list
      },
      // 票 17 签名 = {group,l1} | undefined; 持久层被 mock => l1 给桩对象
      addGroup: vi.fn((input: Parameters<typeof makeTagGroup>[0]) => {
        const group = makeTagGroup(input)
        return group && { group, l1: { id: 'l1-auto', name: group.name, enabled: false, weight: 1, addedAt: 0 } }
      }),
      // 票 22 并入路径依赖门面全真语义: 组内已有 skipped / 撞负向转正向 moved / 他组命中 alsoIn
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

const row = (tag_id: number, checked = true): CandidateRow => ({
  key: `id:${tag_id}`,
  tag_name: `tag${tag_id}`,
  tag_id,
  badge: 'exact',
  checked,
})

const addGroupMock = () => vi.mocked(favorites.addGroup)
const addTagIdsMock = () => vi.mocked(favorites.addTagIdsToGroup)

describe('$modules/tag-rec/service/tag-rec-custom saveAsFavoriteGroup (票 20/22 expandedIds 暂存层固化)', () => {
  beforeEach(() => {
    beginTagRecCustomQuery('')
    addGroupMock().mockClear()
    addTagIdsMock().mockClear()
    ;(favorites.list as TagGroup[]).length = 0
    tagRecCustomSession.candidates = []
    tagRecCustomSession.draftGroup = undefined
    tagRecCustomSession.expandedIds = []
    tagRecCustomSession.selectedGroupIds = []
    tagRecCustomSession.anchor = undefined
    tagRecCustomSession.candidatesCollapsed = true
    resetTagRecCustomSharedState() // 票 32: 模块级干态跨 service 存活, 用例间需清
  })

  it('勾选行 tag_ids ∪ expandedIds 并入新组 (按 id 去重, 候选行优先保序); 草稿负向随组入表仍过滤正向撞车', async () => {
    const svc = new TagRecCustomService()
    // 「入临时组」(弹层★②草稿组档) 写进的扩选: 5=新并入, 1=与勾选行撞 id, 9=与负向撞车
    tagRecCustomSession.draftGroup = {
      name: 'd',
      negative_tag_ids: [
        { id: 8, name: 'neg8' },
        { id: 9, name: 'neg-collide' },
      ],
      strict: true,
    }
    tagRecCustomSession.expandedIds = [
      { id: 5, name: 'exp5' },
      { id: 1, name: 'dup-of-row1' },
      { id: 9, name: 'exp-collide-neg' },
    ]
    await svc.saveAsFavoriteGroup([row(1), row(2), row(3, false)]) // row3 未勾选不进组

    expect(addGroupMock()).toHaveBeenCalledTimes(1)
    const input = addGroupMock().mock.calls[0][0]
    expect(input.name).toBe('tag1')
    // 候选行 {1,2} 优先, expandedIds 增量 {5,9} 追加 (id:1 撞行去重)
    expect(input.tag_ids).toEqual([
      { id: 1, name: 'tag1' },
      { id: 2, name: 'tag2' },
      { id: 5, name: 'exp5' },
      { id: 9, name: 'exp-collide-neg' },
    ])
    expect(input.negative_tag_ids).toEqual([
      { id: 8, name: 'neg8' },
      { id: 9, name: 'neg-collide' },
    ])
    // 返回组: 负向 9 与正向撞车被 makeTagGroup 剔除 (组内互斥正向优先); 票 17 返回 {group,l1}
    const group = addGroupMock().mock.results[0].value!.group
    expect(group.tag_ids.map((e: { id: number }) => e.id)).toEqual([1, 2, 5, 9])
    expect(group.negative_tag_ids).toEqual([{ id: 8, name: 'neg8' }])
    expect(group.negative_strict).toBe(true)
  })

  it('无 expandedIds/草稿组 => tag_ids = 勾选行解析 id (回归原语义)', async () => {
    const svc = new TagRecCustomService()
    await svc.saveAsFavoriteGroup([row(1), row(2)])
    const input = addGroupMock().mock.calls[0][0]
    expect(input.tag_ids).toEqual([
      { id: 1, name: 'tag1' },
      { id: 2, name: 'tag2' },
    ])
    expect(input.negative_tag_ids).toBeUndefined()
  })

  it('零勾选 => 不建组', async () => {
    const svc = new TagRecCustomService()
    await svc.saveAsFavoriteGroup([row(1, false)])
    expect(addGroupMock()).not.toHaveBeenCalled()
  })

  it('实机回归: 草稿语境零勾选零暂存但有锚点 => 锚点并入首成员建组 (纯数字直输场景)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.draftGroup = { name: '奥特曼', negative_tag_ids: [], strict: false }
    tagRecCustomSession.anchor = { id: 963, name: '奥特曼' }
    await svc.saveAsFavoriteGroup([])
    expect(addGroupMock()).toHaveBeenCalledTimes(1)
    const input = addGroupMock().mock.calls[0][0]
    expect(input.name).toBe('奥特曼')
    expect(input.tag_ids).toEqual([{ id: 963, name: '奥特曼' }])
  })

  it('实机回归: 草稿语境锚点+扩选零勾选 => 锚点与暂存一并固化并入新组, 存后清暂存位', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.draftGroup = { name: 'd', negative_tag_ids: [], strict: false }
    tagRecCustomSession.anchor = { id: 963, name: '奥特曼' }
    tagRecCustomSession.expandedIds = [{ id: 7, name: 'exp7' }]
    await svc.saveAsFavoriteGroup([])
    const input = addGroupMock().mock.calls[0][0]
    expect(input.tag_ids).toEqual([
      { id: 963, name: '奥特曼' },
      { id: 7, name: 'exp7' },
    ])
    expect(tagRecCustomSession.expandedIds).toEqual([])
  })

  it('实机回归: expandQuery 只对真入暂存位的行标 expanded —— 锚点行被跳过不伪标 (卡死态/勾中漏组)', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.anchor = { id: 963, name: '奥特曼' }
    const anchorRow = row(963) // 锚点行 (exact 默认勾)
    const normalRow = row(7)
    tagRecCustomSession.candidates = [anchorRow, normalRow]
    await svc.expandQuery([anchorRow, normalRow])
    // 963 是锚点被暂存位跳过 => 不入 expandedIds 且行不伪标「已并入」
    // (伪标 expanded 会卡死: chip 区无此 tag, removeExpandedId 取消不到; 伪造 checked 会经勾中行并入)
    expect(tagRecCustomSession.expandedIds.map((e) => e.id)).toEqual([7])
    expect(anchorRow.expanded).toBeUndefined()
    expect(anchorRow.checked).toBe(true) // 用户勾选态原样保留 (不伪造也不误清)
    expect(normalRow).toMatchObject({ expanded: true, checked: true })
    // 且锚点行仍可手动取消/正常走勾中语义 (未 disabled)
  })

  describe('票 22: 选定组语境 => 并入该组 (暂存层固化, 不建组)', () => {
    let group: TagGroup
    beforeEach(() => {
      group = {
        id: 'g1',
        name: '电波',
        tag_ids: [{ id: 1, name: 'one' }],
        negative_tag_ids: [{ id: 9, name: 'neg9' }],
        weight: 1,
        enabled: true,
        addedAt: 0,
      }
      ;(favorites.list as TagGroup[]).push(group)
      tagRecCustomSession.selectedGroupIds = ['g1']
    })

    it('勾选行 ∪ expandedIds 并入该组: 撞行去重/已在组跳过/撞负向转正向; 并入后清空暂存位', async () => {
      const svc = new TagRecCustomService()
      // 扩选暂存: 5=新并入, 2=与勾选行撞 id, 9=与该组负向撞车
      tagRecCustomSession.expandedIds = [
        { id: 5, name: 'exp5' },
        { id: 2, name: 'dup-of-row2' },
        { id: 9, name: 'exp-collide-neg' },
      ]
      await svc.saveAsFavoriteGroup([row(2), row(3), row(4, false)]) // row4 未勾选不进

      expect(addGroupMock()).not.toHaveBeenCalled() // 不建组
      expect(addTagIdsMock()).toHaveBeenCalledTimes(1)
      const [gid, entries] = addTagIdsMock().mock.calls[0]
      expect(gid).toBe('g1')
      // 勾选行 {2,3} 优先保序, expandedIds 增量 {5,9} 追加 (id:2 撞行去重)
      expect(entries).toEqual([
        { id: 2, name: 'tag2' },
        { id: 3, name: 'tag3' },
        { id: 5, name: 'exp5' },
        { id: 9, name: 'exp-collide-neg' },
      ])
      // 门面全真语义: 2/3/5 新增, 9 由负向转正向 (moved), 组内容真被改写
      expect(group.tag_ids.map((e) => e.id)).toEqual([1, 2, 3, 5, 9])
      expect(group.negative_tag_ids).toEqual([])
      expect(tagRecCustomSession.expandedIds).toEqual([]) // 固化后清空暂存位
    })

    it('零勾选但暂存非空 => 纯扩选固化并入该组', async () => {
      const svc = new TagRecCustomService()
      tagRecCustomSession.expandedIds = [{ id: 5, name: 'exp5' }]
      await svc.saveAsFavoriteGroup([row(2, false)])
      expect(addGroupMock()).not.toHaveBeenCalled()
      expect(addTagIdsMock()).toHaveBeenCalledWith('g1', [{ id: 5, name: 'exp5' }], { silent: true })
      expect(group.tag_ids.map((e) => e.id)).toEqual([1, 5])
      expect(tagRecCustomSession.expandedIds).toEqual([])
    })

    it('零勾选且暂存空 => 不动作 (护栏不松)', async () => {
      const svc = new TagRecCustomService()
      await svc.saveAsFavoriteGroup([row(2, false)])
      expect(addGroupMock()).not.toHaveBeenCalled()
      expect(addTagIdsMock()).not.toHaveBeenCalled()
    })
  })

  it('实修: 草稿 negative 名单容器随组入表 (overrides.negative) + savedGroupId 钉点', async () => {
    const svc = new TagRecCustomService()
    tagRecCustomSession.draftGroup = {
      name: 'd',
      negative_tag_ids: [],
      strict: false,
      negative: {
        up: [{ name: '广告哥', mid: 42 }],
        partitionBlock: [{ name: '游戏', v1: 4, v2: 1008 }],
        partitionAllow: { enabled: true, list: [{ name: '动画', v1: 1, v2: 1001 }] },
      },
    }
    tagRecCustomSession.anchor = { id: 963, name: '奥特曼' }
    await svc.saveAsFavoriteGroup([])
    const input = addGroupMock().mock.calls[0][0]
    expect(input.overrides).toEqual({ negative: tagRecCustomSession.draftGroup!.negative })
    const group = addGroupMock().mock.results[0].value!.group
    expect(group.overrides?.negative?.up?.[0]?.mid).toBe(42)
    expect(group.overrides?.negative?.partitionBlock?.[0]?.name).toBe('游戏')
    expect(tagRecCustomSession.draftGroup!.savedGroupId).toBe(group.id)
  })

  it('实修: 草稿已存成项 (savedGroupId) => 再点存成项并入该组, 不再建新组', async () => {
    const svc = new TagRecCustomService()
    const saved = makeTagGroup({ name: '奥特曼', tag_ids: [{ id: 963, name: '奥特曼' }] })!
    ;(favorites.list as TagGroup[]).push(saved)
    tagRecCustomSession.draftGroup = {
      name: 'd',
      negative_tag_ids: [],
      strict: false,
      savedGroupId: saved.id,
    }
    tagRecCustomSession.anchor = { id: 963, name: '奥特曼' }
    await svc.saveAsFavoriteGroup([row(7)])
    expect(addGroupMock()).not.toHaveBeenCalled() // 不再建组
    expect(addTagIdsMock()).toHaveBeenCalledWith(saved.id, [{ id: 7, name: 'tag7' }], { silent: true })
    expect(saved.tag_ids.map((e) => e.id)).toEqual([963, 7])
  })

  describe('任意标签 B 与共现词独立扩选', () => {
    it('草稿 A 加入 B/C：保留锚点、负向和主候选；仅暂存，取消后存组不复活', async () => {
      beginTagRecCustomQuery('A')
      tagRecCustomSession.anchor = { id: 1, name: 'A' }
      tagRecCustomSession.draftGroup = {
        name: 'A',
        negative_tag_ids: [{ id: 9, name: '负向' }],
        strict: true,
        negative: { title: ['广告'] },
      }
      tagRecCustomSession.candidates = [row(2, false)]
      const draft = tagRecCustomSession.draftGroup
      const candidates = tagRecCustomSession.candidates
      const phase2 = tagRecCustomSession.phase2
      const svc = new TagRecCustomService()
      expect(
        svc
          .expandResolvedTags(
            [
              { id: 1, name: 'A' },
              { id: 2, name: 'B' },
              { id: 3, name: 'C' },
              { id: 2, name: 'B' },
            ],
            tagRecCustomSession.queryRevision,
          )
          .map((e) => e.id),
      ).toEqual([2, 3])
      expect(tagRecCustomSession.anchor).toEqual({ id: 1, name: 'A' })
      expect(tagRecCustomSession.inputText).toBe('A')
      expect(tagRecCustomSession.draftGroup).toBe(draft)
      expect(tagRecCustomSession.phase2).toBe(phase2)
      expect(tagRecCustomSession.candidates).toBe(candidates)
      expect(candidates[0]).toMatchObject({ expanded: true, checked: false })
      expect(tagRecCustomSession.expandedCollapsed).toBe(false)
      expect(addGroupMock()).not.toHaveBeenCalled()
      removeExpandedId(2)
      await svc.saveAsFavoriteGroup([])
      expect(addGroupMock().mock.calls[0][0]).toMatchObject({
        tag_ids: [
          { id: 1, name: 'A' },
          { id: 3, name: 'C' },
        ],
        negative_tag_ids: [{ id: 9, name: '负向' }],
        negative_strict: true,
        overrides: { negative: { title: ['广告'] } },
      })
    })

    it('选定组：已有成员及视频扩选去重，确认保存前不写收藏', async () => {
      const group = makeTagGroup({ name: '组 A', enabled: true, tag_ids: [{ id: 1, name: 'A' }] })!
      ;(favorites.list as TagGroup[]).push(group)
      switchTagRecGroupContext(group.id)
      tagRecCustomSession.expandedIds = [{ id: 2, name: '视频扩选 B' }]
      const svc = new TagRecCustomService()
      const revision = tagRecCustomSession.queryRevision
      expect(
        svc.expandResolvedTags(
          [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
            { id: 3, name: 'C' },
          ],
          revision,
        ),
      ).toEqual([{ id: 3, name: 'C' }])
      expect(tagRecCustomSession.selectedGroupIds).toEqual([group.id])
      expect(group.tag_ids).toEqual([{ id: 1, name: 'A' }])
      expect(addTagIdsMock()).not.toHaveBeenCalled()
      await svc.saveAsFavoriteGroup([])
      expect(group.tag_ids.map((e) => e.id)).toEqual([1, 2, 3])
      expect(tagRecCustomSession.expandedIds).toEqual([])
    })

    it('同名主查询重开和切组再切回，不接收旧 B 解析结果', () => {
      const group = makeTagGroup({ name: '组 A', enabled: true, tag_ids: [{ id: 1, name: 'A' }] })!
      ;(favorites.list as TagGroup[]).push(group)
      switchTagRecGroupContext(group.id)
      const svc = new TagRecCustomService()
      const groupRevision = tagRecCustomSession.queryRevision
      switchTagRecGroupContext(undefined)
      switchTagRecGroupContext(group.id)
      expect(svc.expandResolvedTags([{ id: 2, name: 'B' }], groupRevision)).toEqual([])
      beginTagRecCustomQuery('A')
      const draftRevision = tagRecCustomSession.queryRevision
      beginTagRecCustomQuery('A')
      tagRecCustomSession.anchor = { id: 1, name: 'A' }
      expect(svc.expandResolvedTags([{ id: 2, name: 'B' }], draftRevision)).toEqual([])
      expect(tagRecCustomSession.expandedIds).toEqual([])
    })

    it('无查询、主输入待解析或选定组已删，不建立无归属扩选', () => {
      const svc = new TagRecCustomService()
      const add = () => svc.expandResolvedTags([{ id: 2, name: 'B' }], tagRecCustomSession.queryRevision)
      expect(add()).toEqual([])
      const group = makeTagGroup({ name: '组 A', enabled: true, tag_ids: [{ id: 1, name: 'A' }] })!
      ;(favorites.list as TagGroup[]).push(group)
      switchTagRecGroupContext(group.id)
      beginTagRecCustomQuery('待解析')
      expect(add()).toEqual([])
      switchTagRecGroupContext(group.id)
      ;(favorites.list as TagGroup[]).length = 0
      expect(add()).toEqual([])
      expect(tagRecCustomSession.expandedIds).toEqual([])
    })

    it('草稿已存组的成员不重复暂存，新增扩选仍并入已存组', async () => {
      const group = makeTagGroup({
        name: 'A',
        tag_ids: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
        ],
      })!
      ;(favorites.list as TagGroup[]).push(group)
      beginTagRecCustomQuery('A')
      tagRecCustomSession.anchor = { id: 1, name: 'A' }
      tagRecCustomSession.draftGroup = { name: 'A', negative_tag_ids: [], strict: false, savedGroupId: group.id }
      const svc = new TagRecCustomService()
      expect(
        svc.expandResolvedTags(
          [
            { id: 2, name: 'B' },
            { id: 3, name: 'C' },
          ],
          tagRecCustomSession.queryRevision,
        ),
      ).toEqual([{ id: 3, name: 'C' }])
      await svc.saveAsFavoriteGroup([])
      expect(addGroupMock()).not.toHaveBeenCalled()
      expect(group.tag_ids.map((e) => e.id)).toEqual([1, 2, 3])
    })
  })
})
