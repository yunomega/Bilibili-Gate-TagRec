import { cloneDeep } from 'es-toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchTagInfoByName } from '../api/endpoints'
import {
  findTagRecCondition,
  graftTagRecConditionTree,
  newTagRecCombination,
  tagRecCombinationSignature,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  validateTagRecCombination,
  type TagRecConditionAtom,
  type TagRecConditionGroup,
} from '../model/combination'
import { blockTagRecConditionGlobally, tagRecCombinationBlocks } from './combination-blocks'
import { stageTagRecMaterial, tagRecDiscoveryUi } from './discovery-ui'
import { commitTagRecMaterialDraft, importTagRecFavoriteCombinations } from './material-draft'
import type { TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(), fetchTagInfoByName: vi.fn(), fetchTagInfoById: vi.fn() }))
const kv = vi.hoisted(() => {
  const map = new Map<string, unknown>()
  vi.stubGlobal('GM', {
    getValue: vi.fn((key: string) => Promise.resolve(map.get(key))),
    setValue: vi.fn((key: string, value: unknown) => map.set(key, value)),
  })
  return map
})
const { favorites, favoritesStore, favoritesL1Store } = await import('./index')
const { tagRecCustomSession } = await import('./session')
const w = await import('./workbench')
await w.activateTagRecWorkbench()

