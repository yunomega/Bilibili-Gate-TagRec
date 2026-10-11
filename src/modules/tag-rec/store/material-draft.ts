import { cloneDeep } from 'es-toolkit'
import toast from '$utility/toast'
import { fetchTagInfoById, fetchTagInfoByName } from '../api/endpoints'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  findTagRecCondition,
  graftTagRecConditionTree,
  mergeTagRecCombinationFilters,
  newTagRecCombination,
  removeTagRecCondition,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  tagRecWorkingGroupSignature,
  validateTagRecCombination,
  type TagRecCombination,
} from '../model/combination'
import { tagRecCombinationBlocks } from './combination-blocks'
import { tagRecCustomSession } from './session'
import { currentTagRecTrial, editTagRecWorkingGroup, tagRecWorkbench } from './workbench'
import type { TagRecMaterial } from './workbench-state'

async function resolve(material: TagRecMaterial): Promise<TagRecMaterial | undefined> {
  if (material.atom || material.filter) return material
  const info = await (material.tagId ? fetchTagInfoById(material.tagId) : fetchTagInfoByName(material.name)).catch(
    () => undefined,
  )
  return info
    ? { ...material, atom: tagRecConditionAtom('tag', { id: info.id, name: info.name, tag_type: info.tag_type }) }
    : undefined
}

/** Apply accepted items together. Conflicts and over-limit items stay pending. */
function apply(materials: TagRecMaterial[], target?: string) {
  const accepted = new Set<TagRecMaterial>()
  editTagRecWorkingGroup((group) => {
    if (target && findTagRecCondition(group.combination!.include, target)?.kind !== 'group') return
    for (const material of materials) {
      const next = cloneDeep(group.combination!)
      const atom = material.atom
      if (atom) {
        const key = tagRecConditionKey(atom)
        if (
          !material.exclude &&
          (tagRecCombinationBlocks.list.some((entry) => tagRecConditionKey(entry) === key) ||
            next.exclude.some((entry) => tagRecConditionKey(entry) === key))
        )
          continue
        if (material.exclude) {
          for (const entry of tagRecConditionAtoms(next.include))
            if (tagRecConditionKey(entry) === key) removeTagRecCondition(next, entry.id)
          excludeTagRecCondition(next, atom)
        } else {
          const destination = target ? findTagRecCondition(next.include, target)! : next.include
          const already = tagRecConditionAtoms(destination).some((entry) => tagRecConditionKey(entry) === key)
          if (!already && !addTagRecCondition(next, atom, target)) continue
        }
      }
      if (material.filter) next.filters = mergeTagRecCombinationFilters(next.filters, material.filter)
      if (!validateTagRecCombination(next)) continue
      group.combination = next
      accepted.add(material)
    }
  })
  return accepted
}

export async function selectTagRecMaterial(material: TagRecMaterial, target?: string) {
  const trialId = tagRecWorkbench.activeId
  const revision = tagRecCustomSession.queryRevision
  const trial = currentTagRecTrial()
  if (!trial) return false
  const signature = tagRecWorkingGroupSignature(trial.group)
  const resolved = await resolve(material)
  if (
    trialId !== tagRecWorkbench.activeId ||
    revision !== tagRecCustomSession.queryRevision ||
    signature !== tagRecWorkingGroupSignature(currentTagRecTrial()!.group)
  )
    return false
  if (!resolved) {
    toast('暂未解析到这个标签，请稍后重试')
    return false
  }
  const accepted = apply([resolved], target).size > 0
  if (!accepted) toast('未加入：请检查排除条件、目标组或条件数量')
  return accepted
}

/**
 * 收藏组「整组导入」: 每组 include 整棵嫁接为目标组的子组 (保留原 any/all 嵌套结构),
 * exclude 并入前先拔掉工作区里的同键正原子 (与单选排除同语义), filters 并入;
 * 单次工作区提交。与 apply() 同轨的安全闸: 全局拉黑词、工作区既有排除命中的原子
 * 从源子树剪掉 (剪空的嵌套组随剪随去), 校验不过或零变化的组不计数。
 * 返回实际并入的组数。
 */
export function importTagRecFavoriteCombinations(sources: readonly TagRecCombination[], target?: string): number {
  const prepared = sources.filter(
    (source) => tagRecConditionAtoms(source.include).length > 0 || source.exclude.length > 0 || source.filters,
  )
  if (!prepared.length) return 0
  let imported = 0
  editTagRecWorkingGroup((group) => {
    group.combination ??= newTagRecCombination()
    // 与 apply() 同轨: 显式落点失效则整批不落 (避免落到根组造成意外语义)
    if (target && findTagRecCondition(group.combination.include, target)?.kind !== 'group') return
    for (const source of prepared) {
      const src = cloneDeep(source)
      const next: TagRecCombination = cloneDeep(group.combination)
      const blocked = new Set([
        ...tagRecCombinationBlocks.list.map(tagRecConditionKey),
        ...next.exclude.map(tagRecConditionKey),
      ])
      for (const atom of tagRecConditionAtoms(src.include))
        if (blocked.has(tagRecConditionKey(atom))) removeTagRecCondition(src, atom.id)
      if (tagRecConditionAtoms(src.include).length) graftTagRecConditionTree(next, src.include, target)
      for (const atom of src.exclude) {
        const key = tagRecConditionKey(atom)
        for (const entry of tagRecConditionAtoms(next.include))
          if (tagRecConditionKey(entry) === key) removeTagRecCondition(next, entry.id)
        excludeTagRecCondition(next, atom)
      }
      next.filters = mergeTagRecCombinationFilters(next.filters, src.filters)
      if (!validateTagRecCombination(next) || JSON.stringify(next) === JSON.stringify(group.combination)) continue
      group.combination = next
      imported++
    }
  })
  return imported
}

export async function commitTagRecMaterialDraft(target?: string) {
  const trial = currentTagRecTrial()
  if (!trial) return false
  const revision = tagRecCustomSession.queryRevision
  const signature = tagRecWorkingGroupSignature(trial.group)
  const current = () =>
    trial.id === tagRecWorkbench.activeId &&
    revision === tagRecCustomSession.queryRevision &&
    signature === tagRecWorkingGroupSignature(currentTagRecTrial()!.group)
  const original = cloneDeep(trial.pending ?? [])
  const resolved: TagRecMaterial[] = []
  let requests = 0
  for (const material of original) {
    if (!current()) return false
    if (!material.atom && !material.filter && requests++ >= 20) continue
    const value = await resolve(material)
    if (value) resolved.push(value)
  }
  if (!current()) return false
  const stillPending = new Set(trial.pending?.map((entry) => entry.pickId))
  const accepted = apply(
    resolved.filter((entry) => stillPending.has(entry.pickId)),
    target,
  )
  const completed = new Set([...accepted].map((entry) => entry.pickId))
  trial.pending = (trial.pending ?? []).filter((entry) => !completed.has(entry.pickId))
  toast(trial.pending.length ? '未解析、冲突或超出上限的暂选已保留，请检查后重试' : '已加入当前组合，可继续试改或保存')
  return accepted.size > 0
}
