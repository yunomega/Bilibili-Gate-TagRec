import { useMemoizedFn } from 'ahooks'
import { Button, Dropdown, Modal, Select, Spin, Tag, theme, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { antMessage, defineAntMenus, type AntMenuItem } from '$modules/antd'
import { AntdTooltip } from '$modules/antd/custom'
import { IconForFav, IconForFaved } from '$modules/icon'
import toast from '$utility/toast'
import { fetchVideoTags, invalidateVideoTagsCache, type ViewDetailTagItem } from '../api/endpoints'
import { tagRecConditionAtom, tagRecConditionAtoms } from '../model/combination'
import { buildTagRecCustomDeepLink } from '../model/deeplink'
import { findGroupsByTagIds, pickTagGroupsByIds, summarizeGroupNames } from '../model/favorites'
import {
  classifyVideoTagStatus,
  DRAFT_GROUP_ID,
  parseTagType,
  resolveLandingGroups,
  videoTagToTagIdEntry,
} from '../model/tag-status'
import { favorites, favoritesStore, type AddTagIdsResult } from '../store'
import { blockTagRecConditionGlobally } from '../store/combination-blocks'
import { pushExpandedIds, removeExpandedId, tagRecCustomSession } from '../store/session'
import {
  addTagRecWorkingCondition,
  excludeTagRecWorkingCondition,
  exploreTagRecTagOnly,
  removeTagRecWorkingCondition,
} from '../store/workbench'
import { IconForTagBlock } from './icons'
import type { TagGroup, TagIdEntry } from '../model/types'

/**
 * [tag-rec] 🏷 标签弹层 (spec §4.6, 两挂点共用)
 * - 点开才拉 view/detail/tag (会话缓存 + 同 bvid >=3s 去重); 本组件仅在弹层打开时挂载, 天然懒取
 * - 行: tag_name + #tag_id(小字) + 状态区 + 动作列 (★ 小菜单 / ⛔ 负向切换);
 *   `#id` = 新标签页直达「标签发掘」以此标签开新组合的真链接 (id+名零解析落成试验, 可中键/复制链);
 *   tag_type 徽标不渲 (old_channel 噪音挤行宽, 数据仍留 schema/回填收藏表)
 * - 票 19: ⛔/★ 判定集与动作集同收窄到「本卡落点集」= 归因名解析出的来源组 + 未归属名的草稿组;
 *   落点集外宿主不给本卡反向通路 (解/管去对应归因卡或面板); 票 23: 「·他组」chip 与集内 ★/⛔ 文字
 *   chip 全删 (图标亮灭/红灰自足), 状态区仅留「组X变体」chip, 他组归属走 ★菜单③相关组 Modal 知情
 * - 票 20: ★ 菜单重构四档入组 —— ①新建收藏项 (未收藏分支, toast 带「新标签页查看」动作,
 *   票 24 改道「选中并重开」: 新 tab 经 tag-rec-group 深链直接进选定组语境, 当前 tab 零扰动)
 *   ②加入当前组 (选定组 > 草稿组, 皆无不渲) ③加入相关组…(Modal, 组 tag_ids ∩ 本视频 tag_ids)
 *   ④加入全部组…(Modal, enabled 组); 已收藏分支 = 逐宿主移出/停用 + ②③④
 * - 票 22: ②两语境统一写 expandedIds 暂存位 (与下拉「扩进」同义, 下一轮进查询单元生效;
 *   入表收口到「顺手存成项/并入当前组」) —— ∈暂存位 => ★ 紫染暂存态, 直点取消 (票 27,
 *   图标三态: 灰空心=可收/紫=暂存可撤/金=真成员); 菜单「已扩进」禁选位留给锚点态
 * - 负向语义绑定标签组 (票 14): ⛔ 写进落点集 negative_tag_ids, 多归因写全部落点;
 *   落点集为空 (非 tag-rec 卡) => 仅点击 ⛔ 时弹组选择 Modal 兜底
 * - 已知 id 路径零解析直进组, 不经过沉淀池; tag_type opportunistic 回填收藏表
 */

/** ⛔ tooltip 固定文案 (spec §4.6/票 19: 拉黑/解黑 = 本卡落点组负向二态翻转) */
export const TAG_POPOVER_BLACKLIST_TOOLTIP = '拉黑/解黑本卡落点组的负向成员 (仅作用于「收藏推荐/指定标签」tab)'

/** 宿主组名展示: 草稿组伪组前缀「草稿组」, 收藏表组直接「名」 */
const hostLabel = (g: TagGroup) => (g.id === DRAFT_GROUP_ID ? `草稿组「${g.name}」` : `「${g.name}」`)

/**
 * 同名组消歧 (实机数据可存在同名双胞胎组): peers 内有同名牌 => 附「N个id」区分;
 * 计数仍撞 => 再附 id 短码兜底 (收藏表 id 是 uuid)
 */
function hostLabelEx(g: TagGroup, peers: readonly TagGroup[]) {
  const same = peers.filter((p) => p.name === g.name)
  if (same.length <= 1) return hostLabel(g)
  const byCount = same.filter((p) => p.tag_ids.length === g.tag_ids.length)
  const suffix = byCount.length <= 1 ? `${g.tag_ids.length}个id` : `${g.tag_ids.length}个id·#${g.id.slice(0, 4)}`
  return `${hostLabel(g)}(${suffix})`
}

type LoadState = 'loading' | 'ok' | 'error'
type VideoTag = { tag_id: number; tag_name: string; tag_type?: string }

function pickVideoTags(items: ViewDetailTagItem[] | undefined): VideoTag[] {
  return (items ?? []).filter((t): t is ViewDetailTagItem & VideoTag => !!t.tag_id && !!t.tag_name)
}

export function TagRecTagPopover({
  bvid,
  workbenchMode = false,
  sourceGroupNames = [],
  sourceGroupIds,
}: {
  bvid: string
  workbenchMode?: boolean
  /** 本卡片归因组名 (tag-rec 卡片 = source.groupNames; ⛔ 负向落点解析) */
  sourceGroupNames?: string[]
  sourceGroupIds?: string[]
}) {
  const [tags, setTags] = useState<VideoTag[]>([])
  const [state, setState] = useState<LoadState>('loading')

  // 生命周期闸 (审计 §8-3): 关弹层/换 BV/重试 => 旧请求退出等待; 无其他消费者时
  //   交互道补查随「最后等待者离开」取消, 快速开关不再积攒孤儿请求
  const requestRef = useRef<AbortController | undefined>(undefined)
  const load = useMemoizedFn(async () => {
    requestRef.current?.abort()
    const ctrl = new AbortController()
    requestRef.current = ctrl
    setState('loading')
    const res = await fetchVideoTags(bvid, { interactive: true, signal: ctrl.signal }).catch(() => undefined) // 交互道: 不占批量闸
    if (ctrl.signal.aborted) return
    setTags(pickVideoTags(res))
    setState(res === undefined ? 'error' : 'ok')
  })
  useEffect(() => void load(), [bvid])
  useEffect(() => () => requestRef.current?.abort(), [])

  // tag_type opportunistic 回填收藏表 (§3.1): 已入表条目缺 tag_type 时顺手补
  useEffect(() => {
    if (state !== 'ok' || !tags.length) return
    favorites.backfillTagTypes(tags.map((t) => ({ id: t.tag_id, tag_type: parseTagType(t.tag_type) })))
  }, [state, tags])

  const { list: groups } = useSnapshot(favoritesStore)
  const draftGroup = useSnapshot(tagRecCustomSession).draftGroup
  // 宿主枚举全集 = 收藏表组 + 草稿组伪组 (草稿组仅负向位有意义, 正向位空); 判定集 = 落点集 (票 19)
  const statusGroups: TagGroup[] = [
    ...(groups as TagGroup[]),
    ...(draftGroup
      ? [
          {
            id: DRAFT_GROUP_ID,
            name: draftGroup.name,
            tag_ids: [],
            negative_tag_ids: [...draftGroup.negative_tag_ids],
            weight: 0,
            enabled: true,
            addedAt: 0,
          } satisfies TagGroup,
        ]
      : []),
  ]
  // 本卡落点集 (票 19): ⛔/★ 状态判定集与动作集同收窄到此; 空 => ⛔ 点击时组选择 Modal 兜底
  const landingGroups = resolveLandingGroups(groups as TagGroup[], statusGroups, sourceGroupNames, sourceGroupIds)
  // 票 20 ③ 相关组候选: 组 tag_ids ∩ 本视频全部 tag_ids ≠ ∅ (纯 id 交集, 弹层已持 tags 零请求)
  const relatedGroups = findGroupsByTagIds(
    groups as TagGroup[],
    tags.map((t) => t.tag_id),
  )
  // 票 20 ④ 全部组候选: 收藏表 enabled 组 (停用不列不进, spec §4.3 同语)
  const enabledGroups = (groups as TagGroup[]).filter((g) => g.enabled)

  return (
    <div className='w-310px' onClick={(e) => e.stopPropagation()}>
      <div className='mb-4px flex items-center justify-between'>
        <Typography.Text strong className='text-13px'>
          视频标签
        </Typography.Text>
        {state === 'ok' && (
          <Typography.Text type='secondary' className='text-12px'>
            共 {tags.length} 个
          </Typography.Text>
        )}
      </div>

      {state === 'loading' && (
        <div className='flex-center py-12px'>
          <Spin size='small' />
          <span className='ml-8px text-12px'>加载标签中…</span>
        </div>
      )}

      {state === 'error' && (
        <div className='flex-center py-12px text-12px'>
          加载失败
          <Button
            size='small'
            type='link'
            className='px-4px'
            onClick={() => {
              invalidateVideoTagsCache(bvid)
              void load()
            }}
          >
            重试
          </Button>
        </div>
      )}

      {state === 'ok' && !tags.length && (
        <div className='py-12px text-center'>
          {/* UIUX-U2-1: 死类 text-gate-secondary => Typography secondary */}
          <Typography.Text type='secondary' className='text-12px'>
            该视频暂无标签
          </Typography.Text>
        </div>
      )}

      {state === 'ok' && !!tags.length && (
        <div className='max-h-320px overflow-y-auto'>
          {tags.map((t) =>
            workbenchMode ? (
              <WorkingTagRow
                key={t.tag_id}
                tag={t}
                groups={groups as TagGroup[]}
                relatedGroups={relatedGroups}
                enabledGroups={enabledGroups}
              />
            ) : (
              <TagRow
                key={t.tag_id}
                tag={t}
                groups={groups as TagGroup[]}
                statusGroups={statusGroups}
                landingGroups={landingGroups}
                relatedGroups={relatedGroups}
                enabledGroups={enabledGroups}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}

// ———— 负向写路径 (收藏表组门面 + 草稿组会话直写) ————

function addNegativeToDraft(entry: TagIdEntry): boolean {
  const d = tagRecCustomSession.draftGroup
  if (!d || d.negative_tag_ids.some((x) => x.id === entry.id)) return false
  d.negative_tag_ids.push({ ...entry })
  return true
}

function removeNegativeFromTarget(groupId: string, tagId: number) {
  if (groupId === DRAFT_GROUP_ID) {
    const d = tagRecCustomSession.draftGroup
    if (!d) return
    const i = d.negative_tag_ids.findIndex((e) => e.id === tagId)
    if (i !== -1) d.negative_tag_ids.splice(i, 1)
    return
  }
  favorites.removeNegativeFromGroup(groupId, tagId)
}

/**
 * ★ 入组共享件 (票 07): ①新建收藏项 + ③加入相关组… + ④加入全部组… 的 Modal/Select 与写入报告,
 * TagRow / WorkingTagRow 共用同一实现保证「等价入口」
 */
function useTagGroupAddPicker({
  tag,
  relatedGroups,
  enabledGroups,
}: {
  tag: VideoTag
  relatedGroups: TagGroup[]
  enabledGroups: TagGroup[]
}) {
  const entry = videoTagToTagIdEntry(tag)
  const [addPickerMode, setAddPickerMode] = useState<'related' | 'all'>()
  const [addPickerIds, setAddPickerIds] = useState<string[]>([])

  /** 并入单组的报告 (spec Q8-i): 「已并入组「A」,共 N 个标签」+ 互斥/他组信息; silent 走 facade 去重后自报 */
  const reportAddResult = useMemoizedFn((target: TagGroup, res: AddTagIdsResult) => {
    const live = favorites.list.find((x) => x.id === target.id)
    const parts: string[] =
      res.added || res.moved
        ? [`已并入组「${target.name}」,共 ${live?.tag_ids.length ?? target.tag_ids.length} 个标签`]
        : [`「${target.name}」已含该标签`]
    if (res.moved) parts.push(`${res.moved} 个由负向转正向`)
    if (res.alsoIn.length) parts.push(`也存在于 ${summarizeGroupNames(res.alsoIn)}`)
    toast(parts.join('; '), 3500)
  })

  /**
   * ① 新建收藏项: addGroup + toast 带「新标签页查看」动作 —— 票 24 改道票 20「选中并重开」:
   * 「选中并重开」会炸掉当前 tab 语境 (输入/草稿/滚动现场全清), 改为新 tab 经 tag-rec-group
   * 深链直接进选定组语境 (消费点 = TagRecCustomTabbarView mount), 当前 tab 零扰动, 契合一 tab 一语境互斥
   */
  const createGroupAndOfferOpen = useMemoizedFn(() => {
    const g = favorites.addGroup({ name: tag.tag_name, tag_ids: [entry] })?.group
    if (!g) return
    const key = `tag-rec-new-group-${g.id}`
    antMessage.open({
      key,
      duration: 6,
      content: (
        <span>
          已存为组「{g.name}」·
          <Button
            type='link'
            size='small'
            className='px-4px'
            onClick={() => {
              antMessage.destroy(key)
              window.open(buildTagRecCustomDeepLink(location.origin, { group: g.id }), '_blank')
            }}
          >
            新标签页查看
          </Button>
        </span>
      ),
    })
  })

  // ③④ 入组选择器 (Modal+Select showSearch, 复用 ⛔ 落点 Modal 范式; 多选并入多组)
  const openAddPicker = useMemoizedFn((mode: 'related' | 'all') => {
    setAddPickerIds([])
    setAddPickerMode(mode)
  })
  const confirmAddPicker = useMemoizedFn(() => {
    const pool = addPickerMode === 'related' ? relatedGroups : enabledGroups
    const targets = pool.filter((g) => addPickerIds.includes(g.id))
    setAddPickerMode(undefined)
    if (!targets.length) return
    if (targets.length === 1) {
      reportAddResult(targets[0], favorites.addTagIdsToGroup(targets[0].id, [entry], { silent: true }))
      return
    }
    const added: string[] = []
    const alsoIn = new Set<string>()
    let skipped = 0
    let moved = 0
    for (const g of targets) {
      const res = favorites.addTagIdsToGroup(g.id, [entry], { silent: true })
      if (res.added || res.moved) added.push(g.name)
      else skipped++
      moved += res.moved
      res.alsoIn.forEach((n) => alsoIn.add(n))
    }
    const parts: string[] = []
    if (added.length) parts.push(`已并入 ${summarizeGroupNames(added, 5)}`)
    if (skipped) parts.push(`${skipped} 组已含该标签`)
    if (moved) parts.push(`${moved} 个由负向转正向`)
    if (alsoIn.size) parts.push(`也存在于 ${summarizeGroupNames([...alsoIn])}`)
    toast(parts.join('; ') || '未变动', 3500)
  })

  const addPickerModal = (
    <Modal
      title={addPickerMode === 'related' ? '加入相关组 (含本视频 tag 的组)' : '加入全部组'}
      open={addPickerMode !== undefined}
      onCancel={() => setAddPickerMode(undefined)}
      onOk={confirmAddPicker}
      okText='加入'
      okButtonProps={{ disabled: !addPickerIds.length }}
      width={360}
    >
      <Select
        mode='multiple'
        showSearch
        optionFilterProp='label'
        className='mt-12px w-full'
        placeholder='选择标签组'
        value={addPickerIds}
        onChange={setAddPickerIds}
        options={(addPickerMode === 'related' ? relatedGroups : enabledGroups).map((g) => ({
          value: g.id,
          label: `${g.name} (${g.tag_ids.length} 个 id)`,
        }))}
      />
    </Modal>
  )

  return { reportAddResult, createGroupAndOfferOpen, openAddPicker, addPickerModal }
}

function TagRow({
  tag,
  groups,
  statusGroups,
  landingGroups,
  relatedGroups,
  enabledGroups,
}: {
  tag: VideoTag
  /** 收藏表组 (★「加入当前组」语境解析 + 状态全集) */
  groups: TagGroup[]
  /** 收藏表组+草稿组伪组 (宿主枚举全集 + ⛔ 兜底选择器选项) */
  statusGroups: TagGroup[]
  /** 本卡落点集 (票 19: 判定集+动作集) */
  landingGroups: TagGroup[]
  /** 票 20 ③「加入相关组」候选 (组 tag_ids ∩ 本视频全部 tag_ids ≠ ∅) */
  relatedGroups: TagGroup[]
  /** 票 20 ④「加入全部组」候选 (enabled 组) */
  enabledGroups: TagGroup[]
}) {
  // 票 19: 判定只看落点集; 落点集外宿主进 *Outside 只读位
  const status = classifyVideoTagStatus({ id: tag.tag_id, name: tag.tag_name }, landingGroups, statusGroups)
  const entry = videoTagToTagIdEntry(tag)
  /** 落点集内正向宿主 (★ 激活 + 菜单动作对象); 空 => 本语境按未收藏渲染 (含仅他组收藏) */
  const favedHosts = status.faved
  /** ⛔ 二态: 落点集内存在负向宿主 = 黑 */
  const blacked = status.negative.length > 0

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerIds, setPickerIds] = useState<string[]>([])
  const { token } = theme.useToken() // UIUX-U2-3: 扩选暂存紫走 token.purple6 (antd v6 preset 色板, = 旧 #722ed1, 暗色自适应)

  const { selectedGroupIds, draftGroup, expandedIds, anchor } = useSnapshot(tagRecCustomSession)

  // ⛔ 写入: 命中全部解析目标 (多归因写全部来源组, 票 14 Q2)
  const addNegativeToTargets = useMemoizedFn((targets: TagGroup[]) => {
    const names: string[] = []
    for (const t of targets) {
      if (t.id === DRAFT_GROUP_ID) {
        if (addNegativeToDraft(entry)) names.push(`草稿组「${t.name}」`)
      } else {
        const res = favorites.addNegativeToGroup(t.id, [entry])
        if (res.added || res.moved) names.push(hostLabelEx(t, statusGroups))
      }
    }
    if (names.length) toast(`已加入 ${names.join('、')} 负向`)
    else toast('该标签已在所选组负向中')
  })

  const onToggleNegative = useMemoizedFn(() => {
    // ⛔ 二态翻转 (票 19 Q2-a): 只翻「本卡落点集里黑没黑」—— 黑 => 清落点集内全部负向宿主;
    // 否则 => 加进全部落点; 落点集外宿主永不在本卡动作集 (无「部分黑」稳态)
    if (blacked) {
      for (const g of status.negative) removeNegativeFromTarget(g.id, tag.tag_id)
      toast(`已从 ${status.negative.map(hostLabel).join('、')} 负向移出`)
      return
    }
    // 落点集为空 (非 tag-rec 卡无来源组且无草稿组) => 组选择 Modal 兜底 (票 19: 仅此时弹)
    // 多落点 (多组认领/同名组) => 同弹选择器并预勾全部落点: 任一放行语义下少勾一组卡就死不透,
    //   预勾保底语义正确 + 用户可现场摘选 (实机修复: 同名双胞胎组按名解析会全中, 盲写不可见)
    if (!landingGroups.length || landingGroups.length > 1) {
      setPickerIds(landingGroups.map((g) => g.id))
      setPickerOpen(true)
      return
    }
    addNegativeToTargets(landingGroups)
  })

  // ———— ★ 四档入组 (票 20) ————

  /**
   * ②「当前组」语境: tab2 互斥后恒 1 (票 21) —— 选定组 (pickTagGroupsByIds 停用防御同 service);
   * 无选定组但有草稿组 => 草稿组; 皆无 (tab1/非 tag-rec 语境) => 此项不渲染
   */
  const selectedGroup = pickTagGroupsByIds(groups, selectedGroupIds)[0]
  const alreadyInSelected = !!selectedGroup && selectedGroup.tag_ids.some((e) => e.id === tag.tag_id)
  /** 票 22: ∈expandedIds 暂存位 (或本就是锚点) => 菜单禁选标「已扩进」; 票 27: ★ 紫染暂存态直点取消 */
  const inExpanded = expandedIds.some((e) => e.id === tag.tag_id)
  const isAnchor = anchor?.id === tag.tag_id
  const alreadyExpanded = inExpanded || isAnchor
  const expandedMark = inExpanded ? ' (已扩进)' : isAnchor ? ' (已在查询单元)' : ''

  // 票 07: ★ 入组档与报告与 WorkingTagRow 共用同一实现
  const { reportAddResult, createGroupAndOfferOpen, openAddPicker, addPickerModal } = useTagGroupAddPicker({
    tag,
    relatedGroups,
    enabledGroups,
  })

  /**
   * ② 落地 (票 22): 两语境统一写 expandedIds 暂存位 —— 与「下拉勾选扩进」同义, 下一轮进查询单元;
   * 不再即时 addTagIdsToGroup, 入表收口到存成项 (选定组语境 = 并入该组; 草稿语境 = 升级建组)。
   * pushExpandedIds 收口去重 (已在暂存/锚点/当前组真成员跳过), 菜单禁选已先拦
   */
  const addToCurrentCtx = useMemoizedFn(() => {
    if (!selectedGroup && !tagRecCustomSession.draftGroup) return
    if (alreadyExpanded || alreadyInSelected) return
    if (!pushExpandedIds([{ ...entry }], selectedGroup?.tag_ids).length) {
      toast('该标签已在组或扩选暂存中')
      return
    }
    toast(selectedGroup ? '已扩进本次查询,「并入当前组」时随暂存层固化' : '已扩进本次查询,存成项时随组入表')
  })

  // ★ 小菜单 (spec §4.6/票 19/票 20): 落点集内有宿主 => 「从当前组移出」+「移出相关组…」+ 逐宿主启停 + 入组档 ②③④;
  // 落点集内无宿主 (含仅落点集外收藏) => ①新建收藏项 + ②③④ (+ 落点外宿主 => 「移出相关组…」)
  const favedOutside = status.favedOutside
  const [removePickerOpen, setRemovePickerOpen] = useState(false)
  const [removePickerIds, setRemovePickerIds] = useState<string[]>([])
  const removeFromLanding = useMemoizedFn(() => {
    for (const g of favedHosts) favorites.removeTagIdFromGroup(g.id, tag.tag_id)
  })
  const favMenuItems = defineAntMenus([
    // 移出: 单落点 => 原名直译; 多落点 (多组认领/同名双胞胎) => 一项清全部落点宿主
    ...(favedHosts.length === 1
      ? [
          favedHosts[0].tag_ids.length === 1 && {
            key: `fav-empty-group-${favedHosts[0].id}`,
            label: `从${hostLabelEx(favedHosts[0], statusGroups)}移出此标签 (保留空组)`,
            onClick: () => favorites.removeTagIdFromGroup(favedHosts[0].id, tag.tag_id),
          },
          favedHosts[0].tag_ids.length > 1
            ? {
                key: `fav-remove-id-${favedHosts[0].id}`,
                label: `从${hostLabelEx(favedHosts[0], statusGroups)}移出此标签`,
                onClick: () => favorites.removeTagIdFromGroup(favedHosts[0].id, tag.tag_id),
              }
            : {
                key: `fav-remove-group-${favedHosts[0].id}`,
                label: `删除标签组「${favedHosts[0].name}」`,
                danger: true,
                onClick: () => favorites.removeGroup(favedHosts[0].id),
              },
        ]
      : []),
    favedHosts.length > 1 && {
      key: 'fav-remove-landing',
      label: `从当前组移出此标签 (${favedHosts.length} 个落点组)`,
      onClick: removeFromLanding,
    },
    // 落点集外也有宿主 => 「移出相关组…」选择器 (实机修复: 同名组逐项平铺不可区分)
    !!favedOutside.length && {
      key: 'fav-remove-related',
      label: `移出相关组… (还有 ${favedOutside.length} 组收藏了此标签)`,
      onClick: () => {
        setRemovePickerIds([])
        setRemovePickerOpen(true)
      },
    },
    // 落点集内逐宿主: 启停 (同名消歧)
    ...favedHosts.map((g): AntMenuItem => ({
      key: `fav-toggle-enabled-${g.id}`,
      label: `${g.enabled ? '停用' : '启用'}组${hostLabelEx(g, favedHosts)}`,
      onClick: () => favorites.updateGroup(g.id, { enabled: !g.enabled }),
    })),
    !!favedHosts.length && { type: 'divider', key: 'fav-add-divider' },
    // ① 新建收藏项 (仅未收藏分支)
    !favedHosts.length && { key: 'fav-new-group', label: '新建收藏项', onClick: createGroupAndOfferOpen },
    // ② 加入当前组 (票 22: 两语境统一写 expandedIds 暂存位; 已在组内/已扩进 => 禁选幂等)
    !!(selectedGroup || draftGroup) &&
      (selectedGroup
        ? {
            key: 'fav-into-current',
            label: `加入当前组「${selectedGroup.name}」${alreadyInSelected ? ' (已在组内)' : expandedMark}`,
            disabled: alreadyInSelected || alreadyExpanded,
            onClick: addToCurrentCtx,
          }
        : {
            key: 'fav-into-current',
            label: `加入当前组(草稿)「${draftGroup!.name}」${expandedMark}`,
            disabled: alreadyExpanded,
            onClick: addToCurrentCtx,
          }),
    // ③ 加入相关组… (无交集组 => 禁选, 菜单形态稳定)
    {
      key: 'fav-into-related',
      label: relatedGroups.length ? '加入相关组…' : '加入相关组… (本视频 tag 无交集组)',
      disabled: !relatedGroups.length,
      onClick: () => openAddPicker('related'),
    },
    // ④ 加入全部组… (enabled 组)
    {
      key: 'fav-into-all',
      label: enabledGroups.length ? '加入全部组…' : '加入全部组… (暂无可用组)',
      disabled: !enabledGroups.length,
      onClick: () => openAddPicker('all'),
    },
  ])

  return (
    <div className='flex items-center gap-x-4px b-b-1px b-gate-border b-b-solid py-4px last:b-b-0'>
      {/* tag_name + #tag_id: 保留真链接, 目标为脚本「标签发掘」深链 —— 新标签页以此标签开新组合 */}
      <div className='min-w-0 flex-1'>
        <span className='truncate' title={tag.tag_name}>
          {tag.tag_name}
        </span>
        <Typography.Link
          className='ml-6px text-12px'
          href={buildTagRecCustomDeepLink(location.origin, { seed: { id: tag.tag_id, name: tag.tag_name } })}
          target='_blank'
          rel='noopener noreferrer'
          title='新标签页打开「标签发掘」· 以此标签开新组合'
        >
          #{tag.tag_id}
        </Typography.Link>
      </div>

      {/* 票 24: tag_type 徽标不渲 (old_channel 噪音, 数据仍留 schema/经 backfillTagTypes 回填收藏表) */}

      {/* 状态区 (票 23 chip 精简): 仅留「组X变体」chip —— ★/⛔ 集内态靠图标亮灭/红灰自足表达,
          落点集外「·他组」chip 撤 (他组归属知情通路 = ★菜单③相关组 Modal, 票 20) */}
      {status.variant && (
        <AntdTooltip
          title={`与组「${status.variant.group.name}」内「${status.variant.entry.name}」归一化同形 (不同 tag_id)`}
        >
          <Tag color='blue' className='mr-0'>
            组「{status.variant.group.name}」变体
          </Tag>
        </AntdTooltip>
      )}

      {/* 动作列: ★ 小菜单; 票 27: ∈扩选暂存 => 紫★ 直点取消暂存 (不开菜单, ⛔ 二态翻转同款心智) */}
      {inExpanded ? (
        <AntdTooltip title='扩选暂存中 · 点击取消扩选 (下一轮生效)'>
          <Button
            size='small'
            type='text'
            className='px-2px'
            icon={
              <span className='inline-flex' style={{ color: token.purple6 }}>
                <IconForFav className='size-14px' />
              </span>
            }
            onClick={() => removeExpandedId(tag.tag_id)}
          />
        </AntdTooltip>
      ) : (
        <Dropdown menu={{ items: favMenuItems }} trigger={['click']} placement='bottomRight'>
          <Button
            size='small'
            type='text'
            className='px-2px'
            icon={
              favedHosts.length ? (
                <IconForFaved className='size-14px color-gate-primary' />
              ) : (
                <IconForFav className='size-14px' />
              )
            }
            title={
              favedHosts.length
                ? `已收藏于 ${favedHosts.map((g) => hostLabelEx(g, statusGroups)).join('')}`
                : '收藏此标签'
            }
          />
        </Dropdown>
      )}

      {/* 动作列: ⛔ 负向二态翻转 (票 19: 落点集内黑 => 全解; 未黑 => 加全部落点; 无落点 => 选择器) */}
      <AntdTooltip title={TAG_POPOVER_BLACKLIST_TOOLTIP}>
        <Button
          size='small'
          type='text'
          danger={blacked}
          className='px-2px'
          icon={<IconForTagBlock className='size-14px' />}
          onClick={onToggleNegative}
        />
      </AntdTooltip>

      {/* ⛔ 落点选择器: 无归属来源可解析时弹 (非 tag-rec 卡片/全空归因);
          多落点也弹 (预勾全部落点 —— 任一放行语义下少勾一组卡就死不透, 可现场摘选) */}
      <Modal
        title='拉进哪组的负向'
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onOk={() => {
          const targets = statusGroups.filter((g) => pickerIds.includes(g.id))
          setPickerOpen(false)
          if (targets.length) addNegativeToTargets(targets)
        }}
        okText='加入负向'
        // [tag-rec] UIUX-U7: 空选择禁用主钮 (与下两枚 picker Modal 同口径)
        okButtonProps={{ disabled: !pickerIds.length }}
        width={360}
      >
        <Select
          mode='multiple'
          className='mt-12px w-full'
          placeholder='选择标签组 (含草稿组)'
          value={pickerIds}
          onChange={setPickerIds}
          options={statusGroups.map((g) => ({
            value: g.id,
            label:
              g.id === DRAFT_GROUP_ID
                ? `草稿组「${g.name}」`
                : `${g.name} (${g.tag_ids.length} 个 id·#${g.id.slice(0, 4)})`,
          }))}
        />
      </Modal>

      {/* ★「移出相关组…」: 落点集外宿主多选移除 (最后 1 个 id 拒移由门面 toast) */}
      <Modal
        title='移出相关组 (本卡落点外也收藏了此标签的组)'
        open={removePickerOpen}
        onCancel={() => setRemovePickerOpen(false)}
        onOk={() => {
          const targets = favedOutside.filter((g) => removePickerIds.includes(g.id))
          setRemovePickerOpen(false)
          for (const g of targets) favorites.removeTagIdFromGroup(g.id, tag.tag_id)
          if (targets.length) toast(`已从 ${targets.map((g) => hostLabelEx(g, statusGroups)).join('、')} 移出`)
        }}
        okText='移出'
        okButtonProps={{ disabled: !removePickerIds.length }}
        width={360}
      >
        <Select
          mode='multiple'
          className='mt-12px w-full'
          placeholder='选择标签组'
          value={removePickerIds}
          onChange={setRemovePickerIds}
          options={favedOutside.map((g) => ({
            value: g.id,
            label: `${g.name} (${g.tag_ids.length} 个 id)`,
          }))}
        />
      </Modal>

      {/* ★ 入组选择器 (票 20 ③④/票 07 共享件): related=组 tag_ids ∩ 本视频 tag_ids 命中组, all=enabled 组 */}
      {addPickerModal}
    </div>
  )
}

function WorkingTagRow({
  tag,
  groups,
  relatedGroups,
  enabledGroups,
}: {
  tag: VideoTag
  /** 收藏表组全集 (★ 宿主判定) */
  groups: TagGroup[]
  /** 票 07 ③「加入相关组」候选 (组 tag_ids ∩ 本视频全部 tag_ids ≠ ∅) */
  relatedGroups: TagGroup[]
  /** 票 07 ④「加入全部组」候选 (enabled 组) */
  enabledGroups: TagGroup[]
}) {
  const combination = useSnapshot(tagRecCustomSession).workingGroup?.combination
  const positives = combination
    ? tagRecConditionAtoms(combination.include).filter((a) => a.field === 'tag' && a.value.id === tag.tag_id)
    : []
  const negatives = combination?.exclude.filter((a) => a.field === 'tag' && a.value.id === tag.tag_id) ?? []
  const atom = () => tagRecConditionAtom('tag', videoTagToTagIdEntry(tag))
  const add = () => addTagRecWorkingCondition(atom())
  const exclude = () => excludeTagRecWorkingCondition(atom())
  const only = () => exploreTagRecTagOnly(videoTagToTagIdEntry(tag))

  // 票 07 旧标签行接回: ★ 档与 TagRow 共享同一实现; 工作台语境无落点集,
  //   宿主判定放宽到「任意收藏表组持有此 tag」
  const favedGroups = groups.filter((g) => g.tag_ids.some((e) => e.id === tag.tag_id))
  const { createGroupAndOfferOpen, openAddPicker, addPickerModal } = useTagGroupAddPicker({
    tag,
    relatedGroups,
    enabledGroups,
  })
  const favMenuItems = defineAntMenus([
    ...favedGroups.map((g): AntMenuItem => ({
      key: `fav-remove-${g.id}`,
      label: `从${hostLabelEx(g, favedGroups)}移出此标签`,
      onClick: () => favorites.removeTagIdFromGroup(g.id, tag.tag_id),
    })),
    !!favedGroups.length && { type: 'divider', key: 'fav-remove-divider' },
    !favedGroups.length && { key: 'fav-new-group', label: '新建收藏项', onClick: createGroupAndOfferOpen },
    {
      key: 'fav-into-related',
      label: relatedGroups.length ? '加入相关组…' : '加入相关组… (本视频 tag 无交集组)',
      disabled: !relatedGroups.length,
      onClick: () => openAddPicker('related'),
    },
    {
      key: 'fav-into-all',
      label: enabledGroups.length ? '加入全部组…' : '加入全部组… (暂无可用组)',
      disabled: !enabledGroups.length,
      onClick: () => openAddPicker('all'),
    },
  ])

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [
          { key: 'only', label: '仅看这个标签', onClick: only },
          { key: 'add', label: '选入当前组合', onClick: add },
          { key: 'exclude', label: '这个组合不看', onClick: exclude },
          {
            key: 'global',
            label: '以后都不看（全部标签推荐）',
            onClick: () => {
              blockTagRecConditionGlobally(atom())
              toast('已加入全局排除，可在工作台直接移除')
            },
          },
        ],
      }}
    >
      <div className='flex items-center gap-6px py-4px'>
        {/* 票 07: #tag_id 真链接 —— 新标签页直达「标签发掘」以此标签开新组合 */}
        <Typography.Text className='min-w-0 flex-1'>
          {tag.tag_name}
          <Typography.Link
            className='ml-6px text-12px'
            href={buildTagRecCustomDeepLink(location.origin, { seed: { id: tag.tag_id, name: tag.tag_name } })}
            target='_blank'
            rel='noopener noreferrer'
            title='新标签页打开「标签发掘」· 以此标签开新组合'
          >
            #{tag.tag_id}
          </Typography.Link>
          <Typography.Link
            className='ml-6px text-12px'
            title='仅看这个标签 · 当前组合记入最近尝试，开始解析共现标签'
            onClick={only}
          >
            仅看
          </Typography.Link>
        </Typography.Text>
        <Dropdown menu={{ items: favMenuItems }} trigger={['click']} placement='bottomRight'>
          <Button
            size='small'
            type='text'
            className='px-2px'
            icon={
              favedGroups.length ? (
                <IconForFaved className='size-14px color-gate-primary' />
              ) : (
                <IconForFav className='size-14px' />
              )
            }
            title={favedGroups.length ? `已收藏于 ${favedGroups.map((g) => `「${g.name}」`).join('')}` : '收藏此标签'}
          />
        </Dropdown>
        <Button
          size='small'
          type={positives.length ? 'primary' : 'default'}
          onClick={() => (positives.length ? positives.forEach((a) => removeTagRecWorkingCondition(a.id)) : add())}
        >
          {positives.length ? '已选 · 移出' : '选入'}
        </Button>
        <Button
          size='small'
          danger={!!negatives.length}
          onClick={() => (negatives.length ? negatives.forEach((a) => removeTagRecWorkingCondition(a.id)) : exclude())}
        >
          {negatives.length ? '恢复' : '不看'}
        </Button>
        {addPickerModal}
      </div>
    </Dropdown>
  )
}
