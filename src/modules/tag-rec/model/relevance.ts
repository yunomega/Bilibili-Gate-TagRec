import { mergeTagRecPartitionFields } from './partition'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend, TagRecRelevance, TagRecSourceClaim } from '$define'
import type { TagIdEntry } from './types'

export type TagRecAttributionKey = string | { id?: string; name?: string } | undefined

export function tagRecGroupKey(key: TagRecAttributionKey): string {
  return typeof key === 'string'
    ? `name:${key.replace(/·相关$/, '')}`
    : key?.id
      ? `id:${key.id}`
      : `name:${key?.name ?? ''}`
}

export function tagRecSourceClaims(item: TagRecItemExtend): readonly TagRecSourceClaim[] {
  return item.source.claims ?? [{ ...item.source, srcRank: item.srcRank }]
}

export function tagRecClaimsForGroup(item: TagRecItemExtend, key?: TagRecAttributionKey): readonly TagRecSourceClaim[] {
  const claims = item.activeSourceClaims ?? tagRecSourceClaims(item)
  if (key === undefined) return claims
  const name = typeof key === 'string' ? key.replace(/·相关$/, '') : key.name
  return claims.filter((claim) =>
    typeof key !== 'string' && key.id
      ? claim.groupIds?.includes(key.id)
      : claim.groupNames.some((n) => n.replace(/·相关$/, '') === name),
  )
}

/** 标签命中强于标题命中；归因名、播放量和完整统计不构成相关性证据。 */
export function tagRecRelevanceOf(
  item: TagRecItemExtend,
  entries: readonly TagIdEntry[],
  key?: TagRecAttributionKey,
): TagRecRelevance {
  const claims = tagRecClaimsForGroup(item, key)
  const ids = new Map(entries.map((entry) => [entry.id, normalizeTagName(entry.name) || `id:${entry.id}`]))
  const names = new Set(entries.map((entry) => normalizeTagName(entry.name)).filter(Boolean))
  for (const claim of claims) {
    if (claim.queryKeyword) names.add(normalizeTagName(claim.queryKeyword))
  }
  const hits = new Set<string>()
  for (const id of item.ownTagIds ?? []) if (ids.has(id)) hits.add(ids.get(id)!)
  for (const name of item.ownTagNames ?? []) {
    const norm = normalizeTagName(name)
    if (names.has(norm)) hits.add(norm)
  }
  for (const claim of claims) {
    if (claim.via !== 'tag-top') continue
    for (const id of claim.tagIds ?? []) {
      if (!entries.length || ids.has(id)) hits.add(ids.get(id) ?? `id:${id}`)
    }
  }
  if (hits.size) return { tier: 2, hits: hits.size }
  const title = normalizeTagName(item.title)
  const titleHits = [...names].filter((name) => name.length >= 2 && title.includes(name)).length
  return titleHits ? { tier: 1, hits: titleHits } : { tier: 0, hits: 0 }
}

export function compareTagRecRelevance(a?: TagRecRelevance, b?: TagRecRelevance): number {
  return (b?.tier ?? 0) - (a?.tier ?? 0) || (b?.hits ?? 0) - (a?.hits ?? 0)
}

/** 认领链身份串按对象记忆: claim 对象在反复合并中是稳定引用 (数组整体替换不原地改),
 *   同对象 stringify 只付一次 —— 重叠池逐到达合并的 claim 去重大头在此 */
const claimIdentities = new WeakMap<TagRecSourceClaim, string>()
const claimIdentity = (claim: TagRecSourceClaim) => {
  let key = claimIdentities.get(claim)
  if (key === undefined) {
    const { srcRank: _rank, ...identity } = claim
    claimIdentities.set(claim, (key = JSON.stringify(identity)))
  }
  return key
}

/** 同 BV 的新标签命中会提升旧候选，同时保留原始统计、所有归因与召回记录。 */
export function mergeTagRecCandidate(target: TagRecItemExtend, incoming: TagRecItemExtend): TagRecItemExtend {
  const fields = mergeTagRecPartitionFields(target, {
    tid: incoming.tid,
    tidv2: incoming.tidv2,
    tnamev2: incoming.tnamev2,
    pid_v2: incoming.pid_v2,
    pid_name_v2: incoming.pid_name_v2,
  })
  for (const field of ['tid', 'tidv2', 'tnamev2', 'pid_v2', 'pid_name_v2'] as const)
    Object.assign(target, { [field]: fields[field] })
  // 审计 §5: 同 BV 后到的更完整行补齐内容字段 —— 列表型接口行级数据缺简介/UP/时长时,
  //   详情/证据共享过的完整回包回填空缺, 旧行为把这些字段直接扔掉
  for (const field of ['desc', 'owner', 'duration', 'pubdate', 'aid', 'cid'] as const) {
    if (target[field] === undefined && incoming[field] !== undefined)
      Object.assign(target, { [field]: incoming[field] })
  }
  const evidenceRank = { missing: 1, partial: 2, complete: 3 } as const
  for (const field of ['title', 'desc'] as const) {
    const inc = incoming.fieldEvidence?.[field]
    if (inc === undefined) continue
    const cur = target.fieldEvidence?.[field]
    // 与 mergeTagRecVideoEvidence 同规则: 弱证据 (missing) 只补空位不降级; 强证据 (complete)
    //   升级时连带覆盖字段值 —— 详情回包的完整标题/简介盖掉行级残缺版
    if (cur !== undefined && evidenceRank[inc] <= evidenceRank[cur]) continue
    target.fieldEvidence = { ...target.fieldEvidence, [field]: inc }
    if (inc === 'complete' && incoming[field] !== undefined) target[field] = incoming[field]
  }
  const claims = [...tagRecSourceClaims(target), ...tagRecSourceClaims(incoming)]
  target.source.claims = [...new Map(claims.map((claim) => [claimIdentity(claim), claim] as const)).values()]
  const pairs = new Map<string, string>()
  for (const source of [target.source, incoming.source])
    source.groupIds?.forEach((id, i) => pairs.set(id, source.groupNames[i] ?? id))
  if (pairs.size) {
    target.source.groupIds = [...pairs.keys()]
    target.source.groupNames = [...pairs.values()]
  } else target.source.groupNames = [...new Set([...target.source.groupNames, ...incoming.source.groupNames])]
  target.source.tagIds = [...new Set([...(target.source.tagIds ?? []), ...(incoming.source.tagIds ?? [])])]
  if (incoming.ownTagNames) target.ownTagNames = [...new Set([...(target.ownTagNames ?? []), ...incoming.ownTagNames])]
  if (incoming.ownTagIds) target.ownTagIds = [...new Set([...(target.ownTagIds ?? []), ...incoming.ownTagIds])]
  for (const [key, value] of Object.entries(incoming.stat)) {
    if (value !== undefined) Object.assign(target.stat, { [key]: value })
  }
  const priority = (via: TagRecItemExtend['source']['via']) =>
    via === 'tag-top' || via === 'all-v2-exact' ? 2 : via === 'up-search' ? 1 : 0
  if (priority(incoming.source.via) > priority(target.source.via)) {
    target.source.via = incoming.source.via
    target.source.queryKeyword = incoming.source.queryKeyword
    target.srcRank = incoming.srcRank
  }
  target.partial = undefined
  target.relevance = undefined
  target.relevanceByGroup = undefined
  target.qualitySortScore = undefined
  target.qualityByGroup = undefined
  target.activeSourceClaims = undefined
  target.eligibleGroupKeys = undefined
  target.eligiblePoolScopes = undefined
  return target
}
