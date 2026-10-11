import { Input, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import toast from '$utility/toast'
import {
  buildCandidateRows,
  mergeCandidateRows,
  normalizeTagName,
  resolveAnchor,
  resolveCandidateRows,
  runPhase2Round,
  type CandidateRow,
} from '../model/resolve'
import { sediment } from '../store'
import { TagRecCandidatePickList } from './candidate-list'
import type { TagIdEntry } from '../model/types'

type ResolvePhase = 'idle' | 'resolving' | 'mining' | 'done' | 'error'

/** 独立解析候选, 不读写主查询的草稿组、选定组或扩选暂存。 */
export function CandidateResolvePicker({
  confirmLabel,
  onConfirm,
  disabled = false,
  confirmIdInput = true,
  mineIdInput = false,
  existingTagIds = [],
  existingLabel,
}: {
  confirmLabel: string
  onConfirm: (entries: TagIdEntry[]) => void
  disabled?: boolean
  /** 收藏表保留数字直入; 过滤名单即使输入 id 也须勾选确认。 */
  confirmIdInput?: boolean
  /** 扩选入口以数字 ID 反查的标签名继续发现共现词。 */
  mineIdInput?: boolean
  existingTagIds?: readonly number[]
  existingLabel?: string
}) {
  const [draft, setDraft] = useState('')
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [phase, setPhase] = useState<ResolvePhase>('idle')
  const [confirmBusy, setConfirmBusy] = useState(false)
  const runningRef = useRef(false)
  const versionRef = useRef(0)
  const controllerRef = useRef<AbortController>(undefined)
  const disabledRef = useRef(disabled)
  const onConfirmRef = useRef(onConfirm)
  disabledRef.current = disabled
  onConfirmRef.current = onConfirm

  useEffect(() => {
    if (!disabled) return
    versionRef.current++
    controllerRef.current?.abort()
    runningRef.current = false
    setConfirmBusy(false)
    setPhase((prev) => (prev === 'resolving' || prev === 'mining' ? 'idle' : prev))
  }, [disabled])

  useEffect(
    () => () => {
      versionRef.current++
      controllerRef.current?.abort()
    },
    [],
  )

  const run = async (value: string) => {
    const input = value.trim()
    if (!input || disabled || runningRef.current || confirmBusy) return
    runningRef.current = true
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const version = ++versionRef.current
    const current = () => version === versionRef.current && !controller.signal.aborted && !disabledRef.current
    setRows([])
    setPhase('resolving')
    try {
      const { anchor, isIdPath } = await resolveAnchor(input, controller.signal)
      if (!current()) return
      if (!anchor) {
        toast(`未能解析标签「${input}」`)
        setPhase('error')
        return
      }
      if (isIdPath && confirmIdInput) {
        onConfirmRef.current([{ id: anchor.id, name: anchor.name }])
        setPhase('idle')
        return
      }
      const keyword = isIdPath ? anchor.name : input
      const inputNorm = normalizeTagName(keyword)
      setRows(buildCandidateRows({ anchor, variantEntries: [], aliases: [], suggest: [], inputNorm }))
      if (isIdPath && !mineIdInput) {
        setPhase('done')
        return
      }
      setPhase('mining')
      const res = await runPhase2Round({
        keyword,
        inputNorm,
        anchor,
        fromPage: 1,
        withSuggest: true,
        signal: controller.signal,
      })
      if (!current()) return
      setRows((prev) => mergeCandidateRows(prev, res.newCandidates))
      setPhase(res.allPagesFailed ? 'error' : 'done')
      sediment.merge(inputNorm, res.analysis.cliques)
    } catch {
      if (current()) {
        setPhase('error')
        toast('标签解析失败, 可重试')
      }
    } finally {
      if (version === versionRef.current) runningRef.current = false
    }
  }

  const busy = phase === 'resolving' || phase === 'mining'
  const existing = new Set(existingTagIds)
  const displayRows = rows.map((row) =>
    row.tag_id !== undefined && existing.has(row.tag_id) ? { ...row, expanded: true } : row,
  )
  const statusText =
    phase === 'mining'
      ? '正在查询视频共现标签…'
      : phase === 'done'
        ? '已就绪, 勾选后确认'
        : phase === 'error'
          ? '解析未完成, 已有标签仍可确认或重新解析'
          : undefined

  return (
    <div className='mb-6px min-w-0 w-full'>
      <Input.Search
        size='small'
        className='max-w-full w-240px'
        placeholder='标签名, 或纯数字 tag_id'
        enterButton='解析'
        allowClear
        value={draft}
        loading={busy}
        disabled={disabled || busy || confirmBusy}
        onChange={(e) => setDraft(e.target.value)}
        onSearch={(value) => void run(value)}
      />
      {!!rows.length && (
        <TagRecCandidatePickList
          rows={displayRows}
          expandedLabel={existingLabel}
          onToggleRow={(key, checked) => {
            if (disabled || confirmBusy) return
            setRows((prev) => prev.map((r) => (r.key === key ? { ...r, checked } : r)))
            const target = rows.find((r) => r.key === key)
            if (!checked || !target || target.tag_id !== undefined || target.resolving) return
            const version = versionRef.current
            setRows((prev) => prev.map((r) => (r.key === key ? { ...r, resolving: true } : r)))
            void resolveCandidateRows([{ ...target, checked }], controllerRef.current?.signal)
              .catch(() => undefined)
              .then((resolved) => {
                if (version !== versionRef.current || disabledRef.current) return
                const result = resolved?.[0]
                setRows((prev) =>
                  prev.map((r) =>
                    r.key === key
                      ? {
                          ...r,
                          resolving: false,
                          tag_id: result?.tag_id,
                          tag_name: result?.tag_name ?? r.tag_name,
                          use: result?.use,
                          resolveFailed: result?.resolveFailed ?? true,
                        }
                      : r,
                  ),
                )
              })
          }}
          confirmLabel={confirmLabel}
          busy={busy || confirmBusy || disabled}
          statusText={statusText}
          onConfirm={(picked) => {
            if (disabled || runningRef.current || confirmBusy) return
            const version = versionRef.current
            setConfirmBusy(true)
            void resolveCandidateRows(picked, controllerRef.current?.signal)
              .then((resolved) => {
                if (version !== versionRef.current || disabledRef.current) return
                setRows((prev) => prev.map((r) => resolved.find((x) => x.key === r.key) ?? r))
                const ok = [
                  ...new Map(resolved.filter((r) => r.tag_id !== undefined).map((r) => [r.tag_id!, r])).values(),
                ]
                const failed = resolved.filter((r) => r.tag_id === undefined).length
                if (failed) toast(`${failed} 个标签解析失败, 可重试`)
                if (!ok.length) return
                for (const r of ok) sediment.confirm(normalizeTagName(r.tag_name))
                onConfirmRef.current(ok.map((r) => ({ id: r.tag_id!, name: r.tag_name })))
              })
              .catch(() => {
                if (version === versionRef.current && !disabledRef.current) toast('标签解析失败, 可重试')
              })
              .finally(() => {
                if (version === versionRef.current) setConfirmBusy(false)
              })
          }}
        />
      )}
      {!rows.length && statusText && (
        <Typography.Text type='secondary' className='mt-4px block text-12px'>
          {statusText}
        </Typography.Text>
      )}
    </div>
  )
}
