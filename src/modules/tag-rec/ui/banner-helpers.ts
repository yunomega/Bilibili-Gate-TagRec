import type { TagRecDropDimKey, TagRecFilterRoundStats } from '../model/filter-engine'

/**
 * [tag-rec] 横幅槽位纯逻辑 (spec §5.4, 票 09) —— 三态互斥判定 + 滤除计数文案
 * 无 React 依赖, 便于单测; 组件在 ./banner.tsx
 */

/**
 * 横幅消费的会话最小切片: tab1=tagRecFavSession / tab2=tagRecCustomSession (spec §3.6)
 *
 * 硬见底判据 = session.hardBottom 镜像 (service 单轮产出 0 => exhaustRound 置位):
 *   不直接用 service.hasMoreExceptQueue —— tab2「未输入/解析失败」同样翻 false 且非响应式
 */
export type TagRecBannerSource = {
  partitionPending?: number
  partitionPaused?: boolean
  /** 票 005: 当前到上限停轮转的停牌条数 (仅 tab2 有) */
  partitionAbandoned?: number
  /** 「先看缓存」供给暂停闸 (仅 tab2 有; 停牌原因判据之一) */
  supplyPaused?: boolean
  /** 本轮补查额度用尽标记 (仅 tab2 有; 停牌原因判据之一) */
  partitionBudgetExhausted?: boolean
  /** 硬见底: 单轮产出 0 (service 已发见底 separator + hasMoreExceptQueue=false, spec §4.4) */
  hardBottom: boolean
  /** 软见底: 连续 2 轮产出 <5 (预警不阻断) */
  softBottom: boolean
  /** 最近一轮滤除统计 (degraded = 小池降级标记, spec §3.3) */
  filterStats: TagRecFilterRoundStats
  /**
   * 深挖待决态 (票 13): 主池+兜底堆已光且自动深挖 K 用尽, 但深挖流未尽 —
   * 自动加载已截停待手动「继续深挖」; 硬见底之前的中间横幅态
   */
  digPending?: boolean
  /** 手动深挖在途 (票 13:「继续深挖」按钮 loading + 待决态保持不清) */
  digRunning?: boolean
  /** tab1 本轮抽中组名 (票 13 D8: 硬见底横幅尾附中性归因「抽中组: A、B」) */
  drawnGroupNames?: string[]
  /** 无可抽单位 (配置性空轮, 实机修复): reason=提示文案, enableableL1Ids=可一键启用的未启用一级组 */
  noDrawableHint?: { reason: string; enableableL1Ids: string[] }
  /** 本 tab「显示已看」会话 flag (tab1 默认开 / tab2 默认关; 「临时放开已看」按钮写本 flag) */
  bypassSeen?: boolean
}

/** 互斥按严重度: 无可抽(配置性) > 硬见底 > 深挖待决 > 软见底 > 池浅降级; 'none' = 空态只常显滤除计数 */
export type TagRecBannerState =
  | 'no-drawable'
  | 'partition-pending'
  | 'hard-bottom'
  | 'dig-pending'
  | 'soft-bottom'
  | 'degraded'
  | 'none'

export function resolveTagRecBannerState(s: TagRecBannerSource): TagRecBannerState {
  if (s.noDrawableHint) return 'no-drawable'
  if (s.partitionPaused) return 'partition-pending'
  if (s.hardBottom) return 'hard-bottom'
  if (s.digPending) return 'dig-pending'
  if (s.softBottom) return 'soft-bottom'
  if (s.filterStats.degraded) return 'degraded'
  return 'none'
}

/**
 * 票 006: 停牌原因文案 —— "待核实 N 条"旁边必须说清卡在哪个闸、该点哪里。
 *   判据全部来自会话镜像位 (无新增取数); 返回 undefined = 无闸无放弃, 不编造原因。
 *   优先级: 风控退避 (等) > 供给暂停「先看缓存」(取消勾选) > 额度用尽 (重试/下轮) > 放弃计数 (重试核实)
 */
