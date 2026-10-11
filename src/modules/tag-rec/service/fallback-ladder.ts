import { appWarn } from '$common'
import { waitForAbortable } from '../api/abortable-promise'
import { tagRecBackoff } from '../api/backoff'
import {
  ALLV2_PAGE_CAP,
  fetchArchiveRelated,
  fetchVideoTagNames,
  type TagInfo,
  type TagTopItem,
} from '../api/endpoints'
import { tagRecRecallScheduler } from '../api/recall-scheduler'
import { tagRecDeliverable } from '../model/combination'
import {
  compareFallbackItems,
  cooccurVocab,
  countCooccurDegree,
  deriveGroupCliques,
  DIG_RECOVERY_HALF_MS,
  DIG_STREAM_WINDOW,
  digResumeFromSediment,
  newDigStream,
  selectCooccurSeeds,
  TAG_REC_AUTO_DIG_MAX,
  TAG_REC_CROSS_CLIQUE_MAX,
  TAG_REC_DIG_LOW_YIELD,
  TAG_REC_DIG_LOW_YIELD_STREAK_MAX,
  TAG_REC_FALLBACK_PAGE,
  TAG_REC_PREDIG_TRIGGER_YIELD,
  TAG_REC_SEED_COUNT,
  TAG_REC_SEED_FETCH_BUDGET,
  TAG_REC_SEED_MIN_SCORE,
  TAG_REC_SEED_POOL_MAX,
  TAG_REC_STREAM_CAP_LIFT_YIELD,
  tagRecSearchExtraOf,
  type CooccurSeedCandidate,
  type TagRecDigStream,
} from '../model/dig'
import {
  computeScore,
  projectTagRecActiveClaims,
  tagRecChainKeysOf,
  tagRecPoolScopeKey,
  tagRecPoolsForChain,
  type TagRecLadderSettings,
  type TagRecScopeResolve,
  type TagRecScoreParams,
} from '../model/filter-engine'
import { normalizeAllV2Item, normalizeTagTopItem, type AllV2VideoItem } from '../model/normalize-item'
import { mergeTagRecCandidate, tagRecGroupKey, tagRecSourceClaims } from '../model/relevance'
import { PHASE2_PAGE_BATCH, runPhase2Round, type CandidateRow, type Phase2RoundResult } from '../model/resolve'
import { sedimentClearDig, sedimentNoteProbe } from '../model/sediment'
import { sediment } from '../store'

import { pickTagRecCapacityVictim } from './capacity'
import { createTagRecBvidIndex, tagRecVersionedArray } from './deferred-candidates'
import { tagRecDiscoveryPolicy } from './discovery-policy'
import {
  planTagRecRecall,
  tagRecConsumers,
  tagRecConsumerSource,
  type TagRecConsumer,
  type TagRecRecallPlan,
} from './recall-plan'
import { TagRecRecheckExecutor, type TagRecRecheckSelection } from './recheck'
import type { TagRecItemExtend, TagRecSourceClaim } from '$define'
import type { TagGroup } from '../model/types'

/**
 * [tag-rec] 冷池兜底梯队编排器 (票 13 D1~D8) —— tab1/tab2 共用
 *
 * 干轮次序: related 共现滚动选种 => 兜底堆按相关性与质量放行一页 => all/v2 自动深挖 <=K
 *           => 仍无货 & 有流可挖 => 手动横幅待决 => 全尽 => 硬见底
 *
 * 差异经 hooks 注入: tab2 传 mergeCandidates/mergeVariants/isStale; tab1 只给队/阶段/算分参数。
 * 全部取数走 endpoints 统一通道 (退避/指纹/限流免费叠加, 票 16)。
 *
 * 票 17 第三刀「深挖策略分家」: 机制共用, 策略参数分家 (FallbackLadderStrategy)
 * - tab1 保守 (缺省): 仅干轮起梯队 + 自动深挖 fixed K=3 转手动横幅 —— 与票 13 行为等价
 * - tab2 激进: 浅水位 (产出 <triggerYield 未干透) 同轮顺手一发 digPass('auto') 预挖
 *   + 自动深挖 adaptive 不设硬上限, 三停转手动 (零产出早停/风控门/低产连停)
 */

export type FallbackLadderHooks = {
  /** service 级跨轮 bvid 去重集合 (堆/队共用) */
  seenBvids: Set<string>
  /**
   * 旁路产出经同一管线 (filter=>score=>seen)。
   * ctx.poolSize (票06): 兜底堆放行页注入「放行时堆深」当小池降级分母 ——
   *   页长 ≤20 < 阈值 30 是切片伪影, 堆真见底才该降级; 缺省 = items.length
   */
  applyStages: (
    items: TagRecItemExtend[],
    ctx?: { poolSize?: number; poolItems?: readonly TagRecItemExtend[]; mergeStats?: boolean },
  ) => TagRecItemExtend[]
  rankItems?: (items: TagRecItemExtend[]) => TagRecItemExtend[]
  mergeExisting?: (item: TagRecItemExtend) => TagRecItemExtend | undefined
  seedMinScoreOf?: (item: TagRecItemExtend) => number
  /** exact 条目入队回调 (qs.bufferQueue.push) */
  pushQueue: (items: TagRecItemExtend[]) => void
  /** 队列现存量 (在途深挖刚落的货 => 本轮直接放行) */
  queueSize: () => number
  /** 热组有货不代表欠供给组有可交付货。 */
  hasDemandStock?: () => boolean
  poolItems?: () => readonly TagRecItemExtend[]
  candidateScope?: () => { needed: ReadonlySet<string>; all: ReadonlySet<string> }
  /** 逐条目算分参数 (票05 paramsOf: via=>池槽求解; 堆排序/选种门槛) */
  scoreParams: (item: TagRecItemExtend) => TagRecScoreParams
  /** 候选清单合并 (tab2 专属; 共现行进清单) */
  mergeCandidates?: (rows: CandidateRow[]) => void
  /** 字形变体并入查询单元 (tab2 输入流专属) */
  mergeVariants?: (entries: TagInfo[]) => void
  /** 会话写入守门 (service 已过期 => 跳过清单/变体写; 条目吸收与 sediment 照走) */
  isStale?: () => boolean
  resolve?: () => TagRecScopeResolve
  /**
   * 交集收窄衔接 (死库存源头): related 路由在交集下只是兜底料 —— 兜底门 (degraded) 不开时
   *   选种产物永远停在待核实, 只堆不吐; 返回 false => maybeSeedRelated 整轮跳过
   *   (选种要烧名单补查 + archive/related 页请求, 这些火力交集下应留给 all/v2)。
   */
  relatedSeedingAllowed?: () => boolean
  /**
   * 「显示已看」会话 flag —— 按调用方 scope 注入 (tab1=tagRecFavSession / tab2=tagRecCustomSession);
   * 缺省 false (= 滤掉已看, sediment 游标照常落盘/水合)
   */
  bypassSeen?: () => boolean
  policySignature?: () => string
  observe?: (items: TagRecItemExtend[]) => void
  recallPlan?: () => TagRecRecallPlan
}

export type FallbackLadderResult =
  | { kind: 'items'; items: TagRecItemExtend[] }
  | { kind: 'manual-pending' }
  | { kind: 'hard-bottom' }
  | { kind: 'source-unavailable'; reason: string }
  | { kind: 'retry-later'; reason: string }
  | { kind: 'aborted' }

/**
 * 深挖策略 (票 17「策略分家」): 梯队机制共用, 参数分家 —— 缺省 = tab1 保守现状
 */
export type FallbackLadderStrategy = {
  /**
   * 梯队介入阈值: 本轮主池产出 < 此值 (service 侧判据).
   * =1 => 仅干轮 (产出=0) 起全梯队; >1 => 浅水位 (产出 1~N-1) 同轮顺手一发 preDig
   */
  triggerYield: number
  /**
   * 自动深挖上限策略 (三停前两条两模式共用: 零产出早停 + tagRecBackoff 风控门):
   * - fixed: autoDigs >= max 停自动转手动待决 (票 13 现状 K=3)
   * - adaptive: 不设硬上限 (autoDigs 仍累计留遥测), 第三停 = 连续 lowYieldStreakLimit
   *   轮低产 (0<yield<lowYield) 停自动转手动; 丰产轮清零连续计数
   */
  autoDig: { mode: 'fixed'; max: number } | { mode: 'adaptive'; lowYield: number; lowYieldStreakLimit: number }
  /**
   * 梯队高级参数覆盖 (filter-scope 票10: settings.tagRec.ladder 注入) ——
   * getter 读取保热更 (与 hooks.scoreParams 同惯例); 缺省各键走 model/dig 常量出厂值
   */
  ladder?: () => Partial<TagRecLadderSettings>
}

/** ladder 旋钮取数: 覆盖值 > 常量出厂值 */
export const LADDER_DEFAULTS = {
  seedPoolMax: TAG_REC_SEED_POOL_MAX,
  seedCount: TAG_REC_SEED_COUNT,
  seedMinScore: TAG_REC_SEED_MIN_SCORE,
  fallbackPage: TAG_REC_FALLBACK_PAGE,
  digStreamWindow: DIG_STREAM_WINDOW,
} as const

/**
 * W3-3: 共享态集合硬界 —— 语义不受影响的安全垫 (截尾丢的都是排序尾部/陈旧扫描料)
 * - heap: 兜底堆放行时逐条算分+全排 O(N log N), 无界 => 深挖重负载每干轮主线程重扫
 * - exactPoolItems: 只做选种扫描原料 (:571 并池), 留旧料无收益
 * - streams: exhausted 流游标已由 sediment.noteDig 持久 (重建水合回), 驻留无意义
 */
export const LADDER_HEAP_MAX = 500
export const LADDER_EXACT_POOL_MAX = 500
const LADDER_STREAMS_MAX = 64

