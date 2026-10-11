import { appWarn } from '$common'
import { EApiType } from '$enums'
import { BaseTabService } from '$modules/rec-services/_base'
import { settings } from '$modules/settings'
import toast from '$utility/toast'
import { isRiskControlError, tagRecBackoff } from '../api/backoff'
import { tagRecRecallScheduler } from '../api/recall-scheduler'
import {
  createTagRecAttributionEnricher,
  invalidateTagRecCardData,
  tagRecAttributionLabelOfGroup,
} from '../model/attribution'
import { parseTagRecPkgHash, parseTagRecShareDeepLink } from '../model/deeplink'
import { deriveGroupCliques, TAG_REC_SEED_POOL_MAX, tagRecSearchExtraOf } from '../model/dig'
import {
  computeTagRecFilterSignature,
  createTagRecScopeResolver,
  resolveTagRecItemScoreParams,
  resolveTagRecSeedMinScore,
  runTagRecFilter,
  runTagRecScoreStage,
  TAG_REC_ALL_POOL_KEYS,
  type TagRecDropDimKey,
  type TagRecFilterCore,
  type TagRecFilterRoundStats,
  type TagRecScopeResolve,
} from '../model/filter-engine' // [tag-rec]
import { tagRecGroupKey, tagRecSourceClaims } from '../model/relevance'
import { materializeTagRecSessionFilter } from '../model/session-filter'
import { favorites, favoritesL1, themes, viewScope } from '../store'
import { tagRecCombinationBlocks } from '../store/combination-blocks'
import { resetTagRecFavFilter, syncTagRecFavFilterScope, tagRecFavSession, tagRecSharedSession } from '../store/session'
import { TagRecFavTabbarView } from '../ui/tabbar-fav'
import {
  applyTagRecStages,
  clampTagRecK,
  createTagRecProduceTracker,
  makeTagRecExhaustSeparator,
  TAG_REC_SOURCE_FAILURE_MAX_RETRIES,
  TAG_REC_TAG_TOP_PAGE_CAP,
  TagRecSourceFailureError,
  TagRecTidDryTracker,
  trackTagRecRoundProduce,
  type TagRecRoundCtx,
  type TagRecRoundSource,
  type TagRecRoundStages, // [tag-rec]
} from './_pipeline'
import {
  isDeckDrawable,
  isL1Drawable,
  pickTagIdsForRound,
  TagRecUnitsDeck,
  unitsFingerprint,
  withTagRecGroupScope,
  withTagRecTempEnables,
} from './deck'
import { createTagRecBvidIndex, TagRecDeferredCandidates, tagRecVersionedArray } from './deferred-candidates'
import {
  previewTagRecFairSlice,
  rankTagRecFairSlice,
  TAG_REC_STOCK_TOTAL,
  TagRecFairState,
  trimTagRecStock,
} from './fair-queue'
import {
  FALLBACK_LADDER_STRATEGY_AGGRESSIVE,
  newTagRecLadderState,
  resetTagRecLadderState,
  TagRecFallbackLadder,
  tagRecHeapVersion,
} from './fallback-ladder'
import { dropTagRecStrictTagListHits, ensureTagRecNegativePools, tagRecNegativePools } from './negative-slice' // [tag-rec]
import {
  checkTagRecPartitionSlice,
  hasTagRecPartitionRules,
  TagRecPartitionBudget,
  tagRecPartitionWorkQueue,
} from './partition-slice'
import { tagRecReopenedTopTids, tagRecSourceSignature } from './recall-plan'
import { tagRecRecheckOptions, type TagRecRecheckSelection } from './recheck'
import { refilterTagRecStock } from './refilter-stock'
import { createTagRecSeenStage, tagRecSeenStage } from './seen-stage' // [tag-rec]
import { tagRecSupplyView } from './supply'
import {
  planTagRecRecall,
  runTagRecRecallRound,
  TagRecUpSearchPool,
  upSearchMids,
  type UpSearchSource,
} from './up-search'
import { tagRecVersionKey, versionedSlot } from './versioned-cache'
import type { ItemsSeparator, RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagGroup, TagL1Group } from '../model/types'

/**
 * 票 37 深挖/产出态模块级共享 (与 tag-rec-custom 同款): 刷新重建 service 同资格指纹续挖 —
 * 簇流页游标/兜底堆/选种/三停纪律/去重集/未上屏队列全保; 资格指纹变 => fetchMore 内原地重置
 */
const sharedLadderState = newTagRecLadderState()
const sharedSeenBvids = new Set<string>()
/** 交付队列写版本 (Proxy 拦写): bvid 懒索引的等长换血检出依据 —— splice 交付+push 回补净长不变也无处可藏 */
let sharedBufferQueueSeq = 0
const sharedBufferQueue: RecItemTypeOrSeparator[] = tagRecVersionedArray(() => sharedBufferQueueSeq++)
const sharedCandidates = new TagRecDeferredCandidates()
/**
 * 交付队列/兜底堆 bvid 懒索引 (mergeIncoming 每条到达物全扫 5000 深队列 => O(items×queue) 悬崖):
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
const sharedFairState = new TagRecFairState()
const sharedSuppliedGroups = new Set<string>()
let sharedDeck = new TagRecUnitsDeck()
/** 一次预取最多 5 个二级组（k 更大时随 k，上限 10）；库存少于半页才补。 */
const PREFETCH_GROUP_WINDOW = 5
const STOCK_LOW_WATER = 10
/**
 * 票 41 逐源干态同享模块级 (与 sharedLadderState/sharedSeenBvids 同层): 冷收藏组被牌组反复抽中时
 * 不再每轮重打空 tag/top —— 机制复用 tab2 TagRecTidDryTracker, 复位轴 = unitsFingerprint 变
 * (资格集变=池集合变, 干态无效 => 与 37 共享态同生死)。会话级不落盘 (持久化票 41 裁: 另议)
 */
const sharedDryTids = new TagRecTidDryTracker()
const sharedUpSearch = new TagRecUpSearchPool()
let sharedFingerprint: string | undefined
let sharedFilterSignature: string | undefined

/** 测试用: 清模块级深挖共享态+干态+指纹 (等价整页重载) */
export function resetTagRecFavSharedState() {
  tagRecFavSession.partitionPaused = false
  tagRecFavSession.partitionPending = 0
  resetTagRecFavFilter()
  tagRecFavSession.filterScopeSignature = undefined
  tagRecFavSession.filterScopeRevision = 0
  sharedUpSearch.reset()
  resetTagRecLadderState(sharedLadderState)
  sharedSeenBvids.clear()
  sharedBufferQueue.length = 0
  sharedCandidates.clear()
  sharedFairState.clear()
  sharedSuppliedGroups.clear()
  sharedDeck = new TagRecUnitsDeck()
  sharedDryTids.clear()
  sharedFingerprint = undefined
  sharedFilterSignature = undefined
}

/** A4-6: 「清空已看」联动 —— 持久池清完, 跨轮内存去重同步清 (经 service-map 注册表调达, 保惰性边界) */
export function clearTagRecFavSharedSeenBvids() {
  sharedSeenBvids.clear()
}

/**
 * 巨型收藏夹规模修复 (535 组实测单轮 ~1150 次全表重建 => 主线程冻结):
 * 生效链求解器与三签名按 store 版号记忆化 —— 任一输入深变即换键重算;
 * 非代理输入 (测试替身) 退化为逐次直算, 与缓存前语义一致。
 * resolver 输入 = favorites/favoritesL1/blocks/settings.tagRec/favSession;
 * 语境键加 viewScope.scope/themes/sharedSession + 派生 viewed 集
 * (viewScopeStore.groupScope 无版号外泄, 用 viewedGroupIds 输出兜底覆盖)。
 */
