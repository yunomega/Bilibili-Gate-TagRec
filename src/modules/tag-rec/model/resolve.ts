import { tagRecBackoff } from '../api/backoff'
import {
  ALLV2_PAGE_CAP,
  fetchAllV2Search,
  fetchSuggest,
  fetchTagInfoById,
  fetchTagInfoByName,
  type TagInfo,
} from '../api/endpoints'
import { persistVideoTags } from '../api/video-tags-store'
import { stripHighlightTags, type AllV2VideoItem } from './normalize-item'
import { normalizeTagName, parseAllV2TagField, parseTagInput, type TagClique } from './tag-norm'

/**
 * [tag-rec] 解析管线 (spec §4.1 / §4.2)
 * - 输入分流: 纯数字 => tag/info?tag_id= 反查名 => 直进 Phase 1 (逃生口, 全局统一; 零解析不过 Phase 2/沉淀池)
 *   文本 => Phase 1 即时 + Phase 2 后台
 * - Phase 1: tag/info?tag_name= => 锚点 id => tag/top 拉池
 * - Phase 2 一次调用四重产出:
 *   ① 变体发现 (归一化同形=字形变体自动收并逐个 tag/info 换 id;
 *      共现/联想候选行票 18 起惰性解析 —— 只建行不预取 id, 勾选后动作点现解)
 *   ② 精确召回 (tag 字段命中锚点子集 => 真·打标视频 => qs.bufferQueue 尾部)
 *   ③ 兜底留存 (其余命中保留, 池浅时标「相关」补召回)
 *   ④ 共现边 sediment.merge (§3.5)
 * - 变体来源优先级: 归一化(自动) > 共现挖掘(候选不勾) > suggest 联想(补充) > 数字直输(逃生口)
 * - 不做无人值守自动合并/发现: 产出恒走「候选清单 => 人勾选并入」
 */

export { normalizeTagName, parseAllV2TagField, parseTagInput } from './tag-norm'
export type { ParsedTagInput, TagClique } from './tag-norm'

/** Phase 1 锚点解析 (输入分流内建): id 直输反查名 / 文本解析 id */
export async function resolveAnchor(
  raw: string,
  signal?: AbortSignal,
): Promise<{ anchor?: TagInfo; isIdPath: boolean; input: string }> {
  const input = raw.trim()
  const parsed = parseTagInput(input)
  if (!parsed) return { input, isIdPath: false }
  const anchor =
    parsed.kind === 'id' ? await fetchTagInfoById(parsed.id, signal) : await fetchTagInfoByName(parsed.name, signal)
  return { anchor, isIdPath: parsed.kind === 'id', input }
}

// #region all/v2 tag 字段解析与共现分析 (Phase 2 纯函数部分)
export type CooccurAlias = {
  name: string // 首见写法 (展示用)
  norm: string
  count: number // 与锚点同视频共现频次 (命中视频数)
}

/**
 * 共现别名跨页累加合并 (「继续挖共现」逐页并入用): 同词 (归一化) 计数相加, 新词追加;
 * 首见写法保留 —— 与老版候选清单随深挖轮次增长的行为一致。
 */
export function mergeTagRecCooccurAliases(
  prev: readonly { name: string; count?: number }[],
  next: readonly CooccurAlias[],
): { name: string; count: number }[] {
  const map = new Map(
    prev.map((entry) => [normalizeTagName(entry.name), { name: entry.name, count: entry.count ?? 0 }]),
  )
  for (const alias of next) {
    const key = normalizeTagName(alias.name)
    const old = map.get(key)
    map.set(key, old ? { ...old, count: old.count + alias.count } : { name: alias.name, count: alias.count })
  }
  return [...map.values()]
}

export type Phase2Analysis = {
  /** tag 字段命中锚点 ∪ 标题含输入词 (票 35 放宽) => 真·打标/题写视频 */
  exact: AllV2VideoItem[]
  /** 其余命中 => 兜底留存 (标「相关」) */
  related: AllV2VideoItem[]
  /** 字形变体写法: 归一化后与输入同形的去重写法 (含输入本身写法) */
  glyphSpellings: string[]
  /** 语义别名: 命中视频上除锚点外的其它 tag, 按共现频次降序 */
  cooccurAliases: CooccurAlias[]
  /** 全部视频的 tag 团 (sediment.merge 语料) */
  cliques: TagClique[]
}

