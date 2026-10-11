import { Button, Typography } from 'antd'
import {
  hasTagRecCombination,
  TAG_REC_CONDITION_FIELDS,
  tagRecConditionLabel,
  type TagRecCombination,
  type TagRecConditionAtom,
  type TagRecConditionGroup,
} from '../model/combination'
import { TAG_REC_DROP_DIM_LABELS } from './banner-helpers'
import { TAG_REC_POOL_KEYS, TAG_REC_POOL_LABELS } from './pool-labels'
import { pickTagRecScopePatch, tagRecPoolSlotSummary } from './scope-config-editor'
import type { ReactNode } from 'react'
import type { TagGroup, TagIdEntry, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] 只读条件树渲染 (wayfinding 001/005) —— 组现状面板与分享预览共用同一渲染件。
 * - 默认纯展示; 传入 edit 回调后出现基础编辑 (删原子/删排除/切 all↔any/加条件落点)
 * - combination.filters 单列「组合自带过滤」块 —— 不再混进会话层显示
 * - 无组合的组回落 tag_ids 扁平 chips (收藏展开区/旧分享包同口径)
 */
export type TagRecConditionTreeEdit = {
  /** 移除 include 树上的原子或子组节点 (removeTagRecCondition 口径: 删空的组被剪) */
  onRemoveNode?: (id: string) => void
  /** 移除 exclude 里的原子 */
  onRemoveExclude?: (id: string) => void
  /** 切换子组命中方式 */
  onSetMode?: (id: string, mode: 'all' | 'any') => void
  /** 「＋加条件/＋排除」落点渲染器 —— 调用方给挑选控件 (CandidateResolvePicker 等) */
  renderAdder?: (target: { kind: 'group'; id: string } | { kind: 'exclude' }) => ReactNode
}

const FIELD_TONE: Record<string, { fg: string; bg: string }> = {
  tag: { fg: '#0958d9', bg: '#e6f4ff' },
  up: { fg: '#531dab', bg: '#f9f0ff' },
  title: { fg: '#c41d7f', bg: '#fff0f6' },
  desc: { fg: '#d46b08', bg: '#fff7e6' },
  partition: { fg: '#389e0d', bg: '#f6ffed' },
}

function AtomChip({ atom, danger, onRemove }: { atom: TagRecConditionAtom; danger?: boolean; onRemove?: () => void }) {
  const tone = FIELD_TONE[atom.field]
  return (
    <span
      className='inline-flex items-center gap-2px rounded-4px px-6px py-0 text-12px'
      style={{
        background: danger ? '#fff1f0' : tone?.bg,
        color: danger ? '#cf1322' : tone?.fg,
        border: `1px solid ${danger ? '#ffa39e' : 'transparent'}`,
      }}
      title={`${TAG_REC_CONDITION_FIELDS[atom.field]} · ${tagRecConditionLabel(atom)}`}
    >
      <span className='text-11px opacity-60'>{TAG_REC_CONDITION_FIELDS[atom.field]}</span>
      {tagRecConditionLabel(atom)}
      {onRemove && (
        <Button
          size='small'
          type='text'
          aria-label={`移除${tagRecConditionLabel(atom)}`}
          className='h-auto min-w-16px px-0 text-12px leading-none opacity-60'
          onClick={onRemove}
        >
          ×
        </Button>
      )}
    </span>
  )
}

function ModeBadge({
  node,
  root,
  onSetMode,
}: {
  node: TagRecConditionGroup
  root?: boolean
  onSetMode?: TagRecConditionTreeEdit['onSetMode']
}) {
  const label = node.mode === 'all' ? '全部命中' : '任一命中'
  const inner = (
    <span
      className='inline-flex items-center rounded-4px px-6px text-11px font-600'
      style={{
        height: 20,
        color: node.mode === 'all' ? '#0958d9' : '#d48806',
        background: node.mode === 'all' ? '#e6f4ff' : '#fff7e6',
        cursor: onSetMode ? 'pointer' : undefined,
      }}
      title={onSetMode ? `点击切换为${node.mode === 'all' ? '任一' : '全部'}命中` : label}
      onClick={onSetMode ? () => onSetMode(node.id, node.mode === 'all' ? 'any' : 'all') : undefined}
    >
      {root ? `组合方式 · ${label}` : label}
    </span>
  )
  return inner
}