function favResolverKey(): string | undefined {
  const rk = tagRecVersionKey([favorites.list, favoritesL1.list, tagRecCombinationBlocks, settings.tagRec])
  // 会话态按「参与求解的字段」内容入键而非整对象版号 —— filterStats/partitionPending
  // 等每轮写字段不再连带失效 (patch 小, stringify 稳定且非代理内容也正确)
  return rk === undefined ? undefined : `${rk}|ov:${JSON.stringify(tagRecFavSession.filterOverride ?? null)}`
}
const favViewedIdsSlot = versionedSlot<string>()
/** 派生 viewed 集同样版号化 —— groupScope 无外泄 getter, 其写点均与 favorites/l1 写配对, 由表版号覆盖 */
function favViewedIdsPart(): string | undefined {
  return favViewedIdsSlot(
    tagRecVersionKey([viewScope.scope, themes.list, favoritesL1.list, favorites.list]),
    () =>
      `${[...(viewScope.viewedL1Ids() ?? [])].sort().join(',')}|${[...(viewScope.viewedGroupIds?.() ?? [])].sort().join(',')}`,
  )
}
function favContextKey(): string | undefined {
  const rk = favResolverKey()
  const ctx = tagRecVersionKey([viewScope.scope, themes.list])
  const vp = favViewedIdsPart()
  if (rk === undefined || ctx === undefined || vp === undefined) return undefined
  const sess = JSON.stringify([
    tagRecFavSession.bypassSeen,
    tagRecSharedSession.recoveryRevision,
    tagRecSharedSession.tempEnabledL1Ids,
    tagRecSharedSession.tempEnabledGroupIds,
  ])
  return `${rk}:${ctx}|${sess}|${vp}`
}
const favResolverSlot = versionedSlot<TagRecScopeResolve>()
const favSourceSigSlot = versionedSlot<string>()
const favContextSigSlot = versionedSlot<string>()
const favFilterSigWithSources = versionedSlot<string>()
const favFilterSigNoSources = versionedSlot<string>()
const favRecheckSlot = versionedSlot<{
  plan: ReturnType<typeof planTagRecRecall>
  upsByGroup: Map<string, UpSearchSource[]>
}>()

function favScopeResolver(): TagRecScopeResolve {
  return favResolverSlot(favResolverKey(), () =>
    createTagRecScopeResolver({
      globalExclusions: tagRecCombinationBlocks.list,
      globalExclusionsInvalid: tagRecCombinationBlocks.invalid,
      core: settings.tagRec.filter,
      sessionCore: tagRecFavSession.filterOverride,
      groupsByName: new Map(favorites.list.map((g) => [g.name, g])),
      groupsById: new Map(favorites.list.map((g) => [g.id, g])), // A1-3: id 链权威
      l1ById: new Map(favoritesL1.list.map((l) => [l.id, l])),
    }),
  )
}

/** 票 44: 语境签名 (= 资格指纹: 查看范围 + 有效 L1 表 + L2 资格项) —— 构造期同步与 useRefresh 漂移判定复用 */
export function computeTagRecFavSourceSignature(): string {
  return favSourceSigSlot(favContextKey(), () =>
    tagRecSourceSignature(
      participatingGroups().map((g) => ({ key: { id: g.id }, name: g.name })),
      favScopeResolver(),
    ),
  )
}
export function computeTagRecFavContextSignature(): string {
  return favContextSigSlot(
    favContextKey(),
    () =>
      unitsFingerprint(effectiveGroups(), effectiveL1s(), viewScope.viewedL1Ids()) +
      `|seen:${!!tagRecFavSession.bypassSeen}:${tagRecSharedSession.recoveryRevision ?? 0}|sources:${computeTagRecFavSourceSignature()}`,
  )
}

function effectiveGroups() {
  return withTagRecGroupScope(favorites.list, viewScope.viewedGroupIds?.(), tagRecSharedSession.tempEnabledGroupIds)
}

/** R7: 有效 L1 表 = 持久表 + 临时打开合流 (会话级; 刷新还原, 不改 store) */
function effectiveL1s(): TagL1Group[] {
  return withTagRecTempEnables(favoritesL1.list, tagRecSharedSession.tempEnabledL1Ids)
}

function participatingGroups(): TagGroup[] {
  const parents = new Set(
    effectiveL1s()
      .filter((l) => isL1Drawable(l, viewScope.viewedL1Ids()))
      .map((l) => l.id),
  )
  return effectiveGroups().filter((g) => isDeckDrawable(g) && g.l1Id && parents.has(g.l1Id))
}

/**
 * 票 44: 签名比对前移 —— 「有旧指纹且不同」即原地重置共享态, 返回当前指纹;
 *   构造期+fetchMore 双点调用。构造期必须: loadMore 先放 bufferQueue 后进 fetchMore,
 *   不前置同步 = 旧境存货被当新境首页放行 (主题切换「没反应/加在视频后面」病根)
 */
function syncFavSharedState(): string {
  syncTagRecFavFilterScope(
    JSON.stringify([
      [...(viewScope.viewedL1Ids() ?? [])].sort(),
      [...(viewScope.viewedGroupIds?.() ?? [])].sort(),
      participatingGroups()
        .map((g) => g.id)
        .sort(),
    ]),
  )
  const fingerprint = computeTagRecFavContextSignature()
  const members = fingerprint.split('|sources:', 1)[0]
  if (sharedFingerprint !== undefined && members !== sharedFingerprint) {
    sharedUpSearch.reset(true)
    resetTagRecLadderState(sharedLadderState, true)
    sharedSeenBvids.clear()
    sharedBufferQueue.length = 0
    sharedCandidates.clear()
    sharedFairState.clear()
    sharedSuppliedGroups.clear()
    sharedDeck = new TagRecUnitsDeck()
    sharedDryTids.clear() // 票 41: 资格集变=池集合变 => 干态随 37 共享态同清
  }
  sharedFingerprint = members
  return fingerprint
}

/**
 * 实修票①「放宽过滤救不活已滤条」: 过滤生效签名 —— 覆盖生效链全部输入
 *   (全局核心 + 各组负向名单/严格标/overrides + 各 L1 overrides; 改名也入签 —— 链按名解析)。
 *   变 => 仅清跨轮 seenBvids: 下轮 tag/top 重采样时已滤条重新进池参评 —— 零新增请求
 *   (浅池按 tid 采样本轮必拉, 签名只切条级去重记忆); 真看过的在 seen-set 不复活。
 *   收紧侧由 refilterSharedQueue 覆盖存货 (构造期), 本签名管放宽侧的复活资格。
 */
/** A4-3: 过滤签名计算外提 —— service-map 漂移判定复用 (在途刷新的收紧型 emit 不再被静默丢) */
export function computeTagRecFavFilterSignature(withoutSources = false): string {
  const slot = withoutSources ? favFilterSigNoSources : favFilterSigWithSources
  const sig = slot(favResolverKey(), () =>
    computeTagRecFilterSignature({
      core: settings.tagRec.filter,
      sessionCore: tagRecFavSession.filterOverride,
      groups: favorites.list,
      l1s: favoritesL1.list,
      withoutSources,
    }),
  )
  return sig + `|globalExclusions:${JSON.stringify([tagRecCombinationBlocks.list, tagRecCombinationBlocks.invalid])}`
}

