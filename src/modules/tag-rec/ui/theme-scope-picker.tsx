import { Button, Checkbox, Input, Popover, Tag, Typography, type InputRef } from 'antd'
import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Virtuoso, type SizeFunction } from 'react-virtuoso'
import { useSnapshot } from 'valtio'
import { videoSourceTabState } from '$components/RecHeader/tab'
import { ETab } from '$enums'
import { hasTagRecCombination } from '../model/combination'
import { buildTagQueryPlan, tagPeekPickedCount, tagPeekRows, toggleTagSelection } from '../model/tag-peek'
import {
  createTagRecGroupScopeDraft,
  materializeTagRecGroupScopeDraft,
  type TagRecThemeScopeDraft,
} from '../model/theme-scope-draft'
import { buildTagRecScopeIndex, buildTagRecScopeRows } from '../model/theme-scope-tree'
import { tagRecViewBucketOf } from '../model/view-scope'
import { favorites, favoritesL1, favoritesL1Store, favoritesStore, themesStore, viewScopeStore } from '../store'
import { beginTagRecCustomQuery, pushExpandedIds, tagRecSharedSession } from '../store/session'
import type { TagGroup, TagIdEntry, TagL1Group } from '../model/types'

type CheckboxState = { checked: boolean; indeterminate: boolean; count: number; total: number }
// Popover 的缩放动画不改变布局尺寸，不能把动画中的零高度写入列表测量。
const scopeItemSize: SizeFunction = (element, dimension) => element[dimension]

