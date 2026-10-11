import { cloneDeep } from 'es-toolkit'
import { EApiType } from '$enums'
import { projectTagRecActiveClaims, type TagRecScopeResolve } from '../model/filter-engine'
import { mergeTagRecCandidate, tagRecGroupKey, tagRecSourceClaims } from '../model/relevance'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'

/** 惰性稀缺堆条目: [上次评估稀缺度, 入桶序, bvid] —— 键是上界 (池深在整理中只降不升), 弹出时重估 */
type TagRecScarcityEntry = [key: number, seq: number, bvid: string]

/** 堆顶 = 稀缺度最深者 (牺牲最深归属保冷池); 稀缺度平手按入桶序 (同逐条 pickTagRecCapacityVictim 的 ordered 语义) */
const scarcityHigher = (a: TagRecScarcityEntry, b: TagRecScarcityEntry) => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1])

function scarcityHeapPush(heap: TagRecScarcityEntry[], entry: TagRecScarcityEntry) {
  heap.push(entry)
  let i = heap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!scarcityHigher(heap[i], heap[p])) break
    ;[heap[i], heap[p]] = [heap[p], heap[i]]
    i = p
  }
}

function scarcityHeapPop(heap: TagRecScarcityEntry[]): TagRecScarcityEntry | undefined {
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let m = i
      if (l < heap.length && scarcityHigher(heap[l], heap[m])) m = l
      if (r < heap.length && scarcityHigher(heap[r], heap[m])) m = r
      if (m === i) break
      ;[heap[i], heap[m]] = [heap[m], heap[i]]
      i = m
    }
  }
  return top
}

/** 试验切换暂存: 候选条目表 + 重滤标记的值拷贝 (restore 原地清填, 实例身份不变) */
export type TagRecDeferredCandidatesSnapshot = {
  items: Map<string, TagRecItemExtend>
  needsRefilter: boolean
}

/**
 * [tag-rec] 写版本化数组: Proxy 只拦 set/deleteProperty (push/splice/unshift/length=0 全走这两个 trap),
 * 读路径 (get/迭代/原生方法) 不注册 trap 近似原生速度; 每次写 bump() —— 等长换血也无处可藏。
 */
export function tagRecVersionedArray<T>(bump: () => void, init: readonly T[] = []): T[] {
  return new Proxy([...init], {
    set: (target, prop, value) => (bump(), Reflect.set(target, prop, value)),
    deleteProperty: (target, prop) => (bump(), Reflect.deleteProperty(target, prop)),
  })
}

/**
 * [tag-rec] 数组→bvid 懒索引 (mergeIncoming 的 queued/heap 查找 O(items×len) → O(items)):
 * - map() 按 (数组身份, length, 写版本) 缓存 —— 传 version() 时等长换血也检出; 否则长度/身份兜底;
 * - 键域取 bvid 真值项 —— ItemsSeparator 这类无 bvid 元素自动跳过。
 */
export function createTagRecBvidIndex<T>(
  source: () => readonly T[],
  version?: () => number,
  keep: (it: T) => boolean = () => true,
) {
  let cache: { arr: readonly T[]; len: number; seq: number; map: Map<string, T> } | undefined
  return {
    map(): ReadonlyMap<string, T> {
      const arr = source()
      const seq = version?.() ?? -1
      if (!cache || cache.arr !== arr || cache.len !== arr.length || cache.seq !== seq) {
        const map = new Map<string, T>()
        for (const it of arr) {
          const bvid = (it as { bvid?: unknown }).bvid
          if (typeof bvid === 'string' && bvid && keep(it)) map.set(bvid, it)
        }
        cache = { arr, len: arr.length, seq, map }
      }
      return cache.map
    },
    invalidate: () => (cache = undefined),
  }
}

/** 当前语境内未交付的原料；阈值变化可以重评，存量按组与来源有界保留。 */
export class TagRecDeferredCandidates {
  private readonly items = new Map<string, TagRecItemExtend>()
  /** 复用设计 3: mergeIncoming 改过的排队条目待收编集 —— 不逐条 record (每条全池重建桶),
   *   下次 record 批一并入库, 容量整理只在批次末尾跑一次 */
  private readonly retouched = new Map<string, TagRecItemExtend>()
  /** 批化评分: mergeQueued 逐条 rank 的批化 —— 按 BV 去重收集本轮事实变过的排队条目,
   *   批末 (record/enqueueStock/flushMerged) 一次算分; 逐条算分在 200 重叠池下是 ~3k 次/轮 */
  private readonly dirty = new Map<string, TagRecItemExtend>()
  private dirtyRank?: (items: TagRecItemExtend[]) => TagRecItemExtend[]
  needsRefilter = false
  resolve?: TagRecScopeResolve

