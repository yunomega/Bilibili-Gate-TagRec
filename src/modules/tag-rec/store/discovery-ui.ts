import { proxy, ref } from 'valtio'
import toast from '$utility/toast'
import { proxyWithGmStorageLazy } from '$utility/valtio'
import { tagRecConditionKey, type TagRecConditionField } from '../model/combination'
import { tagRecWorkbench, type TagRecMaterial } from './workbench-state'
import type { TagRecItemExtend } from '$define'
export type { TagRecMaterial } from './workbench-state'

/** Display preferences belong to the workbench, never to a saved recipe. */
export const tagRecDiscoveryPreferences = proxyWithGmStorageLazy<{
  collapsed: boolean
  topCollapsed: boolean
  size: 'small' | 'medium' | 'large'
}>({ collapsed: false, topCollapsed: false, size: 'medium' }, 'tag-rec:discovery-display').proxy

/** Transient panel state only. Conditions and pending picks live in the workbench. */
export const tagRecDiscoveryUi = proxy({
  video: undefined as TagRecItemExtend | undefined,
  videoTrialId: '',
  borrowId: '',
  /** One-shot request for the workbench to run a material search (consumed by TagRecWorkbenchView). */
  materialQuery: undefined as { text: string; field: TagRecConditionField | 'all' } | undefined,
})
export function tagRecMaterialKey(material: TagRecMaterial) {
  return JSON.stringify([
    material.atom ? tagRecConditionKey(material.atom) : (material.tagId ?? material.name),
    !!material.exclude,
    material.filter,
  ])
}
export function stageTagRecMaterial(trialId: string, material: TagRecMaterial) {
  const trial = tagRecWorkbench.trials.find((entry) => entry.id === trialId)
  if (!trial) return false
  const list = trial.pending ?? []
  const key = tagRecMaterialKey(material)
  const at = list.findIndex((entry) => tagRecMaterialKey(entry) === key)
  if (at === -1 && list.length >= 64) {
    toast('已暂选 64 项，请先加入组合或移除一些；已有暂选已保留')
    return false
  }
  trial.pending = at === -1 ? [...list, { ...material, pickId: crypto.randomUUID() }] : list.filter((_, i) => i !== at)
  return true
}
export function openTagRecVideoMaterials(item: TagRecItemExtend, trialId: string) {
  tagRecDiscoveryUi.video = ref(item)
  tagRecDiscoveryUi.videoTrialId = trialId
}
export function requestTagRecMaterialSearch(text: string, field: TagRecConditionField | 'all' = 'tag') {
  tagRecDiscoveryUi.materialQuery = { text, field }
}
