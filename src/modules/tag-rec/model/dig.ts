import {
  tagRecCombinationSeeds,
  tagRecConditionAtoms,
  tagRecSearchBranches,
  type TagRecCombination,
  type TagRecSearchExtra,
  type TagRecSearchTerm,
} from './combination'
import { compareTagRecRelevance } from './relevance'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type { TagInfo } from '../api/endpoints'
import type { TagRecEffectiveConfig } from './filter-engine'
import type { SedimentNode } from './sediment'
import type { TagIdEntry } from './types'

/**
 * [tag-rec] 冷池兜底与见底语义 (票 13 决议 D1~D8) —— 纯函数主战场
 *
 * 兜底梯队: tag/top 主池 => 干轮 => related 共现选种 => 兜底堆按相关性、质量排序
 *           每干轮放行一页 => all/v2 自动深挖 <=K => 手动横幅 => 硬见底
 *
 * - all/v2 深挖流 (TagRecDigStream): 输入路径 = 锚点流 (规范名检索词, D5);
 *   组路径 = 成员规范名同义词簇, 每簇一流 (D7); tab1 饿谁喂谁同簇语义 (D8);
 *   票 32: 深挖流间并行 (tagRecLimit 总闸不变), tab2 首载/变员预热即注册簇流+扩选流
 * - 词表 = sediment 锚点节点 cooccur 键 (Phase 2 exact 条目上除锚点外的 tag 并集, §3.5 免费推导)
 * - 选种先看标签共现，再以质量破平局；默认无分数门槛，显式门槛仍生效。
 *   已知标签按共现选窗口，未知标签限量轮转补查，缺统计不丢失选种资格。
 */

// #region 遗留参数 (票 13 定稿值, 可调)
/** 自动深挖上限/会话 (预算旋钮非质量旋钮, ≈3发/次) */
export const TAG_REC_AUTO_DIG_MAX = 3
/** 每轮选种扫描窗口；未知标签轮转补查，不按历史产出全局关闭。 */
export const TAG_REC_SEED_POOL_MAX = 12
// A3-3: 每轮「池内新名单」抓取预算 —— seedPoolMax 上界 (200) 下最坏 200 发/干轮太宽;
//   持久命中/已抓条目不占预算, 超预算条目本轮不参评 (池在则下轮再评, 不丢资格)
export const TAG_REC_SEED_FETCH_BUDGET = 30
/** 共现种子数 */
export const TAG_REC_SEED_COUNT = 3
/** 选种综合分门槛 (防共现冠军是纯垃圾) */
export const TAG_REC_SEED_MIN_SCORE = 0
/** 组路径同义词簇上限 */
export const TAG_REC_CLIQUE_MAX = 5
/** 兜底堆每干轮放行条数 (= service PAGE_SIZE) */
export const TAG_REC_FALLBACK_PAGE = 20
// #endregion

// #region 票 17 深挖策略分家参数 (tab2 激进档; tab1 沿用上行固定值)
/** 浅水位预挖触发阈值: 本轮主池产出 < 此值 => 同轮顺手一发深挖 (不等干透) */
export const TAG_REC_PREDIG_TRIGGER_YIELD = 10
/** adaptive 深挖低产判据: 0 < 单发净增 < 此值 => 记一轮低产 */
export const TAG_REC_DIG_LOW_YIELD = 3
/** adaptive 深挖低产连停: 连续此轮数低产 => 停自动转手动横幅 (三停之一) */
export const TAG_REC_DIG_LOW_YIELD_STREAK_MAX = 2
// #endregion

