import { Button, Checkbox, Input, InputNumber, Modal, Progress, Table, Tag, Typography } from 'antd'
import { pLimit } from 'promise.map'
import { useEffect, useMemo, useRef, useState } from 'react'
import toast from '$utility/toast'
import { tagRecBackoff } from '../api/backoff'
import { fetchTagInfoById, fetchTagInfoByName } from '../api/endpoints'
import {
  applyCsvRowResolution,
  checkCsvRowConflict,
  planCsvImport,
  resetCsvRowForRetry,
  type CsvImportRow,
} from '../model/import-export'
import { favorites } from '../store'
import type { ColumnsType } from 'antd/es/table'

/** 自动解析窗口: 每批行数 (批间检查退避闸) */
const RESOLVE_WINDOW_ROWS = 20
/** 自动阶段 id 解析总量上限: 一行 20 个不同 id => 仅前两批自动跑 (40 行), 第 3 批起待手动续批 */
const AUTO_RESOLVE_ID_BUDGET = 400

/**
 * [tag-rec] CSV 勾选导入 modal (spec §6.2 入方向)
 * - 列表长+进度条 => 独立 antd Modal, 不塞 pane
 * - 工具栏: 全选 / 全不选 / 勾选 use≥N 阈值快捷勾选 / use 排序 toggle / 解析剩余行
 * - 列: [✓] 原始名 | 解析名 | tag_id | use | 来源徽标 | 状态 (✓ / 待解析 / 与组X冲突)
 * - 导入瞬间解析: 每行经 pLimit(5) 过 tag/info —— 名称列 fetchTagInfoByName,
 *   tag_id 列已给跳名解析但仍 fetchTagInfoById 逐个反查名填快照;
 *   待解析行可改原始名重试或 tag_id 列直填 (数字直输延伸)
 * - 并发裁量: spec 5 并发为行级流水线; 实际 HTTP 仍受 anonGetJson 内 tagRecLimit(4) 共享闸约束
 * - 审计 §2: 打开预览不再无界全量反查 —— 自动解析按 RESOLVE_WINDOW_ROWS 分批,
 *   批间遇风控退避整批暂停 (进度保留); 自动阶段总 id 量封顶 AUTO_RESOLVE_ID_BUDGET,
 *   超出的行保留待解析, 由「解析剩余行」手动续批
 * - 不勾不进表; 「与组X重复」为信息徽标不拦截 (票 14 跨组重复合法), planCsvImport overlaps 上报
 */
