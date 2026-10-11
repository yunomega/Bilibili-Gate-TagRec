import { cloneDeep } from 'es-toolkit'
import { subscribe } from 'valtio'
import toast from '$utility/toast'
import { fetchTagInfoById, fetchTagInfoByName } from '../api/endpoints'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  findTagRecCondition,
  hasTagRecCombination,
  nameTagRecCombination,
  newTagRecCombination,
  prepareTagRecWorkingGroup,
  removeTagRecCondition,
  tagRecCombinationOverflows,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  tagRecWorkingGroupSignature,
  validateTagRecCombination,
  type TagRecConditionAtom,
} from '../model/combination'
import { favorites, favoritesL1, tagRecStoresHydrated } from './index'
import { tagRecCombinationBlocks } from './combination-blocks'
import { requestTagRecMaterialSearch, tagRecDiscoveryUi, type TagRecMaterial } from './discovery-ui'
import { tagRecCustomSession } from './session'
import { currentTagRecTrial, tagRecWorkbench, tagRecWorkbenchStateHydrated, type TagRecTrial } from './workbench-state'
import type { TagGroup, TagIdEntry } from '../model/types'
export { currentTagRecTrial, tagRecWorkbench, type TagRecTrial } from './workbench-state'

export const tagRecWorkbenchHydrated = Promise.all([tagRecWorkbenchStateHydrated, tagRecStoresHydrated])
const undo = new Map<string, TagGroup[]>()
let activated = false
let writing = false
let lastPatch = ''
let lastSynchronizedTrial = ''
export const TAG_REC_WORKING_GROUP_ID = '__tagrec_working__'

