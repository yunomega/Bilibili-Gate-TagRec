import { normalizeTagName, type TagClique } from './tag-norm'

/**
 * [tag-rec] 沉淀池 schema + 写路径 (spec §3.5 草案·票 09 定稿前按此写)
 * - 节点 = tag 名归一 (小写+去空白+NFKC); 边 = 同视频共现 (count/exampleBvids/lastSeen)
 * - 写路径: Phase 2 扫 all/v2 结果 tag 字段, tag↔tag 共现边 merge
 * - 草稿组不沉淀: 只落 tag↔tag 事实边, 不存组实体 (临时输入只有升级进表/丢弃)
 * - 已知 id 路径 (数字直输/★弹层/CSV id 列) 零解析不经过沉淀池
 * - 容量 ~5k 节点 + LRU (按节点 lastSeen 淘汰最久未见)
 * - 票 perf-11: 单节点共现边 cap (SEDIMENT_EDGE_CAP) —— cooccur 唯一读端是 dig.ts
 *   cooccurVocab 词表键 (只问「边存在」不读权重); 写侧 merge/noteDig 收边, 存量大池
 *   水合后 trimSedimentPoolEdges 一次性裁剪 (票 07 实测无上限把池推到 8.1MB)
 */

export type SedimentEdge = {
  count: number
  exampleBvids: string[] // 3~5 个提案证据
  lastSeen: number
}

/**
 * 票 36: 深挖游标 —— 「这个词挖过多深」挂锚点节点 (节点 key 与深挖流 key 同构 = normalizeTagName(锚名/簇名))
 * - keyword: 当时检索词原文 —— 水合门槛 = 精确等值 (同 norm 不同拼写结果集不同, 不误续)
 * - nextPage: 下次应挖页 (=已挖页+1)
 * - exhausted: 流尽标记 (50页 cap/真空页到底) —— A 档: 永真至节点 LRU 淘汰/清空沉淀
 * - lastAt: 最近一次成功挖页时刻
 */
export type SedimentDigCursor = {
  keyword: string
  nextPage: number
  exhausted?: boolean
  lastAt: number
  schemaVersion?: 2
  revision?: number
  stopReason?: 'empty' | 'cap' | 'legacy'
  /** B 产率摘帽: 带帽流高产已摘帽 —— 跨会话抗回补 (否则下会话 cap 回填把已越帽游标当场判干) */
  capLifted?: boolean
  retryAt?: number
  probes?: Record<string, { at: number; retryAt: number; empty?: boolean; revision: number }>
}

export type SedimentNode = {
  variants: string[] // 见过的写法 (原始拼写, 去重)
  cooccur: Record<string /* otherNorm */, SedimentEdge>
  confirmed?: boolean // 用户在候选清单勾选过 => 强信号 (§3.5 草案)
  lastSeen: number // 节点级 LRU 依据
  dig?: SedimentDigCursor // 票 36: 深挖游标 (可选字段, 向后兼容 —— 老节点无此不炸)
}

export type Sediment = Record<string /* normName */, SedimentNode>

/** Map 兼容接口: proxyMap 与原生 Map 均满足, 纯函数可测 */
export type SedimentPool = Pick<Map<string, SedimentNode>, 'get' | 'set' | 'delete' | 'size' | 'entries'>

type SedimentNodeView = {
  variants?: readonly string[]
  cooccur: Readonly<Record<string, { count: number }>>
}

/**
 * 沉淀池共现聚合 (与收藏面板「共现变体表」同源, 零请求): 对给定 norm 集合的共现边累加
 * (频次跨成员相加), 剔除排除集 (含种子自身), 按频次降序取前 limit;
 * 展示名取对方节点 variants 首项 (原始拼写), 无则回落 norm。UI 侧经 useSnapshot 实时刷新。
 */
export function aggregateTagRecCooccur(
  pool: Pick<ReadonlyMap<string, SedimentNodeView>, 'get'>,
  norms: readonly string[],
  excludeNorms: ReadonlySet<string>,
  limit = 50,
): { norm: string; name: string; count: number }[] {
  const acc = new Map<string, number>()
  for (const norm of norms) {
    const node = pool.get(norm)
    if (!node) continue
    for (const [other, edge] of Object.entries(node.cooccur)) {
      if (excludeNorms.has(other)) continue
      acc.set(other, (acc.get(other) ?? 0) + edge.count)
    }
  }
  return [...acc]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([norm, count]) => ({ norm, name: pool.get(norm)?.variants?.[0] ?? norm, count }))
}

export const SEDIMENT_NODE_CAP = 5_000 // ~5k 节点上限
export const SEDIMENT_PRUNE_TO = 4_800 // 超限淘汰到水位 (迟滞避免反复修剪)
export const SEDIMENT_EVIDENCE_CAP = 5 // exampleBvids 3~5
export const SEDIMENT_VARIANT_CAP = 16 // 单节点 variants 写法上限
export const SEDIMENT_MAX_TAGS_PER_CLIQUE = 40 // 单视频 tag 团规模上限 (防 O(k²) 爆炸)
export const SEDIMENT_EDGE_CAP = 128 // 票 perf-11: 单节点共现边度上限 (≈3 个满团邻域; 依据见 trimSedimentNodeEdges)

