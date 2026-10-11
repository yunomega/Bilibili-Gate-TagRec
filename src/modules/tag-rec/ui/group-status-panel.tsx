import { Badge, Button, Input, InputNumber, Popover, Select, Switch, Tag, Typography } from 'antd'
import { cloneDeep } from 'es-toolkit'
import { useState } from 'react'
import { useSnapshot } from 'valtio'
import { settings } from '$modules/settings'
import toast from '$utility/toast'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  findTagRecCondition,
  hasTagRecCombination,
  removeTagRecCondition,
  TAG_REC_CONDITION_FIELDS,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  type TagRecConditionAtom,
  type TagRecConditionField,
} from '../model/combination'
import {
  resolveTagRecEffectiveProvenance,
  TAG_REC_PATCHABLE_DIM_KEYS,
  type TagRecDimsPatch,
  type TagRecFilterDims,
  type TagRecProvenanceLayerId,
} from '../model/filter-engine'
import { PARTITION_NAME_TO_PARENT } from '../model/partition-table'
import { favorites, favoritesL1, favoritesL1Store, favoritesStore, viewScope, viewScopeStore } from '../store'
import { tagRecFavSession, tagRecSharedSession } from '../store/session'
import { TAG_REC_DROP_DIM_LABELS } from './banner-helpers'
import { CandidateResolvePicker } from './candidate-resolve-picker'
import { TagRecConditionTreeView, type TagRecConditionTreeEdit } from './group-condition-tree'
import { TAG_REC_POOL_KEYS, TAG_REC_POOL_LABELS } from './pool-labels'
import type { TagGroup, TagRecNegativeRules, TagRecPartitionEntry, TagRecPoolKey } from '../model/types'

/**
 * 「组现状与配置」顶部三件套 (wayfinding 001/004/007) —— 只挂 L2:
 * ① 条件树 (含基础编辑: 删/切 all↔any/加原子与排除 —— 直写 group.combination);
 * ② 生效值表 (键存在性回放归因, 默认只显「有声明的行」, 会话层只读);
 * ③ 抽牌状态 (开关/权重/视野/临时开启/交集收窄)。
 * 「改」一律写 group.overrides (Q12 决议); 嵌套重组仍走「编辑条件 ↗」工作台。
 */

// ———— 归因层徽标 ————

const LAYER_BADGE: Record<TagRecProvenanceLayerId, { text: string; fg: string; bg: string }> = {
  global: { text: '全局', fg: '#595959', bg: '#f5f5f5' },
  pool: { text: '池', fg: '#0958d9', bg: '#e6f4ff' },
  l1: { text: '一级组', fg: '#389e0d', bg: '#f6ffed' },
  l2: { text: '本组', fg: '#d4380d', bg: '#fff2e8' },
  cell: { text: '格', fg: '#d46b08', bg: '#fff7e6' },
  combination: { text: '组合', fg: '#531dab', bg: '#f9f0ff' },
  session: { text: '会话', fg: '#cf1322', bg: '#fff1f0' },
  sessionCell: { text: '会话·格', fg: '#cf1322', bg: '#fff1f0' },
  derived: { text: '交集·收窄', fg: '#595959', bg: '#f5f5f5' },
}

const LayerBadge = ({ id }: { id: TagRecProvenanceLayerId }) => {
  const c = LAYER_BADGE[id]
  return (
    <span className='rounded-4px px-4px text-11px' style={{ color: c.fg, background: c.bg }}>
      {c.text}
    </span>
  )
}

// ———— 生效值格式化 ————

