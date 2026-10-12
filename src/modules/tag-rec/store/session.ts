import { proxy } from 'valtio'
import { tagRecBackoff } from '../api/backoff'
import { dedupeTagIdEntries } from '../model/favorites'
import type { TagRecFilterRoundStats, TagRecSessionFilterPatch } from '../model/filter-engine' // [tag-rec]
import type { CandidateRow } from '../model/resolve'
import type { ShareImportDraft } from '../model/share' // [tag-rec] 票 18 (tag-share)
import type { TagGroup, TagIdEntry, TagRecNegativeRules } from '../model/types'

/**
 * [tag-rec] 会话态 (spec §3.6, 不落盘)
 * tab1 = tagRecFavSession; tab2 = tagRecCustomSession; 两 tab 共享 = tagRecSharedSession
 * 选中组列表 归后续票
 */
export type Phase2Status = 'idle' | 'running' | 'done' | 'error'

/**
 * [tag-rec] 两 tab 共享会话态 (spec §3.6, 不落盘)
 * 「显示已看」(bypassSeen) 已拆为各 tab 会话自有 flag (见 tagRecFavSession / tagRecCustomSession) ——
 * 主题推荐默认滤掉已看、标签发掘默认显示已看 (调试便利); 见底横幅「临时放开已看」只写本 tab flag
 */
export const tagRecSharedSession = proxy({
  /** 挑选观看范围期间，卡片不记已看。 */
  scopeEditing: false,
  /** 清空观察记录后刷新查询；也让在途刷新识别出条件已变。 */
  recoveryRevision: 0,
  /** 风控退避态镜像 (票 16 ③): 横幅槽位消费; BackoffGate.onStateChange 驱动 */
  riskControl: false,
  /**
   * 票 18 (tag-share): 分享导入请求位 —— service/share-import 写, ui/share-import-modal 消费
   * - origin 记触发源 ('deeplink'=深链走 tabbar 挂载点 / 'paste'=粘贴走 pane 挂载点),
   *   双挂载点各自只渲自家 origin, 防 pane 开着时两处 Modal 叠开
   * - draft 经 valtio ref() 脱壳 (plan 保持 raw —— 确认落表直推 store 不碰 frozen proxy)
   */
  shareImport: {
    loading: false,
    origin: undefined as 'deeplink' | 'paste' | undefined,
    draft: undefined as ShareImportDraft | undefined,
  },
  /**
   * R7 (原票 18): 分享导入信息横幅位 (会话级一次性; 每次导入出) —— 携带包内一级组/主题:
   *   文案按「已启用/未启用」分档; [只看这个包的主题] = 查看范围 onlyThemes; [去开启] 定位
   */
  shareGuide: undefined as { l1Ids: string[]; themeIds: string[] } | undefined,
  /**
   * R7 临时打开 (会话级): 未启用 L1 的临时入抽集 —— 刷新还原, 不影响持久 enabled。
   * 主题下拉「临时打开」写, 首屏/deck 构造经 withTagRecTempEnables 合流 (deck.ts)
   */
  tempEnabledL1Ids: [] as string[],
  /** 精确到二级组的临时开启；不写入收藏表。 */
  tempEnabledGroupIds: [] as string[],
  /**
   * 票 19 (tag-share): 体验后回赞横幅位 —— service/share-like 武装
   *   (pendingShareId 在 ∧ 未赞未拒 ∧ tab1 上屏 ≥20); banner 槽位消费:
   *   state==='none' 且 shareGuide 不在时出 (同槽互斥); busy = 点赞请求在飞
   */
  shareLike: undefined as { shareId: string; busy: boolean } | undefined,
})

// 退避态进出 => 镜像进会话态 (横幅「命中风控 · 退避冷却中」)
tagRecBackoff.onStateChange = (engaged) => {
  tagRecSharedSession.riskControl = engaged
}

/** R8 临时账条目 (右键「临时 · 本会话」写入记录; 固化/清空/展示用; 仅记右键临时档, 弹层手改不入账) */
export type TagRecTempWriteKind =
  | 'upBlock'
  | 'upAllow'
  | 'titleBlock'
  | 'titleAllow'
  | 'descBlock'
  | 'descAllow'
  | 'partitionBlock'
  | 'partitionAllow'
