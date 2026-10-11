import { cloneDeep, isEqual } from 'es-toolkit'
import { setNicknameCache } from '$modules/bilibili/user/nickname'
import {
  getNewestValueOfSettingsInnerArray,
  settings,
  updateSettings,
  updateSettingsInnerArray,
} from '$modules/settings'
import toast from '$utility/toast'
import { planTitleKeywordWrites, planUpBlockWrite } from '../model/block-write'
import {
  cloneTagRecFilterCore,
  type TagRecFilterCore,
  type TagRecGroupOverrides,
  type TagRecSessionFilterPatch,
} from '../model/filter-engine'
import { mergeTagRecGroupOverrides } from '../model/merge-groups'
import { materializeTagRecSessionFilter } from '../model/session-filter'
import { diffTagRecSessionFilterForGroup } from '../model/session-filter-merge'
import { favorites } from '../store'
import {
  tagRecCustomSession,
  tagRecFilterSession,
  type TagRecFilterSessionScope,
  type TagRecTempWriteEntry,
  type TagRecTempWriteKind,
} from '../store/session'
import type { TagRecNegativeRules, TagRecPartitionEntry } from '../model/types'

/**
 * [tag-rec] R8 临时写位 + 固化引擎 (右键「临时 · 本会话」与过滤弹层「临时名单」共用)
 * - 两页分别写自己的 filterOverride 稀疏差分 + tempWriteLog，不写全局或组配置。
 * - 账只记「右键临时档」写入 (弹层手改不入账) —— [清空临时]/固化 按账操作, 不误伤手调
 * - 固化到本组: 按写入时记录的稳定组 ID 写持久；目标已删/已存在跳过计数
 * - 固化到「标签过滤」(全局): 屏蔽类镜像菜单全局档 (UP/标题连带主 feed 双写);
 *   仅看类只有「分区仅看」有全局档 (窄口径全局仅看无意义, Q4)
 */

/** 不复制未修改的字段，避免一次右键操作遮蔽整份组配置。 */
export function ensureTagRecSessionOverride(scope: TagRecFilterSessionScope = 'custom'): TagRecSessionFilterPatch {
  const session = tagRecFilterSession(scope)
  return (session.filterOverride ??= { dims: {} })
}

const dimOfKind = {
  upBlock: 'upBlacklist',
  upAllow: 'upAllow',
  titleBlock: 'titleKeywords',
  titleAllow: 'titleAllow',
  descBlock: 'descKeywords',
  descAllow: 'descAllow',
  partitionBlock: 'partitionBlock',
  partitionAllow: 'partitionAllow',
} as const

function prepareTempDim(patch: TagRecSessionFilterPatch, kind: TagRecTempWriteKind) {
  const key = dimOfKind[kind]
  if (patch.dims[key]) return
  const inherited = settings.tagRec.filter.dims[key]
  // 新的临时仅看名单从空表开始；声明后覆盖本组仅看，而非悄悄追加到下层名单。
  Object.assign(patch.dims, {
    [key]: kind.endsWith('Allow') || !inherited.enabled ? { enabled: false, list: [] } : cloneDeep(inherited),
  })
}

type WriteResult = 'ok' | 'dup'

