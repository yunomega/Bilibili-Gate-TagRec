import { TAG_REC_DROP_DIM_LABELS } from './banner-helpers'
import { TAG_REC_POOL_LABELS } from './pool-labels'
import type { TagRecFilterDims, TagRecSessionFilterPatch } from '../model/filter-engine'

export type TagRecFilterChoice = { key: string; label: string; patch: TagRecSessionFilterPatch }
/** 秒 -> 人类时长串: 3660→「1时1分」, 600→「10分」, 95→「1分35秒」, 45→「45秒」 */
function formatDurationSec(s: number): string {
  if (s >= 3600) return s % 3600 ? `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分` : `${s / 3600}时`
  if (s >= 60) return s % 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s / 60}分`
  return `${s}秒`
}
function describeDim(key: keyof TagRecFilterDims, rule: TagRecFilterDims[keyof TagRecFilterDims]): string {
  const label = TAG_REC_DROP_DIM_LABELS[key]
  if (!rule.enabled) return `${label} · 关闭`
  if ('value' in rule) return `${label} · ${key.endsWith('Rate') ? `${+(rule.value * 100).toFixed(3)}%` : rule.value}`
  if ('list' in rule)
    return `${label} · ${rule.list.map((value) => (typeof value === 'string' ? value : value.name)).join('、') || '空名单'}`
  if ('min' in rule)
    return `时长 · ${rule.min ? `${formatDurationSec(rule.min)}起` : ''}${rule.max ? `至${formatDurationSec(rule.max)}` : ''}`
  const windows = {
    today: '今天',
    d7: '7天内',
    d30: '30天内',
    d180: '180天内',
    days: `${rule.days}天内`,
    range: '指定日期',
  }
  return `发布时间 · ${rule.win ? windows[rule.win] : ''}${rule.from ? ` ${new Date(rule.from * 1000).toLocaleDateString()}起` : ''}${rule.to ? ` 至${new Date(rule.to * 1000).toLocaleDateString()}` : ''}${rule.tod ? ' · 指定时段' : ''}`
}
const scoreLabels: Record<string, string> = {
  view: '播放',
  viewLog10: '播放对数',
  likeRate: '点赞率',
  favRate: '收藏率',
  coinRate: '投币率',
  interactRate: '互动率',
}
/** Each explicit choice can be borrowed or returned to inheritance separately. */
export function tagRecCombinationFilterChoices(patch?: TagRecSessionFilterPatch): TagRecFilterChoice[] {
  if (!patch) return []
  const out: TagRecFilterChoice[] = []
  for (const key of ['enabled', 'strictMode', 'smallPoolThreshold'] as const)
    if (patch[key] !== undefined)
      out.push({
        key,
        label:
          key === 'smallPoolThreshold'
            ? `小池线 · ${patch[key]}`
            : `${key === 'enabled' ? '辅助过滤' : '缺字段严格过滤'} · ${patch[key] ? '开' : '关'}`,
        patch: { dims: {}, [key]: patch[key] },
      })
  for (const [key, dim] of Object.entries(patch.dims))
    out.push({
      key: `dims.${key}`,
      label: describeDim(key as keyof TagRecFilterDims, dim),
      patch: { dims: { [key]: dim } },
    })
  for (const half of ['weights', 'anchors'] as const)
    for (const [key, value] of Object.entries(patch.score?.[half] ?? {}))
      out.push({
        key: `score.${half}.${key}`,
        label: `${scoreLabels[key]}${half === 'weights' ? '权重' : '参照值'} · ${value}`,
        patch: { dims: {}, score: { [half]: { [key]: value } } },
      })
  for (const [key, value] of Object.entries(patch.poolsEnabled ?? {}))
    out.push({
      key: `poolsEnabled.${key}`,
      label: `${TAG_REC_POOL_LABELS[key as keyof typeof TAG_REC_POOL_LABELS]} · ${value ? '开启' : '关闭'}`,
      patch: { dims: {}, poolsEnabled: { [key]: value } },
    })
  for (const [pool, cell] of Object.entries(patch.pools ?? {})) {
    const nested = tagRecCombinationFilterChoices({ ...cell, dims: cell.dims ?? {} })
    for (const choice of nested)
      out.push({
        key: `pools.${pool}.${choice.key}`,
        label: `${TAG_REC_POOL_LABELS[pool as keyof typeof TAG_REC_POOL_LABELS]} · ${choice.label}`,
        patch: { dims: {}, pools: { [pool]: choice.patch } },
      })
  }
  return out
}
export function removeTagRecCombinationFilterChoice(patch: TagRecSessionFilterPatch, key: string): void {
  const path = key.split('.')
  const remove = (value: Record<string, unknown>, at: number) => {
    const field = path[at]
    if (at === path.length - 1) delete value[field]
    else if (value[field] && typeof value[field] === 'object') {
      const child = value[field] as Record<string, unknown>
      remove(child, at + 1)
      if (!Object.keys(child).length) delete value[field]
    }
  }
  remove(patch as unknown as Record<string, unknown>, 0)
  patch.dims ??= {}
}
