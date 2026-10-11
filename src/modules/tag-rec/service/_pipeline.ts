import { appWarn } from '$common'
import { EApiType } from '$enums'
import { perfMark } from '$utility/perf-mark' // [tag-rec] perf 票 06
import { isPersistedDryTid, persistDryTid } from '../api/dry-tids-store'
import { fetchTagTop } from '../api/endpoints'
import { normalizeTagTopItem } from '../model/normalize-item'
import { mergeTagRecCandidate } from '../model/relevance'
import { compareTagRecItems } from './item-order'
import type { ReactNode } from 'react'
import type { ItemsSeparator, TagRecItemExtend } from '$define'
import type { TagRecScopeResolve } from '../model/filter-engine'
import type { TagRecConsumer } from './recall-plan'

/**
 * [tag-rec] 共享轮次管线 (spec §4.3) —— 两 tab 共用主干
 * 一轮输入 = 本轮查询单元 (tab1: 牌组抽中的 K 个组; tab2: 锚点+变体+扩选 id 集合)
 *   选组(各 tab 自决) => 组内全部 tag_id 各拉 tag/top (anonGetJson 内 tagRecLimit 并发4, 组内不截断 ps=100)
 *   => 池并集 => bvid 去重 (跨轮 service 级 seenBvids; 同轮多源命中合并 groupNames 归因)
 *   => normalize-item 归一 => 过滤阶段 => 算分阶段(排序) => 去已看阶段 => 产出数组 + 产出计数
 *
 * 三个阶段的注入点 (stages): 票 06 过滤/算分、票 08 去已看 只换实现不动骨架。
 * `applyTagRecStages` 单独导出: Phase 2 异步入池 / 兜底梯队等旁路产出走同一套阶段。
 */

// #region 阶段签名与注入点 (票 06/08 实装处)
export type TagRecRoundCtx = {
  /** 本轮各源原始拉取总条数 (诊断参考) */
  fetchedCount: number
  /** 小池降级分母覆盖 (票06: 兜底堆放行页注入堆深, 防切片伪影);
   *  AUDIT-A2-1: 缺省 = 轮内去重后进入过滤的有效条数 (spec §3.3「池有效条数」),
   *  不再是 fetchedCount —— 原始拉取量含已见/同轮重复, 会高估池深让浅池不降级 */
  poolSize?: number
  poolItems?: readonly TagRecItemExtend[]
  /** 旁路批 (深挖/放行) 滤除账并入 session 而非整覆 (实修: 小批覆盖清主轮账+错钉 degraded) */
  mergeStats?: boolean
  /**
   * 复用设计 1: 同一次处理共用的生效链求解器 —— 首个用它的 stage 负责 `??=`
   * 就地回填, 同 pass 后续 stage 零成本复用 (ctx 每轮新建, 泄漏不出本 pass)
   */
  resolve?: TagRecScopeResolve
  signal?: AbortSignal
}

export type TagRecRoundStage = (items: TagRecItemExtend[], ctx: TagRecRoundCtx) => TagRecItemExtend[]

export type TagRecRoundStages = {
  /** 过滤管线 (含黑名单维度, 产出分维度滤除计数) —— 直通占位, 实装归票 06 */
  filterStage?: TagRecRoundStage
  /** 算分 + 排序：相关性证据优先，质量只在同层比较。 */
  scoreStage?: TagRecRoundStage
  /** 去已看 (seen-set / bypassSeen) —— 直通占位, 实装归票 08 */
  seenStage?: TagRecRoundStage
}

/** 直通占位: 过滤/去已看 默认实现 */
export const tagRecStagePassthrough: TagRecRoundStage = (items) => items

/** 相关性证据、质量、源序；尚未标注相关性时退化到质量与源序。 */
export { compareTagRecItems } from './item-order'

/** 默认算分阶段: 未算分时按 srcRank 源序排 (组间按 rank 交错, 跨池公平; 票 06 换 score 实装) */
export const defaultTagRecScoreStage: TagRecRoundStage = (items) => [...items].sort(compareTagRecItems)

