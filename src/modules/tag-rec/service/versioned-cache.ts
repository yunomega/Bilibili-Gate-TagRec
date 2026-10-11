import { getVersion } from 'valtio/vanilla'

/**
 * 巨型收藏夹规模修复 (535 组/930 标签实测): tab1 单次 fetchMore 曾新建 ~1150 个
 * scopeResolver —— hasAllowedSupply/needsSupply 逐组调用时各建三张全表 Map, 求解器
 * 内部 (组,池) 缓存随实例同弃; 签名函数同量级重算。版本号键记忆化后整轮至多一建。
 * valtio 子代理深变向上冒泡版本号; 任一输入非代理 (测试替身) => key undefined =>
 * 逐次重建 (与缓存前语义一致, 不引入静态过期风险)。
 */
const identities = new WeakMap<object, number>()
let nextIdentity = 1

/**
 * 代理身份+版号二段读数: getVersion 是每 proxy 独立计数器 —— 对象整体换壳
 * (favoritesStore.list = [...] 整表替换路径存在) 新 proxy 从 0 重计会与旧值碰撞,
 * 身份序号把「不同对象的同版号」区分开; WeakMap 不阻回收。
 */
const ver = (o: unknown): string | undefined => {
  if (!o || typeof o !== 'object') return undefined
  const v = getVersion(o as object)
  if (v === undefined) return undefined
  let id = identities.get(o)
  if (id === undefined) identities.set(o as object, (id = nextIdentity++))
  return `${id}@${v}`
}

/** (身份,版号) 元组 -> 缓存键; 任一输入拿不到版号 => undefined (调用侧应不缓存直算) */
export function tagRecVersionKey(inputs: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const o of inputs) {
    const v = ver(o)
    if (v === undefined) return undefined
    parts.push(v)
  }
  return parts.join(':')
}

/**
 * 单槽版号记忆化: 每槽位存 (key, value); key undefined => 不缓存恒重算;
 * key 漂移 => 重建并换槽。适合 resolver/签名这类「输入集固定、按内容版号失效」的值。
 */
export function versionedSlot<T>(): (key: string | undefined, build: () => T) => T {
  let slot: { key: string; value: T } | undefined
  return (key, build) => {
    if (key !== undefined && slot?.key === key) return slot.value
    const value = build()
    if (key !== undefined) slot = { key, value }
    return value
  }
}
