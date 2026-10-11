import { Alert, Button, Checkbox, Input, Modal, theme, Typography } from 'antd'
import { useEffect, useId, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { antMessage } from '$modules/antd'
import { settings } from '$modules/settings'
import toast from '$utility/toast'
import {
  checkDupShare,
  fetchShareUploader,
  TAG_REC_SHARE_SITE_BASE,
  uploadShare,
  type ShareDupItem,
  type ShareUploadBody,
  type ShareUploaderOutcome,
} from '../api/share'
import { hasTagRecCombination, nameTagRecCombination } from '../model/combination'
import {
  buildShareEditUrl,
  buildSharePageUrl,
  buildSharePayload,
  collectSharePositiveTagIds,
  describeShareCategory,
  describeShareField,
  formatShareUpdatedAgo,
  preflightShareIssues,
  SHARE_GUARD_LIMITS,
  type ShareRejectItem,
} from '../model/share'
import { blacklist, blacklistStore, favoritesL1, themes } from '../store'
import { tagRecCombinationBlocks } from '../store/combination-blocks'
import { readShareTokens, rememberShareToken } from '../store/share-tokens'
import { TagRecShareGroupContents } from './group-condition-tree'
import type { TagGroup } from '../model/types'

/**
 * [tag-rec] 分享上传 Modal (tag-share-platform spec §5 / 票 16)
 * - 勾选组清单确认 + 标题(必填 ≤200)/描述(≤200) + 黑名单勾选 (默认带, 措辞正向「包含黑名单」;
 *   spec 反向表述「本次不含黑名单」同义, 正向写防双否定误读) + 风险告知勾选 (每次打开重新勾, 不记忆)
 * - 票26「包含过滤配置」opt-in (默认不勾): 勾上则 payload.filterConfig = 真实私配随包
 *   (serialize 内 cloneDeep 脱 valtio proxy); 不勾维持出厂占位
 * - 006 缺口2「随包携带全局排除」opt-in (默认不勾): 勾上则 payload.combinationExclusions =
 *   tagRecCombinationBlocks.list (升 v3, 收件侧落「以后都不看」); 屏蔽项是隐私面由用户主动选
 * - 身份 = nav 登录态 mid+uname (fetchShareUploader); UIUX-U1-8 三态分流: user=就绪 /
 *   not-logged-in=确认未登录(警示+拒传) / error=拉取失败(Alert+「重试」钮, nonce 重拉)
 * - 上传前本地预检 (preflightShareIssues = 服务端防护档同口径); 400 结构化拒绝逐条列不清表单;
 *   status=pending => 「已提交,审核中稍后可见」; published => toast 带「复制链接/打开分享页」
 * - 成功后 mgmtToken 落 GM `tag-rec:share-tokens` (rememberShareToken)
 * - 票31「重复分享软提醒」: 上传前先 POST /shares/dup-check ({mid,title,tagIds=正向 id 集});
 *   命中 => Modal 内 warning Alert 列相似条目 (「同名」/相似 NN% + 更新于 X 前),
 *   行右「更新原分享」仅对本机账本持 token 的命中项出 (readShareTokens), 点击 = 关本弹层 +
 *   onOpenMyShares(shareId) 开「我的分享」定位该条; Alert action 区「仍然发布新分享」续传 /「取消」回表单;
 *   接口失败/无命中 => 零打扰直接走原上传流程 (dup-check 挂了不挡上传)
 */
export function TagRecShareModal({
  open,
  groups,
  onClose,
  onOpenMyShares,
}: {
  open: boolean
  /** 勾选集展开后的目标组 (pane 侧 expandShareSelection 产物; 渲染期随 store 同步) */
  groups: readonly TagGroup[]
  onClose: () => void
  /** 票31: dup-check 命中行「更新原分享」出口 —— pane 侧开「我的分享」Modal 并定位该 shareId */
  onOpenMyShares?: (shareId: string) => void
}) {
  const { token } = theme.useToken()
  const formId = useId()
  const { list: blacklistList } = useSnapshot(blacklistStore)
  const blacklistCount = blacklistList.length
  const { list: combinationBlocksList } = useSnapshot(tagRecCombinationBlocks)
  const combinationBlocksCount = combinationBlocksList.length

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [includeBlacklist, setIncludeBlacklist] = useState(true)
  const [includeFilter, setIncludeFilter] = useState(false) // 票26: 真实私配 opt-in (默认仍出厂占位)
  const [includeExclusions, setIncludeExclusions] = useState(false) // 006 缺口2: 全局排除 opt-in (屏蔽项是隐私面, 默认不勾)
  const [riskAck, setRiskAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState<ShareRejectItem[]>([])
  /** 「包内声明」展开集 (wayfinding 005) */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  /** 票40: 最后一次提交的 body —— 拒绝渲染时把 field 路径反查成人话定位+实文本 */
  const lastBody = useRef<ShareUploadBody | undefined>(undefined)
  /**
   * 票31 dup-check 软提醒态: 命中时挂出 warning Alert 待用户裁量;
   * body = 已构建待发的原样上传体 (「仍然发布新分享」续传用它, 防等待期间表单被改后串味);
   * ownedIds = 命中项里本机 GM 账本持管理 token 的 shareId 集 (「更新原分享」钮显隐判据)
   */
  const [dupWarn, setDupWarn] = useState<
    { body: ShareUploadBody; dups: ShareDupItem[]; ownedIds: ReadonlySet<string> } | undefined
  >(undefined)
  /**
   * 上传者身份三态 (fetchShareUploader):
   *   undefined = 读取中; not-logged-in = 确认未登录 (警示+拒传);
   *   error = 拉取失败/响应畸形 (出「重试」钮, nonce 重拉); user = 就绪
   */
  const [uploaderRes, setUploaderRes] = useState<ShareUploaderOutcome | undefined>(undefined)
  const [uploaderNonce, setUploaderNonce] = useState(0)

  // 每次打开重置表单 (风险告知不记忆, spec §5; 上传者身份在下方 effect 独立拉取 —— 重试不再整表单清场)
  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setIncludeBlacklist(true)
    setIncludeFilter(false)
    setIncludeExclusions(false)
    setRiskAck(false)
    setIssues([])
    setExpandedIds(new Set())
    setDupWarn(undefined) // 票31: 软提醒随重开清场
  }, [open])
  useEffect(() => {
    if (!open) return
    setUploaderRes(undefined)
    let cancelled = false
    void fetchShareUploader().then((r) => {
      if (!cancelled) setUploaderRes(r)
    })
    return () => {
      cancelled = true
    }
  }, [open, uploaderNonce])
  const uploader = uploaderRes?.kind === 'user' ? uploaderRes.user : undefined

  const totalIds = groups.reduce((s, g) => s + g.tag_ids.length, 0)
  const canUpload =
    !!uploader &&
    !busy &&
    groups.length > 0 &&
    !!title.trim() &&
    title.length <= SHARE_GUARD_LIMITS.MAX_STRING_LEN &&
    description.length <= SHARE_GUARD_LIMITS.MAX_STRING_LEN &&
    riskAck

  /** 实际上传段 (onUpload dup-check 放行后 / dup Alert「仍然发布新分享」续传 共用) */
  const runUpload = async (body: ShareUploadBody) => {
    const res = await uploadShare(body)
    if (res.kind === 'rejected') {
      setIssues(res.issues) // 逐条列, 表单保留可改后重传
      return
    }
    if (res.kind === 'failed') {
      toast(`分享上传失败: ${res.message}`, 5000)
      return
    }
    // 成功: mgmtToken 记账 (pending 也记 —— PATCH/DELETE 同样凭它)
    void rememberShareToken(res.id, { token: res.mgmtToken, title: body.title, createdAt: Date.now() })
    // 票40: 跳转页携 #key=<mgmtToken> (fragment 不落服务端) → 详情页出管理位;
    // 「复制链接」是外发他人的观看链,仍给不带 token 的干净 URL —— token 泄露 = 移交改删权
    const url = buildSharePageUrl(TAG_REC_SHARE_SITE_BASE, res.id)
    const editUrl = buildShareEditUrl(TAG_REC_SHARE_SITE_BASE, res.id, res.mgmtToken)
    onClose()
    if (res.status === 'pending') {
      antMessage.success({ content: `已提交「${body.title}」, 审核中稍后可见`, duration: 6 })
      return
    }
    antMessage.success({
      duration: 8,
      content: (
        <span className='inline-flex items-center gap-x-10px'>
          已分享「{body.title}」
          {/* [tag-rec] UIUX-U1-5: 动作→link 钮 (复制链 = 写剪贴板动作); 导航→真链接 (携 #key 编辑链可中键/复制链) */}
          <Button
            type='link'
            size='small'
            className='h-auto px-0'
            onClick={() => {
              GM.setClipboard(url)
              toast('已复制分享链接')
            }}
          >
            复制链接
          </Button>
          <Typography.Link href={editUrl} target='_blank'>
            打开分享页
          </Typography.Link>
        </span>
      ),
    })
  }

  const onUpload = async () => {
    const u = uploader
    if (!u || busy || !groups.length || dupWarn) return
    const body = {
      mid: u.mid,
      nickname: u.nickname,
      avatar: u.avatar, // 票34: nav.face 顺字段;服务端白名单归一,非法落 null
      title: title.trim(),
      description: description.trim() || undefined,
      payload: buildSharePayload({
        groups,
        l1: favoritesL1.list,
        themes: themes.list,
        blacklist: blacklist.list,
        includeBlacklist: includeBlacklist && blacklistCount > 0,
        // 票26: opt-in 携带当前真实私配 (valtio proxy, serialize 内 cloneDeep 脱壳); 缺省 = 出厂占位
        filterConfig: includeFilter ? settings.tagRec.filter : undefined,
        // 006 缺口2: opt-in 携带全局排除清单 (同 cloneDeep 脱壳, 随包升 v3); 缺省 = 键不携
        combinationExclusions: includeExclusions ? tagRecCombinationBlocks.list : undefined,
      }),
    }
    lastBody.current = body // 票40: 拒绝定位反查素材 (本地预检与服务端拒绝共用)
    // 本地预检 (服务端防护档镜像) —— 命中即列, 省一轮 400
    const localIssues = preflightShareIssues(body)
    if (localIssues.length) {
      setIssues(localIssues)
      return
    }
    setBusy(true)
    setIssues([])
    try {
      // 票31: 真正上传前 dup-check 软提醒 —— 接口失败/无命中 => 零打扰放行原流程 (不挡上传)
      const dupRes = await checkDupShare({
        mid: body.mid,
        title: body.title,
        tagIds: collectSharePositiveTagIds(body.payload.favorites), // 本次将传的正向 tag id 集 (拍平去重)
      })
      if (dupRes.kind === 'ok' && dupRes.dups.length) {
        // 「更新原分享」钮仅对本机账本持管理 token 的命中项出 (无 token 管不了原分享)
        const tokens = await readShareTokens()
        const ownedIds = new Set(dupRes.dups.filter((d) => !!tokens[d.id]?.token).map((d) => d.id))
        setDupWarn({ body, dups: dupRes.dups, ownedIds })
        return // finally 收 busy; 上传与否交给 Alert 裁量
      }
      await runUpload(body)
    } finally {
      setBusy(false)
    }
  }

  /** 票31 Alert「仍然发布新分享」: 沿用触发时的原样 body 续传 (不再走 dup-check —— 用户已裁量过) */
  const resumeUpload = async () => {
    const w = dupWarn
    setDupWarn(undefined)
    if (!w) return
    setBusy(true)
    try {
      await runUpload(w.body)
    } finally {
      setBusy(false)
    }
  }

  /** 票31 Alert 行内「更新原分享」: 关本弹层 → pane 侧开「我的分享」Modal 定位该分享 */
  const gotoMyShare = (shareId: string) => {
    setDupWarn(undefined)
    onClose()
    onOpenMyShares?.(shareId)
  }

  return (
    <Modal
      title={`分享 ${groups.length} 个标签组`}
      open={open}
      onCancel={() => (busy ? undefined : onClose())}
      onOk={() => void onUpload()}
      okText='发布分享'
      confirmLoading={busy}
      // 票31: dup Alert 挂出期间主上传钮禁用 —— 走/留由 Alert action 明确裁量 (防绕过提醒直传)
      okButtonProps={{ disabled: !canUpload || !!dupWarn }}
      // [tag-rec] UIUX-U1-11: 上传中态在页脚出一行小字 (busy 期间关窗钮已被 disabled 控场, 这里给耐心提示)
      footer={(originNode) => (
        <>
          {busy && (
            <Typography.Text type='secondary' className='mr-8px text-12px'>
              上传中,完成后自动关闭
            </Typography.Text>
          )}
          {originNode}
        </>
      )}
      width={520}
    >
      {/* 清单确认: 组名 + id 数 */}
      <div
        className='b-1px b-gate-border rounded-8px b-solid px-12px py-10px'
        style={{ background: token.colorFillQuaternary }}
      >
        <div className='mb-6px flex items-center justify-between gap-x-8px'>
          <Typography.Text strong className='text-12px'>
            分享内容
          </Typography.Text>
          <Typography.Text type='secondary' className='shrink-0 text-12px'>
            {groups.length} 组 · {totalIds} 个标签
          </Typography.Text>
        </div>
        <div className='max-h-260px overflow-y-auto'>
          {groups.map((g) => (
            <div key={g.id} className='py-2px'>
              <div className='flex items-baseline gap-x-6px'>
                {/* wayfinding 005: 上传侧同口径展开「包内声明」 */}
                <Button
                  size='small'
                  type='text'
                  className='h-auto w-16px shrink-0 px-0 text-11px opacity-70'
                  title='展开包内声明（条件树 / 覆盖 / 负向）'
                  onClick={() =>
                    setExpandedIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.id)) next.delete(g.id)
                      else next.add(g.id)
                      return next
                    })
                  }
                >
                  {expandedIds.has(g.id) ? '▾' : '▸'}
                </Button>
                <Typography.Text ellipsis={{ tooltip: g.name }} className='min-w-0 flex-1 text-13px'>
                  {g.name}
                </Typography.Text>
                <Typography.Text type='secondary' className='shrink-0 text-12px'>
                  {g.tag_ids.length} 个标签
                </Typography.Text>
              </div>
              {expandedIds.has(g.id) ? (
                <TagRecShareGroupContents group={g} />
              ) : (
                g.combination && (
                  <Typography.Text
                    type='secondary'
                    ellipsis={{ tooltip: nameTagRecCombination(g.combination) }}
                    className='ml-18px block text-12px'
                  >
                    条件: {nameTagRecCombination(g.combination)}
                  </Typography.Text>
                )
              )}
            </div>
          ))}
        </div>
        <div className='mt-6px flex items-center justify-between gap-x-8px'>
          <Typography.Text type='secondary' className='text-12px'>
            保留所属一级组与主题结构
            {(groups.some((g) => hasTagRecCombination(g.combination)) || includeExclusions) &&
              ' · 组合结构完整携带 (v3)'}
          </Typography.Text>
          <Button
            size='small'
            type='link'
            className='h-auto shrink-0 px-0 text-12px'
            onClick={() =>
              setExpandedIds((prev) => (prev.size === groups.length ? new Set() : new Set(groups.map((g) => g.id))))
            }
          >
            {expandedIds.size === groups.length ? '全部收起' : '全部展开'}
          </Button>
        </div>
      </div>

      <div className='mt-14px'>
        <div className='mb-6px flex items-center justify-between gap-x-8px text-12px'>
          <label htmlFor={`${formId}-title`}>
            分享标题{' '}
            <Typography.Text type='secondary' className='text-12px'>
              必填
            </Typography.Text>
          </label>
          <Typography.Text type='secondary' className='shrink-0 text-12px'>
            {title.length} / {SHARE_GUARD_LIMITS.MAX_STRING_LEN}
          </Typography.Text>
        </div>
        <Input
          id={`${formId}-title`}
          placeholder='给这份分享起个名字'
          value={title}
          maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
          onChange={(e) => {
            setTitle(e.target.value)
            setDupWarn(undefined) // 票31: 标题改动 => 旧相似度提醒即过期, 撤掉放行重传 (再点会重查)
          }}
        />
      </div>
      <div className='mt-12px'>
        <div className='mb-6px flex items-center justify-between gap-x-8px text-12px'>
          <label htmlFor={`${formId}-description`}>
            描述{' '}
            <Typography.Text type='secondary' className='text-12px'>
              选填
            </Typography.Text>
          </label>
          <Typography.Text type='secondary' className='shrink-0 text-12px'>
            {description.length} / {SHARE_GUARD_LIMITS.MAX_STRING_LEN}
          </Typography.Text>
        </div>
        <Input.TextArea
          id={`${formId}-description`}
          placeholder='介绍内容或推荐理由'
          value={description}
          maxLength={SHARE_GUARD_LIMITS.MAX_STRING_LEN}
          autoSize={{ minRows: 2, maxRows: 4 }}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className='mt-14px overflow-hidden b-1px b-gate-border rounded-8px b-solid'>
        <div className='px-12px py-9px'>
          <Checkbox
            checked={includeBlacklist}
            disabled={!blacklistCount}
            onChange={(e) => setIncludeBlacklist(e.target.checked)}
          >
            包含标签黑名单{blacklistCount ? `（${blacklistCount} 项）` : '（空）'}
          </Checkbox>
        </div>

        {/* 票26 opt-in: 勾上 => 包内 filterConfig = 当前真实私配 (阈值/屏蔽词/UP主名单/算分/预设整套);
          不勾 => 出厂占位 (收件侧 import 不带入) —— 与黑名单同款正向 opt-in, 默认不勾 */}
        <div className='b-t-1px b-t-gate-border b-t-solid px-12px py-9px'>
          <Checkbox checked={includeFilter} onChange={(e) => setIncludeFilter(e.target.checked)}>
            包含过滤配置
          </Checkbox>
          <Typography.Text type='secondary' className='mt-2px block pl-24px text-12px' style={{ textWrap: 'pretty' }}>
            {includeFilter ? '屏蔽词、UP 主名单等个人设置将随分享公开' : '默认不分享屏蔽词、UP 主名单等个人设置'}
          </Typography.Text>
        </div>

        {/* 006 缺口2 opt-in: 勾上 => 包内 combinationExclusions = 全局排除清单 (收件侧导入落「以后都不看」);
          不勾 => 键不携 —— 屏蔽项是隐私面 (暴露你屏蔽了什么), 默认不勾主动选 */}
        <div className='b-t-1px b-t-gate-border b-t-solid px-12px py-9px'>
          <Checkbox
            checked={includeExclusions}
            disabled={!combinationBlocksCount}
            onChange={(e) => setIncludeExclusions(e.target.checked)}
          >
            随包携带全局排除{combinationBlocksCount ? `（${combinationBlocksCount} 项）` : '（空）'}
          </Checkbox>
          <Typography.Text type='secondary' className='mt-2px block pl-24px text-12px' style={{ textWrap: 'pretty' }}>
            {includeExclusions ? '你屏蔽的标签、UP 主等排除条件将随分享公开' : '默认不分享你的全局排除条件'}
          </Typography.Text>
        </div>
      </div>

      {/* 风险告知: 每次打开须重新勾选, 不记忆 (spec §5 四要点) */}
      <Alert
        type='warning'
        showIcon
        className='mt-12px'
        title='发布后公开展示'
        style={{ padding: '12px 14px', borderRadius: 8 }}
        description={
          <div className='flex flex-col gap-y-4px text-12px leading-19px' style={{ textWrap: 'pretty' }}>
            <div>
              标签组{includeBlacklist && blacklistCount > 0 ? '、黑名单' : ''}
              {includeFilter ? '、过滤配置' : ''}
              {includeExclusions && combinationBlocksCount > 0 ? '、全局排除条件' : ''}上传到第三方平台并公开。
            </div>
            <div>同时公开你的 B 站昵称与 UID。</div>
            <div>自动审核不保证合规，请对发布内容负责。</div>
            <div>修改、删除需管理凭证；仅发放一次，丢失无法找回。</div>
          </div>
        }
      />
      <Checkbox className='mt-10px' checked={riskAck} onChange={(e) => setRiskAck(e.target.checked)}>
        <Typography.Text strong className='text-13px'>
          我已了解并同意公开发布
        </Typography.Text>
      </Checkbox>

      {uploaderRes?.kind === 'not-logged-in' && (
        <Alert
          type='error'
          className='mt-8px'
          title='请先登录 B 站'
          description={
            <>
              分享需要读取你的 B 站昵称与 UID。{' '}
              <Typography.Link href='https://passport.bilibili.com/login' target='_blank'>
                去登录
              </Typography.Link>
            </>
          }
        />
      )}
      {/* [tag-rec] UIUX-U1-8: 拉取失败/响应畸形 => error 档出重试钮 (与「确认未登录」分流) */}
      {uploaderRes?.kind === 'error' && (
        <Alert
          type='error'
          className='mt-8px'
          title='读取登录态失败'
          description='可能是网络/风控原因 —— 登录态取不到则无法上传'
          action={
            <Button size='small' onClick={() => setUploaderNonce((n) => n + 1)}>
              重试
            </Button>
          }
        />
      )}

      {/* 票31: dup-check 软提醒 —— 命中列出相似分享 (title_match 行显「同名」替代百分比);
          行右「更新原分享」仅本机账本持 token 项可见; action 区收「仍然发布新分享」/「取消」 */}
      {dupWarn && (
        <Alert
          type='warning'
          className='mt-8px'
          title='你可能发过相似的分享:'
          description={
            <ul className='m-0 list-none pl-0 text-12px'>
              {dupWarn.dups.map((d) => (
                <li key={d.id} className='flex items-center gap-x-8px py-1px'>
                  <Typography.Text
                    className='min-w-0 flex-1 text-12px'
                    ellipsis={{ tooltip: `「${d.title}」 · 更新于 ${formatShareUpdatedAgo(d.updatedAt)}` }}
                  >
                    『{d.title}』 · 更新于 {formatShareUpdatedAgo(d.updatedAt)} ·{' '}
                    {d.titleMatch ? '同名' : `相似 ${Math.min(100, Math.max(0, Math.round(d.similarity * 100)))}%`}
                  </Typography.Text>
                  {dupWarn.ownedIds.has(d.id) && (
                    <Button
                      type='link'
                      size='small'
                      className='h-auto shrink-0 px-0 text-12px'
                      onClick={() => gotoMyShare(d.id)}
                    >
                      更新原分享
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          }
          action={
            <div className='flex gap-x-8px'>
              <Button size='small' type='primary' onClick={() => void resumeUpload()}>
                仍然发布新分享
              </Button>
              <Button size='small' onClick={() => setDupWarn(undefined)}>
                取消
              </Button>
            </div>
          }
        />
      )}

      {/* 拒绝逐条列 (本地预检 + 服务端 400 共用), 不清表单 */}
      {issues.length > 0 && (
        <Alert
          type='error'
          className='mt-8px'
          title='未通过, 请修改后重传'
          description={
            <ul className='m-0 list-disc pl-18px text-12px'>
              {issues.map((it, i) => (
                <li key={i}>
                  {it.field ? `${describeShareField(it.field, lastBody.current)}: ` : ''}
                  {it.reason}
                  {it.word ? ` (命中词: ${it.word})` : ''}
                  {it.category ? ` (类目: ${describeShareCategory(it.category)})` : ''}
                </li>
              ))}
              {issues.some((it) => it.category) && (
                <li className='list-none text-11px opacity-70'>
                  AI 审核存在误判可能 —— 若为误判，微调该处文案后重传即可
                </li>
              )}
            </ul>
          }
        />
      )}

      {uploaderRes === undefined && !issues.length && (
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          读取登录态中…
        </Typography.Text>
      )}
    </Modal>
  )
}
