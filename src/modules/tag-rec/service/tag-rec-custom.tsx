import { cloneDeep } from 'es-toolkit'
import { appWarn } from '$common'
import { EApiType } from '$enums'
import { BaseTabService } from '$modules/rec-services/_base'
import { settings } from '$modules/settings' // [tag-rec]
import { perfMark } from '$utility/perf-mark' // [tag-rec] perf 票 06
import toast from '$utility/toast'
import { isRiskControlError, tagRecBackoff } from '../api/backoff'
import { fetchTagInfoById, fetchTagInfoByName, type TagInfo } from '../api/endpoints'
import { tagRecRecallScheduler } from '../api/recall-scheduler'
import { getCachedTagRecVideoEvidence, mergeTagRecVideoEvidence } from '../api/video-evidence'
import { createTagRecAttributionEnricher, invalidateTagRecCardData } from '../model/attribution'
import {
  addTagRecCondition,
  evalTagRecCombination,
  evalTagRecConditionAtom,
  hasTagRecCombination,
  tagRecCombinationSignature,
  tagRecConditionAtoms,
  tagRecConditionKey,
  tagRecDeliverable,
  validateTagRecCombination,
  type TagRecCombination,
  type TagRecConditionAtom,
} from '../model/combination'
import { parseTagRecDeepLink } from '../model/deeplink'
import { deriveGroupCliques, TAG_REC_SEED_POOL_MAX, tagRecSearchExtraOf, type TagRecDigStream } from '../model/dig'
import { dedupeTagIdEntries, pickTagGroupsByIds, summarizeGroupNames } from '../model/favorites' // [tag-rec]
import {
  computeTagRecFilterSignature,
  createTagRecScopeResolver,
  evalTagRecChain,
  evalTagRecItem,
  poolOfVia,
  projectTagRecActiveClaims,
  resolveTagRecItemScoreParams,
  resolveTagRecSeedMinScore,
  runTagRecFilter,
  runTagRecScoreStage,
  TAG_REC_ALL_POOL_KEYS,
  TAG_REC_HELD_MAX_ATTEMPTS,
  TAG_REC_HELD_RETRY_QUOTA,
  TAG_REC_HELD_REVIVE_MS,
  TAG_REC_VERIFY_CANDIDATES,
  TAG_REC_VERIFY_MS,
  TAG_REC_VERIFY_REQUESTS,
  tagRecChainKeysOf,
  tagRecPoolScopeKey,
  tagRecPoolsForChain,
  tagRecPoolSizes,
  type TagRecChainKey,
  type TagRecDropDimKey,
  type TagRecFilterCore,
  type TagRecFilterCtx,
  type TagRecFilterRoundStats,
  type TagRecScopeResolve,
} from '../model/filter-engine' // [tag-rec]
import { createTagRecQueryMatcher } from '../model/query-scope'
import { tagRecGroupKey, tagRecSourceClaims } from '../model/relevance'
import {
  mergeCandidateRows,
  normalizeTagName,
  parseTagInput,
  resolveAnchor,
  resolveCandidateRows,
  type CandidateRow,
} from '../model/resolve'
import { materializeTagRecSessionFilter } from '../model/session-filter'
import { favorites, favoritesL1, sediment } from '../store'
import { tagRecCombinationBlocks } from '../store/combination-blocks'
import {
  beginTagRecCustomQuery,
  pushExpandedIds,
  switchTagRecGroupContext,
  tagRecCustomSession,
  tagRecSharedSession,
} from '../store/session'
import { tagRecWorkbench } from '../store/workbench-state'
import { TagRecCustomTabbarView } from '../ui/tabbar-custom'
import {
  applyTagRecStages,
  createTagRecProduceTracker,
  makeTagRecExhaustSeparator,
  TAG_REC_SOURCE_FAILURE_MAX_RETRIES,
  TAG_REC_TAG_TOP_PAGE_CAP,
  TagRecSourceFailureError,
  TagRecTidDryTracker,
  trackTagRecRoundProduce,
  type TagRecRoundCtx,
  type TagRecRoundSource,
  type TagRecRoundStages,
  type TagRecTidDrySnapshot,
} from './_pipeline'
import { pickTagIdsForRound } from './deck'
import {
  createTagRecBvidIndex,
  TagRecDeferredCandidates,
  tagRecVersionedArray,
  type TagRecDeferredCandidatesSnapshot,
} from './deferred-candidates'
import { createTagRecDeliveryReplay } from './delivery-replay'
import { spliceTagRecAtomFairSlice, WeightedTurns } from './fair-queue'
import {
  clampTagRecLadderOpts,
  FALLBACK_LADDER_STRATEGY_AGGRESSIVE,
  newTagRecLadderState,
  resetTagRecLadderState,
  TagRecFallbackLadder,
  tagRecHeapVersion,
  type TagRecLadderSharedState,
} from './fallback-ladder'
import { dropTagRecStrictTagListHits, ensureTagRecNegativePools, tagRecNegativePools } from './negative-slice' // [tag-rec]
import {
  checkTagRecPartitionSlice,
  hasTagRecPartitionRules,
  TagRecPartitionBudget,
  tagRecPartitionHeldNext,
  tagRecPartitionWorkQueue,
} from './partition-slice'
import { tagRecConsumers, tagRecReopenedTopTids, tagRecSourceSignature, type TagRecConsumer } from './recall-plan'
import { tagRecRecheckOptions, type TagRecRecheckSelection } from './recheck'
import { refilterTagRecStock } from './refilter-stock'
import { createTagRecSeenStage, tagRecSeenStage } from './seen-stage' // [tag-rec]
import { tagRecSupplyView } from './supply'
import {
  planTagRecRecall,
  runTagRecRecallRound,
  TagRecUpSearchPool,
  upSearchMids,
  type TagRecUpSearchSnapshot,
} from './up-search'
import { tagRecVersionKey, versionedSlot } from './versioned-cache'
import type { ItemsSeparator, RecItemTypeOrSeparator, TagRecItemExtend } from '$define'

import type { TagGroup, TagIdEntry, TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] 「标签发掘」tab —— Phase 1 + Phase 2 (spec §4.1/§4.3)
 *   Phase 1: 输入 => tag/info 锚点 => _pipeline 一轮 (tag/top 池 => bvid 跨轮去重 => 统一字段视图 => 产出)
 *   Phase 2 后台四重产出: ①字形变体 id 并入查询单元(下一轮起)+语义别名候选清单
 *                        ②精确召回 => qs.bufferQueue 尾部
 *                        ③兜底留存 => 池浅时标「相关」补召回
 *                        ④共现边 sediment.merge
 *   展示兜底梯队: tag/top 主池 => all/v2 精确 => 其余命中「相关」=> 全空提示
 *   查询单元 = 选中组并集 (tagRecCustomSession.selectedGroupIds, 正常+挂起) ∪ 临时输入 id (票 07)
 *   轮次主干共享 _pipeline.ts (票 05); 过滤算分/去已看经 stages 注入点, 归票 06/08
 *   票 32 冷池主动性: 逐 tid 干态记忆 (空即干/零新增连击干, 成员签名变全清)
 *   + 首轮/变员后台预热深挖流 (选定组簇流 + 每扩选 id 一流, 与 tag/top 并行)
 */
/**
 * 票 24 深链消费 (spec §4.7): `?gate-tab=tag-rec-custom` 直达后由 service 构造时消费二级参数 —
 *   `tag-rec-group=<L2组id>` => 选定组语境 (失效 id 静默不选 + toast「组不存在」);
 *   `tag-rec-input=<tag_id>` => 直输查询 (数字 id 逃生口, 票 01); 同现 group 优先;
 *   `tag-rec-new=<tag_name>&tag-rec-id=<id>` => 新试验组合 (弹层 #id, id 缺/坏回落 input);
 *   消费后 history.replaceState 清参 (防刷新重放/分享干净, gate-tab 保留属既有机制)
 * 消费点选型 (实机修复): 原挂 tabbar useMount + emit 'refresh' —— 撞上 RecGrid mount 'reuse'
 *   refresh 在途时「同 tab 刷新中」守卫把 emit 丢弃 (useRefresh.ts checkIsSameTabButConditionsChanged
 *   对本 tab 恒 false), 输入框填了值却永不解析。挪进构造函数 = 在建服务的那次 refresh 内部先写
 *   会话种子, 随后的 doFetch 直接读到 —— 不依赖 emit 时序, race 由构造消除
 */
let tagRecDeepLinkConsumed = false

function consumeTagRecDeepLink() {
  if (tagRecDeepLinkConsumed) return
  tagRecDeepLinkConsumed = true
  if (typeof location === 'undefined') return // 测试/node 环境兜底
  const { target, paramsToClear } = parseTagRecDeepLink(location.search)
  if (!paramsToClear.length) return
  for (const p of paramsToClear) {
    const u = new URL(location.href)
    u.searchParams.delete(p)
    history.replaceState({}, '', u.href)
  }
  if (!target) return
  // [tag-rec] perf 票 06: 深链参数消费点 (构造期同步段; 后续锚点解析/首拉是全异步链)
  perfMark('tagrec-deeplink-consume', { [target.kind]: 1 })
  // 本函数须保持同步 (构造函数下游 `消费后再取签名` 的次序依赖); 读 favorites.list 的真值
  // 依赖 useRefresh 建服务前的 `tagRecStoresHydrated` 闸控 (票 perf-03: store 后台水合)
  if (target.kind === 'new') {
    // 弹层 #tag_id 语义: 新 tab 落成「含该标签条件的新试验组合」, 不走输入解析管线。
    //   工作台模块惰性加载 (顶层 import 会在模块载入时启动 GM 水合, 无 GM 环境直接炸);
    //   工作台态是独立 GM 持久位, 消费点不保证已水合 —— 挂在水合+激活完成后追加;
    //   activateTagRecWorkbench 幂等, 与视图 mount 的激活调用无竞态。
    void import('../store/workbench').then((w) =>
      w.activateTagRecWorkbench().then(() => {
        w.seedTagRecNewTrialWithTag({ id: target.id, name: target.name })
      }),
    )
    return
  }
  if (target.kind === 'group') {
    if (favorites.list.some((g) => g.id === target.groupId)) {
      switchTagRecGroupContext(target.groupId)
    } else {
      toast('组不存在')
    }
    return
  }
  beginTagRecCustomQuery(target.input)
}

/**
 * [tag-rec] perf 票 06: 深链锚点预热 —— 模块求值期 (mounted 前 ~1s) 即按 `tag-rec-input` 发 tag/info,
 *   与指纹铸型 (fingerprint.ts 模块级预热) / store 水合 / 页面挂载全并行;
 *   建服务后 resolveAnchor 撞 SessionFetchCache 同一归一 key 的在途/已结 promise,
 *   锚点段 (GM 读 + spi 等 + x/tag/info 往返) 整段退出深链首屏关键路径。
 *   group 档零解析不预热; 失败静默 (正式链走原样重试语义); 数字输入预热带 id 反查。
 *   deeplink.ts 是故意不碰 location/GM 的纯逻辑叶 (见该文件头注), 预热只能挂在本模块体;
 *   node 测试 location/GM 双守卫早退。
 */
