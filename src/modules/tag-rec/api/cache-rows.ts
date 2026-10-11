/** Decode only the newest bounded cache rows; one corrupt row must not discard other reusable facts. */
export function readCacheRows<V>(
  rows: unknown,
  cap: number,
  decode: (value: unknown, key: string) => V | undefined,
): Map<string, V> {
  const map = new Map<string, V>()
  if (!Array.isArray(rows)) return map
  for (const row of rows.slice(-cap)) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0]) continue
    const value = decode(row[1], row[0])
    if (value === undefined) continue
    map.delete(row[0])
    map.set(row[0], value)
  }
  return map
}