export type TagRecTempWriteEntry = {
  kind: TagRecTempWriteKind
  /** 展示文案 (如「屏蔽 UP: 某UP」) */
  label: string
  /** 写入值 (up: {name,mid?} / 词: string / 分区: TagRecPartitionEntry) */
  value: unknown
  /** 写入时卡片的认领组名 (剥 ·相关 后缀; 固化到本组用; 可为空 => 本组档禁用) */
  owningGroupNames: string[]
  owningGroupIds?: string[] // 动作发生时的组编号，改名/同名/切组不改变固化目标
}

/** R7 临时打开读写 (会话级, 去重; 下拉「临时打开」/「保留」/取消 共用) */
export function setTagRecTempEnabled(l1Id: string, on: boolean): void {
  const list = tagRecSharedSession.tempEnabledL1Ids
  const i = list.indexOf(l1Id)
  if (on && i === -1) list.push(l1Id)
  else if (!on && i !== -1) list.splice(i, 1)
}

/** [tag-rec] 每轮滤除统计空值工厂 (spec §3.6 滤除计数: {dimension:count} 明细+合计) */
export function emptyTagRecFilterStats(): TagRecFilterRoundStats {
  return { dropped: 0, byDim: {}, degraded: false }
}

/** [tag-rec] tab1「主题推荐」会话态 (spec §3.6, 不落盘) */
export const tagRecFavSession = proxy({
  /** 「显示已看」会话 flag: 开=去已看阶段直通; 主题推荐求新, 默认关=滤掉已看 (§3.4) */
  bypassSeen: false,
  partitionPending: 0,
  partitionPaused: false,
  /** 主题推荐临时过滤绑定当前查看范围，与标签发掘独立。 */
  filterOverride: undefined as TagRecSessionFilterPatch | undefined,
  tempWriteLog: [] as TagRecTempWriteEntry[],
  filterScopeSignature: undefined as string | undefined,
  filterScopeRevision: 0,
  /** 软见底标记 (连续 2 轮产出 <5, spec §4.4; 横幅消费归票 09) */
  softBottom: false,
  /** [tag-rec] 硬见底标记 (单轮产出 0, spec §4.4; service exhaustRound 置位, 横幅消费归票 09) */
  hardBottom: false,
  /** [tag-rec] 深挖待决态镜像 (票 13: 自动深挖 K 用尽但深挖流未尽 => 停自动加载待手动「继续深挖」, 非硬见底) */
  digPending: false,
  /** [tag-rec] 手动深挖在途标记 (横幅「继续深挖」按钮 loading/防重点) */
  digRunning: false,
  /** 最近一轮抽中的组名 (tabbar 状态文本 / 归因展示) */
  drawnGroupNames: [] as string[],
  /**
   * 无可抽单位提示 (实机修复): 主题下 L1 未启用/麾下全挂起等「配置性空轮」落此而非 hardBottom ——
   *   横幅出「启用一级组」直达动作, 不冒充「已到池底」; reason = in-feed separator 同文案
   */
  noDrawableHint: undefined as { reason: string; enableableL1Ids: string[] } | undefined,
  /** [tag-rec] 最近一轮滤除统计 (分维度计数+小池降级标记; 横幅消费归票 09) */
  filterStats: emptyTagRecFilterStats(),
})

/**
 * 临时输入即草稿组 (票 14 决议): 一次查询会话 = 一个草稿组,
 * 首个临时输入命名; 负向位/严格校验持于会话不落盘。
 * 弹层 ⛔ 对未归属来源名落此;「顺手存成项」升级时负向随组入表 (票 12 联动)。
 */
export type TagRecDraftGroup = {
  name: string
  negative_tag_ids: TagIdEntry[]
  /** 草稿组严格校验开关 (会话级, 同组行 negative_strict 语义) */
  strict: boolean
  /**
   * 草稿组名单容器 (实修: 未存成项也可先屏蔽 —— resolver fallbackGroup 读位);
   * 「顺手存成项」升级时随组入表 (overrides.negative)
   */
  negative?: TagRecNegativeRules
  /** 「顺手存成项」已固化的目标组 id (实修: 存后按钮态改「并入该组」, 防误触二次建组) */
  savedGroupId?: string
}