// #region 票 38 深挖批整形参数
/** due 流窗口: 单 digPass 只挖头 N 条未干流 (nextPage 升序公平轮转, 手动/自动同限 —— 单 pass all/v2 发数 <= PHASE2_PAGE_BATCH×N) */
export const DIG_STREAM_WINDOW = 4
/** 退避恢复后首个 digPass 窗口减半的探测期 (BackoffGate.recentlyRecovered 判定窗) */
export const DIG_RECOVERY_HALF_MS = 10_000
/** Q6b: 组合 title/desc 短词流的页上限 —— 小额试探带出「同词家族」, 到顶即停不再轮转。 */
export const TAG_REC_TEXT_SEED_PAGE_CAP = 2
/** Q7a: 组合 title/desc 词开流的最大字符数; 超长词不开流 (搜索结果纯噪声, 纯本地精确匹配)。 */
export const TAG_REC_TEXT_SEED_MAX_CHARS = 12
/** Q4-C: 交集组合词深挖流上限 —— 分支两两配对多词查询, 让 all/v2 服务端先筛交集
 *  (单词流的双边命中全靠运气, 交集真实产率 ~低个位数 %/页); tag×tag 页帽缺省
 *  ALLV2_PAGE_CAP (真产线不是小额试探), 含 title/desc 词的 pair 继承文本帽 —
 *  试探出高产由 capLifted 摘帽续挖; 配额窗口按 pairSalt 逐轮换, 不独占前 8 */
export const TAG_REC_CROSS_CLIQUE_MAX = 8
/** B 产率摘帽: 带帽深挖流单批交付 (post-filter staged) ≥此值即摘帽续挖 —— 页帽是试探不是天花板 */
export const TAG_REC_STREAM_CAP_LIFT_YIELD = 5
// #endregion

// #region all/v2 深挖流
/**
 * 一条 all/v2 深挖流 = {归一化锚名 key, 检索词 keyword, 页游标}
 * key 同时是: exact 归一化匹配键 / sediment 锚点节点 / 词表键
 */
export type TagRecDigStream = {
  key: string // normalizeTagName(锚点规范名 / 簇名)
  keyword: string // all/v2?keyword=
  /** exact 条目的 source.groupNames; related 衍生为 `${attribution[i]}·相关` */
  attribution: string[]
  groupIds?: string[] // 组源的稳定归属；输入词流没有组实体
  input?: boolean
  /** Q6b: 组合 title/desc 短词流的页上限 (缺省 ALLV2_PAGE_CAP); 到顶即 exhausted。 */
  pageCap?: number
  /** B: 带帽流高产已摘帽 —— 抗派生回补 (旧建流/再派生不再把帽按回去) */
  capLifted?: boolean
  nextPage: number
  /** 会话内已成功页位图 (不落盘): gap 断点后已付页不再重挖, 游标只顺吃连续成功段 */
  okPages?: Set<number>
  exhausted: boolean // all/v2 50 页截断或空页到底
  stopReason?: 'empty' | 'cap' | 'legacy'
  retryAt?: number
  /** 输入流专属: 字形变体 tag/info 解析 (组流不需要, 省请求) */
  withVariants?: boolean
  /** 输入流首轮: suggest 联想第三优先级 */
  withSuggest?: boolean
  /** 输入流锚点 (候选清单「精确」徽章行) */
  anchor?: TagInfo
  /** Q4-C 交集组合词流: 构成成员的归一名 —— exact 分桶任一命中即算; sediment 语料归并到
   *  各成员真实锚点 (组合键不落谱, 不污染共现词表)。在 => 本流是组合词流 */
  crossNorms?: string[]
}

/** 建流时的续挖游标 (票 36 sediment 水合产物; 给 => 从已挖页续挖, 不给 => 页1新流) */
export type DigResumeCursor = Pick<TagRecDigStream, 'nextPage' | 'exhausted' | 'stopReason' | 'retryAt' | 'capLifted'>

export function newDigStream(
  p: Omit<TagRecDigStream, 'nextPage' | 'exhausted'>,
  resume?: DigResumeCursor,
): TagRecDigStream {
  return {
    nextPage: resume?.nextPage ?? 1,
    exhausted: resume?.exhausted ?? false,
    ...(resume?.capLifted ? { capLifted: true } : {}),
    ...(resume?.stopReason ? { stopReason: resume.stopReason, retryAt: resume.retryAt } : {}),
    ...p,
  }
}

/**
 * 票 36: sediment 锚点节点 dig 游标 => 建流 resume 入参 (纯函数)
 * - 水合门槛 = `dig.keyword === stream.keyword` 精确等值: 同 norm 不同拼写结果集不同, 不误续
 *   (拼写变按新流对待, 首个 digPass 成功推进时覆盖写回 dig 字段)
 * - 老节点无 dig 字段 / 脏 nextPage => undefined 按新流; exhausted 随游标水合复活 (A 档永真语义)
 */