/**
 * W3-6: settings.tagRec.ladder 七键可 GM 直改/导入注入绕过 UI 校验 (对照 seenCap 同款面):
 * 消费点统一钳制 —— digStreamWindow/autoDigMax/seedCount 放任值 = 并发请求洪泛。
 */
const LADDER_BOUNDS = {
  triggerYield: [1, 50],
  autoDigMax: [1, 20],
  digStreamWindow: [1, 8],
  seedPoolMax: [10, 200],
  seedCount: [1, 10],
  seedMinScore: [0, 100],
  fallbackPage: [5, 50],
}
const clampLadderNum = (k: keyof typeof LADDER_BOUNDS, v: number | undefined): number | undefined => {
  if (v === undefined) return undefined
  if (!Number.isFinite(v)) return undefined
  const [lo, hi] = LADDER_BOUNDS[k as keyof typeof LADDER_BOUNDS]
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
function clampTagRecLadderOpts(o: Partial<TagRecLadderSettings>): Partial<TagRecLadderSettings> {
  const out: Partial<TagRecLadderSettings> = {}
  for (const k of Object.keys(LADDER_BOUNDS) as (keyof typeof LADDER_BOUNDS)[]) {
    const v = clampLadderNum(k, o[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

/** tab1 保守档 (= 票 13 现状): 仅干轮起梯队 + 自动深挖 K=3 转手动横幅 */
export const FALLBACK_LADDER_STRATEGY_CONSERVATIVE: FallbackLadderStrategy = {
  triggerYield: 1,
  autoDig: { mode: 'fixed', max: TAG_REC_AUTO_DIG_MAX },
}

/** tab2 激进档 (票 17): 浅水位 <10 预挖 + 自适应无限深挖 (连续 2 轮 <3 条低产停) */
export const FALLBACK_LADDER_STRATEGY_AGGRESSIVE: FallbackLadderStrategy = {
  triggerYield: TAG_REC_PREDIG_TRIGGER_YIELD,
  autoDig: {
    mode: 'adaptive',
    lowYield: TAG_REC_DIG_LOW_YIELD,
    lowYieldStreakLimit: TAG_REC_DIG_LOW_YIELD_STREAK_MAX,
  },
}

/**
 * 票 37: 梯队可共享状态盒 —— service 重建(刷新)时同签名续挖, 不重付页游标/堆/选种/纪律计数
 * 全字段可变引用透传 (Map/数组原地突变即共享)
 * AUDIT-10: digRunning 在途 promise 也入盒 —— 实例级会让重建后的新 ladder 并发第二条 doDigPass,
 *   两 pass 读同批共享 stream 各自 nextPage += batch 双倍推进 (中间页永久跳挖 + noteDig 错续)
 * AUDIT-20: tagCursors/queryCursor 轮转游标同入盒 —— 实例级游标随 refresh 归零, >10 id 大组
 *   永远重拉首片 (contributed=0 → 干态标干 → ids 11..N 会话内饿死); 签名变随盒同清
 * AUDIT-15: epoch 共享态纪元 —— reset 递增; 在途 digPass 开跑时快照纪元, 落定比对:
 *   跨纪元批产出 (=旧境货, 如被弃预热 service 的裸-signal 批) 不落共享盒/堆/池, 也不计入 lastDigYield;
 *   语义比「service 钉点 stale」准 —— fetchMore 自愈续跑的实例在新纪元下的产出仍照常放行
 */
export interface TagRecLadderSharedState {
  streams: Map<string, TagRecDigStream>
  heap: TagRecItemExtend[]
  poolItems: TagRecItemExtend[]
  exactPoolItems: TagRecItemExtend[]
  autoDigs: number
  earlyStopped: boolean
  earlyStopReason?: 'empty' | 'yield'
  lowYieldStreak: number
  relatedSeeded: boolean
  pagesFetched: number
  lastDigYield: number
  lastDigError: boolean
  /**
   * 已当过种子的 bvid 集 (filter-scope 票10 选种滚动化): 每干轮重估 top3 时排除已选,
   * 选种不再是「前 12 条一次性锁死」; 随语境签名重置
   */
  seededBvids: Set<string>
  /** 已付种子回包随有界内存原料保留，来源改动可按合法消费者重新挂归属。 */
  seedRequests: Map<
    string,
    { promise: Promise<TagTopItem[] | undefined>; owners: Set<string>; settled: boolean; size: number }
  >
  seedScanCursor: number
  /** 本语境累计净产出，仅作诊断；另一组的历史产出不关闭冷组选种。 */
  producedTotal: number
  /** 在途 digPass (单飞 promise; reset 清位让新语境即刻开挖 —— 旧 pass 在已 detach 的流对象上收尾, 见 digPass 身份校验) */
  digRunning: Promise<number> | undefined
  /** 内层 tag 轮转游标: L2 组id => {游标, 该组 tag_ids 签名} —— AUDIT-A1-5 按组精确失效:
   *  语境签名变不再全清 (成员集未变的组续轮不回首片); sig 不符即该组 tag_ids 已变 => 自失效归零 */
  tagCursors: Map<string, { cursor: number; sig: string }>
  /** 输入单元 (锚点+变体+扩选) 轮转游标 —— tab2 专属非标量组游标 */
  queryCursor: number
  wordCursor: number
  wordWindow: Set<string>
  rechecks: TagRecRecheckExecutor
  /** 共享态纪元: reset 递增; digPass 快照比对, 跨纪元产出不落共享盒 (AUDIT-15) */
  epoch: number
  /**
   * 存货盒纪元: 只在「盒体清空/换盒」时递增 (resetTagRecLadderState + trialStashRestore)。
   *   同试验配方编辑/过滤拨片只 bump epoch 不换盒 —— 在途批已付页按它照常收编,
   *   不再作废重拉; 换盒时旧境产出一概不落 (W1-1 跨盒丢弃语义由它继承)
   */
  stockEpoch: number
  /** Explicit cursor resets invalidate pending page/probe commits, without discarding stock. */
  digCursorEpoch: number
}

/** 兜底堆写版本: heap 数组经 Proxy 拦写自增 —— bvid 懒索引的等长换血检出依据 */
let tagRecHeapSeq = 0
export function tagRecHeapVersion() {
  return tagRecHeapSeq
}
const wrapTagRecHeap = (init: readonly TagRecItemExtend[] = []) =>
  tagRecVersionedArray<TagRecItemExtend>(() => tagRecHeapSeq++, init)

export function newTagRecLadderState(): TagRecLadderSharedState {
  return {
    streams: new Map(),
    heap: wrapTagRecHeap(),
    poolItems: [],
    exactPoolItems: [],
    autoDigs: 0,
    earlyStopped: false,
    lowYieldStreak: 0,
    relatedSeeded: false,
    pagesFetched: 0,
    lastDigYield: 0,
    lastDigError: false,
    seededBvids: new Set(),
    seedRequests: new Map(),
    seedScanCursor: 0,
    producedTotal: 0,
    digRunning: undefined,
    tagCursors: new Map(),
    queryCursor: 0,
    wordCursor: 0,
    wordWindow: new Set(),
    rechecks: new TagRecRecheckExecutor(),
    epoch: 0,
    stockEpoch: 0,
    digCursorEpoch: 0,
  }
}

/** 语境签名变 => 原地重置 (共享引用不换壳, 持有方无感) */
export function resetTagRecLadderState(s: TagRecLadderSharedState, preserveBudget = false) {
  s.streams.clear()
  s.heap.length = 0
  s.poolItems.length = 0
  s.exactPoolItems.length = 0
  if (!preserveBudget) s.autoDigs = 0
  s.earlyStopped = false
  s.earlyStopReason = undefined
  s.lowYieldStreak = 0
  s.relatedSeeded = false
  s.pagesFetched = 0
  s.lastDigYield = 0
  s.lastDigError = false
  s.seededBvids.clear()
  s.seedRequests.clear()
  s.seedScanCursor = 0
  s.producedTotal = 0
  // AUDIT-10/20: 语境换 => 轮转游标随盒清 (成员集变=切片语义变); digRunning 清位放新语境即刻开挖,
  //   在途旧 pass 的 .finally 有身份校验 (digPass) 不会误摘新 pass 的字段
  s.digRunning = undefined
  // AUDIT-A1-5: tagCursors 不随 reset 全清 —— 条目自带 tag_ids 签名自失效;
  //   「改别组资格字段 → 全部大组回首片重拉」的过宽清除面收窄为按组失效
  s.queryCursor = 0
  s.wordCursor = 0
  s.wordWindow.clear()
  s.epoch++ // AUDIT-15: 纪元递增 —— 在途批落定即知共享盒已换语境, 旧境产出丢弃
  s.stockEpoch++ // 收编票: reset 即换盒 —— digPass/选种按它判「同股批可收编, 跨盒批丢弃」
}

export class TagRecFallbackLadder {
  private streamIdentity(stream: Pick<TagRecDigStream, 'key' | 'keyword'>) {
    return JSON.stringify([stream.key, stream.keyword])
  }
  /** 兜底堆: all/v2 related + archive/related (放行时按分排序取页) */
  get heap() {
    return this.s.heap
  }
  set heap(v: TagRecItemExtend[]) {
    this.s.heap = wrapTagRecHeap(v) // 整体换壳也重包版本化数组, 防裸数组写入逃逸版本计数
  }
  /** 堆内 bvid 懒索引: acceptNormalized 每条到达物 findIndex 全扫 => O(items×heap) */
  private heapBvidIndex = createTagRecBvidIndex(() => this.s.heap, tagRecHeapVersion)
  /** all/v2 深挖流 (norm => 流): 输入锚点流 / 组同义词簇流 */
  get streams() {
    return this.s.streams
  }
  /** tag/top 池累计条目 (选种扫描原料; 热池判据已改 producedTotal, 本池只管「扫谁」) */
  get poolItems() {
    return this.s.poolItems
  }
  /** all/v2 exact 归一条目累计 (自带 tag 名单的免费种材) */
  get exactPoolItems() {
    return this.s.exactPoolItems
  }

  get autoDigs() {
    return this.s.autoDigs
  }
  set autoDigs(v: number) {
    this.s.autoDigs = v
  }
  get earlyStopped() {
    return this.s.earlyStopped
  }
  set earlyStopped(v: boolean) {
    this.s.earlyStopped = v
  } // D4 早停: 上轮深挖净增 0 => 衰减死区不白烧
  /** adaptive 低产连停计数 (票 17): 连续 0<净增<lowYield 的自动深挖发数; fixed 档恒 0 不参判 */
  get lowYieldStreak() {
    return this.s.lowYieldStreak
  }
  set lowYieldStreak(v: number) {
    this.s.lowYieldStreak = v
  }
  get relatedSeeded() {
    return this.s.relatedSeeded
  }
  set relatedSeeded(v: boolean) {
    this.s.relatedSeeded = v
  } // 兼容停止标记；正常滚动选种由已选 BV 与每轮预算控制。

  /** 每轮净产出诊断，不用于跨组关闭发掘。 */
  noteProduce(n: number) {
    this.s.producedTotal += n
  }
  get pagesFetched() {
    return this.s.pagesFetched
  }
  set pagesFetched(v: number) {
    this.s.pagesFetched = v
  } // 全部深挖流聚合页数 (phase2.pagesFetched)
  get lastDigYield() {
    return this.s.lastDigYield
  }
  set lastDigYield(v: number) {
    this.s.lastDigYield = v
  } // 上轮深挖净增 (横幅回响)
  get lastDigError() {
    return this.s.lastDigError
  }
  set lastDigError(v: boolean) {
    this.s.lastDigError = v
  } // 上轮 dig 全部流失败 (phase2.status=error 退化)
  /** 单飞深挖在途 promise —— AUDIT-10: 升共享盒 (跨实例单飞, 防并发 pass 双倍推进共享流游标) */
  get digRunning() {
    return this.s.digRunning
  }
  /** 票 38 D: 已消费过半批的退避恢复时刻 (=tagRecBackoff.lastRecoveredAt 快照; 一次性消费去重, 实例级) */
  private digRecoveryConsumedAt = 0

  constructor(
    private readonly hooks: FallbackLadderHooks,
    readonly strategy: FallbackLadderStrategy = FALLBACK_LADDER_STRATEGY_CONSERVATIVE,
    private readonly s: TagRecLadderSharedState = newTagRecLadderState(),
  ) {}

  private stale() {
    return this.hooks.isStale?.() === true
  }
  private bypassSeen() {
    return this.hooks.bypassSeen?.() ?? false
  }
  private hasDemandStock() {
    return this.hooks.hasDemandStock?.() ?? this.hooks.queueSize() > 0
  }

  /** 梯队旋钮合并读 (票10): strategy.ladder getter 快照, 缺省={}; W3-6 出参过钳制 */
  private ladderOpts(): Partial<TagRecLadderSettings> {
    return clampTagRecLadderOpts(this.strategy.ladder?.() ?? {})
  }
  private autoPolicy() {
    const configured = this.strategy.ladder?.()
    if (!configured) return this.strategy.autoDig
    const p = tagRecDiscoveryPolicy(configured)
    return p.mode === 'fixed'
      ? { mode: 'fixed' as const, max: p.autoDigMax }
      : { mode: 'adaptive' as const, lowYield: p.lowYield, lowYieldStreakLimit: p.lowYieldStreakLimit }
  }

  /** 只提升未交付原料；已看/已交付仍由原有去重阶段裁掉。 */
  acceptRecheck(items: TagRecItemExtend[]) {
    const accepted = items.flatMap((item) => {
      const candidate = this.acceptNormalized(item)
      return candidate ? [candidate] : []
    })
    const staged = this.hooks.applyStages(accepted, {
      poolItems: [...(this.hooks.poolItems?.() ?? []), ...accepted],
      mergeStats: true,
    })
    this.hooks.pushQueue(staged)
    return staged.length
  }
  recheck(selection: TagRecRecheckSelection, sources: TagRecRecallPlan, signal?: AbortSignal) {
    const epoch = this.s.epoch
    const stockEpoch = this.s.stockEpoch
    const cursorEpoch = this.s.digCursorEpoch
    const match = (c: TagRecConsumer) => tagRecGroupKey(c.key) === tagRecGroupKey(selection.key)
    const plan = {
      ...sources,
      tagTop: selection.pools.includes('tagTop')
        ? sources.tagTop.flatMap((s) => {
            const consumers = s.consumers.filter(match)
            return consumers.length ? [{ ...s, ...tagRecConsumerSource(consumers), consumers }] : []
          })
        : [],
      up: selection.pools.includes('allV2')
        ? sources.up.flatMap((s) => {
            const consumers = s.consumers?.filter(match) ?? []
            return consumers.length && (!selection.keyword || s.keyword === selection.keyword)
              ? [{ ...s, ...tagRecConsumerSource(consumers), consumers }]
              : []
          })
        : [],
      dig: sources.dig.flatMap((s) => {
        if (selection.keyword && s.keyword !== selection.keyword) return []
        const exactConsumers = selection.pools.includes('allV2') ? s.exactConsumers.filter(match) : []
        const relatedConsumers = selection.pools.includes('allV2Related') ? s.relatedConsumers.filter(match) : []
        return exactConsumers.length || relatedConsumers.length ? [{ ...s, exactConsumers, relatedConsumers }] : []
      }),
      archiveConsumers: selection.pools.includes('archiveRelated') ? sources.archiveConsumers.filter(match) : [],
    }
    const seedPool = plan.archiveConsumers.length ? (this.hooks.poolItems?.() ?? []) : []
    const seedVocab = seedPool.length ? cooccurVocab(sediment.map, [...this.streams.keys()]) : new Set<string>()
    const seedMin = seedPool.length ? (this.ladderOpts().seedMinScore ?? 0) : 0
    const seedResolve = seedPool.length ? this.hooks.resolve?.() : undefined
    const seeds = seedPool.flatMap((item) => {
      const source = {
        ...item.source,
        via: 'archive-related' as const,
        claims: tagRecSourceClaims(item).map((claim) => ({ ...claim, via: 'archive-related' as const })),
      }
      const seed = { ...item, source, eligibleGroupKeys: undefined, eligiblePoolScopes: undefined }
      if (seedResolve && !projectTagRecActiveClaims(seed, seedResolve)) return []
      if (!seed.ownTagNames?.length || !countCooccurDegree(seed.ownTagNames, seedVocab)) return []
      const min = Math.max(seedMin, this.hooks.seedMinScoreOf?.(seed) ?? 0)
      const score = computeScore(seed, this.hooks.scoreParams(seed)).score
      return min > 0 && (score === undefined || score < min) ? [] : [seed]
    })
    const probe = this.probeWriter(plan)
    // 收编票: 写闸同 digPass 口径 —— 同股编辑下 accept 产物照常入队; 换盒 (stockEpoch) 才丢
    const current = () => this.s.stockEpoch === stockEpoch && this.s.digCursorEpoch === cursorEpoch && probe.current()
    return this.s.rechecks.run(JSON.stringify([epoch, cursorEpoch, selection]), {
      plan,
      seeds,
      signal,
      current,
      accept: (items) => this.acceptRecheck(items),
      mergeCorpus: (key, res) => sediment.merge(key, res.analysis.cliques),
      noteSearch: probe.note,
    })
  }
  private probeWriter(plan: TagRecRecallPlan) {
    const version = (key: string, keyword: string, scope: string) => {
      const dig = sediment.map.get(key)?.dig
      return dig?.keyword === keyword ? (dig.probes?.[scope]?.revision ?? 0) : 0
    }
    const scopes = plan.dig.flatMap((source) =>
      (
        [
          ['allV2', source.exactConsumers],
          ['allV2Related', source.relatedConsumers],
        ] as const
      ).flatMap(([pool, consumers]) =>
        consumers.map((c) => {
          const scope = tagRecPoolScopeKey(c.key, pool)
          return {
            key: source.key,
            keyword: source.keyword,
            scope,
            revision: version(source.key, source.keyword, scope),
          }
        }),
      ),
    )
    return {
      current: () => scopes.every((s) => version(s.key, s.keyword, s.scope) === s.revision),
      note: (key: string, keyword: string, empty: boolean | undefined) => {
        const ttl = (empty === undefined ? 5 : tagRecDiscoveryPolicy(this.strategy.ladder?.()).emptyTtlMinutes) * 60_000
        for (const s of scopes.filter((s) => s.key === key && s.keyword === keyword)) {
          sedimentNoteProbe(sediment.map, key, keyword, s.scope, empty, ttl, s.revision)
          s.revision = version(key, keyword, s.scope)
        }
      },
    }
  }
  private expiredProbe(stream: TagRecDigStream) {
    if (!stream.exhausted || stream.stopReason === 'cap') return false
    const source = this.plannedStream(stream)
    if (!source) return false
    const dig = sediment.map.get(stream.key)?.dig
    if (dig && dig.keyword !== stream.keyword) return false
    const fallback =
      stream.retryAt ??
      (dig?.lastAt ?? Date.now()) + tagRecDiscoveryPolicy(this.strategy.ladder?.()).emptyTtlMinutes * 60_000
    const scopes = this.hooks.resolve
      ? planTagRecRecall({ roundSources: [], digSources: [source] }, this.hooks.resolve()).dig.flatMap((s) => [
          ...s.exactConsumers.map((c) => tagRecPoolScopeKey(c.key, 'allV2')),
          ...s.relatedConsumers.map((c) => tagRecPoolScopeKey(c.key, 'allV2Related')),
        ])
      : ['default']
    return scopes.some((scope) => Date.now() >= (dig?.probes?.[scope]?.retryAt ?? fallback))
  }
  private trimSeedRequests() {
    let size = 0
    for (const entry of this.s.seedRequests.values()) size += entry.size
    while (size > LADDER_EXACT_POOL_MAX) {
      let removed = false
      for (const [bvid, entry] of this.s.seedRequests) {
        if (!entry.settled) continue
        this.s.seedRequests.delete(bvid)
        size -= entry.size
        removed = true
        break
      }
      if (!removed) break
    }
  }
  private findStream(predicate: (stream: TagRecDigStream) => boolean) {
    for (const stream of this.streams.values()) if (predicate(stream)) return stream
  }
  private async reprobeExpired(signal?: AbortSignal, manual = false): Promise<number> {
    if (
      !this.hooks.resolve ||
      signal?.aborted ||
      tagRecBackoff.isEngaged ||
      this.stale() ||
      (!manual && this.earlyStopped && this.s.earlyStopReason !== 'empty')
    )
      return 0
    const p = this.autoPolicy()
    if (!manual && (p.mode === 'fixed' ? this.autoDigs >= p.max : this.lowYieldStreak >= p.lowYieldStreakLimit))
      return 0
    const stream = this.findStream((s) => this.expiredProbe(s))
    if (!stream) return 0
    const plan = planTagRecRecall({ roundSources: [], digSources: [this.plannedStream(stream)!] }, this.hooks.resolve())
    const epoch = this.s.epoch
    const stockEpoch = this.s.stockEpoch
    const cursorEpoch = this.s.digCursorEpoch
    const probe = this.probeWriter(plan)
    const result = await this.s.rechecks.run(
      JSON.stringify(['expiry', epoch, cursorEpoch, stream.key, stream.keyword]),
      {
        plan,
        signal,
        onStart: () => {
          if (!manual) this.autoDigs++
        },
        // 收编票: 同股批收编口径 (见 digPass) —— epoch/policy/stale 不进写闸
        current: () => this.s.stockEpoch === stockEpoch && this.s.digCursorEpoch === cursorEpoch && probe.current(),
        accept: (items) => this.acceptRecheck(items),
        mergeCorpus: (key, res) => sediment.merge(key, res.analysis.cliques),
        noteSearch: probe.note,
      },
    )
    if (!result.stale && stockEpoch === this.s.stockEpoch && cursorEpoch === this.s.digCursorEpoch)
      this.lastDigError = result.failed
    return result.added
  }

  /**
   * 超 LADDER_HEAP_MAX 才重排截断；先削最大组×来源池，保护共享候选的稀缺归属。
   * 归属池深相同时丢排序尾部；exact 历史池 FIFO 截头 (只供选种扫描, 新料优先)。
   */
  private pushHeap(items: TagRecItemExtend[]) {
    if (!items.length) return
    this.heap.push(...items)
    if (this.heap.length > LADDER_HEAP_MAX) {
      this.rankItems(this.heap)
      this.heap.sort(compareFallbackItems)
      const buckets = new Map<string, Set<TagRecItemExtend>>()
      for (const item of this.heap)
        for (const key of tagRecChainKeysOf(item))
          for (const pool of tagRecPoolsForChain(item, key)) {
            const scope = tagRecPoolScopeKey(key, pool)
            const bucket = buckets.get(scope) ?? new Set()
            bucket.add(item)
            buckets.set(scope, bucket)
          }
      while (this.heap.length > LADDER_HEAP_MAX) {
        const largest = [...buckets.values()].sort((a, b) => b.size - a.size)[0]
        const victim = pickTagRecCapacityVictim(largest, buckets, this.heap.toReversed())
        if (!victim) break
        const at = this.heap.indexOf(victim)
        const [removed] = this.heap.splice(at, 1)
        for (const bucket of buckets.values()) bucket.delete(removed)
      }
    }
  }

  private rankItems(items: TagRecItemExtend[]) {
    if (this.hooks.rankItems) {
      this.hooks.rankItems(items)
      return
    }
    for (const it of items) {
      const r = computeScore(it, this.hooks.scoreParams(it))
      it.score = r.score
      it.partial = r.partial
    }
    const scores = items.flatMap((it) => (it.score === undefined ? [] : [it.score])).sort((a, b) => a - b)
    const neutral = scores.length
      ? (scores[Math.floor(scores.length / 2)] + scores[Math.floor((scores.length - 1) / 2)]) / 2
      : 50
    for (const it of items) it.qualitySortScore = it.score ?? neutral
  }

  private matchesCandidateScope(
    item: TagRecItemExtend,
    scope: ReturnType<NonNullable<FallbackLadderHooks['candidateScope']>> | undefined,
  ) {
    if (!scope) return true
    const keys = tagRecChainKeysOf(item).map(tagRecGroupKey)
    return (
      keys.some((key) => scope.needed.has(key)) ||
      (!item.source.groupIds?.length && keys.every((key) => !scope.all.has(key)))
    )
  }

  private pushExactPool(items: TagRecItemExtend[]) {
    if (!items.length) return
    this.exactPoolItems.push(...items)
    if (this.exactPoolItems.length > LADDER_EXACT_POOL_MAX) {
      this.exactPoolItems.splice(0, this.exactPoolItems.length - LADDER_EXACT_POOL_MAX)
    }
  }

  /** 干轮触发线生效值: settings.ladder.triggerYield > 策略档出厂 (service 消费) */
  effTriggerYield(): number {
    return this.ladderOpts().triggerYield ?? this.strategy.triggerYield
  }

  // #region 流管理
  /**
   * 登记深挖流 (输入锚点流 / 手工构造); key 撞车不覆盖
   * 票 36: 建流时经 `sediment.map.get(key)?.dig` 水合页游标 —— keyword 精确等值才续
   * (跨 F5/签名变的「已付费页」不再重付; 撞已有活流走 key 撞车早退, 不碰游标)
   */
  addStream(s: Omit<TagRecDigStream, 'nextPage' | 'exhausted'>) {
    if (this.findStream((stream) => this.streamIdentity(stream) === this.streamIdentity(s))) return
    this.streams.set(
      this.streams.has(s.key) ? this.streamIdentity(s) : s.key,
      newDigStream(s, this.bypassSeen() ? undefined : digResumeFromSediment(sediment.map.get(s.key), s.keyword)),
    )
  }

  /**
   * D7/D8: 组同义词簇补流 —— 组正向成员规范名归一去重成簇, 每簇一条 all/v2 流
   * 已存在的 key 合并归属组名 (跨组同簇共享一条流, 归因并集 —— 流已在游标是活的, 不水合不新建);
   * 返回新建流数; 票 36: 新建时同款 sediment dig 水合
   */
  ensureCliqueStreams(groups: readonly (Pick<TagGroup, 'name' | 'tag_ids'> & Partial<Pick<TagGroup, 'id'>>)[]): number {
    let created = 0
    const resolve = this.hooks.resolve?.()
    // 生效链词源喂给配对: 「仅看」名单成必需伪分支, 屏蔽词不进查询 (缺 resolver 时裸组合兜底)
    const all = deriveGroupCliques(
      groups.map((g) => ({
        ...g,
        extra: resolve ? tagRecSearchExtraOf(resolve(g.id ? { id: g.id } : g.name, 'allV2')) : undefined,
      })),
      Infinity,
      // 组合词配额轮转: autoDigs 单调递增当盐 —— 候选超帽时逐轮换牺牲位
      this.autoDigs,
    )
    const allowed = this.hooks.resolve
      ? planTagRecRecall({ roundSources: [], digSources: all }, this.hooks.resolve()).dig
      : all
    const scope = this.hooks.candidateScope?.()
    const demanded = scope?.all.size
      ? allowed.filter((c) => tagRecConsumers(c).some((consumer) => scope.needed.has(tagRecGroupKey(consumer.key))))
      : allowed
    const start = demanded.length ? this.s.wordCursor % demanded.length : 0
    const full = this.hooks.recallPlan?.().dig
    const selected = Array.from({ length: Math.min(5, demanded.length) }, (_, i) => {
      const c = demanded[(start + i) % demanded.length]
      return full?.find((source) => this.streamIdentity(source) === this.streamIdentity(c)) ?? c
    })
    this.s.wordWindow = new Set(selected.map((c) => this.streamIdentity(c)))
    // 组合词活流并发闸: 轮转放开 derive 窗口后, 仍只许 ≤CAP 条活 cross 流 ——
    //   到帽 pair 等既有流判干/摘空再进 (exhausted 流由 LADDER_STREAMS_MAX 惰性瘦身回收)
    let crossLive = [...this.streams.values()].filter((s) => s.crossNorms && !s.exhausted).length
    for (const c of selected) {
      const exist = this.findStream((stream) => this.streamIdentity(stream) === this.streamIdentity(c))
      if (exist) {
        for (const n of c.attribution) if (!exist.attribution.includes(n)) exist.attribution.push(n)
        if (c.groupIds?.length) exist.groupIds = [...new Set([...(exist.groupIds ?? []), ...c.groupIds])]
        // Q6b: 文本种子流上限就位 (含旧建流); 游标已越上限直接判干
        //   B: capLifted 已摘帽的流抗回补 —— 高产已验证, 不再被派生把帽按回去
        if (c.pageCap && !exist.pageCap && !exist.capLifted) {
          exist.pageCap = c.pageCap
          if (exist.nextPage > c.pageCap) {
            exist.exhausted = true
            exist.stopReason = 'cap'
          }
        }
        continue
      }
      if (c.crossNorms && crossLive >= TAG_REC_CROSS_CLIQUE_MAX) continue // 活组合词流超帽不新开
      if (c.crossNorms) crossLive++
      const stream = newDigStream(
        {
          key: c.key,
          keyword: c.keyword,
          attribution: c.attribution,
          ...(c.groupIds && { groupIds: c.groupIds }),
          ...(c.pageCap && { pageCap: c.pageCap }),
          ...(c.crossNorms && { crossNorms: c.crossNorms }),
        },
        this.bypassSeen() ? undefined : digResumeFromSediment(sediment.map.get(c.key), c.keyword),
      )
      // Q6b: sediment 水合游标可能已越过文本种子流上限 => 直接判干 (cap)
      if (stream.pageCap && stream.nextPage > stream.pageCap) {
        stream.exhausted = true
        stream.stopReason = 'cap'
      }
      this.streams.set(this.streams.has(c.key) ? this.streamIdentity(c) : c.key, stream)
      created++
    }
    while (this.streams.size > LADDER_STREAMS_MAX) {
      const victim = [...this.streams].find(([, s]) => !s.input && !this.s.wordWindow.has(this.streamIdentity(s)))
      if (!victim) break
      this.streams.delete(victim[0])
    }
    return created
  }

  /** 仍有可挖的流 (未 exhausted) */
  private plannedStream(stream: TagRecDigStream) {
    if (
      this.s.wordWindow.size &&
      !stream.input &&
      stream.groupIds?.length &&
      !this.s.wordWindow.has(this.streamIdentity(stream))
    )
      return
    if (!this.hooks.resolve) return stream
    const plan = planTagRecRecall({ roundSources: [], digSources: [stream] }, this.hooks.resolve())
    const selected = plan.dig[0]
    if (!selected) return
    const scope = this.hooks.candidateScope?.()
    if (scope?.all.size && !selected.consumers.some((c) => scope.needed.has(tagRecGroupKey(c.key)))) return
    return { ...stream, ...selected }
  }
  hasDueStreams() {
    for (const s of this.streams.values())
      if ((!s.exhausted && this.plannedStream(s)) || this.expiredProbe(s)) return true
    return false
  }

  /**
   * 「重新发掘」(硬见底出口): 把当前全部深挖流复位到第 1 页, 清 exhausted/停止原因/冷却,
   * 并清掉持久沉淀里对应的深挖游标 (票 36 —— 不清会在下次建流时把 exhausted 水合回来),
   * 同时复位自动深挖的三停纪律 (早停/低产连停)。共现边与候选/存货一概不动。
   * 请求仍有界: 由随后的一次 digPass 按既有窗口 (≤digStreamWindow 流 ×3 页) 与退避纪律执行。
   */
  resetDigCursors() {
    this.s.digCursorEpoch++
    this.s.digRunning = undefined
    for (const stream of this.streams.values()) {
      stream.nextPage = 1
      stream.exhausted = false
      stream.stopReason = undefined
      stream.retryAt = undefined
      stream.okPages?.clear() // 回绕后整段重挖: 旧位图若留着会把未拉过的页错判已付
      sedimentClearDig(sediment.map, stream.key)
    }
    this.s.earlyStopped = false
    this.s.earlyStopReason = undefined
    this.s.lowYieldStreak = 0
  }
  // #endregion

  // #region D4 深挖 (all/v2 分页批次)
  /**
   * D4 自动深挖门 (票 17 策略分家):
   *   三停共用 —— 零产出早停 (earlyStopped) / 风控退避 (tagRecBackoff) / 无流可挖;
   *   上限分策略 —— fixed: autoDigs<K; adaptive: 无硬顶, 低产连停 lowYieldStreakLimit 轮
   */
  canAutoDig() {
    if (this.earlyStopped || tagRecBackoff.isEngaged || !this.hasDueStreams()) return false
    const p = this.autoPolicy()
    if (p.mode === 'fixed') return this.autoDigs < (this.ladderOpts().autoDigMax ?? p.max)
    return this.lowYieldStreak < p.lowYieldStreakLimit
  }

  /**
   * 深挖一轮: due 流窗口内 (nextPage 升序头 DIG_STREAM_WINDOW 条, 票 38 A) 每条未 exhausted 流
   * 各 +PHASE2_PAGE_BATCH 页; 返回净入队条数 (auto 计入 autoDigs/早停)
   */
  digPass(mode: 'auto' | 'manual', signal?: AbortSignal): Promise<number> {
    // AUDIT-10: 在途 promise 存共享盒 —— service 重建后新 ladder 的 digPass 共享同一 pass
    if (!this.s.digRunning) {
      if (mode === 'auto' && !this.canAutoDig()) return Promise.resolve(0)
      const p = this.doDigPass(mode, signal).finally(() => {
        // 身份校验: resetTagRecLadderState 语境变时清位, 旧 pass 落定不误摘新 pass
        if (this.s.digRunning === p) this.s.digRunning = undefined
      })
      this.s.digRunning = p
    }
    return this.s.digRunning
  }

  /**
   * 票 32: 深挖流间并行 —— 每条流内部 3 页本就并发, 总闸仍是下游 anonGetJson tagRecLimit(4);
   * 拉取并行放, 副作用 (页游标/归因/sediment/出入队堆) 按流序串行落 (结果序不敏感, 保确定性)
   *
   * 票 38 A: due 流窗口 —— 单 pass 只挖 nextPage 升序头 DIG_STREAM_WINDOW 条 (页少先挖=公平轮转,
   * 手动/自动同限; 单 pass all/v2 发数封顶 PHASE2_PAGE_BATCH×窗口), 窗外流留待下个 digPass;
   * 票 38 D: 退避恢复后首个 pass 窗口减半探活 (按恢复时刻一次性消费, 挖完即过, pageCount 不变)
   */
  private async doDigPass(mode: 'auto' | 'manual', signal?: AbortSignal): Promise<number> {
    // W3-3: 流表惰性瘦身 —— 超 LADDER_STREAMS_MAX 才扫一轮摘 exhausted (游标已由 sediment 持久,
    //   再造时 digResumeFromSediment 水合回, 语义无损); 正常量级零成本
    if (this.streams.size > LADDER_STREAMS_MAX) {
      for (const [k, s] of this.streams) if (s.exhausted) this.streams.delete(k)
    }
    const due = [...this.streams.values()].filter(
      (s) => !s.exhausted && s.nextPage <= (s.pageCap ?? ALLV2_PAGE_CAP) && this.plannedStream(s),
    )
    if (signal?.aborted) return 0
    if (!due.length) return mode === 'manual' ? this.reprobeExpired(signal, true) : 0
    let windowSize = this.ladderOpts().digStreamWindow ?? DIG_STREAM_WINDOW
    const recoveredAt = tagRecBackoff.lastRecoveredAt ?? 0
    if (recoveredAt !== this.digRecoveryConsumedAt && tagRecBackoff.recentlyRecovered?.(DIG_RECOVERY_HALF_MS)) {
      this.digRecoveryConsumedAt = recoveredAt
      windowSize = Math.max(1, Math.ceil(windowSize / 2))
    }
    const batch = due.sort((a, b) => a.nextPage - b.nextPage).slice(0, windowSize)
    const requestPlans = new Map(batch.map((stream) => [stream, this.plannedStream(stream)!]))
    const revisionOf = (stream: TagRecDigStream) => {
      const dig = sediment.map.get(stream.key)?.dig
      return dig?.keyword === stream.keyword ? (dig.revision ?? 0) : 0
    }
    const revisions = new Map(batch.map((stream) => [stream, revisionOf(stream)]))
    if (batch.some((stream) => !stream.input)) this.s.wordCursor += batch.filter((stream) => !stream.input).length
    // AUDIT-15: 批次纪元快照 —— 拉取窗口内共享盒被 reset (语境变) 即跨纪元, 落定段产出丢弃不落盒
    // 收编票: 快照的是「存货盒纪元」非语境纪元 —— 同试验配方编辑/过滤拨片只 bump epoch
    //   不换盒, 在途批已付页照常收编 (货入队走新链重评, 不再作废重拉); reset/暂存恢复换盒
    //   => stockEpoch++ => 旧境产出一概不落。signal/stale 不进闸: service abort 只掐请求,
    //   已付完成的页写入存货盒是收益不是污染
    const stockEpoch = this.s.stockEpoch
    const cursorEpoch = this.s.digCursorEpoch
    const paidPolicy = this.autoPolicy()
    const current = () => this.s.stockEpoch === stockEpoch && this.s.digCursorEpoch === cursorEpoch
    // 实际付出在调度时记账；失败、作废响应及设置改变都不退还。
    if (mode === 'auto') this.autoDigs++
    // AUDIT-12: 每流的 PHASE2_PAGE_BATCH 页改逐页各发一轮 (pageCount=1) —— 逐页 err/allPagesFailed
    //   即页成功位图, 下游游标只推进过最高连续成功页; 整批 3 页连发时单页被拒不再跳页漏挖。
    //   每页仍走 runPhase2Round 全套 (变体解析/候选行/联想/名单落盘), 跨页聚合等价原单批语义
    //   (变体/候选按页增量 merge 幂等; suggest 仅首轮首页一发)
    // 页位图选页: 已成功页 (stream.okPages) 跳过不重付, 断点后的已付页下轮不再白挖;
    //   页号随结果随行, 落定按真页号入账 (批序即页序假设不再依赖)
    const batchPages = new Map<TagRecDigStream, number[]>()
    for (const stream of batch) {
      const pageCap = stream.pageCap ?? ALLV2_PAGE_CAP
      const pages: number[] = []
      for (let pn = stream.nextPage; pn <= pageCap && pages.length < PHASE2_PAGE_BATCH; pn++)
        if (!stream.okPages?.has(pn)) pages.push(pn)
      if (pages.length) batchPages.set(stream, pages)
    }
    const settled = await Promise.all(
      [...batchPages].map(([stream, pages]) =>
        Promise.all(
          pages.map((page, i) =>
            runPhase2Round({
              keyword: stream.keyword,
              inputNorm: stream.key,
              matchNorms: stream.crossNorms,
              anchor: stream.anchor,
              fromPage: page,
              pageCount: 1,
              withSuggest: !!stream.withSuggest && stream.nextPage === 1 && i === 0, // 仅首轮首页
              resolveVariants: !!stream.withVariants, // 组簇流省变体解析
              signal,
            }).then(
              (res) => ({ res, page }),
              (err) => ({ err, page }),
            ),
          ),
        ).then((pageSettled) => ({ stream, pageSettled })),
      ),
    )
    let yieldN = 0
    let attempted = 0
    let failed = 0
    for (const { stream, pageSettled } of settled) {
      if (!current()) break
      if (revisionOf(stream) !== revisions.get(stream)) continue
      attempted++
      const requestSource = requestPlans.get(stream)!
      // 页位图: 成功页记入 stream.okPages (纪元闸内), 游标顺吃最高连续成功段;
      //   断点后成功页的货仍照常收 —— 已付代价不丢, 下轮选页跳过它们不重付
      let gap = false
      let streamPagesFetched = 0
      let anyVideo = false
      const okPages: Phase2RoundResult[] = []
      const okPageNos: number[] = []
      for (const p of pageSettled) {
        if ('err' in p) {
          appWarn('[tag-rec] dig stream %s page failed: %o', stream.key, p.err)
          gap = true
          continue
        }
        if (p.res.allPagesFailed) {
          gap = true
          continue
        }
        okPages.push(p.res)
        okPageNos.push(p.page)
        streamPagesFetched += p.res.pagesFetched
        if (p.res.videos.length) anyVideo = true
      }
      if (!okPages.length) {
        // 全页失败: 页游标不推进, 下次同页重试; 票 36: 整流跳过 noteDig —— 保旧游标不落盘
        failed++
        continue
      }
      // W1-1: 纪元闸补到流账簿与游标 —— 跨纪元批的条目已被下方 :488+ 门丢弃,
      //   若仍推进 nextPage/exhausted 落盘, 被丢页的召回对新语境永久消失 (游标跨会话保真)
      if (current()) {
        const okBitmap = (stream.okPages ??= new Set<number>())
        for (const pn of okPageNos) okBitmap.add(pn)
        while (okBitmap.delete(stream.nextPage)) stream.nextPage++
        this.pagesFetched += streamPagesFetched
        // 票 36: 深挖游标回写沉淀池 —— exhausted 只在「批内零失败页」下判: 有失败页 = 未知页段,
        //   空批/页上限 cap 判据不能越过缺口盖终态; 「成功返回的空页」(整批无货) 或 cap => 真到底可持久
        // Q6b: 文本种子流按 pageCap 收口 (到顶即停, 不再轮转)
        const pageCap = stream.pageCap ?? ALLV2_PAGE_CAP
        stream.exhausted = !gap && (stream.nextPage > pageCap || (streamPagesFetched > 0 && !anyVideo))
        stream.stopReason = stream.exhausted ? (stream.nextPage > pageCap ? 'cap' : 'empty') : undefined
        stream.retryAt =
          stream.stopReason === 'empty'
            ? Date.now() + tagRecDiscoveryPolicy(this.strategy.ladder?.()).emptyTtlMinutes * 60_000
            : undefined
        // 显示已看时从头召回旧内容，保留正常浏览的持久进度。
        if (!this.bypassSeen())
          sediment.noteDig(stream.key, {
            keyword: stream.keyword,
            nextPage: stream.nextPage,
            ...(stream.exhausted ? { exhausted: true } : {}),
            schemaVersion: 2,
            stopReason: stream.stopReason,
            capLifted: stream.capLifted,
            retryAt: stream.retryAt,
            expectedRevision: revisions.get(stream),
          })
      }

      let streamStaged = 0 // 本批过滤后交付量 —— B 产率摘帽判据 (页帽是试探不是天花板)
      for (const res of okPages) {
        // ① 变体并入查询单元 / 候选清单合并 —— 会话写入受过期守门
        if (current()) {
          if (stream.withVariants) this.hooks.mergeVariants?.(res.variantEntries)
          this.hooks.mergeCandidates?.(res.newCandidates)
        }
        // AUDIT-15: 纪元门 —— 共享盒在批拉取间被 reset (语境切换) => 本批产出是旧境货,
        //   队/堆/池一概不落, yield 也不计 (lastDigYield 驱动 digPending 镜像, 虚报会误导待决态)
        if (current()) {
          // ② 精确召回 => 同一管线 => 队尾
          const exact = this.normalizeAllV2(
            res.analysis.exact,
            'all-v2-exact',
            requestSource.attribution,
            requestSource.groupIds,
            stream.keyword,
            requestSource.input,
            tagRecConsumers(requestSource),
          )
          this.pushExactPool(exact)
          // 实修: poolSize 用真实存量深度 (批长是切片伪影会错钉 degraded「池浅已放宽」); mergeStats 不覆主轮账
          const staged = this.hooks.applyStages(exact, {
            poolSize: this.hooks.queueSize() + this.heap.length + exact.length,
            poolItems: [...(this.hooks.poolItems?.() ?? []), ...exact, ...this.heap],
            mergeStats: true,
          })
          this.hooks.pushQueue(staged)
          streamStaged += staged.length
          // ③ 兜底留存 => 堆 (related 档; D6 空 tag 条目也在此列)
          const related = this.normalizeAllV2(
            res.analysis.related,
            'all-v2-related',
            requestSource.attribution.map((n) => `${n}·相关`),
            requestSource.groupIds,
            stream.keyword,
            requestSource.input,
            tagRecConsumers(requestSource),
          )
          this.pushHeap(related)
          yieldN += staged.length + related.length
        }
        // ④ 共现边 sediment (过期输入也落 corpus —— 边是事实语料; 同时供给选种词表)
        //   Q4-C: 组合词流语料归并到各成员真实锚点 —— 组合键不落谱 (词表锚点仍指向真 tag 节点)
        for (const anchor of stream.crossNorms ?? [stream.key]) sediment.merge(anchor, res.analysis.cliques)
      }
      // B 产率摘帽: 带帽流单批交付过线 => 数据自己投票放行续挖 (组合词含文本词/文本种子流共用);
      //   已被帽判干的先复活再写回 —— sediment 里那笔 cap 终态作废, 否则下会话水合即干
      if (current() && stream.pageCap && !stream.capLifted && streamStaged >= TAG_REC_STREAM_CAP_LIFT_YIELD) {
        stream.pageCap = undefined
        stream.capLifted = true
        if (stream.stopReason === 'cap') {
          stream.exhausted = false
          stream.stopReason = undefined
        }
        // Persist every cap lift, including productive batches below the former cap.
        // revisions 是批前快照 —— 上方游标写回已把存储 revision +1, 复活写须按实时值 CAS 否则静默丢弃;
        //   bypassSeen 下上方没落盘 (没有待清终态), 持久进度语义照旧不动
        if (!this.bypassSeen())
          sediment.noteDig(stream.key, {
            keyword: stream.keyword,
            nextPage: stream.nextPage,
            schemaVersion: 2,
            capLifted: true,
            expectedRevision: revisionOf(stream),
          })
      }
    }
    // AUDIT-15: 截停批不落聚合账 —— yield/失败比/三停计数都是「本轮深挖结果」语境事实, abort 归零语义不成立
    // W1-1: 跨纪元批同构 —— 滞留批落定 (条目已被纪元门挡, yieldN 只是旧境口径) 不烧新语境
    //   autoDigs 配额、不锁 earlyStopped 单向闩、不写 lastDigYield/lastDigError 横幅镜像
    if (!current() || !attempted) return yieldN
    this.lastDigYield = yieldN
    this.lastDigError = attempted > 0 && failed === attempted
    if (mode === 'auto') {
      // R5-P2-18: 全页失败批不耗早停预算 —— 网络/风控瞬态与「真挖穿零产出」分流;
      //   前者锁 earlyStopped 后 auto 档永拒, 只剩手动横幅一路 (部分成功零产出仍按真空批停)
      if (!yieldN && !(attempted > 0 && failed === attempted)) {
        this.earlyStopped = true
        this.s.earlyStopReason = batch.every((s) => s.stopReason === 'empty') ? 'empty' : 'yield'
      }
      // 票 17 adaptive 第三停 (低产连停): 0<yield<lowYield 记一轮, 丰产清零;
      // 零产出已被早停接管, 手动挖不触碰 (auto 停后转手动横幅即终态, 与 fixed K 耗尽同构)
      const p = paidPolicy
      if (p.mode === 'adaptive') {
        this.lowYieldStreak = yieldN > 0 && yieldN < p.lowYield ? this.lowYieldStreak + 1 : 0
      }
    }
    return yieldN
  }
  // #endregion

  // #region 票 17 浅水位预挖 (tab2 激进档专属; service 在产出 1~triggerYield-1 时同轮调用)
  /**
   * 浅水位预挖 = digPass('auto') 一档, 非整条梯队:
   *   - prepareStreams 补登记深挖流同 D7 (组簇流借此前移成立; 无流 => 空转返回 0);
   *   - related 选种 (D2) / 兜底堆放行 (D3) 一律不跑 —— 梯队前段干轮专属, 不提前倒存货;
   *   - 深挖产出照常落 queue/heap/sediment: queue 货下轮直放, heap 留待干轮放行;
   *   - 门槛与深挖档完全同构 (canAutoDig: 早停/风控/策略上限);
   *   - 队列有货 (在途深挖刚落) 或在途挖 => 不重复挖 (digPass 单飞共享在途 promise)
   */
  preDig({ signal, prepareStreams }: { signal?: AbortSignal; prepareStreams?: () => void } = {}): Promise<number> {
    prepareStreams?.()
    if (this.hasDemandStock() || !this.canAutoDig()) return Promise.resolve(0)
    return this.digPass('auto', signal)
  }
  // #endregion

  // #region D2 related 共现选种 (滚动重估, 票10; 扫描收窄 票32)
  /**
   * 已知标签按共现取窗口；未知标签限量轮转补查，同共现再比质量。
   * 排除已成功选过的 BV，显式质量门槛仍生效；空池、退避与失败不锁死后续重评。
   * 有组库存信息时仅给缺货组补料，其他组的历史产出不占冷池资格。
   */
  async maybeSeedRelated(signal?: AbortSignal, stockEpoch = this.s.stockEpoch): Promise<void> {
    // 收编票: 同 digPass 口径 —— 写闸看存货盒纪元; 同股编辑下名单/related 已付产物照常落堆
    const current = () => this.s.stockEpoch === stockEpoch
    const archiveSeed = (item: TagRecItemExtend) => {
      if (!this.hooks.resolve) return item
      const seed: TagRecItemExtend = {
        ...item,
        source: {
          ...item.source,
          via: 'archive-related',
          claims: (item.source.claims ?? [item.source]).map((claim) => ({ ...claim, via: 'archive-related' })),
        },
        eligibleGroupKeys: undefined,
        eligiblePoolScopes: undefined,
      }
      return projectTagRecActiveClaims(seed, this.hooks.resolve()) ? seed : undefined
    }
    if (this.relatedSeeded) return
    if (tagRecBackoff.isEngaged) return // 风控期不烧名单/related 发数
    if (this.hooks.relatedSeedingAllowed?.() === false) return // 交集下兜底门没开 => 选种产物纯死库存
    const seedPoolMax = this.ladderOpts().seedPoolMax ?? LADDER_DEFAULTS.seedPoolMax
    const vocab = cooccurVocab(sediment.map, [...this.streams.keys()])
    if (!vocab.size) return // 词表未就绪 (下轮再试)
    const pool = [
      ...new Map(
        [...this.poolItems, ...this.exactPoolItems, ...(this.hooks.poolItems?.() ?? [])].map((i) => [i.bvid, i]),
      ).values(),
    ]
    if (!pool.length) return // 空池不锁死 (票10: 下轮有货再评)

    // 票 32: 先按 score 取池内前 N 再抓名单 (score 无需名单, 纯 stat 免费; 逐条按所属池参数, 票05)
    // R5-P2-10: 已种子先于切片剔除 —— 原「截前 N 再滤种子」在前 N 全是老种子时让
    //   N+1 位新候选永不参评 (池内高分种子满期占坑); 滤后切片同成本消饥饿
    const scope = this.hooks.candidateScope?.()
    const seedResolve = this.hooks.resolve?.()
    const available = pool.flatMap((it) => {
      const seed = archiveSeed(it)
      if (!seed || !this.matchesCandidateScope(seed, scope)) return []
      // 交集收窄 (Q8): 认领链含交集时, 种子须已对某条交集链证明完整 match ——
      //   单边热词种子的相关流回货仍是单边货; 未证明的候选连名单补查资格都不给 (火力留给搜索)
      if (seedResolve) {
        const intersectionEffs = tagRecChainKeysOf(it)
          .map((key) => seedResolve(key, 'allV2'))
          .filter((eff) => eff.intersection && eff.combination)
        if (
          intersectionEffs.length &&
          !intersectionEffs.some((eff) => tagRecDeliverable(it, eff.combination!) === 'match')
        )
          return []
      }
      const paid = this.s.seedRequests.get(it.bvid)
      const freshOwner = paid && tagRecChainKeysOf(seed).some((key) => !paid.owners.has(tagRecGroupKey(key)))
      return !this.s.seededBvids.has(it.bvid) || freshOwner ? [seed] : []
    })
    this.rankItems(available)
    const known = available
      .filter((it) => it.ownTagNames !== undefined)
      .sort(
        (a, b) =>
          countCooccurDegree(b.ownTagNames!, vocab) - countCooccurDegree(a.ownTagNames!, vocab) ||
          (b.qualitySortScore ?? 0) - (a.qualitySortScore ?? 0),
      )
    const unknown = available.filter((it) => it.ownTagNames === undefined)
    const scanCount = Math.min(seedPoolMax, TAG_REC_SEED_FETCH_BUDGET, unknown.length)
    const start = unknown.length ? this.s.seedScanCursor % unknown.length : 0
    const rotated = Array.from({ length: scanCount }, (_, i) => unknown[(start + i) % unknown.length])
    const scanned = [...known.slice(0, seedPoolMax), ...rotated].map((it) => ({
      it,
      score: computeScore(it, this.hooks.scoreParams(it)).score,
    }))
    if (!scanned.length) return // 池内全是老种子 => 本轮无可评, 下轮池变再试
    // 名单抓取并发 (下游 anonGetJson 自带并发门; 持久命中本就同步) —— 串行 ~1 发/条是冷池首刷最大阻塞
    // A3-3: 每轮新名单抓取预算闸 —— seedPoolMax 上界 200 下最坏 200 发/干轮, 收到 ≤30;
    //   超预算条目本轮不参评 (池在则下轮再评, 不丢种子资格); 预算分配时顺带避退避
    // 显式分数门槛先判后付: 本地已算出的 score 不达线时名单抓回也进不了候选 (:471 recheck 种子同口径),
    //   直接跳过本次抓取; min<=0 的默认路径照常轮转 (未知统计无显式门槛仍保有选种资格)
    const seedMinUnified = this.ladderOpts().seedMinScore ?? LADDER_DEFAULTS.seedMinScore
    let fetchBudget = TAG_REC_SEED_FETCH_BUDGET
    const nameLists = await Promise.all(
      scanned.map(({ it, score }) => {
        if (it.ownTagNames !== undefined) return it.ownTagNames
        const min = Math.max(seedMinUnified, this.hooks.seedMinScoreOf?.(it) ?? 0)
        if (min > 0 && (score === undefined || score < min)) return undefined
        if (fetchBudget <= 0 || tagRecBackoff.isEngaged) return undefined
        fetchBudget--
        return fetchVideoTagNames(it.bvid, signal).catch(() => undefined)
      }),
    )
    if (!current()) return
    this.s.seedScanCursor = start + scanCount
    if (tagRecBackoff.isEngaged) return // A3-3: 批间复检 —— 名单批期间 engage 不再发 related 批
    const candidates: CooccurSeedCandidate[] = []
    scanned.forEach(({ it, score }, i) => {
      const names = nameLists[i]
      if (names !== undefined) it.ownTagNames = names
      if (!names?.length) return
      const minScore = this.hooks.seedMinScoreOf?.(it) ?? 0
      if (minScore > 0 && (score === undefined || score < minScore)) return
      candidates.push({ bvid: it.bvid, cooccur: countCooccurDegree(names, vocab), score })
    })
    const byBvid = new Map(available.map((i) => [i.bvid, i]))
    const seedBvids = selectCooccurSeeds(candidates, {
      count: this.ladderOpts().seedCount ?? LADDER_DEFAULTS.seedCount,
      minScore: this.ladderOpts().seedMinScore ?? LADDER_DEFAULTS.seedMinScore,
    })
    // A3-5: 成败分流 —— 请求失败 (undefined) 不落 seededBvids, 下轮可重选;
    //   仅成功响应 (含真空列表 = 真无相关) 才记账, 与名单抓取 .catch 不记账口径一致
    const raws = await Promise.all(
      seedBvids.map((bvid) => {
        const paid = this.s.seedRequests.get(bvid)
        if (paid) return paid.promise
        const entry = {
          promise: Promise.resolve(undefined) as Promise<TagTopItem[] | undefined>,
          owners: new Set<string>(),
          settled: false,
          size: 1,
        }
        entry.promise = fetchArchiveRelated(bvid, { signal })
          .then(
            (v) => v,
            () => undefined,
          )
          .then((raw) => {
            entry.settled = true
            entry.size = Math.max(1, raw?.length ?? 0)
            if (!raw && this.s.seedRequests.get(bvid) === entry) this.s.seedRequests.delete(bvid)
            this.trimSeedRequests()
            return raw
          })
        this.s.seedRequests.set(bvid, entry)
        this.trimSeedRequests()
        return entry.promise
      }),
    )
    if (!current()) return
    seedBvids.forEach((bvid, i) => {
      const res = raws[i]
      if (!res) return
      this.s.seededBvids.add(bvid) // 票10: 记录已选种子 (滚动重估时排除)
      const seed = byBvid.get(bvid)
      for (const key of seed ? tagRecChainKeysOf(seed) : [])
        this.s.seedRequests.get(bvid)?.owners.add(tagRecGroupKey(key))
      const seedClaims = seed?.activeSourceClaims ?? seed?.source.claims
      const consumers = (seedClaims ?? []).flatMap(tagRecConsumers)
      const owners = consumers.length ? tagRecConsumerSource(consumers) : seed?.source
      const names = owners?.groupNames.map((n) => `${n}·相关`) ?? []
      // A1-3: 衍生条继承种子组 id —— 「A·相关」显示名照旧, 过滤求解按 id 直挂源组 (剥名撞名不再发生)
      //   claims 一并下传: 命中词 (徽标显示标签名而非「A·相关」占位组名) + tagIds (旧语境归因证据,
      //   eval 借不到 —— claim.tagIds 消费点全走 via==='tag-top' 闸, 这里已翻成 archive-related)
      this.pushHeap(this.normalizeArchiveRelated(res, names, owners?.groupIds, seed?.source.input, seedClaims))
    })
  }
  // #endregion

  // #region D3 兜底堆分批放行
  /**
   * 每干轮排序一次，依次检查物理页，首批非空即放行；全部被拒才耗尽。
   * 按当前算分参数 (逐条按所属池槽, 票05) 重排堆 => 取页 => 经同一管线
   * (滤除原料由 service 候补缓存保留)。applyStages 注入未消费原料池计算组×来源池深 ——
   *   页长 ≤fallbackPage 是切片伪影, 堆深才是真池规模
   */
  releasePage(epoch = this.s.epoch): TagRecItemExtend[] {
    if (!this.heap.length) return []
    // A3-8: 纪元闸 —— 本页对旧纪元共享堆排序+切割, 先防跨纪元偷料
    if (this.s.epoch !== epoch) return []
    this.rankItems(this.heap)
    this.heap.sort(compareFallbackItems)
    const pageSize = this.ladderOpts().fallbackPage ?? LADDER_DEFAULTS.fallbackPage
    const heap = this.heap
    const scope = this.hooks.candidateScope?.()
    const eligible = scope ? heap.filter((it) => this.matchesCandidateScope(it, scope)) : heap
    const depth = eligible.length
    let consumed = 0
    const used = new Set<TagRecItemExtend>()
    try {
      // 空物理页不等于无存货；只排序一次，每条候选最多检查一次。
      while (consumed < depth) {
        if (this.s.epoch !== epoch) return []
        const poolSize = depth - consumed
        const page = eligible.slice(consumed, consumed + pageSize)
        consumed += page.length
        const items = this.hooks.applyStages(page, {
          poolSize,
          poolItems: eligible.slice(consumed - page.length),
          mergeStats: true,
        })
        if (this.s.epoch !== epoch) return []
        // Only a successfully processed page is consumed. Failed stages keep their stock.
        for (const item of page) used.add(item)
        if (items.length) return items
      }
      return []
    } finally {
      // 语境重置可能原地换掉堆内容；旧操作不得再消费新语境。
      if (this.s.epoch === epoch && this.heap === heap)
        for (let i = heap.length - 1; i >= 0; i--) if (used.has(heap[i])) heap.splice(i, 1)
    }
  }
  // #endregion

  // #region D1 干轮梯队
  /**
   * 干轮编排 (service fetchMore 主池产出 0 后调用):
   *   等在途深挖 => prepareStreams 补簇流 => 选种 => 放行 => 自动深挖 => 手动待决/硬见底
   * 队列有货 (在途深挖刚落) 直接判放行轮, 不重复挖
   */
  runLadder(options: { signal?: AbortSignal; prepareStreams?: () => void } = {}): Promise<FallbackLadderResult> {
    if (options.signal?.aborted) return Promise.resolve({ kind: 'aborted' })
    return tagRecRecallScheduler.withForegroundSupply(() => this.runForegroundLadder(options))
  }

  private async runForegroundLadder({
    signal,
    prepareStreams,
  }: { signal?: AbortSignal; prepareStreams?: () => void } = {}): Promise<FallbackLadderResult> {
    // A3-8: 纪元快照 —— reset 期间在途批的后续写 (选种/放行/流注册) 不落新盒
    const epoch = this.s.epoch
    const cursorEpoch = this.s.digCursorEpoch
    const current = () => this.s.epoch === epoch && this.s.digCursorEpoch === cursorEpoch
    if (signal?.aborted) return { kind: 'aborted' }
    if (this.hasDemandStock()) return { kind: 'items', items: [] }
    if (this.digRunning) {
      await waitForAbortable(this.digRunning, signal).catch(() => undefined)
      if (signal?.aborted) return { kind: 'aborted' }
      if (!current()) return { kind: 'aborted' } // A3-8
    }
    if (signal?.aborted || !current()) return { kind: 'aborted' }
    if (this.hasDemandStock()) return { kind: 'items', items: [] }
    prepareStreams?.()
    if (signal?.aborted || !current()) return { kind: 'aborted' }
    if (this.hasDemandStock()) return { kind: 'items', items: [] }
    await this.reprobeExpired(signal)

    if (signal?.aborted || !current()) return { kind: 'aborted' }
    if (this.hasDemandStock()) return { kind: 'items', items: [] }

    await this.maybeSeedRelated(signal, this.s.stockEpoch)
    if (signal?.aborted || !current()) return { kind: 'aborted' }
    let items = this.releasePage(epoch)
    if (signal?.aborted || !current()) return { kind: 'aborted' }

    // 堆光且无队列货 => 自动深挖一轮, 再放行
    if (!items.length && !this.hasDemandStock() && this.canAutoDig()) {
      await this.digPass('auto', signal)
      if (signal?.aborted || !current()) return { kind: 'aborted' }
      items = this.releasePage(epoch)
    }

    if (signal?.aborted || !current()) return { kind: 'aborted' }

    if (items.length || this.hasDemandStock()) return { kind: 'items', items }
    if (this.hasDueStreams()) return { kind: 'manual-pending' }
    const failedCooling = this.findStream((stream) => {
      const source = this.plannedStream(stream)
      if (!source || !this.hooks.resolve) return false
      const dig = sediment.map.get(stream.key)?.dig
      const p = planTagRecRecall({ roundSources: [], digSources: [source] }, this.hooks.resolve())
      const scopes = p.dig.flatMap((s) => [
        ...s.exactConsumers.map((c) => tagRecPoolScopeKey(c.key, 'allV2')),
        ...s.relatedConsumers.map((c) => tagRecPoolScopeKey(c.key, 'allV2Related')),
      ])
      return scopes.some((scope) => {
        const probe = dig?.probes?.[scope]
        return probe && probe.empty === undefined && Date.now() < probe.retryAt
      })
    })
    if (failedCooling) return { kind: 'retry-later', reason: '上次重查失败，正在冷却；可稍后刷新或选择定向重查' }
    const plan = this.hooks.recallPlan?.()
    if (
      plan?.archiveConsumers.length &&
      !plan.tagTop.length &&
      !plan.up.length &&
      !plan.dig.length &&
      (!cooccurVocab(sediment.map, [...this.streams.keys()]).size ||
        !(this.hooks.poolItems?.().length || this.poolItems.length || this.exactPoolItems.length))
    )
      return { kind: 'source-unavailable', reason: '推荐相关需要已有种子和标签词表；可开启标签池或搜索池' }
    return { kind: 'hard-bottom' }
  }
  // #endregion

  // #region 聚合状态 (session phase2 切片镜像)
  get phase2() {
    return {
      status: this.digRunning
        ? ('running' as const)
        : this.lastDigError
          ? ('error' as const)
          : this.pagesFetched > 0
            ? ('done' as const)
            : ('idle' as const),
      pagesFetched: this.pagesFetched,
      exhausted: this.streams.size > 0 && !this.hasDueStreams(),
      autoDigs: this.autoDigs,
      lastDigYield: this.lastDigYield,
    }
  }
  // #endregion

  // #region 归一 + 去重 (sources => TagRecItemExtend, 记 service seenBvids)
  private normalizeAllV2(
    items: AllV2VideoItem[],
    via: 'all-v2-exact' | 'all-v2-related',
    groupNames: string[],
    groupIds?: string[],
    queryKeyword?: string,
    input?: boolean,
    consumers?: TagRecConsumer[],
  ) {
    const out: TagRecItemExtend[] = []
    for (const it of items) {
      if (!it.bvid) continue
      const item = normalizeAllV2Item(it, { via, groupNames, groupIds, srcRank: out.length })
      item.source.queryKeyword = queryKeyword
      item.source.input = input
      item.source.claims = consumers?.map((c) => ({ ...tagRecConsumerSource([c]), via, queryKeyword }))
      const candidate = this.acceptNormalized(item)
      if (candidate) out.push(candidate)
    }
    return out
  }

  private normalizeArchiveRelated(
    items: TagTopItem[],
    groupNames: string[],
    groupIds?: string[],
    input?: boolean,
    claims?: readonly TagRecSourceClaim[],
  ) {
    const out: TagRecItemExtend[] = []
    for (const it of items) {
      if (!it.bvid) continue
      const item = normalizeTagTopItem(it, { via: 'archive-related', groupNames, groupIds, srcRank: out.length })
      item.source.input = input
      if (claims?.length) {
        // tagIds 是种子的召回证据: 衍生条保留它作归因 (旧语境判定要认「只因被删原子召回」的
        //   残留), 但借不到命中 —— eval 的 claim.tagIds 消费点全走 via==='tag-top' 闸
        //   (combination/relevance/attribution), 这里 via 已翻成 archive-related。
        item.source.claims = claims.map((claim) => ({ ...claim, via: 'archive-related' as const }))
        item.source.queryKeyword = claims.find((c) => c.queryKeyword)?.queryKeyword
      }
      const candidate = this.acceptNormalized(item)
      if (candidate) out.push(candidate)
    }
    return out
  }

  private acceptNormalized(item: TagRecItemExtend): TagRecItemExtend | undefined {
    if (this.hooks.resolve && !projectTagRecActiveClaims(item, this.hooks.resolve())) {
      if (!this.hooks.seenBvids.has(item.bvid)) this.hooks.observe?.([item])
      else this.hooks.mergeExisting?.(item) // 已存在的未交付 BV 可补真实休眠证据，交付后不会复活。
      return
    }
    if (!this.hooks.seenBvids.has(item.bvid)) {
      this.hooks.seenBvids.add(item.bvid)
      return item
    }
    const heapHit = this.heapBvidIndex.map().get(item.bvid)
    const at = heapHit ? this.heap.indexOf(heapHit) : -1
    if (at !== -1) {
      const existing = mergeTagRecCandidate(this.heap[at], item)
      if (item.source.via === 'all-v2-exact') {
        this.heap.splice(at, 1)
        return existing
      }
      return
    }
    return this.hooks.mergeExisting?.(item)
  }
  // #endregion
}
