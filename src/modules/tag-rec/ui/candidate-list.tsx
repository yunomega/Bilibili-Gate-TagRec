import { Button, Checkbox, Table, Tag, Typography } from 'antd'
import { useEffect, useState, type ReactNode } from 'react'
import { useSnapshot } from 'valtio'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import { antModal } from '$modules/antd'
import { AntdTooltip } from '$modules/antd/custom'
import toast from '$utility/toast'
import { getPersistedTagInfoById } from '../api/tag-info-store'
import {
  findGroupByTagId,
  findGroupsByNegativeTagId,
  findGroupsByTagId,
  groupNegativeTagIds,
  pickTagGroupsByIds,
} from '../model/favorites'
import { CandidateBadgeLabel, type CandidateRow } from '../model/resolve'
import { summarizeSessionFilterDiff } from '../model/session-filter-merge'
import { commitTagRecSessionFilterMerge, planTagRecSessionFilterMerge } from '../service/temp-writes'
import { favorites, favoritesStore } from '../store'
import { removeExpandedId, tagRecCustomSession } from '../store/session'
import { tagRecSaveCountParts } from './candidate-list-helpers'
import type { ColumnsType } from 'antd/es/table'
import type { TagGroup } from '../model/types'
import type { TagRecCustomService } from '../service/tag-rec-custom'

/**
 * [tag-rec] 候选清单 (spec §4.2)
 * 行: {tag_name, tag_id, use(读 count.use), 共现频次?, 来源徽章, checkbox}
 * 排序: 精确 > 共现 > 联想，同类按共现频次再按使用量; 别名/联想行惰性入清单
 *   (无 use/tag_id 显示「待解析」，仍按已知共现排序; 「解析失败」可再勾重试)
 * 徽章: 精确(锚点+归一化变体,默认勾) / 共现(别名,不勾) / 联想(不勾)
 * 已在组内的行不进清单 (选定组正/负向 + 草稿组负向, 按 tag_id 判); 组内成员 chip 区默认收起,
 *   展开开关在「存成项/并入当前组」右侧
 * 两语义复用:
 * - query (tab2): `TagRecCandidateList` —— 「扩进本次查询」并入查询单元 /「顺手存成项」存为新组
 * - panel (面板): `TagRecCandidatePickList` —— 成组勾选器, 多选勾进目标 (组/黑名单),
 *   确认动作由调用侧给 (「标签收藏」pane 用, 票 04)
 */

const badgeColor: Record<CandidateRow['badge'], string | undefined> = {
  exact: 'green',
  cooccur: 'geekblue',
  suggest: undefined, // 默认灰
}

/** 票 12 预检标记: id 已在收藏表 => 极性徽标 (正向宿主灰「已在「X」」/ 负向宿主橙「已在「X」负向」; 多宿主 tooltip 列全) */
function HostGroupBadges({ list, tagId }: { list: readonly TagGroup[]; tagId: number }) {
  const pos = findGroupsByTagId(list, tagId)
  const neg = findGroupsByNegativeTagId(list, tagId)
  const badge = (hosts: readonly TagGroup[], suffix: string, color?: string) => {
    if (!hosts.length) return null
    const tag = (
      <Tag color={color} className='mr-4px'>
        已在「{hosts[0].name}」{suffix}
        {hosts.length > 1 ? `等${hosts.length}组` : ''}
      </Tag>
    )
    return hosts.length > 1 ? <AntdTooltip title={hosts.map((g) => g.name).join('、')}>{tag}</AntdTooltip> : tag
  }
  return (
    <>
      {badge(pos, '')}
      {badge(neg, '负向', 'orange')}
    </>
  )
}

