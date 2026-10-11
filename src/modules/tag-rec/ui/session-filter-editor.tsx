import { Button, Select, Typography } from 'antd'
import { useState } from 'react'
import { useSnapshot } from 'valtio'
import toast from '$utility/toast'
import { resolveTagRecEffective, type TagRecFilterCore } from '../model/filter-engine'
import { AdvancedSection, DimsSection, TagRecPresetRow } from './filter-form'
import { TAG_REC_POOL_KEYS, TAG_REC_POOL_LABELS } from './pool-labels'
import { pickTagRecScopePatch, tagRecPoolSlotSummary, TagRecScopeConfigEditor } from './scope-config-editor'
import type { TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] R8 会话过滤编辑器 (tab2「过滤」弹层主体) —— 对齐标签收藏表组配置弹层
 * - 作用范围: [整档 (全池共用) | 格·tag/top | 格·搜索池 | 格·搜索相关 | 格·推荐相关]
 * - 整档三 tab: 名单 (屏蔽/仅看家族) / 阈值 (池筛选 + 数值维) / 算分 (权重锚点小池严格)
 * - 格 = 会话覆盖里按池的参数 (dims/score/spt; 名单不进格) —— 摘要 + ⚙ 深编 (复用 draft-diff 单元格编辑器)
 * - 直接编辑传入的 core proxy (会话覆盖或「跟随镜像」; 物化/脏跟踪由 FilterPopover 负责)
 */
export function SessionFilterEditor({
  core,
  getPopupContainer,
  resolveScope,
  declaredPools,
  basePoolsEnabled,
  onPoolInherit,
}: {
  core: TagRecFilterCore
  getPopupContainer?: () => HTMLElement
  resolveScope?: (pool: TagRecPoolKey, withoutCell?: boolean) => TagRecFilterCore
  declaredPools?: Partial<Record<TagRecPoolKey, boolean>>
  basePoolsEnabled?: Partial<Record<TagRecPoolKey, boolean>>
  onPoolInherit?: (pool: TagRecPoolKey) => void
}) {
  const snap = useSnapshot(core)
  const [scope, setScope] = useState<'core' | TagRecPoolKey>('core')
  const [tab, setTab] = useState<'list' | 'dims' | 'score'>('list')
  const [cellEditing, setCellEditing] = useState<TagRecPoolKey>()
  const isCell = scope !== 'core'
  const tabs: [typeof tab, string][] = isCell
    ? [
        ['dims', '阈值'],
        ['score', '算分'],
      ]
    : [
        ['list', '名单'],
        ['dims', '阈值'],
        ['score', '算分'],
      ]

  return (
    <div className='flex flex-col gap-y-8px'>
      <TagRecPresetRow core={core} scope='session' getPopupContainer={getPopupContainer} />
      {/* 作用范围 (对齐组配置弹层 5 档) */}
      <div className='flex items-center gap-x-6px'>
        <span className='text-12px font-bold'>作用范围</span>
        <Select
          size='small'
          className='w-190px'
          value={scope}
          getPopupContainer={getPopupContainer}
          onChange={(v) => {
            setScope(v)
            setTab(v === 'core' ? 'list' : 'dims')
          }}
          options={[
            { value: 'core', label: '整档 (全池共用)' },
            ...TAG_REC_POOL_KEYS.map((p) => ({ value: p, label: `格 · ${TAG_REC_POOL_LABELS[p]}` })),
          ]}
        />
      </div>

      {isCell ? (
        <div className='flex flex-col gap-y-6px'>
          <Typography.Text type='secondary' className='text-12px'>
            本格覆盖: {core.pools?.[scope] ? tagRecPoolSlotSummary(core.pools[scope]!) : '全继承 (无槽)'}
          </Typography.Text>
          <div>
            <Button size='small' onClick={() => setCellEditing(scope)}>
              ⚙ 深编 (阈值/算分/小池阈值)
            </Button>
          </div>
          <Typography.Text type='secondary' className='text-11px'>
            格 = 会话覆盖里按池的参数 (对齐标签收藏表组配置的「格 · 池」); 名单不进格
          </Typography.Text>
        </div>
      ) : (
        <>
          <div className='flex gap-x-4px b-b-1px b-gate-border b-b-solid pb-4px'>
            {tabs.map(([k, label]) => (
              <Button key={k} size='small' type={tab === k ? 'primary' : 'default'} onClick={() => setTab(k)}>
                {label}
              </Button>
            ))}
          </div>
          {tab === 'list' && (
            <>
              <DimsSection core={core} snap={snap} disabled={false} only='list' getPopupContainer={getPopupContainer} />
              <Typography.Text type='secondary' className='text-12px'>
                标签解析候选独立于草稿组、选定组和扩选暂存。此处严格校验仅作用于辅助名单，复用视频标签缓存;
                查询失败、超时或退避时放行并计入未校验。组合必需条件的内容证据另行按「未知暂存」处理，不受本开关影响。
              </Typography.Text>
            </>
          )}
          {tab === 'dims' && (
            <>
              <div className='flex flex-wrap gap-8px'>
                {TAG_REC_POOL_KEYS.map((p) => (
                  <label key={p}>
                    {TAG_REC_POOL_LABELS[p]}{' '}
                    <Select
                      size='small'
                      value={declaredPools?.[p] === undefined ? 'inherit' : declaredPools[p] ? 'on' : 'off'}
                      options={[
                        { value: 'inherit', label: `继承（${basePoolsEnabled?.[p] === false ? '不使用' : '使用'}）` },
                        { value: 'on', label: '使用' },
                        { value: 'off', label: '不使用' },
                      ]}
                      onChange={(value) => {
                        core.poolsEnabled ??= {}
                        if (value === 'inherit') {
                          onPoolInherit?.(p)
                          core.poolsEnabled[p] = basePoolsEnabled?.[p] ?? true
                        } else core.poolsEnabled[p] = value === 'on'
                      }}
                    />
                  </label>
                ))}
              </div>
              <DimsSection
                core={core}
                snap={snap}
                disabled={false}
                only='numeric'
                getPopupContainer={getPopupContainer}
              />
            </>
          )}
          {tab === 'score' && <AdvancedSection core={core} snap={snap} disabled={false} />}
        </>
      )}

      {cellEditing && (
        <TagRecScopeConfigEditor
          title={`${TAG_REC_POOL_LABELS[cellEditing]} · 格`}
          core={core}
          slots={[{ key: `cell:${cellEditing}`, label: TAG_REC_POOL_LABELS[cellEditing], cell: true }]}
          resolve={() => resolveScope?.(cellEditing) ?? resolveTagRecEffective(core, cellEditing).cfg}
          resolveBase={() =>
            resolveScope?.(cellEditing, true) ??
            resolveTagRecEffective({ ...core, pools: { ...core.pools, [cellEditing]: undefined } }, cellEditing).cfg
          }
          storedOverrideOf={() => pickTagRecScopePatch(core.pools?.[cellEditing])}
          onSave={(entries) => {
            const e = entries.find((x) => x.key === `cell:${cellEditing}`)
            if (!e) return
            if (e.patch) (core.pools ??= {})[cellEditing] = e.patch
            else if (core.pools) {
              delete core.pools[cellEditing]
              if (!Object.keys(core.pools).length) delete core.pools
            }
            toast('已保存格覆盖')
          }}
          onClose={() => setCellEditing(undefined)}
        />
      )}
    </div>
  )
}