beforeEach(() => {
  favoritesStore.list = []
  favoritesL1Store.list = []
  w.tagRecWorkbench.trials = []
  w.tagRecWorkbench.recent = []
  w.tagRecWorkbench.activeId = ''
  w.newTagRecTrial()
  tagRecCombinationBlocks.list = []

  tagRecDiscoveryUi.materialQuery = undefined
  tagRecDiscoveryUi.video = undefined
  tagRecDiscoveryUi.videoTrialId = ''
  vi.mocked(fetchTagInfoByName).mockReset()
})
describe('工作台保存与试验生命周期', () => {
  it('第 65 项暂选被拒绝，最早的暂选仍然保留', () => {
    const id = w.tagRecWorkbench.activeId
    for (let i = 0; i < 64; i++) stageTagRecMaterial(id, { name: `条件${i}`, source: '视频' })
    expect(stageTagRecMaterial(id, { name: '超出数量', source: '视频' })).toBe(false)
    expect(w.currentTagRecTrial()!.pending).toHaveLength(64)
    expect(w.currentTagRecTrial()!.pending![0].name).toBe('条件0')
  })
  it('第九份试验把最早试验连同暂选归档；多次恢复互不影响', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '三体' }))
    stageTagRecMaterial(w.tagRecWorkbench.activeId, { name: '程心', source: '共现' })
    for (let i = 0; i < 8; i++) w.newTagRecTrial()
    expect(w.tagRecWorkbench.trials).toHaveLength(8)
    const archived = w.tagRecWorkbench.recent.find((entry) => entry.pending?.length)!
    expect(archived.pending![0].name).toBe('程心')
    const revived = w.openTagRecRecent(archived)!
    revived.pending = []
    expect(w.openTagRecRecent(archived)!.pending![0].name).toBe('程心')
    expect(archived.pending).toHaveLength(1)
  })
  it('工作副本组名随试验显示名同步 (徽标不再显示默认占位名)', () => {
    w.newTagRecTrial(undefined, undefined, '原神女角色')
    const trial = w.currentTagRecTrial()!
    expect(trial.name).toBe('原神女角色')
    expect(trial.group.name).toBe('原神女角色')
    // 后续编辑 (synchronize) 仍保持一致
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '原神' }))
    expect(w.currentTagRecTrial()!.group.name).toBe('原神女角色')
  })
  it('暂选和最近尝试随工作台落盘，不依赖易失的面板状态', async () => {
    stageTagRecMaterial(w.tagRecWorkbench.activeId, { name: '程心', source: '共现' })
    w.onlyTagRecTag({ id: 3, name: '罗辑' })
    await vi.waitFor(
      () => {
        const persisted = kv.get('tag-rec:workbench') as { recent?: { pending?: { name: string }[] }[] }
        expect(persisted?.recent?.[0].pending?.[0].name).toBe('程心')
      },
      { timeout: 1500 },
    )
  })
  it('仅看解析期间切换组合，旧请求不能替换新组合', async () => {
    const request = Promise.withResolvers<{ id: number; name: string }>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(request.promise)
    const pending = w.exploreTagRecMaterialOnly({ name: '程心', source: '共现' })
    const next = w.newTagRecTrial()!
    request.resolve({ id: 2, name: '程心' })
    expect(await pending).toBe(false)
    expect(w.currentTagRecTrial()!.id).toBe(next.id)
  })
  it('批量选入只清掉成功项，排除冲突保留；已生效项可以完成暂选', async () => {
    w.excludeTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '动画' }))
    stageTagRecMaterial(w.tagRecWorkbench.activeId, {
      atom: tagRecConditionAtom('tag', { id: 1, name: '动画' }),
      name: '动画',
      source: '视频',
    })
    stageTagRecMaterial(w.tagRecWorkbench.activeId, {
      atom: tagRecConditionAtom('title', '人物'),
      name: '人物',
      source: '视频',
    })
    expect(await commitTagRecMaterialDraft()).toBe(true)
    expect(w.currentTagRecTrial()!.pending?.map((item) => item.name)).toEqual(['动画'])
    w.currentTagRecTrial()!.pending = []
    stageTagRecMaterial(w.tagRecWorkbench.activeId, {
      atom: tagRecConditionAtom('title', '人物'),
      name: '人物',
      source: '视频',
    })
    expect(await commitTagRecMaterialDraft()).toBe(true)
    expect(w.currentTagRecTrial()!.pending).toEqual([])
  })
  it('批量解析期间编辑了组合，返回后保留暂选，不能回写旧语境', async () => {
    stageTagRecMaterial(w.tagRecWorkbench.activeId, { name: '程心', source: '共现' })
    const request = Promise.withResolvers<{ id: number; name: string }>()
    vi.mocked(fetchTagInfoByName).mockReturnValue(request.promise)
    const pending = commitTagRecMaterialDraft()
    w.addTagRecWorkingCondition(tagRecConditionAtom('title', '罗辑'))
    request.resolve({ id: 2, name: '程心' })
    expect(await pending).toBe(false)
    expect(w.currentTagRecTrial()!.pending).toHaveLength(1)
    expect(w.currentTagRecTrial()!.group.tag_ids).toEqual([])
  })
  it('从旧收藏打开，删大标签、批量取新条件、改来源再另存，旧收藏和来源条件保持完整', async () => {
    const original = favorites.addGroup({
      name: '三体人物',
      tag_ids: [
        { id: 1, name: '三体' },
        { id: 2, name: '程心' },
        { id: 3, name: '罗辑' },
      ],
    })!.group
    const before = cloneDeep(original)
    w.openTagRecFavorite(original)
    const large = tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include).find(
      (atom) => atom.field === 'tag' && atom.value.id === 1,
    )!
    w.removeTagRecWorkingCondition(large.id)
    const withoutLarge = tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)
    const trialId = w.tagRecWorkbench.activeId
    stageTagRecMaterial(trialId, { atom: tagRecConditionAtom('title', '人物分析'), name: '人物分析', source: '视频' })
    stageTagRecMaterial(trialId, {
      atom: tagRecConditionAtom('desc', '动画'),
      name: '动画',
      source: '视频',
      exclude: true,
    })
    stageTagRecMaterial(trialId, {
      name: '不看相关',
      source: '收藏',
      filter: { dims: {}, poolsEnabled: { allV2Related: false, archiveRelated: false } },
    })
    expect(await commitTagRecMaterialDraft()).toBe(true)
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === trialId)?.pending).toEqual([])
    expect(w.undoTagRecWorkingGroup()).toBe(true)
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(withoutLarge)
    stageTagRecMaterial(trialId, { atom: tagRecConditionAtom('title', '人物分析'), name: '人物分析', source: '视频' })
    stageTagRecMaterial(trialId, {
      atom: tagRecConditionAtom('desc', '动画'),
      name: '动画',
      source: '视频',
      exclude: true,
    })
    stageTagRecMaterial(trialId, {
      name: '不看相关',
      source: '收藏',
      filter: { dims: {}, poolsEnabled: { allV2Related: false, archiveRelated: false } },
    })
    await commitTagRecMaterialDraft()
    const saved = w.saveTagRecWorkingGroup('人物分析组合')!
    expect(saved.id).not.toBe(original.id)
    expect(saved.tag_ids.map((tag) => tag.id)).toEqual([2, 3])
    expect(saved.combination!.filters!.poolsEnabled).toEqual({ allV2Related: false, archiveRelated: false })
    expect(saved.combination!.exclude[0].value).toBe('动画')
    expect(original).toEqual(before)
    expect(favoritesStore.list.map((group) => group.id)).toContain(original.id)
    expect(favoritesStore.list.map((group) => group.id)).toContain(saved.id)
    w.openTagRecFavorite(saved)
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(
      tagRecCombinationSignature(saved.combination!),
    )
  })
  it('同名标签与标题词都能批量加入；解析失败项保留，所有选取仍属于当前试验', async () => {
    const id = w.tagRecWorkbench.activeId
    stageTagRecMaterial(id, { name: '程心', source: '视频' })
    stageTagRecMaterial(id, { atom: tagRecConditionAtom('title', '程心'), name: '程心', source: '视频' })
    stageTagRecMaterial(id, { name: '未解析', source: '共现' })
    vi.mocked(fetchTagInfoByName).mockImplementation((name) =>
      Promise.resolve(name === '程心' ? { id: 2, name: '程心', tag_type: 'topic', aliases: ['程心'] } : undefined),
    )
    expect(await commitTagRecMaterialDraft()).toBe(true)
    expect(
      tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include).map((atom) => atom.field),
    ).toEqual(['tag', 'title'])
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === id)?.pending?.map((entry) => entry.name)).toEqual([
      '未解析',
    ])
    w.newTagRecTrial()
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === w.tagRecWorkbench.activeId)?.pending).toBeUndefined()
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === id)?.pending).toHaveLength(1)
  })
  it('异步解析后切组不污染新组；提交期间重新选取的同项仍暂存', async () => {
    const first = w.tagRecWorkbench.activeId
    stageTagRecMaterial(first, { name: '程心', source: '视频' })
    let request = Promise.withResolvers<{ id: number; name: string }>()
    vi.mocked(fetchTagInfoByName).mockImplementation(() => request.promise)
    const old = commitTagRecMaterialDraft()
    w.newTagRecTrial()
    request.resolve({ id: 2, name: '程心' })
    expect(await old).toBe(false)
    expect(tagRecCustomSession.workingGroup!.tag_ids).toEqual([])
    w.switchTagRecTrial(first)
    request = Promise.withResolvers<{ id: number; name: string }>()
    const pending = commitTagRecMaterialDraft()
    stageTagRecMaterial(first, { name: '程心', source: '视频' })
    stageTagRecMaterial(first, { name: '程心', source: '视频' })
    request.resolve({ id: 2, name: '程心' })
    expect(await pending).toBe(false)
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === first)?.pending).toHaveLength(1)
  })
  it('保存后继续编辑不修改收藏，切回收藏恢复完整排除和显式过滤', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '罗辑' }))
    w.excludeTagRecWorkingCondition(tagRecConditionAtom('desc', '动画'))
    w.editTagRecWorkingGroup((g) => {
      g.combination!.filters = {
        dims: { duration: { enabled: true, min: 20, max: 0 } },
        poolsEnabled: { tagTop: false },
      }
    })
    const saved = w.saveTagRecWorkingGroup('人物')!
    const signature = tagRecCombinationSignature(saved.combination!)
    w.removeTagRecWorkingCondition(tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)[0].id)
    expect(tagRecCombinationSignature(saved.combination!)).toBe(signature)
    w.openTagRecFavorite(saved)
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(signature)
    expect(tagRecCustomSession.filterOverride?.poolsEnabled).toEqual({ tagTop: false })
  })
  it('排除一步转为排除，撤销恢复；临时查看的显式开关不被编辑/切试验静默改写', () => {
    const atom = tagRecConditionAtom('tag', { id: 1, name: '程心' })
    w.addTagRecWorkingCondition(atom)
    tagRecCustomSession.allowUnverified = false
    w.excludeTagRecWorkingCondition(atom)
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    expect(tagRecCustomSession.workingGroup!.tag_ids).toEqual([])
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(1)
    expect(w.undoTagRecWorkingGroup()).toBe(true)
    expect(tagRecCustomSession.workingGroup!.tag_ids).toEqual([{ id: 1, name: '程心' }])
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    const first = w.currentTagRecTrial()!
    const next = w.newTagRecTrial(first.group)!
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    w.switchTagRecTrial(first.id)
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    expect(w.currentTagRecTrial()?.id).not.toBe(next.id)
    expect(JSON.stringify(w.tagRecWorkbench)).not.toContain('allowUnverified')
  })
  it('D06: 显式临时查看在条件编辑/过滤改动/切试验后恢复默认暂存', () => {
    tagRecCustomSession.allowUnverified = true
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    tagRecCustomSession.allowUnverified = true
    tagRecCustomSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['alpha'] } } }
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    const first = w.currentTagRecTrial()!
    tagRecCustomSession.allowUnverified = true
    w.newTagRecTrial(first.group)
    expect(tagRecCustomSession.allowUnverified).toBe(false)
    tagRecCustomSession.allowUnverified = true
    w.switchTagRecTrial(first.id)
    expect(tagRecCustomSession.allowUnverified).toBe(false)
  })
  it('组合发生实质变化时，变化前的组合自动记入最近尝试', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '罗辑' }))
    const counts = w.tagRecWorkbench.recent.map((entry) =>
      entry.group.combination ? tagRecConditionAtoms(entry.group.combination.include).length : 0,
    )
    // 加第二个标签时，把「只有程心」的中间态也记了一条
    expect(counts).toContain(1)
    expect(w.tagRecWorkbench.recent.every((entry) => entry.id !== w.tagRecWorkbench.activeId)).toBe(true)
  })
  it('过滤/池改动同样记入最近尝试，不只在条件编辑时记账', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    const before = tagRecCombinationSignature(w.currentTagRecTrial()!.group.combination!)
    w.tagRecWorkbench.recent = []
    tagRecCustomSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['alpha'] } } }
    const banked = w.tagRecWorkbench.recent[0]
    expect(banked).toBeTruthy()
    expect(tagRecCombinationSignature(banked.group.combination!)).toBe(before)
    expect(w.currentTagRecTrial()!.group.combination!.filters?.dims.titleAllow).toMatchObject({ enabled: true })
  })

  describe('用户旅程（顺序无关）', () => {
    const atoms = () => tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)
    const tagNames = () =>
      atoms()
        .filter((a) => a.field === 'tag')
        .map((a) => a.value.name)
    const fieldNames = (field: 'tag' | 'title' | 'desc') =>
      atoms()
        .filter((a) => a.field === field)
        .map((a) => (typeof a.value === 'string' ? a.value : a.value.name))

    it('J1 搜三体→加程心/罗辑→移出三体：两个角色仍在，三体既不残留也不变成排除', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '三体' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '程心' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 3, name: '罗辑' }))
      const threeBody = atoms().find((a) => a.field === 'tag' && a.value.name === '三体')!
      w.removeTagRecWorkingCondition(threeBody.id)
      expect(tagNames().sort()).toEqual(['程心', '罗辑'])
      expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(0)
    })

    it('J2 同一「三体」分别作标签/标题/简介：身份独立，删其一不影响其余', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '三体' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('title', '三体'))
      w.addTagRecWorkingCondition(tagRecConditionAtom('desc', '三体'))
      const tagAtom = atoms().find((a) => a.field === 'tag')!
      w.removeTagRecWorkingCondition(tagAtom.id)
      expect(tagNames()).toEqual([])
      expect(fieldNames('title')).toEqual(['三体'])
      expect(fieldNames('desc')).toEqual(['三体'])
    })

    it('J3 任意顺序增删后条件不重复、不丢失', () => {
      const A = tagRecConditionAtom('tag', { id: 1, name: 'A' })
      const B = tagRecConditionAtom('tag', { id: 2, name: 'B' })
      const C = tagRecConditionAtom('tag', { id: 3, name: 'C' })
      w.addTagRecWorkingCondition(A)
      w.addTagRecWorkingCondition(C)
      w.addTagRecWorkingCondition(B)
      w.addTagRecWorkingCondition(A) // 重复加入不应叠加
      w.removeTagRecWorkingCondition(atoms().find((a) => a.field === 'tag' && a.value.name === 'C')!.id)
      w.addTagRecWorkingCondition(C)
      expect(tagNames().sort()).toEqual(['A', 'B', 'C'])
      expect(tagNames()).toHaveLength(3)
    })

    it('J4 撤销逐级回退本试验，且不回退到别的试验', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: 'A' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: 'B' }))
      expect(w.undoTagRecWorkingGroup()).toBe(true)
      expect(tagNames()).toEqual(['A'])
      expect(w.undoTagRecWorkingGroup()).toBe(true)
      expect(tagNames()).toEqual([])
    })

    it('J5 打开收藏→改条件→另存：原收藏不被改动', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
      const saved = w.saveTagRecWorkingGroup('人物组合')!
      const before = tagRecCombinationSignature(saved.combination!)
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '罗辑' }))
      w.removeTagRecWorkingCondition(atoms().find((a) => a.field === 'tag' && a.value.name === '程心')!.id)
      expect(tagRecCombinationSignature(saved.combination!)).toBe(before)
    })

    it('J6 全局排除的条件不能被局部选入绕过', () => {
      const atom = tagRecConditionAtom('tag', { id: 9, name: '全局拉黑' })
      blockTagRecConditionGlobally(atom)
      expect(w.addTagRecWorkingCondition(atom)).toBe(false)
      expect(tagNames()).toEqual([])
    })

    it('J7 临时查看不写入组合条件（开关不改条件）', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
      const before = tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)
      tagRecCustomSession.allowUnverified = !tagRecCustomSession.allowUnverified
      tagRecCustomSession.allowUnverified = !tagRecCustomSession.allowUnverified
      expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(before)
    })

    it('J8 连续改动后「最近尝试」能回到中间态，且不含当前试验自身', () => {
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: 'A' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: 'B' }))
      w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 3, name: 'C' }))
      const seen = w.tagRecWorkbench.recent.map((entry) =>
        entry.group.combination ? tagRecConditionAtoms(entry.group.combination.include).length : 0,
      )
      expect(seen).toEqual(expect.arrayContaining([1, 2]))
      expect(w.tagRecWorkbench.recent.every((entry) => entry.id !== w.tagRecWorkbench.activeId)).toBe(true)
    })

    it('J9 随机顺序操作序列（60 步）：不变量始终成立', () => {
      let seed = 20261005
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
      const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]
      const pool = Array.from({ length: 6 }, (_, i) => tagRecConditionAtom('tag', { id: i + 1, name: `T${i + 1}` }))
      for (let step = 0; step < 60; step++) {
        const roll = rnd()
        if (roll < 0.5) w.addTagRecWorkingCondition(pick(pool))
        else if (roll < 0.75) {
          const list = tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)
          if (list.length) w.removeTagRecWorkingCondition(pick(list).id)
        } else if (roll < 0.9) w.excludeTagRecWorkingCondition(pick(pool))
        else w.undoTagRecWorkingGroup()

        const combination = tagRecCustomSession.workingGroup!.combination!
        expect(validateTagRecCombination(combination)).toBe(true)
        const keys = tagRecConditionAtoms(combination.include).map((a) => tagRecConditionKey(a))
        expect(new Set(keys).size).toBe(keys.length) // 无重复条件
        const ids = tagRecCombinationTagIds(combination)
        expect(new Set(ids.map((e) => e.id)).size).toBe(ids.length) // 标签投影不重复
        expect(w.tagRecWorkbench.recent.length).toBeLessThanOrEqual(30) // 最近尝试有界
        expect(w.tagRecWorkbench.recent.every((entry) => entry.id !== w.tagRecWorkbench.activeId)).toBe(true)
      }
    })
  })

  it('只有 UP 和筛选的组可保存启用；最近尝试去重有界且记录键唯一', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('up', { name: 'UP', mid: 11 }))
    const saved = w.saveTagRecWorkingGroup('UP试看')!
    expect(saved.enabled).toBe(true)
    expect(saved.tag_ids).toEqual([])
    favorites.updateGroup(saved.id, { enabled: false })
    favorites.updateGroup(saved.id, { enabled: true })
    expect(saved.enabled).toBe(true)
    for (let i = 0; i < 35; i++) {
      w.editTagRecWorkingGroup((g) => {
        g.combination!.filters = { dims: { viewMin: { enabled: true, value: i } } }
      })
      w.newTagRecTrial(w.currentTagRecTrial()!.group)
    }
    expect(w.tagRecWorkbench.recent).toHaveLength(30)
    expect(new Set(w.tagRecWorkbench.recent.map((entry) => entry.id)).size).toBe(30)
  })
  it('从旧收藏开试验保留原组，完整组合合并不会被扁平化', () => {
    const original = favorites.addGroup({
      name: '旧组',
      tag_ids: [{ id: 1, name: '三体' }],
      negative_tag_ids: [{ id: 2, name: '动画' }],
    })!.group
    const before = JSON.stringify(original)
    w.openTagRecFavorite(original)
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(1)
    w.addTagRecWorkingCondition(tagRecConditionAtom('title', '罗辑'))
    const complete = w.saveTagRecWorkingGroup('试验')!
    expect(favorites.mergeGroupsInto([complete.id], original.id)).toBeUndefined()
    expect(favorites.list).toHaveLength(2)
    expect(JSON.stringify(original)).toBe(before)
  })
  it('跨窗口替换试验后，试看采用新条件而不写回旧对象', async () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('title', '三体'))
    const current = w.currentTagRecTrial()!
    const replayed = cloneDeep(current)
    replayed.group.combination!.include.children = []
    replayed.group.combination!.exclude.push(tagRecConditionAtom('desc', '动画'))
    w.tagRecWorkbench.trials = [replayed]
    await Promise.resolve()
    expect(tagRecCustomSession.workingGroup?.combination?.exclude).toHaveLength(1)
    expect(tagRecCustomSession.workingGroup?.combination?.include.children).toEqual([])
    expect(current.group.combination!.include.children).toHaveLength(1)
  })
  it('仅看这个标签：原组合原位换出记入最近尝试并带走暂选，新试验只剩该标签，恢复带回暂选', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    w.addTagRecWorkingCondition(tagRecConditionAtom('title', '三体'))
    const oldId = w.tagRecWorkbench.activeId
    tagRecDiscoveryUi.videoTrialId = oldId
    tagRecDiscoveryUi.video = JSON.parse('{"bvid":"BV1"}') as TagRecItemExtend
    stageTagRecMaterial(oldId, { atom: tagRecConditionAtom('desc', '动画'), name: '动画', source: '视频' })
    expect(w.exploreTagRecTagOnly({ id: 3, name: '罗辑' })).toBe(true)
    const banked = w.tagRecWorkbench.recent[0]
    expect(banked).toBeTruthy()
    expect(tagRecConditionAtoms(banked.group.combination!.include).map((a) => a.field)).toEqual(['tag', 'title'])
    const cur = w.currentTagRecTrial()!
    expect(cur.id).not.toBe(oldId)
    expect(cur.name).toBe('罗辑')
    expect(cur.originId).toBeUndefined()
    expect(w.tagRecWorkbench.trials).toHaveLength(1)
    const atoms = tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)
    expect(atoms).toHaveLength(1)
    expect(atoms[0].field).toBe('tag')
    expect(atoms[0].value).toMatchObject({ id: 3, name: '罗辑' })
    expect(tagRecCustomSession.workingGroup!.tag_ids).toEqual([{ id: 3, name: '罗辑' }])
    expect(tagRecDiscoveryUi.video).toBeUndefined()
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === oldId)?.pending).toBeUndefined()
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === cur.id)?.pending).toBeUndefined()
    expect(banked.pending).toHaveLength(1)
    expect(tagRecDiscoveryUi.materialQuery).toEqual({ text: '罗辑', field: 'tag' })
    const revived = w.openTagRecRecent(banked)!
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(
      tagRecCombinationSignature(banked.group.combination!),
    )
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === revived.id)?.pending).toHaveLength(1)
    expect(banked.pending).toHaveLength(1)
  })
  it('弹层 #id 深链开新组合：追加新试验并激活，原试验记入最近尝试，无空壳中间态', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    const oldId = w.tagRecWorkbench.activeId
    expect(w.seedTagRecNewTrialWithTag({ id: 9, name: '罗辑' })).toBe(true)
    // 追加而非原位替换: 原试验进最近尝试, 书架现在两条试验
    expect(w.tagRecWorkbench.recent).toHaveLength(1)
    expect(tagRecConditionAtoms(w.tagRecWorkbench.recent[0].group.combination!.include).map((a) => a.field)).toEqual([
      'tag',
    ])
    expect(w.tagRecWorkbench.trials).toHaveLength(2)
    const cur = w.currentTagRecTrial()!
    expect(cur.id).not.toBe(oldId)
    expect(cur.name).toBe('罗辑')
    const atoms = tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)
    expect(atoms).toHaveLength(1)
    expect(atoms[0].field).toBe('tag')
    expect(atoms[0].value).toMatchObject({ id: 9, name: '罗辑' })
    expect(tagRecDiscoveryUi.materialQuery).toEqual({ text: '罗辑', field: 'tag' })
    // 深链 id 缺/坏 => 拒绝且不产生任何试验/归档
    const recentLen = w.tagRecWorkbench.recent.length
    expect(w.seedTagRecNewTrialWithTag({ id: 0, name: '' })).toBe(false)
    expect(w.tagRecWorkbench.activeId).toBe(cur.id)
    expect(w.tagRecWorkbench.recent).toHaveLength(recentLen)
  })
  it('全局排除的标签拒绝开新组合：不落试验、不归档原组合', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    const oldId = w.tagRecWorkbench.activeId
    blockTagRecConditionGlobally(tagRecConditionAtom('tag', { id: 9, name: '广告' }))
    expect(w.seedTagRecNewTrialWithTag({ id: 9, name: '广告' })).toBe(false)
    expect(w.tagRecWorkbench.activeId).toBe(oldId)
    expect(w.tagRecWorkbench.trials).toHaveLength(1)
    expect(w.tagRecWorkbench.recent).toHaveLength(0)
    expect(tagRecDiscoveryUi.materialQuery).toBeUndefined()
  })
  it('全局排除与未解析的标签拒绝仅看，原组合与暂选不动', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '程心' }))
    const id = w.tagRecWorkbench.activeId
    stageTagRecMaterial(id, { name: '词', source: '视频' })
    blockTagRecConditionGlobally(tagRecConditionAtom('tag', { id: 9, name: '广告' }))
    const recentLen = w.tagRecWorkbench.recent.length
    expect(w.exploreTagRecTagOnly({ id: 9, name: '广告' })).toBe(false)
    expect(w.onlyTagRecTag({ id: 0, name: '' })).toBe(false)
    expect(w.tagRecWorkbench.activeId).toBe(id)
    expect(w.tagRecWorkbench.recent).toHaveLength(recentLen)
    expect(tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)).toHaveLength(1)
    expect(w.tagRecWorkbench.trials.find((entry) => entry.id === id)?.pending).toHaveLength(1)
    expect(tagRecDiscoveryUi.materialQuery).toBeUndefined()
  })
  it('素材名未解析可拒绝；空组合有暂选时一同归档，不串入新试验', async () => {
    const id = w.tagRecWorkbench.activeId
    stageTagRecMaterial(id, { name: '词', source: '视频' })
    vi.mocked(fetchTagInfoByName).mockResolvedValue(undefined)
    expect(await w.exploreTagRecMaterialOnly({ name: '未知', source: '共现' })).toBe(false)
    expect(w.tagRecWorkbench.activeId).toBe(id)
    vi.mocked(fetchTagInfoByName).mockResolvedValue({ id: 7, name: '云天明', tag_type: 'topic' })
    expect(await w.exploreTagRecMaterialOnly({ name: '云天明', source: '共现' })).toBe(true)
    expect(w.tagRecWorkbench.recent).toHaveLength(1)
    expect(w.tagRecWorkbench.recent[0].pending?.map((m) => m.name)).toEqual(['词'])
    expect(tagRecConditionAtoms(tagRecCustomSession.workingGroup!.combination!.include)).toHaveLength(1)
  })
  it('更新原旧组时移除旧负向镜像，排除可真正撤回；改回自动归属也生效', () => {
    const original = favorites.addGroup({
      name: '旧组',
      tag_ids: [{ id: 1, name: '三体' }],
      negative_tag_ids: [{ id: 2, name: '动画' }],
    })!.group
    const oldParent = original.l1Id
    w.openTagRecFavorite(original)
    w.removeTagRecWorkingCondition(tagRecCustomSession.workingGroup!.combination!.exclude[0].id)
    w.editTagRecWorkingGroup((g) => {
      g.l1Id = undefined
    })
    w.saveTagRecWorkingGroup('新名字', true)
    expect(original.combination!.exclude).toEqual([])
    expect(original.negative_tag_ids).toBeUndefined()
    expect(original.l1Id).not.toBe(oldParent)
    expect(original.enabled).toBe(true)
  })
  it('「移到…」把条件挪进指定组且一步可撤销; 已在该组/无此组/同键重复都不动', () => {
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '三国演义' }))
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 2, name: '新三国' }))
    const include = () => tagRecCustomSession.workingGroup!.combination!.include
    const tagRow = () =>
      include().children.find((child): child is TagRecConditionGroup => child.kind === 'group' && child.name === 'tag')!
    const dest = () =>
      include().children.find((child): child is TagRecConditionGroup => child.kind === 'group' && child.id === 'dest')!
    const tagRowId = tagRow().id
    const atomId = () => tagRow().children.at(0)!.id
    w.editTagRecWorkingGroup((group) =>
      group.combination!.include.children.push({
        kind: 'group',
        id: 'dest',
        mode: 'any',
        name: '条件组',
        children: [],
      }),
    )
    expect(w.moveTagRecWorkingCondition(atomId(), tagRowId)).toBe(false)
    expect(w.moveTagRecWorkingCondition(atomId(), 'ghost')).toBe(false)
    expect(w.moveTagRecWorkingCondition(atomId(), 'dest')).toBe(true)
    expect(dest().children).toHaveLength(1)
    expect((dest().children.at(0) as TagRecConditionAtom).value).toMatchObject({ name: '三国演义' })
    expect(tagRow().children).toHaveLength(1)
    w.undoTagRecWorkingGroup()
    expect(tagRow().children).toHaveLength(2)
    expect(dest().children).toHaveLength(0)
    // 'new': 挪进新建顶层子组; 已删空的状态不连累旁边的空落点组
    expect(w.moveTagRecWorkingCondition(atomId(), 'new')).toBe(true)
    const born = include().children.find(
      (child): child is TagRecConditionGroup =>
        child.kind === 'group' && child.name === '条件组' && child.id !== 'dest',
    )!
    expect(born.children).toHaveLength(1)
    expect(tagRow().children).toHaveLength(1)
    expect(findTagRecCondition(include(), 'dest')).toBeTruthy()
    // 同键重复: 同值条件再加会回字段组, 移到已含同键的组被拒
    w.addTagRecWorkingCondition(tagRecConditionAtom('tag', { id: 1, name: '三国演义' }))
    const dup = tagRow().children.find(
      (child) =>
        (child as TagRecConditionAtom).kind === 'atom' &&
        ((child as TagRecConditionAtom).value as { name: string }).name === '三国演义',
    )!
    expect(w.moveTagRecWorkingCondition(dup.id, born.id)).toBe(false)
    expect(tagRow().children).toHaveLength(2)
  })
})