/** 行表本体: 两语义共享; 勾选态回写经 onToggleRow 由调用侧管 (session / 本地 state) */
export function TagRecCandidateRowsTable({
  rows,
  onToggleRow,
  emptyText = '暂无候选',
  expandedLabel = '已并入',
}: {
  rows: readonly CandidateRow[]
  onToggleRow: (key: string, checked: boolean) => void
  emptyText?: ReactNode
  expandedLabel?: string
}) {
  const favList = useSnapshot(favoritesStore).list as TagGroup[]
  const columns: ColumnsType<CandidateRow> = [
    {
      key: 'check',
      width: 32,
      // 票 18: 未解析行可勾 (动作点现解); 已并入行禁勾 (并入是单向的)
      render: (_, row) => (
        <Checkbox
          checked={row.checked}
          disabled={row.expanded}
          onChange={(e) => onToggleRow(row.key, e.target.checked)}
        />
      ),
    },
    {
      key: 'name',
      title: '标签',
      render: (_, row) => (
        <span>
          {row.tag_name}
          {row.tag_id !== undefined && (
            <Typography.Text type='secondary' className='ml-6px text-12px'>
              #{row.tag_id}
            </Typography.Text>
          )}
        </span>
      ),
    },
    {
      key: 'use',
      title: 'use',
      width: 70,
      align: 'right',
      render: (_, row) => (row.use === undefined ? '-' : row.use.toLocaleString()),
    },
    {
      key: 'cooccur',
      title: '共现',
      width: 56,
      align: 'right',
      render: (_, row) => row.cooccur ?? '-',
    },
    {
      key: 'badge',
      title: '来源',
      width: 160,
      render: (_, row) => (
        <>
          <Tag color={badgeColor[row.badge]} className='mr-4px'>
            {CandidateBadgeLabel[row.badge]}
          </Tag>
          {row.expanded && <Tag color='purple'>{expandedLabel}</Tag>}
          {row.resolving && <Tag color='blue'>解析中…</Tag>}
          {!row.resolving &&
            row.tag_id === undefined &&
            (row.resolveFailed ? <Tag color='red'>解析失败</Tag> : <Tag>待解析</Tag>)}
          {row.tag_id !== undefined && <HostGroupBadges list={favList} tagId={row.tag_id} />}
        </>
      ),
    },
  ]

  return (
    <Table<CandidateRow>
      size='small'
      rowKey='key'
      columns={columns}
      dataSource={rows as CandidateRow[]}
      pagination={false}
      scroll={{ y: 220 }}
      locale={{ emptyText }}
    />
  )
}

/**
 * 票 22 扩选暂存位可视区 = 候选清单顶部「已扩选 N」chip 区:
 * ★「加入当前组」与下拉「扩进本次查询」同位展示; 每条 chip ✕ 即从 expandedIds 删 (下一轮生效),
 * 对应候选行 expanded flag 同步清回 (removeExpandedId 收口); 只删暂存位, 不动已入表组内容
 */
function TagRecExpandedSection() {
  const expanded = useSnapshot(tagRecCustomSession).expandedIds
  if (!expanded.length) return null
  return (
    <div className='mb-6px flex flex-wrap items-center gap-x-6px gap-y-4px'>
      <Typography.Text type='secondary' className='text-12px'>
        已扩选 {expanded.length} (下一轮生效):
      </Typography.Text>
      {expanded.map((e) => (
        <AntdTooltip key={e.id} title={`#${e.id} · ✕ 取消扩选`}>
          <Tag
            color='purple'
            closable
            className='mr-0'
            onClose={(ev) => {
              ev.preventDefault() // 移除由 session 驱动, 不走 Tag 内部隐藏态
              removeExpandedId(e.id)
            }}
          >
            {e.name}
          </Tag>
        </AntdTooltip>
      ))}
    </div>
  )
}

/**
 * 票 28 组内成员区 (选定组语境): 候选清单顶部列出当前组的正向 tag_ids chip, ✕ 即移出组
 * (facade 直写, 即时生效)。防重复规则: 按 id 去重; 与「已扩选」区互斥 (∈expandedIds 的成员
 * 不在此列 —— 暂存态归扩选区管); 负向成员不列 (管理归面板/弹层)。名字 = entry.name 快照,
 * 缺名惰性查 tag-info 双向键缓存兜底, 再缺显 `#id` (不发请求)。
 */
