import { tagRecCombinationRequiresUp, tagRecCombinationSeeds, tagRecConditionAtoms } from '../model/combination'
import { TAG_REC_ALL_POOL_KEYS, type TagRecChainKey, type TagRecScopeResolve } from '../model/filter-engine'
import { tagRecGroupKey } from '../model/relevance'
import type { TagRecDigStream } from '../model/dig'
import type { TagGroup } from '../model/types'
import type { TagRecRoundSource } from './_pipeline'

export type TagRecConsumer = {
  key: TagRecChainKey
  name: string
  input?: boolean
  queryKeyword?: string
  attributionLabels?: string[]
}
export type TagRecDigSource = Omit<TagRecDigStream, 'nextPage' | 'exhausted'>
export type UpSearchSource = TagRecRoundSource & { mid: number; keyword: string; consumers?: TagRecConsumer[] }
export type TagRecRecallPlan = {
  tagTop: (TagRecRoundSource & { consumers: TagRecConsumer[] })[]
  up: UpSearchSource[]
  dig: (TagRecDigSource & {
    exactConsumers: TagRecConsumer[]
    relatedConsumers: TagRecConsumer[]
    consumers: TagRecConsumer[]
  })[]
  archiveConsumers: TagRecConsumer[]
  blocked: { consumer: TagRecConsumer; reason: 'pools-off' | 'route-off' }[]
}

export function upSearchMids(resolve: TagRecScopeResolve, key: TagRecChainKey): number[] | undefined {
  const eff = resolve(key, 'allV2')
  if (eff.combination && tagRecCombinationRequiresUp(eff.combination)) {
    const ups = tagRecCombinationSeeds(eff.combination).ups
    if (ups.length && ups.every((entry) => Number.isSafeInteger(entry.mid) && entry.mid! > 0))
      return [...new Set(ups.map((entry) => entry.mid!))]
  }
  const allow = eff.cfg.enabled ? eff.neg.upAllow?.list : undefined
  if (!allow?.length || allow.some((it) => !Number.isSafeInteger(it.mid) || it.mid! <= 0)) return
  return [...new Set(allow.map((it) => it.mid!))]
}

/**
 * 源的消费者集。`input: true` 的源通常只有输入消费者 (key=undefined) —— 但深挖流表里
 * 锚点流会被同名「组簇流」就地合并 (ensureCliqueStreams 按 streamIdentity 撞车合并,
 * 只并 attribution/groupIds, 不翻 input 位): 合并后该流同时服务「输入词」与「组」两个消费者。
 * 若仍只返回输入消费者, 工作台切换 (inputText 清空、组消费者就位) 后本流会因消费者不在
 * 作用域内被 plannedStream 判为不可挖 —— 深挖整链静默停摆, 小池只剩 tag/top 那几条
 * (实机 kingexit: 10 条后硬见底, 搜索池 0 请求)。故 input 源带 groupIds 时两者都返回。
 */
export function tagRecConsumers(source: {
  groupIds?: string[]
  groupNames?: string[]
  attribution?: string[]
  input?: boolean
  attributionLabels?: string[]
}): TagRecConsumer[] {
  const names = source.groupNames ?? source.attribution ?? []
  const groupConsumers: TagRecConsumer[] = source.groupIds?.length
    ? source.groupIds.map((id, i) => ({
        key: { id },
        name: names[i] ?? '',
        attributionLabels: source.attributionLabels,
      }))
    : (names.length ? names : ['']).map((name) => ({
        key: name || undefined,
        name,
        attributionLabels: source.attributionLabels,
      }))
  if (source.input)
    return [
      { key: undefined, name: names[0] ?? '', input: true, attributionLabels: source.attributionLabels },
      ...(source.groupIds?.length ? groupConsumers : []),
    ]
  return groupConsumers
}
export function mergeTagRecConsumers(consumers: readonly TagRecConsumer[]): TagRecConsumer[] {
  return [...new Map(consumers.map((c) => [tagRecGroupKey(c.key), c])).values()]
}
export function tagRecConsumerSource(consumers: readonly TagRecConsumer[]) {
  return {
    groupNames: consumers.map((c) => c.name).filter(Boolean),
    groupIds: consumers.flatMap((c) => (typeof c.key === 'object' && c.key?.id ? [c.key.id] : [])),
    ...(consumers.every((c) => c.input) ? { input: true } : {}),
  }
}

