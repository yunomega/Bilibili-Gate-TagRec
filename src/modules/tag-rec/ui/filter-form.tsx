import { Button, Checkbox, Input, InputNumber, Popconfirm, Select, Switch, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { isEqual } from 'es-toolkit'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { snapshot, subscribe, useSnapshot, type Snapshot } from 'valtio'
import { HelpInfo } from '$components/_base/HelpInfo'
import { sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import { settings, useSettingsSnapshot } from '$modules/settings'
import toast from '$utility/toast'
import {
  applyTagRecPreset,
  applyTagRecPresetToCore,
  cloneTagRecFilterCore,
  removeTagRecPreset,
  renameTagRecPreset,
  restoreTagRecBuiltinPreset,
  TAG_REC_ALL_POOL_KEYS,
  upsertTagRecPreset,
  type TagRecFilterCore,
} from '../model/filter-engine'
import { PARTITION_NAME_TO_PARENT } from '../model/partition-table'
import { clampTagRecK, TAG_REC_K_MAX, TAG_REC_K_MIN } from '../service/_pipeline'
import { TAG_REC_POOL_LABELS } from './pool-labels'
import { TagRecPoolSlotsBlock } from './scope-config-editor'
import { TagFilterEntryPicker } from './tag-filter-entry-picker'
import type { TagRecPartitionEntry, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] FilterForm (spec §5.1/§5.2) —— 「标签过滤」pane 与 tab2 过滤 Popover 双处复用
 * - 绑定对象 = `core` (TagRecFilterCore 形状的 valtio proxy):
 *   pane 传 `settings.tagRec.filter` (configPath 段, 持久化/迁移白拿);
 *   tab2 传 `tagRecCustomSession.filterOverride` (会话副本, 刷新即丢不持久)
 * - 结构 = 预设选择器 + 总开关 + 维度开关列表 (13 维三族) + 高级区(权重/锚点/小池阈值/严格模式, 全标「待校准」)
 *   + K 旋钮 (低频不进 tabbar, 仅 global) + 「恢复出厂」(仅 global) + 自定义预设增删改名 (仅 global)
 * - scope='session' 时预设选择器退化为「应用预设整套覆盖副本」, 管理动作/恢复出厂/K 不渲染
 * - readOnly (票 15): tab2 无覆盖时只读预览全局 —— 全控件禁用, 预设行退化为静态文本
 * - getPopupContainer: 内嵌 Select 弹层的就近容器 —— Popover 语境必须挂进 Popover 内容节点,
 *   否则点击下拉项被外层 Popover 判为「外部点击」而误关
 */
export function TagRecFilterForm({
  core,
  scope,
  readOnly,
  getPopupContainer,
}: {
  core: TagRecFilterCore
  scope: 'global' | 'session'
  readOnly?: boolean
  getPopupContainer?: () => HTMLElement
}) {
  const snap = useSnapshot(core)
  const disabled = readOnly || !snap.enabled // 总开关关 / 只读预览 => 子控件全置灰 (同「内容过滤」pane 形态)
  return (
    <div className='flex flex-col gap-y-8px'>
      <TagRecPresetRow core={core} scope={scope} readOnly={readOnly} getPopupContainer={getPopupContainer} />

      {/* 总开关 (spec §3.3: 关 = 完全不过滤 ≈ 预设「全放」) */}
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>总开关</span>
        <Switch size='small' checked={snap.enabled} disabled={readOnly} onChange={(v) => (core.enabled = v)} />
        <Typography.Text type='secondary' className='text-12px'>
          关闭内容过滤，池筛选仍生效；应用预设会覆盖整套全局配置
        </Typography.Text>
      </div>

      {/* R8 池筛选 (只看这些池): 纯产出层, 后台照取照算; 全关/仅剩一池 ⚠ 防呆 */}
      <PoolsEnabledRow
        value={snap.poolsEnabled}
        disabled={readOnly}
        onToggle={(p, on) => {
          core.poolsEnabled ??= {}
          if (on) delete core.poolsEnabled[p]
          else core.poolsEnabled[p] = false
          if (!Object.keys(core.poolsEnabled).length) delete core.poolsEnabled
        }}
      />

      <DimsSection core={core} snap={snap} disabled={disabled} getPopupContainer={getPopupContainer} />
      <AdvancedSection core={core} snap={snap} disabled={disabled} />
      {/* R6: 池层槽位 (四池 dims/score/小池阈值) —— 全局/会话共用; 引擎对 sessionCore.pools 照常生效 */}
      <TagRecPoolSlotsBlock core={core} disabled={disabled} getPopupContainer={getPopupContainer} />
      {scope === 'global' && <KRow />}
    </div>
  )
}

type Snap = Snapshot<TagRecFilterCore>

const C = {
  // UIUX-U2-5: 有边框容器统一 rounded-6px
  block: 'b-1px b-gate-border rounded-6px b-solid px-8px py-6px',
  dimLabel: 'min-w-110px',
  // UIUX-U2-1: 死类 color-gate-secondary => 语义 token 等价 (gate-text + 60% 透明, 同 antd secondary 口径)
  familyTitle: 'mt-2px text-12px text-gate-text font-bold opacity-60',
}

// #region 预设行 (两 scope 共用选择器; 管理动作仅 global)
const PRESET_CUSTOM_VALUE = '__custom__'

export function TagRecPresetRow({
  core,
  scope,
  readOnly,
  getPopupContainer,
}: {
  core: TagRecFilterCore
  scope: 'global' | 'session'
  readOnly?: boolean
  getPopupContainer?: () => HTMLElement
}) {
  const { presets, activePreset } = useSettingsSnapshot().tagRec.filter
  const filterSettings = settings.tagRec.filter
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [applied, setApplied] = useState(() => settings.tagRec.filter.activePreset || undefined)
  /** 会话副本归属名当前是否还对应真实预设档 (同名伪值/已删档 => 回落「自定义」显示) */
  const appliedIsPreset = !!applied && applied !== PRESET_CUSTOM_VALUE && presets.some((p) => p.name === applied)

  /**
   * [tag-rec] UIUX-U1-9: 会话副本任一维度编辑 => 预设归属回落「自定义」伪档。
   *   订阅 core 深变更; 「应用预设」的整套覆写经「写后仍与所选档同形」豁免 ——
   *   否则 apply 的 mutation 回响会立刻把刚选中的档打回自定义 (valtio notify 微批异步, 届时 applied 已更新)
   */
  const appliedRef = useRef(applied)
  appliedRef.current = applied
  useEffect(() => {
    if (scope !== 'session' || readOnly) return
    return subscribe(core as object, () => {
      const name = appliedRef.current
      if (!name || name === PRESET_CUSTOM_VALUE) return
      const p = filterSettings.presets.find((x) => x.name === name)
      // JSON 归一摘 undefined 键 (isEqual 对 {k:undefined} vs 缺键判异)
      const sameShape =
        // eslint-disable-next-line unicorn/prefer-structured-clone -- 有意走 JSON 归一摘 undefined 键 (structuredClone 保留 undefined 属性, 语义不同)
        !!p && isEqual(JSON.parse(JSON.stringify(snapshot(core))), JSON.parse(JSON.stringify(p.config)))
      if (!sameShape) setApplied(PRESET_CUSTOM_VALUE)
    })
  }, [core, scope, readOnly])

  const presetOptions = presets.map((p) => ({
    value: p.name,
    label: p.builtin ? p.name : `${p.name} (自定义)`,
  }))

  // ———— readOnly 预览 (票 15): 无会话副本可覆盖, 预设行退化为静态显示当前生效预设 ————
  if (readOnly) {
    return (
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>预设</span>
        <span className='text-12px'>{presets.some((p) => p.name === activePreset) ? activePreset : '自定义'}</span>
      </div>
    )
  }

  // ———— session scope: 预设选择器 = 「整套覆盖到会话副本」, 无管理动作 ————
  if (scope === 'session') {
    return (
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>预设</span>
        <Select<string>
          size='small'
          className='w-170px'
          placeholder='选择预设整套覆盖'
          // [tag-rec] UIUX-U1-9: 补 global 同款「自定义」伪档 —— 会话副本编辑任一维度后归属回落此档
          options={[...presetOptions, { value: PRESET_CUSTOM_VALUE, label: '自定义' }]}
          value={appliedIsPreset ? applied : PRESET_CUSTOM_VALUE}
          getPopupContainer={getPopupContainer}
          onChange={(name) => {
            if (name === PRESET_CUSTOM_VALUE) {
              setApplied(PRESET_CUSTOM_VALUE) // 「自定义」= 摘归属标记, 配置原样保留 (同 global 档语义)
              return
            }
            if (applyTagRecPresetToCore(filterSettings.presets, core, name)) {
              setApplied(name)
              toast(`已按预设「${name}」覆盖会话副本`)
            }
          }}
        />
        <Typography.Text type='secondary' className='text-12px'>
          只覆盖本会话副本, 不动全局配置
        </Typography.Text>
      </div>
    )
  }

  // ———— global scope: 选择器(含「自定义」伪档) + 增删改名 + 恢复出厂 ————
  const activeIsPreset = presets.some((p) => p.name === activePreset)
  const activePresetObj = presets.find((p) => p.name === activePreset)
  const activeBuiltin = !!activePresetObj?.builtin

  const saveAsPreset = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    // 同名覆盖; 内置档保留 builtin 标记 (spec §3.3: 内置三档可改, 「恢复出厂」可还原)
    const existing = filterSettings.presets.find((p) => p.name === name)
    upsertTagRecPreset(filterSettings, {
      name,
      builtin: existing?.builtin,
      config: cloneTagRecFilterCore(filterSettings),
    })
    filterSettings.activePreset = name // 当前配置即成此预设 => activePreset 跟随
    toast(`已存为预设「${name}」`)
    setSaving(false)
  }

  const restoreFactory = () => {
    const name = filterSettings.activePreset
    if (restoreTagRecBuiltinPreset(filterSettings, name)) {
      applyTagRecPreset(filterSettings, name) // 恢复出厂后立刻把出厂快照整套覆盖进当前配置
      toast(`已恢复出厂「${name}」`)
    }
  }

  return (
    <div className='flex flex-col gap-y-4px'>
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>预设</span>
        <Select<string>
          size='small'
          className='w-170px'
          options={[...presetOptions, { value: PRESET_CUSTOM_VALUE, label: '自定义' }]}
          value={activeIsPreset ? activePreset : PRESET_CUSTOM_VALUE}
          getPopupContainer={getPopupContainer}
          onChange={(v) => {
            if (v === PRESET_CUSTOM_VALUE) {
              filterSettings.activePreset = '' // 「自定义」= 无预设归属标记, 配置原样保留
            } else {
              applyTagRecPreset(filterSettings, v) // 切预设 = 整套覆盖 (spec §3.3)
            }
          }}
        />
        <Button size='small' onClick={() => setSaving((v) => !v)}>
          {saving ? '收起' : '存为预设'}
        </Button>
        {activeIsPreset && !activeBuiltin && (
          <>
            <Button size='small' onClick={() => setRenaming((v) => !v)}>
              重命名
            </Button>
            <Popconfirm
              title='删除预设'
              description={`删除自定义预设「${activePreset}」?`}
              onConfirm={() => removeTagRecPreset(filterSettings, activePreset)}
            >
              <Button size='small' danger>
                删除
              </Button>
            </Popconfirm>
          </>
        )}
        {activeIsPreset && activeBuiltin && (
          <Popconfirm
            title='恢复出厂'
            description={`将内置预设「${activePreset}」恢复为出厂配置并立即应用?`}
            onConfirm={restoreFactory}
          >
            <Button size='small'>恢复出厂</Button>
          </Popconfirm>
        )}
      </div>
      {saving && (
        <Input.Search
          size='small'
          className='w-260px'
          placeholder='预设名 (同名覆盖)'
          enterButton='保存'
          onSearch={saveAsPreset}
        />
      )}
      {renaming && activeIsPreset && !activeBuiltin && (
        <Input.Search
          size='small'
          className='w-260px'
          defaultValue={activePreset}
          enterButton='改名'
          onSearch={(v) => {
            if (renameTagRecPreset(filterSettings, activePreset, v)) {
              toast(`已改名为「${v.trim()}」`)
              setRenaming(false)
            } else {
              toast('改名失败: 空名 / 与既有预设重名')
            }
          }}
        />
      )}
    </div>
  )
}
// #endregion

// #region 维度开关列表 (13 维三族; 负向过滤无开关, 由各组负向成员驱动 —— 票 14)
export function DimRow({
  label,
  tooltip,
  checked,
  disabled,
  onToggle,
  children,
}: {
  label: ReactNode
  tooltip?: ReactNode
  checked: boolean
  disabled?: boolean
  onToggle: (v: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className='flex flex-wrap items-center gap-x-6px gap-y-3px'>
      <Checkbox
        className={C.dimLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      >
        {label}
      </Checkbox>
      {!!tooltip && <HelpInfo className='ml--2px'>{tooltip}</HelpInfo>}
      {children}
    </div>
  )
}

export function NumInput({
  value,
  onChange,
  disabled,
  min = 0,
  max,
  step,
  width = 'w-90px',
  placeholder,
}: {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  min?: number
  max?: number
  step?: number
  width?: string
  placeholder?: string
}) {
  return (
    <InputNumber
      size='small'
      className={width}
      min={min}
      max={max}
      step={step}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(v) => onChange(v == null ? 0 : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)))}
    />
  )
}

