import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import {
  beginTagRecCustomQuery,
  pushExpandedIds,
  reconcileTagRecMergedGroupContext,
  removeExpandedId,
  resetTagRecCustomFilter,
  resetTagRecFavFilter,
  switchTagRecGroupContext,
  syncTagRecFavFilterScope,
  tagRecCustomSession,
  tagRecFavSession,
} from './session'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const setTravelFilter = () => {
  const core = createTagRecFactoryFilterCore()
  core.dims.titleAllow = { enabled: true, list: ['上海', '杭州'] }
  tagRecCustomSession.filterOverride = core
  tagRecCustomSession.tempWriteLog.push({
    kind: 'titleAllow',
    label: '标题仅看: 上海',
    value: '上海',
    owningGroupNames: ['旅游'],
  })
  return tagRecCustomSession.filterOverride
}

describe('$modules/tag-rec/store/session (票 21 组语境互斥)', () => {
  beforeEach(() => {
    beginTagRecCustomQuery('')
    tagRecCustomSession.selectedGroupIds = []
    resetTagRecCustomFilter()
  })

  it('switchTagRecGroupContext: 选组 => 弃临时输入侧整段查询态, 立选定组 (限长 1)', () => {
    // 造输入侧语境: 草稿组 (负向) + 锚点 + 扩选 + 候选清单 + 运行中镜像
    beginTagRecCustomQuery('临时输入')
    tagRecCustomSession.draftGroup = { name: 'foo', negative_tag_ids: [{ id: 1, name: 'neg' }], strict: true }
    tagRecCustomSession.anchor = { id: 2, name: 'anc' }
    tagRecCustomSession.expandedIds = [{ id: 3, name: 'exp' }]
    tagRecCustomSession.candidates = [{ key: 'k', tag_name: 't', badge: 'exact', checked: true }]
    tagRecCustomSession.candidatesCollapsed = false
    tagRecCustomSession.phase2.status = 'running'
    tagRecCustomSession.digPending = true
    tagRecCustomSession.digRunning = true
    tagRecCustomSession.softBottom = true
    tagRecCustomSession.hardBottom = true
    setTravelFilter()

    switchTagRecGroupContext('g1')

    expect(tagRecCustomSession.selectedGroupIds).toEqual(['g1'])
    expect(tagRecCustomSession.inputText).toBe('')
    expect(tagRecCustomSession.draftGroup).toBeUndefined()
    expect(tagRecCustomSession.anchor).toBeUndefined()
    expect(tagRecCustomSession.candidates).toEqual([])
    expect(tagRecCustomSession.candidatesCollapsed).toBe(true)
    expect(tagRecCustomSession.expandedIds).toEqual([])
    expect(tagRecCustomSession.phase2).toEqual({
      status: 'idle',
      pagesFetched: 0,
      exhausted: false,
      autoDigs: 0,
      lastDigYield: 0,
    })
    expect(tagRecCustomSession.digPending).toBe(false)
    expect(tagRecCustomSession.digRunning).toBe(false)
    expect(tagRecCustomSession.softBottom).toBe(false)
    expect(tagRecCustomSession.hardBottom).toBe(false)
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('switchTagRecGroupContext(undefined): 清选 => 切到无组语境, 数组 shape 不破', () => {
    tagRecCustomSession.selectedGroupIds = ['g1']
    setTravelFilter()
    switchTagRecGroupContext(undefined)
    expect(tagRecCustomSession.selectedGroupIds).toEqual([])
    expect(tagRecCustomSession.draftGroup).toBeUndefined()
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('换组 => 后动作者赢, 新组替代旧组 (仍限长 1)', () => {
    switchTagRecGroupContext('g1')
    setTravelFilter()
    switchTagRecGroupContext('g2')
    expect(tagRecCustomSession.selectedGroupIds).toEqual(['g2'])
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('旅游换电影 => 标题仅看和右键临时名单一起清除', () => {
    beginTagRecCustomQuery('旅游')
    setTravelFilter()
    beginTagRecCustomQuery('电影')
    expect(tagRecCustomSession.inputText).toBe('电影')
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('同一锚点重查和扩选保留临时过滤，忽略输入两端空格', () => {
    beginTagRecCustomQuery('旅游')
    const core = setTravelFilter()
    const log = tagRecCustomSession.tempWriteLog
    pushExpandedIds([{ id: 9, name: '旅行' }])
    beginTagRecCustomQuery(' 旅游 ')
    expect(tagRecCustomSession.filterOverride).toBe(core)
    expect(tagRecCustomSession.tempWriteLog).toBe(log)
    expect(core.dims.titleAllow!.list).toEqual(['上海', '杭州'])
  })

  it('相同标签组重查保留临时过滤，改用输入查询则清除', () => {
    switchTagRecGroupContext('g1')
    const core = setTravelFilter()
    switchTagRecGroupContext('g1')
    expect(tagRecCustomSession.filterOverride).toBe(core)
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    beginTagRecCustomQuery('旅游')
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('合并原查询组是语境延续，保留临时过滤和扩选', () => {
    switchTagRecGroupContext('g1')
    const core = setTravelFilter()
    pushExpandedIds([{ id: 9, name: '旅行' }])
    reconcileTagRecMergedGroupContext(['g1'], 'g2')
    expect(tagRecCustomSession.selectedGroupIds).toEqual(['g2'])
    expect(tagRecCustomSession.filterOverride).toBe(core)
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    expect(tagRecCustomSession.expandedIds).toEqual([{ id: 9, name: '旅行' }])
  })

  it('手动清除临时过滤同时销账，保留当前锚点和扩选', () => {
    beginTagRecCustomQuery('旅游')
    tagRecCustomSession.anchor = { id: 2, name: '旅游' }
    pushExpandedIds([{ id: 9, name: '旅行' }])
    setTravelFilter()
    resetTagRecCustomFilter()
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
    expect(tagRecCustomSession.inputText).toBe('旅游')
    expect(tagRecCustomSession.anchor).toEqual({ id: 2, name: '旅游' })
    expect(tagRecCustomSession.expandedIds).toEqual([{ id: 9, name: '旅行' }])
  })
})

describe('「显示已看」按 tab 分家', () => {
  it('主题推荐默认滤掉已看 (bypassSeen=false)，标签发掘默认显示已看 (=true, 调试便利)', () => {
    expect(tagRecFavSession.bypassSeen).toBe(false)
    expect(tagRecCustomSession.bypassSeen).toBe(true)
  })
})

describe('主题推荐临时过滤的查看范围', () => {
  beforeEach(() => {
    resetTagRecFavFilter()
    resetTagRecCustomFilter()
    tagRecFavSession.filterScopeSignature = undefined
    tagRecFavSession.filterScopeRevision = 0
  })

  it('同查看范围重刷保留，切换范围清除临时过滤及账本，另一页保持独立', () => {
    syncTagRecFavFilterScope('范围A')
    tagRecFavSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['上海'] } } }
    tagRecFavSession.tempWriteLog.push({ kind: 'titleAllow', value: '上海', label: 'l', owningGroupNames: [] })
    const patch = tagRecFavSession.filterOverride
    const custom = setTravelFilter()
    syncTagRecFavFilterScope('范围A')
    expect(tagRecFavSession.filterOverride).toBe(patch)
    expect(tagRecFavSession.filterScopeRevision).toBe(0)
    syncTagRecFavFilterScope('范围B')
    expect(tagRecFavSession.filterOverride).toBeUndefined()
    expect(tagRecFavSession.tempWriteLog).toEqual([])
    expect(tagRecFavSession.filterScopeRevision).toBe(1)
    expect(tagRecCustomSession.filterOverride).toBe(custom)
  })
})

describe('票 22 expandedIds 语境无关暂存位 (pushExpandedIds / removeExpandedId)', () => {
  beforeEach(() => {
    beginTagRecCustomQuery('')
    tagRecCustomSession.selectedGroupIds = []
  })

  it('push 去重: 已在暂存位 / 锚点自身 / 当前组真成员 / 入参内部重复 全跳过', () => {
    tagRecCustomSession.expandedIds = [{ id: 1, name: 'in-stash' }]
    tagRecCustomSession.anchor = { id: 2, name: 'anchor' }
    const added = pushExpandedIds(
      [
        { id: 1, name: 'dup-stash' }, // 已在暂存位
        { id: 2, name: 'anchor' }, // 锚点 (本就在查询单元)
        { id: 3, name: 'member' }, // 当前组真成员
        { id: 4, name: 'new' },
        { id: 4, name: 'new-dup' }, // 入参内部重复
      ],
      [{ id: 3, name: 'member' }],
    )
    expect(added).toEqual([{ id: 4, name: 'new' }])
    expect(tagRecCustomSession.expandedIds).toEqual([
      { id: 1, name: 'in-stash' },
      { id: 4, name: 'new' },
    ])
  })

  it('push 成功 => 对应候选行置 expanded 徽标态; checked 不伪造 (勾中=用户并入意图)', () => {
    tagRecCustomSession.candidates = [
      { key: 'id:9', tag_name: 't9', tag_id: 9, badge: 'cooccur', checked: false },
      { key: 'id:8', tag_name: 't8', tag_id: 8, badge: 'suggest', checked: false },
      { key: 'id:7', tag_name: 't7', tag_id: 7, badge: 'cooccur', checked: true }, // 用户预勾行
    ]
    const added = pushExpandedIds([
      { id: 9, name: 't9' },
      { id: 7, name: 't7' },
    ])
    expect(added).toHaveLength(2)
    expect(tagRecCustomSession.candidates[0].expanded).toBe(true)
    expect(tagRecCustomSession.candidates[0].checked).toBe(false) // ★ 扩选不伪造勾中 (实机修复)
    expect(tagRecCustomSession.candidates[1].expanded).toBeUndefined() // 不殃及他行
    expect(tagRecCustomSession.candidates[2]).toMatchObject({ expanded: true, checked: true }) // 预勾保留
  })

  it('removeExpandedId: 删暂存位 + 候选行 expanded/checked 一并清回; 不存在 => 幂等 no-op', () => {
    tagRecCustomSession.expandedIds = [
      { id: 9, name: 't9' },
      { id: 7, name: 't7' },
    ]
    tagRecCustomSession.candidates = [
      { key: 'id:9', tag_name: 't9', tag_id: 9, badge: 'cooccur', checked: true, expanded: true },
      { key: 'n:no-id', tag_name: 'no-id', badge: 'suggest', checked: true, expanded: true },
    ]
    removeExpandedId(9)
    expect(tagRecCustomSession.expandedIds).toEqual([{ id: 7, name: 't7' }])
    // 实机修复: checked 一并清回 —— 勾中行是 saveAsFavoriteGroup 并入来源, 留着 = 取消仍并入
    expect(tagRecCustomSession.candidates[0]).toMatchObject({ expanded: false, checked: false })
    expect(tagRecCustomSession.candidates[1].expanded).toBe(true) // 无 tag_id 不匹配
    removeExpandedId(9) // 已不在暂存位 => no-op
    expect(tagRecCustomSession.expandedIds).toEqual([{ id: 7, name: 't7' }])
  })
})
