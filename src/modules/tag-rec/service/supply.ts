import {
  projectTagRecActiveClaims,
  tagRecChainKeysOf,
  tagRecPoolScopeKey,
  tagRecPoolsForChain,
  type TagRecScopeResolve,
} from '../model/filter-engine'
import { tagRecGroupKey } from '../model/relevance'
import type { TagRecItemExtend } from '$define'

/** 池深与可交付库存用不同分母；每个组及组×来源内按实际 BV 去重。 */
export function tagRecSupplyView(
  raw: readonly TagRecItemExtend[],
  stock: readonly TagRecItemExtend[],
  resolve: TagRecScopeResolve,
  lowWater = 10,
) {
  const depth = new Map<string, Set<string>>()
  const inventory = new Map<string, Set<string>>()
  const groups = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, bvid: string) => {
    const bucket = map.get(key) ?? new Set<string>()
    bucket.add(bvid)
    map.set(key, bucket)
  }
  for (const item of raw) {
    projectTagRecActiveClaims(item, resolve)
    for (const key of tagRecChainKeysOf(item))
      for (const pool of tagRecPoolsForChain(item, key)) add(depth, tagRecPoolScopeKey(key, pool), item.bvid)
  }
  for (const item of stock) {
    projectTagRecActiveClaims(item, resolve)
    for (const key of tagRecChainKeysOf(item)) {
      const group = tagRecGroupKey(key)
      if (item.eligibleGroupKeys && !item.eligibleGroupKeys.includes(group)) continue
      for (const pool of tagRecPoolsForChain(item, key)) {
        const scope = tagRecPoolScopeKey(key, pool)
        if (item.eligiblePoolScopes && !item.eligiblePoolScopes.includes(scope)) continue
        add(inventory, scope, item.bvid)
        add(groups, group, item.bvid)
      }
    }
  }
  return {
    depth,
    inventory,
    groups,
    /** 可交付库存总条数 (队列内 TagRec 条目, bvid 唯一) —— 高水位闸输入 */
    stockTotal: stock.length,
    needs: (key: string) => (groups.get(key)?.size ?? 0) < lowWater,
  }
}
