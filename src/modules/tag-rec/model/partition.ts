import { PARTITION_EXPAND_V1, PARTITION_EXPAND_V2 } from './partition-table'
import type { TagRecItemExtend } from '$define'
import type { TagRecPartitionEntry } from './types'

export type TagRecPartitionFields = Pick<TagRecItemExtend, 'tid' | 'tidv2' | 'tnamev2' | 'pid_v2' | 'pid_name_v2'>
export type TagRecPartitionVerdict = 'match' | 'mismatch' | 'unknown'

const positiveId = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export function normalizeTagRecPartition(raw: Record<string, unknown>): TagRecPartitionFields {
  return {
    tid: positiveId(raw.tid) ?? positiveId(raw.typeid),
    tidv2: positiveId(raw.tidv2) ?? positiveId(raw.tid_v2),
    tnamev2:
      typeof raw.tnamev2 === 'string' ? raw.tnamev2 : typeof raw.tname_v2 === 'string' ? raw.tname_v2 : undefined,
    pid_v2: positiveId(raw.pid_v2),
    pid_name_v2: typeof raw.pid_name_v2 === 'string' ? raw.pid_name_v2 : undefined,
  }
}

export function tagRecPartitionParent(leaf: number): number | undefined {
  for (const [parent, leaves] of Object.entries(PARTITION_EXPAND_V2)) if (leaves.includes(leaf)) return Number(parent)
}

export function mergeTagRecPartitionFields<T extends TagRecPartitionFields>(
  target: T,
  fields: TagRecPartitionFields,
): T {
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  const changed = fields.tidv2 !== undefined && target.tidv2 !== fields.tidv2
  return {
    ...target,
    ...(changed ? { pid_v2: undefined, pid_name_v2: undefined, tnamev2: undefined } : {}),
    ...present,
  }
}

export function evalTagRecPartitionEntry(
  item: TagRecPartitionFields,
  entry: TagRecPartitionEntry,
): TagRecPartitionVerdict {
  const legacy = (): TagRecPartitionVerdict => {
    if (entry.v1 === undefined || item.tid === undefined) return 'unknown'
    return (PARTITION_EXPAND_V1[entry.v1] ?? [entry.v1]).includes(item.tid) ? 'match' : 'mismatch'
  }
  // Equal dual IDs are migrated numeric lists; keep their historical exact-ID compatibility.
  const migrated = entry.v1 !== undefined && entry.v1 === entry.v2
  if (migrated && legacy() === 'match') return 'match'
  if (entry.v2 === undefined || (migrated && entry.v2 < 1001)) return legacy()
  const level = entry.level ?? (PARTITION_EXPAND_V2[entry.v2] ? 'parent' : 'leaf')
  if (level === 'parent') {
    const parent = item.pid_v2 ?? (item.tidv2 === undefined ? undefined : tagRecPartitionParent(item.tidv2))
    if (parent === undefined) return 'unknown'
    return parent === entry.v2 ? 'match' : 'mismatch'
  }
  if (item.tidv2 !== undefined && !PARTITION_EXPAND_V2[item.tidv2])
    return item.tidv2 === entry.v2 ? 'match' : 'mismatch'
  // A same-parent value cannot confirm a particular child; a different known parent can rule it out.
  const parent = tagRecPartitionParent(entry.v2)
  const itemParent = item.pid_v2 ?? (item.tidv2 === undefined ? undefined : tagRecPartitionParent(item.tidv2))
  if (parent !== undefined && itemParent !== undefined && itemParent !== parent) return 'mismatch'
  if (!entry.level && item.pid_v2 === entry.v2) return 'match'
  return 'unknown'
}

export function evalTagRecPartitionList(
  item: TagRecPartitionFields,
  list: readonly TagRecPartitionEntry[],
): TagRecPartitionVerdict {
  let unknown = false
  for (const entry of list) {
    const verdict = evalTagRecPartitionEntry(item, entry)
    if (verdict === 'match') return verdict
    unknown ||= verdict === 'unknown'
  }
  return unknown ? 'unknown' : 'mismatch'
}