/** 单条写进 dims (覆盖层): 幂等去重 + 开闸; 只认账内 kind */
function writeEntryToDims(
  dims: Partial<TagRecFilterCore['dims']>,
  kind: TagRecTempWriteKind,
  value: unknown,
): WriteResult {
  switch (kind) {
    case 'upBlock': {
      const entry = value as { name: string; mid?: number }
      dims.upBlacklist ??= { enabled: false, list: [] }
      if (dims.upBlacklist.list.some((e) => (entry.mid !== undefined ? e.mid === entry.mid : e.name === entry.name))) {
        return 'dup'
      }
      dims.upBlacklist.list.push(entry)
      dims.upBlacklist.enabled = true
      return 'ok'
    }
    case 'upAllow': {
      const entry = value as { name: string; mid?: number }
      dims.upAllow ??= { enabled: false, list: [] }
      if (dims.upAllow.list.some((e) => (entry.mid !== undefined ? e.mid === entry.mid : e.name === entry.name))) {
        return 'dup'
      }
      dims.upAllow.list.push(entry)
      dims.upAllow.enabled = true
      return 'ok'
    }
    case 'titleBlock':
    case 'titleAllow':
    case 'descBlock':
    case 'descAllow': {
      const word = String(value)
      const key =
        kind === 'titleBlock'
          ? 'titleKeywords'
          : kind === 'titleAllow'
            ? 'titleAllow'
            : kind === 'descBlock'
              ? 'descKeywords'
              : 'descAllow'
      const dim = (dims[key] ??= { enabled: false, list: [] })
      if (dim.list.includes(word)) return 'dup'
      dim.list.push(word)
      dim.enabled = true
      return 'ok'
    }
    case 'partitionBlock': {
      dims.partitionBlock ??= { enabled: false, list: [] }
      const entry = value as TagRecPartitionEntry
      const key = `${entry.v1 ?? ''}|${entry.v2 ?? ''}`
      if (dims.partitionBlock.list.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) return 'dup'
      dims.partitionBlock.list.push(entry)
      dims.partitionBlock.enabled = true
      return 'ok'
    }
    case 'partitionAllow': {
      const entry = value as TagRecPartitionEntry
      const key = `${entry.v1 ?? ''}|${entry.v2 ?? ''}`
      dims.partitionAllow ??= { enabled: false, list: [] }
      if (dims.partitionAllow.list.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) return 'dup'
      dims.partitionAllow.list.push(entry)
      dims.partitionAllow.enabled = true
      return 'ok'
    }
  }
}

/** 单条写进 negative 容器 (组/L1 持久层; 固化到本组用) */
function writeEntryToNegative(neg: TagRecNegativeRules, entry: TagRecTempWriteEntry): WriteResult {
  const { kind, value } = entry
  switch (kind) {
    case 'upBlock': {
      const v = value as { name: string; mid?: number }
      neg.up ??= []
      if (neg.up.some((e) => (v.mid !== undefined ? e.mid === v.mid : e.name === v.name))) return 'dup'
      neg.up.push(v)
      return 'ok'
    }
    case 'upAllow': {
      const v = value as { name: string; mid?: number }
      neg.upAllow ??= { enabled: true, list: [] }
      if (neg.upAllow.list.some((e) => (v.mid !== undefined ? e.mid === v.mid : e.name === v.name))) return 'dup'
      neg.upAllow.list.push(v)
      neg.upAllow.enabled = true
      return 'ok'
    }
    case 'titleBlock':
    case 'titleAllow':
    case 'descBlock':
    case 'descAllow': {
      const word = String(value)
      const key =
        kind === 'titleBlock'
          ? 'title'
          : kind === 'titleAllow'
            ? 'titleAllow'
            : kind === 'descBlock'
              ? 'desc'
              : 'descAllow'
      if (key === 'title' || key === 'desc') {
        neg[key] ??= []
        if (neg[key]!.includes(word)) return 'dup'
        neg[key]!.push(word)
        return 'ok'
      }
      const allowKey = key as 'titleAllow' | 'descAllow'
      neg[allowKey] ??= { enabled: true, list: [] }
      if (neg[allowKey]!.list.includes(word)) return 'dup'
      neg[allowKey]!.list.push(word)
      neg[allowKey]!.enabled = true
      return 'ok'
    }
    case 'partitionBlock': {
      const v = value as TagRecPartitionEntry
      neg.partitionBlock ??= []
      const key = `${v.v1 ?? ''}|${v.v2 ?? ''}`
      if (neg.partitionBlock.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) return 'dup'
      neg.partitionBlock.push(v)
      return 'ok'
    }
    case 'partitionAllow': {
      const v = value as TagRecPartitionEntry
      neg.partitionAllow ??= { enabled: true, list: [] }
      const key = `${v.v1 ?? ''}|${v.v2 ?? ''}`
      if (neg.partitionAllow.list.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) return 'dup'
      neg.partitionAllow.list.push(v)
      neg.partitionAllow.enabled = true
      return 'ok'
    }
  }
}