function TagRecGroupMembersSection({ group }: { group: TagGroup }) {
  const expandedIds = useSnapshot(tagRecCustomSession).expandedIds
  const members = group.tag_ids.filter((e) => !expandedIds.some((x) => x.id === e.id))
  const [namePatch, setNamePatch] = useState<Record<number, string>>({})
  useEffect(() => {
    setNamePatch({})
    const missing = group.tag_ids.filter((e) => !e.name)
    if (!missing.length) return
    let dead = false
    void Promise.all(missing.map((e) => getPersistedTagInfoById(e.id))).then((infos) => {
      if (dead) return
      const m: Record<number, string> = {}
      infos.forEach((info, i) => {
        if (info?.name) m[missing[i].id] = info.name
      })
      if (Object.keys(m).length) setNamePatch(m)
    })
    return () => {
      dead = true
    }
  }, [group])
  if (!members.length) return null
  return (
    <div className='mb-6px flex flex-wrap items-center gap-x-6px gap-y-4px'>
      <Typography.Text type='secondary' className='text-12px'>
        组内成员 {members.length}:
      </Typography.Text>
      {members.map((e) => (
        <AntdTooltip key={e.id} title={`#${e.id} · ✕ 移出本组`}>
          <Tag
            closable
            className='mr-0'
            onClose={(ev) => {
              ev.preventDefault()
              favorites.removeTagIdFromGroup(group.id, e.id)
            }}
          >
            {e.name || namePatch[e.id] || `#${e.id}`}
          </Tag>
        </AntdTooltip>
      ))}
    </div>
  )
}

/** query 语义 (tab2): 绑 tagRecCustomSession; 动作 = 扩进本次查询 / 顺手存成项·并入当前组 / 继续深挖 */
/**
 * 「存成项后顺手并入临时过滤」(grilling 共识 Q1-Q4):
 *   新建成组成功后问一次 —— 会话临时过滤 vs 全局的差集写进组 overrides;
 *   「并入已有组」路径不出 (不污染已策展组); 会话覆盖不动 (换锚点照常清除);
 *   全局「标签过滤」不受影响; 无差集则不打扰。
 */
async function offerSessionFilterMergeIntoGroup(group: TagGroup) {
  const diff = planTagRecSessionFilterMerge()
  if (!diff) return
  const ok = await antModal.confirm({
    centered: true,
    title: `临时过滤并入「${group.name}」?`,
    content: (
      <>
        并入差集：{summarizeSessionFilterDiff(diff)}
        <br />
        <Typography.Text type='secondary'>
          写进该组的组级配置 (稀疏差集, 组已写过的键不回头覆盖), 今后这组每次生效； 会话里的临时过滤不动,
          换锚点照常清除; 全局「标签过滤」不受影响。
        </Typography.Text>
      </>
    ),
    okText: '并入该组',
    cancelText: '不了',
  })
  if (ok && commitTagRecSessionFilterMerge(group.id)) toast(`已把临时过滤并入「${group.name}」`)
}

