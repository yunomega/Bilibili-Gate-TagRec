import { Badge, Button, Checkbox, Modal, Popconfirm, Select, Switch, Tabs, Tag, Typography } from 'antd'
import { cloneDeep, isEqual } from 'es-toolkit'
import { useRef, useState, type ReactNode } from 'react'
import { proxy, useSnapshot } from 'valtio'
import { antModal } from '$modules/antd'
import toast from '$utility/toast'
import {
  applyTagRecPresetToCore,
  cloneTagRecFilterCore,
  diffTagRecScopeOverride,
  hasTagRecOverride,
  normalizeTagRecNegativeDraft,
  resolveTagRecEffective,
  TAG_REC_PATCHABLE_DIM_KEYS,
  type TagRecDimsPatch,
  type TagRecDropDimKey,
  type TagRecFilterCore,
  type TagRecScopeOverride,
  type TagRecScopeSaveEntry,
  type TagRecScoreAnchors,
  type TagRecScoreWeights,
} from '../model/filter-engine'
import { TAG_REC_DROP_DIM_LABELS } from './banner-helpers'
import { AdvancedSection, ChipsEditor, DimsSection, PartitionEntryPicker } from './filter-form'
import { TAG_REC_POOL_KEYS, TAG_REC_POOL_LABELS } from './pool-labels'
import { TagFilterEntryPicker } from './tag-filter-entry-picker'
import type { TagRecNegativeRules, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] ScopeConfigEditor (R6 泛化) —— 组配置弹层的通用版: 槽位/生效解/存盘全由调用方注入
 * - 原 TagRecGroupConfigModal.Inner 只认 favorites store; 泛化后同套控件供:
 *   收藏夹组/L1 (favorites 壳) · 分享包组/L1 (my-shares 包草稿壳) · 池层槽位 (filterForm/包 fc)
 * - 编辑模型 = draft-core 差分: 打开时把该槽生效解克隆进草稿, 存盘时 vs resolveBase 基准
 *   per-dim 整对象比对 => 稀疏 override (键在=覆盖, 等值=回继承); 名单走 negative 容器
 *   (additive 叠加, 不做差分 —— 所见即本层自持)
 * - 槽类型 cell/pool 无名单 tab (格槽类型封死; 池层同理 —— 名单不进池槽)
 * - UIUX-U1-4 同口径: maskClosable=false; 取消/Esc 遇脏草稿先确认; 「恢复本槽全部继承」裹 Popconfirm
 */

/** 四池标签 (R8 中立模块 re-export; filter-form 与本站双向引用会成环) */
export { TAG_REC_POOL_KEYS, TAG_REC_POOL_LABELS } from './pool-labels'

/** 差分槽位截形: 写盘/脏检只取 dims/score/smallPoolThreshold 三键 (名单走 negative 容器另判) */
export const pickTagRecScopePatch = (o: TagRecScopeOverride | undefined): TagRecScopeOverride | undefined => {
  if (!o) return undefined
  const out: TagRecScopeOverride = {}
  if (o.dims !== undefined) out.dims = o.dims
  if (o.score !== undefined) out.score = o.score
  if (o.smallPoolThreshold !== undefined) out.smallPoolThreshold = o.smallPoolThreshold
  return Object.keys(out).length ? out : undefined
}

/** 池槽覆盖摘要文 (dims 键名走滤除维度中文名; score/阈值各一短词) */
export function tagRecPoolSlotSummary(slot: TagRecScopeOverride): string {
  const parts: string[] = []
  const dims = slot.dims ? Object.keys(slot.dims) : []
  if (dims.length) {
    parts.push(`阈值 ${dims.map((k) => TAG_REC_DROP_DIM_LABELS[k as TagRecDropDimKey] ?? k).join('·')}`)
  }
  if (slot.score) parts.push('算分权重/锚点')
  if (slot.smallPoolThreshold !== undefined) parts.push(`小池阈值 ${slot.smallPoolThreshold}`)
  return parts.join(' · ') || '(空槽)'
}

export type TagRecScopeSlotDef = {
  key: string // 编辑器内唯一 (惯用 'group'|'l1'|`cell:${pool}`|`pool:${pool}`)
  label: string // 作用范围 Select 文案
  cell?: boolean // true = 只编阈值/算分 (格槽/池槽无名单)
}

