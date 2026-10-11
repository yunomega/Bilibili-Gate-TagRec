import { useMemoizedFn } from 'ahooks'
import { Input, Modal, Popover, Tag, Typography } from 'antd'
import { useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { snapshot, useSnapshot } from 'valtio'
import { APP_CLS_CARD } from '$common'
import { usePopoverBorderColor } from '$common/emotion-css'
import { useOnRefresh } from '$components/Recommends/rec.shared'
import { VideoCardActionButton } from '$components/VideoCard/child-components/VideoCardActions'
import { EApiType, ETab } from '$enums'
import { setNicknameCache } from '$modules/bilibili/user/nickname'
import { checkIsNormalVideo, type IVideoCardData } from '$modules/filter/normalize'
import {
  getNewestValueOfSettingsInnerArray,
  settings,
  updateSettings,
  updateSettingsInnerArray,
} from '$modules/settings'
import toast from '$utility/toast'
import { planTitleKeywordWrites, planUpBlockWrite, splitTitleToSegments } from '../model/block-write'
import { lookupSnapshotCardOwners } from '../model/card-owners'
import { tagRecConditionAtom } from '../model/combination'
import { stripRelatedSuffix } from '../model/dig'
import { tagRecPartitionParent } from '../model/partition'
import { PARTITION_NAME_TO_PARENT } from '../model/partition-table'
import { resolveLandingGroups } from '../model/tag-status'
import { writeTagRecTempEntry } from '../service/temp-writes'
import { favorites, favoritesStore } from '../store'
import { blockTagRecConditionGlobally } from '../store/combination-blocks'
import { openTagRecVideoMaterials } from '../store/discovery-ui'
import { tagRecCustomSession, type TagRecFilterSessionScope } from '../store/session'
import { addTagRecWorkingCondition, excludeTagRecWorkingCondition, tagRecWorkbench } from '../store/workbench'
import { TagRecFilterMenuLabel, TagRecFilterMenuSection } from '../ui/filter-menu-label'
import {
  IconForFilterAuthor,
  IconForFilterDescription,
  IconForFilterPartition,
  IconForFilterTitle,
  IconForTagManage,
} from '../ui/icons'
import { TagRecTagPopover } from '../ui/tag-popover'
import type { RecItemType } from '$define'
import type { AntMenuItem } from '$modules/antd'
import type { TagRecNegativeRules, TagRecPartitionEntry } from '../model/types'

function filterMenuSections(key: string, block: AntMenuItem[], allow: AntMenuItem[]): AntMenuItem[] {
  return [
    { key: `${key}:block-section`, type: 'group', label: <TagRecFilterMenuSection mode='block' />, children: block },
    { key: `${key}:divider`, type: 'divider' },
    { key: `${key}:allow-section`, type: 'group', label: <TagRecFilterMenuSection mode='allow' />, children: allow },
  ]
}

/**
 * [tag-rec] 🏷 标签管理入口 hook (spec §4.6 / §5.3)
 * - 产出 VideoCardActionButton (inlinePosition='right' 进 topRightActionsEl) + 右键菜单项「标签」
 * - 挂点 tab 无关: 全 tab 卡片生效 (不写 tab 门控); 仅 av 视频启用 (view/detail/tag 需要 bvid)
 * - 弹层挂卡片就近容器 (与右键菜单 Dropdown 同策略, 不挂 body); 点开才发请求
 * - 票 33: 右键组加「屏蔽此 UP」「按标题关键词屏蔽…」= 全局 filter.byAuthor/byTitle
 *   + tagRec.filter.dims.upBlacklist/titleKeywords 双写 (单写任一边另一面漏放, spec §4.7);
 *   纯规划逻辑在 model/block-write.ts, 此处只做落定
 * - filter-scope 票02/12: 屏蔽项分档「本组/全局」—— 本组 = 逐认领组 overrides.negative 写入
 *   (归因名剥 ·相关 后缀找组, 只杀本组流量); 全局档维持票33双写 (byAuthor/byTitle 连带主 feed)
 * - 「分区名单 (屏蔽/仅看)」子菜单 (拆池实修): 当前视频的子分区(tidv2)/一级分区(pid_v2)/旧体系(tid)
 *   ×「本组(含草稿组兜底)/全局」×「屏蔽/仅看」; 屏蔽写 partitionBlock (命中即滤),
 *   仅看写 partitionAllow (域收窄池, 入池即开闸); 同分区两池同存时屏蔽先判赢
 * - 对象入口配独立图标与说明；屏蔽/仅看分段，临时/本组/全局用范围徽标和生效说明。
 *   仅看家族 (upAllow/titleAllow/descAllow/partitionAllow) 域收窄, 开启 toast 防呆「可能刷不出视频」;
 *   简介词入口依赖 cardData.tagRecDesc (tag/top 池条目无 desc => 该项禁用)
 * - 临时档写所在页的过滤差分并记账；主题推荐换查看范围清除，标签发掘换锚点池清除。
 */
export function useTagManageRelated({
  cardData,
  actionButtonVisible,
  tab,
  item,
}: {
  cardData: IVideoCardData
  actionButtonVisible: boolean
  /** 临时档仅推荐两页展示，各自使用独立会话态。 */
  tab: ETab
  /** tab2 卡片: 「标签管理」右键改道「从视频取条件」抽屉 (弹层锚点被取词/理由按钮顶替, 不挂) */
  item?: RecItemType
}) {
  const { bvid, goto, title, authorName, authorMid } = cardData
  /** R8: 简介词入口原料 (tag/top 池条目无 desc => 简介子菜单禁用) */
  const descText = cardData.tagRecDesc
  const enabled = !!bvid && checkIsNormalVideo(goto)
  const tagRecItem = tab === ETab.TagRecCustom && item?.api === EApiType.TagRec ? item : undefined
  const [popoverOpen, setPopoverOpen] = useState(false)
  const anchorWrapRef = useRef<HTMLSpanElement | null>(null)
  const getPopupContainer = useCallback(() => {
    // 弹层容器 = 卡片就近 (右键菜单 Dropdown 同款策略), fallback body
    return anchorWrapRef.current?.closest<HTMLElement>(`.${APP_CLS_CARD}`) ?? document.body
  }, [])
  const borderColor = usePopoverBorderColor()

  const openTagPopover = useMemoizedFn(() => setPopoverOpen(true))

  const canUseTemp = tab === ETab.TagRecCustom || tab === ETab.TagRecFav
  const tempScope: TagRecFilterSessionScope = tab === ETab.TagRecFav ? 'fav' : 'custom'
  const tempResetLabel = tab === ETab.TagRecFav ? '切换查看范围后恢复' : '切换查询后恢复'
  const onRefresh = useOnRefresh()
  /** R8 临时账用认领组名 (剥 ·相关; 与 writeOwningGroups 同语义) */
  const ownerNames = useMemo(
    () => [...new Set((cardData.tagRecGroupNames ?? []).map(stripRelatedSuffix))],
    [cardData.tagRecGroupNames],
  )

  /**
   * 组级名单写位 (票02): 逐认领组 (tagRecGroupNames 剥 ·相关 后缀) overrides.negative 容器;
   * fn 返回 true=该组有新写入; 返回写入组数 (0 => 调用侧 toast 未归属/已存在)
   * 实修: 未归属来源名回落草稿组 (与 resolver fallbackGroup 同语义) —— tab2 解析未存成项也可先屏蔽,
   * 「顺手存成项」升级时草稿组 negative 随组入表
   */
  const writeOwningGroups = useMemoizedFn((fn: (neg: TagRecNegativeRules) => boolean) => {
    const names = new Set((cardData.tagRecGroupNames ?? []).map(stripRelatedSuffix))
    let n = 0
    for (const g of resolveLandingGroups(favorites.list, [], [...names], cardData.tagRecGroupIds)) {
      g.overrides ??= {}
      g.overrides.negative ??= {}
      if (fn(g.overrides.negative)) n++
    }
    const draft = tagRecCustomSession.draftGroup
    // 草稿组兜底: 未命中收藏表的来源名归草稿 (与 resolver fallbackGroup 同语义);
    //   空认领 (names 空) 也归草稿 —— resolver 对无认领条目走 fallbackGroup 链
    if (
      draft &&
      !cardData.tagRecGroupIds?.length &&
      (!names.size || [...names].some((x) => !favorites.list.some((g) => g.name === x)))
    ) {
      draft.negative ??= {}
      if (fn(draft.negative)) n++
    }
    return n
  })
  // W2-2: 渲染期读代理须走 useSnapshot —— 裸读 proxy 不订阅, 组增删/草稿组变化后计数与「未归属」门控陈旧
  const favSnapList = useSnapshot(favoritesStore).list
  const draftName = useSnapshot(tagRecCustomSession).draftGroup?.name
  const [ownerGroupCount, ownerLabel, groupScopeDescription] = useMemo(() => {
    // list 引用订阅保留组修改后的刷新；实际查找用共享不可变快照，避免逐卡创建深层跟踪代理。
    const { matched, hasUnowned } = lookupSnapshotCardOwners(
      snapshot(favoritesStore).list,
      ownerNames,
      cardData.tagRecGroupIds,
    )
    const draft = draftName !== undefined && !cardData.tagRecGroupIds?.length && (!ownerNames.length || hasUnowned)
    const parts = [matched.length ? `${matched.length} 个认领组` : '', draft ? '草稿组' : ''].filter(Boolean)
    const description = [
      matched.length ? `长期 · 仅${matched.map((g) => `「${g.name}」`).join('、')}` : '',
      draft ? `当前查询「${draftName}」· 可随标签组保存` : '',
    ]
      .filter(Boolean)
      .join(' / ')
    return [
      matched.length + (draft ? 1 : 0),
      parts.join('+') || '未归属',
      description || '此视频没有所属标签组',
    ] as const
  }, [favSnapList, ownerNames, cardData.tagRecGroupIds, draftName])

  const scopeDescription = (scope: 'group' | 'global' | 'temp', includesHome = false) =>
    scope === 'temp'
      ? '仅本次查询 · 切换后恢复'
      : scope === 'group'
        ? groupScopeDescription
        : includesHome
          ? '长期生效 · 首页与标签推荐'
          : '长期生效 · 全部标签推荐'

  const actionLabel = (
    mode: 'block' | 'allow',
    target: string,
    scope: 'group' | 'global' | 'temp',
    includesHome = false,
  ) => (
    <TagRecFilterMenuLabel
      title={`${mode === 'block' ? '屏蔽' : '仅看'}${target}`}
      scope={scope === 'temp' ? '临时' : scope === 'group' ? '本组' : '全局'}
      description={scopeDescription(scope, includesHome)}
      disabled={scope === 'group' && !ownerGroupCount}
    />
  )

  // #region R8 关键词 Modal (屏蔽/仅看 × 标题/简介 × 本组/全局/临时) —— 票 33 标题屏蔽的泛化版
  const [kwModal, setKwModal] = useState<{
    mode: 'block' | 'allow'
    scope: 'group' | 'global' | 'temp'
    source: 'title' | 'desc'
  }>()
  const [kwDraft, setKwDraft] = useState('')
  const [checkedSegs, setCheckedSegs] = useState<ReadonlySet<string>>(new Set())
  const kwSourceText = kwModal ? (kwModal.source === 'desc' ? (descText ?? '') : title) : ''
  const kwSegs = useMemo(() => (kwSourceText ? splitTitleToSegments(kwSourceText) : []), [kwSourceText])

  const openKwModal = useMemoizedFn(
    (mode: 'block' | 'allow', scope: 'group' | 'global' | 'temp', source: 'title' | 'desc') => {
      setKwModal({ mode, scope, source })
      setKwDraft(source === 'desc' ? (descText ?? '') : title) // 完整文本预填, 可整体编辑删改
      setCheckedSegs(new Set())
    },
  )
  const toggleSeg = useMemoizedFn((seg: string, checked: boolean) => {
    setCheckedSegs((prev) => {
      const next = new Set(prev)
      if (checked) next.add(seg)
      else next.delete(seg)
      return next
    })
  })

  const onConfirmKw = useMemoizedFn(async () => {
    if (!kwModal) return
    const draft = kwDraft.trim()
    const words = draft ? [draft, ...checkedSegs] : [...checkedSegs] // 编辑后文本 + 各选中词
    if (!words.length) return
    const { mode, scope, source } = kwModal
    const isTitle = source === 'title'
    const what = `${isTitle ? '标题' : '简介'}${mode === 'block' ? '屏蔽词' : '仅看词'}`
    setKwModal(undefined)
    // 临时档写所在页的差分并记账，可在「过滤」里固化。
    if (scope === 'temp') {
      let ok = 0
      for (const w of words) {
        const kind = isTitle
          ? mode === 'block'
            ? 'titleBlock'
            : 'titleAllow'
          : mode === 'block'
            ? 'descBlock'
            : 'descAllow'
        const r = writeTagRecTempEntry({
          scope: tempScope,
          kind,
          value: w,
          label: `${mode === 'block' ? '屏蔽' : '仅看'} ${isTitle ? '标题' : '简介'}词: ${w}`,
          owningGroupNames: ownerNames,
          owningGroupIds: cardData.tagRecGroupIds,
        })
        if (r === 'ok') ok++
      }
      if (ok) void onRefresh('refresh')
      return toast(
        ok
          ? `已临时${mode === 'block' ? '屏蔽' : '仅看'} ${ok} 个${what} (${tempResetLabel}; 可在「过滤」里保存)`
          : `${what}已存在于临时名单`,
      )
    }
    if (scope === 'group') {
      const n = writeOwningGroups((neg) => {
        if (mode === 'block') {
          const key = isTitle ? 'title' : 'desc'
          neg[key] ??= []
          let hit = false
          for (const w of words) if (!neg[key]!.includes(w)) (neg[key]!.push(w), (hit = true))
          return hit
        }
        const key = isTitle ? 'titleAllow' : 'descAllow'
        neg[key] ??= { enabled: true, list: [] }
        let hit = false
        for (const w of words) if (!neg[key]!.list.includes(w)) (neg[key]!.list.push(w), (hit = true))
        neg[key]!.enabled = true
        return hit
      })
      return toast(
        n
          ? `已在本组添加 ${words.length} 个${what} (${ownerLabel}生效${
              mode === 'allow' ? ' —— 本组流量只剩命中项, 可能刷不出视频' : ''
            })`
          : `${what}均已存在 (或未归属组)`,
      )
    }
    // 全局档: 仅屏蔽 (仅看家族全局档只对分区有意义 —— 窄口径全局仅看无意义, Q4)
    if (mode === 'allow') return
    if (isTitle) {
      const dims = settings.tagRec.filter.dims // 同 onBlockUp 注: handler 内现取
      const globalKw = await getNewestValueOfSettingsInnerArray('filter.byTitle.keywords')
      const plan = planTitleKeywordWrites(words, globalKw, dims.titleKeywords.list)
      if (plan.globalAdds.length) await updateSettingsInnerArray('filter.byTitle.keywords', { add: plan.globalAdds })
      // R5-P1-08: 同上 —— 主推荐 byTitle.enabled 一并开启, 否则 toast 承诺的「双生效」只对 tag-rec 成立
      updateSettings({ filter: { byTitle: { enabled: true } } })
      if (plan.tagRecAdds.length) dims.titleKeywords.list.push(...plan.tagRecAdds)
      dims.titleKeywords.enabled = true
      const added = words.length - plan.skipped.length
      const skipNote = plan.skipped.length ? `, 跳过已存在 ${plan.skipped.length} 个` : ''
      return toast(
        added ? `已添加 ${added} 个标题关键词 (全局过滤 + 标签推荐双生效)${skipNote}` : `关键词均已存在${skipNote}`,
      )
    }
    // 简介全局屏蔽: 主 feed 无 byDesc 全局档 —— 仅标签推荐 (维度开闸)
    const dims = settings.tagRec.filter.dims
    let added = 0
    for (const w of words) if (!dims.descKeywords.list.includes(w)) (dims.descKeywords.list.push(w), added++)
    dims.descKeywords.enabled = true
    toast(added ? `已添加 ${added} 个简介屏蔽词 (标签推荐全局生效)` : '关键词均已存在')
  })
  // #endregion

  // #region 票 33 「屏蔽此 UP」: filter.byAuthor.keywords + dims.upBlacklist 双写
  // 注: dims 在 handler 内现取 —— applyTagRecPreset 会整套换 dims 对象, render 期捕获会变陈引用
  const onBlockUpGlobal = useMemoizedFn(async () => {
    const dims = settings.tagRec.filter.dims
    const mid = authorMid && /^\d+$/.test(authorMid) ? Number(authorMid) : undefined
    const plan = planUpBlockWrite({ name: authorName, mid }, settings.filter.byAuthor.keywords, dims.upBlacklist.list)

    if (plan.globalAdd) await updateSettingsInnerArray('filter.byAuthor.keywords', { add: [plan.globalAdd] })
    // R5-P1-08: 「全局过滤双生效」承诺须真开主推荐开关 —— 原只写名单, enabled 恒 false 主 feed 不过滤
    updateSettings({ filter: { byAuthor: { enabled: true } } })
    if (plan.tagRecAdd) dims.upBlacklist.list.push(plan.tagRecAdd)
    dims.upBlacklist.enabled = true // 用户主动屏蔽 => 维度确保开
    if (authorMid && authorName) void setNicknameCache(authorMid, authorName) // 同「加入过滤列表」先例: mid 名单显示靠昵称缓存

    if (!plan.globalAdd && !plan.tagRecAdd) return toast(`UP「${authorName || authorMid}」已在屏蔽名单`)
    toast(`已屏蔽 UP「${authorName || authorMid}」(全局过滤 + 标签推荐双生效)`)
  })

  /** 票02/12 本组档: 只写认领组 negative.up (不动全局; 票33 双写由全局档独享) */
  const onBlockUpGroup = useMemoizedFn(() => {
    const mid = authorMid && /^\d+$/.test(authorMid) ? Number(authorMid) : undefined
    const entry = { name: authorName?.trim() ?? '', mid }
    const n = writeOwningGroups((neg) => {
      neg.up ??= []
      if (neg.up.some((e) => (mid !== undefined ? e.mid === mid : e.name === entry.name))) return false
      neg.up.push(entry)
      return true
    })
    if (!n) return toast(`UP「${authorName || authorMid}」已在各认领组名单 (或未归属组)`)
    toast(`已在本组屏蔽 UP「${authorName || authorMid}」(${ownerLabel}生效)`)
  })
  // #endregion

  // #region R8 仅看 UP 家族: 本组 = negative.upAllow 域收窄; 临时 = 会话覆盖 + 记账 (无全局档)
  const onAllowUpGroup = useMemoizedFn(() => {
    const mid = authorMid && /^\d+$/.test(authorMid) ? Number(authorMid) : undefined
    const entry = { name: authorName?.trim() ?? '', mid }
    const n = writeOwningGroups((neg) => {
      neg.upAllow ??= { enabled: true, list: [] }
      if (neg.upAllow.list.some((e) => (mid !== undefined ? e.mid === mid : e.name === entry.name))) return false
      neg.upAllow.list.push(entry)
      neg.upAllow.enabled = true
      return true
    })
    if (!n) return toast(`UP「${authorName || authorMid}」已在各认领组仅看池 (或未归属组)`)
    toast(
      `已把 UP「${authorName || authorMid}」加入本组仅看 (${ownerLabel})；开启过滤后${mid ? '名单全部带 UID 时按标签名搜索 UP 投稿，可能漏掉仅视频标签命中的内容' : '在原结果中筛选该 UP'}`,
    )
  })
  const onBlockUpTemp = useMemoizedFn(() => {
    const mid = authorMid && /^\d+$/.test(authorMid) ? Number(authorMid) : undefined
    const r = writeTagRecTempEntry({
      scope: tempScope,
      kind: 'upBlock',
      value: { name: authorName?.trim() ?? '', mid },
      label: `屏蔽 UP: ${authorName || authorMid}`,
      owningGroupNames: ownerNames,
      owningGroupIds: cardData.tagRecGroupIds,
    })
    if (r === 'ok') void onRefresh('refresh')
    toast(
      r === 'ok'
        ? `已临时屏蔽 UP「${authorName || authorMid}」(${tempResetLabel}; 可在「过滤」里保存)`
        : `UP「${authorName || authorMid}」已在临时名单`,
    )
  })
  const onAllowUpTemp = useMemoizedFn(() => {
    const mid = authorMid && /^\d+$/.test(authorMid) ? Number(authorMid) : undefined
    const r = writeTagRecTempEntry({
      scope: tempScope,
      kind: 'upAllow',
      value: { name: authorName?.trim() ?? '', mid },
      label: `仅看 UP: ${authorName || authorMid}`,
      owningGroupNames: ownerNames,
      owningGroupIds: cardData.tagRecGroupIds,
    })
    if (r === 'ok') void onRefresh('refresh')
    toast(
      r === 'ok'
        ? `已临时仅看 UP「${authorName || authorMid}」；开启过滤后${mid ? '名单全部带 UID 时从 UP 投稿按标签名搜索' : '筛选原结果'} (${tempResetLabel})`
        : `UP「${authorName || authorMid}」已在临时名单`,
    )
  })
  // #endregion

  // #region 分区双池写位 (拆池实修): 「屏蔽此分区」=> partitionBlock 并集池; 「仅看此分区」=> partitionAllow
  //   独立池 (写入即开闸并提示收窄语义, 防误杀靠「默认关+显式入池」); 同分区两池同存时屏蔽先判赢
  const onBlockPartition = useMemoizedFn((entry: TagRecPartitionEntry, scope: 'group' | 'global') => {
    if (scope === 'global') {
      const dim = settings.tagRec.filter.dims.partitionBlock
      if (!dim.list.some((e) => e.v1 === entry.v1 && e.v2 === entry.v2)) dim.list.push(entry)
      dim.enabled = true
      return toast(`已在全局屏蔽分区「${entry.name}」(标签推荐全组生效)`)
    }
    const n = writeOwningGroups((neg) => {
      neg.partitionBlock ??= []
      if (neg.partitionBlock.some((e) => e.v1 === entry.v1 && e.v2 === entry.v2)) return false
      neg.partitionBlock.push(entry)
      return true
    })
    if (!n) return toast(`分区「${entry.name}」已在各认领组屏蔽池 (或未归属)`)
    toast(`已在本组屏蔽分区「${entry.name}」(${ownerLabel}生效)`)
  })
  const onAllowPartition = useMemoizedFn((entry: TagRecPartitionEntry, scope: 'group' | 'global') => {
    if (scope === 'global') {
      const dim = settings.tagRec.filter.dims.partitionAllow
      const dup = dim.list.some((e) => e.v1 === entry.v1 && e.v2 === entry.v2)
      if (dup && dim.enabled) return toast(`分区「${entry.name}」已在全局仅看池`)
      if (!dup) dim.list.push(entry)
      dim.enabled = true // 入池即开 (仅看开关默认关是防误杀, 显式入池=要生效)
      return toast(`已把分区「${entry.name}」加入全局仅看池 —— 标签推荐只剩命中分区 (可在设置里关)`)
    }
    const n = writeOwningGroups((neg) => {
      neg.partitionAllow ??= { enabled: false, list: [] }
      const pa = neg.partitionAllow
      const dup = pa.list.some((e) => e.v1 === entry.v1 && e.v2 === entry.v2)
      if (dup && pa.enabled) return false
      if (!dup) pa.list.push(entry)
      pa.enabled = true // 同上: 入池即开 (复入已存条目 = 重新开闸)
      return true
    })
    if (!n) return toast(`分区「${entry.name}」已在各认领组仅看池 (或未归属)`)
    toast(`已把分区「${entry.name}」加入本组仅看池并开启 (${ownerLabel}生效 —— 本组流量只剩命中分区)`)
  })
  /** R8 临时档: 分区屏蔽/仅看写会话覆盖 + 记账 */
  const onTempPartition = useMemoizedFn((entry: TagRecPartitionEntry, mode: 'block' | 'allow') => {
    const r = writeTagRecTempEntry({
      scope: tempScope,
      kind: mode === 'block' ? 'partitionBlock' : 'partitionAllow',
      value: entry,
      label: `${mode === 'block' ? '屏蔽' : '仅看'} 分区: ${entry.name}`,
      owningGroupNames: ownerNames,
      owningGroupIds: cardData.tagRecGroupIds,
    })
    if (r === 'ok') void onRefresh('refresh')
    toast(
      r === 'ok'
        ? `已临时${mode === 'block' ? '屏蔽' : '仅看'}分区「${entry.name}」(${tempResetLabel}; 可在「过滤」里保存)`
        : `分区「${entry.name}」已在临时名单`,
    )
  })
  // #endregion

  const tagManageActionButtonEl: ReactNode = enabled && (
    <>
      <Popover
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        trigger='click'
        arrow={false}
        placement='bottomRight'
        getPopupContainer={getPopupContainer}
        styles={{ container: { border: `1px solid ${borderColor}` } }}
        content={
          bvid ? (
            <TagRecTagPopover
              bvid={bvid}
              workbenchMode={tab === ETab.TagRecCustom && !!tagRecCustomSession.workingGroup}
              sourceGroupNames={cardData.tagRecGroupNames}
              sourceGroupIds={cardData.tagRecGroupIds}
            />
          ) : undefined
        }
      >
        <span
          ref={anchorWrapRef}
          className='inline-flex'
          onClick={(e: MouseEvent) => {
            // 阻挡冒泡/默认行为到卡片 <a> (防开视频); Popover 切换在同元素上, 不受影响
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <VideoCardActionButton
            visible={actionButtonVisible || popoverOpen}
            active={popoverOpen}
            inlinePosition='right'
            icon={<IconForTagManage className='size-16px' />}
            tooltip='标签'
          />
        </span>
      </Popover>
    </>
  )

  // R8 关键词 Modal (屏蔽/仅看 × 标题/简介 × 本组/全局/临时; 票 33 标题屏蔽泛化):
  //   独立挂回 —— tab2 上 tagManageActionButtonEl 被「取词/理由」顶替不渲染,
  //   Modal 若仍埋在里面会使标题/简介筛选右键项静默失效
  const tagManageModalEl = kwModal && (
    <Modal
      title={
        kwModal
          ? `${kwModal.mode === 'block' ? '屏蔽' : '仅看'}${kwModal.source === 'title' ? '标题' : '简介'}含关键词的视频`
          : ''
      }
      open={!!kwModal}
      onCancel={() => setKwModal(undefined)}
      onOk={onConfirmKw}
      okText={kwModal?.mode === 'block' ? '屏蔽' : '仅看'}
      okButtonProps={{ disabled: !kwDraft.trim() && !checkedSegs.size }} // 空选择禁确认
      width={440}
    >
      <div className='flex flex-col gap-y-8px'>
        <Typography.Text type='secondary' className='text-12px'>
          编辑关键词，或点选下方片段。{kwModal?.mode === 'allow' ? '只保留' : '屏蔽'}包含任意一个关键词的视频。
        </Typography.Text>
        <Typography.Text type='secondary' className='text-12px'>
          作用范围：{kwModal && scopeDescription(kwModal.scope, kwModal.source === 'title')}
        </Typography.Text>
        <Input
          value={kwDraft}
          onChange={(e) => setKwDraft(e.target.value)}
          aria-label='筛选关键词'
          placeholder='输入关键词，或选择下方片段'
        />
        {!!kwSegs.length && (
          <div className='flex flex-wrap gap-4px'>
            {kwSegs.map((seg) => (
              <Tag.CheckableTag key={seg} checked={checkedSegs.has(seg)} onChange={(c) => toggleSeg(seg, c)}>
                {seg}
              </Tag.CheckableTag>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )

  // 票03/12 「屏蔽此分区」条目集: v2 子分区 / v2 一级分区 / v1 旧体系 —— 每级分「本组/全局」档
  const partitionEntries: { key: string; label: string; entry: TagRecPartitionEntry }[] = []
  const parentId =
    cardData.tagRecPidV2 ??
    (cardData.tagRecTidv2 === undefined ? undefined : tagRecPartitionParent(cardData.tagRecTidv2))
  if (cardData.tagRecTidv2 !== undefined) {
    const isParent = parentId === cardData.tagRecTidv2
    const name = cardData.tagRecTnamev2 || `新版${isParent ? '一级' : '子'}分区 #${cardData.tagRecTidv2}`
    partitionEntries.push({
      key: 'v2leaf',
      label: `当前分区「${name}」`,
      entry: { name, v2: cardData.tagRecTidv2, level: isParent ? 'parent' : 'leaf' },
    })
  }
  if (parentId !== undefined && parentId !== cardData.tagRecTidv2) {
    const name =
      cardData.tagRecPidNameV2 ||
      Object.entries(PARTITION_NAME_TO_PARENT).find(([, ids]) => ids.v2 === parentId)?.[0] ||
      `新版一级分区 #${parentId}`
    partitionEntries.push({
      key: 'v2parent',
      label: `上级分区「${name}」`,
      entry: { name, v2: parentId, level: 'parent' },
    })
  }
  if (cardData.tagRecTid !== undefined) {
    const name = Object.entries(PARTITION_NAME_TO_PARENT).find(([, ids]) => ids.v1 === cardData.tagRecTid)?.[0]
    partitionEntries.push({
      key: 'v1',
      label: name ? `旧版分区「${name}」` : `旧版分区 #${cardData.tagRecTid}`,
      entry: { name: name || `旧版分区 #${cardData.tagRecTid}`, v1: cardData.tagRecTid },
    })
  }
  // 分区条目 6 动作 (R8): 本组/全局/临时 × 屏蔽/仅看; 本组档禁用于未归属 (无认领组且无草稿兜底);
  //   临时档在推荐两页展示，各自写本次过滤。
  const partitionScopeItems = (entry: TagRecPartitionEntry, parentKey: string): AntMenuItem[] =>
    filterMenuSections(
      parentKey,
      [
        ...(canUseTemp
          ? [
              {
                key: `${parentKey}:block:temp`,
                label: actionLabel('block', '这个分区', 'temp'),
                onClick: () => onTempPartition(entry, 'block'),
              },
            ]
          : []),
        {
          key: `${parentKey}:block:group`,
          label: actionLabel('block', '这个分区', 'group'),
          disabled: !ownerGroupCount,
          onClick: () => onBlockPartition(entry, 'group'),
        },
        {
          key: `${parentKey}:block:global`,
          label: actionLabel('block', '这个分区', 'global'),
          onClick: () => onBlockPartition(entry, 'global'),
        },
      ],
      [
        ...(canUseTemp
          ? [
              {
                key: `${parentKey}:allow:temp`,
                label: actionLabel('allow', '这个分区', 'temp'),
                onClick: () => onTempPartition(entry, 'allow'),
              },
            ]
          : []),
        {
          key: `${parentKey}:allow:group`,
          label: actionLabel('allow', '这个分区', 'group'),
          disabled: !ownerGroupCount,
          onClick: () => onAllowPartition(entry, 'group'),
        },
        {
          key: `${parentKey}:allow:global`,
          label: actionLabel('allow', '这个分区', 'global'),
          onClick: () => onAllowPartition(entry, 'global'),
        },
      ],
    )

  // 对象入口说明可做的事；子菜单按屏蔽/仅看分组，临时操作优先展示。
  const tagRecMenus: AntMenuItem[] = enabled
    ? [
        {
          key: 'tag-rec:tag-popover',
          label: (
            <TagRecFilterMenuLabel
              title='标签管理'
              description={tagRecItem ? '查看视频标签并取条件' : '查看、收藏或屏蔽标签'}
            />
          ),
          icon: <IconForTagManage className='size-16px' />,
          onClick: () => {
            // tab2 弹层锚点不在树上 (取词/理由顶替) —— 标签管理改道工作台侧的取条件抽屉
            if (tagRecItem) openTagRecVideoMaterials(tagRecItem, tagRecWorkbench.activeId)
            else openTagPopover()
          },
        },
        ...(tab === ETab.TagRecCustom && tagRecCustomSession.workingGroup
          ? [
              {
                key: 'tag-rec:workbench',
                label: '选入 / 排除组合条件',
                children: [
                  ...(authorName || authorMid
                    ? [
                        {
                          key: 'workbench:up',
                          label: `UP 主 · ${authorName || authorMid}`,
                          children: [
                            {
                              key: 'workbench:up:add',
                              label: '选入组合',
                              onClick: () =>
                                addTagRecWorkingCondition(
                                  tagRecConditionAtom('up', {
                                    name: authorName || `UID ${authorMid}`,
                                    mid: authorMid ? Number(authorMid) : undefined,
                                  }),
                                ),
                            },
                            {
                              key: 'workbench:up:block',
                              label: '这个组合不看',
                              onClick: () =>
                                excludeTagRecWorkingCondition(
                                  tagRecConditionAtom('up', {
                                    name: authorName || `UID ${authorMid}`,
                                    mid: authorMid ? Number(authorMid) : undefined,
                                  }),
                                ),
                            },
                            {
                              key: 'workbench:up:global',
                              label: '以后都不看',
                              onClick: () =>
                                blockTagRecConditionGlobally(
                                  tagRecConditionAtom('up', {
                                    name: authorName || `UID ${authorMid}`,
                                    mid: authorMid ? Number(authorMid) : undefined,
                                  }),
                                ),
                            },
                          ],
                        },
                      ]
                    : []),
                  ...(['title', 'desc'] as const).flatMap((field) =>
                    splitTitleToSegments(field === 'title' ? title : (descText ?? ''))
                      .filter((word) => word.trim().length >= 2 && word.length <= 200)
                      .slice(0, 8)
                      .map((word, i) => ({
                        key: `workbench:${field}:${i}`,
                        label: `${field === 'title' ? '标题' : '简介'} · ${word}`,
                        children: [
                          {
                            key: `workbench:${field}:${i}:add`,
                            label: '选入组合',
                            onClick: () => addTagRecWorkingCondition(tagRecConditionAtom(field, word)),
                          },
                          {
                            key: `workbench:${field}:${i}:block`,
                            label: '这个组合不看',
                            onClick: () => excludeTagRecWorkingCondition(tagRecConditionAtom(field, word)),
                          },
                          {
                            key: `workbench:${field}:${i}:global`,
                            label: '以后都不看',
                            onClick: () => blockTagRecConditionGlobally(tagRecConditionAtom(field, word)),
                          },
                        ],
                      })),
                  ),
                  ...partitionEntries.map((part) => ({
                    key: `workbench:part:${part.key}`,
                    label: `分区 · ${part.label}`,
                    children: [
                      {
                        key: `workbench:part:${part.key}:add`,
                        label: '选入组合',
                        onClick: () => addTagRecWorkingCondition(tagRecConditionAtom('partition', part.entry)),
                      },
                      {
                        key: `workbench:part:${part.key}:block`,
                        label: '这个组合不看',
                        onClick: () => excludeTagRecWorkingCondition(tagRecConditionAtom('partition', part.entry)),
                      },
                    ],
                  })),
                ],
              } satisfies AntMenuItem,
            ]
          : []),
        ...(authorName || authorMid
          ? [
              {
                key: 'tag-rec:up',
                label: <TagRecFilterMenuLabel title='筛选这个 UP 主' description={authorName || `UP ${authorMid}`} />,
                icon: <IconForFilterAuthor className='size-16px' />,
                children: filterMenuSections(
                  'tag-rec:up',
                  [
                    ...(canUseTemp
                      ? [
                          {
                            key: 'tag-rec:up:block:temp',
                            label: actionLabel('block', '这个 UP 主', 'temp'),
                            onClick: onBlockUpTemp,
                          },
                        ]
                      : []),
                    {
                      key: 'tag-rec:up:block:group',
                      label: actionLabel('block', '这个 UP 主', 'group'),
                      disabled: !ownerGroupCount,
                      onClick: onBlockUpGroup,
                    },
                    {
                      key: 'tag-rec:up:block:global',
                      label: actionLabel('block', '这个 UP 主', 'global', true),
                      onClick: onBlockUpGlobal,
                    },
                  ],
                  [
                    ...(canUseTemp
                      ? [
                          {
                            key: 'tag-rec:up:allow:temp',
                            label: actionLabel('allow', '这个 UP 主', 'temp'),
                            onClick: onAllowUpTemp,
                          },
                        ]
                      : []),
                    {
                      key: 'tag-rec:up:allow:group',
                      label: actionLabel('allow', '这个 UP 主', 'group'),
                      disabled: !ownerGroupCount,
                      onClick: onAllowUpGroup,
                    },
                  ],
                ),
              } satisfies AntMenuItem,
            ]
          : []),
        {
          key: 'tag-rec:title',
          label: <TagRecFilterMenuLabel title='按标题筛选' description='按关键词屏蔽 / 仅看视频' />,
          icon: <IconForFilterTitle className='size-16px' />,
          children: filterMenuSections(
            'tag-rec:title',
            [
              ...(canUseTemp
                ? [
                    {
                      key: 'tag-rec:title:block:temp',
                      label: actionLabel('block', '标题含词的视频…', 'temp'),
                      onClick: () => openKwModal('block', 'temp', 'title'),
                    },
                  ]
                : []),
              {
                key: 'tag-rec:title:block:group',
                label: actionLabel('block', '标题含词的视频…', 'group'),
                disabled: !ownerGroupCount,
                onClick: () => openKwModal('block', 'group', 'title'),
              },
              {
                key: 'tag-rec:title:block:global',
                label: actionLabel('block', '标题含词的视频…', 'global', true),
                onClick: () => openKwModal('block', 'global', 'title'),
              },
            ],
            [
              ...(canUseTemp
                ? [
                    {
                      key: 'tag-rec:title:allow:temp',
                      label: actionLabel('allow', '标题含词的视频…', 'temp'),
                      onClick: () => openKwModal('allow', 'temp', 'title'),
                    },
                  ]
                : []),
              {
                key: 'tag-rec:title:allow:group',
                label: actionLabel('allow', '标题含词的视频…', 'group'),
                disabled: !ownerGroupCount,
                onClick: () => openKwModal('allow', 'group', 'title'),
              },
            ],
          ),
        },
        {
          key: 'tag-rec:desc',
          label: (
            <TagRecFilterMenuLabel
              title='按简介筛选'
              description={descText ? '按简介关键词屏蔽 / 仅看' : '此视频暂无简介，无法筛选'}
              disabled={!descText}
            />
          ),
          icon: <IconForFilterDescription className='size-16px' />,
          disabled: !descText,
          children: filterMenuSections(
            'tag-rec:desc',
            [
              ...(canUseTemp
                ? [
                    {
                      key: 'tag-rec:desc:block:temp',
                      label: actionLabel('block', '简介含词的视频…', 'temp'),
                      disabled: !descText,
                      onClick: () => openKwModal('block', 'temp', 'desc'),
                    },
                  ]
                : []),
              {
                key: 'tag-rec:desc:block:group',
                label: actionLabel('block', '简介含词的视频…', 'group'),
                disabled: !ownerGroupCount || !descText,
                onClick: () => openKwModal('block', 'group', 'desc'),
              },
              {
                key: 'tag-rec:desc:block:global',
                label: actionLabel('block', '简介含词的视频…', 'global'),
                disabled: !descText,
                onClick: () => openKwModal('block', 'global', 'desc'),
              },
            ],
            [
              ...(canUseTemp
                ? [
                    {
                      key: 'tag-rec:desc:allow:temp',
                      label: actionLabel('allow', '简介含词的视频…', 'temp'),
                      disabled: !descText,
                      onClick: () => openKwModal('allow', 'temp', 'desc'),
                    },
                  ]
                : []),
              {
                key: 'tag-rec:desc:allow:group',
                label: actionLabel('allow', '简介含词的视频…', 'group'),
                disabled: !ownerGroupCount || !descText,
                onClick: () => openKwModal('allow', 'group', 'desc'),
              },
            ],
          ),
        },
        ...(partitionEntries.length
          ? [
              {
                key: 'tag-rec:partition',
                label: (
                  <TagRecFilterMenuLabel
                    title='按分区筛选'
                    description={cardData.tagRecTnamev2 || cardData.tagRecPidNameV2 || partitionEntries[0].label}
                  />
                ),
                icon: <IconForFilterPartition className='size-16px' />,
                children: partitionEntries.map(
                  (p) =>
                    ({
                      key: `tag-rec:partition:${p.key}`,
                      label: p.label,
                      children: partitionScopeItems(p.entry, `tag-rec:partition:${p.key}`),
                    }) satisfies AntMenuItem,
                ),
              } satisfies AntMenuItem,
            ]
          : []),
      ]
    : []

  return { tagManageActionButtonEl, tagManageModalEl, tagRecMenus, openTagPopover }
}