export function TagRecCandidateList({ service }: { service: TagRecCustomService }) {
  const { recSharedEmitter } = useRecSelfContext()
  const snap = useSnapshot(tagRecCustomSession)
  const favList = useSnapshot(favoritesStore).list as TagGroup[]
  const { status, pagesFetched, exhausted } = snap.phase2
  // 票 22 存成项语境分叉: 选定组 => 「并入当前组」勾选行+暂存层固化进该组; 零勾选但暂存非空也可并入
  const selectedGroup = pickTagGroupsByIds(favList, [...snap.selectedGroupIds])[0]
  // 实修: 草稿已存成项 => 「顺手存成项」转「并入该组」(不再建新组; 目标组删则回落建组)
  const savedGroup =
    !selectedGroup && snap.draftGroup?.savedGroupId
      ? favList.find((g) => g.id === snap.draftGroup!.savedGroupId)
      : undefined
  const mergeTarget = selectedGroup ?? savedGroup
  // 已在组内的行不进清单: 选定组正/负向成员 + 草稿组负向, 按 tag_id 判 (未解析行无 id 可判 → 保留)
  const inGroupIds = new Set<number>()
  for (const e of selectedGroup?.tag_ids ?? []) inGroupIds.add(e.id)
  for (const e of selectedGroup ? groupNegativeTagIds(selectedGroup) : []) inGroupIds.add(e.id)
  for (const e of snap.draftGroup?.negative_tag_ids ?? []) inGroupIds.add(e.id)
  const rows = (snap.candidates as readonly CandidateRow[]).filter(
    (r) => r.tag_id === undefined || !inGroupIds.has(r.tag_id),
  )
  // 票 18: 未解析行可勾 (动作点现解)
  // 两动作计数分开: 扩进只计未并入行 (并入单向不重复); 存成项计全部勾中行 (已并入行有 id 可直接存)
  const expandCount = rows.filter((r) => r.checked && !r.expanded).length
  const saveCount = rows.filter((r) => r.checked).length
  const [busy, setBusy] = useState(false)
  const runAction = async <T,>(fn: () => Promise<T>) => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }
  // 计数口径: 勾选行用未扩选行 (expanded 行的 id 已在暂存位, 重复计会虚增)
  const expandedCount = snap.expandedIds.length
  const mergeMode = !!mergeTarget
  // 实机修复: 草稿语境门禁补 expandedIds/锚点 —— 纯数字直输无候选行, 「存成项=本次查询固化」需可点
  const saveDisabled =
    busy || (mergeMode ? !expandCount && !expandedCount : !saveCount && !expandedCount && !snap.anchor)
  const mergeCountParts = [expandCount ? `${expandCount}` : '', expandedCount ? `${expandedCount} 扩选` : ''].filter(
    Boolean,
  )
  // A2 实修: 草稿语境按钮按来源分解 —— 并入集 = 已选行 ∪ 扩选暂存 ∪ 查询词(锚点独立槽位),
  //   与 saveAsFavoriteGroup 三路去重口径对齐; 锚点被前两路覆盖时不虚报名额 (口径见 helpers)
  const saveCountParts = tagRecSaveCountParts({ rows, expandedIds: snap.expandedIds, anchor: snap.anchor })

  // 组内成员 chip 区折叠开关 (「存成项/并入当前组」右侧): 默认收起, 展开态 chip 块仍在清单顶部;
  // 计数口径同 TagRecGroupMembersSection —— ∈expandedIds 的成员归扩选区不在此列
  const memberCount = selectedGroup
    ? selectedGroup.tag_ids.filter((e) => !snap.expandedIds.some((x) => x.id === e.id)).length
    : 0
  const membersToggle = memberCount > 0 && (
    // [tag-rec] UIUX-U1-5: 折叠开关是动作 => Button link (非导航不使用 Typography.Link)
    <Button
      type='link'
      size='small'
      className='h-auto px-0 text-12px'
      onClick={() => (tagRecCustomSession.membersCollapsed = !tagRecCustomSession.membersCollapsed)}
    >
      {snap.membersCollapsed ? '▸' : '▾'} 组内成员 {memberCount}
    </Button>
  )
  // 「已扩选」chip 区同款折叠开关 (组内成员开关右侧)
  const expandedToggle = expandedCount > 0 && (
    <Button
      type='link'
      size='small'
      className='h-auto px-0 text-12px'
      onClick={() => (tagRecCustomSession.expandedCollapsed = !tagRecCustomSession.expandedCollapsed)}
    >
      {snap.expandedCollapsed ? '▸' : '▾'} 已扩选 {expandedCount}
    </Button>
  )

  const toggle = (key: string, checked: boolean) => {
    const row = tagRecCustomSession.candidates.find((c) => c.key === key)
    if (row && !row.expanded) row.checked = checked
    // 打勾即后台预解析 (票 18): use/解析态随后回填, 动作点零等待
    if (checked) service.resolveCandidateInBackground(key)
  }

  const phase2Text =
    status === 'running'
      ? 'Phase 2 后台挖掘中…'
      : status === 'done'
        ? `已挖 ${pagesFetched} 页${exhausted ? ' · 已到底' : ''}`
        : status === 'error'
          ? 'Phase 2 失败, 可重试深挖'
          : ''

  const digButton = (
    <Button
      size='small'
      // [tag-rec] UIUX-U1-1: 去掉 !snap.anchor 门禁 —— service.digMore 自身用 hasDueStreams() 判,
      //   纯组语境 (无锚点) 的 due 流也应可深挖; 与 banner.tsx 同名按钮口径对齐
      disabled={status === 'running' || exhausted}
      onClick={() =>
        void service.digMore().then((yieldN) => {
          // [tag-rec] AUDIT-34: 落货才 emit 'load-more' 再武装 grid hasMore —— 否则深挖进队列的货滞留不上屏
          //   (同 tabbar 深挖入口语义; digMore resolve 值 = 本轮净增条数, 退避/无 due 流 resolve undefined)
          if (typeof yieldN === 'number' && yieldN > 0) return recSharedEmitter.emit('load-more')
        })
      }
    >
      继续深挖 +3页
    </Button>
  )
  const saveButton = (
    <AntdTooltip
      title={
        mergeMode
          ? `勾选项 + 扩选暂存并入组「${mergeTarget!.name}」 (不建新组; 未解析行确认时现场解析)`
          : '已选行 + 扩选暂存 + 查询词存为「标签收藏」表新组 (未解析行确认时现场解析)'
      }
    >
      <Button
        size='small'
        disabled={saveDisabled}
        loading={busy}
        onClick={() =>
          void runAction(async () => {
            const group = await service.saveAsFavoriteGroup(rows)
            if (group) await offerSessionFilterMergeIntoGroup(group) // 新建成组 → 顺手问并入临时过滤
          })
        }
      >
        {mergeMode
          ? `${savedGroup ? `并入「${savedGroup.name}」` : '并入当前组'}${mergeCountParts.length ? ` (${mergeCountParts.join('+')})` : ''}`
          : `顺手存成项${saveCountParts.length ? ` (${saveCountParts.join(' + ')})` : ''}`}
      </Button>
    </AntdTooltip>
  )

  // 票 10: 默认收起为单行摘要不挡视频流 (candidatesCollapsed 会话 flag, 新输入重置收起)
  // 摘要行 = 展开入口 + 「+3页」「存成项」盲安全直达; 「扩进本次查询」单向改查询单元, 留展开态
  if (snap.candidatesCollapsed) {
    const pendingCount = rows.filter((r) => r.checked && r.tag_id === undefined).length
    const failedCount = rows.filter((r) => r.resolveFailed).length
    // 票 12: 盲存前置信号 —— 勾中行里已在收藏表 (正/负向宿主) 的行数, 0 不显
    // W2-3: 「已勾/已在组」只计未扩选行 —— expanded 行已归扩选区单独计数, 全计会双报
    const hostedCount = rows.filter(
      (r) =>
        r.checked &&
        !r.expanded &&
        r.tag_id !== undefined &&
        (findGroupByTagId(favList, r.tag_id) !== undefined || findGroupsByNegativeTagId(favList, r.tag_id).length > 0),
    ).length
    const checkedUnexpanded = rows.filter((r) => r.checked && !r.expanded).length
    const summary = rows.length
      ? `候选 ${rows.length} 条 · 已勾 ${checkedUnexpanded}${pendingCount ? ` (含未解析 ${pendingCount})` : ''}`
      : ''
    return (
      <div className='mt-6px'>
        {selectedGroup && !snap.membersCollapsed && <TagRecGroupMembersSection group={selectedGroup} />}
        {!snap.expandedCollapsed && <TagRecExpandedSection />}
        {/* [tag-rec] UIUX-U2-9: 动作序与展开页脚对齐 [扩进/存成项/成员/扩选/深挖/收起] —
            折叠态无「扩进/收起」位, 余者同序: 存成项 → 成员开关 → 扩选开关 → 深挖 (▸摘要 = 展开入口居首) */}
        <div className='flex items-center gap-x-8px'>
          {!!(summary || phase2Text) && (
            <Button
              type='link'
              size='small'
              className='h-auto px-0 text-12px'
              onClick={() => (tagRecCustomSession.candidatesCollapsed = false)}
            >
              ▸ {summary}
              {summary && phase2Text ? ' · ' : ''}
              {phase2Text}
              {failedCount ? ` · 失败 ${failedCount}` : ''}
              {hostedCount ? ` · 已在组 ${hostedCount}` : ''}
            </Button>
          )}
          {saveButton}
          {membersToggle}
          {expandedToggle}
          {digButton}
        </div>
      </div>
    )
  }

  return (
    <div className='mt-6px'>
      {selectedGroup && !snap.membersCollapsed && <TagRecGroupMembersSection group={selectedGroup} />}
      {!snap.expandedCollapsed && <TagRecExpandedSection />}
      <TagRecCandidateRowsTable
        rows={rows}
        onToggleRow={toggle}
        emptyText={status === 'running' ? 'Phase 2 后台挖掘中…' : '暂无候选'}
      />
      <div className='mt-6px flex items-center gap-x-8px'>
        <Button
          size='small'
          type='primary'
          disabled={!expandCount || busy}
          loading={busy}
          onClick={() => void runAction(() => service.expandQuery(rows))}
        >
          扩进本次查询{expandCount ? ` (${expandCount})` : ''}
        </Button>
        {saveButton}
        {membersToggle}
        {expandedToggle}
        {digButton}
        <Typography.Text type='secondary' className='text-12px'>
          {phase2Text}
        </Typography.Text>
        <Button
          size='small'
          type='link'
          className='px-0'
          onClick={() => (tagRecCustomSession.candidatesCollapsed = true)}
        >
          收起
        </Button>
      </div>
    </div>
  )
}