export const tagRecCustomSession = proxy({
  /** Temporary browsing pace; absent from persisted trials and saved recipes. */
  supplyPaused: false,
  /** 「显示已看」会话 flag: 开=去已看阶段直通; 发掘语境默认开=显示已看, 便于调试观察 (§3.4) */
  bypassSeen: true,
  workingGroup: undefined as TagGroup | undefined,
  allowUnverified: false,
  partitionPending: 0,
  partitionPaused: false,
  /** 票 005: 当前到上限停轮转的停牌条数 (每轮按账目重算; 上屏「放弃 N 条」) */
  partitionAbandoned: 0,
  /** 票 006: 本轮补查额度用尽标记 (停牌原因之一; 「重试核实」/语境切换归零) */
  partitionBudgetExhausted: false,
  /** 票 006: 本次访问本地回放交付的条数 (语境切换归零; 上屏「回放 N 条」) */
  replayDelivered: 0,
  /**
   * 选条件加词后的本地先行闸 (Q5b): 加入条件先只吃本地可交付存量 (零请求), 存量耗尽或
   * 显式查找 (beginTagRecCustomQuery) 才放行远程取数 —— 低频词点击不再立即引发请求风暴。
   */
  localFirst: false,
  /** 主查询换代编号；独立扩选解析绑定此编号，切走再切回也不接受旧结果。 */
  queryRevision: 0,
  /**
   * [tag-rec] tab2 选中组 id 列表 (spec §3.6/§4.3): 会话内有效不持久; 正常+挂起可列, 停用不进
   * 票 21 M3: 保数组但限长 1 (序列化 shape 不破, UI 层收单选); 与草稿组互斥, 写入一律走
   * switchTagRecGroupContext / doResolveAnchor 清对侧
   */
  selectedGroupIds: [] as string[],

  /** 会话级草稿组: 首个临时输入自动成立 (票 14「临时输入即草稿组」) */
  draftGroup: undefined as TagRecDraftGroup | undefined,

  /** 已提交的临时输入原文: 文本 = tag 名; 纯数字 = tag_id 直输 (spec §4.1 输入分流) */
  inputText: '',
  /** service 解析回填的锚点 (tag_id + name): 草稿组命名/深挖流 key/扩选去重/存成项首成员/弹层 isAnchor/深挖与存成项门禁 */
  anchor: undefined as TagIdEntry | undefined,

  /** 候选清单行: Phase 2 产出 ({tag_name,tag_id,use,共现频次?,来源徽章,checkbox}, spec §4.2) */
  candidates: [] as CandidateRow[],
  /** [tag-rec] 候选清单收起态 (票 10): 默认收起为单行摘要不挡视频流; 展开/收起随会话, 新输入重置收起 */
  candidatesCollapsed: true,
  /** [tag-rec] 组内成员 chip 区收起态: 默认收起, 开关在候选清单动作行「存成项/并入当前组」右侧; 纯显示偏好随会话不重置 */
  membersCollapsed: true,
  /** [tag-rec] 「已扩选」chip 区收起态: 同上, 默认收起 */
  expandedCollapsed: true,
  /**
   * 「扩进本次查询」并入的 tag_id (service 每轮开头并入查询单元; 提交新输入时清空)
   * 票 22: 统一为「语境无关的会话级扩选暂存位」(试用层) —— ★「加入当前组」与下拉勾选同写此位,
   * 两语境通用; 入表统一收口到「顺手存成项/并入当前组」(选定组语境并入该组, 草稿语境升级建组);
   * 可见位 = 候选清单顶部「已扩选 N」chip 区, ✕ 即删 (下轮生效)
   */
  expandedIds: [] as TagIdEntry[],

  /** Phase 2/深挖流聚合状态 (UI 展示/「继续深挖」开关; 票 13 扩: 自动深挖计数+上轮净增) */
  phase2: {
    status: 'idle' as Phase2Status,
    pagesFetched: 0, // 已成功拉取的 all/v2 页数
    exhausted: false, // 全部深挖流尽 (all/v2 50 页截断或空页到底)
    autoDigs: 0, // 自动深挖已用次数 (票 13 D4; tab1 上限 K=3, 票 17 tab2 adaptive 无硬顶留遥测)
    lastDigYield: 0, // 上轮深挖净增条数 (横幅回响)
  },

  /** [tag-rec] 深挖待决态镜像 (票 13: 自动深挖 K 用尽但流未尽 => 停自动加载待手动; 非硬见底, 横幅新态) */
  digPending: false,
  /** 自动续挖最早到期刻镜像 (ladder.resumeAt: 休息截止∪流复探冷却; 0=无排程) —— RecGrid 续批排程订阅位 */
  digResumeAt: 0,
  /** [tag-rec] 手动深挖在途标记 (横幅「继续深挖」按钮 loading/防重点) */
  digRunning: false,

  /** 软见底标记 (连续 2 轮产出 <5, spec §4.4; 横幅消费归票 09) */
  softBottom: false,

  /** [tag-rec] 硬见底标记 (单轮产出 0 且给出见底 separator, spec §4.4; service exhaustRound 置位, 横幅消费归票 09) */
  hardBottom: false,

  /** [tag-rec] 最近一轮滤除统计 (分维度计数+小池降级标记; 横幅消费归票 09) */
  filterStats: emptyTagRecFilterStats(),

  /**
   * 当前锚点池的临时过滤差分，不落盘；表单改动/右键临时操作创建。
   * 换输入或标签组、手动清除、整页刷新时丢弃；同一锚点重查/深挖/扩选保留。
   */
  filterOverride: undefined as TagRecSessionFilterPatch | undefined,
  /** R8 临时账 (右键「临时 · 本会话」写入记录) —— 过滤弹层「临时名单」展示 + 固化/清空按账操作 */
  tempWriteLog: [] as TagRecTempWriteEntry[],
})