/** 时长维预设 (秒级端点, 0=不限) —— ≤5分短 / 5~30中 / 30~60长 / ≥60剧场版 */
const DURATION_PRESETS = [
  { key: 'any', label: '不限', min: 0, max: 0 },
  { key: 'short', label: '短视频 ≤5分', min: 0, max: 300 },
  { key: 'mid', label: '中视频 5~30分', min: 300, max: 1800 },
  { key: 'long', label: '长视频 30~60分', min: 1800, max: 3600 },
  { key: 'movie', label: '剧场版 ≥60分', min: 3600, max: 0 },
] as const

/** 时:分 输入对 -> 秒 (时长维自定义档); 用户手改会丢掉秒级零头 */
function DurationHmInput({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  return (
    <span className='inline-flex items-center gap-2px'>
      <NumInput
        width='w-48px'
        min={0}
        max={99}
        value={hours}
        onChange={(h) => onChange(h * 3600 + minutes * 60)}
        disabled={disabled}
      />
      <span className='text-12px'>时</span>
      <NumInput
        width='w-48px'
        min={0}
        max={59}
        value={minutes}
        onChange={(m) => onChange(hours * 3600 + m * 60)}
        disabled={disabled}
      />
      <span className='text-12px'>分</span>
    </span>
  )
}

/** 内联标签列表编辑: 已有项 closable Tag + 尾部输入框 (Enter/失焦提交) */
export function ChipsEditor<T>({
  items,
  render,
  onRemove,
  onAdd,
  placeholder,
  disabled,
}: {
  items: readonly T[]
  render: (t: T) => ReactNode
  onRemove: (index: number) => void
  onAdd: (raw: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const t = draft.trim()
    if (t) {
      onAdd(t)
      setDraft('')
    }
  }
  return (
    <span className='max-w-full inline-flex flex-wrap items-center gap-4px'>
      {items.map((t, i) => (
        <Tag
          key={i}
          closable={!disabled}
          onClose={(e) => {
            e.preventDefault()
            onRemove(i)
          }}
        >
          {render(t)}
        </Tag>
      ))}
      <Input
        size='small'
        className='w-150px'
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={commit}
        onBlur={commit}
      />
    </span>
  )
}

/** pubdate from/to 日期输入: 'YYYY-MM-DD' 文本态 <-> unix 秒 (0/undefined=未设); 不用 DatePicker (Popover 内嵌无弹层冲突) */
function SinceDateInput({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (unixSec: number) => void
  disabled?: boolean
}) {
  const shown = value > 0 ? dayjs(value * 1000).format('YYYY-MM-DD') : ''
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    const t = text.trim()
    if (!t) {
      if (value) onChange(0)
      return
    }
    const d = dayjs(t)
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(t) || !d.isValid()) {
      toast('日期格式 YYYY-MM-DD')
      setText(shown)
      return
    }
    onChange(d.startOf('day').unix())
  }
  return (
    <Input
      size='small'
      className='w-110px'
      placeholder='YYYY-MM-DD'
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onPressEnter={commit}
      onBlur={commit}
    />
  )
}

