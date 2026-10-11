import { Button, Input, Popconfirm, Select, Switch, Tabs, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useSnapshot } from 'valtio'
import { sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import toast from '$utility/toast'
import {
  applyTagRecPreset,
  cloneTagRecFilterCore,
  removeTagRecPreset,
  renameTagRecPreset,
  restoreTagRecBuiltinPreset,
  upsertTagRecPreset,
  type TagRecFilterCore,
  type TagRecFilterSettings,
} from '../model/filter-engine'
import { SHARE_GUARD_LIMITS } from '../model/share'
import { AdvancedSection, DimsSection } from './filter-form'
import { TagRecPoolSlotsBlock } from './scope-config-editor'

/**
 * [tag-rec] 分享包 filterConfig 编辑页签 (tag-share-platform 票26) —— 「我的分享 → 改包内容」内
 * - 绑定 = 包内 filterConfig 副本的 valtio proxy (my-shares-modal openEditor 时归一化 + 克隆
 *   脱源, 与用户全局 settings.tagRec.filter 解耦); 保存时整档 cloneDeep 写回 payload.filterConfig
 *   (PATCH 换 payload => 服务端全量重审)
 * - 页签 = 维度阈值 (DimsSection) / 算分与小池 (AdvancedSection 含严格模式) / 池级覆盖
 *   (R6: 池层槽位块 —— 摘要 + ⚙深编弹同款 ScopeConfigEditor + 清空) / 预设 (整套嵌套编辑)
 * - 预设应用走 applyTagRecPreset —— 其内部 assignTagRecFilterCore 先 cloneDeep 再逐键写,
 *   天然断 proxy 别名 (core.dims 与 preset.config.dims 不共享底层对象)
 * - 写入面约束 (服务端防护档): 预设名/名单词串长 ≤200, preset.config 最深嵌套 ≤11 层
 */

/** 预设整套覆盖包内当前配置 + activePreset 跟随 (直用全局档同一引擎 —— assign 内 cloneDeep 断别名) */
const applySharePkgPreset = applyTagRecPreset

export function TagRecShareFilterEditor({
  filter,
  disabled: outerDisabled,
}: {
  /** 包内 filterConfig 编辑副本的 valtio proxy (已归一化; 写回由调用侧 cloneDeep) */
  filter: TagRecFilterSettings
  disabled?: boolean
}) {
  const snap = useSnapshot(filter)
  const disabled = outerDisabled || !snap.enabled // 总开关关 => 子控件全置灰 (同全局 FilterForm 形态)
  return (
    <div className='flex flex-col gap-y-8px'>
      {/* 总开关 (spec §3.3: 关 = 完全不过滤 ≈ 预设「全放」) */}
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>总开关</span>
        <Switch size='small' checked={snap.enabled} disabled={outerDisabled} onChange={(v) => (filter.enabled = v)} />
        <Typography.Text type='secondary' className='text-12px'>
          关闭 = 完全不过滤 (等同预设「全放」, 负向过滤同失效)
        </Typography.Text>
      </div>
      <Tabs
        size='small'
        items={[
          {
            key: 'dims',
            label: '维度阈值',
            children: <DimsSection core={filter} snap={snap} disabled={disabled} />,
          },
          {
            key: 'score',
            label: '算分与高级',
            children: <AdvancedSection core={filter} snap={snap} disabled={disabled} />,
          },
          { key: 'pools', label: '池级覆盖', children: <PoolsPane filter={filter} disabled={disabled} /> },
          {
            key: 'presets',
            label: `预设 (${snap.presets.length})`,
            children: <PresetsPane filter={filter} disabled={disabled} />,
          },
        ]}
      />
    </div>
  )
}

/** 任意 core 形状的编辑面 (包内顶层档 / 预设内嵌档共用): 总开关 + 维度 + 算分 */
function CoreEditor({ core, disabled }: { core: TagRecFilterCore; disabled?: boolean }) {
  const snap = useSnapshot(core)
  const dimDisabled = disabled || !snap.enabled
  return (
    <div className='flex flex-col gap-y-6px'>
      <div className='flex items-center gap-x-6px'>
        <span className='text-12px font-bold'>过滤开关</span>
        <Switch size='small' checked={snap.enabled} disabled={disabled} onChange={(v) => (core.enabled = v)} />
      </div>
      <DimsSection core={core} snap={snap} disabled={dimDisabled} />
      <AdvancedSection core={core} snap={snap} disabled={dimDisabled} />
      {/* R6: 预设内嵌档的池层槽位同样可编 (写 preset.config.pools) */}
      <TagRecPoolSlotsBlock core={core} disabled={dimDisabled} />
    </div>
  )
}

/** 池级覆盖 tab: 复用池层槽位块 (摘要 + ⚙ 深编弹 ScopeConfigEditor + 清空回继承) —— R6 起包内可逐槽细编 */
function PoolsPane({ filter, disabled }: { filter: TagRecFilterSettings; disabled: boolean }) {
  return <TagRecPoolSlotsBlock core={filter} disabled={disabled} />
}

const PRESET_CUSTOM_VALUE = '__custom__'

/** 预设 tab: 激活档选择 (应用=整套覆盖) + 每条预设的改名/删除/恢复出厂/嵌套配置编辑 + 存当前为新预设 */
function PresetsPane({ filter, disabled }: { filter: TagRecFilterSettings; disabled: boolean }) {
  const snap = useSnapshot(filter)
  const activeIsPreset = snap.presets.some((p) => p.name === snap.activePreset)
  return (
    <div className='flex flex-col gap-y-6px'>
      <div className={sharedClassNames.settingsLine}>
        <span className='min-w-60px font-bold'>激活预设</span>
        <Select<string>
          size='small'
          className='w-170px'
          disabled={disabled}
          options={[
            ...snap.presets.map((p) => ({
              value: p.name,
              label: p.builtin ? p.name : `${p.name} (自定义)`,
            })),
            { value: PRESET_CUSTOM_VALUE, label: '自定义 (无归属)' },
          ]}
          value={activeIsPreset ? snap.activePreset : PRESET_CUSTOM_VALUE}
          onChange={(v) => {
            if (v === PRESET_CUSTOM_VALUE) {
              filter.activePreset = '' // 摘归属标记, 配置原样保留 (同全局档语义)
            } else if (applySharePkgPreset(filter, v)) {
              toast(`已按预设「${v}」覆盖当前包内配置`)
            }
          }}
        />
        <Typography.Text type='secondary' className='text-12px'>
          选预设 = 整套覆盖当前维度/算分; 「自定义」只摘归属不改配置
        </Typography.Text>
      </div>
      {snap.presets.map((p, i) => (
        <PresetCard
          key={`${i}:${p.name}`}
          filter={filter}
          index={i}
          active={snap.activePreset === p.name}
          disabled={disabled}
        />
      ))}
      {!snap.presets.length && (
        <Typography.Text type='secondary' className='text-12px'>
          包内没有预设 —— 可用下方「存为预设」把当前配置沉淀一条
        </Typography.Text>
      )}
      <Input.Search
        size='small'
        className='w-280px'
        placeholder='存当前配置为预设 (同名覆盖; 内置档保内置标)'
        maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
        disabled={disabled}
        enterButton='存为预设'
        onSearch={(raw) => {
          const name = raw.trim()
          if (!name) return
          const existing = filter.presets.find((p) => p.name === name)
          upsertTagRecPreset(filter, {
            name,
            builtin: existing?.builtin,
            config: cloneTagRecFilterCore(filter),
          })
          filter.activePreset = name // 当前配置即成此预设 => 归属跟随 (同全局档)
          toast(`已存为预设「${name}」`)
        }}
      />
    </div>
  )
}

/** 单条预设卡: 名 + 内置/激活标 + 应用/存当前覆盖/改名(自定义)/恢复出厂(内置)/删除(自定义)/展开配置编辑 */
function PresetCard({
  filter,
  index,
  active,
  disabled,
}: {
  filter: TagRecFilterSettings
  index: number
  active: boolean
  disabled: boolean
}) {
  const preset = filter.presets[index]!
  const snap = useSnapshot(preset)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState(false)

  return (
    <div className='b-1px b-gate-border rounded-6px b-dashed px-8px py-6px'>
      <div className='flex flex-wrap items-center gap-x-8px gap-y-4px'>
        <Typography.Text strong className='text-13px'>
          {snap.name}
        </Typography.Text>
        {snap.builtin && <Tag className='mr-0'>内置</Tag>}
        {active && (
          <Tag color='green' className='mr-0'>
            激活
          </Tag>
        )}
        {/* [tag-rec] UIUX-U1-5: 预设卡全部是动作 => Button link (Typography.Link 只留导航义) */}
        <span className='ml-auto inline-flex items-center gap-x-8px'>
          <Button
            type='link'
            size='small'
            className='h-auto px-0 text-12px'
            onClick={() => {
              if (applySharePkgPreset(filter, snap.name)) toast(`已按预设「${snap.name}」覆盖当前包内配置`)
            }}
          >
            应用
          </Button>
          <Popconfirm
            title={`把当前包内配置存入预设「${snap.name}」?`}
            description='预设快照被覆写 (同名覆盖语义)'
            onConfirm={() => {
              upsertTagRecPreset(filter, {
                name: snap.name,
                builtin: snap.builtin || undefined,
                config: cloneTagRecFilterCore(filter),
              })
              toast(`已把当前配置存入预设「${snap.name}」`)
            }}
          >
            <Button type='link' size='small' className='h-auto px-0 text-12px' disabled={disabled}>
              存当前覆盖
            </Button>
          </Popconfirm>
          {!snap.builtin && (
            <Button
              type='link'
              size='small'
              className='h-auto px-0 text-12px'
              disabled={disabled}
              onClick={() => setRenaming((v) => !v)}
            >
              {renaming ? '收起改名' : '改名'}
            </Button>
          )}
          {snap.builtin && (
            <Popconfirm
              title={`恢复内置预设「${snap.name}」为出厂配置?`}
              onConfirm={() => {
                if (restoreTagRecBuiltinPreset(filter, snap.name)) toast(`已恢复出厂「${snap.name}」`)
              }}
            >
              <Button type='link' size='small' className='h-auto px-0 text-12px' disabled={disabled}>
                恢复出厂
              </Button>
            </Popconfirm>
          )}
          {!snap.builtin && (
            <Popconfirm title={`删除预设「${snap.name}」?`} onConfirm={() => removeTagRecPreset(filter, snap.name)}>
              <Button type='link' size='small' danger className='h-auto px-0 text-12px' disabled={disabled}>
                删
              </Button>
            </Popconfirm>
          )}
          <Button type='link' size='small' className='h-auto px-0 text-12px' onClick={() => setEditing((v) => !v)}>
            {editing ? '收起配置' : '编辑配置'}
          </Button>
        </span>
      </div>
      {renaming && !snap.builtin && (
        <Input.Search
          size='small'
          className='mt-4px w-260px'
          defaultValue={snap.name}
          maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
          enterButton='改名'
          onSearch={(v) => {
            if (renameTagRecPreset(filter, snap.name, v)) {
              toast(`已改名为「${v.trim()}」`)
              setRenaming(false)
            } else {
              toast('改名失败: 空名 / 与既有预设重名')
            }
          }}
        />
      )}
      {editing && (
        <div className='mt-6px'>
          <CoreEditor core={preset.config} disabled={disabled} />
        </div>
      )}
    </div>
  )
}
