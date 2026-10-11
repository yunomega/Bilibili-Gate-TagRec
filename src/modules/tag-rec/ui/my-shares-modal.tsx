import { Alert, Button, Checkbox, Input, Modal, Select, Tabs, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { cloneDeep, isEqual } from 'es-toolkit'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { proxy } from 'valtio'
import { antModal } from '$modules/antd'
import toast from '$utility/toast'
import { fetchTagInfoById, fetchTagInfoByName } from '../api/endpoints'
import { deleteShare, getShareDetail, patchShare, TAG_REC_SHARE_SITE_BASE } from '../api/share'
import {
  applyTagRecScopeEntriesToGroupOverrides,
  applyTagRecScopeEntriesToL1Overrides,
  resolveTagRecEffective,
  stripTagRecGroupSlot,
  tagRecL1ChainGroup,
  type TagRecFilterSettings,
  type TagRecGroupOverrides,
  type TagRecL1Overrides,
  type TagRecScopeSaveEntry,
} from '../model/filter-engine'
import { normalizeTagRecFilterSettings } from '../model/import-export'
import {
  buildMyShareRows,
  buildShareEditUrl,
  buildSharePageUrl,
  buildSharePatchBody,
  buildSharePkgPayload,
  createShareFactoryFilterConfig,
  hasSharePkgGroupContent,
  normalizeShareTokenEntries,
  parseSharePkgForEdit,
  probeOutcomeToRemote,
  SHARE_GUARD_LIMITS,
  type MyShareRemote,
  type MyShareRow,
  type SharePkgEdit,
  type SharePkgGroup,
  type SharePkgL1,
  type SharePkgTheme,
  type ShareRejectItem,
  type ShareTokenMap,
} from '../model/share'
import { forgetShareToken, readShareTokens, rememberShareToken } from '../store/share-tokens'
import {
  pickTagRecScopePatch,
  TAG_REC_POOL_KEYS,
  TAG_REC_POOL_LABELS,
  TagRecScopeConfigEditor,
} from './scope-config-editor'
import { TagRecShareFilterEditor } from './share-filter-editor'
import type { TagGroup, TagL1Group, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] 「我的分享」本地记账管理 Modal (tag-share-platform spec §5 / 票 17)
 * - 数据源 = GM `tag-rec:share-tokens` 账本 (shareId → {token,title,createdAt}); 「我的分享」无服务端端点
 * - 每条操作: 打开分享页 (网站详情链接) / 改标题描述 (行内编辑 → PATCH X-Mgmt-Token) / 删除 (二次确认 → DELETE)
 * - reconcile 轻量档: 打开时对每条带 token 的账目 getShareDetail 探 status (并发 ≤3, 失败静默不阻塞);
 *   removed => 整行标灰「已下架」, 404 => 「服务端查无」标 (不存在或 token 失效且非 published 同态)
 * - 账本畸形条目 (token 缺失) => 「失权」标, 只可读 (打开分享页) 不可 PATCH/DELETE
 * - 401/403 => 「管理 token 失效」提示; PATCH 404/409 / DELETE 404 => 询问是否摘账 (forgetShareToken)
 * - 底部常显「清空插件数据将同时失去全部管理 token, 不可找回」(spec §9 GM 清空 = 管理权同失)
 * - 票31 (tag-share): focusShareId = 「更新原分享」深链位 (分享上传 dup-check 命中行入口);
 *   打开时该 shareId 在账本且持 token => 自动展开其「改包内容」编辑器定位; 查无/失权 => 只开列表
 */
export function TagRecMySharesModal({
  open,
  onClose,
  focusShareId,
}: {
  open: boolean
  onClose: () => void
  /** 票31: 定位目标 shareId (dup-check「更新原分享」传入); 缺省 = 普通开列表 */
  focusShareId?: string
}) {
  /** GM 账本原图 (undefined = 读取中); 本地操作成功后同步改此图避免整表重读 */
  const [tokenMap, setTokenMap] = useState<ShareTokenMap | undefined>(undefined)
  /** reconcile 探测表 shareId => remote (unprobed 不落表 —— 失败静默) */
  const [probes, setProbes] = useState<Readonly<Record<string, MyShareRemote>>>({})
  // 行内编辑器态 (单条展开): editId = 展开中的 shareId; descKnown = 远端描述已回填
  //   (回填成功 => 描述留空 = 显式清空; 未取到 => 留空不携键防误清, buildSharePatchBody 语义)
  const [editId, setEditId] = useState<string>()
  const [editMode, setEditMode] = useState<'text' | 'payload'>('text')
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editDescKnown, setEditDescKnown] = useState(false)
  const [editPkg, setEditPkg] = useState<SharePkgEdit | null | undefined>(undefined) // undefined=加载中 null=解析失败
  /** R6: 包内组/L1 深编弹层目标 (复用收藏夹同款 ScopeConfigEditor, 草稿写回 raw.overrides) */
  const [deepEdit, setDeepEdit] = useState<{ kind: 'group'; gi: number } | { kind: 'l1'; li: number } | null>(null)
  // W2-1: 拉取失败独立态 (与解析失败区分 —— 网络/5xx 可重试; text 模式同款早退是刻意的, payload 缺对偶落态会假死)
  const [editPkgFailed, setEditPkgFailed] = useState(false)
  /** 票26 过滤配置编辑态: cfg=归一化后 proxy 副本 (编辑面绑定); base=归一化原值
   *  (保存时 isEqual 比 cfg vs base —— 没动过就不写回, 原包内字段 (含未知键) 原样透传) */
  const [editFilter, setEditFilter] = useState<{ cfg: TagRecFilterSettings; base: TagRecFilterSettings }>()
  const [editBusy, setEditBusy] = useState(false)
  const [editIssues, setEditIssues] = useState<ShareRejectItem[]>([])
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set()) // 删除在途
  const editIdRef = useRef<string | undefined>(undefined)
  editIdRef.current = editId
  // 票31: 定位目标 shareId 的 ref 镜像 —— load effect 异步落定后读现值 (同 editIdRef 手法)
  const focusIdRef = useRef<string | undefined>(undefined)
  focusIdRef.current = focusShareId

  const rows = tokenMap === undefined ? undefined : buildMyShareRows(tokenMap, probes)
  /** 包编辑态派生: 被组引用中的 L1 id 集 (「删」按钮阻塞判据 + 与 buildSharePkgPayload 空壳裁剪同口径) */
  const editUsedL1Ids = new Set((editPkg?.groups ?? []).map((g) => g.l1Id).filter((x): x is string => !!x))

  const closeEditor = () => {
    setEditId(undefined)
    setEditIssues([])
    setEditBusy(false)
    setEditPkg(undefined)
    setEditPkgFailed(false)
    setEditFilter(undefined)
  }

  /** 本地摘账 (GM + 视图同步); 正在编辑该条 => 收起编辑器 */
  const dropRow = (shareId: string) => {
    void forgetShareToken(shareId)
    setTokenMap((prev) => {
      if (!prev || !(shareId in prev)) return prev
      const next = { ...prev }
      delete next[shareId]
      return next
    })
    setProbes((prev) => {
      if (!(shareId in prev)) return prev
      const next = { ...prev }
      delete next[shareId]
      return next
    })
    if (editIdRef.current === shareId) closeEditor()
  }

  // 打开 => 重读账本 + reconcile 探测 (并发 ≤3 自旋取数, 失败静默; 关闭 => cancelled 截断落定)
  useEffect(() => {
    if (!open) return
    setTokenMap(undefined)
    setProbes({})
    setBusyIds(new Set())
    closeEditor()
    let cancelled = false
    void (async () => {
      const map = await readShareTokens()
      if (cancelled) return
      setTokenMap(map)
      // 票31: 「更新原分享」深链定位 —— 该 shareId 在账本且持 token => 展开其「改包内容」编辑器;
      //   远端回填/解析失败兜底照旧走 openEditor 内部分支; 查无/失权 => 只开列表不扰
      const focusId = focusIdRef.current
      if (focusId) {
        const row = buildMyShareRows(map, {}).find((r) => r.shareId === focusId)
        if (row?.token) openEditor(row, 'payload')
      }
      const probees = normalizeShareTokenEntries(map).filter((e) => e.token)
      let idx = 0
      const run = async () => {
        for (;;) {
          const e = probees[idx++]
          if (!e || cancelled || !e.token) return
          const res = await getShareDetail(e.shareId, { mgmtToken: e.token })
          if (cancelled) return
          const remote = probeOutcomeToRemote(res.kind, res.kind === 'ok' ? res.detail.status : undefined)
          if (remote === 'unprobed') continue // 网络错静默 (reconcile 不阻塞列表)
          setProbes((prev) => ({ ...prev, [e.shareId]: remote }))
        }
      }
      await Promise.all([run(), run(), run()])
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  /** 行内编辑展开: 预填本地记账标题; 远端 title/description/payload best-effort 回填 (成功 => 所见即所得) */
  const openEditor = (row: MyShareRow, mode: 'text' | 'payload') => {
    setEditId(row.shareId)
    setEditMode(mode)
    setEditTitle(row.title)
    setEditDesc('')
    setEditDescKnown(false)
    setEditPkg(undefined)
    setEditPkgFailed(false)
    setEditFilter(undefined) // 票26: 防上一行 filterConfig 编辑副本串行渗漏
    setEditIssues([])
    if (!row.token) return
    void getShareDetail(row.shareId, { mgmtToken: row.token }).then((res) => {
      if (editIdRef.current !== row.shareId) return
      // W2-1: 拉取失败(超时/5xx/404)落失败态 —— 否则 editPkg 永停 undefined = 无限「加载中」+ 保存恒灰
      if (res.kind !== 'ok') {
        if (mode === 'payload') setEditPkgFailed(true)
        return
      }
      setEditTitle(res.detail.title)
      setEditDesc(res.detail.description ?? '')
      setEditDescKnown(true)
      const pkg = parseSharePkgForEdit(res.detail.payload) ?? null
      setEditPkg(pkg)
      // 票26: 包内 filterConfig 归一化后克隆+proxy 化供编辑 (畸形/缺省 => 出厂占位为底;
      //   base 留归一原值做「动没动」判据 —— 未动的槽位写回时原样透传不丢未知键)
      if (pkg) {
        const base = normalizeTagRecFilterSettings(pkg.base.filterConfig) ?? createShareFactoryFilterConfig()
        setEditFilter({ cfg: proxy(cloneDeep(base)), base })
      } else {
        setEditFilter(undefined)
      }
    })
  }

  /** PATCH 保存: 成功后本地记账标题同步 (rememberShareToken 覆写); 401/404/409 分态提示 */
  const saveEdit = async (row: MyShareRow) => {
    if (!row.token || editBusy) return
    const body = buildSharePatchBody({
      title: editTitle,
      description: editDescKnown || editDesc.trim() ? editDesc : undefined,
    })
    if (!body) {
      toast(`标题必填且不超过 ${SHARE_GUARD_LIMITS.MAX_STRING_LEN} 字`, 4000)
      return
    }
    setEditBusy(true)
    setEditIssues([])
    try {
      const res = await patchShare(row.shareId, row.token, body)
      if (res.kind === 'ok') {
        const title = res.title ?? body.title ?? row.title
        void rememberShareToken(row.shareId, { token: row.token, title, createdAt: row.createdAt })
        setTokenMap(
          (prev) => prev && { ...prev, [row.shareId]: { token: row.token!, title, createdAt: row.createdAt } },
        )
        closeEditor()
        toast(`已更新「${title}」`)
        return
      }
      if (res.kind === 'rejected') {
        setEditIssues(res.issues) // 逐条列在编辑区内, 表单保留
        return
      }
      if (res.kind === 'unauthorized') {
        toast('管理 token 失效 (服务端记录已删或插件数据被清), 无法修改', 5000)
        return
      }
      if (res.kind === 'not-found' || res.kind === 'conflict') {
        const drop = await antModal.confirm({
          centered: true,
          title: res.kind === 'not-found' ? '服务端已不存在该分享' : '分享已在服务端下架',
          content: '本地记账只剩管理凭据, 是否移除这条记录?',
          okText: '移除记录',
        })
        if (drop) dropRow(row.shareId)
        return
      }
      toast(`修改失败: ${res.message}`, 5000)
    } finally {
      setEditBusy(false)
    }
  }

  /** PATCH 包内容: 仅携 {payload} —— 服务端防护档校验 + 全量重审;
   *  只走结构化档 (buildSharePkgPayload 重建, l1/themes 按剩余组引用精简) —— 不开手改 JSON 口子;
   *  保存前拦: 每组 ≥1 正向 tag (服务端语义档同拒) / L1·主题名非空 (空名会让包过不了导入侧校验);
   *  ok.status==='pending' => 审核降级属正常 (文案提示); rejected 逐条列; 401/404/409 同 saveEdit 分态 */
  const savePayload = async (row: MyShareRow) => {
    if (!row.token || editBusy || !editPkg) return
    if (!editPkg.groups.length) {
      toast('包内至少要留 1 个标签组 (想全删请用「删除」)', 4000)
      return
    }
    const emptyGroup = editPkg.groups.find((g) => !hasSharePkgGroupContent(g))
    if (emptyGroup) {
      toast(`组「${emptyGroup.name || '未命名'}」没有内容条件，请添加条件或删掉该组`, 4000)
      return
    }
    if (editPkg.l1.some((l) => !l.name.trim())) {
      toast('一级组名不能为空', 4000)
      return
    }
    if (editPkg.themes.some((t) => !t.name.trim())) {
      toast('主题名不能为空', 4000)
      return
    }
    let payload: Record<string, unknown>
    try {
      payload = buildSharePkgPayload(editPkg)
    } catch (error) {
      toast(error instanceof Error ? error.message : '内容条件不合法，请检查后再保存', 4000)
      return
    }
    // 票26: filterConfig 编辑副本写回 —— 仅动过才覆写 (未动 = 原包内字段经 base 原样透传,
    //   归一化未知键不丢); cloneDeep 脱 proxy 出纯对象
    if (editFilter) {
      const edited = cloneDeep(editFilter.cfg)
      if (!isEqual(edited, editFilter.base)) payload.filterConfig = edited
    }
    setEditBusy(true)
    setEditIssues([])
    try {
      const res = await patchShare(row.shareId, row.token, { payload })
      if (res.kind === 'ok') {
        closeEditor()
        toast(res.status === 'pending' ? '已更新, 正重走审核 (pending), 稍后自动上架' : '已更新包内容')
        return
      }
      if (res.kind === 'rejected') {
        setEditIssues(res.issues)
        return
      }
      if (res.kind === 'unauthorized') {
        toast('管理 token 失效 (服务端记录已删或插件数据被清), 无法修改', 5000)
        return
      }
      if (res.kind === 'not-found' || res.kind === 'conflict') {
        const drop = await antModal.confirm({
          centered: true,
          title: res.kind === 'not-found' ? '服务端已不存在该分享' : '分享已在服务端下架',
          content: '本地记账只剩管理凭据, 是否移除这条记录?',
          okText: '移除记录',
        })
        if (drop) dropRow(row.shareId)
        return
      }
      toast(`修改失败: ${res.message}`, 5000)
    } finally {
      setEditBusy(false)
    }
  }

  /** DELETE: 二次确认 → 软删 + 摘账; 404 (服务端已被下架/不存在) 同样摘账并提示 */
  const onDelete = async (row: MyShareRow) => {
    if (!row.token || busyIds.has(row.shareId)) return
    const ok = await antModal.confirm({
      centered: true,
      title: `删除分享「${row.title || row.shareId}」?`,
      content: '服务端下架该分享 (不可恢复), 并从本地记账移除',
      okText: '删除',
      okButtonProps: { danger: true },
    })
    if (!ok) return
    setBusyIds((prev) => new Set(prev).add(row.shareId))
    try {
      const res = await deleteShare(row.shareId, row.token)
      if (res.kind === 'ok') {
        dropRow(row.shareId)
        toast('已删除分享')
        return
      }
      if (res.kind === 'not-found') {
        dropRow(row.shareId)
        toast('服务端已下架/不存在, 已摘账', 4000)
        return
      }
      if (res.kind === 'unauthorized') {
        toast('管理 token 失效 (服务端记录已删或插件数据被清), 无法删除', 5000)
        return
      }
      toast(`删除失败: ${res.message}`, 5000)
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(row.shareId)
        return next
      })
    }
  }

  /** 结构化包编辑的小动作 (不可变更新 editPkg) */
  const patchGroup = (gi: number, patch: Partial<SharePkgGroup>) =>
    setEditPkg((prev) => prev && { ...prev, groups: prev.groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)) })
  const removeGroup = (gi: number) =>
    setEditPkg((prev) => prev && { ...prev, groups: prev.groups.filter((_, i) => i !== gi) })
  const removeTag = (gi: number, key: 'tagIds' | 'negIds', id: number) =>
    setEditPkg(
      (prev) =>
        prev && {
          ...prev,
          groups: prev.groups.map((g, i) => (i === gi ? { ...g, [key]: g[key].filter((t) => t.id !== id) } : g)),
        },
    )
  /** 加 tag: 正向/负向互斥 (构造器同口径 —— 正向优先); 已在同列去重 */
  const addTag = (gi: number, key: 'tagIds' | 'negIds', entry: { id: number; name: string }) => {
    setEditPkg(
      (prev) =>
        prev && {
          ...prev,
          groups: prev.groups.map((g, i) => {
            if (i !== gi || g[key].some((t) => t.id === entry.id)) return g
            const next = { ...g, [key]: [...g[key], entry] }
            if (key === 'tagIds') next.negIds = next.negIds.filter((t) => t.id !== entry.id) // 正向撞车剔除负向
            if (key === 'negIds' && next.tagIds.some((t) => t.id === entry.id)) return g // 负向撞正向不加
            return next
          }),
        },
    )
  }
  const addGroup = () =>
    setEditPkg(
      (prev) =>
        prev && {
          ...prev,
          groups: [
            ...prev.groups,
            {
              id: crypto.randomUUID(),
              name: '',
              tagIds: [],
              negIds: [],
              negStrict: false,
              weight: 1,
              raw: {},
            },
          ],
        },
    )
  const patchL1 = (li: number, patch: Partial<SharePkgL1>) =>
    setEditPkg((prev) => prev && { ...prev, l1: prev.l1.map((l, i) => (i === li ? { ...l, ...patch } : l)) })
  const removeL1 = (li: number) => setEditPkg((prev) => prev && { ...prev, l1: prev.l1.filter((_, i) => i !== li) })
  const addL1 = () =>
    setEditPkg(
      (prev) => prev && { ...prev, l1: [...prev.l1, { id: crypto.randomUUID(), name: '', weight: 1, raw: {} }] },
    )
  const patchTheme = (ti: number, patch: Partial<SharePkgTheme>) =>
    setEditPkg((prev) => prev && { ...prev, themes: prev.themes.map((t, i) => (i === ti ? { ...t, ...patch } : t)) })
  const removeTheme = (ti: number) =>
    setEditPkg(
      (prev) =>
        prev && {
          ...prev,
          themes: prev.themes.filter((_, i) => i !== ti),
          l1: prev.l1.map((l) => (l.themeId === prev.themes[ti]?.id ? { ...l, themeId: undefined } : l)),
        },
    )
  const addTheme = () =>
    setEditPkg((prev) => prev && { ...prev, themes: [...prev.themes, { id: crypto.randomUUID(), name: '', raw: {} }] })
  const removeBlacklist = (id: number) =>
    setEditPkg((prev) => prev && { ...prev, blacklist: prev.blacklist.filter((b) => b.id !== id) })
  const addBlacklist = (entry: { id: number; name: string }) =>
    setEditPkg(
      (prev) =>
        prev && {
          ...prev,
          blacklist: prev.blacklist.some((b) => b.id === entry.id) ? prev.blacklist : [...prev.blacklist, entry],
        },
    )

  const remoteTag = (row: MyShareRow) =>
    row.remote === 'removed' ? (
      <Tag>已下架</Tag>
    ) : row.remote === 'pending' ? (
      <Tag color='gold'>审核中</Tag>
    ) : row.remote === 'gone' ? (
      <Tag color='warning'>服务端查无</Tag>
    ) : null

  return (
    <Modal title='我的分享' open={open} onCancel={onClose} footer={null} width={560}>
      {rows === undefined ? (
        <Typography.Text type='secondary' className='text-13px'>
          读取本地记账中…
        </Typography.Text>
      ) : rows.length === 0 ? (
        <Alert
          type='info'
          showIcon
          title='还没有分享'
          description='去「标签收藏表」勾选标签组, 点吸顶操作条上的「分享选中」即可上传'
        />
      ) : (
        // UIUX-U2-5: 主弹层滚动区统一 60vh
        <div className='max-h-60vh overflow-y-auto'>
          {rows.map((row) => {
            const manageable = !!row.token
            const displayTitle = row.title || '(未命名分享)'
            return (
              <div
                key={row.shareId}
                className={`mb-8px b-1px b-gate-border rounded-6px b-solid px-10px py-8px ${
                  row.remote === 'removed' ? 'opacity-50' : ''
                }`}
              >
                <div className='flex items-baseline justify-between gap-x-8px'>
                  <Typography.Text strong ellipsis={{ tooltip: displayTitle }} className='text-14px'>
                    {displayTitle}
                  </Typography.Text>
                  {/* [tag-rec] UIUX-U1-5: 导航 => 真链接 (href 可中键/复制) */}
                  <Typography.Link
                    className='shrink-0'
                    title='打开分享详情页 (不携管理 token —— W6-7b: #key= 明文上会进浏览器历史/代理日志)'
                    href={buildSharePageUrl(TAG_REC_SHARE_SITE_BASE, row.shareId)}
                    target='_blank'
                  >
                    打开分享页
                  </Typography.Link>
                </div>
                <div className='mt-2px flex items-center gap-x-8px'>
                  <Typography.Text type='secondary' className='text-12px font-mono'>
                    {row.shareId}
                  </Typography.Text>
                  {row.createdAt > 0 && (
                    <Typography.Text type='secondary' className='text-12px'>
                      {dayjs(row.createdAt).format('YYYY-MM-DD HH:mm')}
                    </Typography.Text>
                  )}
                  {remoteTag(row)}
                  <span className='ml-auto inline-flex items-center gap-x-10px'>
                    {manageable ? (
                      <>
                        {/* [tag-rec] UIUX-U1-5: 本地编辑器开合/复制/删除是动作 => Button link;
                            「网页编辑」是导航 => 真链接 (携 token 的编辑页 URL 由 buildShareEditUrl 构造) */}
                        <Button
                          type='link'
                          size='small'
                          className='h-auto px-0 text-12px'
                          onClick={() => {
                            if (editId === row.shareId && editMode === 'text') closeEditor()
                            else openEditor(row, 'text')
                          }}
                        >
                          {editId === row.shareId && editMode === 'text' ? '收起' : '改标题/描述'}
                        </Button>
                        <Button
                          type='link'
                          size='small'
                          className='h-auto px-0 text-12px'
                          onClick={() => {
                            if (editId === row.shareId && editMode === 'payload') closeEditor()
                            else openEditor(row, 'payload')
                          }}
                        >
                          {editId === row.shareId && editMode === 'payload' ? '收起' : '改包内容'}
                        </Button>
                        <Typography.Link
                          className='text-12px'
                          title='网页版编辑: 可改/删字段,暂不能新增 (tag 解析在插件内)'
                          href={buildShareEditUrl(TAG_REC_SHARE_SITE_BASE, row.shareId, row.token!)}
                          target='_blank'
                        >
                          网页编辑
                        </Typography.Link>
                        <Button
                          type='link'
                          size='small'
                          className='h-auto px-0 text-12px'
                          title='复制管理 token —— 入群验证/网页编辑手动粘贴用 (凭此 token 可改可删该分享,勿外泄)'
                          onClick={() => {
                            GM.setClipboard(row.token!)
                            toast('已复制管理 token')
                          }}
                        >
                          复制 token
                        </Button>
                        <Button
                          type='link'
                          size='small'
                          danger
                          className='h-auto px-0 text-12px'
                          disabled={busyIds.has(row.shareId)}
                          onClick={() => void onDelete(row)}
                        >
                          删除
                        </Button>
                      </>
                    ) : (
                      <Typography.Text
                        type='secondary'
                        className='text-12px'
                        title='账本缺少管理 token (畸形记录), 仅可查看'
                      >
                        失权
                      </Typography.Text>
                    )}
                  </span>
                </div>

                {/* 行内编辑: 标题必填 ≤200 / 描述 ≤200 (留空=清空, 远端未取到时留空不动);
                    包内容 = 仅结构化编辑, 保存即整包重审 */}
                {editId === row.shareId && (
                  <div className='mt-8px'>
                    {editMode === 'text' ? (
                      <>
                        <Input
                          size='small'
                          placeholder='分享标题 (必填)'
                          value={editTitle}
                          maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                          showCount
                          onChange={(e) => setEditTitle(e.target.value)}
                        />
                        <Input.TextArea
                          className='mt-6px'
                          size='small'
                          placeholder={
                            editDescKnown ? '描述 (留空 = 清空服务端描述)' : '描述 (远端现值未取到, 留空则不动)'
                          }
                          value={editDesc}
                          maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                          showCount
                          autoSize={{ minRows: 2, maxRows: 3 }}
                          onChange={(e) => setEditDesc(e.target.value)}
                        />
                      </>
                    ) : (
                      <>
                        {/* 包内容编辑: 结构化档 (组/L1/主题/黑名单全可增删改), 解析失败不给手改 JSON 通道 */}
                        {editPkgFailed ? (
                          <Typography.Text type='secondary' className='block text-12px'>
                            远端包内容拉取失败 (网络/服务错误){' '}
                            <Button
                              type='link'
                              size='small'
                              className='h-auto px-0 text-12px'
                              onClick={() => openEditor(row, 'payload')}
                            >
                              重试
                            </Button>
                          </Typography.Text>
                        ) : editPkg === undefined ? (
                          <Typography.Text type='secondary' className='block text-12px'>
                            远端包内容加载中…
                          </Typography.Text>
                        ) : editPkg === null ? (
                          <Typography.Text type='secondary' className='block text-12px'>
                            远端包内容无法按导出格式 v2 解析, 不支持编辑
                          </Typography.Text>
                        ) : (
                          <Tabs
                            size='small'
                            items={[
                              {
                                key: 'pkg',
                                label: '分组与黑名单',
                                children: (
                                  <div className='max-h-300px flex flex-col gap-y-6px overflow-y-auto'>
                                    {editPkg.groups.map((g, gi) => {
                                      return (
                                        <div
                                          key={g.id}
                                          className='b-1px b-gate-border rounded-6px b-solid px-8px py-6px'
                                        >
                                          <div className='flex items-center gap-x-6px'>
                                            <Input
                                              size='small'
                                              value={g.name}
                                              maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                                              placeholder='组名 (空=回落首个 tag 名)'
                                              onChange={(e) => patchGroup(gi, { name: e.target.value })}
                                            />
                                            <Typography.Text type='secondary' className='shrink-0 text-12px'>
                                              正{g.tagIds.length}·负{g.negIds.length}
                                            </Typography.Text>
                                            <Button
                                              type='link'
                                              size='small'
                                              danger
                                              className='h-auto shrink-0 px-0 text-12px'
                                              onClick={() => removeGroup(gi)}
                                            >
                                              删组
                                            </Button>
                                          </div>
                                          <div className='mt-4px flex items-center gap-x-6px'>
                                            <Select
                                              size='small'
                                              className='w-110px'
                                              placeholder='归属一级组'
                                              value={g.l1Id ?? ''}
                                              onChange={(v) => patchGroup(gi, { l1Id: v || undefined })}
                                              options={[
                                                { value: '', label: '未归属' },
                                                ...editPkg.l1.map((l) => ({
                                                  value: l.id,
                                                  label: l.name || '(未命名一级组)',
                                                })),
                                              ]}
                                            />
                                            <Select
                                              size='small'
                                              className='w-64px'
                                              title='权重 (0=挂起)'
                                              value={g.weight}
                                              onChange={(v) => patchGroup(gi, { weight: v })}
                                              options={[0, 1, 2, 3, 4, 5].map((w) => ({ value: w, label: `w${w}` }))}
                                            />
                                            <Checkbox
                                              checked={g.negStrict}
                                              onChange={(e) => patchGroup(gi, { negStrict: e.target.checked })}
                                            >
                                              <span className='text-12px'>负向严格</span>
                                            </Checkbox>
                                            <Input
                                              size='small'
                                              className='flex-1'
                                              placeholder='备注 (可空)'
                                              maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                                              value={g.note ?? ''}
                                              onChange={(e) => patchGroup(gi, { note: e.target.value || undefined })}
                                            />
                                            {/* R6: 组深编 —— 阈值/算分/格槽(四池)/名单, 同收藏夹组配置弹层 */}
                                            <Button
                                              size='small'
                                              className='shrink-0'
                                              disabled={!editFilter}
                                              title='阈值/算分/池格/名单 (同收藏夹组配置)'
                                              onClick={() => setDeepEdit({ kind: 'group', gi })}
                                            >
                                              ⚙ 配置
                                            </Button>
                                          </div>
                                          {g.tagIds.length + g.negIds.length > 0 && (
                                            <div className='mt-4px flex flex-wrap gap-4px'>
                                              {g.tagIds.map((t) => (
                                                <Tag
                                                  key={`p${t.id}`}
                                                  closable
                                                  onClose={(e) => {
                                                    e.preventDefault()
                                                    removeTag(gi, 'tagIds', t.id)
                                                  }}
                                                >
                                                  {t.name || `#${t.id}`}
                                                </Tag>
                                              ))}
                                              {g.negIds.map((t) => (
                                                <Tag
                                                  key={`n${t.id}`}
                                                  closable
                                                  color='error'
                                                  onClose={(e) => {
                                                    e.preventDefault()
                                                    removeTag(gi, 'negIds', t.id)
                                                  }}
                                                >
                                                  {t.name || `#${t.id}`}
                                                </Tag>
                                              ))}
                                            </div>
                                          )}
                                          <div className='mt-4px flex items-center gap-x-6px'>
                                            <TagEntryAdder
                                              placeholder='加正向 tag (名或 #id)'
                                              onAdd={(e) => addTag(gi, 'tagIds', e)}
                                            />
                                            <TagEntryAdder
                                              negative
                                              placeholder='加负向 tag'
                                              onAdd={(e) => addTag(gi, 'negIds', e)}
                                            />
                                          </div>
                                        </div>
                                      )
                                    })}
                                    <Button size='small' className='self-start' onClick={addGroup}>
                                      + 新增标签组
                                    </Button>
                                    {editPkg.groups.length === 0 && (
                                      <Typography.Text type='secondary' className='text-12px'>
                                        组已删空 —— 若想整包下架请改用「删除」
                                      </Typography.Text>
                                    )}

                                    {/* 一级组节: 被组引用的才随包上架 (空壳自动裁) */}
                                    <div className='b-1px b-gate-border rounded-6px b-dashed px-8px py-6px'>
                                      <Typography.Text type='secondary' className='text-12px'>
                                        一级组 {editPkg.l1.length} 个 (仅被组引用才进包; enabled 开关位不携带)
                                      </Typography.Text>
                                      {editPkg.l1.map((l, li) => (
                                        <div key={l.id} className='mt-4px flex items-center gap-x-6px'>
                                          <Input
                                            size='small'
                                            className='flex-1'
                                            placeholder='一级组名'
                                            maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                                            value={l.name}
                                            onChange={(e) => patchL1(li, { name: e.target.value })}
                                          />
                                          <Select
                                            size='small'
                                            className='w-100px'
                                            placeholder='所属主题'
                                            value={l.themeId ?? ''}
                                            onChange={(v) => patchL1(li, { themeId: v || undefined })}
                                            options={[
                                              { value: '', label: '未归属' },
                                              ...editPkg.themes.map((t) => ({
                                                value: t.id,
                                                label: t.name || '(未命名主题)',
                                              })),
                                            ]}
                                          />
                                          <Select
                                            size='small'
                                            className='w-58px'
                                            title='权重'
                                            value={l.weight}
                                            onChange={(v) => patchL1(li, { weight: v })}
                                            options={[0, 1, 2, 3, 4, 5].map((w) => ({ value: w, label: `w${w}` }))}
                                          />
                                          {/* R6: 一级组深编 (阈值/算分/名单; L1 无格槽) */}
                                          <Button
                                            size='small'
                                            className='shrink-0'
                                            disabled={!editFilter}
                                            title='阈值/算分/名单 (同收藏夹一级组配置)'
                                            onClick={() => setDeepEdit({ kind: 'l1', li })}
                                          >
                                            ⚙
                                          </Button>
                                          <Button
                                            type='link'
                                            size='small'
                                            danger={!editUsedL1Ids.has(l.id)}
                                            className='h-auto shrink-0 px-0 text-12px'
                                            disabled={editUsedL1Ids.has(l.id)}
                                            title={
                                              editUsedL1Ids.has(l.id)
                                                ? '被组引用中的一级组不可删 (先把组改挂/删)'
                                                : undefined
                                            }
                                            onClick={() => removeL1(li)}
                                          >
                                            删
                                          </Button>
                                        </div>
                                      ))}
                                      <Button size='small' className='mt-4px' onClick={addL1}>
                                        + 新增一级组
                                      </Button>
                                    </div>

                                    {/* 主题节: 被 L1 引用的才随包上架 */}
                                    <div className='b-1px b-gate-border rounded-6px b-dashed px-8px py-6px'>
                                      <Typography.Text type='secondary' className='text-12px'>
                                        主题 {editPkg.themes.length} 个 (仅被一级组引用才进包)
                                      </Typography.Text>
                                      {editPkg.themes.map((t, ti) => (
                                        <div key={t.id} className='mt-4px flex items-center gap-x-6px'>
                                          <Input
                                            size='small'
                                            className='flex-1'
                                            placeholder='主题名'
                                            maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
                                            value={t.name}
                                            onChange={(e) => patchTheme(ti, { name: e.target.value })}
                                          />
                                          <Button
                                            type='link'
                                            size='small'
                                            danger
                                            className='h-auto shrink-0 px-0 text-12px'
                                            onClick={() => removeTheme(ti)}
                                          >
                                            删
                                          </Button>
                                        </div>
                                      ))}
                                      <Button size='small' className='mt-4px' onClick={addTheme}>
                                        + 新增主题
                                      </Button>
                                    </div>

                                    <div className='b-1px b-gate-border rounded-6px b-dashed px-8px py-6px'>
                                      <Typography.Text type='secondary' className='text-12px'>
                                        附黑名单 {editPkg.blacklist.length} 条 (点 × 摘除)
                                      </Typography.Text>
                                      {editPkg.blacklist.length > 0 && (
                                        <div className='mt-4px flex flex-wrap gap-4px'>
                                          {editPkg.blacklist.map((b) => (
                                            <Tag
                                              key={`b${b.id}`}
                                              closable
                                              onClose={(e) => {
                                                e.preventDefault()
                                                removeBlacklist(b.id)
                                              }}
                                            >
                                              {b.name || `#${b.id}`}
                                            </Tag>
                                          ))}
                                        </div>
                                      )}
                                      <TagEntryAdder placeholder='加黑名单 tag (名或 #id)' onAdd={addBlacklist} />
                                    </div>
                                  </div>
                                ),
                              },
                              {
                                key: 'filter',
                                label: '过滤配置',
                                children: editFilter ? (
                                  <div className='max-h-300px overflow-y-auto pr-4px'>
                                    <TagRecShareFilterEditor filter={editFilter.cfg} />
                                  </div>
                                ) : (
                                  <Typography.Text type='secondary' className='text-12px'>
                                    包内容未载入
                                  </Typography.Text>
                                ),
                              },
                            ]}
                          />
                        )}
                        <Typography.Text type='secondary' className='mt-4px block text-12px'>
                          组/L1/主题/黑名单全可增删改; 未引用的空壳自动裁; 过滤配置页签可整套编辑; 保存 = 整包重审
                        </Typography.Text>
                      </>
                    )}
                    {editIssues.length > 0 && (
                      <Alert
                        type='error'
                        className='mt-6px'
                        title='未通过, 请修改后重试'
                        description={
                          <ul className='m-0 list-disc pl-18px text-12px'>
                            {editIssues.map((it, i) => (
                              <li key={i}>
                                {it.field ? `${it.field}: ` : ''}
                                {it.reason}
                                {it.word ? ` (命中词: ${it.word})` : ''}
                                {it.category ? ` (类目: ${it.category})` : ''}
                              </li>
                            ))}
                          </ul>
                        }
                      />
                    )}
                    <div className='mt-6px flex justify-end gap-x-8px'>
                      <Button size='small' onClick={closeEditor} disabled={editBusy}>
                        取消
                      </Button>
                      <Button
                        size='small'
                        type='primary'
                        loading={editBusy}
                        disabled={editMode === 'text' ? !editTitle.trim() : !editPkg || !editPkg.groups.length}
                        onClick={() => void (editMode === 'text' ? saveEdit(row) : savePayload(row))}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 常显 (spec §9): GM store 清空 = 管理权同失 */}
      <Typography.Text type='warning' className='mt-10px block text-12px'>
        清空插件数据将同时失去全部管理 token, 不可找回
      </Typography.Text>

      {/* R6: 包内组/L1 深编 —— 复用收藏夹同款 ScopeConfigEditor, 基底 core = 包内 filterConfig 编辑副本,
          L1 链 = 包内一级组; 保存写回 editPkg 草稿的 raw.overrides (负向 tagIds/strict 折叠顶层口径不变) */}
      {deepEdit && editPkg && editFilter && (
        <PkgScopeEditor
          editPkg={editPkg}
          pkgCore={editFilter.cfg}
          deepEdit={deepEdit}
          setEditPkg={setEditPkg}
          onClose={() => setDeepEdit(null)}
        />
      )}
    </Modal>
  )
}

/**
 * tag 录入小组件 (包编辑「加正向/负向/黑名单」共用):
 * 名 → fetchTagInfoByName; `#123`/纯数字 → fetchTagInfoById; 未命中 toast, 命中回传 {id,name}
 */
function TagEntryAdder({
  onAdd,
  placeholder,
  negative,
}: {
  onAdd: (entry: { id: number; name: string }) => void
  placeholder?: string
  negative?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const m = t.match(/^#?(\d+)$/)
      const info = m ? await fetchTagInfoById(Number(m[1])) : await fetchTagInfoByName(t)
      if (!info || typeof info.id !== 'number') {
        toast(`未找到标签「${t}」`, 3000)
        return
      }
      onAdd({ id: info.id, name: info.name })
      setText('')
    } catch {
      // [tag-rec] UIUX-U1-3: 请求抛错 (网络/风控) 也要出固定话术 —— finally 前补 catch, 输入保留可重试
      toast('请求失败(可能是网络/风控),请稍后重试', 4000)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className='inline-flex flex-1 items-center gap-x-4px'>
      <Input
        size='small'
        placeholder={placeholder ?? '加 tag (名或 #id)'}
        value={text}
        maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={() => void submit()}
      />
      <Button size='small' className='shrink-0' loading={busy} danger={negative} onClick={() => void submit()}>
        {negative ? '加负向' : '加'}
      </Button>
    </span>
  )
}

/**
 * [tag-rec] R6: 包内组/L1 深编适配器 —— 复用收藏夹同款 ScopeConfigEditor (真·同款控件)
 * - 基底 core = 包内 filterConfig 编辑副本 (editFilter.cfg); L1 链 = 包内一级组
 * - 生效解/差分基准: raw.overrides 合成 TagGroup/TagL1Group 走 resolveTagRecEffective 同一链
 *   (包内未知键随 raw 保留; tagIds 不合成 —— 顶层 negative_tag_ids 喂链, 写回折叠口径不变)
 * - 存盘写回 editPkg 草稿的 raw.overrides: 负向 tagIds/strict 折叠编辑模型 (与 buildSharePkgPayload 同口径);
 *   L1 名单容器直存 overrides (L1 无顶层负向别名)
 * - 纯内存草稿, 零请求面; 实际持久化在「保存」(PATCH) 时整包提交
 */
function PkgScopeEditor({
  editPkg,
  pkgCore,
  deepEdit,
  setEditPkg,
  onClose,
}: {
  editPkg: SharePkgEdit
  pkgCore: TagRecFilterSettings
  deepEdit: { kind: 'group'; gi: number } | { kind: 'l1'; li: number }
  setEditPkg: Dispatch<SetStateAction<SharePkgEdit | null | undefined>>
  onClose: () => void
}) {
  /** 包组 → TagGroup 形 (生效链求解用): 负向双源合成 strict; tagIds 恒走顶层 negative_tag_ids */
  const toTagGroup = (g: SharePkgGroup): TagGroup => {
    const src = typeof g.raw.overrides === 'object' && g.raw.overrides !== null ? g.raw.overrides : {}
    const overrides = cloneDeep(src) as TagRecGroupOverrides
    if (overrides.negative) {
      const n = { ...overrides.negative }
      delete n.tagIds // 双源折叠: 顶层 negative_tag_ids 已喂链, 容器内不留副本
      n.strict = g.negStrict || undefined
      if (Object.keys(n).length) overrides.negative = n
      else delete overrides.negative
    } else if (g.negStrict) {
      overrides.negative = { strict: true }
    }
    const toEntry = (t: { id: number; name?: string }) => ({ id: t.id, name: t.name ?? '' })
    return {
      id: g.id,
      name: g.name,
      l1Id: g.l1Id,
      tag_ids: g.tagIds.map(toEntry),
      negative_tag_ids: g.negIds.map(toEntry),
      negative_strict: g.negStrict || undefined,
      overrides: Object.keys(overrides).length ? overrides : undefined,
      weight: g.weight,
      enabled: true,
      addedAt: 0,
    }
  }
  const toTagL1 = (l: SharePkgL1): TagL1Group => {
    const src = typeof l.raw.overrides === 'object' && l.raw.overrides !== null ? l.raw.overrides : undefined
    return {
      id: l.id,
      name: l.name,
      themeId: l.themeId,
      weight: l.weight,
      enabled: true,
      addedAt: 0,
      overrides: src ? (cloneDeep(src) as TagRecL1Overrides) : undefined,
    }
  }
  const pkgGroups = editPkg.groups.map(toTagGroup)

  const saveGroupEntries = (gi: number, entries: TagRecScopeSaveEntry[]) =>
    setEditPkg((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        groups: prev.groups.map((g, i) => {
          if (i !== gi) return g
          const prevOvr = (
            typeof g.raw.overrides === 'object' && g.raw.overrides !== null ? g.raw.overrides : undefined
          ) as TagRecGroupOverrides | undefined
          let next = applyTagRecScopeEntriesToGroupOverrides(prevOvr, entries)
          // 组槽开过 => 名单容器为权威: strict 折叠编辑模型 (tagIds 不经弹层, 无合成恒缺席)
          const negEntry = entries.find((e) => e.key === 'group')?.negative
          const negStrict = negEntry ? !!negEntry.strict : g.negStrict
          // 双源折叠顶层: raw.overrides.negative 不留 tagIds/strict (与 buildSharePkgPayload 同口径)
          if (next?.negative) {
            const n = { ...next.negative }
            delete n.tagIds
            delete n.strict
            next = { ...next }
            if (Object.keys(n).length) next.negative = n
            else delete next.negative
            if (!Object.keys(next).length) next = undefined
          }
          const raw = { ...g.raw }
          if (next) raw.overrides = next
          else delete raw.overrides
          return { ...g, negStrict, raw }
        }),
      }
    })

  const saveL1Entries = (li: number, entries: TagRecScopeSaveEntry[]) =>
    setEditPkg((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        l1: prev.l1.map((l, i) => {
          if (i !== li) return l
          const prevOvr = (
            typeof l.raw.overrides === 'object' && l.raw.overrides !== null ? l.raw.overrides : undefined
          ) as TagRecL1Overrides | undefined
          const next = applyTagRecScopeEntriesToL1Overrides(prevOvr, entries)
          const raw = { ...l.raw }
          if (next) raw.overrides = next
          else delete raw.overrides
          return { ...l, raw }
        }),
      }
    })

  if (deepEdit.kind === 'group') {
    const g = editPkg.groups[deepEdit.gi]
    if (!g) return null
    const tg = toTagGroup(g)
    const tl = g.l1Id ? editPkg.l1.find((l) => l.id === g.l1Id) : undefined
    const tagL1 = tl ? toTagL1(tl) : undefined
    const poolOf = (key: string) => (key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey))
    return (
      <TagRecScopeConfigEditor
        title={`包内组「${g.name}」配置`}
        core={pkgCore}
        presets={pkgCore.presets}
        slots={[
          { key: 'group', label: '整组 (各池共用)' },
          ...TAG_REC_POOL_KEYS.map((p) => ({
            key: `cell:${p}`,
            label: `格 · ${TAG_REC_POOL_LABELS[p]}`,
            cell: true,
          })),
        ]}
        resolve={(key) => resolveTagRecEffective(pkgCore, poolOf(key), tg, tagL1).cfg}
        resolveBase={(key) => resolveTagRecEffective(pkgCore, poolOf(key), stripTagRecGroupSlot(tg, key), tagL1).cfg}
        storedOverrideOf={(key) =>
          pickTagRecScopePatch(key === 'group' ? tg.overrides : tg.overrides?.pools?.[key.slice(5) as TagRecPoolKey])
        }
        negativeOf={(key) => (key === 'group' ? tg.overrides?.negative : undefined)}
        storedPoolsEnabledOf={(key) => (key === 'group' ? tg.overrides?.poolsEnabled : undefined)}
        resolvePoolsEnabled={(key) =>
          resolveTagRecEffective(pkgCore, key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey), tg, tagL1)
            .poolsEnabled
        }
        basePoolsEnabled={(key) =>
          resolveTagRecEffective(
            pkgCore,
            key === 'group' ? 'tagTop' : (key.slice(5) as TagRecPoolKey),
            stripTagRecGroupSlot(tg, key),
            tagL1,
          ).poolsEnabled
        }
        onSave={(entries) => {
          saveGroupEntries(deepEdit.gi, entries)
          toast('已保存组配置 (点「保存」提交后生效)')
        }}
        onClose={onClose}
      />
    )
  }
  const l = editPkg.l1[deepEdit.li]
  if (!l) return null
  const tl = toTagL1(l)
  const chain = () => tagRecL1ChainGroup(tl, pkgGroups)
  const strippedL1: TagL1Group = { ...tl, overrides: undefined }
  return (
    <TagRecScopeConfigEditor
      title={`包内一级组「${l.name}」配置`}
      core={pkgCore}
      presets={pkgCore.presets}
      slots={[{ key: 'l1', label: '一级组' }]}
      resolve={() => resolveTagRecEffective(pkgCore, 'tagTop', chain(), tl).cfg}
      resolveBase={() => resolveTagRecEffective(pkgCore, 'tagTop', chain(), strippedL1).cfg}
      storedOverrideOf={() => pickTagRecScopePatch(tl.overrides)}
      negativeOf={() => tl.overrides?.negative}
      storedPoolsEnabledOf={() => tl.overrides?.poolsEnabled}
      resolvePoolsEnabled={() => resolveTagRecEffective(pkgCore, 'tagTop', chain(), tl).poolsEnabled}
      basePoolsEnabled={() => resolveTagRecEffective(pkgCore, 'tagTop', chain(), strippedL1).poolsEnabled}
      onSave={(entries) => {
        saveL1Entries(deepEdit.li, entries)
        toast('已保存一级组配置 (点「保存」提交后生效)')
      }}
      onClose={onClose}
    />
  )
}
