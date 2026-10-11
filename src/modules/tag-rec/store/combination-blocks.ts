import { cloneDeep } from 'es-toolkit'
import { subscribe } from 'valtio'
import { proxyWithGmStorageLazy } from '$utility/valtio'
import {
  newTagRecCombination,
  tagRecConditionKey,
  validateTagRecCombination,
  type TagRecConditionAtom,
} from '../model/combination'
import { tagRecCustomSession } from './session'

const lazy = proxyWithGmStorageLazy(
  { list: [] as TagRecConditionAtom[], invalid: false, incompatibleData: undefined as unknown },
  'tag-rec:combination-blocks',
)
export const tagRecCombinationBlocks = lazy.proxy
function preserveIncompatibleConditions() {
  const combo = newTagRecCombination()
  combo.exclude = lazy.proxy.list
  if (!validateTagRecCombination(combo)) {
    lazy.proxy.incompatibleData = cloneDeep(lazy.proxy.list)
    lazy.proxy.list = []
    lazy.proxy.invalid = true
  }
}
export const tagRecCombinationBlocksHydrated = lazy.hydrated.then(preserveIncompatibleConditions)
subscribe(lazy.proxy, preserveIncompatibleConditions)
export function blockTagRecConditionGlobally(atom: TagRecConditionAtom): boolean {
  if (tagRecCombinationBlocks.invalid) return false
  if (tagRecCombinationBlocks.list.some((entry) => tagRecConditionKey(entry) === tagRecConditionKey(atom))) return false
  const combo = newTagRecCombination()
  combo.exclude = [...tagRecCombinationBlocks.list, { ...cloneDeep(atom), id: crypto.randomUUID() }]
  if (!validateTagRecCombination(combo)) return false
  tagRecCombinationBlocks.list = combo.exclude
  // D06: 全局排除也是条件变更 —— 显式临时查看恢复默认暂存
  tagRecCustomSession.allowUnverified = false
  return true
}
export function unblockTagRecConditionGlobally(id: string): void {
  tagRecCombinationBlocks.list = tagRecCombinationBlocks.list.filter((atom) => atom.id !== id)
  tagRecCustomSession.allowUnverified = false
}