describe('收藏组整组导入', () => {
  let tagSeq = 1000
  const tag = (name: string) => tagRecConditionAtom('tag', { id: ++tagSeq, name })
  const include = () => tagRecCustomSession.workingGroup!.combination!.include as TagRecConditionGroup
  /** 源组: all{ A, any{ B, C } } —— 带一层嵌套的树 */
  const nestedSource = () => {
    const comb = newTagRecCombination()
    comb.include.children.push(tag('A'), {
      kind: 'group',
      id: crypto.randomUUID(),
      mode: 'any',
      children: [tag('B'), tag('C')],
    })
    return comb
  }
  const graftedRoot = () => include().children.filter((child): child is TagRecConditionGroup => child.kind === 'group')

  it('导入保留 all/any 嵌套结构而不是摊平成根级原子', () => {
    expect(importTagRecFavoriteCombinations([nestedSource()])).toBe(1)
    const grafted = graftedRoot()
    expect(grafted).toHaveLength(1)
    expect(grafted[0].mode).toBe('all')
    expect(grafted[0].children).toHaveLength(2)
    const [firstChild, inner] = grafted[0].children as [TagRecConditionAtom, TagRecConditionGroup]
    expect(firstChild.kind).toBe('atom')
    expect(inner.kind).toBe('group')
    expect(inner.mode).toBe('any')
    expect(tagRecConditionAtoms(inner).map((a) => (a.value as { name: string }).name)).toEqual(['B', 'C'])
  })

  it('嫁接节点全树换 id：同源重复导入不冲突，源树自身不被改动', () => {
    const source = nestedSource()
    const srcIds = [
      source.include.id,
      ...tagRecConditionAtoms(source.include).map((a) => a.id),
      ...source.include.children.map((c) => c.id),
    ]
    expect(importTagRecFavoriteCombinations([source])).toBe(1)
    const firstIds = new Set(graftedRoot().flatMap((g) => [g.id, ...tagRecConditionAtoms(g).map((a) => a.id)]))
    for (const id of firstIds) expect(srcIds).not.toContain(id)
    // 源组合不变 (深拷贝)
    expect(tagRecConditionAtoms(source.include)).toHaveLength(3)
    expect(importTagRecFavoriteCombinations([source])).toBe(1)
    expect(graftedRoot()).toHaveLength(2)
    expect(validateTagRecCombination(tagRecCustomSession.workingGroup!.combination)).toBe(true)
  })

  it('exclude 按 key 去重并入, filters 并入', () => {
    const source = nestedSource()
    source.exclude.push(tag('负面词'))
    source.filters = { dims: { viewMin: { enabled: true, value: 1000 } } }
    expect(importTagRecFavoriteCombinations([source])).toBe(1)
    const working = tagRecCustomSession.workingGroup!.combination!
    expect(working.exclude).toHaveLength(1)
    expect(working.filters?.dims?.viewMin).toEqual({ enabled: true, value: 1000 })
    // 再导一次同键排除条件不重复
    expect(importTagRecFavoriteCombinations([source])).toBe(1)
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(1)
  })

  it('显式落点：整棵树落进目标子组内部', () => {
    w.addTagRecWorkingCondition(tag('宿主'))
    const host = include().children.find((child): child is TagRecConditionGroup => child.kind === 'group')
    expect(host).toBeTruthy()
    expect(importTagRecFavoriteCombinations([nestedSource()], host!.id)).toBe(1)
    // editTagRecWorkingGroup 深拷贝提交: 重新按 id 查树, 不能沿用旧引用
    const hostAfter = findTagRecCondition(include(), host!.id) as TagRecConditionGroup
    const landed = hostAfter.children.find((child): child is TagRecConditionGroup => child.kind === 'group')
    expect(landed).toBeTruthy()
    expect(tagRecConditionAtoms(landed!).map((a) => (a.value as { name: string }).name)).toEqual(['A', 'B', 'C'])
    // 未指定落点时不该再塞进宿主
    expect(importTagRecFavoriteCombinations([nestedSource()])).toBe(1)
    expect(tagRecConditionAtoms(include()).length).toBe(7)
  })

  it('空源与超预算源跳过且不污染既有组合', () => {
    w.addTagRecWorkingCondition(tag('已有'))
    const signature = tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)
    expect(importTagRecFavoriteCombinations([newTagRecCombination()])).toBe(0)
    // 塞满预算: include 原子+exclude 合计 128 封顶
    const fat = newTagRecCombination()
    for (let i = 0; i < 200; i++) fat.include.children.push(tag(`爆${i}`))
    expect(importTagRecFavoriteCombinations([fat])).toBe(0)
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(signature)
  })

  it('graftTagRecConditionTree: atom 直接拒绝, 落点不存在拒绝', () => {
    const comb = newTagRecCombination()
    expect(graftTagRecConditionTree(comb, tag('x'))).toBe(false)
    const source = nestedSource()
    expect(graftTagRecConditionTree(comb, source.include, '不存在的id')).toBe(false)
    expect(comb.include.children).toHaveLength(0)
  })
})

