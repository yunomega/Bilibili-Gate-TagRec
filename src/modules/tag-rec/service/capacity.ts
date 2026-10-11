/** 先保护候选最稀缺的归属池；池深相同时按调用方的淘汰顺序选择。 */
export function pickTagRecCapacityVictim<T>(
  bucket: ReadonlySet<T>,
  scopes: ReadonlyMap<string, ReadonlySet<T>>,
  ordered: Iterable<T>,
): T | undefined {
  const smallest = new Map<T, number>()
  for (const pool of scopes.values())
    for (const item of pool)
      if (bucket.has(item)) smallest.set(item, Math.min(smallest.get(item) ?? Infinity, pool.size))
  let victim: T | undefined
  let depth = -1
  for (const item of ordered) {
    if (!bucket.has(item)) continue
    const size = smallest.get(item) ?? 0
    if (size > depth) {
      victim = item
      depth = size
    }
  }
  return victim
}