export function tagRecHoldReasonText(
  s: Pick<TagRecBannerSource, 'supplyPaused' | 'partitionAbandoned' | 'partitionBudgetExhausted'>,
  riskControl?: boolean,
): string | undefined {
  if (riskControl) return '风控退避中，分区核验已暂停 · 恢复后自动继续'
  if (s.supplyPaused) return '「先看缓存」开着，已暂停取新 · 核验与深挖照常；恢复取新可取消勾选'
  if (s.partitionBudgetExhausted) return '本轮补查额度用尽 · 已核实内容照常交付，后续自动续查'
  if ((s.partitionAbandoned ?? 0) > 0)
    return `其中 ${s.partitionAbandoned} 条多轮未核实 · 已降频轮转重试，核实通过即自动放行`
  return undefined
}

/** 滤除维度键 => 中文名 (spec §5.4「按维度分解」; 穷尽映射, 漏键编译错) */
export const TAG_REC_DROP_DIM_LABELS: Record<TagRecDropDimKey, string> = {
  combination: '组合条件',
  blacklist: '负向',
  viewMin: '播放下限',
  viewMax: '播放上限',
  likeMin: '点赞下限',
  likeMax: '点赞上限',
  favMin: '收藏下限',
  favMax: '收藏上限',
  coinMin: '投币下限',
  coinMax: '投币上限',
  danmakuMin: '弹幕下限',
  danmakuMax: '弹幕上限',
  replyMin: '评论下限',
  replyMax: '评论上限',
  shareMin: '分享下限',
  shareMax: '分享上限',
  likeRate: '点赞率',
  favRate: '收藏率',
  coinRate: '投币率',
  interactRate: '互动率',
  shareRate: '分享率',
  duration: '时长',
  pubdate: '发布时间',
  upBlacklist: 'UP主',
  descKeywords: '简介屏蔽词',
  partitionBlock: '分区屏蔽',
  partitionAllow: '分区仅看',
  titleKeywords: '标题关键词',
  upAllow: 'UP仅看',
  titleAllow: '标题仅看',
  descAllow: '简介仅看',
  tagBlock: '标签屏蔽',
  tagAllow: '标签仅看',
  poolFilter: '池筛选',
  minScore: '综合分',
}

/** 名单来源 scope 豁免名单 (尾注只列组级来源; 全局/会话是默认层不赘述) */
const SCOPE_TAIL_SKIP = new Set(['全局', '会话'])

/**
 * 滤除计数文案 (spec §5.4): 「本轮滤除 N 条(负向 x·阈值 y)」按 byDim 分维度分解
 * dropped=0 时更简洁; byDim 明细顺序 = filter-engine 首命中归因评估序 (黑名单维在最前);
 * stats.unchecked>0 => 尾附「未校验 N」 (严格校验未核查放行条数, 票 14);
 * 票12 尾注: byScope 双键聚合出组级/L1 来源 => 尾附「组「X」滤 n · 组「Y」滤 m」(top2, 余等)
 */
export function formatTagRecDroppedText(stats: TagRecFilterRoundStats, short = false): string {
  const { dropped, byDim, unchecked, byScope } = stats
  const uncheckedText = unchecked ? ` · 未校验 ${unchecked}` : ''
  const seenText = stats.seenDropped ? ` · 已看跳过 ${stats.seenDropped} 条` : ''
  const lead = short ? '滤除' : '本轮滤除' // short: tab2 顶行精简位
  if (!dropped) return `${lead} 0 条${uncheckedText}${seenText}`
  const detail = (Object.entries(byDim) as [TagRecDropDimKey, number][])
    .filter(([, n]) => n > 0)
    .map(([dim, n]) => `${TAG_REC_DROP_DIM_LABELS[dim]} ${n}`)
    .join('·')
  // 尾注: 逐来源聚合 (维@组 双键按来源汇总) —— 组级配置的「是谁滤的」可见
  const perScope = new Map<string, number>()
  for (const [k, n] of Object.entries(byScope ?? {})) {
    const scope = k.slice(k.lastIndexOf('@') + 1)
    if (SCOPE_TAIL_SKIP.has(scope) || !n) continue
    perScope.set(scope, (perScope.get(scope) ?? 0) + n)
  }
  const scopeParts = [...perScope].sort((a, b) => b[1] - a[1])
  const scopeTail = scopeParts.length
    ? ` · ${scopeParts
        .slice(0, 2)
        .map(([s, n]) => `组「${s}」滤 ${n}`)
        .join('·')}${scopeParts.length > 2 ? ' 等' : ''}`
    : ''
  return `${lead} ${dropped} 条${detail ? `(${detail})` : ''}${uncheckedText}${scopeTail}${seenText}`
}
