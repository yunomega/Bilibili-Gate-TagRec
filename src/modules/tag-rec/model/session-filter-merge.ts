import { cloneDeep, isEqual } from 'es-toolkit'
import {
  diffTagRecScopeOverride,
  TAG_REC_ALL_POOL_KEYS,
  TAG_REC_PATCHABLE_DIM_KEYS,
  type TagRecDimsPatch,
  type TagRecFilterCore,
  type TagRecFilterDims,
  type TagRecGroupOverrides,
  type TagRecScopeOverride,
  type TagRecScoreAnchors,
  type TagRecScoreWeights,
} from './filter-engine'
import type { TagRecNegativeRules, TagRecPartitionEntry, TagRecPoolKey } from './types'

/**
 * [tag-rec] 「存成项后顺手并入」差分器 (grilling 共识 Q1):
 *   会话临时过滤 (filterOverride) vs 全局「标签过滤」的**差集** => 组级 override
 *   - 稀疏语义: 键存在=override —— 只写会话真实调过的东西, 组其余维度继续跟随全局 (不整套烙死)
 *   - 名单维 (TagRecDimsPatch 类型层除外的 10 键) 走 negative 容器:
 *       屏蔽族 = 链上并集 => 只持久化「新增条目」; 维闸关 = 不写 (negative 名单常效, 不偷渡闸后条目)
 *       仅看族 = 链上最近「启用非空」名单覆盖 => 整份规则写入; 关/空/与全局相同 => 不写
 *         (「关掉下层仅看」在链上无法表达, enabled:false 会透传下去)
 *   - 不可表达弃项: core.enabled (总开关) / strictMode (严格模式) —— 组槽位无对应键
 */

const upKey = (e: { name: string; mid?: number }) =>
  e.mid !== undefined ? `mid:${e.mid}` : `name:${e.name.trim().toLowerCase()}`
const partKey = (e: TagRecPartitionEntry) => `${e.v1 ?? ''}|${e.v2 ?? ''}`
const wordKey = (w: string) => w.trim().toLowerCase()

function addedEntries<T>(list: readonly T[], base: readonly T[], key: (e: T) => string | number): T[] {
  const seen = new Set(base.map(key))
  return list.filter((e) => !seen.has(key(e)))
}

/** 名单维差分 => negative 容器 (组级 override 的名单槽) */
function diffSessionNegative(session: TagRecFilterDims, base: TagRecFilterDims): TagRecNegativeRules | undefined {
  const neg: TagRecNegativeRules = {}

  // —— 屏蔽族 (并集语义): 只写「会话比全局多出来的条目」, 且仅在会话维闸开时 ——
  if (session.upBlacklist.enabled) {
    const add = addedEntries(session.upBlacklist.list, base.upBlacklist.list, upKey)
    if (add.length) neg.up = cloneDeep(add)
  }
  if (session.titleKeywords.enabled) {
    const add = addedEntries(session.titleKeywords.list, base.titleKeywords.list, wordKey)
    if (add.length) neg.title = add.map((w) => w.trim()).filter(Boolean)
  }
  if (session.descKeywords.enabled) {
    const add = addedEntries(session.descKeywords.list, base.descKeywords.list, wordKey)
    if (add.length) neg.desc = add.map((w) => w.trim()).filter(Boolean)
  }
  if (session.partitionBlock.enabled) {
    const add = addedEntries(session.partitionBlock.list, base.partitionBlock.list, partKey)
    if (add.length) neg.partitionBlock = cloneDeep(add)
  }
  if (session.tagBlock.enabled) {
    const add = addedEntries(session.tagBlock.list, base.tagBlock.list, (e) => e.id)
    if (add.length) {
      neg.tagBlock = { enabled: true, strict: session.tagBlock.strict || undefined, list: cloneDeep(add) }
    }
  }

  // —— 仅看族 (就近覆盖语义): 整份规则写入, 开且非空且与全局不同才有意义 ——
  //   (逐行展开: 联合类型下 neg[key] 收窄成交叉型不可赋值)
  if (
    session.partitionAllow.enabled &&
    session.partitionAllow.list.length &&
    !isEqual(session.partitionAllow, base.partitionAllow)
  ) {
    neg.partitionAllow = cloneDeep(session.partitionAllow)
  }
  if (session.upAllow.enabled && session.upAllow.list.length && !isEqual(session.upAllow, base.upAllow)) {
    neg.upAllow = cloneDeep(session.upAllow)
  }
  if (session.titleAllow.enabled && session.titleAllow.list.length && !isEqual(session.titleAllow, base.titleAllow)) {
    neg.titleAllow = cloneDeep(session.titleAllow)
  }
  if (session.descAllow.enabled && session.descAllow.list.length && !isEqual(session.descAllow, base.descAllow)) {
    neg.descAllow = cloneDeep(session.descAllow)
  }
  if (session.tagAllow.enabled && session.tagAllow.list.length && !isEqual(session.tagAllow, base.tagAllow)) {
    neg.tagAllow = cloneDeep(session.tagAllow)
  }

  return Object.keys(neg).length ? neg : undefined
}