function syncFavFilterState() {
  const source = computeTagRecFavSourceSignature()
  const sig = computeTagRecFavFilterSignature(true) + '|sources:' + source
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

/**
 * 票 18 (tag-share) 深链消费 (spec §6): `?gate-tab=tag-rec-fav&tag-rec-share=<id>[&tag-rec-groups=<csv>]`
 * —— 网站「导入到插件」回跳 tab1 的落点。选型与 tab2 consumeTagRecDeepLink 同款 (构造期同步段,
 *   不依赖挂载/emit 时序): 解析后 history.replaceState 清两参 (防刷新重放; gate-tab 保留属既有机制),
 *   shareId 在 => 懒载 ./share-import 编排 (GM_xhr 详情拉取+预览 Modal+落表全在其内),
 *   模块图常态不背分享管线; 失败全走 toast 不崩构造
 */
let tagRecShareDeepLinkConsumed = false

function consumeTagRecShareDeepLink() {
  if (tagRecShareDeepLinkConsumed) return
  tagRecShareDeepLinkConsumed = true
  if (typeof location === 'undefined') return // 测试/node 环境兜底
  const { shareId, groupIds, paramsToClear } = parseTagRecShareDeepLink(location.search)
  const { code: pkgCode, hasPkg } = parseTagRecPkgHash(location.hash) // 票27: 试改版包走 hash
  if (!paramsToClear.length && !hasPkg) return
  for (const p of paramsToClear) {
    const u = new URL(location.href)
    u.searchParams.delete(p)
    history.replaceState({}, '', u.href)
  }
  if (hasPkg) {
    const u = new URL(location.href)
    u.hash = '' // 清 fragment 防刷新重放 (pkg 链 = `?gate-tab=tag-rec-fav#tag-rec-pkg=<code>`)
    history.replaceState({}, '', u.href)
  }
  // W6-10: share 与 pkg 同现 => pkg 优先 (信封自带 sid 出处, 信息不丢; share 支不再静默吃 pkg)
  if (pkgCode) {
    if (shareId) toast('链接同时携带分享与试改包参数, 已按试改包导入', 4000)
    void import('./share-import')
      .then((m) => m.requestShareImportPkg(pkgCode, 'deeplink'))
      .catch(() => toast('分享导入模块加载失败'))
  } else if (shareId) {
    void import('./share-import')
      .then((m) => m.requestShareImport(shareId, groupIds, 'deeplink'))
      .catch(() => toast('分享导入模块加载失败'))
  }
}

/**
 * [tag-rec] 「主题推荐」tab —— 三层公平抽样混合流 (spec §4.3 tab1 / §4.4; 票 17 L1/L2 层级)
 * 供给与展示分离：一次预取至多 K 个 L1、窗口内多个 L2，各组 ≤10 个标签。
 * 未展示候选同会话留存；每批 20 条按 L1 权重 → L2 权重交错出队。
 * 组权重只在交付份额中计一次，标签数与库存深度不增加展示份额。
 * 见底 (spec §4.4):
 *   软 = 连续 2 轮产出 <5 => tagRecFavSession.softBottom (横幅归票 09, 不阻断)
 *   硬 = 单轮产出 0 (含无可抽组) => 返回 [见底 separator] + hasMoreExceptQueue=false,
 *        队列排空后 hasMore=false 截停 fetchMinCount 连发 (一轮一空转即截停)
 * 手动「重抽一轮」 = useOnRefresh()('refresh') 重建 service (机制在此; 按钮 UI 归票 09)
 */
export class TagRecFavService extends BaseTabService {
  static PAGE_SIZE = 20

  /** 票 44: 语境签名快照 —— useRefresh 判定在途刷新是否被语境变更 (主题切换/资格集变) 作废顶替;
   *  A4-1: 非 readonly —— 被动漂移后 fetchMore 内随共享态重置重钉 (isStale 不再永真楔死深挖链) */
  contextSignature: string

  /**
   * A4-3: 过滤签名构造期钉点 —— drift 判定的「收紧型过滤变更」轴;
   *   刻意不随 fetchMore 重钉 (放宽侧复活走 seenBvids 通道自愈, 钉点漂移保留给 drift 判定消费)
   */
  readonly filterSignature: string

  constructor() {
    super(TagRecFavService.PAGE_SIZE)
    consumeTagRecShareDeepLink() // 票 18 (tag-share): 分享导入深链 —— 清参后置 shareImport 请求位
    // AUDIT-16: favorites/L1 异步水合可晚于 service 构造 —— 空表钉下的指纹不算语境钉点
    //   (否则首轮水合即把本实例冤判 stale: 预热/测试的「先建后填」路径全灭); 有内容钉点后漂移才算被顶替
    this.pinnedEmpty = !favorites.list.length && !favoritesL1.list.length
    this.contextSignature = syncFavSharedState() // 票 44: 签名比对前移构造期, 旧境存货不过夜
    syncFavFilterState() // 实修票①: 过滤配置漂移 => seenBvids 复位, 放宽后已滤条重获参评资格
    sharedUpSearch.sync(this.recheckPlan().up)
    this.filterSignature = computeTagRecFavFilterSignature() // A4-3: 构造期钉点 (漂移判定输入; 不随轮重钉)
    this.qs.bufferQueue = sharedBufferQueue // 票 37: 未上屏存货跨刷新存活 (签名变时上行已清)
    this.refilterSharedQueue() // 实修: 组 override/全局改后刷新, 存货按新生效链重滤 (旧配置滤出的不再直放)
    this.retryPartitions()
  }

  private partitionBudget?: TagRecPartitionBudget
  private partitionHeld = new Set<string>()
  private partitionPausePolicy?: string
  get autoLoadPaused() {
    if (tagRecFavSession.partitionPaused && this.partitionPausePolicy !== computeTagRecFavFilterSignature()) {
      this.partitionHeld.clear()
      this.retryPartitions()
    }
    return tagRecFavSession.partitionPaused
  }
  retryPartitions() {
    tagRecFavSession.partitionPaused = false
    tagRecFavSession.partitionPending = 0
  }
  beginLoadOperation(signal: AbortSignal) {
    this.endLoadOperation()
    this.partitionBudget = new TagRecPartitionBudget(signal)
  }
  endLoadOperation() {
    this.partitionBudget?.dispose()
    this.partitionBudget = undefined
  }

  override tabbarView = <TagRecFavTabbarView service={this} />
  override sidebarView = undefined
  /**
   * 全参与组召回规划 + UP 源按组索引 —— 版号记忆化。
   * hasUpSupply 原逐组各跑一次 planTagRecRecall (535 组=535 次小规划/轮);
   * 合并 plan 的 up 源带 groupIds 并集, 按组过滤等效且只建一次; hasMore 仍读活池态。
   */
  private recheckBundle() {
    return favRecheckSlot(favContextKey(), () => {
      const groups = participatingGroups()
      const plan = planTagRecRecall(
        {
          roundSources: groups.flatMap((g) =>
            g.tag_ids.map((e) => ({ tid: e.id, keyword: e.name, groupIds: [g.id], groupNames: [g.name] })),
          ),
          digSources: deriveGroupCliques(
            groups.map((g) => ({ ...g, extra: tagRecSearchExtraOf(favScopeResolver()({ id: g.id }, 'allV2')) })),
            Infinity,
          ),
          scopeConsumers: groups.map((group) => ({ key: { id: group.id }, name: group.name })),
        },
        favScopeResolver(),
      )
      const upsByGroup = new Map<string, UpSearchSource[]>()
      for (const s of plan.up)
        for (const gid of s.groupIds ?? []) {
          const arr = upsByGroup.get(gid) ?? []
          if (!arr.length) upsByGroup.set(gid, arr)
          arr.push(s)
        }
      return { plan, upsByGroup }
    })
  }
  private recheckPlan() {
    return this.recheckBundle().plan
  }
  getRecheckOptions() {
    return tagRecRecheckOptions(this.recheckPlan())
  }
  recheck(selection: TagRecRecheckSelection, signal?: AbortSignal) {
    if (tagRecBackoff.isEngaged || this.isStale())
      return Promise.resolve({ requests: 0, added: 0, empty: false, failed: false, stale: true })
    return tagRecRecallScheduler
      .withForegroundSupply(() => this.ladder.recheck(selection, this.recheckPlan(), signal ?? this.lastFetchSignal))
      .then((result) => {
        if (!result.stale && result.added) {
          this.hasMoreExceptQueue = true
          tagRecFavSession.hardBottom = false
          tagRecFavSession.digPending = false
        }
        return result
      })
  }
  override restore() {
    this.retryPartitions()
    super.restore()
    sharedCandidates.flushMerged() // 入队门标脏条目批末评分补发 —— 过滤重写归属前字段与逐条 rank 口径齐
    const filtered = runTagRecFilter(
      this.qs.bufferQueue.filter((it): it is TagRecItemExtend => it.api === EApiType.TagRec),
      { resolve: this.scopeResolver(), pools: tagRecNegativePools(), deferPartitions: true },
    ).items
    const keep = new Set(filtered)
    this.qs.bufferQueue.splice(
      0,
      this.qs.bufferQueue.length,
      ...this.qs.bufferQueue.filter((it) => it.api !== EApiType.TagRec || keep.has(it)),
    )
  }
  // spec §4.4: 常规 true; 硬见底翻 false 截停 fetchMinCount 连发
  override hasMoreExceptQueue = true

  /** [tag-rec] R09: 未决轮 (零产出+失败源) 连续计数 —— 有界重试, 超限抛可重试错误 (定轮归零) */
  private failedSourceRounds = 0

  /** 与库存同生死；刷新保留进度，资格语境变化时重建。 */
  private get deck() {
    return sharedDeck
  }
  private prefetchRunning: Promise<void> | undefined
  /**
   * 内层 tag 轮转游标 (票 17): L2 组 id => 游标; 抽中组 >10 id 每轮取 10 切片逐轮覆盖
   * AUDIT-20: 升共享盒 —— 实例级游标随 refresh 归零 → 大组永远重拉首片 (ids 11..N 会话内饿死);
   *   资格指纹变经 resetTagRecLadderState 随盒同清
   */
  private tagCursors = sharedLadderState.tagCursors
  /**
   * AUDIT-15: 手动深挖生命周期闸 —— fetchMore 入口登记当前 abortSignal;
   *   service 被弃 (刷新顶替/卸载) 时 useRefresh abort 旧 controller => 在途/后续手动深挖批随截停
   */
  private lastFetchSignal: AbortSignal | undefined
  /** 跨轮 bvid 去重 (语义同 recItemUniqer; 渲染层 concatRecItems 再兜底); 票 37: 模块级共享, 刷新续去重 */
  private seenBvids = sharedSeenBvids
  /**
   * 票 41 逐源干态记忆 (tab2 票 32 同款移植): 空响应即干 / 零新增连击标干 —— 模块级共享,
   * service 重建/点刷新存活; 资格指纹变或整页重载才清; 干键按 tid 不按轮次, 抽中才记账
   */
  private dryTids = sharedDryTids
  /**
   * 票 13 兜底梯队: 抽中组成员规范名 => 同义词簇深挖流 (饿谁喂谁, D7/D8);
   * 无候选清单/变体 hooks (tab1 无 Phase 2 UI) —— 编排与 tab2 同款 fallback-ladder.ts
   */
  private ladder = new TagRecFallbackLadder(
    {
      seenBvids: this.seenBvids,
      resolve: () => this.scopeResolver(),
      relatedSeedingAllowed: () => this.relatedSeedingAllowed(),
      bypassSeen: () => tagRecFavSession.bypassSeen,
      policySignature: () => computeTagRecFavSourceSignature() + computeTagRecFavFilterSignature(true),
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
      hasDemandStock: () => {
        const groups = participatingGroups().filter((g) => this.hasAllowedSupply(g))
        const counts = this.supplyView().groups
        return groups.length > 0 && groups.every((g) => (counts.get(tagRecGroupKey({ id: g.id }))?.size ?? 0) > 0)
      },
      poolItems: () => sharedCandidates.values(),
      candidateScope: () => {
        const groups = participatingGroups()
        const counts = this.supplyView()
        const keys = (g: TagGroup) => [tagRecGroupKey({ id: g.id }), tagRecGroupKey(g.name)]
        return {
          needed: new Set(
            groups.filter((g) => this.hasAllowedSupply(g) && counts.needs(tagRecGroupKey({ id: g.id }))).flatMap(keys),
          ),
          all: new Set(groups.flatMap(keys)),
        }
      },
      // 票05 paramsOf: 逐条按所属池槽求解 (兜底堆混 allV2/archiveRelated/tagTop)
      // A5: 逐调 cloneDeep 代价 × 堆内条数 => 按池记忆化; 失效令牌 = sharedFilterSignature
      //   (过滤任一输入变即换签 → 旧表作废) + core 对象身份 (替身防御); 窗内编辑至多迟一轮生效
      scoreParams: (it) => {
        const core = settings.tagRec.filter
        const c = this.scoreParamsCache
        if (c.core !== core || c.sig !== sharedFilterSignature || c.patch !== tagRecFavSession.filterOverride) {
          c.resolve = this.scopeResolver()
          c.core = core
          c.sig = sharedFilterSignature
          c.patch = tagRecFavSession.filterOverride
        }
        return resolveTagRecItemScoreParams(it, c.resolve!)
      },
    },
    // 票 32 起 tab1 同激进档 (用户裁): 浅水位预挖 + 自适应深挖, 冷池体验与 tab2 对齐
    // 票10: settings.tagRec.ladder 全局高级参数 getter 注入 (热更)
    { ...FALLBACK_LADDER_STRATEGY_AGGRESSIVE, ladder: () => settings.tagRec.ladder },
    sharedLadderState, // 票 37: 同指纹刷新续挖 (簇流页游标/堆不丢)
  )
  private digRunning: Promise<unknown> | undefined
  private produceTracker = createTagRecProduceTracker()
  /** A5: scoreParams 记忆盒 —— {core, sig} 双闸失配即清 (见 ladder opts 注释) */
  private scoreParamsCache = {
    core: undefined as TagRecFilterCore | undefined,
    sig: undefined as string | undefined,
    patch: undefined as typeof tagRecFavSession.filterOverride,
    resolve: undefined as TagRecScopeResolve | undefined,
  }

  /** [tag-rec] 轮次阶段 (票 06/08 实装): 过滤(含黑名单维) => 算分排序 => 去已看 —— 只换实现不动骨架 */
  private stages: TagRecRoundStages = {
    filterStage: (items, ctx) => this.runFilterStage(items, ctx),
    scoreStage: (items, ctx) => this.runScoreStage(items, ctx),
    seenStage: createTagRecSeenStage(tagRecFavSession, () => tagRecFavSession.bypassSeen),
  }

  /** 生效链求解器 (票01): 全表组名=>组 + L1=>id; 每次调用新建 (廉价, 内部按组×池缓存本趟解) */
  private scopeResolver(): TagRecScopeResolve {
    return favScopeResolver()
  }

  /**
   * 实修 (组 override「刷新」不生效根因): sharedBufferQueue 跨刷新存活 (票37), 存货是旧配置滤出的,
   *   sliceFromQueue 直放不再过阶段 => 构造期原位重过一遍 filterStage
   *   (seenStage 不重跑 —— 队列货本就去过重, 重跑会被 seen 误杀; 分隔符不进过滤原样保留)
   */
  private refilterSharedQueue() {
    const resolve = this.scopeResolver()
    sharedCandidates.resolve = resolve
    const stats = refilterTagRecStock(sharedBufferQueue, this.effectiveFilter(), resolve, {
      pools: tagRecNegativePools(),
      candidates: sharedCandidates,
      recover: (items) => tagRecSeenStage(items, tagRecFavSession.bypassSeen),
      relatedFallback: this.relatedFallbackOn(),
    })
    if (stats) tagRecFavSession.filterStats = stats
  }

  /**
   * 小池降级 (池浅已放宽) 时放行 related 路由条目的组合 mismatch —— 工作台之前的语义:
   * 相关条带「相关」徽标交付、不冒充命中; 排除/屏蔽/来源闸不受影响 (见 filter-engine 判据)。
   */
  private relatedFallbackOn() {
    return tagRecFavSession.filterStats.degraded
  }

  /** 交集组合在的组: related 只是兜底料 —— 兜底门不开时停选种 (产物纯死库存, 火力留给 all/v2).
   *  走 resolver 的派生交集标记 —— 生效链 tagAllow 计入同口径 (判定函数只见组合内 filters) */
  private relatedSeedingAllowed() {
    const resolve = favScopeResolver()
    const inter = participatingGroups().some((g) => g.combination && resolve({ id: g.id }, 'allV2').intersection)
    return !inter || this.relatedFallbackOn()
  }

  private effectiveFilter(): TagRecFilterCore {
    const core = settings.tagRec.filter
    return tagRecFavSession.filterOverride
      ? materializeTagRecSessionFilter(core, tagRecFavSession.filterOverride)
      : core
  }

  private hasUpSupply(group: TagGroup, resolve: TagRecScopeResolve): boolean | undefined {
    if (!upSearchMids(resolve, { id: group.id })) return
    return sharedUpSearch.hasMore(this.recheckBundle().upsByGroup.get(group.id) ?? [])
  }

  private hasAllowedSupply(group: TagGroup) {
    const resolve = this.scopeResolver()
    const pools = resolve({ id: group.id }, 'allV2').poolsEnabled
    return upSearchMids(resolve, { id: group.id }) ? pools.allV2 : TAG_REC_ALL_POOL_KEYS.some((p) => pools[p])
  }
  private supplyView() {
    const stock = sharedBufferQueue.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
    // 组数×低水位 ≤ 总库存上限才联合可达: 535 组 ×10 超过 5000 库存上限, 互异归属下不可达,
    //   会锁死 needsSupply —— 每轮前台补货 + 交付后预取持续放大全库重滤/候补淘汰成本
    const groups = Math.max(1, participatingGroups().length)
    const lowWater = Math.min(STOCK_LOW_WATER, Math.max(1, Math.floor(TAG_REC_STOCK_TOTAL / groups)))
    return tagRecSupplyView(sharedCandidates.values(), stock, this.scopeResolver(), lowWater)
  }

  private needsSupply() {
    const groups = participatingGroups()
    const counts = this.supplyView()
    // 全局高水位闸: 总库存触顶时欠产组的腾位只能来自交付排水/入队淘汰,
    //   此时前台补货与交付后预取都是纯开销 —— 水面以下恢复逐组低水位判定
    if (counts.stockTotal >= TAG_REC_STOCK_TOTAL) return false
    const resolve = this.scopeResolver()
    return groups.some(
      (g) =>
        this.hasAllowedSupply(g) &&
        counts.needs(tagRecGroupKey({ id: g.id })) &&
        (this.hasUpSupply(g, resolve) ?? true),
    )
  }

  /** 任一可供给组归属库存为零且本轮也没供到货 —— 与 preDig 内层 hasDemandStock 门同义, 作外层触发 */
  private hasStarvedGroup(roundItems: readonly TagRecItemExtend[]) {
    const counts = this.supplyView().groups
    // fed 口径须与库存同域: claims ∩ eligibleGroupKeys —— 共享 tid 的条目会带着本组归因
    //   被别组资格放行 (eligible 只剩别组), 裸认 claims 会把"被剥夺资格的组"误判成已供货
    const fed = new Set(
      roundItems.flatMap((it) =>
        tagRecSourceClaims(it).flatMap((c) =>
          (c.groupIds ?? []).filter(
            (gid) => !it.eligibleGroupKeys || it.eligibleGroupKeys.includes(tagRecGroupKey({ id: gid })),
          ),
        ),
      ),
    )
    return participatingGroups().some(
      (g) => this.hasAllowedSupply(g) && !fed.has(g.id) && !counts.get(tagRecGroupKey({ id: g.id }))?.size,
    )
  }

  private enqueueStock(items: RecItemTypeOrSeparator[]) {
    // 入队门 bvid 唯一性: 并发生产者窗口 (seen 占位先于 push 落定) 下重复到达并入存量而非复推/丢弃;
    //   批内同 bvid 同样只留首份 (stagedBvids)
    const qmap = sharedQueueIndex.map() as ReadonlyMap<string, TagRecItemExtend>
    const stagedBvids = new Set<string>()
    const staged: RecItemTypeOrSeparator[] = []
    for (const item of items) {
      if (item.api !== EApiType.TagRec) {
        staged.push(item)
        continue
      }
      if (stagedBvids.has(item.bvid)) continue
      const queued = qmap.get(item.bvid)
      if (queued) sharedCandidates.mergeQueued(queued, item, (xs) => this.runScoreStage(xs))
      else {
        staged.push(item)
        stagedBvids.add(item.bvid)
      }
    }
    // 批末一次评分: mergeQueued 标脏的排队条目在此按 BV 去重一次算分, 淘汰排序读到的是新分数
    sharedCandidates.flushMerged()
    if (staged.length) sharedBufferQueue.push(...staged)
    for (const item of trimTagRecStock(sharedBufferQueue, participatingGroups())) this.seenBvids.delete(item.bvid)
  }

  private prefetch(abortSignal: AbortSignal) {
    if (participatingGroups().every((g) => !!upSearchMids(this.scopeResolver(), { id: g.id }))) return
    if (this.prefetchRunning || !this.hasMoreExceptQueue || abortSignal.aborted || this.isStale()) return
    if (tagRecBackoff.isEngaged || !this.needsSupply()) return
    const epoch = sharedLadderState.epoch
    this.prefetchRunning = this.fetchMore(abortSignal)
      .then(async (items) => {
        if (items?.length && !abortSignal.aborted && !this.isStale() && sharedLadderState.epoch === epoch)
          this.enqueueStock(items)
        if (this.needsSupply() && !abortSignal.aborted && !this.isStale() && sharedLadderState.epoch === epoch) {
          await this.ladder.maybeSeedRelated(abortSignal, sharedLadderState.stockEpoch)
          if (!abortSignal.aborted && !this.isStale() && sharedLadderState.epoch === epoch)
            this.enqueueStock(this.ladder.releasePage(epoch))
        }
      })
      .catch((e) => appWarn('[tag-rec] fav prefetch failed: %o', e))
      .finally(() => {
        this.prefetchRunning = undefined
      })
  }

  /** [tag-rec] 过滤阶段: 生效链逐认领组评估 (任一放行); 分维度计数/降级写 session */
  private runFilterStage(items: TagRecItemExtend[], ctx?: TagRecRoundCtx): TagRecItemExtend[] {
    // 复用设计 1: resolver 同 pass 只建一次 —— ctx 就地回填, scoreStage 直接复用
    const resolve = ctx ? (ctx.resolve ??= this.scopeResolver()) : this.scopeResolver()
    sharedCandidates.resolve = resolve
    sharedCandidates.record(items)
    const { items: out, stats } = runTagRecFilter(items, {
      resolve,
      pools: tagRecNegativePools(),
      poolSize: ctx?.poolSize ?? ctx?.fetchedCount ?? items.length,
      poolItems: ctx?.poolItems ?? items,
      deferPartitions: true,
      relatedFallback: this.relatedFallbackOn(),
    })
    const prev = tagRecFavSession.filterStats
    // 旁路产出 (深挖/兜底放行) 走 merge —— 批次量小, 覆盖会把主轮滤除账清零并把 degraded 错钉真
    // A2-8 推广 (2026-10-06): 主轮同样不灭降级灯 —— 空轮会把 degraded 误清成 false (同 tab2)
    tagRecFavSession.filterStats = ctx?.mergeStats
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

  /** [tag-rec] 算分排序阶段: 逐认领组链取 max (票01) + diversityGuard 两轴 (票09) */
  private runScoreStage(items: TagRecItemExtend[], ctx?: TagRecRoundCtx): TagRecItemExtend[] {
    const { items: out } = runTagRecScoreStage(items, this.effectiveFilter(), {
      resolve: ctx?.resolve ?? this.scopeResolver(),
      diversityGuard: settings.tagRec.diversityGuard,
      sliceSize: TagRecFavService.PAGE_SIZE,
    })
    return out
  }

  /** 旁路产出 (深挖 exact / 兜底梯队放行) 走同一套阶段 (spec §4.3「经同一管线」; ctx.poolSize=票06堆深注入, mergeStats=旁路账并入) */
  private applyStages(items: TagRecItemExtend[], ctx?: Partial<TagRecRoundCtx>) {
    return applyTagRecStages(items, { fetchedCount: items.length, ...ctx }, this.stages)
  }

  /**
   * [tag-rec] 上屏切片严格校验 (negative-slice.ts): 仅对「开了 negative_strict 的源组」条目
   * 逐条 view/detail/tag 核查负向命中 —— 逐条请求是组级自愿付费, 默认关;
   * 退避态直通 + 5s 时间盒 fail-open; 无 strict 源 => 直通
   */
  override async loadMore(abortSignal: AbortSignal): Promise<RecItemTypeOrSeparator[] | undefined> {
    if (abortSignal.aborted || this.autoLoadPaused) return
    const local = !this.partitionBudget
    const budget = this.partitionBudget ?? new TagRecPartitionBudget(abortSignal)
    try {
      return await this.loadPartitionChecked(abortSignal, budget)
    } finally {
      if (local) budget.dispose()
    }
  }

  private async loadPartitionChecked(
    abortSignal: AbortSignal,
    budget: TagRecPartitionBudget,
  ): Promise<RecItemTypeOrSeparator[] | undefined> {
    if (abortSignal.aborted) return
    this.lastFetchSignal = abortSignal
    this.contextSignature = syncFavSharedState()
    const oldFilter = sharedFilterSignature
    syncFavFilterState()
    if (oldFilter !== sharedFilterSignature) this.partitionHeld.clear()
    if (oldFilter !== sharedFilterSignature || sharedCandidates.needsRefilter) this.refilterSharedQueue()
    if (
      !sharedUpSearch.active &&
      this.effectiveFilter().enabled &&
      (this.effectiveFilter().dims.upAllow.enabled ||
        favorites.list.some((g) => g.overrides?.negative?.upAllow?.enabled) ||
        favoritesL1.list.some((g) => g.overrides?.negative?.upAllow?.enabled))
    ) {
      const resolve = this.scopeResolver()
      if (participatingGroups().some((g) => upSearchMids(resolve, { id: g.id }))) {
        resetTagRecLadderState(sharedLadderState)
        sharedUpSearch.active = true
      }
    }
    const epoch = sharedLadderState.epoch
    this.enqueueStock(this.ladder.releasePage(epoch))
    if (!this.hasMore) return
    if (this.prefetchRunning) await this.prefetchRunning
    if (this.hasMoreExceptQueue && (!sharedBufferQueue.length || this.needsSupply())) {
      try {
        const more = await this.fetchMore(abortSignal)
        if (abortSignal.aborted || this.isStale() || sharedLadderState.epoch !== epoch) return
        if (more?.length) this.enqueueStock(more)
      } catch (e) {
        // 某组补货失败时仍交付其他组的库存；没有库存才交给页面重试入口。
        if (!(e instanceof TagRecSourceFailureError) || !sharedBufferQueue.length) throw e
      }
    }
    if (abortSignal.aborted || this.isStale() || sharedLadderState.epoch !== epoch) return
    const delivered: RecItemTypeOrSeparator[] = []
    const workingQueue = tagRecPartitionWorkQueue(sharedBufferQueue, this.partitionHeld)
    const draftState = sharedFairState.clone()
    const consumed = new Set<RecItemTypeOrSeparator>()
    const turns: ReturnType<typeof previewTagRecFairSlice>['turns'] = []
    const strictStats: TagRecFilterRoundStats[] = []
    const pending = new Map<RecItemTypeOrSeparator, TagRecItemExtend>()
    const policy = computeTagRecFavFilterSignature()
    // 严格校验拒绝的候选不扣名额；至多再补一批，保持校验请求有界。
    for (let pass = 0; pass < 2 && delivered.length < this.qs.ps; pass++) {
      const preview = previewTagRecFairSlice(
        workingQueue,
        participatingGroups(),
        effectiveL1s(),
        draftState,
        this.qs.ps - delivered.length,
        settings.tagRec.diversityGuard,
        delivered,
      )
      if (!preview.items.length) break
      let items = preview.items
      if (this.effectiveFilter().enabled || hasTagRecPartitionRules(items, this.scopeResolver())) {
        if (hasTagRecPartitionRules(items, this.scopeResolver())) {
          const partitions = await checkTagRecPartitionSlice(items, this.scopeResolver(), budget, {
            negative: { pools: tagRecNegativePools() },
            relatedFallback: this.relatedFallbackOn(),
          })
          if (
            abortSignal.aborted ||
            this.isStale() ||
            sharedLadderState.epoch !== epoch ||
            policy !== computeTagRecFavFilterSignature()
          )
            return
          items = partitions.items
          for (const [original, updated] of partitions.pending) pending.set(original, updated)
          sharedCandidates.record(partitions.updated)
          strictStats.push(partitions.stats)
        }
        const checked = await dropTagRecStrictTagListHits(
          items,
          this.effectiveFilter(),
          this.scopeResolver(),
          abortSignal,
          undefined,
          true,
          budget, // 审计 §1: 严格核验与分区/素材核验共享整次刷新预算
        )
        if (
          abortSignal.aborted ||
          this.isStale() ||
          sharedLadderState.epoch !== epoch ||
          policy !== computeTagRecFavFilterSignature()
        )
          return
        items = checked.items
        strictStats.push(checked.stats)
      }
      for (const item of preview.items) if (!pending.has(item)) consumed.add(item)
      for (let i = workingQueue.length - 1; i >= 0; i--)
        if (consumed.has(workingQueue[i]) || pending.has(workingQueue[i])) workingQueue.splice(i, 1)
      // 补查可能增加相关性证据或改变允许归属；交付前重新排序与调度，按实际允许链记账。
      this.runScoreStage(items.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec))
      const checked = rankTagRecFairSlice(preview.turns, items)
      draftState.commit(checked.turns, new Set(checked.items))
      turns.push(...checked.turns)
      delivered.push(...checked.items)
    }
    if (
      abortSignal.aborted ||
      this.isStale() ||
      sharedLadderState.epoch !== epoch ||
      policy !== computeTagRecFavFilterSignature()
    )
      return
    for (const [original, updated] of pending) Object.assign(original, updated)
    const held = sharedBufferQueue.filter((item) => pending.has(item))
    for (let i = sharedBufferQueue.length - 1; i >= 0; i--)
      if (consumed.has(sharedBufferQueue[i]) || pending.has(sharedBufferQueue[i])) sharedBufferQueue.splice(i, 1)
    sharedBufferQueue.push(...held)
    const remaining = new Set(sharedBufferQueue.flatMap((item) => (item.api === EApiType.TagRec ? [item.bvid] : [])))
    this.partitionHeld = new Set(
      [...this.partitionHeld, ...held.flatMap((item) => (item.api === EApiType.TagRec ? [item.bvid] : []))].filter(
        (bvid) => remaining.has(bvid),
      ),
    )
    tagRecFavSession.partitionPending = pending.size
    tagRecFavSession.partitionPaused = pending.size > 0 || (budget.exhausted && this.hasMore)
    if (tagRecFavSession.partitionPaused) this.partitionPausePolicy = policy
    sharedFairState.commit(turns, new Set(delivered))
    const tagStats = tagRecFavSession.filterStats
    for (const stats of strictStats) {
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
    this.qs.doReturnItems(delivered)
    const out = this.noteDelivered(delivered)
    if (!this.autoLoadPaused && delivered.some((item) => item.api === EApiType.TagRec)) this.prefetch(abortSignal)
    return out
  }

  /**
   * [tag-rec] 票 19 (tag-share): 「实际渲染」条数观测点 —— 回赞横幅「tab1 实际渲染 ≥20 条」
   *   计数源 = 本方法实际交付给 grid 的切片 (qs 队列切片经严格校验滤后; 分隔符不计)。
   *   懒载 ./share-like —— 回赞编排不进 service 静态图 (同 consumeTagRecShareDeepLink 手法)
   */
  private noteDelivered(items: RecItemTypeOrSeparator[] | undefined): RecItemTypeOrSeparator[] | undefined {
    sharedCandidates.delivered(items ?? [])
    const enrich = createTagRecAttributionEnricher(favorites.list, favoritesL1.list, themes.list)
    const deliveredGroups = new Set<string>()
    for (const item of items ?? []) {
      if (item.api !== EApiType.TagRec) continue
      const sources = enrich(item)
      // 归因字段每次交付重写 => 卡片数据按对象失效重算, 否则重交付的存货冻在旧徽标
      invalidateTagRecCardData(item)
      if (!sources.length) continue
      for (const g of sources) deliveredGroups.add(g.name)
    }
    if (deliveredGroups.size) tagRecFavSession.drawnGroupNames = [...deliveredGroups]
    void import('./share-like').then((m) => m.noteShareLikeDelivered(items)).catch(() => undefined)
    return items
  }

  /** 软见底标记 (票 09 横幅消费入口) */
  get softBottom() {
    return this.produceTracker.softBottom
  }

  override async fetchMore(abortSignal: AbortSignal): Promise<RecItemTypeOrSeparator[] | undefined> {
    this.lastFetchSignal = abortSignal // AUDIT-15: 手动深挖批生命周期随当前 fetch 闸
    // [tag-rec] 新轮开始清硬见底镜像+深挖待决态; 本轮真产出 0 由 exhaustRound 复置 (横幅判据, 票 09/票 13)
    tagRecFavSession.hardBottom = false
    tagRecFavSession.digPending = sharedUpSearch.pending && sharedUpSearch.hasAnyMore
    tagRecFavSession.noDrawableHint = undefined // [tag-rec] 配置性空轮提示随新轮清 (实机修复)
    // 1) 在缺库存的组中选择有限窗口：至多 K 个父组，每个父组可预取多个不同二级组。
    const k = clampTagRecK(settings.tagRec.k)
    // R7: 查看范围 (零写入视图筛) + 临时打开合流 (会话级) —— 全链只读, 不改任何 L1 enabled
    // 票 37/44: 签名变即原地重置共享态 (构造期已同步一轮, 此处兜实例存活期的被动漂移)
    // A4-1: 实例钉点随共享态重钉 —— pane 编辑/主题外操作等无 emit 漂移后 isStale 原永真
    //   (digMore/digRunning 清除等 stale 门控全楔死); 钉点跟上即自愈
    this.contextSignature = syncFavSharedState()
    syncFavFilterState() // 实修票①: 过滤签名变 => 去重记忆复位 (须在取源前, 本轮即生效)
    this.refilterSharedQueue()
    const drawableGroups = participatingGroups().filter((g) => this.hasAllowedSupply(g))
    const recallResolve = this.scopeResolver()
    const onlyUp = drawableGroups.length > 0 && drawableGroups.every((g) => !!upSearchMids(recallResolve, { id: g.id }))
    const stockCounts = this.supplyView()
    const needyGroups = drawableGroups.filter((g) => {
      if (!stockCounts.needs(tagRecGroupKey({ id: g.id }))) return false
      const up = this.hasUpSupply(g, recallResolve)
      return up !== false && (up === undefined || onlyUp || !sharedUpSearch.pending)
    })
    if (drawableGroups.length && !needyGroups.length) {
      if (onlyUp && !sharedBufferQueue.length) return this.exhaustRound('UP 投稿关键词搜索已到末尾')
      return []
    }
    // tag_ids 抽签产活判据: UP 路线 (片→UP 关键词) 或 tagTop 池开 => 抽签位有产;
    //   皆无 => tag 抽签纯占位 (plan 层照拦零请求) —— 剔出牌堆不占位;
    //   但 clique 深挖流是这类组 (如交集组) 的真产线 => dig 种子/UP 源/消费者仍并入供货面, 不饿死
    const sliceLive = (g: TagGroup) =>
      !!upSearchMids(recallResolve, { id: g.id }) || recallResolve({ id: g.id }, 'allV2').poolsEnabled.tagTop
    const digOnlyGroups = needyGroups.filter((g) => !sliceLive(g))
    // 预取资格还含库存低水位；不能复用仅描述查看范围的 contextSignature。
    const groups = this.deck.drawUnits(
      needyGroups.filter(sliceLive),
      effectiveL1s(),
      k,
      viewScope.viewedL1Ids(),
      undefined,
      Math.max(PREFETCH_GROUP_WINDOW, k),
    )
    if (abortSignal.aborted) return
    const supplyGroups = [...groups, ...digOnlyGroups]
    if (!supplyGroups.length) {
      // 无可抽单位 = 空表/查看范围外/一级组均未启用/麾下 L2 全部挂起停用 —— 配置性空轮
      // 不冒充「已到池底」(实机修复: 山田未启用却报池底误导); noDrawableHint 供横幅出「启用一级组」直达
      const viewedIds = viewScope.viewedL1Ids()
      const inRange = effectiveL1s().filter((l) => !viewedIds || viewedIds.has(l.id))
      const enableableL1Ids = inRange.filter((l) => !l.enabled).map((l) => l.id)
      // 适用来源全关为配置空态，不写成视频池耗尽。
      const poolsOn = !participatingGroups().length || participatingGroups().some((g) => this.hasAllowedSupply(g))
      const reason = !poolsOn
        ? '池筛选已关闭全部池 · 在「过滤」里开回至少一个池 (右键/设置里开的「仅看」也有同样风险)'
        : enableableL1Ids.length
          ? '当前查看范围内暂无可抽标签组 · 一级组未启用 (可启用或临时打开)'
          : inRange.length
            ? '当前查看范围内暂无可抽标签组 · 二级组未选中、停用、挂起或尚未添加标签'
            : '当前查看范围内无标签组 · 换主题或点「全选」恢复'
      tagRecFavSession.noDrawableHint = { reason, enableableL1Ids }
      this.hasMoreExceptQueue = false
      return [makeTagRecExhaustSeparator(reason)]
    }

    // 2~7) _pipeline 一轮: 抽中 L2 的 tag_ids 轮转取 ≤10 切片各拉 tag/top => 并集去重归一 => 三阶段 => 产出
    //      票 41: 干 tid 本轮跳过 —— 一轮内全源皆干 => 零请求空轮直走兜底梯队 (不构成见底, §4.4 同 tab2)
    // W1-5: 轮转游标推迟到轮落定才提交 —— 取源即提交时, 中止/风控空转轮整片让位 (ids 切片跳过未拉)
    // A1-5: 游标带 tag_ids 签名按组自失效 —— 死键 (已删组) 顺手清
    const aliveGids = new Set(favorites.list.map((g) => g.id))
    for (const k of this.tagCursors.keys()) if (!aliveGids.has(k)) this.tagCursors.delete(k)
    const pendingCursors: [string, number, number[], string][] = []
    // R7: 归因标签 (主题·L1) 解析表 —— 主路径组源条目在源头定型 (卡片标签 Q9)
    const l1ById = new Map(favoritesL1.list.map((l) => [l.id, l]))
    const themeById = new Map(themes.list.map((t) => [t.id, t]))
    const entriesByTid: TagRecRoundSource[] = groups.flatMap((g) => {
      const sig = g.tag_ids.map((e) => e.id).join(',')
      const ent = this.tagCursors.get(g.id)
      const { entries, nextCursor } = pickTagIdsForRound(g.tag_ids, ent && ent.sig === sig ? ent.cursor : 0)
      pendingCursors.push([g.id, nextCursor, entries.map((e) => e.id), sig])
      const label = tagRecAttributionLabelOfGroup(g, l1ById, themeById)
      return entries.map((e) => ({
        tid: e.id,
        keyword: e.name,
        groupNames: [g.name],
        groupIds: [g.id],
        pn: this.dryTids.pageOf(e.id), // 深翻页游标: 首页饱和后自动进页 (请求数不变)
        ...(label ? { attributionLabels: [label] } : {}),
      }))
    })
    // 同一标签跨组只请求一次，同时保留全部归因与过滤链。
    const byTid = new Map<number, TagRecRoundSource>()
    for (const source of entriesByTid) {
      const old = byTid.get(source.tid)
      if (!old) byTid.set(source.tid, source)
      else {
        old.groupIds = [...new Set([...(old.groupIds ?? []), ...(source.groupIds ?? [])])]
        old.groupNames = [...new Set([...old.groupNames, ...source.groupNames])]
        old.attributionLabels = [...new Set([...(old.attributionLabels ?? []), ...(source.attributionLabels ?? [])])]
      }
    }
    const sources = entriesByTid
    const recallPlan = planTagRecRecall(
      {
        roundSources: sources,
        digSources: deriveGroupCliques(
          supplyGroups.map((g) => ({ ...g, extra: tagRecSearchExtraOf(recallResolve({ id: g.id }, 'allV2')) })),
          Infinity,
        ),
        scopeConsumers: supplyGroups.map((group) => ({ key: { id: group.id }, name: group.name })),
      },
      recallResolve,
    )
    const fullUpSources = this.recheckPlan().up
    sharedUpSearch.sync(fullUpSources)
    // 一次 UP 页只服务供货组；物理共词仍保留其他合法消费者，不截掉后十词。
    const selectedIds = new Set(supplyGroups.map((g) => g.id))
    recallPlan.up = fullUpSources.filter((source) => source.groupIds?.some((id) => selectedIds.has(id)))
    const normalIds = new Set(recallPlan.dig.flatMap((s) => s.groupIds ?? []))
    const normalGroups = supplyGroups.filter((g) => normalIds.has(g.id))
    const epoch = sharedLadderState.epoch
    const policy = computeTagRecFavSourceSignature() + computeTagRecFavFilterSignature(true)
    const isCurrent = () =>
      sharedLadderState.epoch === epoch &&
      policy === computeTagRecFavSourceSignature() + computeTagRecFavFilterSignature(true) &&
      !this.isStale()
    // 按供货组的生效链预热负向浅池 (含 L1 上溯); cfg.enabled 已停的链过滤时不消费池, 不预热。
    const negTids = supplyGroups.flatMap((g) => {
      const eff = recallResolve({ id: g.id }, 'tagTop')
      return eff.cfg.enabled ? eff.neg.tagIds.map((e) => e.v.id) : []
    })
    // 自定义标签名单只复用已有浅池; 选入整主题也不按名单追加 tag/top 请求。
    if (negTids.length) await ensureTagRecNegativePools(negTids, abortSignal)
    if (abortSignal.aborted) return
    const round = await runTagRecRecallRound({
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
      stages: this.stages, // [tag-rec]
    }).catch((e) => {
      // 票 16 ③: 池拉取被风控 => 本轮空转 (hasMore 保持 true, 退避后滚动自动重试)
      if (isRiskControlError(e)) return undefined
      throw e
    })
    if (abortSignal.aborted || this.isStale() || sharedLadderState.epoch !== epoch) return
    if (!round) return
    for (const g of groups) sharedSuppliedGroups.add(g.id)
    this.dryTids.note(round.sourceStats) // 票 41 逐源记账: 空响应即干 / 零新增连击标干 (按 tid 不按轮次, 抽中才记)
    // W1-5+A1-4: 轮转游标按「本源全成」逐组提交 —— 失败源所在组切片不推进 (下轮重拉不跳片);
    //   abort 轮在上方早退不提交 (整片让位作废)
    const failedTids = new Set(round.sourceStats.filter((s) => !s.ok).map((s) => s.tid))
    for (const [id, c, tids, sig] of pendingCursors)
      if (
        tids.some(
          (t) =>
            round.sourceStats.some((s) => s.tid === t && s.ok) &&
            recallPlan.tagTop.some((source) => source.tid === t && source.groupIds?.includes(id)),
        ) &&
        !tids.some((t) => failedTids.has(t))
      )
        this.tagCursors.set(id, { cursor: c, sig })
    // A3-1: 零产出且存在失败源 => 未决轮 —— 不进梯队/不判见底, 保 hasMore 滚动重试
    //   (风控/网络瞬态被 allSettled 收成 ok=false; 原实现误当干轮 → 假 manual-pending/硬见底)
    // R09: 未决轮有界重试 —— 持续失败时 fetchMinCount 按 hasMore 无限连发; 超预算抛可重试错误截停
    if (!round.items.length && failedTids.size) {
      if (this.ladder.poolItems.length < TAG_REC_SEED_POOL_MAX) this.ladder.poolItems.push(...round.poolItems)
      if (this.failedSourceRounds < TAG_REC_SOURCE_FAILURE_MAX_RETRIES) {
        this.failedSourceRounds += 1
        return
      }
      this.failedSourceRounds = 0 // 以错误收尾本轮; 下次刷新/重试重新获得完整预算
      throw new TagRecSourceFailureError()
    }
    this.failedSourceRounds = 0

    // 深翻页未完 (本轮零产出但未干源仍有页可翻) => 非见底: 保 hasMore 让下一轮自动进页
    if (!round.items.length && this.hasTagTopPagesLeft(recallPlan.tagTop)) return []

    if (recallPlan.up.length && sharedUpSearch.pending && sharedUpSearch.hasAnyMore) tagRecFavSession.digPending = true
    if (onlyUp) {
      const more = drawableGroups.some((g) => this.hasUpSupply(g, recallResolve))
      if (!round.items.length) {
        if (more && !sharedUpSearch.pending) return []
        if (more) {
          tagRecFavSession.digPending = true
          return this.exhaustRound()
        }
        return this.exhaustRound('UP 投稿关键词搜索已到末尾')
      }
      if (!more || sharedUpSearch.pending) {
        this.hasMoreExceptQueue = false
        tagRecFavSession.digPending = more
      }
      return round.items
    }
    if (!round.hasTagTop && !round.items.length && !recallPlan.dig.length && !recallPlan.archiveConsumers.length)
      return []

    // 先扫到其他可供给组/标签，再允许把整个范围判作干涸；现存库存不押在深挖后交付。
    if (
      !round.items.length &&
      ((!this.needsSupply() && sharedBufferQueue.length) ||
        needyGroups.some((g) => {
          const up = this.hasUpSupply(g, recallResolve)
          return up === undefined
            ? recallResolve({ id: g.id }, 'tagTop').poolsEnabled.tagTop &&
                (!sharedSuppliedGroups.has(g.id) || g.tag_ids.some((t) => !this.dryTids.isDry(t.id)))
            : up && !sharedUpSearch.pending
        }))
    )
      return []

    // 8) 兜底梯队 (票 13 D1 + 票 17 策略分家, 激进档同 tab2): 产出 <triggerYield 即介入 —
    //    干轮 => related 选种 => 堆按分放行一页 => 自适应自动深挖 => 手动待决 => 硬见底;
    //    浅水位 (产出 1~triggerYield-1) => 同轮顺手一发 digPass('auto') 预挖 (不选种/不放堆);
    //    组级欠产同闸: 任一可供给组归属库存见底也介入 (交集组 tag/top 条目无标签证据,
    //    真产线只有深挖流 —— 混选时别组高产不该饿死它, 实机原神∩cos 与别组同选零产出)
    let items = round.items
    let produce = items.length
    if (items.length < this.ladder.effTriggerYield() || this.hasStarvedGroup(items)) {
      if (items.length) {
        // 浅水位预挖 (同 tab2 票 17): 深挖产出落 bufferQueue 下轮直放, 不挤占本轮切片;
        // AUDIT-17: 后台化 (对齐 tab2 票 perf-06) —— items 已在手不押整档 digPass 落定才返回;
        //   fav 无 phase2 session 镜像, catch 即收尾 (无 finally 同步需求)
        void this.ladder
          .preDig({
            signal: abortSignal,
            prepareStreams: () => this.ladder.ensureCliqueStreams(normalGroups),
          })
          .catch(() => 0)
        if (abortSignal.aborted) return
      } else {
        if (this.ladder.poolItems.length < TAG_REC_SEED_POOL_MAX) this.ladder.poolItems.push(...round.poolItems)
        const r = await this.ladder.runLadder({
          signal: abortSignal,
          // D7/D8 饿谁喂谁: 本轮抽中组的成员规范名 => 同义词簇深挖流 (干轮才补)
          prepareStreams: () => this.ladder.ensureCliqueStreams(normalGroups),
        })
        if (abortSignal.aborted || r.kind === 'aborted') return
        switch (r.kind) {
          case 'items': {
            items = r.items
            // A3-9: 队列货计数只认条目 —— separator 混入会虚 +1 扰动软见底/热池判据
            produce = r.items.length || this.qs.bufferQueue.filter((x) => x.api === EApiType.TagRec).length // 在途深挖刚落的货也记产出

            break
          }
          case 'manual-pending': {
            // 自动深挖用尽但深挖流未尽 => 停自动加载待手动「继续深挖」(非硬见底, 横幅待决态)
            tagRecFavSession.digPending = true
            return this.exhaustRound()
          }
          case 'source-unavailable':
          case 'retry-later': {
            tagRecFavSession.noDrawableHint = { reason: r.reason, enableableL1Ids: [] }
            this.hasMoreExceptQueue = false
            return [makeTagRecExhaustSeparator(r.reason)]
          }
          default: {
            if (sharedUpSearch.hasAnyMore) {
              if (sharedUpSearch.pending) {
                tagRecFavSession.digPending = true
                return this.exhaustRound()
              }
              return []
            }
            return this.exhaustRound('主题推荐已到池底 · 暂无更多新内容')
          }
        }
      }
    }

    // 9) 产出计数 (含兜底产出) => 软见底标记 (镜像 session 供横幅订阅)
    //    实修票③: 同步记入选种「热池」判据 producedTotal (主池+兜底全源累计)
    trackTagRecRoundProduce(this.produceTracker, produce)
    this.ladder.noteProduce(produce)
    tagRecFavSession.softBottom = this.produceTracker.softBottom
    return items
  }

  /** UI「继续深挖」(横幅待决态动作): 全部未 exhausted 深挖流各 +3 页, 落货重挂自动加载; resolve = 本次/在途挖完 */
  digMore(): Promise<unknown> {
    // AUDIT-15/16: 弃实例整发拒挖 —— 无 lastFetchSignal 的裸批会越过 abort 闸往共享盒落旧境货
    if (this.isStale()) return Promise.resolve()
    if (sharedUpSearch.pending && sharedUpSearch.hasAnyMore) {
      sharedUpSearch.continue()
      this.hasMoreExceptQueue = true
      tagRecFavSession.digPending = false
      tagRecFavSession.hardBottom = false
      return Promise.resolve()
    }
    // AUDIT-15 对齐 tab2: 退避期手动 dig 拒发 —— 深挖成功率本就低, 烧的是退避时隙 (请求纪律不放宽)
    if (tagRecBackoff.isEngaged) {
      toast('退避中,恢复后再挖')
      return Promise.resolve()
    }
    if (this.digRunning) return tagRecRecallScheduler.withForegroundSupply(() => this.digRunning!)
    if (this.ladder.digRunning) return tagRecRecallScheduler.withForegroundSupply(() => this.ladder.digRunning!)
    tagRecFavSession.digRunning = true // 待决态保持, 按钮 loading 防重点
    this.digRunning = tagRecRecallScheduler
      .withForegroundSupply(() => this.ladder.digPass('manual', this.lastFetchSignal))
      .catch((e) => (appWarn('[tag-rec] fav dig failed: %o', e), 0))
      .finally(() => {
        this.digRunning = undefined
        // A4-5: digRunning 镜像清零移出 stale 门 (弃实例不摘 => banner 按钮永 loading 无兜底);
        //   但需共享盒在途闸 —— 新语境 service 正在挖时旧实例抢摘会让在途挖的 loading 提前熄灭
        if (!this.ladder.digRunning) tagRecFavSession.digRunning = false
        // AUDIT-16: 弃实例不写共享 session (新语境镜像由其 service 自管; 原 finally 完全无门)
        if (this.isStale()) return
        if (this.ladder.lastDigYield > 0) {
          // 手动深挖落货 => 重挂自动加载 + 解除待决 (UI 挖完 emit 'load-more' 再武装 grid hasMore)
          this.hasMoreExceptQueue = true
          tagRecFavSession.digPending = false
        } else if (this.ladder.hasDueStreams()) {
          tagRecFavSession.digPending = true // 挖了没出货, 流未尽 => 待决回显
        } else {
          // 手动挖穿流尽 => 硬见底 (横幅三动作收尾)
          tagRecFavSession.digPending = false
          tagRecFavSession.hardBottom = true
        }
      })
    return this.digRunning
  }

  /**
   * UI「重新发掘」(硬见底出口): 复位本查询全部深挖流游标 (含持久沉淀的 exhausted/冷却) 并立即重挖一轮。
   * 请求有界 = 一次 digPass 的既有窗口 (≤4 流 ×3 页) + 退避/限流纪律; 退避期不点火。
   */
  redigQuery(): Promise<unknown> {
    if (this.isStale()) return Promise.resolve()
    this.ladder.resetDigCursors()
    this.hasMoreExceptQueue = true
    tagRecFavSession.hardBottom = false
    tagRecFavSession.digPending = false
    return this.digMore()
  }

  /** 构造期资格表为空 = 未初始化钉点 (收藏表水合晚于建实例合法); 此后漂移不作 stale */
  private readonly pinnedEmpty: boolean

  /**
   * 过期判定 (AUDIT-16): 本实例资格指纹签名 vs 当前签名漂移即 stale ——
   *   主题切换/资格集变后的弃实例收尾不写共享 session (digRunning/digPending/hardBottom 镜像)。
   *   空表钉点的实例跨过水合期不算 stale —— 指纹里无 '' 哨兵 (theme=:::: 也是有效串),
   *   靠构造期 pinnedEmpty 快照判「未初始化」
   */
  private isStale() {
    if (this.pinnedEmpty) return false
    return this.contextSignature !== computeTagRecFavContextSignature()
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

  /**
   * 硬见底/停轮 (spec §4.4): content 给了 => [separator] + hardBottom 镜像;
   * 无 content = 深挖待决停轮 (票 13 manual-pending: hasMoreExceptQueue=false 截停自动加载, 不算见底)
   */
  private exhaustRound(content?: string): ItemsSeparator[] {
    this.hasMoreExceptQueue = false
    if (!content) return []
    tagRecFavSession.hardBottom = true // [tag-rec] 硬见底镜像 => 横幅三按钮态 (票 09)
    return [makeTagRecExhaustSeparator(content)]
  }
}