  constructor(
    private readonly perScope = 200,
    private readonly total = 2000,
  ) {}

  clear() {
    this.items.clear()
    this.retouched.clear()
    this.dirty.clear()
    this.dirtyRank = undefined
    this.needsRefilter = false
  }
  /** 待收编排队条目入库 (merge-or-add 同 record 逐条语义: 表内克隆同步新归因; 同对象免自并) */
  absorbRetouched() {
    if (!this.retouched.size) return
    for (const item of this.retouched.values()) {
      const existing = this.items.get(item.bvid)
      if (existing === item) continue
      if (existing) mergeTagRecCandidate(existing, item)
      else this.items.set(item.bvid, cloneDeep(item))
    }
    this.retouched.clear()
  }
  snapshot(): TagRecDeferredCandidatesSnapshot {
    this.flushMerged()
    this.absorbRetouched()
    return { items: cloneDeep(this.items), needsRefilter: this.needsRefilter }
  }
  restore(snap: TagRecDeferredCandidatesSnapshot) {
    this.items.clear()
    this.retouched.clear()
    this.dirty.clear()
    this.dirtyRank = undefined
    for (const [k, v] of snap.items) this.items.set(k, cloneDeep(v))
    this.needsRefilter = snap.needsRefilter
  }
  get size() {
    return this.items.size
  }
  values(): TagRecItemExtend[] {
    return [...this.items.values()]
  }

  record(items: readonly TagRecItemExtend[]) {
    this.flushMerged()
    this.absorbRetouched()
    for (const item of items) {
      const existing = this.items.get(item.bvid)
      if (existing) mergeTagRecCandidate(existing, item)
      else this.items.set(item.bvid, cloneDeep(item))
    }
    if (!this.items.size) return
    const scopes = new Map<string, Set<string>>()
    const dormant = new Map<string, Set<string>>()
    // bvid => 归属池倒排 (活跃/休眠同表): 淘汰按归属 O(度) 删 —— 原逐条全桶扫 O(桶数)×淘汰数
    const members = new Map<string, Set<Set<string>>>()
    const dormantPools = new Set<Set<string>>()
    for (const item of this.items.values()) {
      if (this.resolve) projectTagRecActiveClaims(item, this.resolve)
      const claims =
        item.activeSourceClaims?.length === 0
          ? tagRecSourceClaims(item)
          : (item.activeSourceClaims ?? tagRecSourceClaims(item))
      const target = item.activeSourceClaims?.length === 0 ? dormant : scopes
      const keys = new Set(
        claims.flatMap((claim) => {
          const owners = claim.input
            ? [tagRecGroupKey(undefined)]
            : claim.groupIds?.length
              ? claim.groupIds.map((id) => tagRecGroupKey({ id }))
              : (claim.groupNames.length ? claim.groupNames : ['']).map(tagRecGroupKey)
          return owners.map((owner) => JSON.stringify([owner, claim.via]))
        }),
      )
      for (const key of keys) {
        let bucket = target.get(key)
        if (!bucket) target.set(key, (bucket = new Set<string>()))
        bucket.add(item.bvid)
        let pools = members.get(item.bvid)
        if (!pools) members.set(item.bvid, (pools = new Set()))
        pools.add(bucket)
      }
    }
    for (const bucket of dormant.values()) dormantPools.add(bucket)
    const remove = (bvid: string) => {
      this.items.delete(bvid)
      for (const pool of members.get(bvid) ?? []) pool.delete(bvid)
      members.delete(bvid)
    }
    // 休眠原料有同样的单池上限，但不参与活跃稀缺保护。
    for (const bucket of dormant.values()) while (bucket.size > this.perScope) remove(bucket.values().next().value!)
    if (this.items.size > this.total)
      for (const item of this.items.values()) {
        if (this.items.size <= this.total) break
        if (item.activeSourceClaims?.length === 0) remove(item.bvid)
      }
    // 稀缺度 = 该条最浅活跃归属池深 (同 pickTagRecCapacityVictim 的 smallest-map 语义);
    // 惰性堆维护: 键是上界 (池深只降), 弹出重估降键回插, 键未降即真 argmax ——
    // 淘汰选择与逐条全池重扫完全同义, 但桶大小/稀缺度按批次维护不再逐条重算
    const scarcity = (bvid: string) => {
      let min = Infinity
      for (const pool of members.get(bvid) ?? []) if (!dormantPools.has(pool) && pool.size < min) min = pool.size
      return min
    }
    const pickers = new Map<Set<string>, () => string | undefined>()
    const pickerOf = (bucket: Set<string>) => {
      let pick = pickers.get(bucket)
      if (pick) return pick
      const heap: TagRecScarcityEntry[] = []
      let seq = 0
      for (const bvid of bucket) scarcityHeapPush(heap, [scarcity(bvid), seq++, bvid])
      pick = () => {
        while (heap.length) {
          const top = scarcityHeapPop(heap)!
          if (!bucket.has(top[2])) continue // 已被其它桶/路径淘汰
          const cur = scarcity(top[2])
          if (cur < top[0]) {
            scarcityHeapPush(heap, [cur, top[1], top[2]])
            continue
          }
          return top[2] // 键未降 ⇒ 当前真 argmax
        }
        return undefined
      }
      pickers.set(bucket, pick)
      return pick
    }
    for (const bucket of scopes.values())
      while (bucket.size > this.perScope) {
        const victim = pickerOf(bucket)()
        if (victim === undefined) break
        remove(victim)
      }
    // 总量超限先削最多的组×来源，给冷池保留独立储备。
    while (this.items.size > this.total) {
      let largest: Set<string> | undefined
      for (const pool of scopes.values()) if (pool.size > (largest?.size ?? 0)) largest = pool
      if (!largest?.size) break
      const victim = pickerOf(largest)()
      if (victim === undefined) break
      remove(victim)
    }
  }