export function tagRecSourceSignature(consumers: readonly TagRecConsumer[], resolve: TagRecScopeResolve) {
  return JSON.stringify(
    mergeTagRecConsumers(consumers)
      .map((c) => {
        const pools = resolve(c.key, 'allV2').poolsEnabled
        return [tagRecGroupKey(c.key), upSearchMids(resolve, c.key) ?? null, TAG_REC_ALL_POOL_KEYS.map((p) => pools[p])]
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
}
export function tagRecReopenedTopTids(previous: string | undefined, next: string, groups: readonly TagGroup[]) {
  if (!previous || previous === next) return []
  const before = new Map<string, boolean>(
    (JSON.parse(previous) as [string, number[] | null, boolean[]][]).map(([key, route, pools]) => [
      key,
      !route && pools[0],
    ]),
  )
  const reopened = new Set(
    (JSON.parse(next) as [string, number[] | null, boolean[]][])
      .filter(([key, route, pools]) => !route && pools[0] && before.get(key) !== true)
      .map(([key]) => key),
  )
  return groups.filter((g) => reopened.has(tagRecGroupKey({ id: g.id }))).flatMap((g) => g.tag_ids.map((e) => e.id))
}

/** 先逐消费者求路线和来源，再合并物理请求；兼容旧 shallow 数组调用。 */
export function planTagRecRecall(
  input:
    | readonly TagRecRoundSource[]
    | {
        roundSources: readonly TagRecRoundSource[]
        digSources?: readonly TagRecDigSource[]
        scopeConsumers?: readonly TagRecConsumer[]
      },
  resolve: TagRecScopeResolve,
): TagRecRecallPlan {
  const {
    roundSources,
    digSources = [],
    scopeConsumers,
  } = Array.isArray(input)
    ? { roundSources: input as readonly TagRecRoundSource[], digSources: [], scopeConsumers: undefined }
    : (input as {
        roundSources: readonly TagRecRoundSource[]
        digSources?: readonly TagRecDigSource[]
        scopeConsumers?: readonly TagRecConsumer[]
      })
  const top = new Map<number, TagRecRecallPlan['tagTop'][number]>()
  const up = new Map<string, UpSearchSource>()
  const dig = new Map<string, TagRecRecallPlan['dig'][number]>()
  const scope = mergeTagRecConsumers(scopeConsumers ?? [...roundSources, ...digSources].flatMap(tagRecConsumers))
  const result: TagRecRecallPlan = { tagTop: [], up: [], dig: [], archiveConsumers: [], blocked: [] }
  const ordinary = (c: TagRecConsumer) => !upSearchMids(resolve, c.key)
  for (const c of scope) {
    const pools = resolve(c.key, 'allV2').poolsEnabled
    if (!ordinary(c)) {
      if (!pools.allV2) result.blocked.push({ consumer: c, reason: 'route-off' })
    } else {
      if (pools.archiveRelated) result.archiveConsumers.push(c)
      if (TAG_REC_ALL_POOL_KEYS.every((p) => !pools[p])) result.blocked.push({ consumer: c, reason: 'pools-off' })
    }
    const combination = resolve(c.key, 'allV2').combination
    if (combination && pools.allV2) {
      const seeds = tagRecCombinationSeeds(combination)
      for (const owner of seeds.ups)
        if (owner.mid)
          // Tags and partitions need real content evidence; their names are not
          // necessarily present in the author's searchable text.
          for (const keyword of tagRecCombinationRequiresUp(combination) &&
          !seeds.tags.length &&
          !tagRecConditionAtoms(combination.include).some((atom) => atom.field === 'partition')
            ? seeds.keywords
            : ['']) {
            const identity = JSON.stringify([owner.mid, keyword])
            const old = up.get(identity)
            const consumers = mergeTagRecConsumers([...(old?.consumers ?? []), c])
            up.set(identity, { tid: 0, mid: owner.mid, keyword, ...tagRecConsumerSource(consumers), consumers })
          }
    }
  }
  for (const source of roundSources)
    for (const rawConsumer of tagRecConsumers(source)) {
      const c = {
        ...rawConsumer,
        queryKeyword: source.keyword,
        name:
          typeof rawConsumer.key === 'object' && rawConsumer.key?.id
            ? (resolve(rawConsumer.key, 'allV2').groupName ?? rawConsumer.name)
            : rawConsumer.name,
      }
      const pools = resolve(c.key, 'allV2').poolsEnabled
      const mids = upSearchMids(resolve, c.key)
      if (mids) {
        if (!pools.allV2 || !source.keyword?.trim()) continue
        for (const mid of mids) {
          const keyword = source.keyword.trim()
          const key = JSON.stringify([mid, keyword])
          const old = up.get(key)
          const consumers = mergeTagRecConsumers([...(old?.consumers ?? []), c])
          up.set(key, { ...source, mid, keyword, ...tagRecConsumerSource(consumers), consumers })
        }
      } else if (pools.tagTop) {
        const old = top.get(source.tid)
        const consumers = mergeTagRecConsumers([...(old?.consumers ?? []), c])
        top.set(source.tid, {
          ...source,
          ...tagRecConsumerSource(consumers),
          consumers,
          attributionLabels: [...new Set(consumers.flatMap((v) => v.attributionLabels ?? []))],
        })
      }
    }
  for (const source of digSources) {
    const consumers = tagRecConsumers(source).filter(ordinary)
    const exact = consumers.filter((c) => resolve(c.key, 'allV2').poolsEnabled.allV2)
    const related = consumers.filter((c) => resolve(c.key, 'allV2Related').poolsEnabled.allV2Related)
    if (!exact.length && !related.length) continue
    // 实际关键词保护：同 norm 不同原文不共享续页状态。
    const identity = JSON.stringify([source.key, source.keyword])
    const old = dig.get(identity)
    const exactConsumers = mergeTagRecConsumers([...(old?.exactConsumers ?? []), ...exact])
    const relatedConsumers = mergeTagRecConsumers([...(old?.relatedConsumers ?? []), ...related])
    const all = mergeTagRecConsumers([...exactConsumers, ...relatedConsumers])
    dig.set(identity, {
      ...source,
      ...tagRecConsumerSource(all),
      attribution: [...new Set(all.map((c) => c.name).filter(Boolean))],
      consumers: all,
      exactConsumers,
      relatedConsumers,
    })
  }
  return { ...result, tagTop: [...top.values()], up: [...up.values()], dig: [...dig.values()] }
}