function GroupNode({
  node,
  root,
  edit,
}: {
  node: TagRecConditionGroup
  root?: boolean
  edit?: TagRecConditionTreeEdit
}) {
  const atoms = node.children.filter((c): c is TagRecConditionAtom => c.kind === 'atom')
  const groups = node.children.filter((c): c is TagRecConditionGroup => c.kind === 'group')
  // 只读态空子组不渲染 (它本是编辑落点壳); 可编辑态保留以显示「＋」
  if (!root && !edit && !node.children.length) return null
  return (
    <div className='mt-6px' style={{ paddingLeft: root ? 0 : 10, borderLeft: root ? undefined : '2px solid #f0f0f0' }}>
      <div className='flex flex-wrap items-center gap-x-6px gap-y-4px'>
        <ModeBadge node={node} root={root} onSetMode={edit?.onSetMode} />
        {!root && !!node.name && TAG_REC_CONDITION_FIELDS[node.name as never] === undefined && (
          <Typography.Text type='secondary' className='text-11px'>
            {node.name}
          </Typography.Text>
        )}
        {atoms.map((a) => (
          <AtomChip key={a.id} atom={a} onRemove={edit?.onRemoveNode ? () => edit.onRemoveNode!(a.id) : undefined} />
        ))}
        {edit?.renderAdder?.({ kind: 'group', id: node.id })}
        {edit?.onRemoveNode && !root && (
          <Button
            size='small'
            type='text'
            className='h-auto px-4px text-11px opacity-60'
            onClick={() => edit.onRemoveNode!(node.id)}
          >
            移出整组
          </Button>
        )}
      </div>
      {groups.map((child) => (
        <GroupNode key={child.id} node={child} edit={edit} />
      ))}
    </div>
  )
}

/** combination.filters 声明摘要 (只读) —— 逐键列出, 与「本组声明」列同口径 */
function FiltersBlock({ filters }: { filters: NonNullable<TagRecCombination['filters']> }) {
  const chips: string[] = Array.from(
    Object.keys(filters.dims ?? {}),
    (k) => `维·${TAG_REC_DROP_DIM_LABELS[k as keyof typeof TAG_REC_DROP_DIM_LABELS] ?? k}`,
  )
  if (filters.score) chips.push('算分')
  if (filters.smallPoolThreshold !== undefined) chips.push(`小池阈值 ${filters.smallPoolThreshold}`)
  for (const [p, v] of Object.entries(filters.poolsEnabled ?? {}))
    chips.push(`${TAG_REC_POOL_LABELS[p as TagRecPoolKey] ?? p}·${v ? '开' : '关'}`)
  if (filters.pools)
    for (const p of Object.keys(filters.pools)) chips.push(`格·${TAG_REC_POOL_LABELS[p as TagRecPoolKey] ?? p}`)
  if (filters.enabled !== undefined) chips.push(`过滤总开关·${filters.enabled ? '开' : '关'}`)
  if (filters.strictMode !== undefined) chips.push(`严格模式·${filters.strictMode ? '开' : '关'}`)
  if (!chips.length) return null
  return (
    <div className='mt-8px'>
      <span
        className='inline-flex items-center rounded-4px px-6px text-11px font-600'
        style={{ height: 20, color: '#531dab', background: '#f9f0ff' }}
      >
        组合自带过滤
      </span>
      <div className='mt-4px flex flex-wrap gap-4px' style={{ paddingLeft: 10, borderLeft: '2px solid #f9f0ff' }}>
        {chips.map((c) => (
          <span key={c} className='rounded-4px bg-#f9f0ff px-6px text-12px' style={{ color: '#531dab' }}>
            {c}
          </span>
        ))}
      </div>
    </div>
  )
}

