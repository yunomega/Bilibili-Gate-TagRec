import { Button, Checkbox, Collapse, Popover, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { settings } from '$modules/settings'
import toast from '$utility/toast'
import { resolveTagRecEffective } from '../model/filter-engine'
import { favoritesL1Store } from '../store'
import { tagRecCustomSession, tagRecSharedSession } from '../store/session'
import { editTagRecWorkingGroup } from '../store/workbench'
import { tagRecHoldReasonText } from './banner-helpers'
import { TAG_REC_POOL_KEYS } from './pool-labels'
import { TagRecRecheckButton } from './recheck-button'
import type { TagRecPoolKey } from '../model/types'
import type { TagRecCustomService } from '../service/tag-rec-custom'

export const TAG_REC_POOL_NAMES: Record<TagRecPoolKey, string> = {
  tagTop: '标签视频',
  allV2: '精确搜索',
  allV2Related: '搜索相关',
  archiveRelated: '推荐相关',
}
export function setTagRecWorkingPool(pool: TagRecPoolKey, value?: boolean) {
  return editTagRecWorkingGroup((group) => {
    const filters = (group.combination!.filters ??= { dims: {} })
    if (value === undefined) {
      delete filters.poolsEnabled?.[pool]
      if (!Object.keys(filters.poolsEnabled ?? {}).length) delete filters.poolsEnabled
    } else (filters.poolsEnabled ??= {})[pool] = value
  })
}
export function TagRecDiscoveryPools({ service, onRefresh }: { service: TagRecCustomService; onRefresh: () => void }) {
  const [busyPool, setBusyPool] = useState<TagRecPoolKey>()
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [service])
  const session = useSnapshot(tagRecCustomSession)
  const { riskControl } = useSnapshot(tagRecSharedSession)
  // 票 006: 待核实计数旁直说卡在哪 (退避/「先看缓存」/额度用尽/放弃计数); 无闸不编造
  const holdReason = tagRecHoldReasonText(session, riskControl)
  const parents = useSnapshot(favoritesL1Store)
  useSnapshot(settings.tagRec)
  const group = session.workingGroup
  const overrides = group?.combination?.filters?.poolsEnabled
  const l1 = parents.list.find((entry) => entry.id === group?.l1Id)
  const effective = (pool: TagRecPoolKey) =>
    settings.tagRec.filter
      ? resolveTagRecEffective(settings.tagRec.filter, pool, group, l1, group?.combination?.filters).poolsEnabled[pool]
      : (overrides?.[pool] ?? true)
  const related = effective('allV2Related') || effective('archiveRelated')
  const counts = service?.getDiscoveryStatus?.() ?? []
  const changeRelated = () =>
    editTagRecWorkingGroup((current) => {
      const filters = (current.combination!.filters ??= { dims: {} })
      filters.poolsEnabled = { ...filters.poolsEnabled, allV2Related: !related, archiveRelated: !related }
    })
  const content = (
    <div style={{ maxWidth: 470 }} className='flex flex-col gap-12px'>
      <Typography.Text strong>内容来源 · 本组合</Typography.Text>
      <Typography.Text type='secondary'>
        只保存明确改过的池选择，其余继续继承。关池后停止该池取新；同一视频仍可由其他已开启的来源出现。
      </Typography.Text>
      {TAG_REC_POOL_KEYS.map((pool) => (
        <div key={pool} className='flex flex-wrap items-center gap-8px'>
          <Checkbox checked={effective(pool)} onChange={(event) => setTagRecWorkingPool(pool, event.target.checked)}>
            {TAG_REC_POOL_NAMES[pool]}
          </Checkbox>
          <Typography.Text type='secondary'>{overrides?.[pool] === undefined ? '继承' : '本组合'}</Typography.Text>
          <Typography.Text type='secondary'>
            {group?.combination
              ? `候选 ${counts.find((entry) => entry.pool === pool)?.cached ?? 0} · 可交付 ${
                  counts.find((entry) => entry.pool === pool)?.deliverable ?? 0
                } · 待核实 ${counts.find((entry) => entry.pool === pool)?.held ?? 0} · 标签待补 ${
                  counts.find((entry) => entry.pool === pool)?.tagsPending ?? 0
                }`
              : `本地候选 ${counts.find((entry) => entry.pool === pool)?.cached ?? 0} · 标签未核实 ${
                  counts.find((entry) => entry.pool === pool)?.tagsPending ?? 0
                }`}
          </Typography.Text>
          <Button size='small' type='text' onClick={() => setTagRecWorkingPool(pool)}>
            恢复继承
          </Button>
          <Button
            size='small'
            loading={busyPool === pool}
            disabled={!!busyPool || !counts.find((entry) => entry.pool === pool)?.tagsPending}
            onClick={async () => {
              setBusyPool(pool)
              controller.current = new AbortController()
              try {
                const result = await service.completeDiscoveryTags(pool, controller.current.signal)
                toast(
                  result.stale
                    ? '当前条件已改变或正在退避，缓存已保留'
                    : `本批补齐 ${result.updated} / ${result.attempted} 条，余下可稍后继续`,
                )
                if (!result.stale) {
                  service.retryPartitions(true)
                  onRefresh()
                }
              } catch {
                toast('这批标签暂未取到，已有缓存仍保留')
              } finally {
                controller.current = undefined
                setBusyPool(undefined)
              }
            }}
          >
            批量补齐标签
          </Button>
        </div>
      ))}
      {!group?.tag_ids.length && (
        <Typography.Text type='secondary'>标签池需要已解析的正向标签；当前可使用其他来源。</Typography.Text>
      )}
      <Typography.Text type='secondary'>
        按池限量补查，每批最多 20 条；复用缓存并遵守并发、时间与退避限额。
      </Typography.Text>
      {!!holdReason && <Typography.Text type='secondary'>{holdReason}</Typography.Text>}
      <Button
        size='small'
        onClick={() =>
          editTagRecWorkingGroup((current) => {
            ;(current.combination!.filters ??= { dims: {} }).poolsEnabled = {
              tagTop: false,
              allV2: true,
              allV2Related: false,
              archiveRelated: false,
            }
          })
        }
      >
        只用精确搜索
      </Button>
      <Button
        size='small'
        onClick={() =>
          editTagRecWorkingGroup((current) => {
            if (current.combination!.filters) delete current.combination!.filters.poolsEnabled
          })
        }
      >
        池选择全部恢复继承
      </Button>
      <TagRecRecheckButton service={service} onDone={onRefresh} />
      <Collapse
        ghost
        size='small'
        items={[
          {
            key: 'execution',
            label: '取新与必要补查',
            children: (
              <>
                <Checkbox
                  checked={session.supplyPaused}
                  onChange={(event) => {
                    tagRecCustomSession.supplyPaused = event.target.checked
                    service.retryPartitions(true)
                    onRefresh()
                  }}
                >
                  先看缓存，暂缓自动取新
                </Checkbox>
                <p>这是临时浏览节奏，不随二级组保存。只停新内容取新：已进队列的核验与深挖照常，明确排除仍会生效。</p>
              </>
            ),
          },
        ]}
      />
    </div>
  )
  return (
    <div className='flex flex-wrap items-center gap-x-8px gap-y-2px' style={{ padding: '1px 0' }}>
      <Popover trigger='click' placement='bottomLeft' content={content}>
        <Button size='small' type='text'>
          内容来源 · {TAG_REC_POOL_KEYS.filter(effective).length} 项 ▾
        </Button>
      </Popover>
      <Typography.Text type='secondary' style={{ fontSize: 11 }}>
        {TAG_REC_POOL_KEYS.filter(effective)
          .map((pool) => TAG_REC_POOL_NAMES[pool])
          .join(' / ')}
      </Typography.Text>
      <Button size='small' type='text' onClick={changeRelated}>
        {related ? '不看相关' : '启用相关'}
      </Button>
      {TAG_REC_POOL_KEYS.every((pool) => !effective(pool)) && (
        <Typography.Text type='secondary'>四个池都已关闭，可在这里重新开启。</Typography.Text>
      )}
      {session.supplyPaused && (
        <Typography.Text type='secondary'>
          缓存浏览中{' '}
          <Button
            size='small'
            type='link'
            onClick={() => {
              tagRecCustomSession.supplyPaused = false
              service.retryPartitions(true)
              onRefresh()
            }}
          >
            恢复取新
          </Button>
        </Typography.Text>
      )}
    </div>
  )
}
