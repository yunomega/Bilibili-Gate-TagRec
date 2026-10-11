import { cloneDeep } from 'es-toolkit'
import { dedupeTagIdEntries, groupNegativeTagIds, setGroupNegativeTagIds } from './favorites'
import type { TagRecGroupOverrides } from './filter-engine'
import type { TagGroup, TagRecNegativeRules } from './types'

const unionBy = <T>(a: readonly T[] = [], b: readonly T[] = [], key: (value: T) => string | number): T[] => {
  const seen = new Set<string | number>()
  return [...a, ...b].filter((v) => !seen.has(key(v)) && !!seen.add(key(v))).map((v) => cloneDeep(v))
}

function foldPartition(n: TagRecNegativeRules = {}): TagRecNegativeRules {
  const out = cloneDeep(n)
  if (out.partition?.mode === 'block') out.partitionBlock = [...(out.partitionBlock ?? []), ...out.partition.list]
  else if (out.partition?.mode === 'allow' && out.partitionAllow === undefined) {
    out.partitionAllow = { enabled: true, list: out.partition.list }
  }
  delete out.partition
  for (const key of Object.keys(out)) {
    if ((out as Record<string, unknown>)[key] === undefined) delete (out as Record<string, unknown>)[key]
  }
  return out
}

function mergeNegative(dst: TagRecNegativeRules | undefined, src: TagRecNegativeRules | undefined) {
  if (!dst && !src) return undefined
  const x = foldPartition(dst)
  const y = foldPartition(src)
  const out: TagRecNegativeRules = { ...y, ...x }
  if (x.tagIds || y.tagIds) out.tagIds = unionBy(x.tagIds, y.tagIds, (e) => e.id)
  if (x.up || y.up)
    out.up = unionBy(x.up, y.up, (e) => (e.mid !== undefined ? `mid:${e.mid}` : `name:${e.name.trim().toLowerCase()}`))
  for (const key of ['title', 'desc'] as const)
    if (x[key] || y[key]) out[key] = unionBy(x[key], y[key], (e) => e.trim().toLowerCase())
  if (x.partitionBlock || y.partitionBlock)
    out.partitionBlock = unionBy(x.partitionBlock, y.partitionBlock, (e) => `${e.v1 ?? ''}|${e.v2 ?? ''}`)
  if (x.tagBlock || y.tagBlock) {
    out.tagBlock = {
      enabled: x.tagBlock?.enabled ?? y.tagBlock?.enabled ?? false,
      strict: x.tagBlock?.strict ?? y.tagBlock?.strict,
      list: unionBy(x.tagBlock?.list, y.tagBlock?.list, (e) => e.id),
    }
  }
  return out
}

/** 各入口共用：目标显式值优先，按维度/字段补缺项，屏蔽名单并集、仅看整项保留目标。 */
export function mergeTagRecGroupOverrides(
  dst: TagRecGroupOverrides | undefined,
  src: TagRecGroupOverrides | undefined,
): TagRecGroupOverrides | undefined {
  if (!dst && !src) return undefined
  const out = cloneDeep(dst ?? {})
  if (!src) return out
  const neg = mergeNegative(dst?.negative, src.negative)
  if (neg) out.negative = neg
  if (src.dims) out.dims = { ...cloneDeep(src.dims), ...out.dims }
  if (src.score) {
    out.score ??= {}
    if (src.score.weights) out.score.weights = { ...cloneDeep(src.score.weights), ...out.score.weights }
    if (src.score.anchors) out.score.anchors = { ...cloneDeep(src.score.anchors), ...out.score.anchors }
  }
  out.smallPoolThreshold ??= src.smallPoolThreshold
  if (src.pools) {
    out.pools ??= {}
    for (const key of ['tagTop', 'allV2', 'allV2Related', 'archiveRelated'] as const) {
      if (src.pools[key]) out.pools[key] = mergeTagRecGroupOverrides(out.pools[key], src.pools[key])
    }
  }
  if (src.poolsEnabled) out.poolsEnabled = { ...src.poolsEnabled, ...out.poolsEnabled }
  return out
}

export const compareMergeSources = (a: TagGroup, b: TagGroup) => a.addedAt - b.addedAt || a.id.localeCompare(b.id)

function overridesOf(g: TagGroup) {
  const out = cloneDeep(g.overrides ?? {})
  const ids = groupNegativeTagIds(g)
  if (ids.length || g.negative_strict !== undefined) {
    out.negative ??= {}
    if (ids.length) out.negative.tagIds = ids
    out.negative.strict ??= g.negative_strict
  }
  return out
}

/** 先计算整批结果：成员合并、缺项补齐、冲突保留目标；不修改输入。 */
export function mergeTagGroups(target: TagGroup, sources: readonly TagGroup[]): TagGroup {
  const sorted = [...sources].sort(compareMergeSources)
  const out = cloneDeep(target)
  out.tag_ids = dedupeTagIdEntries([target, ...sorted].flatMap((g) => g.tag_ids)).map((e) => ({ ...e }))
  out.overrides = overridesOf(target)
  for (const source of sorted) out.overrides = mergeTagRecGroupOverrides(out.overrides, overridesOf(source))
  const positives = new Set(out.tag_ids.map((e) => e.id))
  setGroupNegativeTagIds(
    out,
    dedupeTagIdEntries([target, ...sorted].flatMap(groupNegativeTagIds)).filter((e) => !positives.has(e.id)),
  )
  out.negative_strict = out.overrides?.negative?.strict
  const notes = sorted.filter((g) => g.note?.trim() && g.note !== target.note)
  if (notes.length) out.note = [target.note, ...notes.map((g) => `${g.name}: ${g.note}`)].filter(Boolean).join('\n')
  return out
}
