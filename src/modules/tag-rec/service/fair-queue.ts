import { EApiType } from '$enums'
import { TAG_GROUP_WEIGHT_MAX } from '../model/favorites'
import { tagRecGroupKey } from '../model/relevance'
import { compareTagRecGroupItems, compareTagRecItems } from './item-order'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagRecDiversityGuardSettings } from '../model/filter-engine'
import type { TagGroup, TagL1Group } from '../model/types'

type Unit = { id: string; weight: number }
type FairTurn = {
  item: RecItemTypeOrSeparator
  group?: TagGroup
  parents: Unit[]
  children: Unit[]
  groups?: readonly TagGroup[]
  readyGroups?: readonly TagGroup[]
  l1s?: ReadonlyMap<string, TagL1Group>
}

/** 加权轮转按实际交付记账；空库存不积累欠额。 */
export class WeightedTurns {
  readonly credits = new Map<string, number>()

  advance(units: readonly Unit[], chosen?: string): string {
    const live = new Set(units.map((u) => u.id))
    for (const id of this.credits.keys()) if (!live.has(id)) this.credits.delete(id)
    let best = units[0].id
    let total = 0
    for (const u of units) {
      const weight = Math.min(TAG_GROUP_WEIGHT_MAX, Math.max(1, Math.floor(u.weight) || 1))
      total += weight
      this.credits.set(u.id, (this.credits.get(u.id) ?? 0) + weight)
      if (this.credits.get(u.id)! > this.credits.get(best)!) best = u.id
    }
    const id = chosen ?? best
    this.credits.set(id, this.credits.get(id)! - total)
    return id
  }
}

/** 与库存同会话共享，普通刷新不会重置已交付份额。 */
export class TagRecFairState {
  private readonly parents = new WeightedTurns()
  private readonly children = new Map<string, WeightedTurns>()

  clear() {
    this.parents.credits.clear()
    this.children.clear()
  }

  private inner(parentId: string) {
    let turns = this.children.get(parentId)
    if (!turns) this.children.set(parentId, (turns = new WeightedTurns()))
    return turns
  }

  clone(): TagRecFairState {
    const copy = new TagRecFairState()
    for (const [id, credit] of this.parents.credits) copy.parents.credits.set(id, credit)
    for (const [parent, turns] of this.children)
      for (const [id, credit] of turns.credits) copy.inner(parent).credits.set(id, credit)
    return copy
  }

  pick(groups: readonly TagGroup[], l1s: ReadonlyMap<string, TagL1Group>): Omit<FairTurn, 'item'> {
    const parents = [...new Set(groups.map((g) => g.l1Id!))].map((id) => ({ id, weight: l1s.get(id)!.weight }))
    const parentId = this.parents.advance(parents)
    const children = groups.filter((g) => g.l1Id === parentId).map((g) => ({ id: g.id, weight: g.weight }))
    const groupId = this.inner(parentId).advance(children)
    return { group: groups.find((g) => g.id === groupId)!, parents, children }
  }

  commit(turns: readonly FairTurn[], delivered: ReadonlySet<RecItemTypeOrSeparator>) {
    for (const turn of turns) {
      if (!turn.group || !delivered.has(turn.item)) continue
      let group = turn.group
      if (turn.item.api === EApiType.TagRec && turn.item.eligibleGroupKeys) {
        const keys = turn.item.eligibleGroupKeys
        const allowed = (g: TagGroup) =>
          keys.includes(tagRecGroupKey({ id: g.id })) || keys.includes(tagRecGroupKey(g.name))
        if (!allowed(group)) {
          const alternate = turn.groups?.find(allowed)
          if (!alternate) continue
          group = alternate
        }
      }
      const assigned = assignTurnGroup(turn, group)
      this.parents.advance(assigned.parents, group.l1Id!)
      this.inner(group.l1Id!).advance(assigned.children, group.id)
    }
  }
}