function workingGroup(source?: TagGroup): TagGroup {
  // 扁平大组无法无损转组合: 静默截断会在「更新原二级组」时抹掉成员 —— 拒载并开新试验
  const usable = source && tagRecCombinationOverflows(source) ? undefined : source
  if (source && !usable) toast(`「${source.name}」标签数超过组合节点上限，无法载入条件编辑器；已开新试验`)
  const group: TagGroup = usable
    ? prepareTagRecWorkingGroup(usable)
    : {
        id: TAG_REC_WORKING_GROUP_ID,
        name: '新试验',
        tag_ids: [],
        enabled: true,
        weight: 1,
        addedAt: Date.now(),
      }
  group.id = TAG_REC_WORKING_GROUP_ID
  group.enabled = true
  group.combination ??= newTagRecCombination()
  return group
}
function remember(trial: TagRecTrial) {
  if (!validateTagRecCombination(trial.group?.combination)) return
  if (!hasTagRecCombination(trial.group.combination) && !trial.pending?.length) return
  const signature = (entry: TagRecTrial) =>
    JSON.stringify([tagRecWorkingGroupSignature(entry.group), entry.pending ?? []])
  const sig = signature(trial)
  tagRecWorkbench.recent = [
    { ...cloneDeep(trial), id: crypto.randomUUID() },
    ...tagRecWorkbench.recent.filter((entry) => !entry.group?.combination || signature(entry) !== sig),
  ]
  // Completed history is bounded; unfinished selections must never be evicted.
  let completed = 0
  tagRecWorkbench.recent = tagRecWorkbench.recent.filter((entry) => entry.pending?.length || ++completed <= 30)
}
function synchronize() {
  const trial = currentTagRecTrial()
  if (!trial) return
  writing = true
  try {
    const tags = tagRecCombinationTagIds(trial.group.combination!)
    if (JSON.stringify(trial.group.tag_ids) !== JSON.stringify(tags)) trial.group.tag_ids = tags
    // 工作副本组名随试验显示名 —— 徽标/归因回落显示用户认识的试验名, 不再是默认占位名 (新试验)
    if (trial.group.name !== trial.name) trial.group.name = trial.name
    tagRecCustomSession.inputText = ''
    tagRecCustomSession.anchor = undefined
    tagRecCustomSession.draftGroup = undefined
    tagRecCustomSession.selectedGroupIds = []
    tagRecCustomSession.expandedIds = []
    tagRecCustomSession.workingGroup = trial.group
    tagRecCustomSession.filterOverride = cloneDeep(trial.group.combination?.filters)
    // D06: 条件变更/切试验恢复默认暂存 —— 显式临时查看不跨组合版本延续
    tagRecCustomSession.allowUnverified = false
    tagRecCustomSession.queryRevision++
    lastPatch = JSON.stringify(tagRecCustomSession.filterOverride)
    lastSynchronizedTrial = JSON.stringify([trial.id, trial.group])
  } finally {
    writing = false
  }
}
export async function activateTagRecWorkbench(): Promise<void> {
  if (activated) return
  await tagRecWorkbenchHydrated
  if (activated) return
  activated = true
  // Reject incompatible/malformed conditions instead of restoring a broader query.
  if (
    !Array.isArray(tagRecWorkbench.trials) ||
    !Array.isArray(tagRecWorkbench.recent) ||
    tagRecWorkbench.version !== 1
  ) {
    toast('本地组合格式不兼容，原数据已保留，请升级插件')
    return
  }
  const validTrials = tagRecWorkbench.trials.filter(
    (trial) => trial?.group?.combination && validateTagRecCombination(trial.group.combination),
  )
  if (validTrials.length !== tagRecWorkbench.trials.length) toast('部分试验条件不兼容，原数据已保留；请升级后再打开')
  if (!validTrials.length) {
    const selected = favorites.list.find((group) => group.id === tagRecCustomSession.selectedGroupIds[0])
    const group = workingGroup(selected)
    if (!selected && tagRecCustomSession.anchor)
      addTagRecCondition(group.combination!, {
        kind: 'atom',
        id: crypto.randomUUID(),
        field: 'tag',
        value: cloneDeep(tagRecCustomSession.anchor),
      })
    if (!selected && tagRecCustomSession.draftGroup) {
      const draft = tagRecCustomSession.draftGroup
      const prepared = prepareTagRecWorkingGroup({
        ...group,
        negative_tag_ids: draft.negative_tag_ids,
        overrides: { negative: draft.negative },
      })
      group.combination = prepared.combination
    }
    if (!selected && tagRecCustomSession.filterOverride)
      group.combination!.filters = cloneDeep(tagRecCustomSession.filterOverride)
    for (const tag of tagRecCustomSession.expandedIds)
      addTagRecCondition(group.combination!, {
        kind: 'atom',
        id: crypto.randomUUID(),
        field: 'tag',
        value: cloneDeep(tag),
      })
    const trial = { id: crypto.randomUUID(), name: selected?.name ?? '新试验', originId: selected?.id, group }
    tagRecWorkbench.trials.push(trial)
    tagRecWorkbench.activeId = trial.id
  }
  if (!currentTagRecTrial()?.group.combination || !validateTagRecCombination(currentTagRecTrial()!.group.combination))
    tagRecWorkbench.activeId = validTrials[0]?.id ?? tagRecWorkbench.trials.at(-1)!.id
  synchronize()
}
export function editTagRecWorkingGroup(change: (group: TagGroup) => void): boolean {
  const trial = currentTagRecTrial()
  if (!trial) return false
  const previous = cloneDeep(trial.group)
  const next = cloneDeep(previous)
  change(next)
  if (!next.combination || !validateTagRecCombination(next.combination)) {
    toast('条件过多、嵌套过深或条件不完整，请先简化组合')
    return false
  }
  if (JSON.stringify(next) === JSON.stringify(previous)) return false
  // Q5b 本地先行: 正向条件增长 (加词) => 先吃本地可交付存量 (零请求), 远程取数等耗尽或显式查找
  //   (清位在 beginTagRecCustomQuery) —— 低频标题/简介词点击不再立即引发请求风暴。
  if (
    tagRecConditionAtoms(next.combination!.include).length > tagRecConditionAtoms(previous.combination!.include).length
  )
    tagRecCustomSession.localFirst = true
  // A: 组合实质变化 => 把变化前的组合自动记入最近尝试 (去重有界)，支持「随时改、随时回退」
  remember({ id: trial.id, name: trial.name, group: cloneDeep(previous) })
  const stack = undo.get(trial.id) ?? []
  stack.push(previous)
  undo.set(trial.id, stack.slice(-30))
  trial.group = next
  synchronize()
  return true
}
export function addTagRecWorkingCondition(atom: TagRecConditionAtom, target?: string) {
  if (tagRecCombinationBlocks.list.some((entry) => tagRecConditionKey(entry) === tagRecConditionKey(atom))) {
    toast('此条件已被全局排除，请先在「更多」中解除')
    return false
  }
  if (
    currentTagRecTrial()?.group.combination?.exclude.some(
      (entry) => tagRecConditionKey(entry) === tagRecConditionKey(atom),
    )
  ) {
    toast('此条件已被本组合排除，请先移除排除条件')
    return false
  }
  return editTagRecWorkingGroup((group) => {
    addTagRecCondition(group.combination!, atom, target)
  })
}
export function excludeTagRecWorkingCondition(atom: TagRecConditionAtom) {
  return editTagRecWorkingGroup((group) => {
    tagRecConditionAtoms(group.combination!.include)
      .filter((a) => tagRecConditionKey(a) === tagRecConditionKey(atom))
      .forEach((a) => removeTagRecCondition(group.combination!, a.id))
    excludeTagRecCondition(group.combination!, atom)
  })
}
export function removeTagRecWorkingCondition(id: string) {
  return editTagRecWorkingGroup((group) => {
    removeTagRecCondition(group.combination!, id)
  })
}
/** 药丸菜单「移到…」: 把条件挪进指定组; 'new' = 新建顶层子组收编。单次编辑 => 只占一条撤销/最近尝试记录 */
export function moveTagRecWorkingCondition(atomId: string, target: string | 'new'): boolean {
  const include = currentTagRecTrial()?.group.combination?.include
  const atom = include ? findTagRecCondition(include, atomId) : undefined
  if (atom?.kind !== 'atom') return false
  return editTagRecWorkingGroup((group) => {
    const combination = group.combination!
    if (target === 'new') {
      removeTagRecCondition(combination, atomId)
      combination.include.children.push({
        kind: 'group',
        id: crypto.randomUUID(),
        mode: 'any',
        name: '条件组',
        children: [{ ...cloneDeep(atom), id: crypto.randomUUID() }],
      })
      return
    }
    const destination = findTagRecCondition(combination.include, target)
    if (destination?.kind !== 'group') return
    if (destination.children.some((child) => child.id === atomId)) return
    if (
      destination.children.some(
        (child) => child.kind === 'atom' && tagRecConditionKey(child) === tagRecConditionKey(atom),
      )
    ) {
      toast('该组已有相同条件')
      return
    }
    removeTagRecCondition(combination, atomId)
    destination.children.push({ ...cloneDeep(atom), id: crypto.randomUUID() })
  })
}
export function undoTagRecWorkingGroup(): boolean {
  const trial = currentTagRecTrial()
  const previous = trial && undo.get(trial.id)?.pop()
  if (!trial || !previous) return false
  trial.group = previous
  synchronize()
  return true
}
export function newTagRecTrial(source?: TagGroup, originId?: string, label?: string, seed?: TagRecConditionAtom) {
  const current = currentTagRecTrial()
  if (current) remember(current)
  const group = workingGroup(source)
  // seed (弹层 #id 深链等新试验入口): 条件在试验诞生时就位 —— 避免「空壳试验」作为中间态记入最近尝试
  if (seed) addTagRecCondition(group.combination!, seed)
  if (!validateTagRecCombination(group.combination)) {
    toast('组合条件不兼容，原数据已保留')
    return
  }
  const trial: TagRecTrial = { id: crypto.randomUUID(), name: label || source?.name || '新试验', originId, group }
  tagRecWorkbench.trials.push(trial)
  if (tagRecWorkbench.trials.length > 8) {
    const oldest = tagRecWorkbench.trials[0]
    remember(oldest)
    undo.delete(oldest.id)
    tagRecWorkbench.trials = tagRecWorkbench.trials.slice(1)
    toast('最早的试验已移到最近尝试，条件和暂选均已保留')
  }
  tagRecWorkbench.activeId = trial.id
  synchronize()
  return trial
}
export function openTagRecFavorite(group: TagGroup) {
  if (group.combination && !validateTagRecCombination(group.combination)) {
    toast('这份组合条件不兼容，请升级插件后重试')
    return
  }
  return newTagRecTrial(group, group.id, group.name)
}
/**
 * 「仅看这个标签」: 当前组合记入最近尝试 (未提交暂选随之挂到该条, openTagRecRecent 可取回),
 *   原位换成只含该标签的新试验 —— 深挖/共现管线随 synchronize 的生效签名自动重启。
 *   全局排除/未解析直接拒绝, 当前组合不动。
 */
