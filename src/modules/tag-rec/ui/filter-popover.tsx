import { Alert, Button, Popconfirm, Popover, Tag, theme, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { proxy, subscribe, useSnapshot } from 'valtio'
import { usePopoverBorderColor } from '$common/emotion-css'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import { settings } from '$modules/settings'
import { resolveTagRecEffective } from '../model/filter-engine'
import {
  createTagRecSessionFilterBase,
  diffTagRecSessionFilter,
  materializeTagRecSessionFilter,
} from '../model/session-filter'
import {
  canKeepTempEntryToGlobal,
  clearTagRecTempWrites,
  keepTagRecTempEntryToGlobal,
  keepTagRecTempEntryToGroup,
  removeTagRecTempWriteAt,
} from '../service/temp-writes'
import { favorites, favoritesL1Store, favoritesStore } from '../store'
import {
  resetTagRecCustomFilter,
  resetTagRecFavFilter,
  tagRecCustomSession,
  tagRecFavSession,
  type TagRecFilterSessionScope,
} from '../store/session'
import { SessionFilterEditor } from './session-filter-editor'

// #region 「过滤」Popover (本锚点临时过滤；只打开不创建覆盖)
export function FilterPopover({
  getPopupContainer,
  scope = 'custom',
}: {
  getPopupContainer: () => HTMLElement
  scope?: TagRecFilterSessionScope
}) {
  const { token } = theme.useToken()
  const { recSharedEmitter } = useRecSelfContext()
  const session = scope === 'fav' ? tagRecFavSession : tagRecCustomSession
  const sessionSnap = useSnapshot(session)
  const { filterOverride, tempWriteLog } = sessionSnap
  const scopeRevision = 'queryRevision' in sessionSnap ? sessionSnap.queryRevision : sessionSnap.filterScopeRevision
  const getRevision = () => (scope === 'fav' ? tagRecFavSession.filterScopeRevision : tagRecCustomSession.queryRevision)
  const [open, setOpen] = useState(false)
  const dirtyRef = useRef(false)
  const [mirrorEpoch, setMirrorEpoch] = useState(0)
  const borderColor = usePopoverBorderColor()
  const contentRef = useRef<HTMLDivElement>(null)
  // 「格」深编等嵌套弹层挂 document.body —— 弹层内点击于本面板均为外部点击,
  //   开态期间须拒收关闭请求, 否则面板先关先应用 (携带编辑前旧覆盖) 而弹层改动被晾成「需刷新」
  const nestedOverlayRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 内嵌控件 (预设 Select/分区 Select) 的弹层挂进 Popover 内容节点:
  // 挂 body 会被外层 Popover 判「外部点击」误关 (spec §5.2 usePopupContainer 就近原则同旨)
  const getInnerPopupContainer = useCallback(() => contentRef.current ?? document.body, [])

  const writingRef = useRef(false)
  const patchJsonRef = useRef(JSON.stringify(session.filterOverride))
  const editor = useMemo(() => {
    const group =
      scope === 'custom'
        ? (tagRecCustomSession.workingGroup ??
          favorites.list?.find((g) => g.id === tagRecCustomSession.selectedGroupIds?.[0]))
        : undefined
    const l1 = favoritesL1Store.list?.find((l) => l.id === group?.l1Id)
    const base = createTagRecSessionFilterBase(settings.tagRec.filter, group, l1)
    return { base, core: proxy(materializeTagRecSessionFilter(base, session.filterOverride)), group, l1 }
  }, [scope, mirrorEpoch, scopeRevision])
  const core = editor.core

  // 表单完整镜像只负责编辑，实际会话态始终保存差分。
  useEffect(
    () =>
      subscribe(
        core,
        () => {
          if (getRevision() !== scopeRevision) return
          writingRef.current = true
          try {
            session.filterOverride = diffTagRecSessionFilter(core, editor.base, session.filterOverride)
            patchJsonRef.current = JSON.stringify(session.filterOverride)
            dirtyRef.current = true
          } finally {
            writingRef.current = false
          }
        },
        true,
      ),
    [core, editor, scopeRevision],
  )

  // 右键和固化从外部改差分；未修改字段继续跟随最新全局/组配置。
  useEffect(
    () =>
      subscribe(
        session,
        () => {
          const json = JSON.stringify(session.filterOverride)
          if (json === patchJsonRef.current) return
          patchJsonRef.current = json
          if (!writingRef.current) setMirrorEpoch((e) => e + 1)
        },
        true,
      ),
    [session],
  )
  useEffect(() => {
    const changed = () => setMirrorEpoch((e) => e + 1)
    const stops = [
      subscribe(settings.tagRec, changed),
      subscribe(favoritesStore, changed),
      subscribe(favoritesL1Store, changed),
    ]
    return () => stops.forEach((stop) => stop())
  }, [])

  // 新查询已有自己的刷新；关闭旧弹层，丢弃旧编辑的待刷新标记。
  useEffect(() => {
    dirtyRef.current = false
    setOpen(false)
  }, [scopeRevision])

  const onOpenChange = (next: boolean) => {
    if (!next && nestedOverlayRef.current) return // 嵌套弹层交互中: 拒收外部点击关闭
    setOpen(next)
    if (next) scrollRef.current?.scrollTo({ top: 0 })
    if (!next && dirtyRef.current) {
      dirtyRef.current = false
      // 轻应用: 离场时一次性重滤现有存货与已上屏条目并原位重展示 —— 不重建 service、不重拉 (队列有货零请求)
      void recSharedEmitter.emit('tag-rec:apply-session-filter')
    }
  }

  const resetToGlobal = () => {
    if (scope === 'fav') resetTagRecFavFilter()
    else resetTagRecCustomFilter()
    setMirrorEpoch((e) => e + 1) // 重建镜像 (跟随「标签过滤」)
    dirtyRef.current = false
    setOpen(false)
    void recSharedEmitter.emit('tag-rec:apply-session-filter') // 清除临时过滤同样走轻应用 (放宽后存货原位放行)
  }

  const content = (
    <div ref={contentRef} className='max-h-72vh max-w-80vw w-460px flex flex-col'>
      <div className='mb-8px flex shrink-0 flex-wrap items-center justify-between gap-6px'>
        <span className='font-bold'>
          {scope === 'custom' && tagRecCustomSession.workingGroup ? '组合过滤' : '临时过滤'}
        </span>
        <div className='flex gap-x-6px'>
          <Button size='small' disabled={!filterOverride && !tempWriteLog.length} onClick={resetToGlobal}>
            {scope === 'custom' && tagRecCustomSession.workingGroup ? '全部恢复继承' : '清除临时过滤'}
          </Button>
          <Button size='small' aria-label='关闭临时过滤面板' onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </div>
      <Alert
        type={filterOverride ? 'warning' : 'info'}
        className='mb-8px shrink-0'
        // [tag-rec] UIUX-U2-6: antd v6 message 属性已废弃 => title (该 Alert 本就无 description 体)
        title={
          scope === 'fav'
            ? filterOverride
              ? '本查看范围临时过滤 · 切换范围自动清除'
              : '跟随「标签过滤」及各组配置 · 改动仅对本查看范围生效'
            : tagRecCustomSession.workingGroup
              ? '明确改过的条件随组合保存；未改项继承默认和所属一级组配置'
              : filterOverride
                ? '本锚点临时过滤 · 换锚点池自动清除'
                : '跟随「标签过滤」及本组配置 · 改动仅对本锚点池生效'
        }
        description={
          scope === 'custom' && tagRecCustomSession.workingGroup
            ? '标签、简介与分区等条件缺少依据时自动补查，未核实先暂存；切换或改条件后临时查看权限恢复。'
            : '只覆盖本次修改的字段，其余继续继承；关闭临时仅看可解除本次限制，组内屏蔽继续生效。'
        }
      />
      <div ref={scrollRef} className='min-h-0 overflow-y-auto'>
        <SessionFilterEditor
          key={`${scopeRevision}-${mirrorEpoch}`}
          core={core}
          declaredPools={filterOverride?.poolsEnabled}
          basePoolsEnabled={editor.base.poolsEnabled}
          onNestedOverlayChange={(next) => {
            nestedOverlayRef.current = next
          }}
          onPoolInherit={(pool) => {
            if (session.filterOverride?.poolsEnabled) delete session.filterOverride.poolsEnabled[pool]
          }}
          resolveScope={(pool, withoutCell) => {
            const patch = session.filterOverride
            return resolveTagRecEffective(
              settings.tagRec.filter,
              pool,
              editor.group,
              editor.l1,
              withoutCell && patch ? { ...patch, pools: { ...patch.pools, [pool]: undefined } } : patch,
            ).cfg
          }}
          getPopupContainer={getInnerPopupContainer}
        />
        {/* R8 临时名单 (右键「临时 · 本会话」账本): 固化/移除/清空; 弹层手改不入账 */}
        {tempWriteLog.length > 0 && (
          <div className='mt-10px b-t-1px b-gate-border b-t-solid pt-8px'>
            <div className='mb-4px flex items-center justify-between'>
              <span className='text-12px font-bold' style={{ color: token.colorWarning }}>
                临时名单 (来自右键 · 本会话) {tempWriteLog.length} 条
              </span>
              <Popconfirm
                title='清空临时名单? (只清右键临时档, 你手调的编辑不动)'
                okText='清空'
                cancelText='取消'
                getPopupContainer={getInnerPopupContainer}
                onConfirm={() => {
                  clearTagRecTempWrites(scope)
                  dirtyRef.current = true
                }}
              >
                <Button size='small'>清空临时</Button>
              </Popconfirm>
            </div>
            <div className='flex flex-col gap-y-4px'>
              {tempWriteLog.map((e, i) => (
                <div key={`${e.kind}-${i}`} className='flex flex-wrap items-center gap-x-6px'>
                  <Tag color='orange' className='mr-0' style={{ borderStyle: 'dashed' }}>
                    {e.label}
                  </Tag>
                  <Button
                    size='small'
                    disabled={!(e.owningGroupIds?.length ?? e.owningGroupNames.length)}
                    onClick={() => {
                      keepTagRecTempEntryToGroup(i, scope)
                      dirtyRef.current = true
                    }}
                  >
                    固化到本组
                    {(e.owningGroupIds?.length ?? e.owningGroupNames.length)
                      ? ` (${e.owningGroupIds?.length ?? e.owningGroupNames.length})`
                      : ' (无认领组)'}
                  </Button>
                  <Button
                    size='small'
                    disabled={!canKeepTempEntryToGlobal(e.kind)}
                    onClick={() => {
                      void keepTagRecTempEntryToGlobal(i, scope).then(() => {
                        if (getRevision() === scopeRevision) dirtyRef.current = true
                      })
                    }}
                  >
                    固化到「标签过滤」
                  </Button>
                  <Button
                    size='small'
                    onClick={() => {
                      removeTagRecTempWriteAt(i, scope)
                      dirtyRef.current = true
                    }}
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
            <Typography.Text type='secondary' className='mt-4px block text-11px'>
              固化到本组 = 写入卡片认领组 (写入时记账; 永不走草稿组); 目标组已删/值已存在 =&gt; 跳过计数
            </Typography.Text>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      afterOpenChange={(next) => {
        if (next) scrollRef.current?.scrollTo({ top: 0 })
      }}
      trigger='click'
      arrow={false}
      placement='bottomLeft'
      getPopupContainer={getPopupContainer}
      styles={{ container: { border: `1px solid ${borderColor}` } }}
      content={content}
    >
      <Button size='small'>
        过滤
        {filterOverride && (
          <Tag color='orange' className='mr-0'>
            覆盖中
          </Tag>
        )}
      </Button>
    </Popover>
  )
}
// #endregion