/** pubdate.tod 一天内时段输入: 'HH:mm-HH:mm' <-> {from,to} 分钟 (空=未设; from>to=跨零点, 票04) */
function TodInput({
  value,
  onChange,
  disabled,
}: {
  value?: { from?: number; to?: number }
  onChange: (v?: { from?: number; to?: number }) => void
  disabled?: boolean
}) {
  const fmt = (m?: number) =>
    m === undefined ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const shown =
    value && (value.from !== undefined || value.to !== undefined) ? `${fmt(value.from)}-${fmt(value.to)}` : ''
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const parseHm = (s: string) => {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.trim())
    if (!m) return undefined
    const h = +m[1]
    const mi = +m[2]
    return h <= 23 && mi <= 59 ? h * 60 + mi : undefined
  }
  const commit = () => {
    const t = text.trim()
    if (!t) {
      if (shown) onChange(undefined)
      return
    }
    const sep = t.indexOf('-')
    const from = sep > 0 ? parseHm(t.slice(0, sep)) : undefined
    const to = sep > 0 ? parseHm(t.slice(sep + 1)) : undefined
    if (from === undefined || to === undefined) {
      toast('时段格式 HH:mm-HH:mm')
      setText(shown)
      return
    }
    onChange({ from, to })
  }
  return (
    <Input
      size='small'
      className='w-110px'
      placeholder='HH:mm-HH:mm'
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onPressEnter={commit}
      onBlur={commit}
    />
  )
}