function ensureNode(pool: SedimentPool, norm: string, now: number): SedimentNode {
  let node = pool.get(norm)
  if (!node) {
    node = { variants: [], cooccur: {}, lastSeen: now }
    pool.set(norm, node)
  }
  node.lastSeen = now
  return node
}

function pushUnique<T>(arr: T[], v: T, cap: number) {
  if (arr.includes(v)) return
  if (arr.length >= cap) arr.shift() // 滚动保留最新
  arr.push(v)
}

/** 写一条有向共现边 a -> b */
function addEdge(pool: SedimentPool, aNorm: string, bNorm: string, bvid: string | undefined, now: number) {
  if (aNorm === bNorm) return
  const node = ensureNode(pool, aNorm, now)
  let edge = node.cooccur[bNorm]
  if (!edge) {
    edge = { count: 0, exampleBvids: [], lastSeen: now }
    node.cooccur[bNorm] = edge
  }
  edge.count++
  edge.lastSeen = now
  if (bvid) pushUnique(edge.exampleBvids, bvid, SEDIMENT_EVIDENCE_CAP)
}

/**
 * sediment.merge(anchorNorm, items) 写路径:
 * 每条 clique = 一个视频的 tag 团; 团内两两互边 (tag↔tag 同视频共现, 双向)
 * anchorNorm 标识调用侧锚点 (变体写法聚合到锚点节点; 非锚点团也落 corpus)
 */
export function sedimentMerge(
  pool: SedimentPool,
  anchorNorm: string,
  items: TagClique[],
  now: number = Date.now(),
): void {
  ensureNode(pool, anchorNorm, now)
  const edgeTouched = new Set<string>() // 票 perf-11: 本轮可能涨边的节点 (收尾裁剪名单)
  for (const item of items) {
    // 同一 norm 的多写法全集 (variants 收全部写法; 边按 norm 去重计)
    const rawsByNorm = new Map<string, string[]>()
    for (const raw of item.tags.slice(0, SEDIMENT_MAX_TAGS_PER_CLIQUE)) {
      const norm = normalizeTagName(raw)
      if (!norm) continue
      const raws = rawsByNorm.get(norm) ?? []
      if (!raws.includes(raw)) raws.push(raw)
      rawsByNorm.set(norm, raws)
    }
    if (!rawsByNorm.size) continue

    // 节点: variants 收录写法 + lastSeen 触碰
    for (const [norm, raws] of rawsByNorm) {
      const node = ensureNode(pool, norm, now)
      for (const raw of raws) pushUnique(node.variants, raw, SEDIMENT_VARIANT_CAP)
    }
    // 边: 团内两两互边
    const norms = [...rawsByNorm.keys()]
    for (const n of norms) edgeTouched.add(n)
    for (let i = 0; i < norms.length; i++) {
      for (let j = i + 1; j < norms.length; j++) {
        addEdge(pool, norms[i], norms[j], item.bvid, now)
        addEdge(pool, norms[j], norms[i], item.bvid, now)
      }
    }
  }
  // [tag-rec] 票 perf-11: 单节点边度 cap —— 只扫本轮落过边的节点 (存量全池扫描在水合迁移做)
  for (const norm of edgeTouched) {
    const node = pool.get(norm)
    if (node) trimSedimentNodeEdges(node)
  }
  pruneSediment(pool)
}

/** LRU/久未见淘汰: 节点数超上限时按 lastSeen 最旧删至水位 */
export function pruneSediment(pool: SedimentPool, cap = SEDIMENT_NODE_CAP, floor = SEDIMENT_PRUNE_TO): number {
  if (pool.size <= cap) return 0
  const byAge = [...pool.entries()].sort((a, b) => (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0))
  let removed = 0
  for (const [norm] of byAge) {
    if (pool.size <= floor) break
    pool.delete(norm)
    removed++
  }
  return removed
}

/**
 * [tag-rec] 票 perf-11: 单节点共现边裁剪 —— 保「count 高 → lastSeen 新」前 cap 条, 未超 cap 早退零排序
 * - cooccur 唯一消费 = dig.ts cooccurVocab 词表键并集 (只问「边存在」, 不读 count/证据/lastSeen);
 *   候选视频自身 ~10-20 tag 去重命中计度, 128 词/锚点词表分辩力已富裕 => 裁剪对推荐近乎零损
 * - count 优先于 lastSeen: 反复共现才是真邻域信号; 同 count 一次性弱边按 lastSeen 滚动出新;
 *   饱和 hub (存量全 count≥2) 词表冻结在最强邻域 —— 可接受: 锚点语义近邻本就稳定
 * - 原地 delete 保 edge 对象身份 (proxyMap 嵌套对象不重包); 返回裁掉边数
 */