/** 一次 Phase 2 结果集的四重产出之①②③原料 (纯函数, 可测)
 *  hitNorms: 交集组合词流的多键命中集 (任一成员命中即 exact); 缺省 = [inputNorm] */
export function analyzeAllV2Videos(
  videos: AllV2VideoItem[],
  inputNorm: string,
  hitNorms?: readonly string[],
): Phase2Analysis {
  const exact: AllV2VideoItem[] = []
  const related: AllV2VideoItem[] = []
  const hitSet = new Set(hitNorms?.length ? hitNorms : [inputNorm])
  const glyphSpellings = new Set<string>()
  const aliasMap = new Map<string, CooccurAlias>()
  const cliques: TagClique[] = []

  for (const video of videos) {
    const tags = parseAllV2TagField(video.tag)
    // 票 35: exact 放宽 = tag 命中 ∪ 标题含输入词 (标题去高亮+同归一化子串判; 标题党噪声换主档召回)
    //   门槛: 命中词 ≥2 字符 —— 单字符关键词标题子串命中是纯噪声 (任意标题都含)
    const titleNorm = normalizeTagName(stripHighlightTags(video.title ?? ''))
    const titleHit = [...hitSet].some((n) => n.length >= 2 && titleNorm.includes(n))
    // 票 13 D6: 空 tag 字段条目不再丢弃 —— 标题命中者进 exact, 否则 related (ownTagNames 空 => 负向名匹配失效)
    if (!tags.length) {
      ;(titleHit ? exact : related).push(video)
      continue
    }
    cliques.push({ bvid: video.bvid, tags })

    const hit = tags.some((t) => hitSet.has(normalizeTagName(t))) || titleHit
    if (!hit) {
      related.push(video)
      continue
    }
    exact.push(video)

    // 命中视频内: 同形 => 字形变体写法; 其余 => 语义别名共现计数 (每视频一次)
    const seenNorm = new Set<string>()
    for (const t of tags) {
      const norm = normalizeTagName(t)
      if (hitSet.has(norm)) {
        glyphSpellings.add(t)
      } else if (!seenNorm.has(norm)) {
        seenNorm.add(norm)
        const entry = aliasMap.get(norm) ?? { name: t, norm, count: 0 }
        entry.count++
        aliasMap.set(norm, entry)
      }
    }
  }

  const cooccurAliases = [...aliasMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { exact, related, glyphSpellings: [...glyphSpellings], cooccurAliases, cliques }
}
// #endregion

// #region 候选清单行 (spec §4.2): {tag_name, tag_id, use(读 count.use), 共现频次?, 来源徽章, checkbox}
export type CandidateBadge = 'exact' | 'cooccur' | 'suggest'
export const CandidateBadgeLabel: Record<CandidateBadge, string> = {
  exact: '精确',
  cooccur: '共现',
  suggest: '联想',
}
/** 徽章语义强度 (合并去重时强徽章胜): 精确 > 共现 > 联想 */
const badgeRank: Record<CandidateBadge, number> = { exact: 0, cooccur: 1, suggest: 2 }

export type CandidateRow = {
  key: string // `id:${tag_id}` 或 `n:${norm}` (未解析到 id 时; 解析成功后 key 不换, 仅作行身份)
  tag_name: string
  tag_id?: number // 票 18 惰性解析: 别名/联想行不带 id 入清单, 勾选后动作点现场解析
  use?: number // tag/info 的 count.use (解析后补显, 不回排)
  cooccur?: number // 共现频次 (仅共现徽章行)
  badge: CandidateBadge
  checked: boolean // 精确 (锚点+字形变体) 默认勾; 共现/联想不勾
  expanded?: boolean // 已并入本 service 查询单元
  resolving?: boolean // 勾选触发后台解析进行中 (票 18 增强: 打勾即发, 动作点经会话缓存共享在途 promise)
  resolveFailed?: boolean // 惰性解析失败标记 (票 11 三态之「解析失败」; 可再勾重试)
}

export function candidateRowKey(row: { tag_name: string; tag_id?: number }): string {
  return row.tag_id !== undefined ? `id:${row.tag_id}` : `n:${normalizeTagName(row.tag_name)}`
}

/** 精确 > 共现 > 联想；同类先看共现频次，再以使用量和名字破平局。 */
export function compareCandidateRows(a: CandidateRow, b: CandidateRow): number {
  const badgeDiff = badgeRank[a.badge] - badgeRank[b.badge]
  if (badgeDiff) return badgeDiff
  const ca = a.cooccur ?? 0
  const cb = b.cooccur ?? 0
  if (ca !== cb) return cb - ca
  const ua = a.use ?? -1
  const ub = b.use ?? -1
  if (ua !== ub) return ub - ua
  return a.tag_name.localeCompare(b.tag_name)
}

export function sortCandidateRows(rows: CandidateRow[]): CandidateRow[] {
  return [...rows].sort(compareCandidateRows)
}

/**
 * A5: 会话候选清单驻留上界 —— 深挖期 merge 逐批无界累积 (每并一次 O(C log C) 全排,
 *   长会话 C 可上千); 超界截排序尾部未触及行, 用户已触行 (勾选/展开/在途/败绩) 不受截
 */
export const CANDIDATE_ROWS_SESSION_CAP = 200

/** 合并候选行: 按 key 去重, 强徽章胜, 保留已存在的 checked/expanded 用户态 */
export function mergeCandidateRows(existing: CandidateRow[], incoming: CandidateRow[]): CandidateRow[] {
  const map = new Map<string, CandidateRow>()
  for (const row of existing) map.set(row.key, row)
  for (const row of incoming) {
    const prev = map.get(row.key)
    if (!prev) {
      map.set(row.key, row)
      continue
    }
    map.set(row.key, {
      ...prev,
      ...row,
      // 强徽章胜; 用户态不覆写
      badge: badgeRank[prev.badge] <= badgeRank[row.badge] ? prev.badge : row.badge,
      // W1-6: OR 合并会复活用户已取消的勾 (incoming exact 行恒 checked); resolving 被 spread 抹掉
      //   => 已存在行的 勾选/已并入 全保 prev, 在途/失败位取并集
      checked: prev.checked,
      expanded: prev.expanded,
      resolving: prev.resolving || row.resolving,
      resolveFailed: prev.resolveFailed || row.resolveFailed,
      use: row.use ?? prev.use,
      cooccur: row.cooccur ?? prev.cooccur,
    })
  }
  const merged = sortCandidateRows([...map.values()])
  let kept = 0 // 未触及行名额; 已触行单列不占额
  return merged.filter((r) => {
    if (r.checked || r.expanded || r.resolving || r.resolveFailed) return true
    return ++kept <= CANDIDATE_ROWS_SESSION_CAP
  })
}
// #endregion

// #region Phase 2 主编排 (all/v2 默认 3 页 ~60 条;「继续深挖」+3 页; suggest 补充)
export const PHASE2_PAGE_BATCH = 3
export const PHASE2_MAX_ALIASES = 50 // 进清单别名上限 (共现频次降序截断)
export const VARIANT_RESOLVE_CAP = 20 // 字形变体换 id 上限 (变体自动并入查询单元, 必须解析)
export const SUGGEST_LIST_CAP = 10 // 进清单联想词上限 (票 18: 只建行不解析)

/**
 * tag/info 换 id (并发经 anonGetJson pLimit + 会话缓存撞名合并; 失败静默丢, index 对齐返回)
 * 票 18 决议③: 归一化名去重后共享一次取数 (会话缓存层已合并, 此处防重复入队)
 */
export async function resolveTagInfos(names: string[], signal?: AbortSignal): Promise<(TagInfo | undefined)[]> {
  // 归一化名去重, 保留首见写法 (Map 构造式去重会留后者, 展示名取首见)
  const seenNorm = new Set<string>()
  const uniq = names.filter((n) => {
    const norm = normalizeTagName(n)
    return seenNorm.has(norm) ? false : (seenNorm.add(norm), true)
  })
  const infos = await Promise.all(uniq.map((n) => fetchTagInfoByName(n, signal).catch(() => undefined)))
  const byNorm = new Map(uniq.map((n, i) => [normalizeTagName(n), infos[i]]))
  return names.map((n) => byNorm.get(normalizeTagName(n)))
}

/**
 * 候选行惰性解析 (票 18 决议①): 勾选的未解析行现场 tag/info 换 id
 * - 成功: 回填 tag_id/use + 官方名, 清 resolveFailed
 * - 失败: 标 resolveFailed (票 11 三态; 已解析行/未勾选行原样返回)
 */
export async function resolveCandidateRows(
  rows: readonly CandidateRow[],
  signal?: AbortSignal,
): Promise<CandidateRow[]> {
  const pendings = rows.filter((r) => r.tag_id === undefined)
  if (!pendings.length) return [...rows]
  const infos = await resolveTagInfos(
    pendings.map((r) => r.tag_name),
    signal,
  )
  const byNorm = new Map<string, TagInfo>()
  pendings.forEach((r, i) => {
    const info = infos[i]
    if (info) byNorm.set(normalizeTagName(r.tag_name), info)
  })
  return rows.map((r) => {
    if (r.tag_id !== undefined) return r
    const info = byNorm.get(normalizeTagName(r.tag_name))
    if (!info) return { ...r, resolveFailed: true }
    return { ...r, tag_id: info.id, tag_name: info.name, use: info.use, resolveFailed: false }
  })
}

export type Phase2RoundArgs = {
  keyword: string // all/v2 检索词 (= 输入原文)
  inputNorm: string // normalizeTagName(输入)
  anchor?: TagInfo // Phase 1 锚点 (行首 + 归因名)
  fromPage: number
  pageCount?: number // 默认 PHASE2_PAGE_BATCH
  withSuggest?: boolean // 首轮补联想 (第三优先级)
  /** 字形变体 tag/info 解析开关 (缺省 true; 票 13 组簇流关 —— 省变体解析请求) */
  resolveVariants?: boolean
  /** Q4-C 交集组合词流: exact 分桶命中集 (归一名多键); 缺省 = [inputNorm] */
  matchNorms?: readonly string[]
  signal?: AbortSignal
}

export type Phase2RoundResult = {
  videos: AllV2VideoItem[] // 本轮全部命中 (exact+related)
  analysis: Phase2Analysis
  pagesFetched: number // 实际成功的页数
  allPagesFailed: boolean
  /** ① 字形变体解析出的 id (自动收; 可能含锚点自身 id, 调用侧按 id 去重) */
  variantEntries: TagInfo[]
  /** 候选行增量 (锚点行 + 变体行 + 别名行 + 联想行; 票 18: 别名/联想行不带 id, 勾选后惰性解析) */
  newCandidates: CandidateRow[]
}

export async function runPhase2Round(args: Phase2RoundArgs): Promise<Phase2RoundResult> {
  const { keyword, inputNorm, anchor, fromPage, withSuggest = false, signal } = args
  const pageCount = args.pageCount ?? PHASE2_PAGE_BATCH
  const pages = Array.from({ length: pageCount }, (_, i) => fromPage + i).filter((p) => p <= ALLV2_PAGE_CAP)

  // —— all/v2 分页连发 (单页失败静默丢该页) ——
  const settled = await Promise.allSettled(pages.map((p) => fetchAllV2Search(keyword, { page: p, signal })))
  const videos = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const pagesFetched = settled.filter((r) => r.status === 'fulfilled').length
  const allPagesFailed = pages.length > 0 && pagesFetched === 0
  if (signal?.aborted) return emptyResult()

  // 票 13 D10: all/v2 `tag` 字段名单顺手落盘 (bvid→name-only 持久缓存) ——
  // 白嫖率从「碰巧」变「必然」: 共现选种/严格校验/tag 弹层全部受益
  for (const video of videos) {
    const tagNames = parseAllV2TagField(video.tag)
    if (video.bvid && tagNames.length)
      void persistVideoTags(
        video.bvid,
        tagNames.map((tag_name) => ({ tag_name })),
        // partial: 搜索 tag 字段是投影非全量 —— 合并进旧名单, 不允许截断已有完整名单
        { partial: true },
      )
  }

  const analysis = analyzeAllV2Videos(videos, inputNorm, args.matchNorms)

  // —— ① 字形变体: 去重写逐个 tag/info 换 id (并发, 失败静默丢; 自动并入查询单元必须解析) ——
  // 票 13: 组簇流 resolveVariants=false 整段跳过 (簇内同形已归一, 组流零变体请求)
  const spellings = args.resolveVariants === false ? [] : analysis.glyphSpellings.slice(0, VARIANT_RESOLVE_CAP)
  const variantInfos = spellings.length ? await resolveTagInfos(spellings, signal) : []
  const variantEntries = dedupeById(variantInfos.filter((i): i is TagInfo => !!i))

  // —— 票 18 决议①: 共现别名/联想词不再投机预解析 —— 直接建行 (无 tag_id/use), 勾选后动作点现解 ——
  const aliases = analysis.cooccurAliases.slice(0, PHASE2_MAX_ALIASES)
  // 票 38 C: suggest 双门槛 —— 退避期避让 + 空结果轮不发 (本页零命中更无必要补联想)
  const suggestNames =
    withSuggest && !tagRecBackoff.isEngaged && videos.length > 0
      ? (await fetchSuggest(keyword, signal).catch(() => [])).slice(0, SUGGEST_LIST_CAP)
      : []

  if (signal?.aborted) return emptyResult()

  const newCandidates = buildCandidateRows({ anchor, variantEntries, aliases, suggest: suggestNames, inputNorm })

  return { videos, analysis, pagesFetched, allPagesFailed, variantEntries, newCandidates }
}

function emptyResult(): Phase2RoundResult {
  return {
    videos: [],
    analysis: { exact: [], related: [], glyphSpellings: [], cooccurAliases: [], cliques: [] },
    pagesFetched: 0,
    allPagesFailed: false,
    variantEntries: [],
    newCandidates: [],
  }
}

function dedupeById(infos: TagInfo[]): TagInfo[] {
  const seen = new Set<number>()
  return infos.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
}

export function buildCandidateRows(args: {
  anchor?: TagInfo
  variantEntries: TagInfo[]
  /** 票 18: 别名行不再带预解析 info (无 tag_id/use 入清单) */
  aliases: { name: string; count: number }[]
  /** 票 18: 联想行同别名, 只给词 */
  suggest: string[]
  inputNorm: string
}): CandidateRow[] {
  const { anchor, variantEntries, aliases, suggest, inputNorm } = args
  const rows: CandidateRow[] = []

  const push = (row: Omit<CandidateRow, 'key'>) => {
    rows.push({ ...row, key: candidateRowKey(row) })
  }

  // 徽章「精确」: 锚点 + 归一化变体, 默认勾
  if (anchor) push({ tag_name: anchor.name, tag_id: anchor.id, use: anchor.use, badge: 'exact', checked: true })
  for (const v of variantEntries) {
    push({ tag_name: v.name, tag_id: v.id, use: v.use, badge: 'exact', checked: true })
  }
  // 徽章「共现」: 语义别名, 不勾 (tag_id 留空待惰性解析)
  for (const a of aliases) {
    push({ tag_name: a.name, cooccur: a.count, badge: 'cooccur', checked: false })
  }
  // 徽章「联想」: suggest 补充, 不勾
  for (const s of suggest) {
    // suggest 词与锚点/变体同形 => 已尽收进「精确」, 不再建行
    if (normalizeTagName(s) === inputNorm) continue
    push({ tag_name: s, badge: 'suggest', checked: false })
  }

  // 同 key 合并 (不同写法可能解析到同 tag_id; suggest/别名可能撞车)
  const map = new Map<string, CandidateRow>()
  for (const row of rows) {
    const prev = map.get(row.key)
    if (!prev) {
      map.set(row.key, row)
      continue
    }
    map.set(row.key, {
      ...row,
      badge: badgeRank[prev.badge] <= badgeRank[row.badge] ? prev.badge : row.badge,
      checked: prev.checked || row.checked,
      cooccur: prev.cooccur ?? row.cooccur,
      use: prev.use ?? row.use,
    })
  }
  return sortCandidateRows([...map.values()])
}
// #endregion

export type { TagInfo }