const fmtNum = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(v % 10000 ? 1 : 0)}w` : String(v))
const fmtRate = (v: number) => `${+(v * 100).toFixed(2)}%`

function formatDimValue(key: keyof TagRecFilterDims, d: TagRecFilterDims[keyof TagRecFilterDims]): string {
  const v = d as Record<string, unknown>
  if (v.enabled === false) return '已声明 · 关'
  if (key === 'duration') return `时长 ${v.min || 0}s ~ ${v.max || '∞'}`
  if (key === 'pubdate') {
    const win = v.win ? String(v.win) : undefined
    const span = [
      v.from ? `≥${new Date(Number(v.from) * 1000).toLocaleDateString()}` : '',
      v.to ? `≤${new Date(Number(v.to) * 1000).toLocaleDateString()}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    return `发布时间 ${[win, span].filter(Boolean).join(' ') || '已开启'}`
  }
  if ('list' in v) return `${(v.list as unknown[]).length} 项`
  if (typeof v.value === 'number') return key.endsWith('Rate') ? fmtRate(v.value) : fmtNum(v.value)
  return '已开启'
}

// ———— 「改」写本组 overrides ————

function writeGroupDim(group: TagGroup, key: keyof TagRecDimsPatch, value: unknown) {
  const o = (group.overrides ??= {})
  const dims = (o.dims ??= {})
  ;(dims as Record<string, unknown>)[key] = cloneDeep(value)
}
function clearGroupDim(group: TagGroup, key: keyof TagRecDimsPatch) {
  const o = group.overrides
  if (!o?.dims) return
  delete (o.dims as Record<string, unknown>)[key]
  if (!Object.keys(o.dims).length) delete o.dims
  if (!Object.keys(o).length) delete group.overrides
}

/** {enabled,value} 家族的「改」气泡 —— 其余复杂维 (duration/pubdate/名单) 引导去下方槽位编辑器 */
function DimEditPopover({
  group,
  dimKey,
  eff,
  children,
}: {
  group: TagGroup
  dimKey: keyof TagRecDimsPatch
  eff: TagRecFilterDims
  children: React.ReactNode
}) {
  const cur = eff[dimKey] as { enabled: boolean; value: number }
  const isRate = dimKey.endsWith('Rate')
  const patch = (next: Partial<{ enabled: boolean; value: number }>) =>
    writeGroupDim(group, dimKey, { ...cloneDeep(cur), ...next })
  return (
    <Popover
      trigger='click'
      content={
        <div className='flex flex-col gap-y-6px text-12px'>
          <div className='opacity-60'>写入位置: 本组 overrides（上方生效值即时重解）</div>
          <div className='flex items-center gap-x-8px'>
            <Switch size='small' checked={cur.enabled} onChange={(v) => patch({ enabled: v })} />
            <InputNumber
              size='small'
              min={0}
              step={isRate ? 0.01 : 100}
              value={cur.value}
              onChange={(v) => typeof v === 'number' && patch({ value: v })}
            />
            <span className='opacity-60'>{isRate ? '(比率 0.02=2%)' : ''}</span>
          </div>
          {group.overrides?.dims?.[dimKey] !== undefined && (
            <Button
              size='small'
              type='link'
              className='h-auto self-start px-0'
              onClick={() => clearGroupDim(group, dimKey)}
            >
              清除本组声明（回继承）
            </Button>
          )}
        </div>
      }
    >
      {children}
    </Popover>
  )
}

// ———— 加条件/加排除的挑选控件 ————