export function onlyTagRecTag(entry: TagIdEntry): boolean {
  const trial = currentTagRecTrial()
  if (!trial || !entry?.id || !entry.name) return false
  const index = tagRecWorkbench.trials.findIndex((t) => t.id === trial.id)
  if (index === -1) return false
  const atom = tagRecConditionAtom('tag', { id: entry.id, name: entry.name, tag_type: entry.tag_type })
  if (tagRecCombinationBlocks.list.some((a) => tagRecConditionKey(a) === tagRecConditionKey(atom))) {
    toast(`「${entry.name}」在「以后都不看」里，先在「更多」里解除全局排除`)
    return false
  }
  const group = workingGroup()
  addTagRecCondition(group.combination!, atom)
  if (!validateTagRecCombination(group.combination)) return false
  if (tagRecDiscoveryUi.videoTrialId === trial.id) {
    tagRecDiscoveryUi.video = undefined
    tagRecDiscoveryUi.videoTrialId = ''
  }
  remember(trial)
  const bankedIsOurs = hasTagRecCombination(trial.group.combination) || !!trial.pending?.length
  const next: TagRecTrial = { id: crypto.randomUUID(), name: entry.name, group }
  tagRecWorkbench.trials[index] = next
  undo.delete(trial.id)
  tagRecWorkbench.activeId = next.id
  synchronize()
  toast(bankedIsOurs ? `仅看「${entry.name}」· 原组合记入最近尝试` : `仅看「${entry.name}」`)
  return true
}
/** 仅看 + 打开该标签的素材解析 (共现/同形/视频字段) —— UI 各入口共用的完整动作 */
export function exploreTagRecTagOnly(entry: TagIdEntry): boolean {
  if (!onlyTagRecTag(entry)) return false
  requestTagRecMaterialSearch(entry.name)
  return true
}
/**
 * 弹层 #tag_id 深链落地: 在既有试验之外「开新组合」—— 新试验追加进书架并激活
 * (原试验照常记入最近尝试, 不像「仅看」那样原位替换), 条件即该标签原子, 顺带触发素材解析。
 */