export function TagRecConditionTreeView({
  combination,
  tagIds,
  edit,
}: {
  combination?: TagRecCombination
  /** 无组合时的扁平回落 (旧组/预览) */
  tagIds?: readonly TagIdEntry[]
  edit?: TagRecConditionTreeEdit
}) {
  if (!combination)
    return (
      <div>
        {tagIds?.length ? (
          <div className='flex flex-wrap items-center gap-4px'>
            {tagIds.map((t) => (
              <span
                key={t.id}
                className='rounded-4px px-6px text-12px'
                style={{ background: '#e6f4ff', color: '#0958d9' }}
              >
                {t.name || `#${t.id}`}
              </span>
            ))}
            {edit?.renderAdder?.({ kind: 'group', id: '' })}
            {edit?.renderAdder?.({ kind: 'exclude' })}
          </div>
        ) : (
          <div className='flex items-center gap-6px'>
            <Typography.Text type='secondary' className='text-12px'>
              (无条件)
            </Typography.Text>
            {edit?.renderAdder?.({ kind: 'group', id: '' })}
            {edit?.renderAdder?.({ kind: 'exclude' })}
          </div>
        )}
        {edit?.renderAdder && (
          <Typography.Text type='secondary' className='mt-2px block text-11px'>
            加入首个条件会把本组转为组合组（既有标签自动并入 tag 行）
          </Typography.Text>
        )}
      </div>
    )
  const include = combination.include
  const empty = !include.children.length && !combination.exclude.length && !combination.filters
  if (empty)
    return (
      <Typography.Text type='secondary' className='text-12px'>
        (空组合)
      </Typography.Text>
    )
  return (
    <div>
      <GroupNode node={include} root edit={edit} />
      {!!combination.exclude.length && (
        <div className='mt-8px'>
          <span
            className='inline-flex items-center rounded-4px px-6px text-11px font-600'
            style={{ height: 20, color: '#cf1322', background: '#fff1f0' }}
          >
            排除
          </span>
          <div
            className='mt-4px flex flex-wrap items-center gap-4px'
            style={{ paddingLeft: 10, borderLeft: '2px solid #fff1f0' }}
          >
            {combination.exclude.map((a) => (
              <AtomChip
                key={a.id}
                atom={a}
                danger
                onRemove={edit?.onRemoveExclude ? () => edit.onRemoveExclude!(a.id) : undefined}
              />
            ))}
            {edit?.renderAdder?.({ kind: 'exclude' })}
          </div>
        </div>
      )}
      {edit?.renderAdder && !combination.exclude.length && (
        <div className='mt-6px'>{edit.renderAdder({ kind: 'exclude' })}</div>
      )}
      {combination.filters && <FiltersBlock filters={combination.filters} />}
    </div>
  )
}

/**
 * 集市预览「包内声明」展开块 (wayfinding 005): 口径 = 这组随包带了什么 (非导入后生效值)。
 * 条件树复用同渲染件只读态 + 声明摘要行 (overrides/格槽/池筛选/负向); 展开与否由调用方控。
 */
export function TagRecShareGroupContents({ group }: { group: TagGroup }) {
  const o = group.overrides
  const summary: string[] = []
  const slot = pickTagRecScopePatch(o)
  if (slot) summary.push(`覆盖: ${tagRecPoolSlotSummary(slot)}`)
  for (const p of TAG_REC_POOL_KEYS) {
    const cell = o?.pools?.[p]
    if (cell) summary.push(`格·${TAG_REC_POOL_LABELS[p]}: ${tagRecPoolSlotSummary(cell)}`)
  }
  const poolsOff = TAG_REC_POOL_KEYS.filter((p) => o?.poolsEnabled?.[p] === false)
  const poolsOn = TAG_REC_POOL_KEYS.filter((p) => o?.poolsEnabled?.[p] === true)
  if (poolsOff.length) summary.push(`关池: ${poolsOff.map((p) => TAG_REC_POOL_LABELS[p]).join('·')}`)
  if (poolsOn.length) summary.push(`开池: ${poolsOn.map((p) => TAG_REC_POOL_LABELS[p]).join('·')}`)
  const negBits: string[] = []
  if (group.negative_tag_ids?.length) negBits.push(`${group.negative_tag_ids.length} 标签`)
  const neg = o?.negative
  if (neg) {
    if (neg.title?.length) negBits.push(`${neg.title.length} 标题词`)
    if (neg.up?.length) negBits.push(`${neg.up.length} UP`)
    if (neg.partitionBlock?.length) negBits.push(`${neg.partitionBlock.length} 分区`)
    if (neg.strict) negBits.push('严格负向')
  }
  if (negBits.length) summary.push(`负向: ${negBits.join('·')}`)
  return (
    <div className='ml-18px mt-4px border-l-2px border-#f0f0f0 border-solid pl-10px'>
      <TagRecConditionTreeView
        combination={hasTagRecCombination(group.combination) ? group.combination : undefined}
        tagIds={group.tag_ids}
      />
      {!!summary.length && (
        <div className='mt-6px flex flex-wrap gap-x-10px gap-y-2px text-11px opacity-75'>
          {summary.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      )}
    </div>
  )
}
