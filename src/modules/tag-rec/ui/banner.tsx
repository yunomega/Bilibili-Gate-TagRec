import { Alert, Button, Space, theme, Typography } from 'antd'
import { useSnapshot } from 'valtio'
import { modalSettingsStore, TabPaneKey } from '$components/ModalSettings/shared' // [tag-rec] 票 perf-08: 轻模块, 不拉 ModalSettings 图
import { showModalSettings } from '$components/RecHeader/modals'
import { useOnRefresh } from '$components/Recommends/rec.shared'
import { AntdTooltip } from '$modules/antd/custom'
import { usePopupContainer } from '$modules/rec-services/_base'
import { clearTagRecSeenRecords } from '../service/recovery'
import { favoritesL1, favoritesL1Store, viewScope } from '../store'
import { tagRecSharedSession } from '../store/session'
import {
  formatTagRecDroppedText,
  resolveTagRecBannerState,
  tagRecHoldReasonText,
  type TagRecBannerSource,
} from './banner-helpers'
import type { ReactNode } from 'react'

/**
 * [tag-rec] 横幅槽位 (spec §5.4, 票 09) —— 统一提示区, 两 tab 复用
 *   tab1 传 tagRecFavSession / tab2 传 tagRecCustomSession (结构见 TagRecBannerSource)
 * - 三态互斥按严重度: 硬见底(error) > 深挖待决(info) > 软见底 > 池浅降级
 * - 仅「有可操作位」的态上横幅 (硬见底三动作 / 深挖待决「继续深挖」);
 *   软见底/池浅降级无动作 => 不整行展示, 回落常显滤除计数 + 尾注 (「· 池将见底」「· 池浅已放宽」)
 * - 空态: 槽位常显灰小字滤除计数; 有横幅时计数并进横幅文案
 * - basis-full => tab-bar 左区 flex-wrap 内换行自成一行, 随 sticky tab-bar 常显
 * - 硬见底三动作: [重抽一轮]=useOnRefresh()('refresh') 重建 service 全量重拉 /
 *   [临时放开已看]=session.bypassSeen (各 tab 自有 flag: tab1 默认开 / tab2 默认关, §3.4) /
 *   [管理收藏表]=深链「标签收藏」pane
 * - 硬见底判据 = session.hardBottom 镜像: service 单轮产出 0 => exhaustRound 置位。
 *   不读 service.hasMoreExceptQueue —— tab2「未输入/解析失败」也翻 false (非池见底) 且非响应式
 */