export function digResumeFromSediment(node: SedimentNode | undefined, keyword: string): DigResumeCursor | undefined {
  const dig = node?.dig
  if (!dig || dig.keyword !== keyword) return undefined
  const nextPage = Math.floor(dig.nextPage)
  if (!Number.isFinite(nextPage) || nextPage < 1) return undefined // 脏游标 => 按新流
  return {
    nextPage,
    exhausted: dig.exhausted === true,
    ...(dig.capLifted ? { capLifted: true } : {}),
    ...(dig.exhausted
      ? { stopReason: dig.stopReason ?? 'legacy', retryAt: dig.retryAt ?? dig.lastAt + 60 * 60 * 1000 }
      : {}),
  }
}

/** D7: 组正向成员规范名按归一化去重成簇 —— 每簇一条流, keyword=首个成员规范名, 归属=含该 norm 成员的全部组名
 *  W1-8: 逐位轮转取成员 (原组序整扫 = 首组独占 cap —— 后面组永远分不到簇流)
 *  Q6b/Q7a: 组合的 title/desc 词进流另有限制 —— 短词 (≤TAG_REC_TEXT_SEED_MAX_CHARS) 才开流且
 *    带 pageCap (小额试探, 到顶即停); 长词不开流 (纯本地精确匹配), 否则 20 字短语搜索纯噪声烧请求。 */