function prefetchTagRecDeepLinkAnchor() {
  if (typeof location === 'undefined' || typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') return
  const { target } = parseTagRecDeepLink(location.search)
  if (target?.kind !== 'input') return
  const parsed = parseTagInput(target.input)
  if (parsed?.kind === 'name') void fetchTagInfoByName(parsed.name).catch(() => undefined)
  else if (parsed?.kind === 'id') void fetchTagInfoById(parsed.id).catch(() => undefined)
}
prefetchTagRecDeepLinkAnchor()

/**
 * 票 32 干态/成员签名模块级共享: service 实例随 refresh/重建轮换, 但「这个查询语境哪些 tid 已干」
 * 是会话事实不该随实例丢 —— 刷干池再刷新不再把死源的 tag/top 重打一轮抢占深挖闸位 (冷池首屏提速);
 * 成员签名变 => fetchMore 内全清重获一轮机会; 整页重载 (F5) 自然清零
 * 票 39: persistEmpty 开 —— 空响应标干落 GM `tag-rec:dry-tids` (TTL 60min), F5 跨会话不再重打死源;
 *   零新增连击维持会话级不落盘 (相对本会话 seenBvids 判定, F5 后语义不成立)
 */
const sharedDryTids = new TagRecTidDryTracker({ persistEmpty: true })
let sharedMemberSignature: string | undefined
/**
 * 票 37 深挖/产出态同享模块级: 刷新重建 service 续挖不重启 —— 流页游标/兜底堆/选种标记/三停纪律、
 * 跨轮去重集、未上屏队列全保; 已付过代价的请求与已攒下的货都不再重付。签名变 => fetchMore 内原地重置
 */
const sharedLadderState = newTagRecLadderState()
const sharedSeenBvids = new Set<string>()
/** 交付队列写版本 (Proxy 拦写): bvid 懒索引的等长换血检出依据 —— splice 交付+push 回补净长不变也无处可藏 */
let sharedBufferQueueSeq = 0
const sharedBufferQueue: RecItemTypeOrSeparator[] = tagRecVersionedArray(() => sharedBufferQueueSeq++)
const sharedCandidates = new TagRecDeferredCandidates()
/**
 * 交付队列/兜底堆 bvid 懒索引 (mergeIncoming 每条到达物全扫 => O(items×queue) 悬崖):
 * 写版本变自动重建 —— 一切写路径 (push/splice/restore/测试直改) 全覆盖
 */
const sharedQueueIndex = createTagRecBvidIndex(
  () => sharedBufferQueue,
  () => sharedBufferQueueSeq,
  (it) => it.api === EApiType.TagRec, // 同原 queue.find 语义: 非 TagRec 项不入 bvid 域
)
const sharedHeapIndex = createTagRecBvidIndex(() => sharedLadderState.heap, tagRecHeapVersion)
/** 已见到达物是否仍挂未交付态 (归一/合并早退判): 队列 ∪ 兜底堆 ∪ 被挡候选表 */
const sharedHasPending = (bvid: string) =>
  sharedQueueIndex.map().has(bvid) || sharedHeapIndex.map().has(bvid) || sharedCandidates.has(bvid)
const sharedUpSearch = new TagRecUpSearchPool()
/** 组合组内原子级公平混排的欠额记账 (跨页平滑; 死原子由 advance 的 live 清理自动失效)。 */
const sharedAtomTurns = new WeightedTurns()
/**
 * 已交付内容的有界回放池 (票 002): 「显示已看」打开时零请求回放"第一次看到的内容"。
 *   不再依赖"清 seen 重新拉取"—— 交付时条目已出队、游标已越过, 重拉拉不回来。
 */
const sharedDeliveryReplay = createTagRecDeliveryReplay()

/**
 * 回放池键 (票 002 + 审计修复): 直接取语境签名的**成员段** —— 工作台组合签名 /
 *   非工作台的 组id+tag_ids+扩选+输入词 全在里面 (原实现只读 workingGroup,
 *   非工作台模式全语境共用 `[null,null,null]` 串池, 选组 A 的内容会回放进选组 B)。
 *   `|seen:` 段只剥**开关位** (seen:<bypass>:<rev> → seen:*:<rev>): 开关只切显示不换键;
 *   **代际保留** —— 「清空已看」(rev++) 后池子不再复活已交付内容。
 *   `|sources:` 段不入键: 取数态/干态一变就换键, 回放会永远命中不了。
 *   试验身份仍前置 (workbench: 段用的是恒等 __tagrec_working__, 不含 activeId ——
 *   同组合的两个试验不能串池); 输入词尾置双保险 (wg 段签名不含它)。
 */
/** 成员段的 seen 段只剥**开关位** (seen:<bypass>:<rev> → seen:*:<rev>): 显示切换不换键; 代际保留。 */
function tagRecMembersCore(members: string): string {
  return members.replace(/\|seen:[^:]*:/, '|seen:*:')
}
export function tagRecDeliveryReplayKey(): string {
  const members = computeTagRecCustomContextSignature().split('|sources:', 1)[0]
  if (!members) return ''
  return `${tagRecWorkbench.activeId ?? ''}|${tagRecMembersCore(members)}|in:${normalizeTagName(tagRecCustomSession.inputText ?? '')}`
}
let sharedFilterSignature: string | undefined
/** 上次同步的工作台尝试身份 (切尝试=重开收集的判定, 见 syncCustomSharedState)。 */
let sharedWorkbenchTrialId: string | undefined
/**
 * 票 004: 组合原子集变迁账 —— 同试验配方编辑时, 被删的原子用于标"旧语境存货"。
 *   切试验不标 (换语境不是删条件, 存货已被清场/暂存)。
 *   atomsSig 只在**原子集**真正变化时重算 —— 输入词/选组变动不算配方编辑。
 */
let sharedPrevConditionAtoms: TagRecConditionAtom[] | undefined
let sharedPrevAtomsSig: string | undefined
let sharedRemovedConditionAtoms: TagRecConditionAtom[] = []

/**
 * 切试验时的有界库存暂存 (每试验一档, LRU): 切换会清场上屏外全部存货, 但 sediment 深挖
 *   游标是持久层不随清 —— 不暂存的话「已付费页对应的未上屏货」永久丢失且游标已越过。
 *   暂存让「游标推进 ↔ 对应结果仍在」成对成立: 切回时原地恢复 (容器对象身份不换,
 *   service 构造期捕获的引用不失效), 已付代价的页不重挖、已看的条目不重放。
 */
type TagRecTrialStash = {
  seenBvids: Set<string>
  dryTids: TagRecTidDrySnapshot
  bufferQueue: RecItemTypeOrSeparator[]
  candidates: TagRecDeferredCandidatesSnapshot
  upSearch: TagRecUpSearchSnapshot
  atomCredits: Map<string, number>
  // 审计回填 (D2): 删原子账本随档往返 —— 切走再切回时恢复队列里的 stale 条
  //   若不丢标记, 会按普通 unknown 重进 pending 核查 (烧 evidence 预算直到封顶转 abandoned)
  removedAtoms: TagRecConditionAtom[]
  prevAtoms: TagRecConditionAtom[] | undefined
  prevAtomsSig: string | undefined
  ladder: {
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
    seededBvids: Set<string>
    seedRequests: TagRecLadderSharedState['seedRequests']
    seedScanCursor: number
    producedTotal: number
    tagCursors: TagRecLadderSharedState['tagCursors']
    queryCursor: number
    wordCursor: number
    wordWindow: Set<string>
    digResumeAt: number
  }
}
const TRIAL_STASH_CAP = 6
const trialStash = new Map<string, TagRecTrialStash>()

/** 清场前调用: 把当前共享盒整体拷进该试验的暂存档 (值拷贝, 与活容器不共享) */
function trialStashCapture(trialId: string) {
  const s = sharedLadderState
  trialStash.delete(trialId)
  trialStash.set(trialId, {
    seenBvids: new Set(sharedSeenBvids),
    dryTids: sharedDryTids.snapshot(),
    bufferQueue: [...sharedBufferQueue],
    candidates: sharedCandidates.snapshot(),
    upSearch: sharedUpSearch.snapshot(),
    atomCredits: new Map(sharedAtomTurns.credits),
    removedAtoms: [...sharedRemovedConditionAtoms],
    prevAtoms: sharedPrevConditionAtoms ? [...sharedPrevConditionAtoms] : undefined,
    prevAtomsSig: sharedPrevAtomsSig,
    ladder: {
      streams: new Map(s.streams),
      heap: [...s.heap],
      poolItems: [...s.poolItems],
      exactPoolItems: [...s.exactPoolItems],
      autoDigs: s.autoDigs,
      earlyStopped: s.earlyStopped,
      earlyStopReason: s.earlyStopReason,
      lowYieldStreak: s.lowYieldStreak,
      relatedSeeded: s.relatedSeeded,
      pagesFetched: s.pagesFetched,
      lastDigYield: s.lastDigYield,
      lastDigError: s.lastDigError,
      seededBvids: new Set(s.seededBvids),
      seedRequests: new Map(s.seedRequests),
      seedScanCursor: s.seedScanCursor,
      producedTotal: s.producedTotal,
      tagCursors: new Map(s.tagCursors),
      queryCursor: s.queryCursor,
      wordCursor: s.wordCursor,
      wordWindow: new Set(s.wordWindow),
      digResumeAt: s.digResumeAt,
    },
  })
  while (trialStash.size > TRIAL_STASH_CAP) trialStash.delete(trialStash.keys().next().value!)
}

/**
 * 切回时原地恢复暂存档: 全部容器「清+回填」保对象身份; 无档 => false (调用侧走原清场路径)。
 * 票 003: 不再因「显示已看」打开而弃档 —— 那正是"开着显示已看切回 = 空场"的成因。
 */
function trialStashRestore(trialId: string): boolean {
  const stash = trialStash.get(trialId)
  trialStash.delete(trialId) // 命中即消费 —— 下次离开重新按当时状态暂存
  if (!stash) return false
  sharedSeenBvids.clear()
  for (const b of stash.seenBvids) sharedSeenBvids.add(b)
  sharedBufferQueue.length = 0
  sharedBufferQueue.push(...stash.bufferQueue)
  sharedCandidates.restore(stash.candidates)
  sharedUpSearch.restore(stash.upSearch)
  sharedDryTids.restore(stash.dryTids)
  sharedAtomTurns.credits.clear()
  for (const [k, v] of stash.atomCredits) sharedAtomTurns.credits.set(k, v)
  sharedRemovedConditionAtoms = stash.removedAtoms
  sharedPrevConditionAtoms = stash.prevAtoms
  sharedPrevAtomsSig = stash.prevAtomsSig
  const s = sharedLadderState
  s.streams.clear()
  stash.ladder.streams.forEach((v, k) => s.streams.set(k, v))
  s.heap.length = 0
  s.heap.push(...stash.ladder.heap)
  s.poolItems.length = 0
  s.poolItems.push(...stash.ladder.poolItems)
  s.exactPoolItems.length = 0
  s.exactPoolItems.push(...stash.ladder.exactPoolItems)
  s.seededBvids.clear()
  for (const b of stash.ladder.seededBvids) s.seededBvids.add(b)
  s.seedRequests.clear()
  stash.ladder.seedRequests.forEach((v, k) => s.seedRequests.set(k, v))
  s.tagCursors.clear()
  stash.ladder.tagCursors.forEach((v, k) => s.tagCursors.set(k, v))
  s.wordWindow.clear()
  for (const w of stash.ladder.wordWindow) s.wordWindow.add(w)
  s.autoDigs = stash.ladder.autoDigs
  s.earlyStopped = stash.ladder.earlyStopped
  s.earlyStopReason = stash.ladder.earlyStopReason
  s.lowYieldStreak = stash.ladder.lowYieldStreak
  s.relatedSeeded = stash.ladder.relatedSeeded
  s.pagesFetched = stash.ladder.pagesFetched
  s.lastDigYield = stash.ladder.lastDigYield
  s.lastDigError = stash.ladder.lastDigError
  s.seedScanCursor = stash.ladder.seedScanCursor
  s.producedTotal = stash.ladder.producedTotal
  s.queryCursor = stash.ladder.queryCursor
  s.wordCursor = stash.ladder.wordCursor
  s.digResumeAt = stash.ladder.digResumeAt
  s.digRunning = undefined
  s.epoch++ // 恢复同样换纪元: 暂存期内在途批产出不落回恢复的盒
  s.stockEpoch++ // 收编票: 盒体被暂存档置换 => 在途批按跨盒口径丢弃 (与 reset 同级)
  return true
}

/** 测试用: 清模块级干态+签名+深挖共享态 (等价整页重载; 同文件多 service 测试需防跨用例串态) */
export function resetTagRecCustomSharedState() {
  tagRecCustomSession.partitionPaused = false
  tagRecCustomSession.partitionPending = 0
  tagRecCustomSession.partitionAbandoned = 0
  tagRecCustomSession.partitionBudgetExhausted = false
  tagRecCustomSession.replayDelivered = 0
  tagRecCustomSession.localFirst = false
  tagRecCustomSession.supplyPaused = false
  tagRecCustomSession.allowUnverified = false
  tagRecCustomSession.digPending = false
  tagRecCustomSession.digRunning = false
  tagRecCustomSession.digResumeAt = 0
  sharedUpSearch.reset()
  sharedDryTids.clear()
  sharedMemberSignature = undefined
  resetTagRecLadderState(sharedLadderState)
  sharedDeliveryReplay.clear()
  sharedSeenBvids.clear()
  sharedPrevConditionAtoms = undefined
  sharedPrevAtomsSig = undefined
  sharedRemovedConditionAtoms = []
  sharedBufferQueue.length = 0
  sharedCandidates.clear()
  sharedAtomTurns.credits.clear()
  sharedWorkbenchTrialId = undefined
  sharedFilterSignature = undefined
  trialStash.clear()
}

/** 测试/诊断用: 拉取级去重集 (共享存货的一部分; 切尝试/打开显示已看时重开收集)。 */
export function tagRecCustomSharedSeenBvids() {
  return sharedSeenBvids
}

/** 测试/诊断用: 未上屏共享队列 (本地先行闸/成本预览的存量来源)。 */
export function tagRecCustomSharedBufferQueue() {
  return sharedBufferQueue
}

/** 测试/诊断用: 已交付内容的有界回放池 (票 002; 「显示已看」打开时零请求供给)。 */
export function tagRecCustomSharedDeliveryReplay() {
  return sharedDeliveryReplay
}

/** 测试/诊断用: 同试验配方编辑时被删的条件原子 (票 004; 旧语境存货判定的原料)。 */
export function tagRecCustomSharedRemovedAtoms() {
  return sharedRemovedConditionAtoms
}

/**
 * 选条件成本预览 (Q8a, 零请求): 假设该原子加入当前组合后, 本地存量 (队列 ∪ 候选池) 有多少条
 * 会被证成 match, 以及它会并入同字段「或」组还是跨字段「且」(与 addTagRecCondition 落点一致)。
 */
export function tagRecLocalConditionImpact(atom: TagRecConditionAtom): { hits: number; join: 'any' | 'all' } {
  const combination = tagRecCustomSession.workingGroup?.combination
  const join = combination?.include.children.some((child) => child.kind === 'group' && child.name === atom.field)
    ? ('any' as const)
    : ('all' as const)
  if (!combination) return { hits: 0, join }
  // 组合来自 valtio 代理: structuredClone 拒绝代理, 用 cloneDeep 深拷 (workbench 同款)
  const next = cloneDeep(combination)
  if (!addTagRecCondition(next, atom) || !validateTagRecCombination(next)) return { hits: 0, join }
  const pool = new Map<string, TagRecItemExtend>()
  for (const item of [...sharedBufferQueue, ...sharedCandidates.values()])
    if (item.api === EApiType.TagRec && item.bvid) pool.set(item.bvid, item)
  let hits = 0
  for (const item of pool.values()) if (evalTagRecCombination(item, next).state === 'match') hits += 1
  return { hits, join }
}

/** A4-6: 「清空已看」联动 —— 持久池清完, 跨轮内存去重同步清 (经 service-map 注册表调达, 保惰性边界) */
export function clearTagRecCustomSharedSeenBvids() {
  sharedSeenBvids.clear()
}

/**
 * 票 32/44: 成员语境签名 = 选定组 tag_ids ∪ 扩选暂存位 归一去重 id 集 (序不敏感) ——
 *   提升模块级: 构造期同步与 useRefresh 漂移判定复用 (体同原 computeMemberSignature)
 * AUDIT-09: 并入输入原文归一化 —— 锚点随 inputText 派生, 输入变即语境变;
 *   修「expandedIds 空+组未动时 beginTagRecCustomQuery(new) 的 refresh 被签名恒等判丢」
 */
export function tagRecCustomQueryGroups(): TagGroup[] {
  return tagRecCustomSession.workingGroup
    ? [tagRecCustomSession.workingGroup]
    : pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds)
}
/**
 * tab1 同款版号记忆化 (巨型收藏夹 535 组规模修复): resolver/签名输入集 =
 * favorites/favoritesL1/blocks/settings.tagRec/customSession (+sharedSession 入语境键);
 * 非代理输入退化为逐次直算, 与缓存前语义一致。
 */
function customResolverKey(): string | undefined {
  const rk = tagRecVersionKey([favorites.list, favoritesL1.list, tagRecCombinationBlocks, settings.tagRec])
  // 会话态按「参与求解的字段」内容入键 (tab1 同款) —— phase2/partitionPending 等
  // 每轮写字段不再连带失效; workingGroup/draftGroup stringify 量级 KB 可承受
  if (rk === undefined) return undefined
  const sess = JSON.stringify([
    tagRecCustomSession.workingGroup ?? null,
    tagRecCustomSession.draftGroup ?? null,
    tagRecCustomSession.inputText,
    tagRecCustomSession.expandedIds,
    tagRecCustomSession.selectedGroupIds,
    tagRecCustomSession.filterOverride ?? null,
    tagRecCustomSession.allowUnverified,
  ])
  return `${rk}|s:${sess}`
}
function customContextKey(): string | undefined {
  const rk = customResolverKey()
  if (rk === undefined) return undefined
  return `${rk}|sh:${JSON.stringify([tagRecCustomSession.bypassSeen, tagRecSharedSession.recoveryRevision])}`
}
const customResolverSlot = versionedSlot<TagRecScopeResolve>()
const customSourceSigSlot = versionedSlot<string>()
const customContextSigSlot = versionedSlot<string>()
const customFilterSigWithSources = versionedSlot<string>()
const customFilterSigNoSources = versionedSlot<string>()

export function computeTagRecCustomSourceSignature(): string {
  return customSourceSigSlot(customResolverKey(), () => {
    const groups = tagRecCustomQueryGroups()
    const consumers: TagRecConsumer[] = groups.map((g) => ({ key: { id: g.id }, name: g.name }))
    if (tagRecCustomSession.inputText || tagRecCustomSession.expandedIds.length)
      consumers.push({ key: undefined, name: '', input: true })
    const d = tagRecCustomSession.draftGroup
    const resolve = createTagRecScopeResolver({
      globalExclusions: tagRecCombinationBlocks.list,
      globalExclusionsInvalid: tagRecCombinationBlocks.invalid,
      core: settings.tagRec.filter,
      sessionCore: tagRecCustomSession.filterOverride,
      groupsById: new Map(favorites.list.map((g) => [g.id, g])),
      groupsByName: new Map(favorites.list.map((g) => [g.name, g])),
      l1ById: new Map(favoritesL1.list.map((l) => [l.id, l])),
      fallbackGroup:
        tagRecCustomSession.workingGroup ??
        (d
          ? {
              id: '__draft__',
              name: d.name,
              tag_ids: [],
              enabled: true,
              weight: 1,
              addedAt: 0,
              overrides: { negative: d.negative },
            }
          : undefined),
    })
    return tagRecSourceSignature(consumers, resolve)
  })
}

export function computeTagRecCustomContextSignature(): string {
  return customContextSigSlot(customContextKey(), () => {
    const working = tagRecCustomSession.workingGroup
    if (working)
      return `workbench:${JSON.stringify([working.id, working.l1Id, working.combination ? tagRecCombinationSignature(working.combination) : working.tag_ids])}|seen:${!!tagRecCustomSession.bypassSeen}:${tagRecSharedSession.recoveryRevision}|sources:${computeTagRecCustomSourceSignature()}`
    const ids = new Set<number>()
    for (const g of tagRecCustomQueryGroups()) for (const e of g.tag_ids) ids.add(e.id)
    for (const e of tagRecCustomSession.expandedIds) ids.add(e.id)
    const inputNorm = normalizeTagName(tagRecCustomSession.inputText)
    // 空语境 (无选定组且无扩选且无输入) 不参与签名生命周期 —— syncCustomSharedState 守门语义保持
    if (!ids.size && !inputNorm && !tagRecCustomSession.selectedGroupIds.length) return ''
    // R5-P1-11: 组身份入签 —— 两组共用全部 tag_id 时签名原恒等, A→B 切组不重置共享盒,
    //   A 境存货(队/堆/seen)按 B 语境继续放行; 组 id 排序入签后同 ids 异组也判漂移
    const gids = [...tagRecCustomSession.selectedGroupIds].sort().join('+')
    return (
      [...ids].sort((a, b) => a - b).join(',') +
      `|in:${inputNorm}|g:${gids}|seen:${!!tagRecCustomSession.bypassSeen}:${tagRecSharedSession.recoveryRevision ?? 0}|sources:${computeTagRecCustomSourceSignature()}`
    )
  })
}

/**
 * 票 44: 签名比对前移 —— 「有旧签名且不同」即原地重置共享态; 构造期+fetchMore 双点调用。
 *   构造期必须: loadMore 先放 bufferQueue 后进 fetchMore, 不前置同步 = 旧境存货被当新境首页放行
 */
function syncCustomSharedState(): { sig: string; changed: boolean } {
  const sig = computeTagRecCustomContextSignature()
  // 空语境 (无选定组且无扩选) 不参与签名生命周期: 不钉不重置 —— 构造期先于 session 就绪时
  // 钉下 '' 会把 fetchMore 的 ''→真签名 误判成语境切换, 清空测试/运行期攒下的共享态
  if (!sig) return { sig, changed: false }
  const members = sig.split('|sources:', 1)[0]
  const changed = sharedMemberSignature !== undefined && members !== sharedMemberSignature
  // 「显示已看」开关只切显示态: 成员段仅 seen 开关位不同 (代际段一致 => 不是清空已看) 才算
  const seenOnlyDelta = changed && tagRecMembersCore(members) === tagRecMembersCore(sharedMemberSignature!)
  // 切尝试 / 打开显示已看 = 收集语境切换 (非配方微调): 重开拉取去重与干态, 重拉的头页与
  //   续挖货才能再入队 (显示已看开 => 旧内容照常上屏; 关 => 由已看集过滤)。无此重置时
  //   切回旧尝试净增≈0: 游标归零重拉的头页全被拉取去重拦死, 只剩 archive 衍生条能过。
  //   同尝试编辑配方仍保 seen/干态 (no reflowed deliveries)。
  const trialId = tagRecWorkbench.activeId
  if (tagRecCustomSession.workingGroup) {
    const trialChanged = sharedWorkbenchTrialId !== undefined && trialId !== sharedWorkbenchTrialId
    // 票 004: 原子集变迁只在"同试验且原子集真变了"时重算 —— 输入词/选组变动不冲掉被删原子
    const currentAtoms = tagRecCustomSession.workingGroup.combination
      ? tagRecConditionAtoms(tagRecCustomSession.workingGroup.combination.include)
      : []
    const atomsSig = currentAtoms.map(tagRecConditionKey).join('|')
    if (trialChanged) {
      // 暂存必须在清账前 —— 清账后再 capture 存进档的就是空账本, 切回时残留标记全丢 (审计 D2)
      if (sharedWorkbenchTrialId) trialStashCapture(sharedWorkbenchTrialId)
      sharedPrevConditionAtoms = undefined
      sharedPrevAtomsSig = undefined
      sharedRemovedConditionAtoms = []
    } else if (atomsSig !== sharedPrevAtomsSig) {
      const curKeys = new Set(currentAtoms.map(tagRecConditionKey))
      // 累计账 (审计修复): 历轮被删且至今未回归的原子都记着 —— 只记最近一次 diff 的话,
      //   连续删除 [X,Y] 中 X 后 Y 时 X 的归因存货会解封, 重占取条分区/核查额度
      const removed = new Map<string, TagRecConditionAtom>()
      for (const atom of [...sharedRemovedConditionAtoms, ...(sharedPrevConditionAtoms ?? [])]) {
        const key = tagRecConditionKey(atom)
        if (!curKeys.has(key)) removed.set(key, atom)
      }
      sharedRemovedConditionAtoms = [...removed.values()]
      sharedPrevConditionAtoms = currentAtoms
      sharedPrevAtomsSig = atomsSig
    }
    if (trialChanged) {
      // 暂存上一试验的有界库存 (capture 已在上文清账前完成): 清场会把未上屏存货连同拉取记忆一起丢,
      //   但 sediment 深挖游标是持久层不随清 —— 不暂存则切回时游标越过、存货却永久丢失
      sharedSeenBvids.clear()
      sharedDryTids.clear()
      // 切试验 = 换语境 (不是同试验编辑配方): 上一试验的兜底堆/候选/存货/深挖流/轮转游标
      //   全是它的产物, 不能漂到新试验上 —— 工作副本组 id 恒 __tagrec_working__, 作用域闸
      //   分不开两个试验 (实机: 山西/人文 试验的美食「相似」条切到 kingexit 后仍从堆里放行,
      //   还被富化器改写成新试验的徽标)。同试验编辑仍按下面 changed 分支保留存货 (no reflow)。
      //   有暂存档 => 原地恢复上一试验状态 (含清过的 seen/dry), 等效「试验内存页切出/切回」
      if (!(trialId && trialStashRestore(trialId))) {
        resetTagRecLadderState(sharedLadderState, true)
        sharedUpSearch.reset(true)
        sharedBufferQueue.length = 0
        sharedCandidates.clear()
        sharedAtomTurns.credits.clear()
      }
      // 票 005/006: 换试验 => 上屏计数器归零 (生产路径归零口; resetTagRecCustomSharedState 是测试专用)
      tagRecCustomSession.replayDelivered = 0
      tagRecCustomSession.partitionAbandoned = 0
      tagRecCustomSession.partitionBudgetExhausted = false
    } else if (seenOnlyDelta) {
      // 票 002/003 + 审计: 「显示已看」开/关**双向**都只切显示态 —— 不清 seen/干态、
      //   不动深挖/epoch (原实现只豁免关→开, 开→关仍连带 invalidate 深挖流与干轮纪律)。
      //   要看的内容由回放池零请求供给; 代际变 (清空已看) 不算 seenOnlyDelta, 走真变更。
    } else if (!changed) {
      // 同组合重开尝试 (签名未变): 补一次分支级重置 —— 在途批作废 + 干轮纪律复位
      sharedUpSearch.invalidate()
      sharedLadderState.epoch++
      sharedLadderState.earlyStopped = false
      sharedLadderState.lowYieldStreak = 0
    }
  }
  sharedWorkbenchTrialId = trialId
  // 工作台语境下「显示已看」开关单变不算语境变更 —— 不进重置分支 (非工作台语境
  //   维持原语义: seen 位在成员签名里, 开关切换仍按语境切换重收)
  if (changed && !(tagRecCustomSession.workingGroup && seenOnlyDelta)) {
    // 票 005/006: 语境签名变 => 上屏计数器归零 (回放条数按条件键计; 放弃计数下轮按账目自重算)
    tagRecCustomSession.replayDelivered = 0
    tagRecCustomSession.partitionAbandoned = 0
    tagRecCustomSession.partitionBudgetExhausted = false
    if (tagRecCustomSession.workingGroup) {
      // Editing a recipe preserves paid source cursors, candidates, and the seen/risk clocks.
      // Stock stays in the queue and is re-scored under the new recipe — no reflowed deliveries.
      sharedUpSearch.invalidate()
      sharedLadderState.epoch++
      sharedLadderState.earlyStopped = false
      sharedLadderState.lowYieldStreak = 0
    } else {
      sharedUpSearch.reset(true)
      sharedDryTids.clear()
      // 票 37: 语境换 => 深挖空间/存货/去重记忆一并重置 (共享引用原地清, 本实例与后续实例同视)
      resetTagRecLadderState(sharedLadderState, true)
      sharedSeenBvids.clear()
      sharedBufferQueue.length = 0
      sharedCandidates.clear()
    }
  }
  sharedMemberSignature = members
  // changed 对调用方表达"真语境变更": wg 下 seen 开关单变只切显示态, 不武装深挖/重置锚点
  return { sig, changed: changed && !(tagRecCustomSession.workingGroup && seenOnlyDelta) }
}