/** 稀疏×稀疏差分 (池槽用): 只比 draft 显式写过的键 —— 缺键=继承, 不写 */
function diffScopeSparse(
  draft: TagRecScopeOverride | undefined,
  base: TagRecScopeOverride | undefined,
): TagRecScopeOverride | undefined {
  if (!draft) return undefined
  const out: TagRecScopeOverride = {}
  const dims: TagRecDimsPatch = {}
  for (const k of TAG_REC_PATCHABLE_DIM_KEYS) {
    const dv = draft.dims?.[k]
    if (dv !== undefined && !isEqual(dv, base?.dims?.[k])) (dims as Record<string, unknown>)[k] = cloneDeep(dv)
  }
  if (Object.keys(dims).length) out.dims = dims
  if (draft.score) {
    const weights: Partial<TagRecScoreWeights> = {}
    for (const k of Object.keys(draft.score.weights ?? {}) as (keyof TagRecScoreWeights)[]) {
      if (draft.score.weights![k] !== base?.score?.weights?.[k]) weights[k] = draft.score.weights![k]
    }
    const anchors: Partial<TagRecScoreAnchors> = {}
    for (const k of Object.keys(draft.score.anchors ?? {}) as (keyof TagRecScoreAnchors)[]) {
      if (draft.score.anchors![k] !== base?.score?.anchors?.[k]) anchors[k] = draft.score.anchors![k]
    }
    if (Object.keys(weights).length || Object.keys(anchors).length) {
      out.score = {
        ...(Object.keys(weights).length ? { weights } : {}),
        ...(Object.keys(anchors).length ? { anchors } : {}),
      }
    }
  }
  if (draft.smallPoolThreshold !== undefined && draft.smallPoolThreshold !== base?.smallPoolThreshold) {
    out.smallPoolThreshold = draft.smallPoolThreshold
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 会话临时过滤 => 组级 override 差集 (并入「顺手存成项」建出的组用)。
 * 返回 undefined = 无可并入差异 (调用侧不出并入提示)。
 */
export function diffTagRecSessionFilterForGroup(
  session: TagRecFilterCore,
  base: TagRecFilterCore,
): TagRecGroupOverrides | undefined {
  // dims/score/smallPoolThreshold 全量×全量差分 —— 复用票12 组配置存盘核
  const out: TagRecGroupOverrides = { ...diffTagRecScopeOverride(session, base) }

  const neg = diffSessionNegative(session.dims, base.dims)
  if (neg) out.negative = neg

  const poolsEnabled: Partial<Record<TagRecPoolKey, boolean>> = {}
  for (const k of TAG_REC_ALL_POOL_KEYS) {
    const v = session.poolsEnabled?.[k]
    if (v !== undefined && v !== base.poolsEnabled?.[k]) poolsEnabled[k] = v
  }
  if (Object.keys(poolsEnabled).length) out.poolsEnabled = poolsEnabled

  for (const k of TAG_REC_ALL_POOL_KEYS) {
    const d = diffScopeSparse(session.pools?.[k], base.pools?.[k])
    if (d) (out.pools ??= {})[k] = d
  }

  return Object.keys(out).length ? out : undefined
}

/** 并入确认弹窗的差集摘要 (让用户看清要落什么, 不放行黑盒) */
export function summarizeSessionFilterDiff(diff: TagRecGroupOverrides): string {
  const parts: string[] = []
  const neg = diff.negative ?? {}
  const blockN =
    (neg.up?.length ?? 0) +
    (neg.title?.length ?? 0) +
    (neg.desc?.length ?? 0) +
    (neg.partitionBlock?.length ?? 0) +
    (neg.tagBlock?.list.length ?? 0)
  if (blockN) parts.push(`屏蔽类新增 ${blockN} 条`)
  const allowN =
    (neg.upAllow?.list.length ?? 0) +
    (neg.titleAllow?.list.length ?? 0) +
    (neg.descAllow?.list.length ?? 0) +
    (neg.partitionAllow?.list.length ?? 0) +
    (neg.tagAllow?.list.length ?? 0)
  if (allowN) parts.push(`仅看名单 ${allowN} 条 (整份覆盖)`)
  if (neg.strict !== undefined) parts.push('严格校验')
  const dimsN = Object.keys(diff.dims ?? {}).length
  if (dimsN) parts.push(`阈值/时间窗 ${dimsN} 项`)
  const scoreN = Object.keys(diff.score?.weights ?? {}).length + Object.keys(diff.score?.anchors ?? {}).length
  if (scoreN) parts.push(`评分权重 ${scoreN} 项`)
  if (diff.smallPoolThreshold !== undefined) parts.push('小池阈值')
  const poolsN = Object.keys(diff.poolsEnabled ?? {}).length + Object.keys(diff.pools ?? {}).length
  if (poolsN) parts.push(`池槽 ${poolsN} 处`)
  return parts.join('；')
}