/**
 * panel 语义 (面板成组勾选器): 行由调用侧持有 (受控), 确认动作 = 勾选项 => onConfirm
 * 「添加变体」(加入本组) / 「新建标签组」(存为一项) / 黑名单「添加」(入黑名单) 共用
 */
export function TagRecCandidatePickList({
  rows,
  onToggleRow,
  confirmLabel,
  onConfirm,
  statusText,
  busy = false,
  expandedLabel,
}: {
  rows: readonly CandidateRow[]
  onToggleRow: (key: string, checked: boolean) => void
  confirmLabel: string
  onConfirm: (checkedRows: readonly CandidateRow[]) => void
  statusText?: ReactNode
  busy?: boolean
  expandedLabel?: string
}) {
  // 票 18: 未解析行可勾, 确认时现解 (调用侧 resolveCandidateRows)
  const checked = rows.filter((r) => r.checked && !r.expanded)
  return (
    <div className='mt-6px'>
      <TagRecCandidateRowsTable rows={rows} onToggleRow={onToggleRow} expandedLabel={expandedLabel} />
      <div className='mt-6px flex items-center gap-x-8px'>
        <Button size='small' type='primary' disabled={!checked.length || busy} onClick={() => onConfirm(checked)}>
          {confirmLabel}
          {checked.length ? ` (${checked.length})` : ''}
        </Button>
        {statusText && (
          <Typography.Text type='secondary' className='text-12px'>
            {statusText}
          </Typography.Text>
        )}
      </div>
    </div>
  )
}