  delivered(items: readonly RecItemTypeOrSeparator[]) {
    for (const item of items)
      if (item.api === EApiType.TagRec) {
        this.items.delete(item.bvid)
        this.retouched.delete(item.bvid)
        this.dirty.delete(item.bvid)
      }
    if (!this.dirty.size) this.dirtyRank = undefined
  }

  /** 队列/兜底堆之外的存在性查询 (hasPending 早退用): 已挡候选表内是否仍有该 BV */
  has(bvid: string) {
    return this.items.has(bvid)
  }

  /** mergeIncoming queued 分支复用 (入队门同款合并): 并发生产者窗口下重复到达并入存量而非复推/丢弃 */
  mergeQueued(
    queued: TagRecItemExtend,
    item: TagRecItemExtend,
    rank: (items: TagRecItemExtend[]) => TagRecItemExtend[],
  ) {
    mergeTagRecCandidate(queued, item)
    // 延迟收编: 表内克隆的归因同步与容量整理留给下次 record 一次做 (批内逐条 record 是 O(全池)×条数)
    this.retouched.set(queued.bvid, queued)
    this.needsRefilter = true
    // 延迟评分: 同 BV 重复到达每次即评是重叠池 CPU 热点 —— 标脏按 BV 去重, 批末 flushMerged 一次算
    this.dirty.set(queued.bvid, queued)
    this.dirtyRank = rank
  }

  /**
   * 批末一次评分 (mergeQueued 逐条 rank 的批化): 评分消费者 = 入队淘汰/切片排序/卡片字段,
   *   批内无读取 ⇒ record 入库点与 enqueueStock 收尾处调用; 中性/组中位回退按 flush 集合取
   *   (原逐条调用退化为条目自身, 批口径与整队重滤的中位语义更接近)
   */
  flushMerged() {
    if (!this.dirty.size) return
    const items = [...this.dirty.values()]
    const rank = this.dirtyRank
    this.dirty.clear()
    this.dirtyRank = undefined
    rank?.(items)
  }

  /**
   * 已排队只更新证据；被挡候选重新进阶段；已交付且不在存量中的 BV 不复活。
   * queue 传 bvid 索引 Map (createTagRecBvidIndex) 可省逐条全扫, 传数组回退线性查;
   * heapIndex 同理省兜底堆 findIndex。
   */
  mergeIncoming(
    item: TagRecItemExtend,
    queue: readonly RecItemTypeOrSeparator[] | ReadonlyMap<string, TagRecItemExtend>,
    rank: (items: TagRecItemExtend[]) => TagRecItemExtend[],
    heap: TagRecItemExtend[] = [],
    heapIndex?: ReadonlyMap<string, TagRecItemExtend>,
  ): TagRecItemExtend | undefined {
    const queued = Array.isArray(queue)
      ? (queue as RecItemTypeOrSeparator[]).find(
          (other): other is TagRecItemExtend => other.api === EApiType.TagRec && other.bvid === item.bvid,
        )
      : (queue as ReadonlyMap<string, TagRecItemExtend>).get(item.bvid)
    if (queued) {
      this.mergeQueued(queued, item, rank)
      return
    }
    const heapHit = heapIndex?.get(item.bvid)
    const at = heapIndex ? (heapHit ? heap.indexOf(heapHit) : -1) : heap.findIndex((other) => other.bvid === item.bvid)
    if (at !== -1) return mergeTagRecCandidate(heap.splice(at, 1)[0], item)
    const held = this.items.get(item.bvid)
    return held ? mergeTagRecCandidate(held, item) : undefined
  }
}