/** 每条视频只存一份；多归因条目的调度归属不改动完整的过滤/卡片归因。 */
function partitionStock(queue: readonly RecItemTypeOrSeparator[], groups: readonly TagGroup[]) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const byName = new Map(groups.map((g) => [g.name, g]))
  const buckets = new Map<string, TagRecItemExtend[]>()
  const other: RecItemTypeOrSeparator[] = []
  for (const item of queue) {
    if (item.api !== EApiType.TagRec) {
      other.push(item)
      continue
    }
    const claimed = item.source.groupIds?.length
      ? item.source.groupIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      : item.source.groupNames.flatMap((name) => {
          const g = byName.get(name.replace(/·相关$/, ''))
          return g ? [g] : []
        })
    const owners = claimed.filter(
      (g) =>
        !item.eligibleGroupKeys ||
        item.eligibleGroupKeys.includes(tagRecGroupKey({ id: g.id })) ||
        item.eligibleGroupKeys.includes(tagRecGroupKey(g.name)),
    )
    if (!owners.length) {
      if (item.eligibleGroupKeys?.length !== 0 && item.activeSourceClaims?.length !== 0) other.push(item)
      continue
    }
    const owner = owners.reduce((best, g) =>
      (buckets.get(g.id)?.length ?? 0) / g.weight < (buckets.get(best.id)?.length ?? 0) / best.weight ? g : best,
    )
    let bucket = buckets.get(owner.id)
    if (!bucket) buckets.set(owner.id, (bucket = []))
    bucket.push(item)
  }
  return { buckets, other }
}

function activeGroupIds(item: TagRecItemExtend): string[] {
  const claims = item.activeSourceClaims ?? item.source.claims ?? [item.source]
  const ids = [...new Set(claims.flatMap((claim) => (claim.input ? [] : (claim.groupIds ?? []))))]
  return ids.filter((id) => !item.eligibleGroupKeys || item.eligibleGroupKeys.includes(tagRecGroupKey({ id })))
}

export function tagRecStockCounts(queue: readonly RecItemTypeOrSeparator[], groups: readonly TagGroup[]) {
  return new Map([...partitionStock(queue, groups).buckets].map(([id, items]) => [id, items.length]))
}

/** 先预演再严格校验；中止不移除库存，拒绝条目不消耗展示份额。 */
export function previewTagRecFairSlice(
  queue: readonly RecItemTypeOrSeparator[],
  groups: readonly TagGroup[],
  l1s: readonly TagL1Group[],
  state: TagRecFairState,
  count: number,
  guard?: TagRecDiversityGuardSettings,
  preceding: readonly RecItemTypeOrSeparator[] = [],
): { items: RecItemTypeOrSeparator[]; turns: FairTurn[] } {
  const parents = new Map(l1s.map((l) => [l.id, l]))
  const eligible = groups.filter((g) => g.l1Id && parents.has(g.l1Id))
  const { buckets, other } = partitionStock(queue, eligible)
  for (const [id, bucket] of buckets) bucket.sort((a, b) => compareTagRecGroupItems(id, a, b))
  const draft = state.clone()
  const turns: FairTurn[] = []
  const groupCounts = new Map<string, number>()
  const upCounts = new Map<number, number>()
  for (const item of preceding) {
    if (item.api !== EApiType.TagRec) continue
    for (const id of activeGroupIds(item)) groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1)
    if (item.owner?.mid !== undefined) upCounts.set(item.owner.mid, (upCounts.get(item.owner.mid) ?? 0) + 1)
  }
  const groupMax = Math.max(1, Math.floor((count + preceding.length) * (guard?.group?.maxShare ?? 0.6)))
  const upMax = Math.max(1, guard?.up?.max ?? 4)
  const allowedUp = (item: TagRecItemExtend) =>
    !guard?.up?.enabled || item.owner?.mid === undefined || (upCounts.get(item.owner.mid) ?? 0) < upMax
  const allowed = (item: TagRecItemExtend) =>
    (!guard?.group?.enabled || activeGroupIds(item).every((id) => (groupCounts.get(id) ?? 0) < groupMax)) &&
    allowedUp(item)
  while (turns.length < count) {
    const ready = eligible.filter((g) => buckets.get(g.id)?.length)
    if (!ready.length) break
    let match = allowed
    let guarded = ready.filter((g) => buckets.get(g.id)!.some(match))
    if (!guarded.length) {
      // 组占比与 UP 限额冲突时，先用其他 UP 补位，再放宽 UP 限额。
      match = allowedUp
      guarded = ready.filter((g) => buckets.get(g.id)!.some(match))
    }
    // 护栏是有替代内容时的限制；只剩一组/UP 时仍可补满。
    const turn = draft.pick(guarded.length ? guarded : ready, parents)
    const bucket = buckets.get(turn.group!.id)!
    const at = guarded.length ? bucket.findIndex(match) : 0
    const [item] = bucket.splice(at, 1)
    for (const id of activeGroupIds(item)) groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1)
    if (item.owner?.mid !== undefined) upCounts.set(item.owner.mid, (upCounts.get(item.owner.mid) ?? 0) + 1)
    turns.push({ ...turn, item, groups: eligible, readyGroups: guarded.length ? guarded : ready, l1s: parents })
  }
  for (const item of other.slice(0, count - turns.length)) turns.push({ item, parents: [], children: [] })
  return { items: turns.map((t) => t.item), turns }
}