function ConditionAdder({
  kind,
  group,
  targetGroupId,
  onDone,
}: {
  kind: 'group' | 'exclude'
  group: TagGroup
  targetGroupId?: string
  onDone?: () => void
}) {
  const [field, setField] = useState<TagRecConditionField>('tag')
  const push = (atom: TagRecConditionAtom) => {
    // add/exclude 撞键或超限返回 false —— mutate no-op 照样过校验落库, 吞掉返回值就是静默失败
    let applied = false
    const saved = favorites.editGroupCombination(group.id, (combo) => {
      applied =
        kind === 'exclude' ? excludeTagRecCondition(combo, atom) : addTagRecCondition(combo, atom, targetGroupId)
    })
    if (saved && !applied) {
      toast(kind === 'exclude' ? '该条件已在排除名单中，未重复加入' : '该条件已存在或组合已达上限，未加入')
    }
    onDone?.()
  }
  const textInput = (ph: string, build: (raw: string) => TagRecConditionAtom | undefined) => (
    <Input.Search
      size='small'
      className='w-220px'
      placeholder={ph}
      enterButton='加入'
      onSearch={(raw) => {
        const atom = build(raw.trim())
        if (atom) push(atom)
      }}
    />
  )
  return (
    <div className='w-320px flex flex-col gap-y-6px'>
      <Select
        size='small'
        className='w-140px'
        value={field}
        onChange={setField}
        options={Object.entries(TAG_REC_CONDITION_FIELDS).map(([value, label]) => ({ value, label }))}
      />
      {field === 'tag' && (
        <CandidateResolvePicker
          confirmLabel={kind === 'exclude' ? '加入排除' : '加入条件'}
          existingTagIds={tagRecConditionAtoms(group.combination?.include ?? { kind: 'group', children: [] }).flatMap(
            (a) => (a.field === 'tag' ? [a.value.id] : []),
          )}
          existingLabel='已在条件树'
          onConfirm={(entries) => {
            for (const e of entries) push(tagRecConditionAtom('tag', e))
          }}
        />
      )}
      {(field === 'title' || field === 'desc') &&
        textInput(`${TAG_REC_CONDITION_FIELDS[field]}…`, (raw) => (raw ? tagRecConditionAtom(field, raw) : undefined))}
      {field === 'up' && textInput('UP 主名…', (raw) => (raw ? tagRecConditionAtom('up', { name: raw }) : undefined))}
      {field === 'partition' && (
        <Select<string>
          size='small'
          className='w-220px'
          showSearch
          placeholder='搜分区名加入'
          value={null}
          options={Object.entries(PARTITION_NAME_TO_PARENT).map(([name, ids]) => ({
            value: name,
            label: `${name}${ids.v1 !== undefined ? ` (v1:${ids.v1})` : ''}${ids.v2 !== undefined ? ` (v2:${ids.v2})` : ''}`,
          }))}
          filterOption={(input, opt) => !!opt?.label?.toString().includes(input.trim())}
          onChange={(name) => {
            const ids = PARTITION_NAME_TO_PARENT[name]
            const entry: TagRecPartitionEntry = {
              name,
              ...(ids?.v2 !== undefined ? { v2: ids.v2 } : { v1: ids?.v1 }),
              level: 'parent',
            }
            push(tagRecConditionAtom('partition', entry))
          }}
        />
      )}
    </div>
  )
}

// ———— 主面板 ————

