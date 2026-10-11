import { cloneDeep } from 'es-toolkit'
import { settings } from '$modules/settings'
import { resolveTagRecImportApply, type TagRecImportChoice, type TagRecImportPlan } from '../model/import-export'
import { mergeTagGroups } from '../model/merge-groups'
import { blacklistStore, favorites, favoritesL1, themes } from './index'
import { blockTagRecConditionGlobally } from './combination-blocks'
import { reconcileTagRecMergedGroupContext } from './session'
import type { TagRecFilterSettings } from '../model/filter-engine'
import type { TagGroup } from '../model/types'

/**
 * [tag-rec] 导入计划落表门面 (票 18 抽提 —— pane JSON 导入 confirm 与分享导入 Modal 共用):
 * - 序: 主题 → L1 → L2 (组携 l1Id 的归属校验须先见新 L1, 否则被 auto-wrap 截胡; 票 17)
 * - merge 并入在入表后 —— 宿主可能是本批新入组; 宿主缺席 (被 skip/未勾选) => 回落照常入表
 * - onlyGroupIds (分享勾选子集): 只落这些组, l1/themes 裁到实际归属链 (resolveTagRecImportApply)
 * - applyFilterConfig: 勾选制整体覆盖 (JSON 档传 data.filterConfig; 票26 起分享档传
 *   draft.filterConfig —— 出厂占位不携, Modal 勾选裁决; 克隆落表不共享引用)
 * - activeThemeId: plan 裁决过的照走 (JSON 档可携视图态; 分享路径 planShareImport 已剥键 —— 分享是数据不是视图态)
 */
export function applyTagRecImport(input: {
  plan: TagRecImportPlan
  /** 覆盖源过滤配置 (归一化后快照; JSON 档 = data.filterConfig, 分享档 = draft.filterConfig) */
  filterConfig?: TagRecFilterSettings
  choices?: Readonly<Record<string, TagRecImportChoice>>
  onlyGroupIds?: ReadonlySet<string>
  applyFilterConfig?: boolean
  /** 默认 true; 分享档可经 Modal 勾选关闭 (黑名单仍随包默认并) */
  includeBlacklist?: boolean
}): {
  themesAdded: number
  l1Added: number
  added: number
  merged: number
  skipped: number
  blacklistAdded: number
  /** 过滤配置是否实际被覆写 (toast 文案位) */
  filterApplied: boolean
} {
  const applied = resolveTagRecImportApply(input.plan, {
    choices: input.choices,
    onlyGroupIds: input.onlyGroupIds,
  })
  themes.addThemes(applied.themesToAdd)
  favoritesL1.addL1s(applied.l1ToAdd)
  // 批量入表走 addGroups (免 addGroup 逐行 toast); 「无裸奔 L2」auto-wrap 不变式同守
  favorites.addGroups(applied.groupsToAdd)
  let merged = 0
  let fallbackAdded = 0
  const sourcesByTarget = new Map<string, TagGroup[]>()
  for (const m of applied.merges) {
    const sources = sourcesByTarget.get(m.targetId) ?? []
    sources.push(m.src)
    sourcesByTarget.set(m.targetId, sources)
  }
  for (const [targetId, sources] of sourcesByTarget) {
    const dst = favorites.list.find((g) => g.id === targetId)
    if (!dst || dst.combination || sources.some((g) => g.combination)) {
      favorites.addGroups(sources)
      fallbackAdded += sources.length // 宿主失效则照常入表，计入实际落地数
      continue
    }
    Object.assign(dst, mergeTagGroups(dst, sources))
    reconcileTagRecMergedGroupContext([], targetId)
    merged += sources.length
  }
  let blacklistAdded = 0
  if (input.includeBlacklist ?? true) {
    for (const atom of input.plan.combinationExclusionsToAdd ?? []) blockTagRecConditionGlobally(atom)
    blacklistStore.list.push(...input.plan.blacklistToAdd)
    blacklistAdded = input.plan.blacklistToAdd.length
  }
  const filterToApply = input.applyFilterConfig ? input.filterConfig : undefined
  const filterApplied = !!filterToApply
  if (filterToApply) settings.tagRec.filter = cloneDeep(filterToApply)
  // activeThemeId: undefined = 档未声明 => 不动当前; null => 复位「全部」; id => 落位 (plan 已校验可解析)
  if (input.plan.activeThemeId !== undefined) themes.setActive(input.plan.activeThemeId ?? undefined)
  return {
    themesAdded: applied.themesToAdd.length,
    l1Added: applied.l1ToAdd.length,
    added: applied.groupsToAdd.length + fallbackAdded,
    merged,
    skipped: applied.skippedCount,
    blacklistAdded,
    filterApplied,
  }
}