export type TagRecFilterSessionScope = 'fav' | 'custom'

export function tagRecFilterSession(scope: TagRecFilterSessionScope = 'custom') {
  return scope === 'fav' ? tagRecFavSession : tagRecCustomSession
}

export function resetTagRecFavFilter() {
  tagRecFavSession.filterOverride = undefined
  tagRecFavSession.tempWriteLog = []
}

/** 同范围重刷保留临时过滤；切换观看范围时解除，并关闭旧编辑面板。 */
export function syncTagRecFavFilterScope(signature: string) {
  const previous = tagRecFavSession.filterScopeSignature
  if (previous !== undefined && signature !== previous) {
    resetTagRecFavFilter()
    tagRecFavSession.filterScopeRevision++
  }
  tagRecFavSession.filterScopeSignature = signature
}

/** 清除本锚点的全部临时过滤及右键账本，回到「标签过滤」。 */
export function resetTagRecCustomFilter() {
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.tempWriteLog = []
}

/** 重置解析进度；过滤的去留由输入/选组入口按查询语境决定。 */
function resetTagRecCustomQueryState(inputText: string) {
  tagRecCustomSession.queryRevision++
  tagRecCustomSession.inputText = inputText
  tagRecCustomSession.anchor = undefined
  tagRecCustomSession.candidates = []
  tagRecCustomSession.candidatesCollapsed = true
  tagRecCustomSession.expandedIds = []
  tagRecCustomSession.phase2 = { status: 'idle', pagesFetched: 0, exhausted: false, autoDigs: 0, lastDigYield: 0 }
  tagRecCustomSession.digPending = false
  tagRecCustomSession.digResumeAt = 0 // 换查询语境 => 旧语境的休息/冷却排程作废
  tagRecCustomSession.digRunning = false
  tagRecCustomSession.softBottom = false
  tagRecCustomSession.hardBottom = false // [tag-rec]
  tagRecCustomSession.filterStats = emptyTagRecFilterStats() // [tag-rec]
  tagRecCustomSession.draftGroup = undefined // 草稿组随新输入重建
}

/** 提交新输入；换锚点清除临时过滤，同一输入重查保留。 */
export function beginTagRecCustomQuery(raw: string) {
  const inputText = raw.trim()
  // Q5b: 显式查找 = 用户主动要货, 解除加词后的本地先行闸, 立即放行远程取数
  tagRecCustomSession.localFirst = false
  if (inputText !== tagRecCustomSession.inputText || tagRecCustomSession.selectedGroupIds.length > 0) {
    resetTagRecCustomFilter()
  }
  resetTagRecCustomQueryState(inputText)
}