export function CsvImportModal({
  open,
  initialRows,
  onClose,
}: {
  open: boolean
  /** 已解析的导入行 (pane 侧 chooseFile => parseCsvText => csvRecordsToImportRows); open 时拷贝入本地态 */
  initialRows: CsvImportRow[] | undefined
  onClose: () => void
}) {
  const [rows, setRows] = useState<CsvImportRow[]>([])
  const [doneCount, setDoneCount] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [sortByUseDesc, setSortByUseDesc] = useState(false)
  const [useThreshold, setUseThreshold] = useState<number>(1000)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const limit = useMemo(() => pLimit(5), [])

  /** 行级窗口: 每批窗口之间检查退避闸, 退避期整批暂停等恢复 (不往风控期再压流量) */
  const runResolve = async (list: CsvImportRow[], signal: AbortSignal, idBudget: number) => {
    let spent = 0
    for (let i = 0; i < list.length && !signal.aborted; i += RESOLVE_WINDOW_ROWS) {
      while (tagRecBackoff.isEngaged && !signal.aborted) await new Promise((r) => setTimeout(r, 500))
      if (signal.aborted) return
      // 窗口级合批: 逐行 putRow 是 行数×全表拷贝 + 逐次重渲 —— 每窗落定一次 setRows
      const resolved = new Map<string, CsvImportRow>()
      await Promise.all(
        list.slice(i, i + RESOLVE_WINDOW_ROWS).map((r) =>
          limit(async () => {
            const cost = r.tagIds.length || 1 // 行内 id 逐个反查: 成本 = id 数; 纯名行 = 1
            if (signal.aborted || spent + cost > idBudget) return
            spent += cost
            patchRow(r.key, { status: 'resolving' })
            const next = await resolveOne(r, signal)
            if (signal.aborted) return
            resolved.set(r.key, next)
          }),
        ),
      )
      if (resolved.size) {
        setRows((prev) => prev.map((r) => resolved.get(r.key) ?? r))
        setDoneCount((c) => c + resolved.size)
      }
    }
  }

  const patchRow = (key: string, patch: Partial<CsvImportRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const putRow = (next: CsvImportRow) => setRows((prev) => prev.map((r) => (r.key === next.key ? next : r)))

  /** 单行解析: id 列有值 => 逐个 ById 反查名; 否则 (纯数字原始名按逃生口) ByName; 落定后查冲突 */
  const resolveOne = async (r: CsvImportRow, signal: AbortSignal): Promise<CsvImportRow> => {
    try {
      let infos
      if (r.tagIds.length) {
        infos = await Promise.all(r.tagIds.map((id) => fetchTagInfoById(id, signal).catch(() => undefined)))
      } else if (/^\d+$/.test(r.rawName.trim())) {
        infos = [await fetchTagInfoById(Number(r.rawName.trim()), signal).catch(() => undefined)]
      } else {
        infos = [await fetchTagInfoByName(r.rawName, signal).catch(() => undefined)]
      }
      if (signal.aborted) return r
      let next = applyCsvRowResolution(r, infos)
      if (next.status === 'resolved') next = checkCsvRowConflict(next, favorites.list)
      return next
    } catch {
      return { ...r, status: 'pending', checked: false }
    }
  }

  /** 「导入瞬间解析」: 打开即跑, 行级 pLimit(5), 进度条记 doneCount; 总量超预算截停待手动续批 */
  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const init = (initialRows ?? []).map((r) => ({ ...r }))
    setRows(init)
    setDoneCount(0)
    setSortByUseDesc(false)
    setResolving(true)
    void runResolve(init, ctrl.signal, AUTO_RESOLVE_ID_BUDGET).then(() => {
      if (!ctrl.signal.aborted) setResolving(false)
    })
    return () => ctrl.abort()
  }, [open, initialRows])

  /** 「解析剩余行」: 预算截停/失败行手动续批 —— 用户动作不受自动预算限制, 仍走窗口与退避暂停 */
  const resolveRemaining = () => {
    if (resolving) return
    const rest = rows.filter((r) => r.status === 'ready' || r.status === 'pending')
    if (!rest.length) return
    const signal = abortRef.current?.signal ?? new AbortController().signal
    setResolving(true)
    void runResolve(rest, signal, Infinity).then(() => {
      if (!signal.aborted) setResolving(false)
    })
  }

  /** 待解析行重试: 改过的原始名/直填 tag_id 已在行上, 清产物重跑单行 */
  const retryRow = async (key: string) => {
    const r = rows.find((x) => x.key === key)
    if (!r || r.status === 'resolving') return
    const fresh = { ...resetCsvRowForRetry(r), status: 'resolving' as const }
    putRow(fresh)
    const signal = abortRef.current?.signal ?? new AbortController().signal
    // [tag-rec] AUDIT-40: 重试同走 pLimit(5) 闸 —— 直 await resolveOne 连点时瞬时并发超设计;
    //   abort 后不回写 (同批量路径的 ctrl.signal.aborted 守门)
    const next = await limit(() => resolveOne(fresh, signal))
    if (!signal.aborted) putRow(next)
  }

  // #region 工具栏批量勾选 (可勾行 = resolved 或「与组X重复」徽标行 —— 重复不拦截照常可勾, 票 14)
  const checkable = (r: CsvImportRow) => r.status === 'resolved' || r.status === 'conflict'
  const setAllChecked = (checked: boolean) => setRows((prev) => prev.map((r) => (checkable(r) ? { ...r, checked } : r)))
  const checkByThreshold = () =>
    setRows((prev) => prev.map((r) => (checkable(r) ? { ...r, checked: (r.use ?? 0) >= useThreshold } : r)))
  // #endregion

  const displayRows = sortByUseDesc
    ? [...rows].sort((a, b) => (b.use ?? -1) - (a.use ?? -1) || a.index - b.index)
    : rows
  const checkedCount = rows.filter((r) => r.checked && checkable(r)).length
  const pendingCount = rows.filter((r) => r.status === 'pending').length
  /** 待解析 = 从未触及 (ready) + 失败待重试 (pending) —— 「解析剩余行」按钮的供给面 */
  const unresolvedCount = rows.filter((r) => r.status === 'ready' || r.status === 'pending').length

  /** 确认导入: planCsvImport 仅勾选行入表; 重叠为信息上报不拦截 (票 14) */
  const doImport = () => {
    const plan = planCsvImport(rows, favorites.list)
    if (plan.toAdd.length) {
      // 批量场景走 addGroups (免 addGroup 逐行 toast); 「无裸奔 L2」auto-wrap 不变式同守 (票 17)
      favorites.addGroups(plan.toAdd)
    }
    const overlapMsg = plan.overlaps.length ? `, 其中 ${plan.overlaps.length} 行与既有组标签重复` : ''
    toast(`已导入 ${plan.toAdd.length} 个标签组${overlapMsg}`, 4000)
    onClose()
  }

  const statusOf = (r: CsvImportRow) => {
    switch (r.status) {
      case 'resolved':
        return <Tag color='success'>✓</Tag>
      case 'conflict':
        return <Tag color='warning'>与组「{r.conflictGroupName}」重复</Tag>
      case 'resolving':
        return <Tag color='processing'>解析中…</Tag>
      case 'pending':
        return (
          <span className='inline-flex items-center gap-x-4px'>
            <Tag color='warning'>待解析</Tag>
            <Button size='small' type='link' className='h-auto px-0 text-12px' onClick={() => retryRow(r.key)}>
              重试
            </Button>
          </span>
        )
      default:
        return <Tag>排队中</Tag>
    }
  }

  const columns: ColumnsType<CsvImportRow> = [
    {
      key: 'check',
      width: 34,
      render: (_, r) => (
        <Checkbox
          checked={r.checked}
          disabled={!checkable(r)}
          onChange={(e) => patchRow(r.key, { checked: e.target.checked })}
        />
      ),
    },
    {
      key: 'rawName',
      title: '原始名',
      render: (_, r) =>
        r.status === 'pending' ? (
          <Input
            size='small'
            value={r.rawName}
            placeholder='改标签名后重试'
            onChange={(e) => patchRow(r.key, { rawName: e.target.value })}
            onPressEnter={() => retryRow(r.key)}
          />
        ) : (
          r.rawName || <Typography.Text type='secondary'>-</Typography.Text>
        ),
    },
    {
      key: 'resolved',
      title: '解析名',
      render: (_, r) =>
        r.resolvedEntries.length ? (
          r.resolvedEntries.map((e) => e.name).join(';')
        ) : (
          <Typography.Text type='secondary'>-</Typography.Text>
        ),
    },
    {
      key: 'tag_id',
      title: 'tag_id',
      width: 140,
      render: (_, r) =>
        r.status === 'pending' ? (
          <InputNumber
            size='small'
            className='w-120px'
            min={1}
            controls={false}
            value={r.tagIds.length === 1 ? r.tagIds[0] : undefined}
            placeholder='直填 id'
            onChange={(v) => patchRow(r.key, { tagIds: v ? [v] : [] })}
            onPressEnter={() => retryRow(r.key)}
          />
        ) : (
          r.tagIds.join(';') || <Typography.Text type='secondary'>-</Typography.Text>
        ),
    },
    {
      key: 'use',
      title: 'use',
      width: 80,
      align: 'right',
      render: (_, r) => (r.use === undefined ? '-' : r.use.toLocaleString()),
    },
    {
      key: 'source',
      title: '来源',
      width: 90,
      render: (_, r) => (r.source === 'id-column' ? <Tag>id 列</Tag> : <Tag color='green'>名解析</Tag>),
    },
    {
      key: 'status',
      title: '状态',
      width: 170,
      render: (_, r) => statusOf(r),
    },
  ]

  const total = rows.length
  const percent = total ? Math.round((doneCount / total) * 100) : 0

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title='导入 CSV 标签名单'
      width={860}
      maskClosable={false}
      footer={
        <div className='flex items-center'>
          <Typography.Text type='secondary' className='text-12px'>
            每行 = 一个标签组; 勾选 {checkedCount} / {total} 行{pendingCount ? ` · ${pendingCount} 行待解析` : ''}
          </Typography.Text>
          <div className='flex-1' />
          <Button onClick={onClose}>取消</Button>
          <Button type='primary' disabled={!checkedCount} onClick={doImport}>
            导入{checkedCount ? ` (${checkedCount})` : ''}
          </Button>
        </div>
      }
    >
      <div className='mb-8px flex flex-wrap items-center gap-x-8px gap-y-1'>
        <Button size='small' onClick={() => setAllChecked(true)}>
          全选
        </Button>
        <Button size='small' onClick={() => setAllChecked(false)}>
          全不选
        </Button>
        <Typography.Text type='secondary'>勾选 use ≥</Typography.Text>
        <InputNumber
          size='small'
          className='w-110px'
          min={0}
          value={useThreshold}
          onChange={(v) => setUseThreshold(v ?? 0)}
        />
        <Button size='small' onClick={checkByThreshold}>
          勾选
        </Button>
        <Button size='small' type={sortByUseDesc ? 'primary' : 'default'} onClick={() => setSortByUseDesc((v) => !v)}>
          按 use 排序
        </Button>
        <Button size='small' onClick={resolveRemaining} disabled={resolving || !unresolvedCount}>
          解析剩余行{unresolvedCount ? ` (${unresolvedCount})` : ''}
        </Button>
      </div>

      {(resolving || doneCount < total) && (
        <div className='mb-8px flex items-center gap-x-8px'>
          <Progress className='flex-1' percent={percent} size='small' />
          <Typography.Text type='secondary' className='text-12px'>
            {doneCount}/{total}
          </Typography.Text>
        </div>
      )}

      <Table<CsvImportRow>
        size='small'
        rowKey='key'
        columns={columns}
        dataSource={displayRows}
        pagination={false}
        // [tag-rec] perf: 数百行解析期逐行 setRows => 每次全表重渲; 虚拟滚动只渲可视窗
        virtual
        scroll={{ x: 820, y: 380 }}
        locale={{ emptyText: '无可导入行' }}
      />
    </Modal>
  )
}