/**
 * 实修票①「放宽过滤救不活已滤条」: 过滤生效签名 —— 覆盖生效链全部输入
 *   (全局核心 + 会话覆盖副本 + 各组负向/严格/overrides + 各 L1 + 草稿组负向件; 改名也入签)。
 *   变 => 仅清跨轮 seenBvids: 下轮 tag/top 重采样时已滤条重新进池参评 —— 零新增请求
 *   (浅池按 tid 采样本轮必拉, 签名只切条级去重记忆); 真看过的在 seen-set 不复活。
 *   收紧侧由 refilterSharedQueue 覆盖存货 (构造期), 本签名管放宽侧的复活资格;
 *   深挖已消费页中的未交付原料由候补缓存重评，页游标不倒退。
 */
/** A4-3: 过滤签名计算外提 —— service-map 漂移判定复用 (在途刷新的收紧型 emit 不再被静默丢) */
export function computeTagRecCustomFilterSignature(withoutSources = false): string {
  const slot = withoutSources ? customFilterSigNoSources : customFilterSigWithSources
  const sig = slot(customResolverKey(), () => {
    const d = tagRecCustomSession.draftGroup
    return computeTagRecFilterSignature({
      core: settings.tagRec.filter,
      sessionCore: tagRecCustomSession.filterOverride,
      groups: favorites.list,
      l1s: favoritesL1.list,
      withoutSources,
      // 草稿兜底组与 draftAsGroup 同形映射 (strict=>negative_strict, negative=>overrides.negative)
      fallbackGroup:
        tagRecCustomSession.workingGroup ??
        (d
          ? {
              name: d.name,
              negative_tag_ids: d.negative_tag_ids,
              negative_strict: d.strict,
              overrides: d.negative ? { negative: d.negative } : undefined,
            }
          : undefined),
    })
  })
  // 节奏开关 (supplyPaused) 不进签名 —— 它只停取新, 不改核验/过滤语义,
  //   混入会令切换时掀纪元丢在途批、重置深挖纪律
  return (
    sig +
    `|unverified:${tagRecCustomSession.allowUnverified}|globalExclusions:${JSON.stringify([tagRecCombinationBlocks.list, tagRecCombinationBlocks.invalid])}`
  )
}

function syncCustomFilterState() {
  const source = computeTagRecCustomSourceSignature()
  const sig = computeTagRecCustomFilterSignature(true) + '|sources:' + source
  if (sharedFilterSignature !== undefined && sig !== sharedFilterSignature) {
    // R5-P1-09: 放宽侧复活链须连清「零新增」干态 —— tid 被标干后 isDry 在请求前就截,
    //   只清 seenBvids 的「已滤条重新进池参评」承诺对干 tid 不兑现 (空响应型干态会自重标, 代价有界)
    sharedUpSearch.invalidate()
    sharedDryTids.revive(tagRecReopenedTopTids(sharedFilterSignature.split('|sources:', 2)[1], source, favorites.list))
    sharedLadderState.epoch++
    sharedLadderState.earlyStopped = false
    sharedLadderState.lowYieldStreak = 0
  }
  sharedFilterSignature = sig
}

/** [tag-rec] 票 13-fix: 空语境(待解析输入)退避期有界重试上限 —— 超限终止本轮, 防零让出空转/无限挂起刷新 */
const TAG_REC_EMPTY_CONTEXT_MAX_RETRIES = 2

export class TagRecCustomService extends BaseTabService {
  static PAGE_SIZE = 20

  /**
   * 票 44: 语境签名快照 —— useRefresh 判定在途刷新是否被语境变更 (选组/扩选/锚点变) 作废顶替;
   * AUDIT-09/16: 输入解析成功触发「组⇄草稿互斥」弃组 => 签名换型 (id段∪in段 => in段),
   *   doResolveAnchor 内同步共享态后原地重钉本字段 —— 故非 readonly
   */
  contextSignature: string

  /**
   * A4-3: 过滤签名构造期钉点 —— drift 判定的「收紧型过滤变更」轴;
   *   刻意不随 fetchMore 重钉 (放宽侧复活走 seenBvids 通道自愈, 钉点漂移保留给 drift 判定消费);
   *   轻应用已同步生效链 => 原位重钉 (非 readonly, 否则 service 在漂移判定里恒漂移被顶替)
   */
  filterSignature: string
  /** 生效过滤 JSON 基线 (轻应用 no-op 判定): materialize 后内容 —— 勾空名单等无效果编辑不触发重滤 */
  private effectiveFilterJson?: string

  constructor() {
    super(TagRecCustomService.PAGE_SIZE)
    consumeTagRecDeepLink()
    const context = syncCustomSharedState()
    // 审计: 每次访问新建 service => 回放计数按本次访问重新计 (replayShown 同为实例级;
    //   否则同语境刷新会把同一批回放条重复计入, 「回放 N 条」越刷越大)
    tagRecCustomSession.replayDelivered = 0
    this.contextSignature = context.sig // 票 44: deeplink 可写 session, 消费后再取签名
    syncCustomFilterState() // 实修票①: 过滤配置漂移 => seenBvids 复位, 放宽后已滤条重获参评资格
    sharedUpSearch.sync(this.recheckPlan().up)
    this.filterSignature = computeTagRecCustomFilterSignature() // A4-3: 构造期钉点 (不随轮重钉)
    this.effectiveFilterJson = JSON.stringify(this.effectiveFilter())
    this.qs.bufferQueue = sharedBufferQueue // 票 37: 未上屏存货跨刷新存活 (签名变时上行已清)
    this.refilterSharedQueue() // 实修: 配置漂移 (组 override/会话覆盖/全局改) 后刷新, 存货按新生效链重滤
    this.retryPartitions()
  }

  private partitionBudget?: TagRecPartitionBudget
  /** 票 005: 停牌 bvid → 已被暂停轮数 (重试有上限, 不再无限期白吃额度) */
  private partitionHeld = new Map<string, number>()
  /** 封顶时刻账 (bvid → 达 heldMax 的时刻): 只有封顶条按各自冷却自动复活;
   *   未封顶条尝试账不受自动续批影响 (否则慢轮转条永远累积不到上限, heldMax 形同虚设) */
  private partitionHeldCapAt = new Map<string, number>()
  private partitionPausePolicy?: string
  get autoLoadPaused() {
    if (tagRecCustomSession.partitionPaused && this.partitionPausePolicy !== computeTagRecCustomFilterSignature()) {
      this.partitionHeld.clear()
      this.partitionHeldCapAt.clear()
      this.retryPartitions()
    }
    return tagRecCustomSession.supplyPaused && !this.qs.bufferQueue.length
  }

  /** 分区核验/停牌旋钮 —— 读 settings.tagRec.ladder 热更, GM 注入值经 LADDER_BOUNDS 钳制 */
  private partitionLimits() {
    const o = clampTagRecLadderOpts(settings.tagRec.ladder)
    return {
      requests: o.verifyRequests ?? TAG_REC_VERIFY_REQUESTS,
      candidates: o.verifyCandidates ?? TAG_REC_VERIFY_CANDIDATES,
      ms: o.verifyMs ?? TAG_REC_VERIFY_MS,
      heldQuota: o.heldRetryQuota ?? TAG_REC_HELD_RETRY_QUOTA,
      heldMax: o.heldMaxAttempts ?? TAG_REC_HELD_MAX_ATTEMPTS,
    }
  }
  retryPartitions(reviveHeld = false) {
    // 票 005: 停牌身份保留 (不开不经核查直出的口子), 尝试数归零再给轮转额度 ——
    //   明令再试 (reviveHeld) 全量归零; 自动续批只复活「封顶且各自冷却到期」的条,
    //   未封顶条继续累积 (每批全清会让慢轮转条永远到不了 heldMax)
    if (reviveHeld) {
      for (const bvid of this.partitionHeld.keys()) this.partitionHeld.set(bvid, 0)
      this.partitionHeldCapAt.clear()
    } else {
      const max = this.partitionLimits().heldMax
      for (const [bvid, attempts] of this.partitionHeld) {
        if (attempts < max) continue
        const capAt = this.partitionHeldCapAt.get(bvid)
        if (capAt === undefined) {
          this.partitionHeldCapAt.set(bvid, Date.now()) // 无账封顶条: 补记冷却起点
          continue
        }
        if (Date.now() < capAt + TAG_REC_HELD_REVIVE_MS) continue
        this.partitionHeld.set(bvid, 0)
        this.partitionHeldCapAt.delete(bvid)
      }
    }
    tagRecCustomSession.partitionPaused = false
    tagRecCustomSession.partitionPending = 0
    tagRecCustomSession.partitionAbandoned = 0
    tagRecCustomSession.partitionBudgetExhausted = false
  }
  beginLoadOperation(signal: AbortSignal) {
    this.endLoadOperation()
    const limits = this.partitionLimits()
    this.partitionBudget = new TagRecPartitionBudget(signal, limits)
  }
  endLoadOperation() {
    this.partitionBudget?.dispose()
    this.partitionBudget = undefined
  }