export function deriveGroupCliques(
  groups: readonly {
    id?: string
    name: string
    tag_ids: readonly TagIdEntry[]
    combination?: TagRecCombination
    /** 生效链词源 (service 侧 tagRecSearchExtraOf(resolver(...))) —— 仅看名单参与配对, 屏蔽词不进查询 */
    extra?: TagRecSearchExtra
  }[],
  cap = TAG_REC_CLIQUE_MAX,
  /** 组合词配额轮转种子 —— 候选超帽时按盐换起点, 不独占确定性前 8 */
  pairSalt = 0,
): {
  key: string
  keyword: string
  attribution: string[]
  groupIds?: string[]
  pageCap?: number
  crossNorms?: string[]
}[] {
  const prepared = groups.map((group) => {
    if (!group.combination) return { group, textSeeds: undefined as Set<string> | undefined }
    const text = new Set(
      tagRecConditionAtoms(group.combination.include).flatMap((atom) =>
        atom.field === 'title' || atom.field === 'desc' ? [atom.value] : [],
      ),
    )
    const long = new Set([...text].filter((word) => word.length > TAG_REC_TEXT_SEED_MAX_CHARS))
    return {
      group: {
        ...group,
        tag_ids: tagRecCombinationSeeds(group.combination)
          .keywords.filter((name) => !long.has(name))
          .map((name) => ({ id: 0, name })),
      },
      textSeeds: new Set([...text].filter((word) => word.length <= TAG_REC_TEXT_SEED_MAX_CHARS)),
    }
  })
  const byNorm = new Map<string, { keyword: string; attribution: string[]; groupIds?: string[]; pageCap?: number }>()
  const maxLen = prepared.reduce((m, { group }) => Math.max(m, group.tag_ids.length), 0)
  for (let i = 0; i < maxLen; i++) {
    for (const { group: g, textSeeds } of prepared) {
      const e = g.tag_ids[i]
      if (!e) continue
      const norm = normalizeTagName(e.name)
      if (!norm) continue
      const textCap = textSeeds?.has(e.name) ? TAG_REC_TEXT_SEED_PAGE_CAP : undefined
      const c = byNorm.get(norm)
      if (!c)
        byNorm.set(norm, {
          keyword: e.name,
          attribution: [g.name],
          ...(g.id && { groupIds: [g.id] }),
          ...(textCap && { pageCap: textCap }),
        })
      else {
        if (!c.attribution.includes(g.name)) c.attribution.push(g.name)
        if (g.id) {
          c.groupIds ??= []
          if (!c.groupIds.includes(g.id)) c.groupIds.push(g.id)
        }
        if (textCap && !c.pageCap) c.pageCap = textCap
      }
    }
  }
  // Q4-C: 组合词深挖流 —— 可检索分支两两配对 (required×required + required×optional +
  //   internal 内配), keyword=「a b」多词查询。词源 = tag 名 + 短 title/desc 词
  //   (长文本词纯噪声不开); 词面跨支重复 (同 norm) 不算 pair。crossNorms 同时充任:
  //   exact 分桶键 / sediment 语料锚点 / 「组合词流」标记; 跨组同 pair 归一序去重并归属
  //   (同 byNorm 簇合并语义); 数量帽闸的是本批窗口, pairSalt 轮转牺牲位。
  const crossByKey = new Map<
    string,
    {
      key: string
      keyword: string
      attribution: string[]
      groupIds?: string[]
      crossNorms: string[]
      pageCap?: number
    }
  >()
  const textCapOk = (t: TagRecSearchTerm) => t.field === 'tag' || t.name.length <= TAG_REC_TEXT_SEED_MAX_CHARS
  for (const { group: g } of prepared) {
    if (!g.combination) continue
    const { required, optional, internal } = tagRecSearchBranches(g.combination, g.extra)
    const branches = required.map((b) => b.filter(textCapOk)).filter((b) => b.length > 0)
    const opt = optional.filter(textCapOk)
    const pushPair = (a: TagRecSearchTerm, b: TagRecSearchTerm) => {
      if (a.norm === b.norm) return
      const key = [a.norm, b.norm].sort().join(' ')
      // 含 title/desc 词的 pair 继承文本帽 —— 试探出高产由 capLifted 摘帽; tag×tag 是真产线不设帽
      const textCap = a.field !== 'tag' || b.field !== 'tag' ? TAG_REC_TEXT_SEED_PAGE_CAP : undefined
      const exist = crossByKey.get(key)
      if (exist) {
        if (!exist.attribution.includes(g.name)) exist.attribution.push(g.name)
        if (g.id) {
          exist.groupIds ??= []
          if (!exist.groupIds.includes(g.id)) exist.groupIds.push(g.id)
        }
        if (textCap && exist.pageCap === undefined) exist.pageCap = textCap
        return
      }
      if (crossByKey.size >= TAG_REC_CROSS_CLIQUE_MAX) return
      crossByKey.set(key, {
        key,
        keyword: `${a.name} ${b.name}`,
        attribution: [g.name],
        ...(g.id && { groupIds: [g.id] }),
        crossNorms: [a.norm, b.norm],
        ...(textCap && { pageCap: textCap }),
      })
    }
    const pairs: [TagRecSearchTerm, TagRecSearchTerm][] = []
    for (let i = 0; i < branches.length; i++)
      for (let j = i + 1; j < branches.length; j++)
        for (const a of branches[i]) for (const b of branches[j]) pairs.push([a, b])
    // 任一命中根组的成员词 × 必需伪分支 (过滤 allow-list): 单词流按词面捞, 组合词服务端预筛必过约束
    for (const branch of branches) for (const a of branch) for (const b of opt) pairs.push([b, a])
    // any 根下 all 子组内配: 成员在该备选里是同位必需 —— `丝柯克 实机` 是唯一瞄准 all{x,y} 备选的查询
    for (const inner of internal.map((b) => b.map((t) => t.filter(textCapOk)).filter((t) => t.length > 0)))
      for (let i = 0; i < inner.length; i++)
        for (let j = i + 1; j < inner.length; j++)
          for (const a of inner[i]) for (const b of inner[j]) pairs.push([a, b])
    // 轮转取窗: 候选超帽时按 pairSalt 换起点 —— 不同轮次取不同 8 窗口, 旧牺牲位轮得到
    const rot = pairs.length ? pairSalt % pairs.length : 0
    for (let k = 0; k < pairs.length; k++) {
      const [a, b] = pairs[(k + rot) % pairs.length]
      pushPair(a, b)
    }
  }
  return [...[...byNorm].slice(0, cap).map(([key, c]) => ({ key, ...c })), ...crossByKey.values()]
}
/** 生效配置 => 组合词配对的外部词源: 「仅看」名单成必需伪分支; 屏蔽词归一成封堵集 ——
 *  命中即滤的词进查询只会整流白烧 (回来全被本地滤死)。neg 已含 dims 层名单 (title/desc
 *  scoped 进 neg.title/neg.desc), 只需读 neg。 */
