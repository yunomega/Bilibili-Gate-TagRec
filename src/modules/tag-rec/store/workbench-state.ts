import { proxyWithGmStorageLazy } from '$utility/valtio'
import type { TagRecConditionAtom } from '../model/combination'
import type { TagRecSessionFilterPatch } from '../model/filter-engine'
import type { TagGroup } from '../model/types'

export type TagRecMaterial = {
  atom?: TagRecConditionAtom
  name: string
  source: '解析' | '共现' | '视频' | '收藏' | '输入'
  tagId?: number
  exclude?: boolean
  filter?: TagRecSessionFilterPatch
  pickId?: string
  count?: number
  /** 共现双源标记: true = 累积沉淀池语料行 (随深挖自动长), 缺省 = 本次搜索快照行。 */
  corpus?: boolean
}

/** A trial and its pending picks are saved and archived as one unit. */
export type TagRecTrial = {
  id: string
  name: string
  originId?: string
  group: TagGroup
  pending?: TagRecMaterial[]
}
type WorkbenchState = { version: 1; activeId: string; trials: TagRecTrial[]; recent: TagRecTrial[] }
const lazy = proxyWithGmStorageLazy<WorkbenchState>(
  { version: 1, activeId: '', trials: [], recent: [] },
  'tag-rec:workbench',
)
export const tagRecWorkbench = lazy.proxy
export const tagRecWorkbenchStateHydrated = lazy.hydrated

export function currentTagRecTrial(): TagRecTrial | undefined {
  return Array.isArray(tagRecWorkbench.trials)
    ? tagRecWorkbench.trials.find((trial) => trial?.id === tagRecWorkbench.activeId)
    : undefined
}