/** 存盘条目类型 (纯逻辑在 model/filter-engine.ts; 此处 re-export 供 UI 侧习惯引用) */
export type { TagRecScopeSaveEntry }

type Draft = { cfg: TagRecFilterCore; neg: TagRecNegativeRules; pools: Partial<Record<TagRecPoolKey, boolean>> }

export function TagRecScopeConfigEditor({
  title,
  hint,
  core,
  presets,
  slots,
  resolve,
  resolveBase,
  storedOverrideOf,
  negativeOf,
  resolvePoolsEnabled,
  basePoolsEnabled,
  storedPoolsEnabledOf,
  onSave,
  onClose,
  getPopupContainer,
  statusContent,
}: {
  title: ReactNode
  /** 可选副标题提示 (如: 组合组配方不在此弹窗, 只管辅助名单) */
  hint?: ReactNode
  /** 「组现状与配置」面板注入口 (wayfinding 001): 渲在槽位编辑器上方的只读+直写现状区, 仅 L2 壳传 */
  statusContent?: ReactNode
  core: TagRecFilterCore
  /** 可选预设源 (「应用预设」下拉); 不传不渲染 */
  presets?: { name: string; config: TagRecFilterCore; builtin?: boolean }[]
  slots: TagRecScopeSlotDef[]
  /** 槽生效解 (含本层) —— 草稿克隆源 */
  resolve: (key: string) => TagRecFilterCore
  /** 剥本层基准 —— 差分参照 */
  resolveBase: (key: string) => TagRecFilterCore
  /** 已存本槽 patch (脏检比对用; 惯用 = overrides 三键截形) */
  storedOverrideOf?: (key: string) => TagRecScopeOverride | undefined
  /** 本层名单源 (非 cell 槽) */
  negativeOf?: (key: string) => TagRecNegativeRules | undefined
  /** R8 池筛选: 本层生效解 (含本层) / 剥本层基准; 缺省 = 该编辑器不支持池筛选 (不渲染行, 不动存储) */
  resolvePoolsEnabled?: (key: string) => Record<TagRecPoolKey, boolean>
  basePoolsEnabled?: (key: string) => Record<TagRecPoolKey, boolean>
  storedPoolsEnabledOf?: (key: string) => Partial<Record<TagRecPoolKey, boolean>> | undefined
  onSave: (entries: TagRecScopeSaveEntry[]) => void
  onClose: () => void
  getPopupContainer?: () => HTMLElement
}) {
  const [scopeKey, setScopeKey] = useState(slots[0]?.key ?? '')
  const slot = slots.find((s) => s.key === scopeKey) ?? slots[0]
  const isCell = !!slot?.cell

  /** per-scope 草稿 (迟建; 切范围不丢未存编辑) */
  const draftsRef = useRef(new Map<string, Draft>())
  const draftOf = (key: string): Draft => {
    let d = draftsRef.current.get(key)
    if (!d) {
      const pools = storedPoolsEnabledOf?.(key) ?? {}
      d = proxy({
        cfg: cloneTagRecFilterCore(resolve(key)),
        neg: cloneDeep(negativeOf?.(key) ?? {}),
        pools: { ...pools },
      })
      draftsRef.current.set(key, d)
    }
    return d
  }

  const draft = slot ? draftOf(slot.key) : undefined
  // 懒建空兜底草稿 (slots 恒非空, 实际不可达; 保 hooks 恒序 + snap 字段类型完整)
  const emptyDraftRef = useRef<Draft | undefined>(undefined)
  emptyDraftRef.current ??= {
    cfg: core,
    neg: {},
    pools: {},
  }
  const snap = useSnapshot(draft ?? emptyDraftRef.current)
  const baseCfg = slot ? resolveBase(slot.key) : core

  /** 存盘: 逐已建草稿槽差分 => entries 交调用方组装落位 (调用方定槽位语义) */
  const onSaveClick = () => {
    const entries: TagRecScopeSaveEntry[] = []
    for (const [key, d] of draftsRef.current) {
      const s = slots.find((x) => x.key === key)
      if (!s) continue
      const raw = diffTagRecScopeOverride(d.cfg, resolveBase(key))
      const sparsePools = resolvePoolsEnabled
        ? (() => {
            const rec: Partial<Record<TagRecPoolKey, boolean>> = {}
            for (const p of TAG_REC_POOL_KEYS) if (typeof d.pools[p] === 'boolean') rec[p] = d.pools[p]
            return Object.keys(rec).length ? rec : undefined
          })()
        : undefined
      entries.push({
        key,
        patch: raw && hasTagRecOverride(raw) ? raw : undefined,
        negative: s.cell ? undefined : normalizeTagRecNegativeDraft(d.neg),
        ...(resolvePoolsEnabled ? { poolsEnabled: sparsePools } : {}),
      })
    }
    onSave(entries)
    onClose()
  }

  /** 未保存草稿判 —— 与存盘同一差分通道, 逐已建草稿槽比对「将写盘形 vs 现存量」 */
  const hasUnsavedDrafts = () => {
    for (const [key, d] of draftsRef.current) {
      if (!isEqual(diffTagRecScopeOverride(d.cfg, resolveBase(key)), storedOverrideOf?.(key))) return true
      if (resolvePoolsEnabled && !isEqual(d.pools, storedPoolsEnabledOf?.(key) ?? {})) return true
      const s = slots.find((x) => x.key === key)
      if (!s?.cell && !isEqual(normalizeTagRecNegativeDraft(d.neg), normalizeTagRecNegativeDraft(negativeOf?.(key))))
        return true
    }
    return false
  }

  const requestClose = async () => {
    if (hasUnsavedDrafts()) {
      const drop = await antModal.confirm({
        centered: true,
        title: '放弃未保存的修改?',
        content: '各槽草稿改动将整批丢弃',
        okText: '放弃',
        cancelText: '继续编辑',
      })
      if (!drop) return
    }
    onClose()
  }

  /** 本槽全回继承: 草稿抄基准 + 名单清空 */
  const assignDraftToBase = () => {
    if (!draft) return
    const b = cloneTagRecFilterCore(baseCfg)
    draft.cfg.dims = b.dims
    draft.cfg.score = b.score
    draft.cfg.smallPoolThreshold = b.smallPoolThreshold
    draft.neg.up = undefined
    draft.neg.upAllow = undefined
    draft.neg.title = undefined
    draft.neg.titleAllow = undefined
    draft.neg.desc = undefined
    draft.neg.descAllow = undefined
    draft.neg.partitionBlock = undefined
    draft.neg.partitionAllow = undefined
    draft.neg.partition = undefined // 旧形槽位一并摘 (读期折叠, 防残留复活)
    draft.neg.strict = undefined
    draft.neg.tagBlock = undefined
    draft.neg.tagAllow = undefined
    if (resolvePoolsEnabled) draft.pools = {}
  }

  const overriddenDims = TAG_REC_PATCHABLE_DIM_KEYS.filter((k) => !isEqual(snap.cfg.dims[k], baseCfg.dims[k]))
  const overriddenScore = [
    ...(Object.keys(snap.cfg.score.weights) as (keyof TagRecScoreWeights)[])
      .filter((k) => snap.cfg.score.weights[k] !== baseCfg.score.weights[k])
      .map((k) => ({ sec: 'weights' as const, k })),
    ...(Object.keys(snap.cfg.score.anchors) as (keyof TagRecScoreAnchors)[])
      .filter((k) => snap.cfg.score.anchors[k] !== baseCfg.score.anchors[k])
      .map((k) => ({ sec: 'anchors' as const, k })),
  ]
  const thresholdOverridden = snap.cfg.smallPoolThreshold !== baseCfg.smallPoolThreshold
  const overrideCount = overriddenDims.length + overriddenScore.length + (thresholdOverridden ? 1 : 0)

  const resetDims = (k: keyof TagRecDimsPatch) => {
    if (!draft) return
    // union-key 赋值需窄化 (各维值对象异形: 比率/区间); 键与值同源故断言安全
    ;(draft.cfg.dims as Record<string, unknown>)[k as string] = cloneDeep(baseCfg.dims[k])
  }

  const overrideChips = (
    <div className='flex flex-wrap items-center gap-4px text-12px'>
      <Typography.Text type='secondary' className='text-12px'>
        本层覆盖:
      </Typography.Text>
      {overriddenDims.map((k) => (
        <Tag key={k} closable onClose={() => resetDims(k)} className='mr-0'>
          {TAG_REC_DROP_DIM_LABELS[k]}
        </Tag>
      ))}
      {overriddenScore.map(({ sec, k }) => (
        <Tag
          key={`${sec}.${k}`}
          closable
          onClose={() => {
            if (!draft) return
            ;(draft.cfg.score[sec] as Record<string, number>)[k] = (baseCfg.score[sec] as Record<string, number>)[k]
          }}
          className='mr-0'
        >
          {sec === 'weights' ? '权重' : '锚点'}·{k}
        </Tag>
      ))}
      {thresholdOverridden && draft && (
        <Tag closable onClose={() => (draft.cfg.smallPoolThreshold = baseCfg.smallPoolThreshold)} className='mr-0'>
          小池阈值
        </Tag>
      )}
      {!overrideCount && (
        <Typography.Text type='secondary' className='text-12px'>
          无 (全部继承)
        </Typography.Text>
      )}
    </div>
  )

  if (!slot || !draft) return null

  const negDraft = draft.neg
  const negSnap = snap.neg
  const namesTab = {
    key: 'negative',
    label: '名单',
    children: (
      <div className='flex flex-col gap-y-8px'>
        <Typography.Text type='secondary' className='text-12px'>
          屏蔽名单与上下层叠加, 屏蔽优先。标签仅看按「会话 &gt; 二级组 &gt; 一级组 &gt; 全局」取最近的开启非空名单,
          命中其中任一标签即可保留。UP 主/标题/简介/分区仅看同为域收窄 (就近覆盖), 与同实体屏蔽池同存时屏蔽先判赢。
        </Typography.Text>
        {(['tagBlock', 'tagAllow'] as const).map((key) => {
          const rule = negSnap[key]
          const update = () => (negDraft[key] ??= { enabled: false, strict: false, list: [] })
          return (
            <div key={key} className='flex items-start gap-x-8px'>
              <span className='min-w-110px text-12px font-bold'>{key === 'tagBlock' ? '标签·屏蔽' : '标签·仅看'}</span>
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-x-8px'>
                  <Switch size='small' checked={!!rule?.enabled} onChange={(value) => (update().enabled = value)} />
                  <Checkbox
                    checked={!!rule?.strict}
                    disabled={!rule?.enabled}
                    onChange={(e) => (update().strict = e.target.checked)}
                  >
                    严格校验
                  </Checkbox>
                </div>
                <TagFilterEntryPicker
                  snapList={rule?.list ?? []}
                  onChange={(entries) => (update().list = entries)}
                  disabled={!rule?.enabled}
                  confirmLabel={key === 'tagBlock' ? '加入屏蔽标签' : '加入仅看标签'}
                  getPopupContainer={getPopupContainer}
                />
              </div>
            </div>
          )
        })}
        <Typography.Text type='secondary' className='text-12px'>
          未开严格: 用已有标签/浅池命中, 缺标签放行, 不额外取 tag/top。开严格: 仅对待显示的缺标签视频补查,
          两侧与右键浮窗共用缓存; 失败/超时/退避放行并记未校验。
        </Typography.Text>
        <div className='flex items-center gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>组内负向·严格校验</span>
          <Switch size='small' checked={!!negSnap.strict} onChange={(v) => (negDraft.strict = v || undefined)} />
          <Typography.Text type='secondary' className='text-12px'>
            开 = 补查原组内负向成员的命中 (默认关)
          </Typography.Text>
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>UP 主·屏蔽</span>
          <ChipsEditor
            items={negSnap.up ?? []}
            render={(e) => (e.mid !== undefined ? `${e.name || e.mid} (mid:${e.mid})` : e.name)}
            placeholder='UP 名 或 mid'
            onAdd={(raw) => {
              const mid = /^\d+$/.test(raw) ? Number(raw) : undefined
              const name = mid === undefined ? raw : ''
              const list = (negDraft.up ??= [])
              if (list.some((e) => (mid !== undefined ? e.mid === mid : e.name === name))) return toast('已存在')
              list.push({ name, mid })
            }}
            onRemove={(i) => negDraft.up?.splice(i, 1)}
          />
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>UP 主·仅看</span>
          <Switch
            size='small'
            checked={!!negSnap.upAllow?.enabled}
            onChange={(v) => {
              negDraft.upAllow ??= { enabled: false, list: [] }
              negDraft.upAllow.enabled = v
            }}
          />
          <ChipsEditor
            items={negSnap.upAllow?.list ?? []}
            render={(e) => (e.mid !== undefined ? `${e.name || e.mid} (mid:${e.mid})` : e.name)}
            placeholder='UID（推荐）或 UP 名'
            onAdd={(raw) => {
              const mid = /^\d+$/.test(raw) ? Number(raw) : undefined
              const name = mid === undefined ? raw : ''
              const rule = (negDraft.upAllow ??= { enabled: false, list: [] })
              if (rule.list.some((e) => (mid !== undefined ? e.mid === mid : e.name === name))) return toast('已存在')
              rule.list.push({ name, mid })
            }}
            onRemove={(i) => negDraft.upAllow?.list.splice(i, 1)}
          />
          <Typography.Text type='secondary' className='text-12px'>
            开启过滤后，名单各项都带 UID 时从 UP
            投稿中按标签名搜索，可能漏掉仅视频标签命中的内容；含纯名字条目仍筛选原结果。屏蔽规则优先。
          </Typography.Text>
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>标题·屏蔽词</span>
          <ChipsEditor
            items={negSnap.title ?? []}
            render={(k) => k}
            placeholder='关键词 (归一化子串, ≥2 字符)'
            onAdd={(raw) => {
              const list = (negDraft.title ??= [])
              if (list.includes(raw)) return toast('已存在')
              list.push(raw)
            }}
            onRemove={(i) => negDraft.title?.splice(i, 1)}
          />
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>标题·仅看词</span>
          <Switch
            size='small'
            checked={!!negSnap.titleAllow?.enabled}
            onChange={(v) => {
              negDraft.titleAllow ??= { enabled: false, list: [] }
              negDraft.titleAllow.enabled = v
            }}
          />
          <ChipsEditor
            items={negSnap.titleAllow?.list ?? []}
            render={(k) => k}
            placeholder='关键词'
            onAdd={(raw) => {
              const rule = (negDraft.titleAllow ??= { enabled: false, list: [] })
              if (rule.list.includes(raw)) return toast('已存在')
              rule.list.push(raw)
            }}
            onRemove={(i) => negDraft.titleAllow?.list.splice(i, 1)}
          />
          <Typography.Text type='secondary' className='text-12px'>
            开 = 本组流量只剩标题命中词 (域收窄); 缺字段豁免 (严格模式反转)
          </Typography.Text>
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>简介·屏蔽词</span>
          <ChipsEditor
            items={negSnap.desc ?? []}
            render={(k) => k}
            placeholder='关键词 (仅搜索池/相关池判定)'
            onAdd={(raw) => {
              const list = (negDraft.desc ??= [])
              if (list.includes(raw)) return toast('已存在')
              list.push(raw)
            }}
            onRemove={(i) => negDraft.desc?.splice(i, 1)}
          />
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>简介·仅看词</span>
          <Switch
            size='small'
            checked={!!negSnap.descAllow?.enabled}
            onChange={(v) => {
              negDraft.descAllow ??= { enabled: false, list: [] }
              negDraft.descAllow.enabled = v
            }}
          />
          <ChipsEditor
            items={negSnap.descAllow?.list ?? []}
            render={(k) => k}
            placeholder='关键词'
            onAdd={(raw) => {
              const rule = (negDraft.descAllow ??= { enabled: false, list: [] })
              if (rule.list.includes(raw)) return toast('已存在')
              rule.list.push(raw)
            }}
            onRemove={(i) => negDraft.descAllow?.list.splice(i, 1)}
          />
          <Typography.Text type='secondary' className='text-12px'>
            开 = 本组流量只剩简介命中词 (域收窄); tag/top 条目无简介 =&gt; 豁免 (严格模式反转)
          </Typography.Text>
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>分区·屏蔽</span>
          <PartitionEntryPicker
            list={(negDraft.partitionBlock ??= [])}
            snapList={negSnap.partitionBlock ?? []}
            getPopupContainer={getPopupContainer}
          />
        </div>
        <div className='flex items-start gap-x-8px'>
          <span className='min-w-110px text-12px font-bold'>分区·仅看</span>
          <Switch
            size='small'
            checked={!!negSnap.partitionAllow?.enabled}
            onChange={(v) => {
              negDraft.partitionAllow ??= { enabled: false, list: [] }
              negDraft.partitionAllow.enabled = v
            }}
          />
          <PartitionEntryPicker
            list={(negDraft.partitionAllow ??= { enabled: false, list: [] }).list}
            snapList={negSnap.partitionAllow?.list ?? []}
            getPopupContainer={getPopupContainer}
          />
          <Typography.Text type='secondary' className='text-12px'>
            默认关防误杀; 开 = 流量只剩命中分区 (与屏蔽池独立, 同分区屏蔽先判赢)
          </Typography.Text>
        </div>
      </div>
    ),
  }

  const dimsTab = {
    key: 'dims',
    label: (
      <Badge count={overriddenDims.length} size='small' offset={[6, 0]}>
        阈值
      </Badge>
    ),
    children: (
      <div className='flex flex-col gap-y-8px'>
        {overrideChips}
        {!isCell && resolvePoolsEnabled && (
          <div className='flex flex-wrap gap-8px'>
            {TAG_REC_POOL_KEYS.map((p) => (
              <label key={p}>
                {TAG_REC_POOL_LABELS[p]}{' '}
                <Select
                  size='small'
                  value={snap.pools[p] === undefined ? 'inherit' : snap.pools[p] ? 'on' : 'off'}
                  options={[
                    {
                      value: 'inherit',
                      label: `继承（${basePoolsEnabled?.(scopeKey)?.[p] === false ? '不使用' : '使用'}）`,
                    },
                    { value: 'on', label: '使用' },
                    { value: 'off', label: '不使用' },
                  ]}
                  onChange={(value) => {
                    if (value === 'inherit') delete draft.pools[p]
                    else draft.pools[p] = value === 'on'
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <DimsSection
          core={draft.cfg}
          snap={snap.cfg}
          disabled={false}
          getPopupContainer={getPopupContainer}
          hideListDims
        />
      </div>
    ),
  }

  const scoreTab = {
    key: 'score',
    label: (
      <Badge count={overriddenScore.length + (thresholdOverridden ? 1 : 0)} size='small' offset={[6, 0]}>
        算分
      </Badge>
    ),
    children: (
      <div className='flex flex-col gap-y-8px'>
        {overrideChips}
        <AdvancedSection core={draft.cfg} snap={snap.cfg} disabled={false} hideStrict sectionTitle='算分与小池降级' />
      </div>
    ),
  }

  const tabs = isCell ? [dimsTab, scoreTab] : [namesTab, dimsTab, scoreTab]

  return (
    <Modal
      open
      title={
        <span className='inline-flex items-center gap-x-10px'>
          {title}
          {slots.length > 1 && (
            <Select
              size='small'
              className='w-190px'
              value={scopeKey}
              getPopupContainer={getPopupContainer}
              options={slots.map((s) => ({ value: s.key, label: s.label }))}
              onChange={setScopeKey}
            />
          )}
        </span>
      }
      width={720}
      maskClosable={false} // UIUX-U1-4: 防点遮罩误丢草稿 (取消仍走 requestClose 脏检)
      onCancel={() => void requestClose()}
      onOk={onSaveClick}
      okText='保存'
      cancelText='取消'
    >
      <div className='mb-6px flex items-center gap-x-8px'>
        <Typography.Text type='secondary' className='text-12px'>
          生效链: 会话 &gt; 格(组×池) &gt; 组 &gt; L1 &gt; 池 &gt; 全局;
          {isCell ? ' 本槽只装阈值/算分 (名单不进此层)' : ' 应用预设可把整套参数填进当前槽'}
        </Typography.Text>
        {!isCell && !!presets?.length && (
          <Select
            size='small'
            className='ml-auto w-130px'
            placeholder='应用预设…'
            options={presets.map((p) => ({ value: p.name, label: p.name }))}
            getPopupContainer={getPopupContainer}
            onChange={(name) => {
              if (applyTagRecPresetToCore(presets, draft.cfg, name)) {
                toast(`已把预设「${name}」填入当前槽 (保存生效)`)
              }
            }}
          />
        )}
      </div>
      {hint && (
        <div className='mb-6px'>
          <Typography.Text type='secondary' className='text-12px'>
            {hint}
          </Typography.Text>
        </div>
      )}
      {/* 长表单滚动区 —— 弹层内容超高时底部控件可够 (头部钉住不滚); UIUX-U2-5: 统一 60vh */}
      <div className='max-h-60vh overflow-y-auto pr-4px'>
        {statusContent}
        <Tabs size='small' items={tabs} />
        <Typography.Text type='secondary' className='text-12px'>
          「本层覆盖」表示与上层不同，包含内置配置和手动修改。关闭徽标或保存与上层相同的值可恢复继承。改动保存后生效。
        </Typography.Text>
        <Popconfirm
          title='将清空本槽自定义与本槽名单(含已保存项),确定?'
          okText='恢复继承'
          cancelText='取消'
          getPopupContainer={getPopupContainer}
          onConfirm={assignDraftToBase}
        >
          <Button size='small' className='mt-6px'>
            恢复本槽全部继承
          </Button>
        </Popconfirm>
      </div>
    </Modal>
  )
}

/**
 * 池层槽位块 (R6): 四池各一行「覆盖摘要 + 深编⚙ + 清空」—— 写 core.pools[p] (TagRecScopeOverride 槽)
 * - 复用点: FilterForm (全局+会话两处), ShareFilterEditor 池级覆盖 tab, 预设内嵌 CoreEditor
 * - 深编弹同款 ScopeConfigEditor (单槽无 Select): 生效解 = 全局链+本池槽; 基准 = 摘槽后全局链
 *   (allV2Related 摘槽后 score 回落 allV2 槽 —— resolveTagRecEffective 内置口径)
 * - 会话 scope 同样可调: 引擎对 sessionCore.pools 照常生效 (格层遮蔽不影响池层)
 */
export function TagRecPoolSlotsBlock({
  core,
  disabled,
  getPopupContainer,
}: {
  core: TagRecFilterCore
  disabled?: boolean
  getPopupContainer?: () => HTMLElement
}) {
  const snap = useSnapshot(core)
  const [editing, setEditing] = useState<TagRecPoolKey>()
  return (
    <div className='flex flex-col gap-y-6px'>
      <Typography.Text type='secondary' className='text-12px'>
        池层槽位 = 按来源池覆盖阈值/算分/小池阈值 (在 组/L1 之下、全局之上; 名单不进池层)。 缺省槽 =
        全继承全局;「搜索相关池」算分缺槽时回落「搜索池」档 (两源字段形同构)。
      </Typography.Text>
      <Typography.Text type='secondary' className='text-12px'>
        搜索池的内置配置不计投币权重，以适配缺少投币数的结果，通常无需手动调整。
      </Typography.Text>
      {TAG_REC_POOL_KEYS.map((pk) => {
        const slot = snap.pools?.[pk]
        return (
          <div key={pk} className='b-1px b-gate-border rounded-6px b-dashed px-8px py-6px'>
            <div className='flex items-center gap-x-8px'>
              <Typography.Text strong className='text-12px'>
                {TAG_REC_POOL_LABELS[pk]}
              </Typography.Text>
              <span className='text-12px'>{slot ? `已覆盖: ${tagRecPoolSlotSummary(slot)}` : '全继承 (无槽)'}</span>
              <span className='flex-1' />
              <Button size='small' disabled={disabled} onClick={() => setEditing(pk)}>
                ⚙ 深编
              </Button>
              {slot && (
                <Popconfirm
                  title={`清空 ${TAG_REC_POOL_LABELS[pk]} 的覆盖?`}
                  description='槽整摘 = 该池回上层继承'
                  onConfirm={() => {
                    if (core.pools) {
                      delete core.pools[pk]
                      if (!Object.keys(core.pools).length) delete core.pools
                    }
                  }}
                >
                  <Button size='small' danger disabled={disabled}>
                    清空
                  </Button>
                </Popconfirm>
              )}
            </div>
          </div>
        )
      })}
      {editing && (
        <TagRecScopeConfigEditor
          title={`${TAG_REC_POOL_LABELS[editing]} · 池层槽`}
          core={core}
          slots={[{ key: `pool:${editing}`, label: TAG_REC_POOL_LABELS[editing], cell: true }]}
          resolve={() => resolveTagRecEffective(core, editing).cfg}
          resolveBase={() =>
            resolveTagRecEffective({ ...core, pools: { ...core.pools, [editing]: undefined } }, editing).cfg
          }
          storedOverrideOf={() => pickTagRecScopePatch(core.pools?.[editing])}
          onSave={(entries) => {
            const e = entries.find((x) => x.key === `pool:${editing}`)
            if (!e) return
            if (e.patch) (core.pools ??= {})[editing] = e.patch
            else if (core.pools) {
              delete core.pools[editing]
              if (!Object.keys(core.pools).length) delete core.pools
            }
            toast('已保存池层槽位')
          }}
          onClose={() => setEditing(undefined)}
          getPopupContainer={getPopupContainer}
        />
      )}
    </div>
  )
}
