import { cloneDeep, isEqual } from 'es-toolkit'
import {
  cloneTagRecFilterCore,
  resolveTagRecEffective,
  TAG_REC_ALL_POOL_KEYS,
  type TagRecFilterCore,
  type TagRecFilterDims,
  type TagRecScorePatch,
  type TagRecSessionFilterPatch,
} from './filter-engine'
import type { TagGroup, TagL1Group } from './types'

/** 完整对象仅供表单和需要 core 的边界使用；取数/过滤始终传稀疏差分。 */
export function materializeTagRecSessionFilter(
  core: TagRecFilterCore,
  patch?: TagRecSessionFilterPatch,
): TagRecFilterCore {
  const out = cloneTagRecFilterCore(core)
  if (!patch) return out
  for (const key of ['enabled', 'strictMode', 'smallPoolThreshold'] as const) {
    if (patch[key] !== undefined) Object.assign(out, { [key]: patch[key] })
  }
  Object.assign(out.dims, cloneDeep(patch.dims))
  Object.assign(out.score.weights, patch.score?.weights)
  Object.assign(out.score.anchors, patch.score?.anchors)
  if (patch.pools) out.pools = { ...out.pools, ...cloneDeep(patch.pools) }
  if (patch.poolsEnabled) out.poolsEnabled = { ...out.poolsEnabled, ...patch.poolsEnabled }
  return out
}

/** 表单基线展示选定组的实际配置；主题推荐的多组场景展示全局基线。 */
export function createTagRecSessionFilterBase(
  core: TagRecFilterCore,
  group?: TagGroup,
  l1?: TagL1Group,
): TagRecFilterCore {
  const eff = resolveTagRecEffective(core, 'tagTop', group, l1)
  const out = cloneTagRecFilterCore(eff.cfg)
  for (const key of ['upAllow', 'titleAllow', 'descAllow', 'partitionAllow', 'tagAllow'] as const) {
    const rule = eff.neg[key]
    if (rule)
      Object.assign(out.dims, {
        [key]: { enabled: true, list: cloneDeep(rule.list), ...('strict' in rule ? { strict: rule.strict } : {}) },
      })
  }
  // 「格」只编辑本次声明的来源差分；继承值由 resolver 提供，不复制持久格。
  out.pools = undefined
  out.poolsEnabled = { ...eff.poolsEnabled }
  return out
}

/** 表单实际改过的维度、评分字段与来源开关；回到基线即恢复继承。 */
export function diffTagRecSessionFilter(
  next: TagRecFilterCore,
  base: TagRecFilterCore,
  previous?: TagRecSessionFilterPatch,
): TagRecSessionFilterPatch | undefined {
  const patch: TagRecSessionFilterPatch = { dims: {} }
  for (const key of ['enabled', 'strictMode', 'smallPoolThreshold'] as const) {
    if (next[key] !== base[key]) Object.assign(patch, { [key]: next[key] })
  }
  for (const key of Object.keys(base.dims) as (keyof TagRecFilterDims)[]) {
    if (!isEqual(next.dims[key], base.dims[key])) Object.assign(patch.dims, { [key]: cloneDeep(next.dims[key]) })
  }
  const score: TagRecScorePatch = {}
  for (const half of ['weights', 'anchors'] as const) {
    const fields: Record<string, number> = {}
    for (const [key, value] of Object.entries(next.score[half])) {
      if (value !== (base.score[half] as unknown as Record<string, number>)[key]) fields[key] = value
    }
    if (Object.keys(fields).length) score[half] = fields
  }
  if (Object.keys(score).length) patch.score = score
  for (const pool of TAG_REC_ALL_POOL_KEYS) {
    if (!isEqual(next.pools?.[pool], base.pools?.[pool]) && next.pools?.[pool])
      (patch.pools ??= {})[pool] = cloneDeep(next.pools[pool])
    const enabled = next.poolsEnabled?.[pool] ?? true
    if (enabled !== (base.poolsEnabled?.[pool] ?? true) || previous?.poolsEnabled?.[pool] === enabled)
      (patch.poolsEnabled ??= {})[pool] = enabled
  }
  return Object.keys(patch.dims).length || Object.keys(patch).length > 1 ? patch : undefined
}
