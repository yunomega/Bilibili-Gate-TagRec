import type { TagRecSessionFilterPatch } from './filter-engine'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((key) => allowed.includes(key))
const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 200
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
const tag = (v: unknown) =>
  object(v) &&
  keys(v, ['id', 'name', 'tag_type']) &&
  positive(v.id) &&
  text(v.name) &&
  (v.tag_type === undefined || ['topic', 'old_channel', 'bgm'].includes(v.tag_type as string))
const up = (v: unknown) =>
  object(v) && keys(v, ['name', 'mid']) && text(v.name) && (v.mid === undefined || positive(v.mid))
const partition = (v: unknown) =>
  object(v) &&
  keys(v, ['name', 'v1', 'v2', 'level']) &&
  text(v.name) &&
  [v.v1, v.v2].some(positive) &&
  [v.v1, v.v2].every((id) => id === undefined || positive(id)) &&
  (v.level === undefined || v.level === 'parent' || v.level === 'leaf')
const values = new Set([
  'viewMin',
  'viewMax',
  'likeMin',
  'likeMax',
  'favMin',
  'favMax',
  'coinMin',
  'coinMax',
  'danmakuMin',
  'danmakuMax',
  'replyMin',
  'replyMax',
  'shareMin',
  'shareMax',
  'likeRate',
  'favRate',
  'coinRate',
  'interactRate',
  'shareRate',
  'minScore',
])
const listKeys = [
  'upBlacklist',
  'upAllow',
  'titleKeywords',
  'titleAllow',
  'descKeywords',
  'descAllow',
  'partitionBlock',
  'partitionAllow',
  'tagBlock',
  'tagAllow',
]
function dims(v: unknown, lists = true): boolean {
  if (!object(v) || !keys(v, [...values, 'duration', 'pubdate', ...(lists ? listKeys : [])])) return false
  return Object.entries(v).every(([key, rule]) => {
    if (!object(rule) || typeof rule.enabled !== 'boolean') return false
    if (values.has(key)) return keys(rule, ['enabled', 'value']) && number(rule.value)
    if (key === 'duration') return keys(rule, ['enabled', 'min', 'max']) && number(rule.min) && number(rule.max)
    if (key === 'pubdate') {
      if (
        !keys(rule, ['enabled', 'win', 'days', 'from', 'to', 'tod']) ||
        (rule.win !== undefined && !['today', 'd7', 'd30', 'd180', 'days', 'range'].includes(rule.win as string))
      )
        return false
      if (['days', 'from', 'to'].some((k) => rule[k] !== undefined && !number(rule[k]))) return false
      if (
        rule.tod !== undefined &&
        (!object(rule.tod) ||
          !keys(rule.tod, ['from', 'to']) ||
          Object.values(rule.tod).some((n) => !number(n) || (n as number) > 1440))
      )
        return false
      return true
    }
    const predicate = key.startsWith('up')
      ? up
      : key.startsWith('partition')
        ? partition
        : key.startsWith('tag')
          ? tag
          : text
    return (
      keys(rule, ['enabled', 'list', ...(key.startsWith('tag') ? ['strict'] : [])]) &&
      (rule.strict === undefined || typeof rule.strict === 'boolean') &&
      Array.isArray(rule.list) &&
      rule.list.length <= 128 &&
      rule.list.every(predicate)
    )
  })
}
function score(v: unknown): boolean {
  return (
    object(v) &&
    keys(v, ['weights', 'anchors']) &&
    Object.entries(v).every(
      ([key, fields]) =>
        object(fields) &&
        keys(
          fields,
          key === 'weights'
            ? ['view', 'likeRate', 'favRate', 'coinRate', 'interactRate']
            : ['viewLog10', 'likeRate', 'favRate', 'coinRate', 'interactRate'],
        ) &&
        Object.values(fields).every(number),
    )
  )
}
const pools = ['tagTop', 'allV2', 'allV2Related', 'archiveRelated']
function scope(v: unknown): boolean {
  return (
    object(v) &&
    keys(v, ['dims', 'score', 'smallPoolThreshold']) &&
    (v.dims === undefined || dims(v.dims, false)) &&
    (v.score === undefined || score(v.score)) &&
    (v.smallPoolThreshold === undefined || number(v.smallPoolThreshold))
  )
}
/** Recipes are an executable contract: malformed or unknown filters cannot be discarded on import. */
export function validateTagRecCombinationFilters(v: unknown): v is TagRecSessionFilterPatch {
  return (
    object(v) &&
    keys(v, ['dims', 'enabled', 'strictMode', 'smallPoolThreshold', 'score', 'pools', 'poolsEnabled']) &&
    dims(v.dims) &&
    ['enabled', 'strictMode'].every((key) => v[key] === undefined || typeof v[key] === 'boolean') &&
    (v.smallPoolThreshold === undefined || number(v.smallPoolThreshold)) &&
    (v.score === undefined || score(v.score)) &&
    (v.pools === undefined || (object(v.pools) && keys(v.pools, pools) && Object.values(v.pools).every(scope))) &&
    (v.poolsEnabled === undefined ||
      (object(v.poolsEnabled) &&
        keys(v.poolsEnabled, pools) &&
        Object.values(v.poolsEnabled).every((b) => typeof b === 'boolean')))
  )
}