/**
 * 票 21 组语境互斥: tab2 同时只允许一个组语境 —— 选定组 × 草稿组双向互斥, 后动作者赢。
 * 选择器选组/清选 => 弃临时输入侧: 整段查询态重置 (等价 beginTagRecCustomQuery(''),
 * 含 inputText/anchor/draftGroup/candidates/expandedIds/phase2/见底镜像), 再立选定组 (限长 1)。
 * 草稿组非空判定 + 「顺手存入」落表在 UI 侧先于本动作执行 (tabbar-custom GroupSelect);
 * 反向 (输入解析成功 => 清选定组) 挂点在 service doResolveAnchor
 */
export function switchTagRecGroupContext(groupId: string | undefined) {
  const selectedIds = tagRecCustomSession.selectedGroupIds
  const sameGroup = groupId ? selectedIds.length === 1 && selectedIds[0] === groupId : selectedIds.length === 0
  if (tagRecCustomSession.inputText || !sameGroup) resetTagRecCustomFilter()
  resetTagRecCustomQueryState('') // 弃临时输入侧整段查询态 (草稿组随弃)
  tagRecCustomSession.selectedGroupIds = groupId ? [groupId] : []
}

/** 合并后跟随目标组重建查询语境；未固化的扩选保留，旧在途动作随候选引用失效。 */
export function reconcileTagRecMergedGroupContext(sourceIds: readonly string[], targetId: string) {
  const affected = new Set([...sourceIds, targetId])
  if (tagRecCustomSession.selectedGroupIds.some((id) => affected.has(id))) {
    const expanded = [...tagRecCustomSession.expandedIds]
    // 合并是原查询组的延续，保留临时过滤；主动选择别的组才清除。
    resetTagRecCustomQueryState('')
    tagRecCustomSession.selectedGroupIds = [targetId]
    tagRecCustomSession.expandedIds = expanded
  } else if (
    tagRecCustomSession.draftGroup?.savedGroupId &&
    affected.has(tagRecCustomSession.draftGroup.savedGroupId)
  ) {
    tagRecCustomSession.draftGroup.savedGroupId = targetId
    tagRecCustomSession.candidates = [...tagRecCustomSession.candidates]
  }
}

// ———— 票 22: expandedIds 扩选暂存位读写收口 (语境无关) ————

/**
 * 扩选暂存位写入 (★「加入当前组」/ 下拉「扩进本次查询」共用):
 * 去重 = 已在暂存位 / 锚点自身 / 当前组真成员 (currentGroupTagIds, 选定组语境传入) 全跳过;
 * 入参内部同 id 亦去重。新增成功的行顺手同步候选行 expanded (「已并入」徽标;
 * checked 不伪造 —— 勾中=用户并入意图, 候选行是 saveAsFavoriteGroup 的并入来源,
 * 伪造勾中会让 ✕ 取消后该 tag 仍经勾中行并入)。返回实际并入的条目
 */
export function pushExpandedIds(entries: readonly TagIdEntry[], currentGroupTagIds: readonly TagIdEntry[] = []) {
  const have = new Set(tagRecCustomSession.expandedIds.map((e) => e.id))
  if (tagRecCustomSession.anchor) have.add(tagRecCustomSession.anchor.id)
  for (const e of currentGroupTagIds) have.add(e.id)
  const adds = dedupeTagIdEntries(entries).filter((e) => !have.has(e.id))
  if (!adds.length) return [] as TagIdEntry[]
  tagRecCustomSession.expandedIds.push(...adds)
  const ids = new Set(adds.map((e) => e.id))
  for (const c of tagRecCustomSession.candidates) {
    if (c.tag_id !== undefined && ids.has(c.tag_id)) c.expanded = true
  }
  return adds
}

/**
 * 扩选区 chip ✕ 取消 (票 22): 只删会话级暂存位 (下轮不再进查询单元), 不动已入表的组内容;
 * 对应候选行 expanded+checked 一并清回 —— 实机修复: 仅清 expanded 留 checked, 勾中行仍是
 * 「顺手存成项/并入当前组」的并入来源, 取消的 tag 会照旧入组
 */
export function removeExpandedId(tagId: number) {
  const i = tagRecCustomSession.expandedIds.findIndex((e) => e.id === tagId)
  if (i === -1) return
  tagRecCustomSession.expandedIds.splice(i, 1)
  for (const c of tagRecCustomSession.candidates) {
    if (c.expanded && c.tag_id === tagId) {
      c.expanded = false
      c.checked = false
    }
  }
}