export function tagRecSearchExtraOf(eff: Pick<TagRecEffectiveConfig, 'neg'> | undefined): TagRecSearchExtra {
  const blockNorms = new Set<string>()
  for (const rule of eff?.neg.tagBlock ?? []) for (const norm of rule.index.names) blockNorms.add(norm)
  for (const s of [...(eff?.neg.title ?? []), ...(eff?.neg.desc ?? [])]) {
    const norm = normalizeTagName(s.v)
    if (norm) blockNorms.add(norm)
  }
  return {
    allowTags: eff?.neg.tagAllow?.list,
    allowTitle: eff?.neg.titleAllow?.list,
    allowDesc: eff?.neg.descAllow?.list,
    blockNorms,
  }
}
// #endregion

/** `X·相关` 旁路归因名 => 源组名 X (负向过滤/严格校验归因回落, 票 13) */
export function stripRelatedSuffix(name: string): string {
  return name.endsWith('·相关') ? name.slice(0, -'·相关'.length) : name
}

// #region D2 词表与共现选种
/** Map 兼容接口 (同 sediment.SedimentPool): proxyMap 与原生 Map 均满足 */
export type CooccurVocabPool = Pick<Map<string, SedimentNode>, 'get'>

/** 锚点邻域词表 = sediment 各锚点节点 cooccur 键并集 (多流并集) */
export function cooccurVocab(pool: CooccurVocabPool, norms: readonly string[]): Set<string> {
  const vocab = new Set<string>()
  for (const norm of norms) {
    const node = pool.get(norm)
    for (const other of Object.keys(node?.cooccur ?? {})) vocab.add(other)
  }
  return vocab
}

/** 共现度 = 自身 tag 名归一化后命中词表的去重个数 */
export function countCooccurDegree(tagNames: readonly string[], vocab: ReadonlySet<string>): number {
  const hit = new Set<string>()
  for (const t of tagNames) {
    const norm = normalizeTagName(t)
    if (norm && vocab.has(norm)) hit.add(norm)
  }
  return hit.size
}

export type CooccurSeedCandidate = {
  bvid: string
  cooccur: number
  score: number | undefined
}

/**
 * D2 选种: 共现度>=1，按共现降序、同值按质量；只有显式正分数门槛做硬筛选。
 * 返回种子 bvid 列表 (条数 < count 时取全部)
 */
export function selectCooccurSeeds(
  candidates: readonly CooccurSeedCandidate[],
  { count = TAG_REC_SEED_COUNT, minScore = TAG_REC_SEED_MIN_SCORE }: { count?: number; minScore?: number } = {},
): string[] {
  return candidates
    .filter((c) => c.cooccur >= 1 && (minScore <= 0 || (c.score !== undefined && c.score >= minScore)))
    .sort((a, b) => b.cooccur - a.cooccur || (b.score ?? -1) - (a.score ?? -1))
    .slice(0, count)
    .map((c) => c.bvid)
}
// #endregion

// #region D1/D3 兜底堆排序 (合并堆按分排序, 分批放行)
/** via 择优: 共现 related (archive) 先于 关键词 related (all/v2) —— 同分时的档内次序 */
const FALLBACK_VIA_RANK: Record<string, number> = {
  'archive-related': 0,
  'all-v2-related': 1,
}

/**
 * 兜底堆按相关性证据、质量排序；缺统计使用中性排序值，来源序只破平局。
 */
export function compareFallbackItems(a: TagRecItemExtend, b: TagRecItemExtend): number {
  const relevanceDiff = compareTagRecRelevance(a.relevance, b.relevance)
  if (relevanceDiff) return relevanceDiff
  const scoreDiff = (b.qualitySortScore ?? b.score ?? 0) - (a.qualitySortScore ?? a.score ?? 0)
  if (scoreDiff) return scoreDiff
  if (a.partial && b.partial) {
    const viewDiff = (b.stat.view ?? 0) - (a.stat.view ?? 0)
    if (viewDiff) return viewDiff
  }
  const viaDiff = (FALLBACK_VIA_RANK[a.source.via] ?? 2) - (FALLBACK_VIA_RANK[b.source.via] ?? 2)
  if (viaDiff) return viaDiff
  const rankDiff = (a.srcRank ?? 0) - (b.srcRank ?? 0)
  if (rankDiff) return rankDiff
  return a.bvid < b.bvid ? -1 : a.bvid > b.bvid ? 1 : 0
}
// #endregion
