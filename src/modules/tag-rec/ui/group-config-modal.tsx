import { settings } from '$modules/settings'
import toast from '$utility/toast'
import { hasTagRecCombination } from '../model/combination'
import {
  applyTagRecScopeEntriesToGroupOverrides,
  applyTagRecScopeEntriesToL1Overrides,
  resolveTagRecEffective,
  stripTagRecGroupSlot,
  tagRecL1ChainGroup,
} from '../model/filter-engine'
import { favorites, favoritesL1 } from '../store'
import { TagRecGroupStatusPanel } from './group-status-panel'
import {
  pickTagRecScopePatch,
  TAG_REC_POOL_KEYS,
  TAG_REC_POOL_LABELS,
  TagRecScopeConfigEditor,
} from './scope-config-editor'
import type { TagL1Group, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] GroupConfigModal (filter-scope 票12) —— 组/L1 共享配置编辑面的收藏夹壳
 * - 控件本体 = TagRecScopeConfigEditor (scope-config-editor.tsx): 槽位/生效解/存盘注入,
 *   本壳只做 favorites store 实体解析 + overrides 组装落盘
 * - 槽位: L2 = 整组 + 格·四池; L1 = 单槽无格
 * - R6 修正: 存盘只动「开过草稿」的槽 (旧实现未开「组」槽时把整个组级 overrides 误清);
 *   组装/剥槽/链桩纯逻辑在 model/filter-engine.ts (applyTagRecScopeEntries* / stripTagRecGroupSlot / tagRecL1ChainGroup)
 */

export type TagRecGroupConfigTarget = { kind: 'l2'; groupId: string } | { kind: 'l1'; l1Id: string }

export function TagRecGroupConfigModal({
  open,
  target,
  onClose,
  getPopupContainer,
}: {
  open: boolean
  target: TagRecGroupConfigTarget | undefined
  onClose: () => void
  getPopupContainer?: () => HTMLElement
}) {
  // 条件挂载 => 每次打开全新草稿 (cancel=整草稿丢); 实体在此层解析 (Inner hooks 恒序)
  if (!open || !target) return null
  const core = settings.tagRec.filter
  if (target.kind === 'l2') {
    const group = favorites.list.find((g) => g.id === target.groupId)
    if (!group) return null
    const l1 = group.l1Id ? favoritesL1.list.find((l) => l.id === group.l1Id) : undefined
    return (
      <TagRecScopeConfigEditor
        title={`标签组「${group.name}」现状与配置`}
        hint={
          hasTagRecCombination(group.combination)
            ? '上方为组现状（条件树 + 生效值 + 抽牌状态）；本弹窗下方槽位编辑器管理本组覆盖与辅助名单。条件树的嵌套重组在工作台「编辑条件 ↗」。'
            : '上方为组现状（条件树 + 生效值 + 抽牌状态）；下方槽位编辑器管理本组覆盖与辅助名单。'
        }
        statusContent={<TagRecGroupStatusPanel groupId={group.id} getPopupContainer={getPopupContainer} />}
        core={core}
        presets={settings.tagRec.filter.presets}
        slots={[
          { key: 'group', label: '整组 (各池共用)' },
          ...TAG_REC_POOL_KEYS.map((p) => ({
            key: `cell:${p}`,
            label: `格 · ${TAG_REC_POOL_LABELS[p]}`,
            cell: true,
          })),
        ]}
        resolve={(key) =>
          resolveTagRecEffective(core, key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey), group, l1).cfg
        }
        resolveBase={(key) =>
          resolveTagRecEffective(
            core,
            key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey),
            stripTagRecGroupSlot(group, key),
            l1,
          ).cfg
        }
        storedOverrideOf={(key) =>
          pickTagRecScopePatch(
            key === 'group' ? group.overrides : group.overrides?.pools?.[key.slice(5) as TagRecPoolKey],
          )
        }
        negativeOf={(key) => (key === 'group' ? group.overrides?.negative : undefined)}
        storedPoolsEnabledOf={(key) => (key === 'group' ? group.overrides?.poolsEnabled : undefined)}
        resolvePoolsEnabled={(key) =>
          resolveTagRecEffective(core, key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey), group, l1)
            .poolsEnabled
        }
        basePoolsEnabled={(key) =>
          resolveTagRecEffective(
            core,
            key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey),
            stripTagRecGroupSlot(group, key),
            l1,
          ).poolsEnabled
        }
        onSave={(entries) => {
          const next = applyTagRecScopeEntriesToGroupOverrides(group.overrides, entries)
          if (next) favorites.updateGroup(group.id, { overrides: next })
          else delete group.overrides // 全摘 = 槽位删键回继承 (update* 的 !==undefined 守卫不能清)
          toast('已保存组配置')
        }}
        onClose={onClose}
        getPopupContainer={getPopupContainer}
      />
    )
  }
  const l1 = favoritesL1.list.find((l) => l.id === target.l1Id)
  if (!l1) return null
  const chainGroup = () => tagRecL1ChainGroup(l1, favorites.list)
  const strippedL1: TagL1Group = { ...l1, overrides: undefined }
  return (
    <TagRecScopeConfigEditor
      title={`一级组「${l1.name}」配置`}
      core={core}
      presets={settings.tagRec.filter.presets}
      slots={[{ key: 'l1', label: '一级组' }]}
      resolve={() => resolveTagRecEffective(core, 'tagTop', chainGroup(), l1).cfg}
      resolveBase={() => resolveTagRecEffective(core, 'tagTop', chainGroup(), strippedL1).cfg}
      storedOverrideOf={() => pickTagRecScopePatch(l1.overrides)}
      negativeOf={() => l1.overrides?.negative}
      storedPoolsEnabledOf={() => l1.overrides?.poolsEnabled}
      resolvePoolsEnabled={() => resolveTagRecEffective(core, 'tagTop', chainGroup(), l1).poolsEnabled}
      basePoolsEnabled={() => resolveTagRecEffective(core, 'tagTop', chainGroup(), strippedL1).poolsEnabled}
      onSave={(entries) => {
        const next = applyTagRecScopeEntriesToL1Overrides(l1.overrides, entries)
        if (next) favoritesL1.updateL1(l1.id, { overrides: next })
        else delete l1.overrides // 同上: 槽位删键
        toast('已保存组配置')
      }}
      onClose={onClose}
      getPopupContainer={getPopupContainer}
    />
  )
}
