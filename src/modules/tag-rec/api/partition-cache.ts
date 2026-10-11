import { mergeTagRecPartitionFields, normalizeTagRecPartition, type TagRecPartitionFields } from '../model/partition'

const CAP = 2_000
const MAX_AGE_MS = 60 * 60_000
const known = new Map<string, { fields: TagRecPartitionFields; at: number }>()

export function rememberTagRecPartition(bvid: string | undefined, raw: Record<string, unknown>): void {
  if (!bvid) return
  const fields = normalizeTagRecPartition(raw)
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  if (!Object.keys(present).length) return
  const previousEntry = known.get(bvid)
  const previous = getCachedTagRecPartition(bvid)
  const nativeUpdated = fields.tidv2 !== undefined || fields.pid_v2 !== undefined
  const at = previous && !nativeUpdated ? previousEntry!.at : Date.now()
  known.delete(bvid)
  known.set(bvid, { fields: mergeTagRecPartitionFields(previous ?? {}, fields), at })
  while (known.size > CAP) known.delete(known.keys().next().value!)
}

export function getCachedTagRecPartition(bvid: string): TagRecPartitionFields | undefined {
  const entry = known.get(bvid)
  if (!entry) return
  if (Date.now() - entry.at >= MAX_AGE_MS) {
    known.delete(bvid)
    return
  }
  known.delete(bvid)
  known.set(bvid, entry)
  return entry.fields
}