/** 依次应用 过滤 => 算分 => 去已看 三阶段 (缺省直通/默认排序) */
export function applyTagRecStages(
  items: TagRecItemExtend[],
  ctx: TagRecRoundCtx,
  stages?: TagRecRoundStages,
): TagRecItemExtend[] {
  let out = (stages?.filterStage ?? tagRecStagePassthrough)(items, ctx)
  out = (stages?.scoreStage ?? defaultTagRecScoreStage)(out, ctx)
  out = (stages?.seenStage ?? tagRecStagePassthrough)(out, ctx)
  return out
}
// #endregion

// #region 轮次主流程
export type TagRecRoundSource = {
  input?: boolean
  consumers?: TagRecConsumer[]
  tid: number // 拉取单元 tag_id
  keyword?: string // 标签规范名，用于有 UID 的「仅看 UP」定向投稿搜索
  groupNames: string[] // 该源命中 item 记入 source.groupNames 的归因名 (tab1=组名 / tab2=tag 名)
  /** A1-3: 归因组 id (与 groupNames 平行同序, 稳定键) —— 过滤求解按 id 优先, 名碰撞不再错账 */
  groupIds?: string[]
  /** R7: 卡片归因标签 (主题·L1, model/attribution 产物; tab1 主路径填) */
  attributionLabels?: string[]
  /**
   * tag/top 深翻页游标 (缺省 1): 实测 pn=1 不重采样、池深 ~200-300 (pn=3 空体),
   * 每标签只吃首页 = 一半池子不可达 —— 当前页零新增连击即进页, 见 TagRecTidDryTracker.note
   */
  pn?: number
}

export type TagRecRoundResult = {
  items: TagRecItemExtend[]
  /** 本轮产出条数 (= items.length) —— 软见底判定输入 (spec §4.4) */
  producedCount: number
  /** 本轮原始拉取总条数 (小池降级/诊断参考) */
  fetchedCount: number
  /** 本轮池归一化条目 (阶段前; 票 13 选种原料池: stat 完整, ownTagNames 无 —— 走 fetchVideoTagNames) */
  poolItems: TagRecItemExtend[]
  /** 逐源拉取账 (票 32 逐源干态记忆原料; 轮中止 => 空数组不计账) */
  sourceStats: TagRecRoundSourceStat[]
}

/**
 * 逐源拉取账: fetched = tag/top 原始响应条数; contributed = 并集去重后本源新贡献条数
 * (同轮多源同 bvid 只计首个认领源); ok=false = 请求被拒 (网络/风控 —— 非「响应空」不判干)
 * pn = 本源实际请求的 tag/top 页 (深翻页游标; 缺省 1)
 */
export type TagRecRoundSourceStat = { tid: number; fetched: number; contributed: number; ok: boolean; pn?: number }

/**
 * 一轮: 查询单元全部 tag_id 各拉 tag/top => 并集去重归一 => 三阶段 => 产出
 * - Promise.allSettled: 单 id 失败 (网络/风控) 不拖死整轮, 该源按空池处理
 * - 同 BV 合并召回记录与归因；跨轮重复可更新库存证据或恢复未交付候选。
 * - 拉取先记源去重；服务保留未交付原料，条件变更后可以本地重评。
 */
export type TagRecRoundOptions = {
  sources: readonly TagRecRoundSource[]
  /** service 级跨轮 bvid 去重集合 (每 service 实例一份) */
  seenBvids: Set<string>
  signal?: AbortSignal
  stages?: TagRecRoundStages
  mergeExisting?: (item: TagRecItemExtend) => TagRecItemExtend | undefined
  /**
   * 该 BV 是否仍挂未交付态 (队列/兜底堆/候选表任一处) —— mergeExisting 的廉价前置:
   *   已见且三处皆不在 => 归一/归因构造/合并查找全省 (长会话里多数到达物走此分支);
   *   缺省 => 逐条走 mergeExisting 老路 (保守路径, 不跳归一)
   */
  hasPending?: (bvid: string) => boolean
  isCurrent?: () => boolean
  /** Composite recalls commit IDs only after all asynchronous legs and stages finish. */
  commitSeen?: boolean
}