function assignTurnGroup(turn: FairTurn, group: TagGroup): FairTurn {
  let parents = turn.parents
  if (!parents.some((p) => p.id === group.l1Id))
    parents = [...parents, { id: group.l1Id!, weight: turn.l1s?.get(group.l1Id!)?.weight ?? 1 }]
  let children =
    turn.group?.l1Id === group.l1Id
      ? turn.children
      : (turn.readyGroups ?? []).filter((g) => g.l1Id === group.l1Id).map((g) => ({ id: g.id, weight: g.weight }))
  if (!children.some((g) => g.id === group.id)) children = [...children, { id: group.id, weight: group.weight }]
  return { ...turn, group, parents, children }
}

/** 补查后只在已有组名额内重排，不用切片大小重新计算公平欠额。 */
export function rankTagRecFairSlice(turns: readonly FairTurn[], checked: readonly RecItemTypeOrSeparator[]) {
  const byBvid = new Map(checked.flatMap((item) => (item.api === EApiType.TagRec ? [[item.bvid, item] as const] : [])))
  const retained = new Set(checked)
  const passed = turns.flatMap<FairTurn>((turn) => {
    if (turn.item.api !== EApiType.TagRec) return retained.has(turn.item) ? [turn] : []
    const item = byBvid.get(turn.item.bvid)
    if (!item) return []
    const keys = item.eligibleGroupKeys
    if (keys?.length === 0) return []
    const allowed = (g: TagGroup) =>
      !keys || keys.includes(tagRecGroupKey({ id: g.id })) || keys.includes(tagRecGroupKey(g.name))
    const group = turn.group && !allowed(turn.group) ? turn.groups?.find(allowed) : turn.group
    if (turn.group && !group) return []
    const updated = { ...turn, item }
    return [group ? assignTurnGroup(updated, group) : updated]
  })
  const buckets = new Map<string, TagRecItemExtend[]>()
  for (const turn of passed) {
    if (turn.item.api !== EApiType.TagRec) continue
    const id = turn.group?.id ?? ''
    const bucket = buckets.get(id) ?? []
    bucket.push(turn.item)
    buckets.set(id, bucket)
  }
  for (const [id, bucket] of buckets) bucket.sort(id ? (a, b) => compareTagRecGroupItems(id, a, b) : compareTagRecItems)
  const ranked = passed.map((turn) =>
    turn.item.api === EApiType.TagRec ? { ...turn, item: buckets.get(turn.group?.id ?? '')!.shift()! } : turn,
  )
  return { items: ranked.map((turn) => turn.item), turns: ranked }
}

/** 深挖与主轮共用库存总量上限；组低水位目标与补货高水位闸同用此口径做联合可达性折算。 */
export const TAG_REC_STOCK_TOTAL = 5000