/** stat 七项绝对值上下限 (票04): 折叠区, 每行 = [min]~[max] 一对 dim (勾选同启停; 0=未设端) */
const STAT_BOUND_ROWS = [
  { key: 'like', label: '点赞数' },
  { key: 'fav', label: '收藏数' },
  { key: 'coin', label: '投币数' },
  { key: 'danmaku', label: '弹幕数' },
  { key: 'reply', label: '评论数' },
  { key: 'share', label: '分享数' },
] as const

function StatBoundsRows({ d, cd, disabled }: { d: Snap['dims']; cd: TagRecFilterCore['dims']; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className='flex items-center gap-x-6px'>
        <Button size='small' type='text' className='px-0 text-12px' onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}数值上下限 (点赞/收藏/投币/弹幕/评论/分享)
        </Button>
      </div>
      {open &&
        STAT_BOUND_ROWS.map(({ key, label }) => {
          const kMin = `${key}Min` as const
          const kMax = `${key}Max` as const
          const checked = d[kMin].enabled || d[kMax].enabled
          const rowDisabled = disabled || !checked
          return (
            <DimRow
              key={key}
              label={label}
              tooltip='绝对值上下限; 0=该端未设; 勾选后按区间过滤, 缺字段维度豁免放行'
              checked={checked}
              disabled={disabled}
              onToggle={(v) => ((cd[kMin].enabled = v), (cd[kMax].enabled = v))}
            >
              <NumInput
                value={d[kMin].value}
                onChange={(v) => (cd[kMin].value = v)}
                disabled={rowDisabled}
                placeholder='≥'
                width='w-90px'
              />
              <span className='text-12px'>~</span>
              <NumInput
                value={d[kMax].value}
                onChange={(v) => (cd[kMax].value = v)}
                disabled={rowDisabled}
                placeholder='≤'
                width='w-90px'
              />
            </DimRow>
          )
        })}
    </>
  )
}

/** 分区条目录入 (票03/12): 名搜索下拉选一级分区 (双体系 id 一并落条); 叶级 v2 条目走视频卡片右键补 */
export function PartitionEntryPicker({
  list,
  snapList,
  disabled,
  getPopupContainer,
}: {
  list: TagRecPartitionEntry[]
  snapList: readonly { name: string; v1?: number; v2?: number }[]
  disabled?: boolean
  getPopupContainer?: () => HTMLElement
}) {
  const options = Object.entries(PARTITION_NAME_TO_PARENT).map(([name, ids]) => ({
    value: name,
    label: `${name}${ids.v1 !== undefined ? ` (v1:${ids.v1})` : ''}${ids.v2 !== undefined ? ` (v2:${ids.v2})` : ''}`,
  }))
  return (
    <span className='max-w-full inline-flex flex-wrap items-center gap-4px'>
      {snapList.map((e, i) => (
        <Tag
          key={i}
          closable={!disabled}
          onClose={(ev) => {
            ev.preventDefault()
            list.splice(i, 1)
          }}
        >
          {e.name}
          {e.v1 !== undefined || e.v2 !== undefined ? '' : ' (仅名)'}
        </Tag>
      ))}
      <Select<string>
        size='small'
        className='w-170px'
        showSearch
        placeholder='搜分区名添加'
        options={options}
        value={null} // 受控恒占位: undefined=非受控会留着上次选中值 (实修: X 掉条目后下拉仍显示)
        disabled={disabled}
        getPopupContainer={getPopupContainer}
        filterOption={(input, opt) => !!opt?.label?.toString().includes(input.trim())}
        onChange={(name) => {
          const ids = PARTITION_NAME_TO_PARENT[name]
          if (snapList.some((e) => e.name === name)) {
            toast('已存在')
            return
          }
          list.push({ name, ...(ids?.v2 !== undefined ? { v2: ids.v2 } : { v1: ids?.v1 }), level: 'parent' })
        }}
      />
    </span>
  )
}