export function TagRecGroupStatusPanel({
  groupId,
  getPopupContainer,
}: {
  groupId: string
  getPopupContainer?: () => HTMLElement
}) {
  // 订阅即重渲; 写入用门面活体引用 (valtio proxy), 快照只供派生读
  const favSnap = useSnapshot(favoritesStore)
  const l1Snap = useSnapshot(favoritesL1Store)
  useSnapshot(viewScopeStore)
  useSnapshot(tagRecFavSession)
  useSnapshot(tagRecSharedSession)
  void favSnap
  void l1Snap

  const [pool, setPool] = useState<TagRecPoolKey>('allV2')
  const [showAll, setShowAll] = useState(false)
  const [adderOpen, setAdderOpen] = useState<string>() // 'group:<id>' | 'exclude'

  const group = favorites.list.find((g) => g.id === groupId)
  if (!group) return null
  const l1 = group.l1Id ? favoritesL1.list.find((l) => l.id === group.l1Id) : undefined
  const core = settings.tagRec.filter
  const sessionCore = tagRecFavSession.filterOverride
  const resolved = resolveTagRecEffectiveProvenance(core, pool, group, l1, sessionCore)
  const { prov } = resolved

  // —— ③ 抽牌状态 ——
  const viewed = viewScope.viewedGroupIds()
  const inView = !viewed || viewed.has(groupId)
  const tempOn = tagRecSharedSession.tempEnabledGroupIds.includes(groupId)
  const l1Off = l1 && !l1.enabled && !tagRecSharedSession.tempEnabledL1Ids.includes(l1.id)
  const drawable = !!group.enabled || tempOn
  const deckState = !drawable
    ? { text: '未入抽', fg: '#cf1322' }
    : l1Off || !inView
      ? { text: '暂不入抽', fg: '#d46b08' }
      : { text: '在抽', fg: '#389e0d' }
  const deckWhy = [
    !group.enabled && tempOn ? '临时开启' : !group.enabled ? '组开关关' : '',
    l1Off ? `一级组「${l1!.name}」未启用` : '',
    !inView ? '不在当前观看范围' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  // —— ① 条件树编辑回调 (直写已存组, 校验失败整体丢弃由 editGroupCombination 把关) ——
  const treeEdit: TagRecConditionTreeEdit = {
    onRemoveNode: (id) => favorites.editGroupCombination(groupId, (c) => removeTagRecCondition(c, id)),
    onRemoveExclude: (id) => favorites.editGroupCombination(groupId, (c) => removeTagRecCondition(c, id)),
    onSetMode: (id, mode) =>
      favorites.editGroupCombination(groupId, (c) => {
        const node = findTagRecCondition(c.include, id)
        if (node?.kind === 'group') node.mode = mode
      }),
    renderAdder: (target) => {
      const key = target.kind === 'exclude' ? 'exclude' : `group:${target.id}`
      return (
        <Popover
          key={key}
          open={adderOpen === key}
          onOpenChange={(v) => setAdderOpen(v ? key : undefined)}
          trigger='click'
          getPopupContainer={getPopupContainer}
          content={
            <ConditionAdder
              kind={target.kind === 'exclude' ? 'exclude' : 'group'}
              group={group}
              targetGroupId={target.kind === 'group' ? target.id : undefined}
              onDone={() => setAdderOpen(undefined)}
            />
          }
        >
          <Button size='small' type='dashed' className='h-20px px-6px text-11px'>
            ＋{target.kind === 'exclude' ? '排除' : '条件'}
          </Button>
        </Popover>
      )
    },
  }

  // —— ② 生效值表行 (默认只显「有声明的行」= prov 记到层的; 显示全部字段把继承行也摊开) ——
  const declaredDimKeys = TAG_REC_PATCHABLE_DIM_KEYS.filter((k) => prov.dims[k] !== undefined)
  const dimRows = showAll ? [...TAG_REC_PATCHABLE_DIM_KEYS] : declaredDimKeys
  const groupDeclares = (key: keyof TagRecDimsPatch): string => {
    if (group.overrides?.pools?.[pool]?.dims?.[key] !== undefined) return '格'
    if (group.overrides?.dims?.[key] !== undefined) return '本组'
    if (group.combination?.filters?.dims?.[key] !== undefined) return '组合.filters'
    return '—'
  }
  const scoreDeclared = Object.keys(prov.scoreWeights).length + Object.keys(prov.scoreAnchors).length
  const sessionRowProv = (id: TagRecProvenanceLayerId) => id === 'session' || id === 'sessionCell'

  // —— 名单生效行 (patch 结构性排除名单维 => 持久层声明在 overrides.negative, 会话/组合经 dims 名单进同链);
  //   resolved.neg 的 scope 已是归一显示串 ('组'/'L1·名'/'会话'/'组合'/'全局') —— 只读行, 改走槽位/负向管理 ——
  const neg = resolved.neg
  const blockBits = [
    neg.tagIds.length && `tag ${neg.tagIds.length} 项`,
    neg.up.length && `UP ${neg.up.length} 项`,
    neg.title.length && `标题词 ${neg.title.length}`,
    neg.desc.length && `简介词 ${neg.desc.length}`,
    neg.partitionBlock.length && `分区 ${neg.partitionBlock.length}`,
    ...(neg.tagBlock ?? []).map((l) => `tag 屏蔽 ${l.list.length}(${l.scope}${l.strict ? '·严格' : ''})`),
  ].filter(Boolean)
  const blockScopes = [
    ...new Set(
      [...neg.tagIds, ...neg.up, ...neg.title, ...neg.desc, ...neg.partitionBlock, ...(neg.tagBlock ?? [])].map(
        (e) => e.scope,
      ),
    ),
  ]
  const allowBits = [
    neg.tagAllow && `tag ${neg.tagAllow.list.length}(${neg.tagAllow.scope})`,
    neg.upAllow && `UP ${neg.upAllow.list.length}(${neg.upAllow.scope})`,
    neg.titleAllow && `标题词 ${neg.titleAllow.list.length}(${neg.titleAllow.scope})`,
    neg.descAllow && `简介词 ${neg.descAllow.list.length}(${neg.descAllow.scope})`,
    neg.partitionAllow && `分区 ${neg.partitionAllow.list.length}(${neg.partitionAllow.scope})`,
  ].filter((b): b is string => !!b)
  const allowScopes = [
    ...new Set(
      [neg.tagAllow, neg.upAllow, neg.titleAllow, neg.descAllow, neg.partitionAllow].flatMap((x) =>
        x ? [x.scope] : [],
      ),
    ),
  ]
  const negDecl = group.overrides?.negative
  const cfListDims = group.combination?.filters?.dims
  /** 声明探测 = 键存在且容器非空 (稀疏语义: 键在=声明, 空壳不算) */
  const negDeclBits = (keys: (keyof TagRecNegativeRules)[], dimsKeys: (keyof TagRecFilterDims)[]) =>
    [
      negDecl &&
      keys.some((k) => {
        const v = negDecl[k]
        if (v === undefined) return false
        if (Array.isArray(v)) return v.length > 0
        if (v && typeof v === 'object') {
          const l = v as { enabled?: boolean; list?: unknown[] }
          return Array.isArray(l.list) ? l.list.length > 0 : l.enabled !== undefined
        }
        return v === true // strict 开关
      })
        ? '本组'
        : '',
      cfListDims &&
      dimsKeys.some((k) => {
        const r = cfListDims[k] as { enabled?: boolean; list?: unknown[] } | undefined
        return !!(r && Array.isArray(r.list) && r.list.length > 0)
      })
        ? '组合.filters'
        : '',
    ]
      .filter(Boolean)
      .join(' + ') || '—'
  const blockDecl = negDeclBits(
    ['tagIds', 'strict', 'tagBlock', 'up', 'title', 'desc', 'partitionBlock', 'partition'],
    ['upBlacklist', 'titleKeywords', 'descKeywords', 'partitionBlock', 'tagBlock'],
  )
  const allowDecl = negDeclBits(
    ['tagAllow', 'upAllow', 'titleAllow', 'descAllow', 'partitionAllow'],
    ['tagAllow', 'upAllow', 'titleAllow', 'descAllow', 'partitionAllow'],
  )

  return (
    <div className='mb-10px b-1px b-gate-border rounded-6px b-solid p-10px'>
      <div className='mb-6px flex items-center justify-between'>
        <Typography.Text strong className='text-13px'>
          组现状
        </Typography.Text>
        <div className='flex items-center gap-x-8px'>
          {/* ③ 抽牌状态行 */}
          <Badge color={deckState.fg} text={<span className='text-12px'>{deckState.text}</span>} />
          {!!deckWhy && (
            <Typography.Text type='secondary' className='text-11px'>
              {deckWhy}
            </Typography.Text>
          )}
          <Typography.Text type='secondary' className='text-11px'>
            权重 {group.weight}
          </Typography.Text>
          {resolved.intersection && <Tag className='mr-0 text-10px'>交集 · 收窄</Tag>}
        </div>
      </div>

      {/* ① 条件树 */}
      <div className='mb-8px'>
        <div className='mb-4px flex items-center gap-x-8px'>
          <Typography.Text type='secondary' className='text-12px'>
            条件树
          </Typography.Text>
          <Typography.Text type='secondary' className='text-11px'>
            （删原子/切命中模式/加条件直接落库；嵌套重组去工作台「编辑条件 ↗」）
          </Typography.Text>
        </div>
        <TagRecConditionTreeView
          combination={hasTagRecCombination(group.combination) ? group.combination : undefined}
          tagIds={group.tag_ids}
          edit={treeEdit}
        />
      </div>

      {/* ② 生效值表 */}
      <div>
        <div className='mb-4px flex flex-wrap items-center gap-x-8px'>
          <Typography.Text type='secondary' className='text-12px'>
            生效值
          </Typography.Text>
          <Select
            size='small'
            className='w-190px'
            value={pool}
            onChange={setPool}
            getPopupContainer={getPopupContainer}
            options={TAG_REC_POOL_KEYS.map((p) => ({ value: p, label: TAG_REC_POOL_LABELS[p] }))}
          />
          <Button size='small' type='link' className='h-auto px-0 text-11px' onClick={() => setShowAll((v) => !v)}>
            {showAll ? '只看有声明的' : '显示全部字段'}
          </Button>
        </div>
        <table className='b-collapse w-full text-12px'>
          <thead>
            <tr className='text-left opacity-60'>
              <th className='py-2px font-normal'>字段</th>
              <th className='py-2px font-normal'>生效值</th>
              <th className='py-2px font-normal'>来自</th>
              <th className='py-2px font-normal'>本组声明</th>
              <th className='py-2px font-normal' />
            </tr>
          </thead>
          <tbody>
            {dimRows.map((k) => {
              const layer = prov.dims[k] ?? 'global'
              const sessionOwned = sessionRowProv(layer)
              const simple = 'value' in (resolved.cfg.dims[k] as object)
              return (
                <tr key={k} className='b-t-1px b-t-gate-border b-t-solid'>
                  <td className='py-3px'>{TAG_REC_DROP_DIM_LABELS[k] ?? k}</td>
                  <td className='py-3px'>{formatDimValue(k, resolved.cfg.dims[k])}</td>
                  <td className='py-3px'>
                    <LayerBadge id={layer} />
                  </td>
                  <td className='py-3px opacity-80'>{groupDeclares(k)}</td>
                  <td className='py-3px text-right'>
                    {sessionOwned ? (
                      <Typography.Text type='secondary' className='text-11px'>
                        会话改动 · 去过滤弹层
                      </Typography.Text>
                    ) : simple ? (
                      <DimEditPopover group={group} dimKey={k} eff={resolved.cfg.dims}>
                        <Button size='small' type='link' className='h-auto px-0 text-11px'>
                          改
                        </Button>
                      </DimEditPopover>
                    ) : (
                      <Typography.Text type='secondary' className='text-11px'>
                        下方槽位编辑
                      </Typography.Text>
                    )}
                  </td>
                </tr>
              )
            })}
            {!!scoreDeclared && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>算分参数</td>
                <td className='py-3px opacity-80'>
                  权重 {Object.keys(prov.scoreWeights).length} 项声明 · 锚点 {Object.keys(prov.scoreAnchors).length}{' '}
                  项声明
                </td>
                <td className='py-3px'>
                  <LayerBadge id={prov.scoreWeights[Object.keys(prov.scoreWeights)[0] as never] ?? 'global'} />
                </td>
                <td className='py-3px opacity-80'>{group.overrides?.score ? '本组' : '—'}</td>
                <td className='py-3px text-right'>
                  <Typography.Text type='secondary' className='text-11px'>
                    下方槽位编辑
                  </Typography.Text>
                </td>
              </tr>
            )}
            {(showAll || prov.smallPoolThreshold !== 'global') && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>小池阈值</td>
                <td className='py-3px'>{resolved.cfg.smallPoolThreshold}</td>
                <td className='py-3px'>
                  <LayerBadge id={prov.smallPoolThreshold} />
                </td>
                <td className='py-3px opacity-80'>
                  {group.overrides?.pools?.[pool]?.smallPoolThreshold !== undefined
                    ? '格'
                    : group.overrides?.smallPoolThreshold !== undefined
                      ? '本组'
                      : '—'}
                </td>
                <td className='py-3px text-right'>
                  {sessionRowProv(prov.smallPoolThreshold) ? (
                    <Typography.Text type='secondary' className='text-11px'>
                      会话改动 · 去过滤弹层
                    </Typography.Text>
                  ) : (
                    <Popover
                      trigger='click'
                      content={
                        <div className='flex items-center gap-x-6px text-12px'>
                          <InputNumber
                            size='small'
                            min={0}
                            value={resolved.cfg.smallPoolThreshold}
                            onChange={(v) => {
                              if (typeof v !== 'number') return
                              const o = (group.overrides ??= {})
                              o.smallPoolThreshold = v
                            }}
                          />
                          <span className='opacity-60'>写入本组 overrides</span>
                        </div>
                      }
                    >
                      <Button size='small' type='link' className='h-auto px-0 text-11px'>
                        改
                      </Button>
                    </Popover>
                  )}
                </td>
              </tr>
            )}
            {/* 池开关 (本池) —— derived=交集收窄缺省, session=会话层 */}
            {(showAll || prov.poolsEnabled[pool] !== 'derived' || !resolved.poolsEnabled[pool]) && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>本池入抽 ({TAG_REC_POOL_LABELS[pool]})</td>
                <td className='py-3px'>{resolved.poolsEnabled[pool] ? '开' : '关'}</td>
                <td className='py-3px'>
                  <LayerBadge id={prov.poolsEnabled[pool]} />
                </td>
                <td className='py-3px opacity-80'>
                  {group.overrides?.poolsEnabled?.[pool] !== undefined ? '本组' : '—'}
                </td>
                <td className='py-3px text-right'>
                  {sessionRowProv(prov.poolsEnabled[pool]) ? (
                    <Typography.Text type='secondary' className='text-11px'>
                      会话改动 · 去过滤弹层
                    </Typography.Text>
                  ) : (
                    <Switch
                      size='small'
                      checked={group.overrides?.poolsEnabled?.[pool] ?? resolved.poolsEnabled[pool]}
                      onChange={(v) => {
                        const o = (group.overrides ??= {})
                        const pe = (o.poolsEnabled ??= {})
                        pe[pool] = v
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
            {(prov.enabled !== 'global' || prov.strictMode !== 'global') && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>过滤总开关 / 严格模式</td>
                <td className='py-3px'>
                  {resolved.cfg.enabled ? '开' : '关'} / {resolved.cfg.strictMode ? '开' : '关'}
                </td>
                <td className='py-3px'>
                  <LayerBadge id={sessionRowProv(prov.enabled) ? prov.enabled : prov.strictMode} />
                </td>
                <td className='py-3px opacity-80'>—</td>
                <td className='py-3px text-right'>
                  <Typography.Text type='secondary' className='text-11px'>
                    会话/全局层字段 · 组层无槽位
                  </Typography.Text>
                </td>
              </tr>
            )}
            {/* 名单生效 (合并面): 屏蔽并集逐层叠加 + 仅看就近覆盖; scope 串自带层标, 组层改走槽位/负向管理 */}
            {!!blockBits.length && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>屏蔽名单</td>
                <td className='py-3px'>
                  {blockBits.join(' · ')}
                  {neg.strict && <Tag className='ml-4px mr-0 text-10px'>严格</Tag>}
                </td>
                <td className='py-3px opacity-80'>{blockScopes.join(' / ')}</td>
                <td className='py-3px opacity-80'>{blockDecl}</td>
                <td className='py-3px text-right'>
                  <Typography.Text type='secondary' className='text-11px'>
                    下方槽位/负向管理
                  </Typography.Text>
                </td>
              </tr>
            )}
            {!!allowBits.length && (
              <tr className='b-t-1px b-t-gate-border b-t-solid'>
                <td className='py-3px'>仅看名单</td>
                <td className='py-3px'>{allowBits.join(' · ')}</td>
                <td className='py-3px opacity-80'>{allowScopes.join(' / ')}</td>
                <td className='py-3px opacity-80'>{allowDecl}</td>
                <td className='py-3px text-right'>
                  <Typography.Text type='secondary' className='text-11px'>
                    下方槽位/负向管理
                  </Typography.Text>
                </td>
              </tr>
            )}
            {!dimRows.length &&
              !scoreDeclared &&
              prov.smallPoolThreshold === 'global' &&
              !blockBits.length &&
              !allowBits.length && (
                <tr>
                  <td colSpan={5} className='py-6px opacity-60'>
                    本组及上层均无声明 —— 全部继承出厂全局。
                  </td>
                </tr>
              )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