export function TagRecBanner({
  session,
  onDigMore,
  onPartitionRetry,
  onRedig,
  hideIdleDropText,
  hidePartitionPending,
}: {
  session: TagRecBannerSource
  onDigMore?: () => void
  onPartitionRetry?: () => void
  /**
   * 硬见底第四动作「重新发掘」: 复位本查询深挖游标 (含持久沉淀的 exhausted/冷却) 并重挖一轮。
   * 缺省不渲染 —— tab1/tab2 各自接自己的 service.redigQuery。
   */
  onRedig?: () => void
  /** 空态滤除计数不上屏 (tab2: 计数上移进 tabbar 顶行); 有横幅/风控时不受影响 */
  hideIdleDropText?: boolean
  /** Discovery uses a compact verification row with temporary viewing. */
  hidePartitionPending?: boolean
}) {
  const snap = useSnapshot(session)
  const bypassSeenOn = snap.bypassSeen
  const { riskControl, shareGuide, shareLike } = useSnapshot(tagRecSharedSession)
  const { list: l1List } = useSnapshot(favoritesL1Store)
  const { token } = theme.useToken() // UIUX-U2-3: 池浅蓝走 token.colorInfo (暗色主题随档)
  const onRefresh = useOnRefresh()
  // 弹层就近挂 tab-bar 父元素 (spec §5.2)
  const { ref, getPopupContainer } = usePopupContainer<HTMLDivElement>()

  const state = resolveTagRecBannerState(snap)
  const dropText = formatTagRecDroppedText(snap.filterStats)

  // [tag-rec] 风控退避提示 (票 16 ③): 独立于三态互斥叠加显示, 恢复后自动消失
  const riskControlAlert = riskControl && (
    <Alert type='warning' showIcon className='py-4px' title='命中风控 · 请求已退避降速并自动重试, 恢复后自动继续' />
  )

  // 重抽一轮: 'refresh' = 重建 service 全量重拉 (spec §4.4)
  const redraw = () => onRefresh('refresh')
  // 临时放开已看: 写本 tab 的「显示已看」会话 flag, 不删 seen-set、刷新即丢
  const bypassSeen = () => {
    session.bypassSeen = true
    onRefresh('refresh')
  }
  const clearSeen = () => {
    clearTagRecSeenRecords()
    onRefresh('refresh')
  }
  // 管理收藏表: 深链设置 modal「标签收藏」pane (spec §5.4)
  const openFavoritesPane = () => {
    modalSettingsStore.tab = TabPaneKey.TagRecFavorites
    showModalSettings()
  }

  // 无可操作位的横幅态 (软见底/池浅降级) 不整行展示 —— 回落常显滤除计数 + 状态尾注;
  // hideIdleDropText (tab2) 时计数已上移顶行, 槽位只剩风控提示 (无风控整槽不渲染)
  const actionable =
    state === 'no-drawable' ||
    state === 'hard-bottom' ||
    (state === 'dig-pending' && !!onDigMore) ||
    state === 'partition-pending'

  // [tag-rec] 分享类提示 (票18 导入信息 R7 / 票19 回赞): 与状态横幅同槽纵排共存 ——
  //   R7: 两横幅**堆叠不互斥** (引导不再挡住回赞; 回赞 pending 显示后才消费, 见 share-like.ts) ——
  //   实机修复遗产: 原「仅空态出」设计在 no-drawable/见底横幅占位时把引导/回赞永久遮挡
  //   两横幅均一次性: 确认/关闭 => 清会话位 (懒载 service —— 横幅静态图不背分享管线)
  const dismissGuide = () =>
    void import('../service/share-import').then((m) => m.dismissShareImportGuide()).catch(() => undefined)
  let shareGuideAlert: ReactNode = null
  if (shareGuide && shareGuide.l1Ids.length) {
    const pkg = shareGuide
    const enabledCount = pkg.l1Ids.filter((id) => l1List.some((l) => l.id === id && l.enabled)).length
    const total = pkg.l1Ids.length
    const allEnabled = enabledCount >= total
    shareGuideAlert = (
      <Alert
        type='info'
        showIcon
        className='py-4px'
        title={
          allEnabled
            ? `已导入 ${total} 组 · 已全部启用`
            : `已导入 ${total} 组 · ${enabledCount} 个已启用，${total - enabledCount} 个未启用 (可在主题下拉里临时打开)`
        }
        action={
          <Space size={4}>
            {allEnabled && pkg.themeIds.length > 0 && (
              <Button
                size='small'
                type='primary'
                onClick={() => {
                  viewScope.onlyThemes(pkg.themeIds)
                  dismissGuide()
                  onRefresh('refresh')
                }}
              >
                只看这个包的主题
              </Button>
            )}
            {!allEnabled && (
              <Button
                size='small'
                type='primary'
                onClick={() => {
                  openFavoritesPane()
                  dismissGuide()
                }}
              >
                去开启
              </Button>
            )}
            <Button size='small' onClick={dismissGuide}>
              知道了
            </Button>
          </Space>
        }
      />
    )
  }
  let shareLikeAlert: ReactNode = null
  if (shareLike) {
    const actLike = () => void import('../service/share-like').then((m) => m.actShareLike()).catch(() => undefined)
    const dismissLike = () =>
      void import('../service/share-like').then((m) => m.dismissShareLike()).catch(() => undefined)
    shareLikeAlert = (
      <Alert
        type='info'
        showIcon
        className='py-4px'
        title='这个分享帮到你了吗?'
        action={
          <Space size={4}>
            <Button size='small' type='primary' loading={shareLike.busy} onClick={actLike}>
              👍 赞一个
            </Button>
            <Button size='small' disabled={shareLike.busy} onClick={dismissLike}>
              不了
            </Button>
          </Space>
        }
      />
    )
  }

  // 配置性空轮 (实机修复): 主题下 L1 未启用/麾下全挂起 => 出直达动作不冒充「已到池底」
  const enableDisabledL1s = () => {
    for (const id of snap.noDrawableHint?.enableableL1Ids ?? []) favoritesL1.updateL1(id, { enabled: true })
    onRefresh('refresh')
  }

  let stateAlert: ReactNode = null
  if (state === 'no-drawable') {
    const hint = snap.noDrawableHint!
    stateAlert = (
      <Alert
        type='warning'
        showIcon
        className='py-4px'
        title={
          <>
            {hint.reason}
            <Typography.Text type='secondary' className='ml-8px text-12px'>
              {dropText}
            </Typography.Text>
          </>
        }
        action={
          <Space size={4}>
            {!!hint.enableableL1Ids.length && (
              <Button size='small' type='primary' onClick={enableDisabledL1s}>
                启用一级组并重抽
              </Button>
            )}
            <Button size='small' onClick={openFavoritesPane}>
              管理收藏表
            </Button>
          </Space>
        }
      />
    )
  } else if (state === 'partition-pending' && !hidePartitionPending) {
    // 票 006: 停牌原因直说卡在哪、该点哪里 —— 全部判据来自会话镜像位, 无新增取数
    const holdReason = tagRecHoldReasonText(snap, riskControl)
    stateAlert = (
      <Alert
        type='info'
        showIcon
        className='py-4px'
        title={
          snap.partitionPending
            ? `本批 ${snap.partitionPending} 条内容待确认分区，已保留 · ${holdReason ?? '可以继续核验或调整筛选'}`
            : `本批分区筛选已暂停${holdReason ? ` · ${holdReason}` : ' · 可以继续筛选剩余候选'}`
        }
        action={
          <Button size='small' type='primary' onClick={onPartitionRetry}>
            继续筛选
          </Button>
        }
      />
    )
  } else if (actionable && state !== 'partition-pending') {
    // 票 13 D8: tab1 硬见底尾附本轮抽中组名 (中性陈述, 不写「已抽干的组」归因)
    const drawnSuffix =
      state === 'hard-bottom' && snap.drawnGroupNames?.length ? ` · 抽中组: ${snap.drawnGroupNames.join('、')}` : ''
    const title = state === 'hard-bottom' ? `本轮没有新结果${drawnSuffix}` : '池底保底已展开 · 歇息片刻后自动续挖'
    stateAlert = (
      <Alert
        type={state === 'hard-bottom' ? 'warning' : 'info'}
        showIcon
        className='py-4px'
        title={
          <>
            {title}
            <Typography.Text type='secondary' className='ml-8px text-12px'>
              {dropText}
            </Typography.Text>
            {state === 'hard-bottom' && (
              <div className='text-12px font-normal'>
                {bypassSeenOn
                  ? '当前已显示已看内容；仍无结果时，可点「重新发掘」复位本词的深挖游标，或放宽过滤条件。'
                  : '浏览过的卡片会被已看去重跳过，可以显示已看、清空已看，或「重新发掘」从头挖。'}
              </div>
            )}
          </>
        }
        action={
          state === 'hard-bottom' ? (
            <Space size={4}>
              <Button size='small' type='primary' onClick={redraw}>
                重抽一轮
              </Button>
              {onRedig && (
                <AntdTooltip
                  title='复位本查询全部深挖流的页游标（含已挖穿/冷却中的词与持久沉淀记录）并重新挖一轮；请求有界，遵守退避与限流。'
                  getPopupContainer={getPopupContainer}
                >
                  <Button size='small' loading={snap.digRunning} onClick={onRedig}>
                    重新发掘
                  </Button>
                </AntdTooltip>
              )}
              <AntdTooltip
                title='重新获取包含已看的视频，并从头发掘；本次浏览有效，重新加载页面后恢复去重，已看记录保留。'
                getPopupContainer={getPopupContainer}
              >
                <Button size='small' disabled={bypassSeenOn} onClick={bypassSeen}>
                  显示已看
                </Button>
              </AntdTooltip>
              <AntdTooltip
                title='删除已看记忆：下次刷新重新收集全部内容。与「显示已看」不同——那个只改视图不删记忆。'
                getPopupContainer={getPopupContainer}
              >
                <Button size='small' onClick={clearSeen}>
                  清空已看
                </Button>
              </AntdTooltip>
              <Button size='small' onClick={openFavoritesPane}>
                管理收藏表
              </Button>
            </Space>
          ) : (
            // 票 13 深挖待决: 手动「继续深挖」接续 —— 全部未尽深挖流各 +3 页; 在途 loading 防重点
            <Button size='small' type='primary' loading={snap.digRunning} onClick={onDigMore}>
              继续深挖
            </Button>
          )
        }
      />
    )
  }

  const idleText =
    !actionable && !hideIdleDropText ? (
      <Typography.Text type='secondary' className='text-12px'>
        {dropText}
        {/* 尾注沿用原横幅 severity 色: 池浅降级=info 蓝 (token.colorInfo, UIUX-U2-3), 软见底=warning 橙 */}
        {state === 'degraded' && <span style={{ color: token.colorInfo }}> · 池浅已放宽</span>}
        {state === 'soft-bottom' && (
          <Typography.Text type='warning' className='text-12px'>
            {' · 池将见底'}
          </Typography.Text>
        )}
      </Typography.Text>
    ) : null

  if (!riskControlAlert && !stateAlert && !idleText && !shareGuideAlert && !shareLikeAlert) return null
  return (
    <div ref={ref} className='flex basis-full flex-col gap-y-4px'>
      {riskControlAlert}
      {stateAlert}
      {idleText}
      {shareGuideAlert}
      {shareLikeAlert}
    </div>
  )
}