  override tabbarView = <TagRecCustomTabbarView service={this} />
  override sidebarView = undefined
  /**
   * Actual local candidates; counts are not result totals.
   * deliverable/held 与交付路径共用同一套本地闸: 生效链逐池 evalTagRecChain
   *   (来源池/负向/名单/组合三态/小池降级兜底, deferPartitions 同 runFilterStage),
   *   再叠组合三态 —— 真过滤会杀掉的条目不再谎报可交付; 分区暂存条计 held 不计库存。
   */
  getDiscoveryStatus() {
    const candidates = new Map<string, TagRecItemExtend>()
    for (const item of [...sharedCandidates.values(), ...sharedBufferQueue])
      if (item.api === EApiType.TagRec)
        candidates.set(item.bvid, mergeTagRecVideoEvidence(item, getCachedTagRecVideoEvidence(item.bvid)))
    const combination = tagRecCustomSession.workingGroup?.combination
    const all = [...candidates.values()]
    const resolve = this.scopeResolver()
    const poolSizes = tagRecPoolSizes(all)
    const negPools = tagRecNegativePools()
    const passForPool = (item: TagRecItemExtend, pool: TagRecPoolKey) => {
      projectTagRecActiveClaims(item, resolve)
      const ctx: TagRecFilterCtx = {
        negative: { pools: negPools },
        queryMatches: this.queryMatcher(),
        deferPartitions: true,
        relatedFallback: this.relatedFallbackOn(),
      }
      for (const key of tagRecChainKeysOf(item)) {
        for (const p of tagRecPoolsForChain(item, key)) {
          if (p !== pool) continue
          const eff = resolve(key, p)
          if (
            evalTagRecChain(item, eff, {
              ...ctx,
              sourcePool: p,
              poolSize: poolSizes[tagRecPoolScopeKey(key, p)],
            }) == null
          )
            return true
        }
      }
      return false
    }
    return TAG_REC_ALL_POOL_KEYS.map((pool) => {
      const items = all.filter((item) => tagRecSourceClaims(item).some((claim) => poolOfVia(claim.via) === pool))
      const verdicts = items.map(
        (item) =>
          [tagRecDeliverable(item, combination), passForPool(item, pool), this.partitionHeld.has(item.bvid)] as const,
      )
      return {
        pool,
        cached: items.length,
        deliverable: verdicts.filter(([state, pass, held]) => state === 'match' && pass && !held).length,
        held: verdicts.filter(([state, pass, held]) => pass && (state === 'pending' || held)).length,
        tagsPending: items.filter((item) => item.ownTagIds === undefined).length,
      }
    })
  }
  /** Explicit, bounded batch for browsing tag/top materials; never raises request limits. */
  async completeDiscoveryTags(pool: TagRecPoolKey, signal: AbortSignal) {
    const policy = computeTagRecCustomFilterSignature()
    if (tagRecBackoff.isEngaged || signal.aborted || this.isSessionStale())
      return { updated: 0, attempted: 0, stale: true }
    const candidates = new Map<string, TagRecItemExtend>()
    for (const item of [...sharedBufferQueue, ...sharedCandidates.values()])
      if (
        item.api === EApiType.TagRec &&
        tagRecSourceClaims(item).some((claim) => poolOfVia(claim.via) === pool) &&
        item.ownTagIds === undefined
      )
        candidates.set(item.bvid, item)
    const pending = [...candidates.values()].slice(0, 20)
    const budget = new TagRecPartitionBudget(signal, this.partitionLimits())
    let cursor = 0
    let updated = 0
    let attempted = 0
    const stale = () => signal.aborted || this.isSessionStale() || policy !== computeTagRecCustomFilterSignature()
    try {
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          while (cursor < pending.length && !stale() && !tagRecBackoff.isEngaged) {
            const item = pending[cursor++]
            attempted++
            const evidence = await budget.lookupEvidence(item.bvid)
            if (stale()) return
            if (evidence?.ownTagIds !== undefined) {
              Object.assign(item, mergeTagRecVideoEvidence(item, evidence))
              updated++
            }
          }
        }),
      )
      if (!stale() && updated) sharedCandidates.needsRefilter = true
      return { updated, attempted, stale: stale() }
    } finally {
      budget.dispose()
    }
  }
  private recheckPlan() {
    const groups = tagRecCustomQueryGroups()
    const inputs = this.queryEntries().filter((e) => !groups.some((g) => g.tag_ids.some((t) => t.id === e.id)))
    const rounds = [
      ...groups.flatMap((g) =>
        g.tag_ids.map((e) => ({ tid: e.id, keyword: e.name, groupIds: [g.id], groupNames: [g.name] })),
      ),
      ...inputs.map((e) => ({ tid: e.id, keyword: e.name, groupNames: [e.name], input: true })),
    ]
    const numeric = parseTagInput(tagRecCustomSession.inputText)?.kind === 'id'
    return planTagRecRecall(
      {
        roundSources: rounds,
        digSources: [
          ...deriveGroupCliques(
            groups.map((g) => ({ ...g, extra: tagRecSearchExtraOf(this.scopeResolver()({ id: g.id }, 'allV2')) })),
            Infinity,
          ),
          ...(!numeric
            ? inputs.map((e) => ({
                key: normalizeTagName(e.name),
                keyword: e.name,
                attribution: [e.name],
                input: true,
              }))
            : []),
        ],
        scopeConsumers: groups.map((group) => ({ key: { id: group.id }, name: group.name })),
      },
      this.scopeResolver(),
    )
  }
  getRecheckOptions() {
    return tagRecRecheckOptions(this.recheckPlan())
  }
  recheck(selection: TagRecRecheckSelection, signal?: AbortSignal) {
    if (tagRecBackoff.isEngaged || this.isSessionStale())
      return Promise.resolve({ requests: 0, added: 0, empty: false, failed: false, stale: true })
    return tagRecRecallScheduler
      .withForegroundSupply(() => this.ladder.recheck(selection, this.recheckPlan(), signal ?? this.lastFetchSignal))
      .then((result) => {
        if (!result.stale && result.added) {
          this.hasMoreExceptQueue = true
          tagRecCustomSession.hardBottom = false
          tagRecCustomSession.digPending = false
        }
        return result
      })
  }
  override restore() {
    this.retryPartitions(true)
    super.restore()
    // 审计: returnQueue 把带「回放」标的克隆回队 —— 标是展示态, 回存货前剥掉
    for (const it of this.qs.bufferQueue) if (it.api === EApiType.TagRec) delete (it as TagRecItemExtend).tagRecReplayed
    sharedCandidates.flushMerged() // 入队门标脏条目批末评分补发 (fav 侧同款守卫)
    const filtered = runTagRecFilter(
      this.qs.bufferQueue.filter((it): it is TagRecItemExtend => it.api === EApiType.TagRec),
      {
        resolve: this.scopeResolver(),
        pools: tagRecNegativePools(),
        queryMatches: this.queryMatcher(),
        deferPartitions: true,
      },
    ).items
    const keep = new Set(filtered)
    this.qs.bufferQueue.splice(
      0,
      this.qs.bufferQueue.length,
      ...this.qs.bufferQueue.filter((it) => it.api !== EApiType.TagRec || keep.has(it)),
    )
  }
  // spec §4.4: 常规 true; 单轮产出 0 (含兜底) => 硬见底翻 false 截停 fetchMinCount 连发
  override hasMoreExceptQueue = true
  /**
   * 审计回填 (A1): 基类 hasMore 只看 `queue.length>0`, 全 stale 队列 (删原子后队列
   *   只剩归因被删原子的残留条) 配 hasMoreExceptQueue=false 时恒真 => footer 视口内
   *   无界空转 (每轮空 loadMore + 全网格 uniqBy/重渲)。活货口径: 任一非 stale 条目
   *   即算有货 —— 原子加回会签名漂移重开语境, 不会假死。
   */
  override get hasMore() {
    if (!this.qs.bufferQueue.length) return this.hasMoreExceptQueue
    return this.queueHasLiveStock() || this.hasMoreExceptQueue
  }
  private liveStockCache: { key: string; hasLive: boolean } | undefined
  private queueHasLiveStock(): boolean {
    const stale = this.stalePredicate()
    if (!stale) return true
    // 扫描键: 队列写版本 + 语境签名 (含组合/账本派生) —— 两不变即复用上轮结论,
    //   否则全量 loadMore 每轮都要对整队跑 atomKeysOf
    const key = `${sharedBufferQueueSeq}|${computeTagRecCustomContextSignature()}`
    if (this.liveStockCache?.key === key) return this.liveStockCache.hasLive
    const hasLive = this.qs.bufferQueue.some((item) => item.api !== EApiType.TagRec || !stale(item))
    this.liveStockCache = { key, hasLive }
    return hasLive
  }
  /** [tag-rec] 票 13-fix: 空语境(待解析输入)退避期重试计数 (成功轮/新查询归零) */
  private emptyContextRetries = 0
  /** [tag-rec] R09: 未决轮 (零产出+失败源) 连续计数 —— 有界重试, 超限抛可重试错误 (定轮归零) */
  private failedSourceRounds = 0

  /** 跨轮 bvid 去重 (语义同 recItemUniqer; 渲染层 concatRecItems 再兜底); 票 37: 模块级共享, 刷新续去重 */
  private seenBvids = sharedSeenBvids
  /** 锚点解析结果缓存 (promise 级, 并发轮共享; 失败不缓存允许重试) */
  private anchorPromise: Promise<TagIdEntry | undefined> | undefined
  private anchorEntry: TagIdEntry | undefined
  private anchorInfo: TagInfo | undefined // 含 count.use 的完整锚点
  private anchorInput = '' // Phase 2 检索词 (= 输入原文)
  private inputNorm = ''
  private isIdPath = false // 数字直输逃生口: 零解析不过 Phase 2/沉淀池

  /** 本 service 查询单元: 锚点 + 字形变体 id (Phase 2 自动并入) + 用户扩选 id */
  private queryIds = new Map<number, string>() // tag_id -> 归因名
  private discoveredVariants: TagIdEntry[] = []
  /** A5: scoreParams 记忆盒 —— {core, sig} 双闸失配即清 (见 ladder opts 注释) */
  private scoreParamsCache = {
    core: undefined as TagRecFilterCore | undefined,
    sig: undefined as string | undefined,
    patch: undefined as typeof tagRecCustomSession.filterOverride,
    resolve: undefined as TagRecScopeResolve | undefined,
  }

  /**
   * 内层 tag 轮转游标 (票 17): 选定 L2 组 id => 游标; 该组 >10 id 每轮取 10 切片逐轮覆盖
   * AUDIT-20: 升共享盒 —— 实例级游标随 refresh 归零 → 永远重拉首片 (全已见 contributed=0 →
   *   干态连击标干 → ids 11..N 会话内饿死); 签名变经 resetTagRecLadderState 随盒同清
   */
  private tagCursors = sharedLadderState.tagCursors
  /** 输入单元 (锚点+变体+扩选) 轮转游标 —— 非 L2 归属, 独立标量 (同 pickTagIdsForRound 语义) */
  private get queryCursor() {
    return sharedLadderState.queryCursor
  }
  private set queryCursor(v: number) {
    sharedLadderState.queryCursor = v
  }

  /**
   * 票 13 兜底梯队: 兜底堆(all/v2 related + archive/related) / all/v2 深挖流(输入锚点流+组同义词簇流)
   * / 共现选种 / 分批放行 / 自动深挖 / 手动待决 / 硬见底 —— D1~D8 编排见 fallback-ladder.ts
   * 票 17 策略分家: tab2 激进档 —— 浅水位 (<10) 同轮预挖 + 自适应自动深挖 (三停转手动横幅)
   */
  private ladder = new TagRecFallbackLadder(
    {
      seenBvids: this.seenBvids,
      resolve: () => this.scopeResolver(),
      relatedSeedingAllowed: () => this.relatedSeedingAllowed(),
      bypassSeen: () => tagRecCustomSession.bypassSeen,
      policySignature: () => computeTagRecCustomSourceSignature() + computeTagRecCustomFilterSignature(true),
      observe: (items) => {
        sharedCandidates.resolve = this.scopeResolver()
        sharedCandidates.record(items)
      },
      recallPlan: () => this.recheckPlan(),
      applyStages: (items, ctx) => this.applyStages(items, ctx),
      rankItems: (items) => this.runScoreStage(items),
      seedMinScoreOf: (item) => resolveTagRecSeedMinScore(item, this.scopeResolver()),
      mergeExisting: (item) =>
        sharedCandidates.mergeIncoming(
          item,
          sharedQueueIndex.map() as ReadonlyMap<string, TagRecItemExtend>,
          (items) => this.runScoreStage(items),
          sharedLadderState.heap,
          sharedHeapIndex.map(),
        ),
      // AUDIT-15: 落货守门不在此处钉点判 stale —— fetchMore 自愈续跑的实例钉点恒旧会误伤新语境产出;
      //   改由 fallback-ladder 共享态纪元门兜 (批跑期间共享盒 reset => 旧境产出不落盒)
      pushQueue: (items) => this.enqueueStock(items),
      queueSize: () =>
        this.qs.bufferQueue.filter((item) => item.api === EApiType.TagRec && (item.eligibleGroupKeys?.length ?? 1) > 0)
          .length,
      poolItems: () => sharedCandidates.values(),
      candidateScope: () => this.supplyScope(),
      hasDemandStock: () => this.supplyScope().ready,
      // 票05 paramsOf: 逐条按所属池槽求解 (兜底堆混 allV2/archiveRelated/tagTop)
      // A5: 逐调 cloneDeep 代价 × 堆内条数 => 按池记忆化; 失效令牌 = sharedFilterSignature
      //   (覆盖生效链全输入含 sessionCore/草稿兜底 → 变即换签) + core 对象身份 (filterOverride
      //   整体换替身即失配); 窗内编辑至多迟一轮生效
      scoreParams: (it) => {
        const core = settings.tagRec.filter
        const c = this.scoreParamsCache
        if (c.core !== core || c.sig !== sharedFilterSignature || c.patch !== tagRecCustomSession.filterOverride) {
          c.resolve = this.scopeResolver()
          c.core = core
          c.sig = sharedFilterSignature
          c.patch = tagRecCustomSession.filterOverride
        }
        return resolveTagRecItemScoreParams(it, c.resolve!)
      },
      mergeCandidates: (rows) => {
        tagRecCustomSession.candidates = mergeCandidateRows(tagRecCustomSession.candidates, rows)
      },
      mergeVariants: (entries) => {
        for (const v of entries) {
          if (!this.queryIds.has(v.id) && !this.discoveredVariants.some((d) => d.id === v.id)) {
            this.discoveredVariants.push({ id: v.id, name: v.name })
          }
        }
      },
      isStale: () => this.isSessionStale(),
    },
    // 票10: settings.tagRec.ladder 全局高级参数 getter 注入 (热更)
    { ...FALLBACK_LADDER_STRATEGY_AGGRESSIVE, ladder: () => settings.tagRec.ladder },
    sharedLadderState, // 票 37: 同签名刷新续挖 (页游标/堆/选种不丢)
  )

  /**
   * 票 32 逐源干态记忆: tag/top 空响应即干 / 零新增连击标干 —— 挂模块级共享 (见文件尾部 shared*):
   *   service 重建/点刷新存活 (刷干的池刷新不再空放一轮 tag/top 抢并发闸, 冷池首屏提速);
   *   成员签名变才清内存干态 —— 票 39 起 empty 标干落 GM 持久图 (TTL 复活), F5 也不再重打死源
   */
  private dryTids = sharedDryTids

  private phase2Running: Promise<unknown> | undefined
  private phase2Started = false
  /**
   * AUDIT-15: 手动深挖生命周期闸 —— fetchMore 入口登记当前 abortSignal;
   *   service 被弃 (刷新顶替/卸载) 时 useRefresh abort 旧 controller => 在途/后续手动深挖批随截停,
   *   不再裸跑推共享游标/往 detach 队列落死货白打 seenBvids
   */
  private lastFetchSignal: AbortSignal | undefined
  private produceTracker = createTagRecProduceTracker()
  private firstDataMarked = false // [tag-rec] perf 票 06: tagrec-first-data 每实例只记一次

  /**
   * 轮次阶段注入点 (spec §4.3): 过滤/算分实装 (票 06), 去已看实装票 08 —— 只换实现不动骨架
   * [tag-rec] filterStage: 全局 settings.tagRec.filter + 会话覆盖副本 + 组内负向 (票 14), 计数/降级写 session
   */
  private stages: TagRecRoundStages = {
    filterStage: (items, ctx) => this.runFilterStage(items, ctx),
    scoreStage: (items, ctx) => this.runScoreStage(items, ctx),
    seenStage: createTagRecSeenStage(tagRecCustomSession, () => tagRecCustomSession.bypassSeen),
  }

  /** 需要完整 core 的边界合入本次差分；取数与算分仍使用各组继承链。 */
  private effectiveFilter(): TagRecFilterCore {
    const core = settings.tagRec.filter
    return tagRecCustomSession.filterOverride
      ? materializeTagRecSessionFilter(core, tagRecCustomSession.filterOverride)
      : core
  }

  /** 草稿组 => TagGroup 伪形 (resolver fallbackGroup 入参): 持本会话一切未归属来源的负向位 (票02/14) */
  private draftAsGroup(): TagGroup | undefined {
    if (tagRecCustomSession.workingGroup) return tagRecCustomSession.workingGroup
    const d = tagRecCustomSession.draftGroup
    if (!d) return undefined
    return {
      id: '__draft__',
      name: d.name,
      tag_ids: this.queryEntries(),
      negative_tag_ids: d.negative_tag_ids,
      negative_strict: d.strict,
      weight: 1,
      enabled: true,
      addedAt: 0,
      // 实修: 草稿组名单容器 (UP/标题/简介/分区双池) —— 右键「本组」写位落此, 未存成项先生效
      ...(d.negative ? { overrides: { negative: d.negative } } : {}),
    }
  }

  /** 生效链求解器 (票01): 会话副本插链顶 + 草稿组兜底未归属名 (负向); 按 store 版号记忆化, 内部按组×池缓存 */
  private scopeResolver(): TagRecScopeResolve {
    const base = customResolverKey()
    // 实例级输入 (anchor/queryIds/discoveredVariants 入 queryEntries) 内容入键 ——
    //   键不含实例态会在深挖推进后误命中旧 resolver; 小集 stringify 代价可忽略
    const key =
      base === undefined
        ? undefined
        : `${base}|q:${JSON.stringify([tagRecCustomSession.anchor ?? null, [...this.queryIds], this.discoveredVariants])}`
    return customResolverSlot(key, () => {
      // Reused candidates keep their real provenance, but every discovery preview
      // must obey the current copy rather than a saved owner's older conditions.
      const groups = tagRecCustomSession.workingGroup ? [tagRecCustomSession.workingGroup] : favorites.list
      return createTagRecScopeResolver({
        globalExclusions: tagRecCombinationBlocks.list,
        globalExclusionsInvalid: tagRecCombinationBlocks.invalid,
        core: settings.tagRec.filter,
        sessionCore: tagRecCustomSession.filterOverride,
        groupsByName: new Map(groups.map((g) => [g.name, g])),
        groupsById: new Map(groups.map((g) => [g.id, g])), // A1-3: id 链权威
        l1ById: new Map(favoritesL1.list.map((l) => [l.id, l])),
        fallbackGroup: this.draftAsGroup(),
        allowUnverified: !!tagRecCustomSession.workingGroup && tagRecCustomSession.allowUnverified,
        queryEntries: this.queryEntries(),
      })
    })
  }

  /** 任一可供给消费者归属库存为零且本轮也没供到货 —— 与 preDig 内层 ready 门同义, 作外层触发 */
  private hasStarvedConsumer(roundItems: readonly TagRecItemExtend[]) {
    const empty = this.supplyScope().empty
    if (!empty.size) return false
    // fed 口径须与库存同域: 只有 match 产出才算供货 —— pending (unknown) 条目 spec 05
    //   明确不计存货, 若计入 fed 会把严格配方下"只出 pending 的组"误判成已供货,
    //   深挖门永远不开 (tag/top 单边货结构上证明不了 all{a,b} 交集, 真产线只有深挖流)
    const combination = tagRecCustomSession.workingGroup?.combination
    const fed = new Set(
      roundItems
        .filter((it) => tagRecDeliverable(it, combination) === 'match')
        .flatMap((it) =>
          tagRecSourceClaims(it).flatMap((claim) =>
            tagRecConsumers(claim)
              .map((c) => tagRecGroupKey(c.key))
              // 同 fav 侧口径: claims ∩ eligibleGroupKeys —— 共享 tid 条目被别组资格放行时
              //   不带本组库存, 裸认 claims 会把资格被剥夺的消费者误判成已供货
              .filter((k) => !it.eligibleGroupKeys || it.eligibleGroupKeys.includes(k)),
          ),
        ),
    )
    return [...empty].some((k) => !fed.has(k))
  }

  private supplyScope() {
    const groups = tagRecCustomQueryGroups()
    const consumers: TagRecConsumer[] = groups.map((g) => ({ key: { id: g.id }, name: g.name }))
    if (
      tagRecCustomSession.inputText ||
      this.queryEntries().some((e) => !groups.some((g) => g.tag_ids.some((t) => t.id === e.id)))
    )
      consumers.push({ key: undefined, name: '', input: true })
    const resolve = this.scopeResolver()
    const combination = tagRecCustomSession.workingGroup?.combination
    // Stock view is signed by the current recipe: only proven matches count as deliverable inventory.
    // Pending (unknown) candidates neither occupy stock nor block fresh recall — spec 05.
    const stock = this.qs.bufferQueue.filter(
      (item): item is TagRecItemExtend =>
        item.api === EApiType.TagRec && tagRecDeliverable(item, combination) === 'match',
    )
    const counts = tagRecSupplyView(sharedCandidates.values(), stock, resolve, 10)
    const active = consumers.filter((c) => {
      const pools = resolve(c.key, 'allV2').poolsEnabled
      return upSearchMids(resolve, c.key) ? pools.allV2 : TAG_REC_ALL_POOL_KEYS.some((pool) => pools[pool])
    })
    const keys = (c: TagRecConsumer) => [tagRecGroupKey(c.key), ...(c.name && !c.input ? [tagRecGroupKey(c.name)] : [])]
    return {
      all: new Set(consumers.flatMap(keys)),
      needed: new Set(active.filter((c) => counts.needs(tagRecGroupKey(c.key))).flatMap(keys)),
      /** 归属库存为零的可供给消费者主键 —— 外层欠产触发用 (与 ready 同口径的逐项分解) */
      empty: new Set(
        active.filter((c) => !counts.groups.get(tagRecGroupKey(c.key))?.size).map((c) => tagRecGroupKey(c.key)),
      ),
      ready: consumers.length
        ? active.length > 0 && active.every((c) => (counts.groups.get(tagRecGroupKey(c.key))?.size ?? 0) > 0)
        : stock.length > 0,
    }
  }

  private queryMatcher() {
    if (tagRecCustomSession.workingGroup?.combination) return () => true
    return createTagRecQueryMatcher(this.queryEntries())
  }

  private queryEntries(): TagIdEntry[] {
    if (tagRecCustomSession.workingGroup) return tagRecCustomSession.workingGroup.tag_ids
    return [
      ...pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds).flatMap((group) => group.tag_ids),
      ...(tagRecCustomSession.anchor ? [tagRecCustomSession.anchor] : []),
      ...[...this.queryIds].map(([id, name]) => ({ id, name })),
      ...this.discoveredVariants,
      ...tagRecCustomSession.expandedIds,
    ]
  }

  /**
   * 实修 (会话覆盖/组 override「刷新」不生效根因): sharedBufferQueue 跨刷新存活 (票37),
   *   存货是旧配置滤出来的, sliceFromQueue 直放不再过阶段 => 配置变了也原样上屏。
   *   构造期把存货原位重过一遍 filterStage (seenStage 不重跑 —— 队列货本就是去重过的, 重跑会被 seen 误杀);
   *   分隔符原样保留 (非 TagRecItem 不进过滤)
   */
  private refilterSharedQueue() {
    const resolve = this.scopeResolver()
    sharedCandidates.resolve = resolve
    const stats = refilterTagRecStock(sharedBufferQueue, this.effectiveFilter(), resolve, {
      queryMatches: this.queryMatcher(),
      pools: tagRecNegativePools(),
      candidates: sharedCandidates,
      recover: (items) => tagRecSeenStage(items, tagRecCustomSession.bypassSeen),
      diversityGuard: settings.tagRec.diversityGuard,
      sliceSize: TagRecCustomService.PAGE_SIZE,
      relatedFallback: this.relatedFallbackOn(),
    })
    if (stats) tagRecCustomSession.filterStats = stats
  }

  /**
   * 小池降级 (池浅已放宽) 时放行 related 路由条目的组合 mismatch —— 工作台之前的语义:
   * 相关条带「相关」徽标交付、不冒充命中; 排除/屏蔽/来源闸不受影响 (见 filter-engine 判据)。
   */
  private relatedFallbackOn() {
    return tagRecCustomSession.filterStats.degraded
  }

  /**
   * 临时过滤轻应用 (过滤面板离场): 重滤存货队列 + 同步签名/纪元 (与重建同口径的簿记) ——
   *   不重建 service、不发请求; 已上屏条目由调用侧经 refilterDisplayed 原位重过一遍。
   * 生效过滤未变 (如勾了空名单/无效果编辑) => 返回 false 整体跳过 —— 不翻纪元不重滤不动画面。
   */
  applySessionFilterLive(): boolean {
    const next = JSON.stringify(this.effectiveFilter())
    if (this.effectiveFilterJson === next) return false
    this.effectiveFilterJson = next
    syncCustomFilterState()
    // 语境签名含组合过滤段 (tagRecCombinationSignature 计入 filters): 组合对象被镜像换身后
    //   钉点过期 => isSessionStale() 恒真、交付循环静默空转 (此前仅 fetchMore 内同步可自愈,
    //   队列有货不走取数的路径永远卡死); 共享态簿记 (深挖流作废/轮次纪元/计数归零) 提前到位
    this.contextSignature = syncCustomSharedState().sig
    this.filterSignature = computeTagRecCustomFilterSignature()
    this.refilterSharedQueue()
    // 过滤已变 => 旧「硬见底」判据失效 (可能正是旧过滤滤空所致): 复位硬见底闩让补货重新评估;
    //   新过滤下若仍零产, 下一轮 exhaustRound 会复置 (同 fetchMore 开头清 hardBottom 的先例)
    this.hasMoreExceptQueue = true
    tagRecCustomSession.hardBottom = false
    return true
  }

  /**
   * 按新生效链过滤已上屏条目 (轻应用用): 缺证据维按缺字段豁免语义放行 (不触发核验、不计滤除账),
   *   核验预算/待决流转仍由后续 loadMore 的常规管线承担。
   */
  refilterDisplayed(items: TagRecItemExtend[]): TagRecItemExtend[] {
    return runTagRecFilter(items, {
      resolve: this.scopeResolver(),
      queryMatches: this.queryMatcher(),
      pools: tagRecNegativePools(),
      deferPartitions: true,
      relatedFallback: this.relatedFallbackOn(),
    }).items
  }

  /**
   * 交集下 related 只是兜底料 —— 兜底门 (degraded) 不开时选种产物纯死库存 (只堆不吐),
   *   且选种要烧名单补查 + archive/related 页请求; 这些火力交集下应留给 all/v2。
   */
  private relatedSeedingAllowed() {
    const wg = tagRecCustomSession.workingGroup
    // 走 resolver 的派生交集标记 —— 生效链 tagAllow 计入同口径 (判定函数只见组合内 filters)
    return !(wg?.combination && this.scopeResolver()({ id: wg.id }, 'allV2').intersection) || this.relatedFallbackOn()
  }

  /** [tag-rec] 过滤阶段: 生效链逐认领组评估 (任一放行); 分维度滤除计数+降级标记写 session */
  private runFilterStage(items: TagRecItemExtend[], ctx?: TagRecRoundCtx): TagRecItemExtend[] {
    // 复用设计 1: resolver 同 pass 只建一次 —— ctx 就地回填, scoreStage 直接复用
    const resolve = ctx ? (ctx.resolve ??= this.scopeResolver()) : this.scopeResolver()
    sharedCandidates.resolve = resolve
    sharedCandidates.record(items)
    const { items: out, stats } = runTagRecFilter(items, {
      resolve,
      queryMatches: this.queryMatcher(),
      pools: tagRecNegativePools(),
      poolSize: ctx?.poolSize ?? ctx?.fetchedCount ?? items.length,
      poolItems: ctx?.poolItems ?? items,
      deferPartitions: true,
      relatedFallback: this.relatedFallbackOn(),
    })
    const prev = tagRecCustomSession.filterStats
    // 旁路产出 (深挖/兜底放行) 走 merge —— 批次量小, 覆盖会把主轮滤除账清零并把 degraded 错钉真
    // A2-8 推广 (2026-10-06): 主轮同样不灭降级灯 —— 空轮 (0 条进过滤) 会把 degraded 误清成 false,
    //   横幅「池浅已放宽」闪烁, 且「小池相关兜底放行」随之失效 (relatedFallbackOn 读同一信号)
    tagRecCustomSession.filterStats = ctx?.mergeStats
      ? {
          dropped: prev.dropped + stats.dropped,
          byDim: Object.fromEntries(
            [...new Set([...Object.keys(prev.byDim), ...Object.keys(stats.byDim)])].map((k) => [
              k,
              (prev.byDim[k as TagRecDropDimKey] ?? 0) + (stats.byDim[k as TagRecDropDimKey] ?? 0),
            ]),
          ),
          byScope: Object.fromEntries(
            [...new Set([...Object.keys(prev.byScope ?? {}), ...Object.keys(stats.byScope ?? {})])].map((k) => [
              k,
              (prev.byScope?.[k] ?? 0) + (stats.byScope?.[k] ?? 0),
            ]),
          ),
          degraded: prev.degraded || stats.degraded, // A2-8: 降级灯一经钉下不被旁路小批灭掉 (池深事实+已发横幅一致)
          unchecked: (prev.unchecked ?? 0) + (stats.unchecked ?? 0) || undefined,
          seenDropped: prev.seenDropped,
        }
      : { ...stats, degraded: prev.degraded || stats.degraded }
    return out
  }

  /**
   * 入队门 bvid 唯一性: 并发生产者窗口 (seenBvids 占位先于 push 落定) 下重复到达并入存量而非复推;
   *   批内同 bvid 只留首份 (stagedBvids)。fav 侧同款守卫见 enqueueStock
   */
  private enqueueStock(items: TagRecItemExtend[]) {
    const qmap = sharedQueueIndex.map() as ReadonlyMap<string, TagRecItemExtend>
    const stagedBvids = new Set<string>()
    const staged: TagRecItemExtend[] = []
    for (const item of items) {
      if (stagedBvids.has(item.bvid)) continue
      const queued = qmap.get(item.bvid)
      if (queued) sharedCandidates.mergeQueued(queued, item, (xs) => this.runScoreStage(xs))
      else {
        staged.push(item)
        stagedBvids.add(item.bvid)
      }
    }
    // 批末一次评分: mergeQueued 标脏的排队条目在此按 BV 去重一次算分 (fav 侧同款守卫)
    sharedCandidates.flushMerged()
    if (staged.length) this.qs.bufferQueue.push(...staged)
  }

  /** [tag-rec] 算分排序阶段: 逐认领组链取 max (票01) + diversityGuard 两轴 (票09) */
  private runScoreStage(items: TagRecItemExtend[], ctx?: TagRecRoundCtx): TagRecItemExtend[] {
    const { items: out } = runTagRecScoreStage(items, this.effectiveFilter(), {
      resolve: ctx?.resolve ?? this.scopeResolver(),
      diversityGuard: settings.tagRec.diversityGuard,
      sliceSize: TagRecCustomService.PAGE_SIZE,
    })
    return out
  }

  /** 旁路产出 (Phase 2 精确召回 / 兜底梯队) 走同一套阶段 (spec §4.3「经同一管线」; ctx.poolSize=票06堆深注入, mergeStats=旁路账并入) */
  private applyStages(items: TagRecItemExtend[], ctx?: Partial<TagRecRoundCtx>) {
    return applyTagRecStages(items, { fetchedCount: items.length, ...ctx }, this.stages)
  }

  /**
   * [tag-rec] 上屏切片严格校验 (negative-slice.ts): 仅对「开了 negative_strict 的源组」条目
   * 逐条 view/detail/tag 核查负向命中 —— 逐条请求是组级自愿付费, 默认关;
   * 退避态直通 + 5s 时间盒 fail-open (negative-slice 内部); 无 strict 源 => 直通
   */
  override async loadMore(abortSignal: AbortSignal): Promise<RecItemTypeOrSeparator[] | undefined> {
    if (abortSignal.aborted || this.autoLoadPaused) return
    const local = !this.partitionBudget
    const budget = this.partitionBudget ?? new TagRecPartitionBudget(abortSignal, this.partitionLimits())
    try {
      return await this.loadPartitionChecked(abortSignal, budget)
    } finally {
      if (local) budget.dispose()
    }
  }

  /** 组合原子分桶键: 条目在当前组合下命中的 include 原子 (公平混排只读判定结果, 不改语义)。 */
  private atomKeysOf(combination: TagRecCombination) {
    const atoms = tagRecConditionAtoms(combination.include)
    return (item: TagRecItemExtend) =>
      atoms
        .filter((atom) => evalTagRecConditionAtom(item, atom).state === 'match')
        .map((atom) => tagRecConditionKey(atom))
  }

  /**
   * 票 004: 旧语境判定 —— 当前原子全不命中 ∧ 归因里引用着被删原子的值。
   *   相关池条目的 claims 不计入 tag 命中 (via 闸), 所以在新配方下只判 unknown 留队,
   *   正好成了残留 —— 用**归因口径** (source.tagIds ∪ claims[].tagIds ∪ 召回词名) 而不是命中口径来标。
   *   审计回填: 搜索类渠道 (all-v2/up-search) 的 claims 从不带 tagIds 只有 queryKeyword ——
   *   补按名归一匹配, 否则删 up/标题/简介原子的残留结构性漏网, tag 原子的 all-v2 召回
   *   残留 (queryKeyword=被删标签名) 同样漏网。双命中条目仍安全: stale 前提是全不命中。
   */
  private stalePredicate(): ((item: TagRecItemExtend) => boolean) | undefined {
    const combination = tagRecCustomSession.workingGroup?.combination
    if (!sharedRemovedConditionAtoms.length || !combination || !validateTagRecCombination(combination)) return undefined
    const atomKeysOf = this.atomKeysOf(combination)
    const keywordHit = (item: TagRecItemExtend, word: string) =>
      (item.source.queryKeyword !== undefined && normalizeTagName(item.source.queryKeyword) === word) ||
      !!item.source.claims?.some(
        (claim) => claim.queryKeyword !== undefined && normalizeTagName(claim.queryKeyword) === word,
      )
    const tests = sharedRemovedConditionAtoms.map((atom): ((item: TagRecItemExtend) => boolean) => {
      if (atom.field === 'tag') {
        const id = atom.value.id
        const name = atom.value.name ? normalizeTagName(atom.value.name) : ''
        return (item) =>
          !!item.source.tagIds?.includes(id) ||
          !!item.source.claims?.some((claim) => claim.tagIds?.includes(id)) ||
          (!!name && keywordHit(item, name))
      }
      const word =
        atom.field === 'up'
          ? normalizeTagName(atom.value.name)
          : atom.field === 'title' || atom.field === 'desc'
            ? normalizeTagName(atom.value)
            : ''
      return word ? (item) => keywordHit(item, word) : () => false
    })
    return (item) => !atomKeysOf(item).length && tests.some((test) => test(item))
  }

  /** 本地可交付存量 (localFirst 闸用): 队列内已证满足当前组合且未暂存的条数。 */
  private localDeliverableCount() {
    const combination = tagRecCustomSession.workingGroup?.combination
    return this.qs.bufferQueue.filter(
      (item) =>
        item.api === EApiType.TagRec &&
        !this.partitionHeld.has(item.bvid) &&
        tagRecDeliverable(item, combination) === 'match',
    ).length
  }

  private async loadPartitionChecked(
    abortSignal: AbortSignal,
    budget: TagRecPartitionBudget,
  ): Promise<RecItemTypeOrSeparator[] | undefined> {
    const oldFilter = sharedFilterSignature
    syncCustomFilterState()
    if (oldFilter !== sharedFilterSignature) {
      this.partitionHeld.clear()
      this.partitionHeldCapAt.clear()
      // 审计: 账目清空同步清会话计数 —— 否则本轮早退会把过期的「待核实/放弃/额度尽」留在横幅
      this.retryPartitions(true)
    }
    if (oldFilter !== sharedFilterSignature || sharedCandidates.needsRefilter) this.refilterSharedQueue()
    if (!this.hasMore) return
    const onlyHeld =
      this.qs.bufferQueue.length > 0 &&
      this.qs.bufferQueue.every((item) => item.api !== EApiType.TagRec || this.partitionHeld.has(item.bvid))
    // spec 05: 库存视图驱动取新 —— 待核实不占库存; 任一活跃消费者库存低于水位即召回,
    //   不再等队列物理见底/全暂存, 也不要一次性强制召回标志。
    // Q5b 本地先行闸: 加词后先吃本地可交付存量 (零请求); 存量耗尽即自行放行远程取数
    //   (显式查找由 beginTagRecCustomQuery 清位)。"存量耗尽"= 队列内无未暂存的 match 条。
    if (tagRecCustomSession.localFirst && !this.localDeliverableCount()) tagRecCustomSession.localFirst = false
    if (
      !this.qs.bufferQueue.length ||
      (this.hasMoreExceptQueue && !tagRecCustomSession.localFirst && (onlyHeld || this.supplyScope().needed.size > 0))
    ) {
      const more = await this.fetchMore(abortSignal)
      if (abortSignal.aborted || this.isSessionStale()) return
      if (more?.length) this.qs.bufferQueue.push(...more)
    }
    if (abortSignal.aborted || this.isSessionStale()) return
    // 工作台态把 trial 工作副本一并入表: 其 tag_ids 已同步为组合正向标签,
    //   ownTagNames∩tag_ids 可产「试验 › 命中标签」证据标签, 否则来源回落成「新试验·相关」占位名
    const enrich = createTagRecAttributionEnricher(
      tagRecCustomSession.workingGroup ? [...favorites.list, tagRecCustomSession.workingGroup] : favorites.list,
      favoritesL1.list,
    )
    // 组合组内原子级公平选片 (spec: 新加的条件原子不被源序/命中数压在队尾); 只动展示顺序
    const combination = tagRecCustomSession.workingGroup?.combination
    const enriched = (items: RecItemTypeOrSeparator[]) => {
      sharedCandidates.delivered(items)
      for (const item of items)
        if (item.api === EApiType.TagRec) {
          enrich(item)
          // 归因字段每次交付重写 => 卡片数据按对象失效重算, 否则重交付的存货冻在旧徽标
          invalidateTagRecCardData(item)
        }
      const tagItems = items.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
      // 算分写字段并过滤 (claims 全灭剔除) 供排序与后续比较; 组合态按其结果集合、换回原子公平
      //   轮转的选片顺序 —— 按 hits 降序会让一族重叠标签 (原神/原神手书/原神六周年...) 堆满页首
      const ranked = this.runScoreStage(tagItems)
      const pickOrder = new Map(tagItems.map((item, index) => [item, index]))
      const ordered = combination
        ? [...ranked].sort((a, b) => (pickOrder.get(a) ?? 0) - (pickOrder.get(b) ?? 0))
        : ranked
      let at = 0
      return items.map((item) => (item.api === EApiType.TagRec ? ordered[at++] : item))
    }
    // 残留账非空时不走快路径 —— 全放口径下旧语境条会原样出队占屏 (下方过滤路径才判 stale)
    if (
      !this.effectiveFilter().enabled &&
      !sharedRemovedConditionAtoms.length &&
      !hasTagRecPartitionRules(sharedBufferQueue, this.scopeResolver())
    ) {
      const out = enriched(this.qs.sliceFromQueue())
      // 审计: 快路径同样记交付 + 缺口回放 —— 「全放」预设 enabled:false 走这条,
      //   原实现漏记漏补 (池里有同 bvid 还会在过滤打开后重复上屏)
      sharedDeliveryReplay.remember(
        tagRecDeliveryReplayKey(),
        out.filter((it): it is TagRecItemExtend => it.api === EApiType.TagRec),
      )
      return this.fillFromDeliveryReplay(out)
    }
    const policy = computeTagRecCustomFilterSignature()
    const delivered: RecItemTypeOrSeparator[] = []
    const consumed = new Set<RecItemTypeOrSeparator>()
    const pending = new Map<RecItemTypeOrSeparator, TagRecItemExtend>()
    const attemptedBvids = new Set<string>() // 票 005: 本操作真发过请求的 bvid —— 持账只给它计尝试
    const rounds: TagRecFilterRoundStats[] = []
    const atomKeysOf = combination && validateTagRecCombination(combination) ? this.atomKeysOf(combination) : undefined
    const isStaleContext = this.stalePredicate()
    const limits = this.partitionLimits()
    const working = tagRecPartitionWorkQueue(
      this.qs.bufferQueue,
      this.partitionHeld,
      isStaleContext,
      limits.heldQuota,
      (bvid) => (this.partitionHeld.get(bvid) ?? 0) < limits.heldMax,
    )
    for (let pass = 0; pass < 2 && delivered.length < this.qs.ps; pass++) {
      const want = this.qs.ps - delivered.length
      const slice = atomKeysOf
        ? spliceTagRecAtomFairSlice(working, want, sharedAtomTurns, atomKeysOf, settings.tagRec.diversityGuard)
        : working.splice(0, want)
      if (!slice.length) break
      const partitions = hasTagRecPartitionRules(slice, this.scopeResolver())
        ? await checkTagRecPartitionSlice(slice, this.scopeResolver(), budget, {
            queryMatches: this.queryMatcher(),
            negative: { pools: tagRecNegativePools() },
            relatedFallback: this.relatedFallbackOn(),
          })
        : {
            items: slice,
            pending: new Map<RecItemTypeOrSeparator, TagRecItemExtend>(),
            updated: [],
            attempted: new Set<string>(),
            stats: { dropped: 0, byDim: {}, degraded: false },
          }
      if (abortSignal.aborted || this.isSessionStale() || policy !== computeTagRecCustomFilterSignature()) return
      const tagChecked = await dropTagRecStrictTagListHits(
        partitions.items,
        this.effectiveFilter(),
        this.scopeResolver(),
        abortSignal,
        this.queryMatcher(),
        true,
        budget, // 审计 §1: 严格核验与分区/素材核验共享整次刷新预算
      )
      if (abortSignal.aborted || this.isSessionStale() || policy !== computeTagRecCustomFilterSignature()) return
      for (const [original, updated] of partitions.pending) pending.set(original, updated)
      for (const bvid of partitions.attempted) attemptedBvids.add(bvid)
      for (const item of slice) if (!pending.has(item)) consumed.add(item)
      sharedCandidates.record(partitions.updated)
      rounds.push(partitions.stats, tagChecked.stats)
      delivered.push(...tagChecked.items)
    }
    if (abortSignal.aborted || this.isSessionStale() || policy !== computeTagRecCustomFilterSignature()) return
    for (const [original, updated] of pending) Object.assign(original, updated)
    const held = this.qs.bufferQueue.filter((item) => pending.has(item))
    for (let i = this.qs.bufferQueue.length - 1; i >= 0; i--)
      if (consumed.has(this.qs.bufferQueue[i]) || pending.has(this.qs.bufferQueue[i])) this.qs.bufferQueue.splice(i, 1)
    this.qs.bufferQueue.push(...held)
    // 审计回填 (A3): stale 条不计入 remaining —— 它们永不再被核查, 留在 held 账里只会
    //   把「待核实/放弃」计数虚撑住 (横幅报着 N 条待核实, 其中含已排除核查的残留)
    const remaining = new Set(
      this.qs.bufferQueue.flatMap((item) =>
        item.api === EApiType.TagRec && !isStaleContext?.(item) ? [item.bvid] : [],
      ),
    )
    // 票 005: 尝试计数 —— 只给本轮**真查过**仍被暂停的条目 +1 (闸挡根本没查的不计),
    //   封顶钳在上限; 「已放弃」= 当前账目里到上限的条数, 每轮重算不累计
    //   (「重试核实」把尝试数归零 => 放弃计数随之归零; 缓存自愈后交付/滤除也随 remaining 清账)
    this.partitionHeld = tagRecPartitionHeldNext(
      this.partitionHeld,
      held.filter((it): it is TagRecItemExtend => it.api === EApiType.TagRec),
      remaining,
      limits.heldMax,
      attemptedBvids,
    )
    // 封顶时刻记账 (per-entry 冷却起点): 首达上限即记; 离场条随账目清
    for (const [bvid, attempts] of this.partitionHeld)
      if (attempts >= limits.heldMax && !this.partitionHeldCapAt.has(bvid))
        this.partitionHeldCapAt.set(bvid, Date.now())
    for (const bvid of this.partitionHeldCapAt.keys())
      if (!this.partitionHeld.has(bvid)) this.partitionHeldCapAt.delete(bvid)
    tagRecCustomSession.partitionAbandoned = [...this.partitionHeld.values()].filter(
      (attempts) => attempts >= limits.heldMax,
    ).length
    tagRecCustomSession.partitionPending = this.partitionHeld.size
    // 审计回填 (A3): stale 条不算鲜货 —— 队列只剩「停牌 ∪ 残留」时 freshRemaining 误真,
    //   partitionPaused 永不可达 (无横幅、无暂停闸), 用户看不到终态原因
    const freshRemaining = this.qs.bufferQueue.some(
      (item) => item.api === EApiType.TagRec && !this.partitionHeld.has(item.bvid) && !isStaleContext?.(item),
    )
    tagRecCustomSession.partitionPaused = (pending.size > 0 && !freshRemaining) || (budget.exhausted && this.hasMore)
    // 票 006: 「额度用尽」也是停牌原因之一
    tagRecCustomSession.partitionBudgetExhausted = budget.exhausted && this.hasMore
    if (tagRecCustomSession.partitionPaused) this.partitionPausePolicy = policy
    const tagStats = tagRecCustomSession.filterStats
    for (const stats of rounds) {
      tagStats.dropped += stats.dropped
      for (const [key, count] of Object.entries(stats.byDim)) {
        const dim = key as TagRecDropDimKey
        tagStats.byDim[dim] = (tagStats.byDim[dim] ?? 0) + count!
      }
      for (const [key, count] of Object.entries(stats.byScope ?? {})) {
        tagStats.byScope ??= {}
        tagStats.byScope[key] = (tagStats.byScope[key] ?? 0) + count
      }
      tagStats.unchecked = (tagStats.unchecked ?? 0) + (stats.unchecked ?? 0) || undefined
    }
    const out = enriched(delivered)
    // 票 002: 记住本条件交付过什么 (含顺序) —— 「显示已看」打开时零请求回放
    sharedDeliveryReplay.remember(
      tagRecDeliveryReplayKey(),
      out.filter((it): it is TagRecItemExtend => it.api === EApiType.TagRec),
    )
    const withReplay = this.fillFromDeliveryReplay(out)
    this.qs.doReturnItems(withReplay)
    return withReplay
  }

  /**
   * 本次访问已展示过的 bvid (票 002): 同一次访问内不重复回放; 切走再切回会新建 service,
   *   集合清空 => 完整回放"第一次看到的那批" (用户期望: 第一次什么样, 切回来就什么样)。
   */
  private replayShown = new Set<string>()

  /**
   * 票 002/003: 「显示已看」打开且**本轮队列没填满**时, 用回放池补位 (零请求)。
   *   只在缺口里补 —— 队列供得上时不动, 避免正常滚动时把回放内容重复上屏。
   */
  private fillFromDeliveryReplay(items: RecItemTypeOrSeparator[]): RecItemTypeOrSeparator[] {
    // 记账必须在开关判断之前: 关着的时候交付的条目也要计入"本次访问已展示",
    //   否则同一次访问里再打开「显示已看」, 回放池会把它们二次上屏 (评审指出)
    for (const it of items) if (it.api === EApiType.TagRec && it.bvid) this.replayShown.add(it.bvid)
    if (!tagRecCustomSession.bypassSeen) return items
    let want = Math.max(0, this.qs.ps - items.length)
    if (!want) return items
    const filled: RecItemTypeOrSeparator[] = []
    for (const item of sharedDeliveryReplay.replay(tagRecDeliveryReplayKey())) {
      if (want <= 0) break
      if (!item.bvid || this.replayShown.has(item.bvid)) continue
      // 票 006: 回放条打「回放」标 —— 标落在克隆上 (池内条目/共享库存同引用, 原地标会污染)
      const replayItem: TagRecItemExtend = { ...item, tagRecReplayed: true }
      // 审计: 回放条过现行生效链 —— 交付之后才加的负向/分区闸照样拦
      //   (deferPartitions 与存货同口径: 未证实分区不拦, 已证实的硬排除拦)
      const verdict = evalTagRecItem(replayItem, this.scopeResolver(), {
        queryMatches: this.queryMatcher(),
        negative: { pools: tagRecNegativePools() },
        relatedFallback: this.relatedFallbackOn(),
        deferPartitions: true,
        poolSize: replayItem.filterPoolSize,
        poolSizes: replayItem.filterPoolSizes,
      })
      if (!verdict.pass) continue
      this.replayShown.add(item.bvid)
      filled.push(replayItem)
      want--
    }
    if (filled.length) tagRecCustomSession.replayDelivered += filled.length
    return filled.length ? [...filled, ...items] : items
  }

  override async fetchMore(abortSignal: AbortSignal): Promise<RecItemTypeOrSeparator[] | undefined> {
    if (tagRecCustomSession.supplyPaused) return []
    this.lastFetchSignal = abortSignal // AUDIT-15: 手动深挖批生命周期随当前 fetch 闸
    // [tag-rec] 新轮开始清硬见底镜像+深挖待决态; 本轮真产出 0 由 exhaustRound(content) 复置 (横幅判据, 票 09/票 13)
    tagRecCustomSession.hardBottom = false
    tagRecCustomSession.digPending = sharedUpSearch.pending && sharedUpSearch.hasAnyMore
    this.syncDigResumeMirror()
    // ———— 轮次管线 (spec §4.3; 主干共享 service/_pipeline.ts, 票 05) ————

    // 1) 查询单元 = 选中组并集 ∪ 临时输入 id (spec §4.3 tab2 选组 = 选中组并集; 票 07 接线)
    //    选中组 = 正常+挂起组 (停用不进, pickTagGroupsByIds 防御剔除); 改选即 refresh 重建本 service
    const anchor = await this.resolveAnchorOnce().catch((e) => {
      // 票 16 ③: 风控错误不裸抛 —— 友好提示 + 本轮空转 (退避后用户滚动即自动重试)
      if (isRiskControlError(e)) {
        toast('命中风控 · 已退避降速,恢复后自动继续')
        return undefined
      }
      throw e
    })
    if (abortSignal.aborted) return

    const selectedGroups = tagRecCustomQueryGroups()
    const unit = this.collectQueryIds() // 锚点 + 字形变体 + 扩选
    // 同 tid 跨选中组/临时单元命中 => 合并归因名, 防同 tid 重复拉取
    const byTid = new Map<number, Set<string>>()
    const atomicSources: TagRecRoundSource[] = []
    const keywords = new Map<number, string>()
    const byTidGids = new Map<number, Set<string>>() // A1-3: 并行组 id 归因 (单元词归因不进)
    const push = (tid: number, name: string, gid?: string, keyword = name) => {
      atomicSources.push({
        tid,
        keyword,
        groupNames: [name],
        groupIds: gid ? [gid] : undefined,
        input: !gid,
        pn: this.dryTids.pageOf(tid), // 深翻页游标: 首页饱和后自动进页 (请求数不变)
      })
      keywords.set(tid, keyword)
      const names = byTid.get(tid) ?? new Set<string>()
      names.add(name)
      byTid.set(tid, names)
      if (gid) {
        const ids = byTidGids.get(tid) ?? new Set<string>()
        ids.add(gid)
        byTidGids.set(tid, ids)
      }
    }
    // 票 17 内层 tag 轮转 (与 tab1 同一纯函数): 选定组/输入单元 >10 id 均按游标取 10 切片, 逐轮推进覆盖全量
    // W1-5: 游标推迟到轮落定才提交 —— 取源即提交时, 中止/风控空转轮整片让位 (ids 切片跳过未拉)
    // A1-5: 游标带 tag_ids 签名按组自失效 —— 死键 (已删组) 顺手清
    const aliveGids = new Set([...favorites.list.map((g) => g.id), ...selectedGroups.map((g) => g.id)])
    for (const k of this.tagCursors.keys()) if (!aliveGids.has(k)) this.tagCursors.delete(k)
    const pendingCursors: [string, number, number[], string][] = []
    for (const g of selectedGroups) {
      const sig = g.tag_ids.map((e) => e.id).join(',')
      const ent = this.tagCursors.get(g.id)
      const { entries, nextCursor } = pickTagIdsForRound(g.tag_ids, ent && ent.sig === sig ? ent.cursor : 0)
      pendingCursors.push([g.id, nextCursor, entries.map((e) => e.id), sig])
      for (const e of entries) push(e.id, g.name, g.id, e.name)
    }
    const unitPick = pickTagIdsForRound(
      unit.map(([id, name]) => ({ id, name })),
      this.queryCursor,
    )
    pendingCursors.push(['', unitPick.nextCursor, unitPick.entries.map((e) => e.id), '']) // '' = queryCursor 哨位 (单元无 id 键)
    for (const e of unitPick.entries) push(e.id, e.name)
    // 未选组且未输入/解析失败 —— 非池见底, 不出 separator
    // [tag-rec] 票 13-fix: 退避态不再裸 return undefined 无限重试 —— 零请求微任务空转, 主线程饿死
    //   (research/13-empty-context-backoff-loop.md, 探针实锤); 改为:
    //   有待解析输入 => 有界重试(下轮重试锚点解析, 请求经退避时隙节奏; ≤TAG_REC_EMPTY_CONTEXT_MAX_RETRIES);
    //   纯空态/超限 => 终止本轮(同非退避态 exhaustRound 语义, 无池底 UI), 由用户刷新/新查询再武装
    if (!byTid.size && !selectedGroups.some((group) => hasTagRecCombination(group.combination))) {
      const retryable = !!tagRecCustomSession.inputText && tagRecBackoff.isEngaged
      if (retryable && this.emptyContextRetries < TAG_REC_EMPTY_CONTEXT_MAX_RETRIES) {
        this.emptyContextRetries += 1
        return undefined
      }
      return this.exhaustRound()
    }
    this.emptyContextRetries = 0

    // 负向池预热: 每负向 tid 一次 tag/top, 会话级快照 (tag/top 条目靠 bvid 交集近似拉黑) ——
    //   但只服务「生效链真会消费」的名单: 逐组经 resolver 取生效 neg.tagIds (含 L1 上溯/草稿兜底);
    //   cfg.enabled 已停的链过滤时不碰负向池, 预热是纯浪费请求
    const negResolve = this.scopeResolver()
    const effNegTids = (key: TagRecChainKey) => {
      const eff = negResolve(key, 'tagTop')
      return eff.cfg.enabled ? eff.neg.tagIds.map((e) => e.v.id) : []
    }
    const negTids = [...selectedGroups.flatMap((g) => effNegTids({ id: g.id })), ...effNegTids(undefined)]
    // 自定义标签名单只复用已有浅池; 选入整主题也不按名单追加 tag/top 请求。
    if (negTids.length) await ensureTagRecNegativePools(negTids, abortSignal)
    if (abortSignal.aborted) return

    // 票 32/37/44 成员签名 (模块级): 变 => 干态全清+共享态重置+后台预热再触发一次;
    //   仅「有旧签名且不同」才算切换 (首次确立共享盒本就空, 不误重置播种/存货);
    //   构造期已先同步一轮, 此处兜实例存活期的被动漂移
    const { sig, changed: signatureChanged } = syncCustomSharedState()
    // AUDIT-A4-1: 实例钉点随共享态重钉 —— 扩选/成员 ✕/★/⛔ 等无 emit 被动漂移后,
    //   isSessionStale 原会永久为真 → 手动深挖/深挖待决/phase2镜像/候选聚合/变体并入全楔死。
    //   共享态方已原地重置 (上方 sync), 钉点跟上即自愈; 锚点残留随签名清空 ——
    //   输入语境漂移时 doResolveAnchor 对新 inputText 重解析, 旧锚点流/变体/queryIds 不外溢
    // wg 语境按剥 seen 位的成员段比 (显示切换不重置锚点); 非 wg 维持全段比 (seen 位在语境内)
    const membersDiffer = tagRecCustomSession.workingGroup
      ? tagRecMembersCore(sig.split('|sources:', 1)[0]) !==
        tagRecMembersCore(this.contextSignature.split('|sources:', 1)[0])
      : sig.split('|sources:', 1)[0] !== this.contextSignature.split('|sources:', 1)[0]
    if (membersDiffer) {
      this.anchorPromise = undefined
      this.anchorInfo = undefined
      this.anchorEntry = undefined
      this.anchorInput = ''
      this.phase2Started = false
      this.inputNorm = ''
      this.isIdPath = false
      this.queryIds.clear()
      this.discoveredVariants = []
    }
    this.contextSignature = sig
    syncCustomFilterState() // 实修票①: 过滤签名变 => 去重记忆复位 (须在取源前, 本轮即生效)

    // 2~7) _pipeline 一轮: 单元全部 tag_id 各拉 tag/top => 并集去重归一 => 三阶段 => 产出
    //      (浅池每请求重采样, 固定 pn=1 靠去重吃新样本; 并发上限经 anonGetJson tagRecLimit)
    //      票 32: 干 tid 本轮跳过 —— 一轮内全源皆干 => 零请求空轮直走兜底梯队 (不构成见底, §4.4)
    const supply = this.supplyScope()
    if (!supply.needed.size && supply.ready) return []
    const sources = atomicSources.filter((source) =>
      tagRecConsumers(source).some((consumer) => supply.needed.has(tagRecGroupKey(consumer.key))),
    )
    const recallResolve = this.scopeResolver()
    const digSources = [
      ...deriveGroupCliques(
        selectedGroups.map((g) => ({ ...g, extra: tagRecSearchExtraOf(recallResolve({ id: g.id }, 'allV2')) })),
        Infinity,
      ),
      ...(!this.isIdPath
        ? unit.map(([, name]) => ({ key: normalizeTagName(name), keyword: name, attribution: [name], input: true }))
        : []),
    ]
    const recallPlan = planTagRecRecall(
      {
        roundSources: sources,
        digSources,
        scopeConsumers: [
          ...selectedGroups.map<TagRecConsumer>((g) => ({ key: { id: g.id }, name: g.name })),
          ...(unit.length ? [{ key: undefined, name: '', input: true }] : []),
        ],
      },
      recallResolve,
    )
    const fullUpSources = this.recheckPlan().up
    sharedUpSearch.sync(fullUpSources)
    // UP 每轮只付一页，按自己的检索词游标覆盖全表，不借 tag/top 的十词切片。
    recallPlan.up = fullUpSources.filter((source) =>
      tagRecConsumers(source).some((consumer) => supply.needed.has(tagRecGroupKey(consumer.key))),
    )
    const onlyUp =
      recallPlan.up.length > 0 &&
      !recallPlan.tagTop.length &&
      !recallPlan.dig.length &&
      !recallPlan.archiveConsumers.length
    const normalIds = new Set(recallPlan.dig.flatMap((s) => s.groupIds ?? []))
    const normalGroups = selectedGroups.filter((g) => normalIds.has(g.id))
    const normalInputs = new Set(recallPlan.dig.filter((s) => s.input).map((s) => s.key))
    for (const stream of this.ladder.streams.values())
      if (!stream.groupIds?.length && normalInputs.has(stream.key)) stream.input = true
    if (
      !recallPlan.tagTop.length &&
      !recallPlan.up.length &&
      !recallPlan.dig.length &&
      !recallPlan.archiveConsumers.length
    ) {
      this.hasMoreExceptQueue = false
      return [makeTagRecExhaustSeparator('池筛选已关闭当前路线 · 请开启适用的推荐来源')]
    }
    const epoch = sharedLadderState.epoch
    const policy = computeTagRecCustomSourceSignature() + computeTagRecCustomFilterSignature(true)
    const isCurrent = () =>
      sharedLadderState.epoch === epoch &&
      policy === computeTagRecCustomSourceSignature() + computeTagRecCustomFilterSignature(true) &&
      !this.isSessionStale()
    const roundPromise = runTagRecRecallRound({
      sources,
      resolve: recallResolve,
      plan: recallPlan,
      isCurrent,
      upPool: sharedUpSearch,
      dryTids: this.dryTids,
      seenBvids: this.seenBvids,
      mergeExisting: (item) =>
        sharedCandidates.mergeIncoming(
          item,
          sharedQueueIndex.map() as ReadonlyMap<string, TagRecItemExtend>,
          (items) => this.runScoreStage(items),
          sharedLadderState.heap,
          sharedHeapIndex.map(),
        ),
      hasPending: sharedHasPending,
      signal: abortSignal,
      stages: this.stages,
    })
    // 锚点深挖也在主池请求入闸后点火, 避免 all/v2 抢首屏槽位。
    if (
      normalInputs.has(normalizeTagName(this.anchorEntry?.name ?? this.anchorInput)) &&
      this.anchorInput &&
      !this.phase2Started &&
      !tagRecBackoff.isEngaged
    ) {
      this.phase2Started = true
      void this.startPhase2('auto')
    }
    // 票 32 首载/变员预热: tag/top 请求先行入闸, 深挖流注册+顺手一发 manual dig 后台并行排其后 (不等)
    //   触发条件: 签名变 || 本 service 深挖流为空 —— service 重建 (刷新) 后流表清零需重注册, 干态则按签名保住
    if (!onlyUp && (signatureChanged || !this.ladder.streams.size))
      this.warmupDigStreams(normalGroups, abortSignal, normalInputs)
    const round = await roundPromise.catch((e) => {
      // 票 16 ③: 池拉取被风控 => 本轮空转 (hasMore 保持 true, 退避后滚动自动重试)
      if (isRiskControlError(e)) return undefined
      throw e
    })
    if (abortSignal.aborted || !isCurrent()) return
    if (!round) return
    this.dryTids.note(round.sourceStats) // 逐源记账: 空响应即干 / 零新增连击标干
    // W1-5+A1-4: 轮转游标按「本源全成」逐单元提交 —— 失败源所在组/查询单元切片不推进;
    //   abort 轮在上方早退不提交 (整片让位作废)
    const failedTids = new Set(round.sourceStats.filter((s) => !s.ok).map((s) => s.tid))
    for (const [k, c, tids, sig] of pendingCursors) {
      if (
        !tids.some(
          (t) =>
            round.sourceStats.some((s) => s.tid === t && s.ok) &&
            recallPlan.tagTop.some(
              (source) =>
                source.tid === t &&
                source.consumers.some((consumer) =>
                  k ? typeof consumer.key === 'object' && consumer.key?.id === k : consumer.input,
                ),
            ),
        )
      )
        continue
      if (tids.some((t) => failedTids.has(t))) continue
      if (k === '') this.queryCursor = c
      else this.tagCursors.set(k, { cursor: c, sig })
    }
    // A3-1: 零产出且存在失败源 => 未决轮 —— 不进梯队/不判见底, 保 hasMore 滚动重试
    //   (风控/网络瞬态被 allSettled 收成 ok=false; 原实现误当干轮 → 假 manual-pending/硬见底)
    // R09: 未决轮有界重试 —— 持续失败时 fetchMinCount 按 hasMore 无限连发; 超预算抛可重试错误截停
    if (!round.items.length && failedTids.size) {
      if (this.ladder.poolItems.length < TAG_REC_SEED_POOL_MAX) this.ladder.poolItems.push(...round.poolItems)
      if (this.failedSourceRounds < TAG_REC_SOURCE_FAILURE_MAX_RETRIES) {
        this.failedSourceRounds += 1
        // 未决轮重试前先过一个退避时隙 (退避态排队 / 正常态即时): 瞬态失败下不再零间隔连发,
        //   给风控探针留恢复窗; fetchMinCount 侧另有零进展护栏兜底。(?. 兼容旧测试 mock)
        await tagRecBackoff.waitTurn?.(abortSignal)?.catch(() => undefined)
        return
      }
      this.failedSourceRounds = 0 // 以错误收尾本轮; 下次刷新/重试重新获得完整预算
      throw new TagRecSourceFailureError()
    }
    this.failedSourceRounds = 0

    // 深翻页未完 (本轮零产出但未干源仍有页可翻) => 非见底: 保 hasMore 让下一轮自动进页;
    //   原「单轮零产出即硬见底」会把 hasMore 关掉, 页游标永远等不到下一轮 (实测池深 200/标签)
    if (!round.items.length && this.hasTagTopPagesLeft(recallPlan.tagTop)) return []

    if (recallPlan.up.length && sharedUpSearch.pending && sharedUpSearch.hasAnyMore)
      tagRecCustomSession.digPending = true
    if (onlyUp) {
      const more = sharedUpSearch.hasAnyMore
      if (!round.items.length) {
        if (more && !sharedUpSearch.pending) return []
        if (more) {
          tagRecCustomSession.digPending = true
          return this.exhaustRound()
        }
        return this.exhaustRound('UP 投稿关键词搜索已到末尾')
      }
      if (!more || sharedUpSearch.pending) {
        this.hasMoreExceptQueue = false
        tagRecCustomSession.digPending = more
      }
      return round.items
    }

    // 8) 兜底梯队 (票 13 D1 + 票 17 策略分家): 产出 <triggerYield 即介入 —
    //    干轮 => related 选种 => 堆按分放行一页 => 自适应自动深挖 => 手动待决 => 硬见底;
    //    浅水位 (产出 1~triggerYield-1) => 同轮顺手一发 digPass('auto') 预挖 (不选种/不放堆);
    //    组级欠产同闸: 任一可供给消费者归属库存见底也介入 (交集组 tag/top 条目无标签证据,
    //    真产线只有深挖流 —— 混选时别组高产不该饿死它, 与 fav 同病同治)
    let items = round.items
    let produce = items.length
    if (items.length < this.ladder.effTriggerYield() || this.hasStarvedConsumer(items)) {
      if (items.length) {
        // 票 17 浅水位预挖: 深挖产出落 bufferQueue 下轮直放, 不挤占本轮切片;
        //   组簇流同款补登记 (组模式深挖流借此前移成立), 选种/兜底放行一概不碰 —— 预挖只跑 dig 档
        // 票 perf-06 后台化: 原 await 把本轮产出押在一整档 all/v2 批 + 变体解析后面 ——
        //   深链新 tab 浅池场景首屏白等一串 GM_xhr; 预挖货本就「下轮直放」, 同步等它零收益,
        //   与 warmupDigStreams 的 manual 顺手一发同改后台 (digPass 单飞, 天然合并重复点火)
        void this.ladder
          .preDig({
            signal: abortSignal,
            prepareStreams: () => this.ladder.ensureCliqueStreams(normalGroups),
          })
          .catch(() => 0)
          .finally(() => {
            if (!this.isSessionStale()) this.syncPhase2Session()
          })
        if (abortSignal.aborted) return
      } else {
        // 选种原料池累计 (达阈值即停记 —— 热池选种本就永不开闸)
        if (this.ladder.poolItems.length < TAG_REC_SEED_POOL_MAX) this.ladder.poolItems.push(...round.poolItems)
        const r = await this.ladder.runLadder({
          signal: abortSignal,
          // D7 组路径同义词簇流: 干轮续挖补登记 (预挖档上方同款前移)
          prepareStreams: () => this.ladder.ensureCliqueStreams(normalGroups),
        })
        if (abortSignal.aborted || r.kind === 'aborted') return
        if (!this.isSessionStale()) this.syncPhase2Session()
        switch (r.kind) {
          case 'items': {
            items = r.items
            // A3-9: 队列货计数只认条目 —— separator 混入会虚 +1 扰动软见底/热池判据
            produce = r.items.length || this.qs.bufferQueue.filter((x) => x.api === EApiType.TagRec).length // 在途深挖刚落的货也记产出

            break
          }
          case 'manual-pending': {
            // 自动深挖停 (三停之一) 但深挖流未尽 => 停自动加载待手动「继续深挖」(非硬见底, 横幅待决态)
            if (!this.isSessionStale()) tagRecCustomSession.digPending = true
            return this.exhaustRound()
          }
          case 'source-unavailable':
          case 'retry-later': {
            this.hasMoreExceptQueue = false
            return [makeTagRecExhaustSeparator(r.reason)]
          }
          default: {
            if (sharedUpSearch.pending && sharedUpSearch.hasAnyMore) {
              tagRecCustomSession.digPending = true
              return this.exhaustRound()
            }
            if (anchor) toast(`「${anchor.name}」标签池暂无新内容`)
            return this.exhaustRound('已到池底 · 该标签池暂无更多新内容')
          }
        }
      }
    }

    // 9) 产出计数 (含兜底产出) => 软见底标记; 硬见底 => [separator] + hasMoreExceptQueue=false
    //    实修票③: 同步记入选种「热池」判据 producedTotal (主池+兜底全源累计)
    trackTagRecRoundProduce(this.produceTracker, produce)
    this.ladder.noteProduce(produce)
    tagRecCustomSession.softBottom = this.produceTracker.softBottom
    // [tag-rec] perf 票 06: 本实例首批 items 就绪 (normalize+三阶段+兜底全在后; 渲染/封面归外层测量)
    if (items.length && !this.firstDataMarked) {
      this.firstDataMarked = true
      perfMark('tagrec-first-data', { n: items.length })
    }
    return items
  }

  /** 查询单元 = 锚点 + 字形变体 (自动并入, 下一轮起) + 「扩进本次查询」扩选 */
  private collectQueryIds() {
    if (tagRecCustomSession.workingGroup) return [] as [number, string][]
    for (const v of this.discoveredVariants) this.queryIds.set(v.id, v.name)
    for (const e of tagRecCustomSession.expandedIds) this.queryIds.set(e.id, e.name)
    return [...this.queryIds.entries()]
  }

  /**
   * 票 32 首载/变员预热 (后台不阻塞, fetchMore 内 tag/top 入闸后调用):
   *   选定组同义词簇流 (D7 同款) + 每个扩选 id 一条独立流 (key=归一名, 归因=tag 名同查询单元口径),
   *   顺手一发 auto 深挖与 tag/top 并行 —— 深挖条目仍经 queue/heap 管线不直喂,
   *   auto 档照走三停/配额纪律 (预热即正规自动批, 停轮后由休息自愈续); 退避期不点火 (请求纪律不放宽)
   */
  private warmupDigStreams(groups: readonly TagGroup[], signal: AbortSignal, inputKeywords: ReadonlySet<string>) {
    if (tagRecBackoff.isEngaged) return
    this.ladder.ensureCliqueStreams(groups)
    for (const e of tagRecCustomSession.expandedIds) {
      const key = normalizeTagName(e.name)
      if (!key || !inputKeywords.has(key)) continue
      // 撞已有簇流/锚点流 key => 并入其 attribution (同 ensureCliqueStreams 合并写法), 纯徽标归属修正
      const exist = this.ladder.streams.get(key)
      if (exist) {
        if (!exist.attribution.includes(e.name)) exist.attribution.push(e.name)
        continue
      }
      // 票 36: 扩选独立流建流 —— sediment dig 水合收敛在 addStream 内 (keyword 等值续页/活终态)
      this.ladder.addStream({ key, keyword: e.name, attribution: [e.name], input: true })
    }
    if (!this.ladder.canAutoDig()) {
      this.syncDigResumeMirror() // 判定可能上膛休息位 —— 早退也要把排程交给续批
      return
    }
    void this.ladder
      .digPass('auto', signal)
      .catch(() => 0)
      .finally(() => {
        if (!this.isSessionStale()) this.syncPhase2Session()
      })
  }

  /**
   * Phase 1 锚点解析, 有真锚点才缓存 promise (并发轮共享);
   * AUDIT-09: 空输入/未命中不缓存 —— `??=` 把空输入解出的 undefined 钉死后该实例永不读新
   *   inputText (滚动也救不回); 失败不缓存允许重试
   */
  private resolveAnchorOnce() {
    this.anchorPromise ??= this.doResolveAnchor()
      .then((entry) => {
        if (!entry) this.anchorPromise = undefined // 空结果不缓存, 下轮重读 inputText
        return entry
      })
      .catch((e) => {
        this.anchorPromise = undefined // 失败不缓存, 下轮重试
        throw e
      })
    return this.anchorPromise
  }

  /** 输入分流 (spec §4.1): 纯数字 => tag_id 直输反查名(逃生口); 文本 => tag_name 解析 + Phase 2 后台 */
  private async doResolveAnchor(): Promise<TagIdEntry | undefined> {
    if (tagRecCustomSession.workingGroup) return undefined
    const input = tagRecCustomSession.inputText.trim()
    if (!input) return undefined
    // [tag-rec] perf 票 06: 锚点解析段 (持久层读 + 指纹等 + x/tag/info 往返; 深链预热命中时 ≈0)
    perfMark('tagrec-anchor-resolve')
    const { anchor, isIdPath } = await resolveAnchor(input)
    perfMark('tagrec-anchor-resolved', { found: anchor ? 1 : 0, idPath: isIdPath ? 1 : 0 })
    this.isIdPath = isIdPath
    this.anchorInfo = anchor
    this.anchorEntry = anchor ? { id: anchor.id, name: anchor.name } : undefined
    // 票 21: 解析途中语境已被切换 (选组/新输入) => 本过期实例不回写输入侧会话态, 直接收尾
    if (this.isSessionStale()) return this.anchorEntry
    tagRecCustomSession.anchor = this.anchorEntry
    if (!anchor) {
      toast(`未能解析标签「${input}」`)
      return undefined
    }
    this.queryIds.set(anchor.id, anchor.name)
    // 临时输入即草稿组 (票 14): 首个解析成功的输入成立本会话草稿组 (负向位随组走)
    tagRecCustomSession.draftGroup ??= { name: anchor.name, negative_tag_ids: [], strict: false }
    // 票 21 组语境互斥 (后动作者赢): 输入解析成功 = 草稿组语境成立 => 清选定组
    const droppedGroups = pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds)
    if (droppedGroups.length) toast(`已切换到临时输入「${anchor.name}」,已弃选定组「${droppedGroups[0].name}」`)
    tagRecCustomSession.selectedGroupIds = []
    // AUDIT-09/16: 互斥弃组即语境迁移完成点 (签名由「组段∪in段」换型为「in段」) ——
    //   同步共享态 (签名变 => 原地重置深挖流/干态/存货) 并重钉本实例签名快照 (stale 门/useRefresh 复用);
    //   必须早于下方 addStream/startPhase2 —— 迟置会把刚注册的锚点流随重置抹掉
    this.contextSignature = syncCustomSharedState().sig
    if (!isIdPath) {
      this.anchorInput = input
      this.inputNorm = normalizeTagName(anchor.name) // D5: 规范名归一键 = 流 key / sediment 锚点节点 / 词表键
      // 票 13: 输入锚点深挖流登记 (D5 keyword=锚点规范名; 变体解析+首轮联想仅输入流)
      this.ladder.addStream({
        key: this.inputNorm,
        keyword: anchor.name,
        attribution: [anchor.name],
        input: true,
        withVariants: true,
        withSuggest: true,
        anchor: this.anchorInfo,
      })
    }
    return this.anchorEntry
  }

  // ———— Phase 2 后台 = 梯队深挖流 (票 13: 手动 dig 与干轮自动 dig 全部收编进 ladder) ————

  /** 后台深挖一轮 (输入锚点流首轮启动 /「继续深挖」复用): 单飞, 完成即镜像 phase2; 返回在途 promise */
  private startPhase2(mode: 'auto' | 'manual' = 'manual'): Promise<unknown> {
    // A3-2: 退避闸补齐 —— 锚点解析触发的深挖批原是唯一无门点火点 (digMore/warmup/canAutoDig/选种皆避让)
    if (tagRecBackoff.isEngaged) return Promise.resolve(0)
    if (this.phase2Running) return this.phase2Running
    if (this.ladder.digRunning) return this.ladder.digRunning
    // AUDIT-15/16: 弃实例整发拒挖 —— 无 lastFetchSignal 的裸批会越过 abort 闸往共享盒落旧境货
    if (this.isSessionStale()) return Promise.resolve(0)
    if (mode === 'auto' && !this.ladder.canAutoDig()) return Promise.resolve(0)
    tagRecCustomSession.phase2.status = 'running'
    tagRecCustomSession.digRunning = true // 待决态保持, 按钮 loading 防重点
    this.phase2Running = this.ladder
      .digPass(mode, this.lastFetchSignal) // service 生命周期闸，预热同样扣自动预算
      .catch((e) => (appWarn('[tag-rec] phase2 dig failed: %o', e), 0))
      .finally(() => {
        this.phase2Running = undefined
        // A4-5: digRunning 镜像清零移出 stale 门 (弃实例不摘 => banner 按钮永 loading 无兜底);
        //   但需共享盒在途闸 —— 新语境 service 正在挖时旧实例抢摘会让在途挖的 loading 提前熄灭
        if (!this.ladder.digRunning) tagRecCustomSession.digRunning = false
        if (this.isSessionStale()) return
        this.syncPhase2Session()
        if (this.ladder.lastDigYield > 0) {
          // 手动深挖落货 => 重挂自动加载 + 解除待决 (UI 挖完 emit 'load-more' 再武装 grid hasMore)
          this.hasMoreExceptQueue = true
          tagRecCustomSession.digPending = false
        } else if (this.ladder.hasDueStreams()) {
          tagRecCustomSession.digPending = true // 挖了没出货, 流未尽 => 待决回显
        } else {
          // 手动挖穿流尽 => 硬见底 (横幅三动作收尾)
          tagRecCustomSession.digPending = false
          tagRecCustomSession.hardBottom = true
        }
      })
    return this.phase2Running
  }

  /**
   * UI「继续深挖」: 全部未 exhausted 深挖流各 +3 页 (spec §4.1 扩展为票 13 多流); resolve = 本次/在途挖完
   * 判据 = 梯队有无 due 流 (组簇流可在无锚点下独立存在 —— 纯组模式 anchorEntry 为空也必须能挖)
   * 票 38-C②选项①: 退避期手动 dig 拒发 —— 深挖成功率本就低, 烧的是退避时隙 (请求纪律不放宽)
   */
  digMore(automatic = false): Promise<unknown> {
    if (sharedUpSearch.pending && sharedUpSearch.hasAnyMore) {
      if (this.isSessionStale()) return Promise.resolve()
      sharedUpSearch.continue()
      this.hasMoreExceptQueue = true
      tagRecCustomSession.digPending = false
      tagRecCustomSession.hardBottom = false
      this.syncDigResumeMirror()
      return Promise.resolve()
    }
    if (tagRecBackoff.isEngaged) {
      if (!automatic) toast('退避中,恢复后再挖')
      return Promise.resolve()
    }
    if (!this.ladder.hasDueStreams()) {
      // 无 due 流 => 待决态无对象 (冷却排程另由 digResumeAt 承担): 清位防续批 60s 空转
      tagRecCustomSession.digPending = false
      this.syncDigResumeMirror()
      return Promise.resolve()
    }
    // 审计 §5: 滚动触发的自动续批走 auto 档 —— 扣自动预算/低产纪律; 耗尽即转手动待决,
    //   等用户点「继续发掘」才按 manual 发 (此前误走 manual, 固定三批等自动上限不生效)
    if (automatic && !this.ladder.canAutoDig()) {
      tagRecCustomSession.digPending = true
      this.syncDigResumeMirror()
      return Promise.resolve()
    }
    return tagRecRecallScheduler.withForegroundSupply(() => this.startPhase2(automatic ? 'auto' : 'manual'))
  }

  /**
   * UI「重新发掘」(硬见底出口): 复位本查询全部深挖流游标 (含持久沉淀的 exhausted/冷却) 并立即重挖一轮。
   * 请求有界 = 一次 digPass 的既有窗口 (≤4 流 ×3 页) + 退避/限流纪律; 退避期不点火。
   * 已挖穿/冷却中的词重获完整召回 —— 免去「去设置里清空沉淀」或干等 TTL。
   */
  redigQuery(): Promise<unknown> {
    if (this.isSessionStale()) return Promise.resolve()
    this.ladder.resetDigCursors()
    this.hasMoreExceptQueue = true
    tagRecCustomSession.hardBottom = false
    tagRecCustomSession.digPending = false
    return this.digMore()
  }

  /** 梯队聚合态 => session.phase2 镜像 (横幅待决态/tabbar 深挖按钮/计数文案订阅) */
  private syncPhase2Session() {
    const p2 = tagRecCustomSession.phase2
    const ladder2 = this.ladder.phase2
    p2.status = this.phase2Running || this.ladder.digRunning ? 'running' : ladder2.status
    p2.pagesFetched = ladder2.pagesFetched
    p2.exhausted = ladder2.exhausted
    p2.autoDigs = ladder2.autoDigs
    p2.lastDigYield = ladder2.lastDigYield
    this.syncDigResumeMirror()
  }

  /** 休息/流冷却排程镜像 —— RecGrid 续批订阅位; 每个 dig 状态早退/落定点都要刷, 防陈旧位空转或漏唤醒 */
  private syncDigResumeMirror() {
    tagRecCustomSession.digResumeAt = this.ladder.resumeAt()
  }

  /**
   * 勾选即后台预解析 (票 18 增强): 未解析行打勾瞬间后台 tag/info, use/解析态随后回填。
   * 动作点 (expandQuery/saveAsFavoriteGroup) 仍走 resolveCandidateRows 兜底——
   * 会话缓存按 key 合并在途请求, 两处共享同一 promise, 动作点零新增等待。
   */
  resolveCandidateInBackground(key: string) {
    const live = tagRecCustomSession.candidates.find((c) => c.key === key)
    if (!live || live.tag_id !== undefined || live.resolving) return
    live.resolving = true
    const snapshot: CandidateRow = { ...live }
    const isCurrent = this.captureActionContext()
    void resolveCandidateRows([snapshot])
      .catch(() => {
        // [tag-rec] UIUX-U1-10: 顶层解析抛错不再静默吞 —— 该行打「解析失败」红徽
        //   (resolveFailed 复用既有失败徽标通道, mergeCandidateRows/行渲染已接), 用户可见可重勾重试
        live.resolveFailed = true
        return undefined
      })
      .then((resolved) => {
        live.resolving = false
        if (resolved && isCurrent()) this.applyResolvedRows(resolved)
      })
  }

  /** 惰性解析回填 (票 18): 解析结果写回 session 候选行 (key 不换, 仅更新 tag_id/use/resolveFailed) */
  private applyResolvedRows(resolved: readonly CandidateRow[]) {
    for (const r of resolved) {
      const idx = tagRecCustomSession.candidates.findIndex((c) => c.key === r.key)
      if (idx === -1) continue
      const live = tagRecCustomSession.candidates[idx]
      live.tag_id = r.tag_id
      live.tag_name = r.tag_name
      live.use = r.use
      live.resolveFailed = r.resolveFailed
      // 解析后撞已有 id 行 (例: 别名解析到锚点 id) => 并入彼行, 删本行
      const dup = tagRecCustomSession.candidates.find(
        (c) => c !== live && c.tag_id !== undefined && c.tag_id === live.tag_id,
      )
      if (dup) {
        dup.checked ||= live.checked
        dup.expanded ||= live.expanded
        tagRecCustomSession.candidates.splice(idx, 1)
      }
    }
  }

  /** 用户动作绑定发起时的语境；同组新增暂存不使动作失效，切走再切回也不复活旧动作。 */
  private captureActionContext() {
    const ids = tagRecCustomSession.selectedGroupIds.join(',')
    const groups = tagRecCustomSession.selectedGroupIds.map((id) => favorites.list.find((g) => g.id === id))
    const input = tagRecCustomSession.inputText
    const draft = tagRecCustomSession.draftGroup
    const candidates = tagRecCustomSession.candidates
    return () =>
      ids === tagRecCustomSession.selectedGroupIds.join(',') &&
      input === tagRecCustomSession.inputText &&
      draft === tagRecCustomSession.draftGroup &&
      candidates === tagRecCustomSession.candidates &&
      groups.every((group, i) => group === favorites.list.find((g) => g.id === tagRecCustomSession.selectedGroupIds[i]))
  }

  /** 独立解析 B 的确认入口：只写已有扩选暂存，不接管主查询或收藏组。 */
  expandResolvedTags(entries: readonly TagIdEntry[], queryRevision: number) {
    if (queryRevision !== tagRecCustomSession.queryRevision) return []
    const selectedGroup = pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds)[0]
    // 新输入尚未解析成立时，即使旧选定组还在也不能接收扩选。
    if (tagRecCustomSession.inputText ? !tagRecCustomSession.anchor : !selectedGroup) return []
    const savedGroup = tagRecCustomSession.draftGroup?.savedGroupId
      ? favorites.list.find((g) => g.id === tagRecCustomSession.draftGroup!.savedGroupId)
      : undefined
    const added = pushExpandedIds(entries, (selectedGroup ?? savedGroup)?.tag_ids)
    for (const entry of added) sediment.confirm(normalizeTagName(entry.name))
    if (added.length) tagRecCustomSession.expandedCollapsed = false
    toast(added.length ? `已扩选 ${added.length} 个标签, 下一轮起生效` : '所选标签已在本次查询中')
    return added
  }

  /** UI「扩进本次查询」: 勾选行并入查询单元 (下一轮起) + confirmed 边; 未解析行现场 tag/info 换 id (票 18) */
  async expandQuery(rows: readonly CandidateRow[]) {
    const isCurrent = this.captureActionContext()
    const pendings = rows.filter((r) => r.checked && !r.expanded)
    if (!pendings.length) {
      toast('先勾选要并入的标签')
      return
    }
    const resolved = await resolveCandidateRows(pendings)
    if (!isCurrent()) return
    this.applyResolvedRows(resolved)
    const ok = resolved.filter((r) => r.tag_id !== undefined)
    const failed = resolved.length - ok.length
    // 票 22: 写暂存位收口 pushExpandedIds —— 已在暂存/锚点/当前选定组真成员全跳过,
    // 并入成功的行同步候选行 expanded+checked (「已并入」徽标, 扩选区 ✕ 可取消)
    const currentGroup = pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds)[0]
    const staged = new Set(
      pushExpandedIds(
        ok.map((r) => ({ id: r.tag_id!, name: r.tag_name })),
        currentGroup?.tag_ids,
      ).map((e) => e.id),
    )
    for (const r of ok) {
      sediment.confirm(normalizeTagName(r.tag_name)) // confirmed 边 (§3.5)
      const live = tagRecCustomSession.candidates.find((c) => c.key === r.key)
      // 实机修复: 仅对真入暂存位的行标 expanded/checked —— pushExpandedIds 跳过的行
      // (锚点自身/已在组/已在暂存) 伪标「已并入」会卡死: chip ✕ 取消不到, checked 残留还经勾中行并入
      if (live && r.tag_id !== undefined && staged.has(r.tag_id)) {
        live.expanded = true
        live.checked = true
      }
    }
    if (!ok.length) {
      toast(`${failed} 个标签解析失败`)
      return
    }
    const skippedExisting = ok.length - staged.size
    const lead = staged.size ? `已扩进 ${staged.size} 个标签, 下一轮起生效` : '所选标签已在组或扩选暂存中'
    toast(
      `${lead}${skippedExisting && staged.size ? `; ${skippedExisting} 个已在组/暂存` : ''}${failed ? `; ${failed} 个解析失败跳过` : ''}`,
    )
    // 票 10: 干净成功自动收起候选清单; 有失败行保持展开 (红徽在清单里可见)
    if (!failed) tagRecCustomSession.candidatesCollapsed = true
  }

  /**
   * UI「顺手存成项 / 并入当前组」(§4.2) —— 票 22 语境分叉 (暂存层整体固化):
   *   选定组语境 => 勾选行 ∪ expandedIds 暂存层 `addTagIdsToGroup` 并入**该组** (复用门面去重/负向撞车计数),
   *     并入后清暂存位, 不建组; 零勾选但暂存非空同样可并入 (纯扩选固化)
   *   草稿语境 => 维持升级建新组路径: 会话负向随组入表 (票 14/票 12 联动)
   * 未解析行现场解析 (票 18)
   */
  async saveAsFavoriteGroup(rows: readonly CandidateRow[]): Promise<TagGroup | undefined> {
    const isCurrent = this.captureActionContext()
    const checked = rows.filter((r) => r.checked)
    // 语境解析同 service 查询单元 (停用组防御剔除); 互斥后选定组与草稿组不共存 (票 21)
    const selectedGroup = pickTagGroupsByIds(favorites.list, tagRecCustomSession.selectedGroupIds)[0]
    const draft = tagRecCustomSession.draftGroup
    // 实修: 草稿已存成项 (savedGroupId) => 后续勾选并入该组不再建新组 (防误触二次建组);
    //   目标组被删则回落建组路径
    const mergeTarget =
      selectedGroup ?? (draft?.savedGroupId ? favorites.list.find((g) => g.id === draft.savedGroupId) : undefined)
    const expandedSnapshot = [...tagRecCustomSession.expandedIds]
    const anchor = tagRecCustomSession.anchor
    // 草稿语境锚点即组身份 (纯数字直输无候选行, 实机修复: 零勾选+零暂存但有锚点也应可存)
    if (!checked.length && !expandedSnapshot.length && (mergeTarget || !anchor)) {
      toast('先勾选要存的标签')
      return
    }
    const resolved = await resolveCandidateRows(checked)
    if (!isCurrent()) return
    this.applyResolvedRows(resolved)
    // 不同写法可能解析到同 tag_id => 按 id 去重
    const ok = [...new Map(resolved.filter((r) => r.tag_id !== undefined).map((r) => [r.tag_id!, r])).values()]
    const failed = resolved.length - ok.length

    // W2-4: 解析等候窗内并入目标可被删 —— 写前复检, 否则 addTagIdsToGroup 落空而暂存已被清+toast 谎报
    if (mergeTarget && !favorites.list.some((g) => g.id === mergeTarget.id)) {
      toast('并入目标组已被删除, 暂存位已保留', 4000)
      return
    }
    if (mergeTarget) {
      // ———— 并入语境: 暂存层整体固化进目标组 (选定组 / 草稿已存组) ————
      if (!ok.length && !expandedSnapshot.length) {
        toast(`${failed} 个标签解析失败, 未并入组`)
        return
      }
      // 勾选行优先保序, expandedIds 增量追加 (id 撞行去重, 同建组路径语义)
      const tagIds = dedupeTagIdEntries([...ok.map((r) => ({ id: r.tag_id!, name: r.tag_name })), ...expandedSnapshot])
      const expandedMerged = tagIds.length - ok.length
      const res = favorites.addTagIdsToGroup(mergeTarget.id, tagIds, { silent: true })
      // 固化完成: 暂存位清空 (并入者已是正式成员; 已在组内的本就不动 —— 成员移除走弹层★/面板)
      const savedIds = new Set(expandedSnapshot.map((e) => e.id))
      tagRecCustomSession.expandedIds = tagRecCustomSession.expandedIds.filter((e) => !savedIds.has(e.id))
      for (const r of ok) sediment.confirm(normalizeTagName(r.tag_name))
      const live = favorites.list.find((x) => x.id === mergeTarget.id)
      const parts: string[] = [
        res.added || res.moved
          ? `已并入「${mergeTarget.name}」, 共 ${live?.tag_ids.length ?? mergeTarget.tag_ids.length} 个标签`
          : `「${mergeTarget.name}」已含所选标签`,
      ]
      if (res.moved) parts.push(`${res.moved} 个由负向转正向`)
      if (expandedMerged) parts.push(`含 ${expandedMerged} 个扩选并入`)
      if (res.alsoIn.length) parts.push(`也存在于 ${summarizeGroupNames(res.alsoIn)}`)
      if (failed) parts.push(`${failed} 个解析失败跳过`)
      toast(parts.join('; '), 3500)
      // 票 10: 同上自动收起; 按真实解析失败判
      if (!resolved.some((r) => r.tag_id === undefined)) tagRecCustomSession.candidatesCollapsed = true
      return
    }

    // 票 20: 「入临时组」(弹层★②草稿组档) 写进的 expandedIds 并入新组 tag_ids ——
    // 与勾选行解析 id 去重 (票 12 语义沿用; 候选行优先保序), 「存成项时随组入表」兑现点;
    // 实机修复: 锚点本身并入首成员 —— 存成项 = 本次查询固化, 纯数字直输 (无候选行) 也存得下
    const tagIds = dedupeTagIdEntries([
      ...(anchor ? [{ id: anchor.id, name: anchor.name }] : []),
      ...ok.map((r) => ({ id: r.tag_id!, name: r.tag_name })),
      ...expandedSnapshot,
    ])
    if (!tagIds.length) {
      toast(`${failed} 个标签解析失败, 未存组`)
      return
    }
    const expandedMerged = tagIds.length - ok.length - (anchor ? 1 : 0)
    // 票 12: 草稿负向与勾中正向撞 id => 组内互斥正向优先 (makeTagGroup 构造期剔除), 计数上报
    const posIds = new Set(tagIds.map((e) => e.id))
    const negDropped = (draft?.negative_tag_ids ?? []).filter((e) => posIds.has(e.id)).length
    // 票 17: addGroup 缺省 l1Id => 自动套同名新 L1 (默认不启用), 返回 {group,l1} 取组
    // 实修: 草稿组名单容器 (overrides.negative) 随组入表 —— 右键「本组」屏蔽在存成项前的写不丢
    const group = favorites.addGroup({
      name: ok[0]?.tag_name ?? anchor!.name,
      tag_ids: tagIds,
      negative_tag_ids: draft?.negative_tag_ids,
      negative_strict: draft?.strict,
      overrides: draft?.negative ? { negative: draft.negative } : undefined,
    })?.group
    if (!group) return // 拒因 addGroup 内已 toast (空 ids)
    if (draft) draft.savedGroupId = group.id // 实修: 存后按钮态改「并入该组」, 防误触二次建组
    const savedIds = new Set(expandedSnapshot.map((e) => e.id))
    tagRecCustomSession.expandedIds = tagRecCustomSession.expandedIds.filter((e) => !savedIds.has(e.id))
    for (const r of ok) sediment.confirm(normalizeTagName(r.tag_name))
    const negNote = group.negative_tag_ids?.length ? `, 含 ${group.negative_tag_ids.length} 个负向` : ''
    const negDropNote = negDropped ? `, ${negDropped} 个负向与正向撞车剔除` : ''
    const expNote = expandedMerged ? `, 含 ${expandedMerged} 个扩选并入` : ''
    const failNote = failed ? `, ${failed} 个解析失败跳过` : ''
    toast(
      `已存为标签组「${group.name}」(${group.tag_ids.length} 个 tag_id${negNote}${negDropNote}${expNote}${failNote})`,
    )
    // 票 10: 同上自动收起; 按真实解析失败判 (同 id 去重合并不算失败, 行并入彼此仍可见)
    if (!resolved.some((r) => r.tag_id === undefined)) tagRecCustomSession.candidatesCollapsed = true
    // 「存成项后顺手并入临时过滤」: 新建成组回组给 UI 做并入问询 (并入已有组路径不回 —— 不污染已策展组)
    return group
  }

  /**
   * 过期判定 (AUDIT-16): 本实例语境签名 vs 当前签名漂移即 stale ——
   *   组语境 A→B 切换/输入提交/扩选并入全判到 (原只比 inputText, 组语境 anchorInput='' 恒不 stale);
   *   已弃 service 的异步收尾一律不写共享 session (digPending/digRunning/phase2 镜像/候选清单)。
   *   '' 钉点不算语境 (与 syncCustomSharedState 不钉空签名同款): 构造期先于 session 就绪是合法态
   *   (deeplink/预热建实例时 session 可空), 空签钉住的实例跨过语境建立不作 stale,
   *   否则首轮水合即把本实例冤判弃 —— 只有真签名钉住后漂移才算被顶替
   */
  private isSessionStale() {
    return !!this.contextSignature && this.contextSignature !== computeTagRecCustomContextSignature()
  }

  /**
   * 深翻页未完: 未干源里仍有页可翻 (pageOf < 上限) —— 零产出轮不判见底, 下一轮自动进页。
   * 请求成本不变 (原本每轮也在重复打 pn=1); 到顶/空页由 dryTids 标干后自然回到原见底语义。
   */
  private hasTagTopPagesLeft(sources: readonly { tid: number }[]): boolean {
    return sources.some(
      (source) => !this.dryTids.isDry(source.tid) && this.dryTids.pageOf(source.tid) < TAG_REC_TAG_TOP_PAGE_CAP,
    )
  }

  /** 硬见底 (spec §4.4): content 给了 => 返回 [见底 separator]; 队列排空后 hasMore=false 停自动加载 */
  private exhaustRound(content?: string): RecItemTypeOrSeparator[] {
    this.hasMoreExceptQueue = false
    // [tag-rec] 有 separator 才算真·硬见底 (未输入/解析失败 = 非池见底, 不置位) => 横幅判据, 票 09
    if (content) tagRecCustomSession.hardBottom = true
    const separator: ItemsSeparator[] = content ? [makeTagRecExhaustSeparator(content)] : []
    return separator
  }
}