/** 草稿在离开后一次应用；只有保存按钮写入收藏表开关。 */
export const TagRecThemeScopePicker = memo(function TagRecThemeScopePicker({
  onChanged,
  getPopupContainer,
}: {
  onChanged: () => void
  getPopupContainer?: () => HTMLElement
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [focusBucket, setFocusBucket] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** 二级组行内「标签 chips」展开位（只影响本面板渲染，不写任何 scope） */
  const [tagPeek, setTagPeek] = useState<ReadonlySet<string>>(new Set())
  /** 选中的标签（可跨组）：点「只看选中的 N 个标签」=> 首个当锚点、其余进扩选位，切 tab2 查询 */
  const [pickedTags, setPickedTags] = useState<readonly TagIdEntry[]>([])
  const [draft, setDraft] = useState<TagRecThemeScopeDraft>()
  const [history, setHistory] = useState<TagRecThemeScopeDraft[]>([])
  const [message, setMessage] = useState('')
  const draftRef = useRef<TagRecThemeScopeDraft | undefined>(undefined)
  const baselineRef = useRef<TagRecThemeScopeDraft | undefined>(undefined)
  const openRef = useRef(false)
  const inputRef = useRef<InputRef>(null)

  const { scope, groupScope } = useSnapshot(viewScopeStore)
  const { list: l1List } = useSnapshot(favoritesL1Store)
  const { list } = useSnapshot(favoritesStore)
  const { list: themeList } = useSnapshot(themesStore)
  const { tempEnabledL1Ids, tempEnabledGroupIds } = useSnapshot(tagRecSharedSession)
  const l1s = l1List as TagL1Group[]
  const groups = list as TagGroup[]
  const index = useMemo(() => buildTagRecScopeIndex(groups, l1s, themeList), [groups, l1s, themeList])
  const { themeIds, buckets, l1ById, l1sOf, childrenOf, selectable, available, groupsOfBucket, savedSelection } = index
  const committed = useMemo(
    () => createTagRecGroupScopeDraft(groups, l1s, themeIds, scope, groupScope, tempEnabledL1Ids, tempEnabledGroupIds),
    [groups, l1s, themeIds, scope, groupScope, tempEnabledL1Ids, tempEnabledGroupIds],
  )
  const selected = draft ?? committed
  const selectedOf = (g: TagGroup) => selected[g.id] ?? committed[g.id] ?? false
  const checkboxStates = new Map<readonly TagGroup[], CheckboxState>()
  const stateOf = (items: readonly TagGroup[]): CheckboxState => {
    const cached = checkboxStates.get(items)
    if (cached) return cached
    const eligible = items.filter(selectable)
    const count = eligible.filter(selectedOf).length
    const state = {
      checked: eligible.length > 0 && count === eligible.length,
      indeterminate: count > 0 && count < eligible.length,
      count,
      total: eligible.length,
    }
    checkboxStates.set(items, state)
    return state
  }
  const focus = buckets.find((b) => b.id === focusBucket) ?? buckets[0]
  const chosen = available.filter(selectedOf)
  const chosenParentIds = new Set(chosen.map((g) => g.l1Id))
  const chosenParents = l1s.filter((l) => chosenParentIds.has(l.id))
  const chosenThemes = buckets.filter((b) => chosenParents.some((l) => tagRecViewBucketOf(l, themeIds) === b.id))
  // 触发器读已提交范围，挑选草稿时不提前改变推荐说明。
  const summary = useMemo(() => {
    if (groups.every((g) => committed[g.id] === savedSelection[g.id])) return '主题：当前启用'
    const committedChosen = available.filter((g) => committed[g.id])
    const parentIds = new Set(committedChosen.map((g) => g.l1Id))
    const parents = l1s.filter((l) => parentIds.has(l.id))
    return committedChosen.length === 1
      ? '只看：' + committedChosen[0].name
      : parents.length === 1
        ? '只看：' + parents[0].name
        : parents.length
          ? '主题：自选 ' + parents.length + ' 个一级组'
          : '主题：未选'
  }, [groups, l1s, available, committed, savedSelection])
  const q = query.trim().toLowerCase()
  const matches = (name: string) => name.toLowerCase().includes(q)
  const rows = useMemo(
    () => (open ? buildTagRecScopeRows(index, focus.id, expanded, q) : []),
    [open, index, focus.id, expanded, q],
  )
  const pending = !!draft && groups.some((g) => selectedOf(g) !== baselineRef.current?.[g.id])
  const persistCount =
    groups.filter((g) => selectable(g) && selectedOf(g) !== g.enabled).length +
    l1s.filter((l) => childrenOf(l.id).some(selectable) && childrenOf(l.id).some(selectedOf) !== l.enabled).length

  useEffect(
    () => () => {
      tagRecSharedSession.scopeEditing = false
    },
    [],
  )
  const setSelection = (next: TagRecThemeScopeDraft) => {
    const previous = draftRef.current ?? committed
    if (groups.every((g) => previous[g.id] === next[g.id])) return
    setHistory((h) => [...h.slice(-49), previous])
    draftRef.current = next
    setDraft(next)
    setMessage('')
  }
  const toggle = (items: readonly TagGroup[], on: boolean) => {
    const next = { ...(draftRef.current ?? committed) }
    for (const g of items.filter(selectable)) next[g.id] = on
    const parent = q && l1ById.get(items[0]?.l1Id ?? '')
    if (parent) {
      setFocusBucket(tagRecViewBucketOf(parent, themeIds))
      setExpanded((prev) => new Set([...prev, parent.id]))
    }
    setSelection(next)
  }
  const only = (items: readonly TagGroup[]) => {
    const ids = new Set(items.filter(selectable).map((g) => g.id))
    const parent = q && l1ById.get(items[0]?.l1Id ?? '')
    if (parent) {
      setFocusBucket(tagRecViewBucketOf(parent, themeIds))
      setExpanded(new Set([parent.id]))
    }
    setSelection(Object.fromEntries(groups.map((g) => [g.id, ids.has(g.id)])))
  }
  /** 标签 chip 选中态切换（跨组累积） */
  const togglePickedTag = (e: TagIdEntry) => setPickedTags((prev) => toggleTagSelection(prev, e))
  /**
   * 「只看选中的 N 个标签」：这不是缩小查看范围（view-scope 粒度是二级组），而是**换查询单元**——
   * 复用 tab2 现成语义：首个标签当锚点（传名，走文本解析全管线，同 🏷 弹层 #id 口径），
   * 其余进扩选暂存位。会话级、用完即弃，不写收藏表、不落长期画像。
   */
  const onlyPickedTags = () => {
    const plan = buildTagQueryPlan(pickedTags)
    if (!plan) return
    beginTagRecCustomQuery(plan.anchor.name)
    if (plan.expanded.length) pushExpandedIds(plan.expanded)
    setPickedTags([])
    commit()
    videoSourceTabState.value = ETab.TagRecCustom
  }
  const commit = () => {
    if (!openRef.current) return
    openRef.current = false
    const next = draftRef.current
    let changed = false
    if (next) {
      const applied = materializeTagRecGroupScopeDraft(
        next,
        favoritesStore.list,
        favoritesL1Store.list,
        new Set(themesStore.list.map((t) => t.id)),
      )
      changed = favoritesStore.list.some((g) => next[g.id] !== baselineRef.current?.[g.id])
      viewScopeStore.scope = applied.scope
      viewScopeStore.groupScope = applied.groupScope
      tagRecSharedSession.tempEnabledL1Ids = applied.temporary
      tagRecSharedSession.tempEnabledGroupIds = applied.temporaryGroups
    }
    tagRecSharedSession.scopeEditing = false
    draftRef.current = undefined
    setDraft(undefined)
    setOpen(false)
    if (changed) onChanged()
  }
  const escape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (query) setQuery('')
    else commit()
  })
  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', escape, { capture: true })
    return () => document.removeEventListener('keydown', escape, true)
  }, [open])
  const onOpenChange = (value: boolean) => {
    if (!value) return commit()
    const initial = createTagRecGroupScopeDraft(
      favoritesStore.list,
      favoritesL1Store.list,
      new Set(themesStore.list.map((t) => t.id)),
      viewScopeStore.scope,
      viewScopeStore.groupScope,
      tagRecSharedSession.tempEnabledL1Ids,
      tagRecSharedSession.tempEnabledGroupIds,
    )
    baselineRef.current = initial
    draftRef.current = initial
    setDraft(initial)
    setHistory([])
    setMessage('')
    setQuery('')
    setExpanded(
      new Set(
        l1sOf(focus.id)
          .slice(0, 1)
          .map((l) => l.id),
      ),
    )
    openRef.current = true
    tagRecSharedSession.scopeEditing = true
    setOpen(true)
  }
  const persist = () => {
    const next = draftRef.current ?? committed
    // 子开关先保存；父开关再保存并清除该子树临时覆盖。
    for (const g of favoritesStore.list) {
      if (selectable(g) && next[g.id] !== g.enabled) favorites.updateGroup(g.id, { enabled: !!next[g.id] })
    }
    for (const l of favoritesL1Store.list) {
      const kids = childrenOf(l.id)
      if (!kids.some(selectable)) continue
      const on = kids.some((g) => next[g.id])
      if (on !== l.enabled) favoritesL1.updateL1(l.id, { enabled: on })
    }
    viewScopeStore.scope = {}
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledL1Ids = []
    tagRecSharedSession.tempEnabledGroupIds = []
    setHistory([])
    setMessage('已保存到收藏表，下次沿用')
  }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    draftRef.current = previous
    setDraft(previous)
    setHistory((h) => h.slice(0, -1))
    setMessage('')
  }
  const highlight = (name: string) => {
    const index = q ? name.toLowerCase().indexOf(q) : -1
    return index < 0 ? (
      name
    ) : (
      <>
        {name.slice(0, index)}
        <mark
          className='rounded-2px color-gate-primary'
          style={{ background: 'color-mix(in oklab, var(--bilibili-gate--primary-color) 12%, transparent)' }}
        >
          {name.slice(index, index + q.length)}
        </mark>
        {name.slice(index + q.length)}
      </>
    )
  }
  const checkbox = (label: string, items: readonly TagGroup[]) => {
    const st = stateOf(items)
    return (
      <Checkbox
        aria-label={label}
        checked={st.checked}
        indeterminate={st.indeterminate}
        disabled={!st.total}
        onChange={(e) => toggle(items, e.target.checked)}
      />
    )
  }
  const themeRow = (b: { id: string; name: string }) => {
    const items = groupsOfBucket(b.id)
    const st = stateOf(items)
    return (
      <div
        key={b.id}
        className={
          'flex items-center gap-6px rounded-6px px-6px py-7px ' +
          (focus.id === b.id && !q ? 'bg-gate-bg-lv2' : 'hover:bg-gate-bg-lv1')
        }
      >
        {checkbox('观看主题：' + b.name, items)}
        <button
          type='button'
          className='min-w-0 flex-1 border-0 bg-transparent p-0 text-left text-12px text-gate-text'
          onClick={() => {
            setFocusBucket(b.id)
            setQuery('')
            setExpanded(
              new Set(
                l1sOf(b.id)
                  .slice(0, 1)
                  .map((l) => l.id),
              ),
            )
          }}
        >
          {highlight(b.name)}
        </button>
        <span className='text-10px opacity-60'>{l1sOf(b.id).length}</span>
        <Button
          size='small'
          type='text'
          className='px-3px color-gate-primary'
          disabled={!st.total}
          onClick={() => {
            const active = items.filter((g) => committed[g.id])
            const saved = items.filter((g) => g.enabled)
            only(active.length ? active : saved.length ? saved : items)
            setFocusBucket(b.id)
          }}
        >
          只看
        </Button>
      </div>
    )
  }
  const groupRow = (g: TagGroup, l: TagL1Group) => {
    const ready = selectable(g)
    const temporary = selectedOf(g) && (!g.enabled || !l.enabled)
    /** 搜索态下「组名没命中但组内标签命中」=> 自动展开标签行，让命中 chip 直接可见可点 */
    const autoPeek = !!q && !matches(g.name) && g.tag_ids.some((e) => matches(e.name))
    const peek = tagPeek.has(g.id) || autoPeek
    const pickedInGroup = tagPeekPickedCount(g, pickedTags)
    return (
      <div key={g.id}>
        <div className='ml-16px flex items-center gap-6px b-l-1px b-gate-border b-l-solid py-5px pl-14px pr-4px hover:bg-gate-bg-lv1'>
          <Checkbox
            aria-label={'观看二级组：' + l.name + ' › ' + g.name}
            checked={selectedOf(g)}
            disabled={!ready}
            onChange={(e) => toggle([g], e.target.checked)}
          />
          <span className='min-w-0 flex-1 break-words text-12px'>{highlight(g.name)}</span>
          {(!ready || !g.enabled || !l.enabled) && (
            <Tag className='mr-0 text-10px' color={temporary ? 'orange' : undefined}>
              {!g.tag_ids.length && !hasTagRecCombination(g.combination)
                ? '待添加标签'
                : g.weight === 0 || l.weight === 0
                  ? '挂起'
                  : temporary
                    ? '临时'
                    : !l.enabled && g.enabled
                      ? '一级组停用'
                      : '停用'}
            </Tag>
          )}
          {/* 展开组内标签：看得到、可勾选做「只看」（B1 —— 换查询单元，不动 view-scope） */}
          {!!g.tag_ids.length && (
            <Button
              size='small'
              type='text'
              className={`shrink-0 b-1px b-gate-primary rounded-3px b-solid px-6px text-11px ${
                peek || pickedInGroup
                  ? 'bg-gate-primary color-white'
                  : 'bg-gate-bg-lv1 color-gate-primary hover:(bg-gate-primary color-white)'
              }`}
              aria-expanded={peek}
              aria-label={`${peek ? '收起' : '展开'}「${g.name}」的 ${g.tag_ids.length} 个标签`}
              title={`看这组的 ${g.tag_ids.length} 个标签（可勾选做「只看」）`}
              onClick={() =>
                setTagPeek((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })
              }
            >
              🏷 {g.tag_ids.length}
              {pickedInGroup ? ` · 选${pickedInGroup}` : ''}
            </Button>
          )}
          <Button
            size='small'
            type='text'
            className='shrink-0 px-4px color-gate-primary'
            disabled={!ready}
            aria-label={'只看二级组：' + l.name + ' › ' + g.name}
            onClick={() => only([g])}
          >
            {g.enabled && l.enabled ? '只看' : '临时只看'}
          </Button>
        </div>
        {peek && (
          <div className='ml-16px flex flex-wrap items-center gap-4px py-4px pl-44px pr-4px'>
            {tagPeekRows(g, pickedTags, q).map((e) => (
              <button
                key={e.id}
                type='button'
                className={`b-1px rounded-3px b-solid px-6px py-1px text-11px ${
                  e.picked
                    ? 'b-gate-primary bg-gate-primary color-white'
                    : 'b-gate-border bg-gate-bg-lv1 hover:(b-gate-primary color-gate-primary)'
                }`}
                aria-pressed={e.picked}
                title={`${e.name} · #${e.id} —— 勾选后点底部「只看选中的标签」`}
                onClick={() => togglePickedTag({ id: e.id, name: e.name })}
              >
                {highlight(e.name)}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  const l1Row = (l: TagL1Group, contextOnly: boolean) => {
    const kids = childrenOf(l.id)
    const st = stateOf(kids)
    const isExpanded = !!q || expanded.has(l.id)
    return (
      <div key={l.id} className='pb-3px'>
        <div className='flex items-center gap-6px rounded-6px px-5px py-6px hover:bg-gate-bg-lv1'>
          {contextOnly ? (
            <span className='w-16px shrink-0 text-center text-11px opacity-50'>›</span>
          ) : (
            checkbox('观看一级组：' + l.name, kids)
          )}
          <button
            type='button'
            disabled={!!q}
            aria-label={(isExpanded ? '收起' : '展开') + '一级组：' + l.name}
            aria-expanded={isExpanded}
            className='min-w-0 flex-1 border-0 bg-transparent p-0 text-left text-13px text-gate-text'
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(l.id)) next.delete(l.id)
                else next.add(l.id)
                return next
              })
            }
          >
            <span className='mr-5px text-10px opacity-60'>{q ? '›' : isExpanded ? '▾' : '▸'}</span>
            <strong>{highlight(l.name)}</strong>
            <span className='ml-6px text-11px opacity-55'>
              {q ? '一级组 · ' : ''}
              {kids.length} 个二级组
            </span>
          </button>
          {!l.enabled && (
            <Tag className='mr-0 text-10px' color={st.count ? 'orange' : undefined}>
              {st.count ? '临时' : '停用'}
            </Tag>
          )}
          {!contextOnly && (
            <Button
              size='small'
              type='text'
              className='shrink-0 px-4px color-gate-primary'
              disabled={!st.total}
              onClick={() => {
                const enabled = kids.filter((g) => g.enabled)
                only(enabled.length ? enabled : kids)
                setExpanded(new Set([l.id]))
              }}
            >
              {l.enabled ? '只看' : '临时只看'}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger='click'
      placement='bottomLeft'
      getPopupContainer={getPopupContainer}
      destroyOnHidden
      fresh
      styles={{ container: { padding: 0 } }}
      content={
        open ? (
          <div
            style={{ width: 'min(660px, calc(100vw - 32px))', padding: 12 }}
            onMouseLeave={() => {
              if (inputRef.current?.input !== document.activeElement) commit()
            }}
            onBlur={(e) => {
              if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) commit()
            }}
          >
            <Input
              ref={inputRef}
              size='small'
              allowClear
              autoFocus
              placeholder='搜主题、一级组、二级组或标签'
              aria-label='搜索主题、一级组、二级组或标签'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className='mt-8px overflow-hidden b-t-1px b-gate-border b-t-solid'
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px, 0.32fr) minmax(0, 0.68fr)',
                height: 'min(350px, 50vh)',
              }}
            >
              <div className='overflow-y-auto b-r-1px b-gate-border b-r-solid pr-5px'>
                <div className='sticky top-0 z-1 flex items-center gap-6px bg-gate-bg-lv1 px-6px py-8px'>
                  {checkbox('全选主题', groups)}
                  <strong className='text-12px'>主题</strong>
                  <span className='ml-auto text-10px opacity-55'>
                    {chosenThemes.length}/{buckets.filter((b) => groupsOfBucket(b.id).some(selectable)).length}
                  </span>
                </div>
                {buckets.map(themeRow)}
              </div>
              <div className='min-h-0 flex flex-col pl-6px'>
                <div className='z-1 flex shrink-0 items-center gap-6px bg-gate-bg-lv1 px-6px py-8px'>
                  {!q && checkbox('全选当前主题的组', groupsOfBucket(focus.id))}
                  <strong className='text-12px'>{q ? '搜索结果' : focus.name}</strong>
                  <span className='ml-auto text-10px opacity-55'>
                    {q ? '主题 › 一级组 › 二级组 › 标签' : '展开查看二级组'}
                  </span>
                </div>
                {rows.length > 0 ? (
                  <Virtuoso
                    key={q ? `search:${q}` : focus.id}
                    data={rows}
                    style={{ flex: 1, minHeight: 0 }}
                    tabIndex={0}
                    aria-label='主题组列表'
                    defaultItemHeight={36}
                    itemSize={scopeItemSize}
                    increaseViewportBy={80}
                    computeItemKey={(_, row) => row.key}
                    itemContent={(_, row) => {
                      switch (row.kind) {
                        case 'theme':
                          return (
                            <div className='b-b-1px b-gate-border b-b-solid px-6px pb-7px pt-5px text-11px opacity-65'>
                              {highlight(row.bucket.name)} <span className='ml-4px opacity-60'>主题</span>
                            </div>
                          )
                        case 'l1':
                          return l1Row(row.l1, row.contextOnly)
                        case 'group':
                          return groupRow(row.group, row.l1)
                        case 'empty':
                          return (
                            <span className='block py-5px pl-40px text-11px opacity-55'>
                              暂无二级组 · 可在收藏表新建
                            </span>
                          )
                      }
                    }}
                  />
                ) : (
                  <Typography.Text type='secondary' className='block py-24px text-center text-12px'>
                    {q ? '无匹配结果' : '暂无一级组'}
                  </Typography.Text>
                )}
              </div>
            </div>
            {pickedTags.length > 0 && (
              <div className='mt-8px flex items-center gap-8px b-1px b-gate-primary rounded-6px b-solid px-8px py-6px'>
                <span className='min-w-0 flex-1 truncate text-11px'>
                  🏷 选中 {pickedTags.length} 个标签：
                  {pickedTags
                    .slice(0, 3)
                    .map((t) => t.name)
                    .join('、')}
                  {pickedTags.length > 3 ? ' 等' : ''}
                </span>
                <Button size='small' type='text' onClick={() => setPickedTags([])}>
                  清空
                </Button>
                <Button size='small' type='primary' title='到「标签发掘」页只看这些标签' onClick={onlyPickedTags}>
                  只看选中的标签
                </Button>
              </div>
            )}
            <div className='mt-8px flex items-center gap-8px b-t-1px b-gate-border b-t-solid pt-8px'>
              <span className='min-w-0 flex-1 text-11px opacity-65'>
                看 {chosenParents.length} 个一级组 / {chosen.length} 个二级组
              </span>
              <Button size='small' type='text' onClick={() => setSelection({ ...savedSelection })}>
                跟随收藏表
              </Button>
              <Button size='small' disabled={!history.length} onClick={undo}>
                撤销
              </Button>
              <Button
                size='small'
                type='primary'
                disabled={!persistCount}
                title='保存一级组和二级组开关，下次沿用'
                onClick={persist}
              >
                保存选择
              </Button>
            </div>
            <div role='status' aria-live='polite' className='mt-6px min-h-17px text-11px'>
              {message || (pending ? '离开面板更新推荐 · 临时选择不会改收藏表' : '勾选想看的，点「只看」只留这一项')}
              <span className='float-right opacity-55'>{q ? 'Esc 清除搜索，再按关闭' : 'Esc 关闭并应用'}</span>
            </div>
          </div>
        ) : (
          <span />
        )
      }
    >
      <button
        type='button'
        className='max-w-80vw inline-flex items-center gap-x-8px b-2px b-gate-primary rounded-8px b-solid bg-gate-bg-lv1 px-12px py-5px text-14px color-gate-primary font-600'
      >
        <span className='truncate'>{summary}</span>
        <span className='text-11px'>▾</span>
      </button>
    </Popover>
  )
})