/** 从覆盖里摘除一条 (清空/固化后; 与写入同身份键) */
function removeEntryFromDims(dims: Partial<TagRecFilterCore['dims']>, kind: TagRecTempWriteKind, value: unknown): void {
  switch (kind) {
    case 'upBlock':
    case 'upAllow': {
      const entry = value as { name: string; mid?: number }
      const dim = kind === 'upBlock' ? dims.upBlacklist : dims.upAllow
      if (!dim) return
      const idx = dim.list.findIndex((e) => (entry.mid !== undefined ? e.mid === entry.mid : e.name === entry.name))
      if (idx !== -1) dim.list.splice(idx, 1)
      return
    }
    case 'titleBlock':
    case 'titleAllow':
    case 'descBlock':
    case 'descAllow': {
      const word = String(value)
      const key =
        kind === 'titleBlock'
          ? 'titleKeywords'
          : kind === 'titleAllow'
            ? 'titleAllow'
            : kind === 'descBlock'
              ? 'descKeywords'
              : 'descAllow'
      const dim = dims[key]
      if (!dim) return
      const idx = dim.list.indexOf(word)
      if (idx !== -1) dim.list.splice(idx, 1)
      return
    }
    case 'partitionBlock':
    case 'partitionAllow': {
      const entry = value as TagRecPartitionEntry
      const key = `${entry.v1 ?? ''}|${entry.v2 ?? ''}`
      if (kind === 'partitionBlock') {
        if (!dims.partitionBlock) return
        const idx = dims.partitionBlock.list.findIndex((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)
        if (idx !== -1) dims.partitionBlock.list.splice(idx, 1)
      } else if (dims.partitionAllow) {
        const idx = dims.partitionAllow.list.findIndex((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)
        if (idx !== -1) dims.partitionAllow.list.splice(idx, 1)
      }
      return
    }
  }
}

/**
 * 右键临时写位：只修改所在页的本次差分并记账。
 * @returns 'ok' | 'dup' (已存在于临时名单)
 */
export function writeTagRecTempEntry(input: {
  kind: TagRecTempWriteKind
  value: unknown
  label: string
  owningGroupNames: readonly string[]
  owningGroupIds?: readonly string[]
  scope?: TagRecFilterSessionScope
}): WriteResult {
  const session = tagRecFilterSession(input.scope)
  const override = ensureTagRecSessionOverride(input.scope)
  const key = dimOfKind[input.kind]
  const inherited = override.dims[key] === undefined
  prepareTempDim(override, input.kind)
  const r = writeEntryToDims(override.dims, input.kind, input.value)
  if (r === 'dup') {
    if (inherited) delete override.dims[key]
    if (!Object.keys(override.dims).length && Object.keys(override).length === 1) session.filterOverride = undefined
    return 'dup'
  }
  session.tempWriteLog.push({
    kind: input.kind,
    value: input.value,
    label: input.label,
    owningGroupNames: [...input.owningGroupNames],
    owningGroupIds: input.owningGroupIds
      ? [...input.owningGroupIds]
      : input.owningGroupNames.flatMap((name) => {
          const matches = favorites.list.filter((g) => g.name === name)
          return matches.length === 1 ? [matches[0].id] : []
        }),
  })
  return 'ok'
}

/** 仅看家族的全局档只对分区有意义 (窄口径全局仅看无意义, Q4) —— 固化到全局按钮的可用性判据 */
export function canKeepTempEntryToGlobal(kind: TagRecTempWriteKind): boolean {
  return kind !== 'upAllow' && kind !== 'titleAllow' && kind !== 'descAllow'
}

/**
 * 固化到本组: 逐「记账认领组」写持久 (overrides.negative);
 * **永不走草稿组**; 目标组已删/值已存在 => 跳过计数; 全跳 (有认领组但一个都没写成) => 保留临时条不消费
 */
export function keepTagRecTempEntryToGroup(index: number, scope: TagRecFilterSessionScope = 'custom'): void {
  const session = tagRecFilterSession(scope)
  const entry = session.tempWriteLog[index]
  if (!entry) return
  const ids =
    entry.owningGroupIds ??
    entry.owningGroupNames.flatMap((name) => {
      const matches = favorites.list.filter((g) => g.name === name)
      return matches.length === 1 ? [matches[0].id] : []
    })
  if (!ids.length) {
    if (entry.owningGroupNames.length) toast('固化未生效: 目标组已删除或名称不明确, 临时规则已保留')
    return
  }
  let written = 0
  let skipped = Math.max(0, entry.owningGroupNames.length - ids.length)
  for (const id of new Set(ids)) {
    const g = favorites.list.find((x) => x.id === id)
    if (!g) {
      skipped++
      continue
    }
    g.overrides ??= {}
    g.overrides.negative ??= {}
    if (writeEntryToNegative(g.overrides.negative, entry) === 'ok') written++
    else skipped++
  }
  if (!written) {
    toast(`固化未生效: 目标组已删除或值已存在 (跳过 ${skipped} 个) —— 可改「固化到「标签过滤」」`)
    return
  }
  removeTempEntryFromOverride(entry, scope)
  session.tempWriteLog.splice(index, 1)
  toast(`已固化到 ${written} 个组${skipped ? ` (跳过 ${skipped} 个: 已删/已存在)` : ''}`)
}

/** 固化到「标签过滤」(全局): 屏蔽类镜像菜单全局档 (UP/标题连带主 feed 双写); 仅看类仅 partitionAllow */
export async function keepTagRecTempEntryToGlobal(
  index: number,
  scope: TagRecFilterSessionScope = 'custom',
): Promise<void> {
  const session = tagRecFilterSession(scope)
  const entry = session.tempWriteLog[index]
  if (!entry || !canKeepTempEntryToGlobal(entry.kind)) return
  const dims = settings.tagRec.filter.dims
  switch (entry.kind) {
    case 'upBlock': {
      const v = entry.value as { name: string; mid?: number }
      const plan = planUpBlockWrite(v, settings.filter.byAuthor.keywords, dims.upBlacklist.list)
      if (plan.globalAdd) await updateSettingsInnerArray('filter.byAuthor.keywords', { add: [plan.globalAdd] })
      updateSettings({ filter: { byAuthor: { enabled: true } } })
      if (plan.tagRecAdd) dims.upBlacklist.list.push(plan.tagRecAdd)
      dims.upBlacklist.enabled = true
      if (v.mid !== undefined && v.name) void setNicknameCache(v.mid, v.name)
      break
    }
    case 'titleBlock': {
      const word = String(entry.value)
      const globalKw = await getNewestValueOfSettingsInnerArray('filter.byTitle.keywords')
      const plan = planTitleKeywordWrites([word], globalKw, dims.titleKeywords.list)
      if (plan.globalAdds.length) await updateSettingsInnerArray('filter.byTitle.keywords', { add: plan.globalAdds })
      updateSettings({ filter: { byTitle: { enabled: true } } })
      if (plan.tagRecAdds.length) dims.titleKeywords.list.push(...plan.tagRecAdds)
      dims.titleKeywords.enabled = true
      break
    }
    case 'descBlock': {
      // 主 feed 无 byDesc 全局档 —— 仅标签推荐 (维度开闸)
      const word = String(entry.value)
      if (!dims.descKeywords.list.includes(word)) dims.descKeywords.list.push(word)
      dims.descKeywords.enabled = true
      break
    }
    case 'partitionBlock': {
      const v = entry.value as TagRecPartitionEntry
      const key = `${v.v1 ?? ''}|${v.v2 ?? ''}`
      if (!dims.partitionBlock.list.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) {
        dims.partitionBlock.list.push(v)
      }
      dims.partitionBlock.enabled = true
      break
    }
    case 'partitionAllow': {
      const v = entry.value as TagRecPartitionEntry
      dims.partitionAllow ??= { enabled: false, list: [] }
      const key = `${v.v1 ?? ''}|${v.v2 ?? ''}`
      if (!dims.partitionAllow.list.some((e) => `${e.v1 ?? ''}|${e.v2 ?? ''}` === key)) {
        dims.partitionAllow.list.push(v)
      }
      dims.partitionAllow.enabled = true
      break
    }
    default:
      return
  }
  const currentIndex = session.tempWriteLog.indexOf(entry)
  if (currentIndex !== -1) {
    removeTempEntryFromOverride(entry, scope)
    session.tempWriteLog.splice(currentIndex, 1)
  }
  toast('已固化到「标签过滤」(长期生效)')
}

/** 从覆盖摘除一条账 (清空/固化共用) */
function removeTempEntryFromOverride(entry: TagRecTempWriteEntry, scope: TagRecFilterSessionScope = 'custom'): void {
  const session = tagRecFilterSession(scope)
  const override = session.filterOverride
  if (!override) return
  removeEntryFromDims(override.dims, entry.kind, entry.value)
  const key = dimOfKind[entry.kind]
  const dim = override.dims[key]
  if (dim && ((!dim.list.length && dim.enabled) || isEqual(dim, settings.tagRec.filter.dims[key])))
    delete override.dims[key]
  if (!Object.keys(override.dims).length && Object.keys(override).length === 1) session.filterOverride = undefined
}

/** 单条移除 (临时名单 [×]): 摘覆盖条目 + 销账 */
export function removeTagRecTempWriteAt(index: number, scope: TagRecFilterSessionScope = 'custom'): void {
  const session = tagRecFilterSession(scope)
  const entry = session.tempWriteLog[index]
  if (!entry) return
  removeTempEntryFromOverride(entry, scope)
  session.tempWriteLog.splice(index, 1)
}

/** [清空临时]: 按账摘除覆盖条目 + 清账 (弹层手改不动 —— 那是你自己的编辑, 用「重置为「标签过滤」」清) */
export function clearTagRecTempWrites(scope: TagRecFilterSessionScope = 'custom'): void {
  const session = tagRecFilterSession(scope)
  for (const entry of session.tempWriteLog) removeTempEntryFromOverride(entry, scope)
  session.tempWriteLog.length = 0
}

// #region 「存成项后顺手并入临时过滤」(差集固化, 非默认持久化 —— grilling 共识)

/**
 * 并入预览: 会话临时过滤 vs 全局「标签过滤」的差集 => 组可表达槽位 (dims/score/名单/pools)。
 * 返回 undefined = 无差异 (调用侧不出提示)。
 */
export function planTagRecSessionFilterMerge(): TagRecGroupOverrides | undefined {
  const override = tagRecCustomSession.filterOverride
  if (!override) return undefined
  return diffTagRecSessionFilterForGroup(
    materializeTagRecSessionFilter(settings.tagRec.filter, override),
    cloneTagRecFilterCore(settings.tagRec.filter),
  )
}

/**
 * 并入执行: 差集 merge 进目标组 overrides。
 * mergeTagRecGroupOverrides 语义 = 目标显式值优先/源补缺项 —— 组已写过的键不被会话差集回头覆盖。
 * 会话侧 filterOverride 不动 (换锚点照常清除); 返回是否实际并入。
 */
export function commitTagRecSessionFilterMerge(groupId: string): boolean {
  const diff = planTagRecSessionFilterMerge()
  const g = favorites.list.find((x) => x.id === groupId)
  if (!diff || !g) return false
  g.overrides = mergeTagRecGroupOverrides(g.overrides, diff)
  return true
}
// #endregion