export function DimsSection({
  core,
  snap,
  disabled,
  getPopupContainer,
  hideListDims,
  only,
}: {
  core: TagRecFilterCore
  snap: Snap
  disabled: boolean
  getPopupContainer?: () => HTMLElement
  /** 票12 GroupConfigModal 阈值 tab: 名单四维走 negative 容器 (结构性不可 patch), 不渲染 */
  hideListDims?: boolean
  /** R8 会话弹层对齐: 'list'=只渲名单区 / 'numeric'=只渲数值维; 缺省=全渲 */
  only?: 'list' | 'numeric'
}) {
  const d = snap.dims
  const cd = core.dims
  const dimProps = (key: keyof typeof cd) => ({
    checked: d[key].enabled,
    disabled,
    onToggle: (v: boolean) => (cd[key].enabled = v),
  })
  const editorOff = (key: keyof typeof cd) => disabled || !d[key].enabled
  // 时长维: 端点命中预设则下拉回显档名, 否则落「自定义」; customDur 记忆「自定义」显式选中
  //   (防止端点仍等于预设时选中态被反推回预设档, 自定义编辑器出不来)
  const [customDur, setCustomDur] = useState(false)
  const durationKey =
    customDur || !DURATION_PRESETS.some((p) => p.min === d.duration.min && p.max === d.duration.max)
      ? 'custom'
      : DURATION_PRESETS.find((p) => p.min === d.duration.min && p.max === d.duration.max)!.key
  // 比率族统一编辑: ≥ 值 0~1
  const rateEditor = (key: 'likeRate' | 'favRate' | 'coinRate' | 'interactRate' | 'shareRate') => (
    <NumInput
      value={d[key].value}
      onChange={(v) => (cd[key].value = v)}
      disabled={editorOff(key)}
      max={1}
      step={0.01}
    />
  )

  return (
    <div className={C.block}>
      {only !== 'list' && (
        <>
          <div className='mb-4px text-12px font-bold'>维度开关</div>
          <div className='flex flex-col gap-y-3px'>
            {/* 绝对值族 */}
            <div className={C.familyTitle}>绝对值</div>
            <DimRow label='播放量 ≥' tooltip='低于该值滤除; 0=未设' {...dimProps('viewMin')}>
              <NumInput
                value={d.viewMin.value}
                onChange={(v) => (cd.viewMin.value = v)}
                disabled={editorOff('viewMin')}
                step={1000}
              />
            </DimRow>
            <DimRow label='播放量 ≤' tooltip='高于该值滤除; 0=未设' {...dimProps('viewMax')}>
              <NumInput
                value={d.viewMax.value}
                onChange={(v) => (cd.viewMax.value = v)}
                disabled={editorOff('viewMax')}
                step={1000}
              />
            </DimRow>
            <StatBoundsRows d={d} cd={cd} disabled={disabled} />

            {/* 比率族 (num/view ≥ 值; 小池降级时与综合分门槛一同失效, spec §3.3) */}
            <div className={C.familyTitle}>比率 (num/view ≥)</div>
            <DimRow
              label='点赞率'
              tooltip='like/view ≥；默认仅参与质量排序，开启后按阈值筛选'
              {...dimProps('likeRate')}
            >
              {rateEditor('likeRate')}
            </DimRow>
            <DimRow label='收藏率' tooltip='favorite/view ≥' {...dimProps('favRate')}>
              {rateEditor('favRate')}
            </DimRow>
            <DimRow label='投币率' tooltip='coin/view ≥' {...dimProps('coinRate')}>
              {rateEditor('coinRate')}
            </DimRow>
            <DimRow label='互动率' tooltip='(danmaku+reply)/view ≥' {...dimProps('interactRate')}>
              {rateEditor('interactRate')}
            </DimRow>
            <DimRow label='分享率' tooltip='share/view ≥' {...dimProps('shareRate')}>
              {rateEditor('shareRate')}
            </DimRow>
            <DimRow label='综合分 ≥' tooltip='综合分门槛 (0~100); 与比率族同属小池降级失效集' {...dimProps('minScore')}>
              <NumInput
                value={d.minScore.value}
                onChange={(v) => (cd.minScore.value = v)}
                disabled={editorOff('minScore')}
                max={100}
                step={5}
              />
            </DimRow>

            {/* 元信息族 */}
            <div className={C.familyTitle}>元信息</div>
            <DimRow label='时长' tooltip='预设档快捷选; 自定义按时:分; 端点留 0=不限' {...dimProps('duration')}>
              <Select
                size='small'
                className='w-130px'
                value={durationKey}
                disabled={editorOff('duration')}
                getPopupContainer={getPopupContainer}
                options={[
                  ...DURATION_PRESETS.map((p) => ({ value: p.key, label: p.label })),
                  { value: 'custom', label: '自定义' },
                ]}
                onChange={(key) => {
                  const preset = DURATION_PRESETS.find((p) => p.key === key)
                  setCustomDur(!preset)
                  if (preset) {
                    cd.duration.min = preset.min
                    cd.duration.max = preset.max
                  }
                }}
              />
              {durationKey === 'custom' && (
                <>
                  <DurationHmInput
                    value={d.duration.min}
                    onChange={(v) => (cd.duration.min = v)}
                    disabled={editorOff('duration')}
                  />
                  <span className='text-12px'>~</span>
                  <DurationHmInput
                    value={d.duration.max}
                    onChange={(v) => (cd.duration.max = v)}
                    disabled={editorOff('duration')}
                  />
                  <Typography.Text type='secondary' className='text-12px'>
                    0=不限
                  </Typography.Text>
                </>
              )}
            </DimRow>
            <DimRow
              label='发布日期'
              tooltip='快捷窗 token / 日期区间 / 一天内时段; 空=未设 (票04)'
              {...dimProps('pubdate')}
            >
              <Select
                size='small'
                className='w-100px'
                options={[
                  { value: '', label: '不限' },
                  { value: 'today', label: '今天' },
                  { value: 'd7', label: '近 7 天' },
                  { value: 'd30', label: '近 30 天' },
                  { value: 'd180', label: '近半年' },
                  { value: 'days', label: '最近 N 天' },
                  { value: 'range', label: '日期区间' },
                ]}
                value={d.pubdate.win ?? ''}
                disabled={editorOff('pubdate')}
                getPopupContainer={getPopupContainer}
                onChange={(v) => {
                  cd.pubdate.win = (v || undefined) as typeof cd.pubdate.win
                  if (v !== 'days') cd.pubdate.days = undefined
                  if (v !== 'range') ((cd.pubdate.from = undefined), (cd.pubdate.to = undefined))
                }}
              />
              {d.pubdate.win === 'days' && (
                <>
                  <NumInput
                    value={d.pubdate.days ?? 0}
                    onChange={(v) => (cd.pubdate.days = v)}
                    disabled={editorOff('pubdate')}
                    min={1}
                    width='w-70px'
                  />
                  <span className='text-12px'>天内</span>
                </>
              )}
              {d.pubdate.win === 'range' && (
                <>
                  <SinceDateInput
                    value={d.pubdate.from ?? 0}
                    onChange={(v) => (cd.pubdate.from = v || undefined)}
                    disabled={editorOff('pubdate')}
                  />
                  <span className='text-12px'>~</span>
                  <SinceDateInput
                    value={d.pubdate.to ?? 0}
                    onChange={(v) => (cd.pubdate.to = v || undefined)}
                    disabled={editorOff('pubdate')}
                  />
                </>
              )}
              <span className='text-12px'>时段</span>
              <TodInput value={d.pubdate.tod} onChange={(v) => (cd.pubdate.tod = v)} disabled={editorOff('pubdate')} />
            </DimRow>
            {/* 名单四维 (票12): GroupConfigModal 阈值 tab 不渲染 —— 组级名单走 negative 容器 (名单 tab) */}
          </div>
        </>
      )}
      {only !== 'numeric' && !hideListDims && (
        <div className={only === 'list' ? 'flex flex-col gap-y-3px' : 'mt-8px flex flex-col gap-y-3px'}>
          <div className={C.familyTitle}>名单 (屏蔽 / 仅看)</div>
          <DimRow
            label='标题·仅看词'
            tooltip='开 = 只剩标题命中词 (域收窄, 子串 ≥2 字符); 缺字段豁免 (严格模式反转)'
            {...dimProps('titleAllow')}
          >
            <ChipsEditor
              items={d.titleAllow.list}
              render={(k) => k}
              disabled={editorOff('titleAllow')}
              placeholder='关键词'
              onAdd={(raw) => {
                if (cd.titleAllow.list.includes(raw)) {
                  toast('已存在')
                  return
                }
                cd.titleAllow.list.push(raw)
              }}
              onRemove={(i) => cd.titleAllow.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow label='标题·屏蔽词' tooltip='标题含任一关键词即滤 (不区分大小写)' {...dimProps('titleKeywords')}>
            <ChipsEditor
              items={d.titleKeywords.list}
              render={(k) => k}
              disabled={editorOff('titleKeywords')}
              placeholder='关键词'
              onAdd={(raw) => {
                if (cd.titleKeywords.list.includes(raw)) {
                  toast('已存在')
                  return
                }
                cd.titleKeywords.list.push(raw)
              }}
              onRemove={(i) => cd.titleKeywords.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow label='UP 主·屏蔽' tooltip='UP 主名或 mid 命中即滤' {...dimProps('upBlacklist')}>
            <ChipsEditor
              items={d.upBlacklist.list}
              render={(e) => (e.mid !== undefined ? `${e.name || e.mid} (mid:${e.mid})` : e.name)}
              disabled={editorOff('upBlacklist')}
              placeholder='UP 名 或 mid'
              onAdd={(raw) => {
                const mid = /^\d+$/.test(raw) ? Number(raw) : undefined
                const name = mid === undefined ? raw : ''
                if (cd.upBlacklist.list.some((e) => (mid !== undefined ? e.mid === mid : e.name === name))) {
                  toast('已存在')
                  return
                }
                cd.upBlacklist.list.push({ name, mid })
              }}
              onRemove={(i) => cd.upBlacklist.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow
            label='UP 主·仅看'
            tooltip='开启过滤后，名单各项都带 UID（可从视频右键加入）时，将在这些 UP 的投稿中按标签名搜索，可能漏掉只写在视频标签里的内容。含纯名字条目仍在原结果中筛选；屏蔽规则优先。'
            {...dimProps('upAllow')}
          >
            <ChipsEditor
              items={d.upAllow.list}
              render={(e) => (e.mid !== undefined ? `${e.name || e.mid} (mid:${e.mid})` : e.name)}
              disabled={editorOff('upAllow')}
              placeholder='UID（推荐）或 UP 名'
              onAdd={(raw) => {
                const mid = /^\d+$/.test(raw) ? Number(raw) : undefined
                const name = mid === undefined ? raw : ''
                if (cd.upAllow.list.some((e) => (mid !== undefined ? e.mid === mid : e.name === name))) {
                  toast('已存在')
                  return
                }
                cd.upAllow.list.push({ name, mid })
              }}
              onRemove={(i) => cd.upAllow.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow
            label='简介·屏蔽词'
            tooltip='简介含任一关键词即滤 (归一化子串); 仅搜索池/相关池判定, tag/top 池不适用 (票02)'
            {...dimProps('descKeywords')}
          >
            <ChipsEditor
              items={d.descKeywords.list}
              render={(k) => k}
              disabled={editorOff('descKeywords')}
              placeholder='关键词'
              onAdd={(raw) => {
                if (cd.descKeywords.list.includes(raw)) {
                  toast('已存在')
                  return
                }
                cd.descKeywords.list.push(raw)
              }}
              onRemove={(i) => cd.descKeywords.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow
            label='简介·仅看词'
            tooltip='开 = 只剩简介命中词 (域收窄); tag/top 条目无简介 => 豁免 (严格模式反转)'
            {...dimProps('descAllow')}
          >
            <ChipsEditor
              items={d.descAllow.list}
              render={(k) => k}
              disabled={editorOff('descAllow')}
              placeholder='关键词'
              onAdd={(raw) => {
                if (cd.descAllow.list.includes(raw)) {
                  toast('已存在')
                  return
                }
                cd.descAllow.list.push(raw)
              }}
              onRemove={(i) => cd.descAllow.list.splice(i, 1)}
            />
          </DimRow>
          <DimRow
            label='分区·屏蔽'
            tooltip='命中即滤，与仅看池独立。新版一级分区按父子关系判断；搜索、相关池缺字段时补查，未确认的内容保留待检。'
            {...dimProps('partitionBlock')}
          >
            <PartitionEntryPicker
              list={cd.partitionBlock.list}
              snapList={d.partitionBlock.list}
              disabled={editorOff('partitionBlock')}
              getPopupContainer={getPopupContainer}
            />
          </DimRow>
          <DimRow
            label='分区·仅看'
            tooltip='只展示确认命中分区的内容；缺字段会分批核验，查不清的内容保留待检。同分区同时屏蔽时，屏蔽优先。'
            {...dimProps('partitionAllow')}
          >
            <PartitionEntryPicker
              list={cd.partitionAllow.list}
              snapList={d.partitionAllow.list}
              disabled={editorOff('partitionAllow')}
              getPopupContainer={getPopupContainer}
            />
          </DimRow>
          {(['tagBlock', 'tagAllow'] as const).map((key) => (
            <div key={key} className='min-w-0'>
              <DimRow
                label={key === 'tagBlock' ? '标签·屏蔽' : '标签·仅看'}
                tooltip={
                  key === 'tagBlock'
                    ? '命中任一名单标签即屏蔽; 与组内负向叠加。严格校验会对缺标签的视频补查完整标签。'
                    : '在当前查询范围内筛选, 命中任一名单标签即可保留; 不会扩成该标签的独立视频池。屏蔽优先; 严格校验会补查缺失标签。'
                }
                {...dimProps(key)}
              >
                <Checkbox
                  checked={!!d[key].strict}
                  disabled={editorOff(key)}
                  onChange={(e) => (cd[key].strict = e.target.checked)}
                >
                  严格校验
                </Checkbox>
              </DimRow>
              <TagFilterEntryPicker
                snapList={d[key].list}
                onChange={(entries) => (cd[key].list = entries)}
                disabled={editorOff(key)}
                confirmLabel={key === 'tagBlock' ? '加入屏蔽标签' : '加入仅看标签'}
                getPopupContainer={getPopupContainer}
              />
            </div>
          ))}
          <Typography.Text type='secondary' className='mb-4px text-12px'>
            未开严格时复用已有标签/浅池, 缺标签放行, 不按名单追加 tag/top; 开严格才对待显示的缺标签视频补查。
          </Typography.Text>
        </div>
      )}
      <Typography.Text type='secondary' className='mt-4px block text-12px'>
        组内负向恒为一维 (由各组展开行的负向成员驱动, 无独立开关); 缺字段维度默认豁免放行
      </Typography.Text>
    </div>
  )
}
// #endregion

// #region 高级区 (spec §5.1: 权重/锚点/小池阈值/严格模式, 全部标「待校准」)
export function AdvancedSection({
  core,
  snap,
  disabled,
  hideStrict,
  sectionTitle = '高级参数',
}: {
  core: TagRecFilterCore
  snap: Snap
  disabled: boolean
  /** 票12 GroupConfigModal 算分 tab: 严格模式是基底姿态不进覆盖链, 不渲染 */
  hideStrict?: boolean
  sectionTitle?: string
}) {
  const w = snap.score.weights
  const a = snap.score.anchors
  const cw = core.score.weights
  const ca = core.score.anchors
  const wsum = Object.values(w).reduce((s, x) => s + x, 0)

  const field = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    opts?: { min?: number; max?: number; step?: number; width?: string },
  ) => (
    <span className='inline-flex items-center gap-x-4px'>
      <span className='text-12px'>{label}</span>
      <NumInput
        value={value}
        onChange={onChange}
        disabled={disabled}
        width={opts?.width ?? 'w-76px'}
        min={opts?.min ?? 0}
        max={opts?.max}
        step={opts?.step}
      />
    </span>
  )

  return (
    <div className={C.block}>
      <div className='mb-4px flex items-center text-12px font-bold'>
        {sectionTitle}
        <Tag color='orange' className='ml-6px mr-0'>
          待校准
        </Tag>
        <HelpInfo>综合分权重/锚点、小池降级阈值、严格模式均为出厂估值, 尚未实测校准 (spec §3.3); 权重和应为 1</HelpInfo>
      </div>
      <div className='flex flex-col gap-y-3px'>
        <div className='flex flex-wrap items-center gap-x-10px gap-y-3px'>
          {field('小池降级阈值', snap.smallPoolThreshold, (v) => (core.smallPoolThreshold = v), { step: 5 })}
          <HelpInfo>轮内池有效条数 &lt; 阈值时, 比率类维度与综合分门槛自动失效 (硬条件仍生效)</HelpInfo>
        </div>
        {!hideStrict && (
          <div className='flex flex-wrap items-center gap-x-10px gap-y-3px'>
            <span className='text-12px'>严格模式</span>
            <Switch
              size='small'
              checked={snap.strictMode}
              disabled={disabled}
              onChange={(v) => (core.strictMode = v)}
            />
            <Typography.Text type='secondary' className='text-12px'>
              开 = 源缺字段即不过; 关 = 缺字段维度不评估放行 (默认)
            </Typography.Text>
          </div>
        )}
        <div className='flex flex-wrap items-center gap-x-10px gap-y-3px'>
          <span className='min-w-120px text-12px'>综合分权重 (Σ≈1)</span>
          {field('播放', w.view, (v) => (cw.view = v), { max: 1, step: 0.05 })}
          {field('赞率', w.likeRate, (v) => (cw.likeRate = v), { max: 1, step: 0.05 })}
          {field('收藏率', w.favRate, (v) => (cw.favRate = v), { max: 1, step: 0.05 })}
          {field('投币率', w.coinRate, (v) => (cw.coinRate = v), { max: 1, step: 0.05 })}
          {field('互动率', w.interactRate, (v) => (cw.interactRate = v), { max: 1, step: 0.05 })}
          <Typography.Text type={Math.abs(wsum - 1) > 0.001 ? 'warning' : 'secondary'} className='text-12px'>
            Σ={wsum.toFixed(2)}
          </Typography.Text>
        </div>
        <div className='flex flex-wrap items-center gap-x-10px gap-y-3px'>
          <span className='min-w-120px text-12px'>锚点 (分量=1 的参照值)</span>
          {field('log10播放', a.viewLog10, (v) => (ca.viewLog10 = v), { step: 1 })}
          {field('赞率', a.likeRate, (v) => (ca.likeRate = v), { step: 0.01 })}
          {field('收藏率', a.favRate, (v) => (ca.favRate = v), { step: 0.01 })}
          {field('投币率', a.coinRate, (v) => (ca.coinRate = v), { step: 0.01 })}
          {field('互动率', a.interactRate, (v) => (ca.interactRate = v), { step: 0.01 })}
        </div>
      </div>
    </div>
  )
}
// #endregion

// #region K 旋钮 (spec §5.1: 低频管理项, 不进 tabbar —— 仅 global scope)
function KRow() {
  const { k } = useSettingsSnapshot().tagRec
  return (
    <div className={sharedClassNames.settingsLine}>
      <span className='min-w-60px font-bold'>K</span>
      <NumInput
        value={k}
        onChange={(v) => (settings.tagRec.k = clampTagRecK(v))}
        min={TAG_REC_K_MIN}
        max={TAG_REC_K_MAX}
        step={1}
      />
      <Typography.Text type='secondary' className='text-12px'>
        「主题推荐」每次预取至多 K 个一级组 (1~10)，二级组按权重交错展示
      </Typography.Text>
    </div>
  )
}
// #endregion

/**
 * [tag-rec] R8 池筛选行 (只看这些池): 4 复选; false=不取 (稀疏存储, 勾=摘键);
 * 纯产出层 (后台照取照算, 不影响算分/深挖/共现); 全关/仅剩一池 => ⚠ 防呆
 * - value 可传 core.poolsEnabled (全局/会话) 或 draft 全量记录 (组配置弹层)
 * - disabledOf: 上层已关的池在本层不可重开 (覆盖只写 false, 防呆)
 */
export function PoolsEnabledRow({
  value,
  onToggle,
  disabled,
  disabledOf,
}: {
  /** 稀疏记录 (缺键/true=取; false=不取) */
  value: Partial<Record<TagRecPoolKey, boolean>> | undefined
  onToggle: (p: TagRecPoolKey, on: boolean) => void
  disabled?: boolean
  disabledOf?: (p: TagRecPoolKey) => boolean
}) {
  const onCount = TAG_REC_ALL_POOL_KEYS.filter((p) => value?.[p] !== false).length
  return (
    <div>
      <div className='mb-4px flex items-center gap-x-8px'>
        <span className='text-12px font-bold'>池筛选</span>
        <Typography.Text type='secondary' className='text-11px'>
          选择使用的推荐来源；关闭后不再为本组拉取。共享搜索、其他组和负向校验仍可能请求
        </Typography.Text>
      </div>
      <div className='flex flex-wrap items-center gap-x-12px gap-y-4px'>
        {TAG_REC_ALL_POOL_KEYS.map((p) => (
          <Checkbox
            key={p}
            checked={value?.[p] !== false}
            disabled={disabled || disabledOf?.(p)}
            onChange={(e) => onToggle(p, e.target.checked)}
          >
            <span className='text-12px'>{TAG_REC_POOL_LABELS[p]}</span>
          </Checkbox>
        ))}
      </div>
      {onCount <= 1 && (
        <Typography.Text type='warning' className='mt-4px block text-11px'>
          ⚠ {onCount === 0 ? '全部池已关闭 —— 将刷不出视频' : '只剩一个池 —— 可能刷不出视频'}
        </Typography.Text>
      )}
    </div>
  )
}