export function seedTagRecNewTrialWithTag(entry: TagIdEntry): boolean {
  if (!entry?.id || !entry.name) return false
  const atom = tagRecConditionAtom('tag', { id: entry.id, name: entry.name, tag_type: entry.tag_type })
  if (tagRecCombinationBlocks.list.some((a) => tagRecConditionKey(a) === tagRecConditionKey(atom))) {
    toast(`「${entry.name}」在「以后都不看」里，先在「更多」里解除全局排除`)
    return false
  }
  if (!newTagRecTrial(undefined, undefined, entry.name, atom)) return false
  requestTagRecMaterialSearch(entry.name)
  return true
}
/** 素材行入口: 未解析素材先按 tagId/名称补 tag 实体再仅看 (与 select 的惰性解析同口径) */
export async function exploreTagRecMaterialOnly(material: TagRecMaterial): Promise<boolean> {
  const trialId = tagRecWorkbench.activeId
  const revision = tagRecCustomSession.queryRevision
  const signature = currentTagRecTrial() && tagRecWorkingGroupSignature(currentTagRecTrial()!.group)
  let entry = material.atom?.field === 'tag' ? cloneDeep(material.atom.value) : undefined
  if (!entry && material.filter) return false // 过滤补丁素材不是标签, 无可仅看对象
  if (!entry) {
    const info = await (material.tagId ? fetchTagInfoById(material.tagId) : fetchTagInfoByName(material.name)).catch(
      () => undefined,
    )
    if (!info) {
      toast('暂时未解析到这个标签，可稍后重试')
      return false
    }
    entry = { id: info.id, name: info.name, tag_type: info.tag_type }
  }
  if (
    trialId !== tagRecWorkbench.activeId ||
    revision !== tagRecCustomSession.queryRevision ||
    signature !== tagRecWorkingGroupSignature(currentTagRecTrial()!.group)
  )
    return false
  return exploreTagRecTagOnly(entry)
}
/** 最近尝试 => 开新试验; 「仅看」记账时挂上的暂选一并对号取回 */
export function openTagRecRecent(entry: TagRecTrial): TagRecTrial | undefined {
  const trial = newTagRecTrial(entry.group, entry.originId, entry.name)
  if (!trial) return
  trial.pending = cloneDeep(entry.pending ?? [])
  return trial
}
export function switchTagRecTrial(id: string) {
  if (id === tagRecWorkbench.activeId) return true
  const current = currentTagRecTrial()
  if (current) remember(current)
  const target = tagRecWorkbench.trials.find((trial) => trial.id === id)
  if (!target) return false
  if (!validateTagRecCombination(target.group?.combination)) {
    toast('组合条件不兼容，原数据已保留')
    return false
  }
  tagRecWorkbench.activeId = id
  synchronize()
  return true
}
export function closeTagRecTrial(id: string) {
  const trial = tagRecWorkbench.trials.find((entry) => entry.id === id)
  if (trial) remember(trial)
  tagRecWorkbench.trials = tagRecWorkbench.trials.filter((entry) => entry.id !== id)
  undo.delete(id)
  if (!tagRecWorkbench.trials.length) newTagRecTrial()
  else if (tagRecWorkbench.activeId === id) {
    tagRecWorkbench.activeId = tagRecWorkbench.trials[0].id
    synchronize()
  }
}
export function saveTagRecWorkingGroup(name?: string, updateOriginal = false): TagGroup | undefined {
  const trial = currentTagRecTrial()
  if (!trial?.group.combination || !hasTagRecCombination(trial.group.combination)) {
    toast('请先选入内容条件或调整过滤')
    return
  }
  const group = cloneDeep(trial.group)
  group.name = name?.trim() || nameTagRecCombination(group.combination!)
  group.tag_ids = tagRecCombinationTagIds(group.combination!)
  if (updateOriginal && trial.originId) {
    const original = favorites.list.find((entry) => entry.id === trial.originId)
    if (!original) {
      toast('原二级组已移除，请另存')
      return
    }
    Object.assign(original, {
      name: group.name,
      combination: group.combination,
      tag_ids: group.tag_ids,
      overrides: group.overrides,
    })
    delete original.negative_tag_ids
    delete original.negative_strict
    if (group.l1Id !== original.l1Id) {
      const parent = favoritesL1.assignGroupToL1(original.id, group.l1Id)
      if (parent) trial.group.l1Id = parent.id
    }
    toast('已更新原二级组')
    return original
  }
  const existing = favorites.list.find(
    (entry) =>
      entry.combination &&
      entry.l1Id === group.l1Id &&
      tagRecWorkingGroupSignature(entry) === tagRecWorkingGroupSignature(group),
  )
  if (existing) {
    trial.originId = existing.id
    toast('这份完整条件已收藏')
    return existing
  }
  const result = favorites.addGroup({
    name: group.name,
    l1Id: group.l1Id,
    tag_ids: group.tag_ids,
    combination: group.combination,
    overrides: group.overrides,
    enabled: true,
  })
  if (!result) return
  trial.originId = result.group.id
  trial.group.l1Id = result.group.l1Id
  trial.name = result.group.name
  remember(trial)
  toast(
    result.l1.enabled ? '已存为二级组，继续试改保留原收藏' : '已存为二级组；主题推荐中需开启所属一级组，这里可直接试看',
  )
  return result.group
}