export function trimSedimentNodeEdges(node: SedimentNode, cap = SEDIMENT_EDGE_CAP): number {
  const entries = Object.entries(node.cooccur)
  if (entries.length <= cap) return 0
  entries.sort((a, b) => (a[1].count ?? 0) - (b[1].count ?? 0) || (a[1].lastSeen ?? 0) - (b[1].lastSeen ?? 0))
  const drops = entries.slice(0, entries.length - cap)
  for (const [k] of drops) delete node.cooccur[k]
  return drops.length
}

/**
 * [tag-rec] 票 perf-11: 全池边裁剪 (存量大池一次性迁移, 挂 store 水合后) —— 收敛式幂等:
 * 裁后无节点超 cap, 重跑返回 0, 无需 migrated 哨兵; 每次水合顺手跑兼自愈更老版本写入
 */
export function trimSedimentPoolEdges(pool: SedimentPool, cap = SEDIMENT_EDGE_CAP): number {
  let removed = 0
  for (const [, node] of pool.entries()) removed += trimSedimentNodeEdges(node, cap)
  return removed
}

/** confirmed 边标记: 候选清单勾选确认 => 节点记 confirmed 强信号 */
export function sedimentConfirm(pool: SedimentPool, norm: string, now: number = Date.now()): void {
  const node = ensureNode(pool, norm, now)
  node.confirmed = true
}

/**
 * 票 36: 深挖游标写口 —— digPass 页游标成功推进后回写 (调用侧保证 allPagesFailed 整流跳过不写);
 * 同实际 keyword 的正常页码只前进，复探记录独立保留；schema 2 区分 empty/cap 与复探冷却。
 * 迁移前的 exhausted 不跨词残留，旧写口不得覆盖新版状态或修改其时间。
 */
export function sedimentNoteDig(
  pool: SedimentPool,
  norm: string,
  dig: Omit<SedimentDigCursor, 'lastAt'> & { expectedRevision?: number },
  now: number = Date.now(),
): void {
  const existing = pool.get(norm)
  const previous = existing?.dig?.keyword === dig.keyword ? existing.dig : undefined
  if (previous?.schemaVersion === 2 && dig.schemaVersion !== 2) return
  if (dig.expectedRevision !== undefined && dig.expectedRevision !== (previous?.revision ?? 0)) return
  const node = ensureNode(pool, norm, now)
  trimSedimentNodeEdges(node) // [tag-rec] 票 perf-11: 深挖锚点恰是边度热点, 回写游标顺手收边
  const exhausted = dig.exhausted === true || (dig.schemaVersion !== 2 && previous?.exhausted === true)
  node.dig = {
    keyword: dig.keyword,
    nextPage: Math.max(dig.nextPage, previous?.nextPage ?? 1),
    lastAt: now,
    ...(previous?.probes ? { probes: previous.probes } : {}),
    ...(dig.schemaVersion === 2
      ? {
          schemaVersion: 2,
          revision: (previous?.revision ?? 0) + 1,
          stopReason: dig.stopReason,
          capLifted: dig.capLifted,
          retryAt: dig.retryAt,
        }
      : {}),
  }
  if (exhausted) node.dig.exhausted = true
}

/** 复探账独立于正常分页，按消费者×来源隔离；旧实例不得重新粘住已迁移状态。 */
export function sedimentNoteProbe(
  pool: SedimentPool,
  norm: string,
  keyword: string,
  scope: string,
  empty: boolean | undefined,
  ttlMs: number,
  expectedRevision?: number,
  now = Date.now(),
) {
  const existing = pool.get(norm)
  if (existing?.dig && existing.dig.keyword !== keyword) return
  const dig = existing?.dig ?? { keyword, nextPage: 1, lastAt: now }
  const previous = dig.probes?.[scope]
  if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) return
  const node = ensureNode(pool, norm, now)
  dig.schemaVersion = 2
  dig.probes ??= {}
  dig.probes[scope] = { at: now, retryAt: now + ttlMs, empty, revision: (previous?.revision ?? 0) + 1 }
  const oldest = Object.entries(dig.probes).sort((a, b) => a[1].at - b[1].at)
  for (const [key] of oldest.slice(0, Math.max(0, oldest.length - 32))) delete dig.probes[key]
  node.dig = dig
}

/**
 * 「重新发掘」出口 (票 36 深挖游标的定向复位): 只清某个锚点的深挖游标 + 复探冷却,
 * 保留共现边与其他节点。与 sedimentClear 的区别: 后者清空整个沉淀池; 这里只把
 * 「这个词挖到哪」复位到第 1 页 —— 已挖穿/冷却中的词重获一轮完整召回 (请求仍有界)。
 */
export function sedimentClearDig(pool: SedimentPool, norm: string): boolean {
  const node = pool.get(norm)
  if (!node?.dig) return false
  delete node.dig
  return true
}

/** 「清空沉淀」(危险区, 归票 08 UI 接线) */
export function sedimentClear(pool: SedimentPool): void {
  for (const [norm] of pool.entries()) pool.delete(norm)
}
