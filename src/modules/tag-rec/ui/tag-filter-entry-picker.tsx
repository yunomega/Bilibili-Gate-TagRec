import { Button, Input, Pagination, Select, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import toast from '$utility/toast'
import { createTagRecFavoriteTagIndex } from '../model/favorite-tag-selection'
import { normalizeTagName } from '../model/tag-norm'
import { favoritesL1Store, favoritesStore, themesStore } from '../store'
import { CandidateResolvePicker } from './candidate-resolve-picker'
import type { TagIdEntry } from '../model/types'

const CHIP_PAGE_SIZE = 24

/** 只在展开时订阅收藏并构建层级索引, Select 使用虚拟列表。 */
function FavoriteTagPicker({
  disabled,
  onConfirm,
  getPopupContainer,
}: {
  disabled: boolean
  onConfirm: (entries: TagIdEntry[]) => void
  getPopupContainer?: () => HTMLElement
}) {
  const groups = useSnapshot(favoritesStore).list
  const l1s = useSnapshot(favoritesL1Store).list
  const themes = useSnapshot(themesStore).list
  const index = useMemo(() => createTagRecFavoriteTagIndex(groups, l1s, themes), [groups, l1s, themes])
  const [selected, setSelected] = useState<string[]>([])
  const entries = useMemo(() => index.select(selected), [index, selected])
  return (
    <div className='mt-4px flex flex-col gap-y-4px'>
      <Typography.Text type='secondary' className='text-12px'>
        复制所选范围内的正向标签快照, 不解析、不带入源组配置; 后续收藏变化不会联动此名单。
      </Typography.Text>
      <Select
        mode='multiple'
        showSearch
        allowClear
        virtual
        className='w-full'
        placeholder='搜索主题 / 一级组 / 二级组'
        value={selected}
        options={index.options}
        maxTagCount='responsive'
        disabled={disabled}
        getPopupContainer={getPopupContainer}
        filterOption={(input, option) => !!option?.search.includes(normalizeTagName(input))}
        onChange={setSelected}
      />
      <Button
        size='small'
        className='self-start'
        disabled={disabled || !entries.length}
        onClick={() => {
          if (disabled) return
          onConfirm(entries)
          setSelected([])
        }}
      >
        加入名单 ({entries.length})
      </Button>
    </div>
  )
}

export function TagFilterEntryPicker({
  snapList,
  onChange,
  disabled,
  confirmLabel,
  getPopupContainer,
}: {
  snapList: readonly TagIdEntry[]
  onChange: (entries: TagIdEntry[]) => void
  disabled: boolean
  confirmLabel: string
  getPopupContainer?: () => HTMLElement
}) {
  const [open, setOpen] = useState<'resolve' | 'favorites'>()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const norm = normalizeTagName(query)
    return norm
      ? snapList.filter((tag) => normalizeTagName(tag.name).includes(norm) || String(tag.id).includes(query.trim()))
      : snapList
  }, [snapList, query])
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / CHIP_PAGE_SIZE)))
  const add = (entries: TagIdEntry[]) => {
    if (disabled) return
    const have = new Set(snapList.map((tag) => tag.id))
    const adds = entries.filter((tag) => !have.has(tag.id) && have.add(tag.id))
    if (adds.length) onChange([...snapList, ...adds.map((entry) => ({ ...entry }))])
    toast(adds.length ? `已加入 ${adds.length} 个标签` : '标签已在名单中')
  }
  return (
    <div className='mt-3px min-w-0 w-full'>
      <div className='flex flex-wrap items-center gap-x-8px gap-y-4px'>
        <span className='text-12px'>已加入 {snapList.length} 个标签</span>
        <Button
          size='small'
          type='link'
          className='h-auto px-0 text-12px'
          disabled={disabled}
          onClick={() => setOpen(open === 'resolve' ? undefined : 'resolve')}
        >
          {open === 'resolve' ? '收起解析' : '解析添加'}
        </Button>
        <Button
          size='small'
          type='link'
          className='h-auto px-0 text-12px'
          disabled={disabled}
          onClick={() => setOpen(open === 'favorites' ? undefined : 'favorites')}
        >
          {open === 'favorites' ? '收起收藏选择' : '从收藏选择'}
        </Button>
        {!!snapList.length && (
          <Button
            size='small'
            type='link'
            className='h-auto px-0 text-12px'
            disabled={disabled}
            onClick={() => {
              if (disabled) return
              onChange([])
              setQuery('')
              setPage(1)
            }}
          >
            清空名单
          </Button>
        )}
      </div>
      {(snapList.length > CHIP_PAGE_SIZE || !!query) && (
        <Input
          size='small'
          allowClear
          className='my-4px'
          placeholder='筛选已加入标签名 / ID'
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
        />
      )}
      <div className='mt-4px flex flex-wrap items-center gap-4px'>
        {filtered.slice((currentPage - 1) * CHIP_PAGE_SIZE, currentPage * CHIP_PAGE_SIZE).map((entry) => (
          <Tag
            key={entry.id}
            closable={!disabled}
            onClose={(e) => {
              e.preventDefault()
              if (!disabled) onChange(snapList.filter((tag) => tag.id !== entry.id).map((tag) => ({ ...tag })))
            }}
          >
            {entry.name || `#${entry.id}`}
          </Tag>
        ))}
      </div>
      {filtered.length > CHIP_PAGE_SIZE && (
        <Pagination
          size='small'
          current={currentPage}
          pageSize={CHIP_PAGE_SIZE}
          total={filtered.length}
          showSizeChanger={false}
          onChange={setPage}
        />
      )}
      {open === 'favorites' && (
        <FavoriteTagPicker disabled={disabled} onConfirm={add} getPopupContainer={getPopupContainer} />
      )}
      {open === 'resolve' && (
        <div className='mt-4px'>
          <Typography.Text type='secondary' className='mb-4px block text-12px'>
            任意标签 → 视频共现候选 → 勾选加入本名单; 不改变当前查询组
          </Typography.Text>
          <CandidateResolvePicker
            confirmLabel={confirmLabel}
            confirmIdInput={false}
            disabled={disabled}
            onConfirm={add}
          />
        </div>
      )}
    </div>
  )
}
