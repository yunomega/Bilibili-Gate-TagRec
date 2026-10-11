import { cloneDeep } from 'es-toolkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRecConditionAtom, tagRecConditionAtoms } from '../model/combination'
import { favoritesL1Store, favoritesStore } from '../store'
import { stageTagRecMaterial, tagRecDiscoveryPreferences, tagRecDiscoveryUi } from '../store/discovery-ui'
import { tagRecCustomSession } from '../store/session'
import * as workbench from '../store/workbench'
import { setTagRecWorkingPool } from './discovery-pools'
import { TagRecWorkbenchView } from './workbench'
import type { TagRecCustomService } from '../service/tag-rec-custom'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', async () => ({ settings: { tagRec: (await import('valtio')).proxy({}) } }))
vi.mock('$components/RecHeader/modals', () => ({ showModalSettings: vi.fn() }))
vi.mock('$components/VideoCard/child-components/VideoCardActions', () => ({ VideoCardActionButton: () => null }))
vi.mock('$components/Recommends/rec.shared', () => ({
  useOnRefresh: () => vi.fn(),
  useRecSelfContext: () => ({ recSharedEmitter: { emit: vi.fn() } }),
}))
// Q8a: 成本预览经 service-map 注册表调达 —— 测试环境隔掉 pane 急切模块 (node 无 document)
vi.mock('$modules/rec-services/service-map', () => ({
  estimateTagRecConditionImpact: () => ({ hits: 0, join: 'all' }),
}))
vi.mock('$modules/rec-services/_base', () => ({
  usePopupContainer: () => ({ ref: null, getPopupContainer: () => null }),
}))
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchTagTop: vi.fn(),
  fetchAllV2Search: vi.fn(),
  fetchSuggest: vi.fn(),
  fetchTagInfoById: vi.fn(),
  fetchTagInfoByName: vi.fn(),
}))
vi.mock('./filter-popover', () => ({ FilterPopover: () => <button>组合过滤</button> }))
vi.mock('./banner', () => ({ TagRecBanner: () => null }))
vi.mock('./recheck-button', () => ({ TagRecRecheckButton: () => <button>定向重查</button> }))
vi.hoisted(() => {
  vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve(undefined)), setValue: vi.fn(() => Promise.resolve()) })
})
await workbench.activateTagRecWorkbench()
const render = () => renderToStaticMarkup(<TagRecWorkbenchView service={null as unknown as TagRecCustomService} />)

beforeEach(() => {
  favoritesStore.list = []
  favoritesL1Store.list = []
  workbench.tagRecWorkbench.trials = []
  workbench.tagRecWorkbench.recent = []
  workbench.newTagRecTrial()
  tagRecCustomSession.partitionPending = 0
  tagRecDiscoveryPreferences.collapsed = false
  tagRecDiscoveryPreferences.topCollapsed = false

  tagRecDiscoveryUi.materialQuery = undefined
})

describe('真实工作台视图与试验条件连线', () => {
  it('书架可收起，四池随完整条件保存，临时取词不提前写入组合', () => {
    workbench.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '程心' }))
    stageTagRecMaterial(workbench.tagRecWorkbench.activeId, {
      atom: tagRecConditionAtom('title', '黑暗森林'),
      name: '黑暗森林',
      source: '视频',
    })
    const markup = render()
    expect(markup).toContain('收起组合书架')
    expect(markup).toContain('暂选 1 项')
    expect(markup).toContain('加入当前组合')
    for (const pool of ['标签视频', '精确搜索', '搜索相关', '推荐相关']) expect(markup).toContain(pool)
    expect(markup).not.toContain('移出标题词黑暗森林')
    setTagRecWorkingPool('allV2Related', false)
    setTagRecWorkingPool('archiveRelated', false)
    expect(workbench.saveTagRecWorkingGroup('人物')!.combination!.filters!.poolsEnabled).toEqual({
      allV2Related: false,
      archiveRelated: false,
    })
    setTagRecWorkingPool('allV2Related')
    expect(tagRecCustomSession.workingGroup!.combination!.filters!.poolsEnabled).toEqual({ archiveRelated: false })
    tagRecDiscoveryPreferences.collapsed = true
    expect(render()).toContain('展开组合书架')
    expect(render()).not.toContain('二级组收藏')
    expect(workbench.currentTagRecTrial()?.pending).toHaveLength(1)
  })
  it('移出大池只删该条件，人物组合可直接保存，收藏与近期在同一界面恢复', () => {
    for (const [id, name] of [
      [1, '三体'],
      [2, '程心'],
      [3, '罗辑'],
    ] as const)
      workbench.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id, name }))
    const anchor = tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include).find(
      (a) => a.field === 'tag' && a.value.id === 1,
    )!
    workbench.removeTagRecWorkingCondition(anchor.id)
    const markup = render()
    expect(markup).toContain('移出标签程心')
    expect(markup).toContain('移出标签罗辑')
    expect(markup).not.toContain('移出标签三体')
    expect(markup).not.toContain('丢弃当前查询的暂存')
    expect(markup).toContain('任一命中')
    expect(markup).toContain('存为二级组')
    const saved = workbench.saveTagRecWorkingGroup('人物组合')!
    workbench.excludeTagRecWorkingCondition(tagRecConditionAtom('desc', '动画'))
    workbench.openTagRecFavorite(cloneDeep(saved))
    expect(render()).toContain('人物组合')
    expect(render()).toContain('二级组收藏')
    expect(render()).toContain('最近尝试')
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toEqual([])
  })
  it('无标签组合的字段、排除及暂时查看都可见；临时查看不会改写条件', () => {
    workbench.addTagRecWorkingCondition(tagRecConditionAtom('up', { name: '读书UP', mid: 11 }))
    workbench.addTagRecWorkingCondition(tagRecConditionAtom('title', '三体'))
    workbench.excludeTagRecWorkingCondition(tagRecConditionAtom('partition', { name: '动画', v1: 1, level: 'parent' }))
    tagRecCustomSession.partitionPending = 3
    tagRecCustomSession.allowUnverified = false
    const markup = render()
    expect(markup).toContain('UP 主 · 读书UP')
    expect(markup).toContain('标题词 · 三体')
    expect(markup).toContain('分区 · 动画')
    expect(markup).toContain('暂时查看未核实内容')
    const conditions = JSON.stringify(tagRecCustomSession.workingGroup!.combination)
    tagRecCustomSession.allowUnverified = true
    tagRecCustomSession.partitionPending = 0
    expect(render()).toContain('恢复暂存')
    expect(JSON.stringify(tagRecCustomSession.workingGroup!.combination)).toBe(conditions)
  })
})