/** 深挖与主轮共用库存边界；淘汰的未展示候选退还取数去重资格。 */
export function trimTagRecStock(
  queue: RecItemTypeOrSeparator[],
  groups: readonly TagGroup[],
  perGroup = 1000,
  total = TAG_REC_STOCK_TOTAL,
): TagRecItemExtend[] {
  const { buckets } = partitionStock(queue, groups)
  const evicted = new Set<TagRecItemExtend>()
  for (const [id, bucket] of buckets) {
    bucket.sort((a, b) => compareTagRecGroupItems(id, a, b))
    for (const item of bucket.slice(perGroup)) evicted.add(item)
  }
  // 总量满时先削最大库存，避免一个组排掉其他组的全部储备。
  const assigned = new Set([...buckets.values()].flat())
  // Orphaned and dormant videos still occupy memory. Keep a fallback bucket so
  // they share the global bound, without charging separators against video capacity.
  const videos = queue.filter((item): item is TagRecItemExtend => item.api === EApiType.TagRec)
  const unassigned = videos.filter((item) => !assigned.has(item)).sort(compareTagRecItems)
  let remaining = videos.length - evicted.size
  const sizes = [...buckets.values(), unassigned].map((items) => items.filter((it) => !evicted.has(it)))
  while (remaining > total) {
    const largest = sizes.reduce((best, items) => (items.length > best.length ? items : best), [] as TagRecItemExtend[])
    const item = largest.pop()
    if (!item) break
    evicted.add(item)
    remaining--
  }
  if (evicted.size) {
    let write = 0
    for (const item of queue) {
      if (item.api === EApiType.TagRec && evicted.has(item)) continue
      if (queue[write] !== item) queue[write] = item
      write++
    }
    queue.length = write
  }
  return [...evicted]
}

/**
 * 组合组内原子级公平选片 (同 TagRecFairState 的欠额记账): 条目按当前组合下命中的条件原子分桶,
 * 多命中条归当前最短板 (同 partitionStock 哲学), 桶内先按质量序, 再欠额轮转取条 ——
 * 新加的条件原子不再被源序/命中数压在队尾。只决定展示顺序, 不触碰判定/证据语义;
 * 无命中条不参与轮转, 兜底按原序补足。原地移除已取条目 (同 splice 语义)。
 */
export function spliceTagRecAtomFairSlice(
  working: RecItemTypeOrSeparator[],
  count: number,
  turns: WeightedTurns,
  atomKeysOf: (item: TagRecItemExtend) => readonly string[],
  guard?: TagRecDiversityGuardSettings,
): RecItemTypeOrSeparator[] {
  const buckets = new Map<string, RecItemTypeOrSeparator[]>()
  for (const item of working) {
    if (item.api !== EApiType.TagRec) continue
    const keys = atomKeysOf(item)
    if (!keys.length) continue
    const owner = keys.reduce((best, key) =>
      (buckets.get(key)?.length ?? 0) < (buckets.get(best)?.length ?? 0) ? key : best,
    )
    const bucket = buckets.get(owner) ?? []
    bucket.push(item)
    buckets.set(owner, bucket)
  }
  for (const bucket of buckets.values()) (bucket as TagRecItemExtend[]).sort((a, b) => compareTagRecItems(a, b))
  const picked = new Set<RecItemTypeOrSeparator>()
  const out: RecItemTypeOrSeparator[] = []
  // UP 多样性顺延 (同 previewTagRecFairSlice 语义): 有替代条时跳过已满额 UP, 无替代照常补满不砍供给
  const upMax = Math.max(1, guard?.up?.max ?? 4)
  const upCounts = new Map<number, number>()
  const allowedUp = (item: RecItemTypeOrSeparator) =>
    !guard?.up?.enabled ||
    item.api !== EApiType.TagRec ||
    item.owner?.mid === undefined ||
    (upCounts.get(item.owner.mid) ?? 0) < upMax
  while (out.length < count) {
    const ready = [...buckets].filter(([, bucket]) => bucket.length)
    if (!ready.length) break
    const guarded = ready.filter(([, bucket]) => (bucket as TagRecItemExtend[]).some(allowedUp))
    const pool = guarded.length ? guarded : ready
    const id = turns.advance(pool.map(([id]) => ({ id, weight: 1 })))
    const bucket = buckets.get(id)!
    const at = guarded.length ? (bucket as TagRecItemExtend[]).findIndex(allowedUp) : 0
    const [item] = bucket.splice(at, 1)
    picked.add(item)
    out.push(item)
    if (item.api === EApiType.TagRec && item.owner?.mid !== undefined)
      upCounts.set(item.owner.mid, (upCounts.get(item.owner.mid) ?? 0) + 1)
  }
  for (const item of working) {
    if (out.length >= count) break
    if (!picked.has(item)) {
      picked.add(item)
      out.push(item)
    }
  }
  for (let i = working.length - 1; i >= 0; i--) if (picked.has(working[i])) working.splice(i, 1)
  return out
}