describe('整组导入的安全闸', () => {
  let tagSeq = 2000
  const tag = (name: string) => tagRecConditionAtom('tag', { id: ++tagSeq, name })
  const include = () => tagRecCustomSession.workingGroup!.combination!.include as TagRecConditionGroup
  const sourceOf = (...atoms: TagRecConditionAtom[]) => {
    const comb = newTagRecCombination()
    comb.include.children.push(...atoms)
    return comb
  }
  const names = () =>
    tagRecConditionAtoms(include())
      .map((a) => (a.value as { name: string }).name)
      .sort()

  it('全局拉黑的词在导入时被剪掉，其余结构保留', () => {
    const sensitive = tag('敏感词')
    blockTagRecConditionGlobally(sensitive)
    expect(importTagRecFavoriteCombinations([sourceOf(tag('甲'), sensitive)])).toBe(1)
    expect(names()).toEqual(['甲'])
  })

  it('源组全部原子都被拉黑 → 零变化不计数，工作区原样', () => {
    w.addTagRecWorkingCondition(tag('已有'))
    const signature = tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)
    const allBlocked = tag('全部')
    blockTagRecConditionGlobally(allBlocked)
    expect(importTagRecFavoriteCombinations([sourceOf(allBlocked)])).toBe(0)
    expect(tagRecCombinationSignature(tagRecCustomSession.workingGroup!.combination!)).toBe(signature)
  })

  it('工作区已排除的词不能作为正向条件被导入', () => {
    const excluded = tag('已排除')
    w.excludeTagRecWorkingCondition(excluded)
    expect(importTagRecFavoriteCombinations([sourceOf(tag('保留'), excluded)])).toBe(1)
    expect(names()).toEqual(['保留'])
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(1)
  })

  it('源组 exclude 的原子会拔掉工作区里已有的同键正原子', () => {
    const toExclude = tag('要排除')
    w.addTagRecWorkingCondition(toExclude)
    const source = sourceOf(tag('顺带'))
    source.exclude.push(toExclude)
    expect(importTagRecFavoriteCombinations([source])).toBe(1)
    expect(names()).toEqual(['顺带'])
    expect(tagRecCustomSession.workingGroup!.combination!.exclude).toHaveLength(1)
  })
})