// The existing complete filter panel still writes sparse session differences.
// Mirror those explicit choices into the working recipe without freezing inherited defaults.
subscribe(
  tagRecCustomSession,
  () => {
    if (!activated || writing) return
    const json = JSON.stringify(tagRecCustomSession.filterOverride)
    if (json === lastPatch) return
    lastPatch = json
    const trial = currentTagRecTrial()
    if (!trial?.group.combination) return
    const next = { ...cloneDeep(trial.group.combination), filters: cloneDeep(tagRecCustomSession.filterOverride) }
    if (!validateTagRecCombination(next)) {
      toast('本组合的过滤条件已达上限或格式不完整，本次调整未保存')
      writing = true
      tagRecCustomSession.filterOverride = cloneDeep(trial.group.combination.filters)
      lastPatch = JSON.stringify(tagRecCustomSession.filterOverride)
      writing = false
      return
    }
    const stack = undo.get(trial.id) ?? []
    stack.push(cloneDeep(trial.group))
    undo.set(trial.id, stack.slice(-30))
    // 过滤/池改动与条件改动同等对待: 变化前的组合也要进最近尝试, 否则改完过滤列表不动
    remember({ id: trial.id, name: trial.name, group: cloneDeep(trial.group) })
    trial.group.combination = next
    // D06: 过滤/池改动同属条件变更 —— 显式临时查看随组合版本重置为默认暂存
    tagRecCustomSession.allowUnverified = false
    lastSynchronizedTrial = JSON.stringify([trial.id, trial.group])
  },
  true,
)

// GM replay replaces trial objects. Keep the preview attached to the replayed recipe;
// remembering a local edit must not reset temporary viewing or echo another GM write.
subscribe(tagRecWorkbench, () => {
  if (!activated || writing) return
  const trial = currentTagRecTrial()
  if (!trial || !validateTagRecCombination(trial.group?.combination)) return
  const next = JSON.stringify([trial.id, trial.group])
  if (next !== lastSynchronizedTrial) synchronize()
})