export type TagRecRoundFetch = PromiseSettledResult<Awaited<ReturnType<typeof fetchTagTop>>>[]

export const emptyTagRecRoundResult = (): TagRecRoundResult => ({
  items: [],
  producedCount: 0,
  fetchedCount: 0,
  poolItems: [],
  sourceStats: [],
})

/** Fetch without touching service inventory: a later asynchronous leg may still be cancelled. */
export function fetchTagRecRoundSources(
  sources: readonly TagRecRoundSource[],
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<TagRecRoundFetch> {
  if (signal?.aborted || isCurrent?.() === false) return Promise.resolve([])
  perfMark('tagrec-tagtop-fetch', { n: sources.length })
  return Promise.allSettled(sources.map((s) => fetchTagTop(s.tid, { pn: s.pn ?? 1, signal })))
}

export async function runTagRecRound(opts: TagRecRoundOptions): Promise<TagRecRoundResult> {
  const settled = await fetchTagRecRoundSources(opts.sources, opts.signal, opts.isCurrent)
  return finishTagRecRound(opts, settled)
}

/** Synchronous merge/commit after the caller has checked the complete round's lifetime. */
export function finishTagRecRound(
  { sources, seenBvids, signal, stages, mergeExisting, hasPending, isCurrent, commitSeen = true }: TagRecRoundOptions,
  settled: TagRecRoundFetch,
): TagRecRoundResult {
  if (signal?.aborted || isCurrent?.() === false) return emptyTagRecRoundResult()

  const byBvid = new Map<string, TagRecItemExtend>()
  const sourceStats: TagRecRoundSourceStat[] = sources.map((s) => ({
    tid: s.tid,
    pn: s.pn ?? 1,
    fetched: 0,
    contributed: 0,
    ok: true,
  }))
  let fetchedCount = 0
  settled.forEach((res, i) => {
    const { tid, groupNames, groupIds, attributionLabels } = sources[i]
    const stat = sourceStats[i]
    if (res.status === 'rejected') {
      stat.ok = false
      appWarn('[tag-rec] round fetch tag/top?tid=%s failed: %o', tid, res.reason)
      return
    }
    stat.fetched = res.value.length
    res.value.forEach((it, srcRank) => {
      fetchedCount++
      const bvid = it.bvid
      if (!bvid) return
      // [tag-rec] perf: 已见且无处可合并 => 连归一都省 —— mergeExisting 注定 undefined,
      //   省下 normalize + claims 归因构造 (长会话大头: 到达物多已交付出清)
      if (!byBvid.has(bvid) && seenBvids.has(bvid) && hasPending && !hasPending(bvid)) return
      const normalized = normalizeTagTopItem(it, {
        groupNames: groupNames.filter(Boolean),
        groupIds: groupIds?.filter(Boolean),
        attributionLabels: attributionLabels?.filter(Boolean),
        srcRank,
      })
      normalized.source.tagIds = [tid]
      normalized.source.queryKeyword = sources[i].keyword
      normalized.source.input = sources[i].input
      normalized.source.claims = sources[i].consumers?.map((c) => ({
        via: 'tag-top',
        tagIds: [tid],
        queryKeyword: c.queryKeyword ?? sources[i].keyword,
        input: c.input,
        groupIds: typeof c.key === 'object' && c.key?.id ? [c.key.id] : undefined,
        groupNames: c.name ? [c.name] : [],
      }))
      const exist = byBvid.get(bvid)
      if (exist) {
        mergeTagRecCandidate(exist, normalized)
        if (attributionLabels)
          for (const lb of attributionLabels) {
            if (!lb) continue
            exist.source.attributionLabels ??= []
            if (!exist.source.attributionLabels.includes(lb)) exist.source.attributionLabels.push(lb)
          }
        return
      }
      if (seenBvids.has(bvid)) {
        const updated = mergeExisting?.(normalized)
        if (updated) byBvid.set(bvid, updated)
        return
      }
      stat.contributed++
      byBvid.set(bvid, normalized)
    })
  })

  // [tag-rec] perf 票 06: tag/top 齐回+并集去重归一完成点 (三阶段/兜底在本点之后; 段差=拉取+归一)
  perfMark('tagrec-tagtop-fetched', {
    n: sources.length,
    fetched: fetchedCount,
    pool: byBvid.size,
    failed: sourceStats.filter((s) => !s.ok).length,
  })

  // AUDIT-A2-1: 主轮降级分母 = 去重后池有效条数 (fetchedCount 仅诊断; spec §3.3 小池口径)
  const poolItems = [...byBvid.values()]
  const ctx: TagRecRoundCtx = { fetchedCount, poolSize: byBvid.size, poolItems, signal }
  const items = applyTagRecStages(poolItems, ctx, stages)
  if (signal?.aborted || isCurrent?.() === false) return emptyTagRecRoundResult()
  if (commitSeen) for (const item of poolItems) seenBvids.add(item.bvid)
  return { items, producedCount: items.length, fetchedCount, poolItems, sourceStats }
}
// #endregion

// #region 票 32 逐源干态记忆 (tab2 冷池: tag/top 常年空转的 tid 不再重打)
/**
 * 逐 tid 干态, 挂 service 旁模块级共享 (service 重建存活; 签名变 clear 全清):
 *   - tag/top 响应空 => 该 tid 立即标干;
 *   - 响应非空但零新增 (全部已见/同轮重复, producedCount 贡献=0) => 连击累计, 连续
 *     TAG_REC_TID_DRY_STREAK 轮标干;
 *   - 请求被拒 (ok=false) 不动干态 —— 网络抖动/风控不判干也不清连击;
 *   - 复位不在这里: 成员签名 (选定组 tag_ids ∪ expandedIds 归一集) 变 => service 侧 clear() 全清。
 * 一轮内全源皆干 => 完全跳过 tag/top 直走兜底梯队 (不构成见底, §4.4); 部分干只拉未干 tid。
 *
 * 深翻页 (pn 游标, 实测修正): tag/top 池深 ~200-300 条/标签, 而 pn=1 不重采样 (同一页反复请求
 *   返回同一批) —— 原「零新增连击 => 标干」把一半以上的池子永久关在门外 (单标签查询 2 轮即饿死)。
 *   修正: 当前页零新增连击达阈值 => **进下一页** (pn+1, 上限 TAG_REC_TAG_TOP_PAGE_CAP);
 *   只有「pn=1 空响应」(源真空, 落持久图) 或「深页空体/到顶」(池底, 仅会话级) 才标干。
 *   请求成本不变 —— 原本每轮也在重复打 pn=1, 现在同一发请求打深一页。
 *
 * 票 39 持久化 (persistEmpty 开时): `empty` 标干顺手落 GM `tag-rec:dry-tids` (TTL 兜底复活)
 * —— 响应空是源的属性跨会话可复用; `zeroNewStreak` 连击相对本会话 seenBvids 判定,
 * F5 后语义不成立 => 维持会话级不落盘。深页空体 (池底) 同样不落盘: 该 tid 有内容,
 * 只是本会话已翻到底, 落盘会连 pn=1 一起误杀。isDry 读侧 = 内存图 ∪ 持久图并集;
 * clear() 只清内存图 (持久图保留) —— 翻页游标随 clear 归零 (新语境重新从首页吃)。
 */

/** 零新增连击标干轮数 (= 进页阈值) */
export const TAG_REC_TID_DRY_STREAK = 2
/** tag/top 深翻页上限: 实测池深 ~200-300 (pn=3 返回空体), 3 页覆盖; 空页即止不空转 */
export const TAG_REC_TAG_TOP_PAGE_CAP = 3

/** 试验切换暂存: 干态图 + 深翻页游标的值拷贝 (restore 覆盖式回填) */
export type TagRecTidDrySnapshot = {
  map: Map<number, { empty: boolean; emptyAt?: number; zeroNewStreak: number }>
  pages: Map<number, number>
}

export class TagRecTidDryTracker {
  /**
   * @param opts 构造选项
   * @param opts.persistEmpty 票 39 empty 标干落 GM + isDry 读侧并持久图;
   *   tab2 sharedDryTids 开; tab1 会话级 (票 41 裁: 持久化另议)
   */
  constructor(private readonly opts: { persistEmpty?: boolean } = {}) {}

  private map = new Map<number, { empty: boolean; emptyAt?: number; zeroNewStreak: number }>()
  /** tag/top 深翻页游标: tid => 下一页 (1 起; 当前页饱和即进页, 到顶/空页标干) */
  private pages = new Map<number, number>()

  /** 本轮该 tid 应请求的 tag/top 页 (1 起, 钳制到深翻上限) */
  pageOf(tid: number): number {
    return Math.min(this.pages.get(tid) ?? 1, TAG_REC_TAG_TOP_PAGE_CAP)
  }

  /** 本轮是否跳过该 tid 的 tag/top: 内存干态 ∪ 持久图 (persistEmpty 开时) */
  isDry(tid: number): boolean {
    const d = this.map.get(tid)
    if (d?.empty && Date.now() - (d.emptyAt ?? 0) >= 60 * 60 * 1000) {
      this.map.delete(tid)
      this.pages.delete(tid) // An expired empty pool is probed from its first page, not an old bottom.
    } else if (!!d && (d.empty || d.zeroNewStreak >= TAG_REC_TID_DRY_STREAK)) return true
    return !!this.opts.persistEmpty && isPersistedDryTid(tid)
  }

  /** 一轮逐源账记账: 只对本轮实际拉过的源记账 (被跳过/未抽中轮转的 tid 原样保留) */
  note(stats: readonly TagRecRoundSourceStat[]) {
    for (const s of stats) {
      if (!s.ok) continue
      const prev = this.map.get(s.tid)
      const pn = s.pn ?? 1
      if (!s.fetched) {
        // 空响应: pn=1 = 源真空 (跨会话可复用, 落持久图); 深页空体 = 池底 (仅本会话, 不落盘)
        this.map.set(s.tid, { empty: true, emptyAt: Date.now(), zeroNewStreak: 0 })
        if (pn === 1 && this.opts.persistEmpty) void persistDryTid(s.tid) // 票 39: empty=源属性落盘 (TTL 复活)
      } else if (!s.contributed) {
        const zeroNewStreak = (prev?.zeroNewStreak ?? 0) + 1
        if (zeroNewStreak >= TAG_REC_TID_DRY_STREAK && pn < TAG_REC_TAG_TOP_PAGE_CAP) {
          // 当前页饱和: 不标干 —— 进下一页 (实测深页才有新内容, 请求数不变)
          this.pages.set(s.tid, pn + 1)
          this.map.set(s.tid, { empty: false, zeroNewStreak: 0 })
        } else {
          this.map.set(s.tid, { empty: false, zeroNewStreak }) // 零新增连击
        }
      } else if (prev) {
        this.map.set(s.tid, { empty: false, zeroNewStreak: 0 }) // 有新货 => 连击清零
      }
    }
  }

  /** 签名变 => 全清内存干态与翻页游标 (新语境重新从首页吃); 票 39 裁: 持久图保留 */
  clear() {
    this.map.clear()
    this.pages.clear()
  }

  /** 试验切换暂存: 值拷贝 (两图独立, 与活图不共享条目对象) */
  snapshot(): TagRecTidDrySnapshot {
    return {
      map: new Map([...this.map].map(([k, v]) => [k, { ...v }])),
      pages: new Map(this.pages),
    }
  }

  restore(snap: TagRecTidDrySnapshot) {
    this.map = new Map([...snap.map].map(([k, v]) => [k, { ...v }]))
    this.pages = new Map(snap.pages)
  }
  revive(tids: Iterable<number>) {
    for (const tid of tids) if (!this.map.get(tid)?.empty) this.map.delete(tid)
  }

  get size() {
    return this.map.size
  }
}
// #endregion

// #region 见底判定 (spec §4.4)
/** 软见底: 连续 SOFT_BOTTOM_STREAK 轮产出 < SOFT_BOTTOM_MIN_PRODUCE (横幅预警不阻断) */
export const TAG_REC_SOFT_BOTTOM_MIN_PRODUCE = 5
export const TAG_REC_SOFT_BOTTOM_STREAK = 2

export type TagRecProduceTracker = {
  /** 连续低产出轮数 */
  lowStreak: number
  /** 软见底标记 (票 09 横幅消费; 镜像到 session store 供 UI 订阅) */
  softBottom: boolean
}

export function createTagRecProduceTracker(): TagRecProduceTracker {
  return { lowStreak: 0, softBottom: false }
}

/** 每轮产出计数 => 软见底判定 (产出达标清零连续计数) */
export function trackTagRecRoundProduce(tracker: TagRecProduceTracker, producedCount: number): TagRecProduceTracker {
  tracker.lowStreak = producedCount < TAG_REC_SOFT_BOTTOM_MIN_PRODUCE ? tracker.lowStreak + 1 : 0
  tracker.softBottom = tracker.lowStreak >= TAG_REC_SOFT_BOTTOM_STREAK
  return tracker
}

let exhaustSeparatorSeq = 0
/**
 * 硬见底 separator (spec §4.4): 单轮产出 0 => 该轮返回 [separator] + hasMoreExceptQueue=false,
 * 队列排空后 hasMore=false 截停 fetchMinCount 连发; 尾部横幅三动作按钮归票 09
 */
export function makeTagRecExhaustSeparator(content: ReactNode): ItemsSeparator {
  return {
    api: EApiType.Separator,
    uniqId: `${EApiType.TagRec}:separator:exhaust:${++exhaustSeparatorSeq}`,
    content,
  }
}
// #endregion

// #region 源失败有界重试 (R09: 持续失败不得无限连发)
/**
 * R09 (tag-rec 全面审查): 未决轮 = 零产出且存在失败源 —— 保 hasMore 滚动重试的语义保留,
 * 但 fetchMinCount 只认「条数/hasMore/abort」, 持续失败时单次刷新会无限连发。
 * 单次刷新内连续未决轮预算 (1 首发 + 2 重试), 超限抛 TagRecSourceFailureError 截停:
 * grid refreshError / loadMoreError 均带重试入口; 与空语境退避修复同款有界纪律。
 */
export const TAG_REC_SOURCE_FAILURE_MAX_RETRIES = 2

/** 源请求持续失败的可重试错误出口 (message 上屏: loadMore 通知 / ErrorDetail 详情) */
export class TagRecSourceFailureError extends Error {
  constructor() {
    super('[tag-rec] 标签源请求持续失败 (网络/风控), 请稍后重试')
    this.name = 'TagRecSourceFailureError'
  }
}
// #endregion

// #region tagRec.k 收口 (spec §3.3: 每轮抽样组数, 可调 1~10, 默认 3)
export const TAG_REC_K_MIN = 1
export const TAG_REC_K_MAX = 10
export const TAG_REC_K_DEFAULT = 3

export function clampTagRecK(k: number): number {
  if (!Number.isFinite(k)) return TAG_REC_K_DEFAULT
  return Math.min(TAG_REC_K_MAX, Math.max(TAG_REC_K_MIN, Math.round(k)))
}
// #endregion
