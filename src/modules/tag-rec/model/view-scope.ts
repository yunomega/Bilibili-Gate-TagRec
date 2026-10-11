import type { TagL1Group } from './types'

/**
 * [tag-rec] R7: 查看范围 (查看范围 = 「现在看哪些主题/一级组」的零写入视图筛)
 * - 记录形: 桶键 (主题 id | 未归属哨兵) => 'all' | L1 id 数组; **缺键 = 'all' (默认全看)**
 *   「全选」= 空记录; 取消某主题 = 该桶 []; 主题内细选 = 该桶 L1 id 数组
 * - 未归属桶: 一级组无主题 (或悬挂已删主题) 落此桶 —— 主题删/并入时桶按并集吸收 (store 侧)
 * - 纯函数, 不含 store/GM; deck 判定/指纹/计数共用展开口径 (tagRecViewScopeViewedIds)
 */

/** 未归属桶哨兵 (与 pane 的 THEME_FILTER_UNASSIGNED 同值; 防跨模块循环仅此处定义) */
export const TAG_REC_VIEW_UNASSIGNED = '__theme_unassigned__'

/** 查看范围记录 (持久于 tag-rec:view-scope) */
export type TagRecViewScope = Record<string, 'all' | string[]>

/** L1 的归属桶: 主题存在则用主题 id; 无主题/悬挂 (已删主题) 归未归属 */
export function tagRecViewBucketOf(l1: Pick<TagL1Group, 'themeId'>, themeIds: ReadonlySet<string>): string {
  return l1.themeId && themeIds.has(l1.themeId) ? l1.themeId : TAG_REC_VIEW_UNASSIGNED
}

/** 记录项 => 是否含该 L1 ('all'/缺键 = 全看; 数组 = 包含判定) */
export function tagRecViewScopeCovers(scope: TagRecViewScope, bucket: string, l1Id: string): boolean {
  const v = scope[bucket]
  if (v === undefined || v === 'all') return true
  return v.includes(l1Id)
}

/** 展开查看范围为 L1 id 集 (deck 判定/指纹/计数用; 组序无关) */
export function tagRecViewScopeViewedIds(
  scope: TagRecViewScope,
  l1s: readonly Pick<TagL1Group, 'id' | 'themeId'>[],
  themeIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const l1 of l1s) {
    if (tagRecViewScopeCovers(scope, tagRecViewBucketOf(l1, themeIds), l1.id)) out.add(l1.id)
  }
  return out
}

/** 桶当前形 ('all' | string[]; 缺键 => 'all') —— UI 消费/写回用 */
export function tagRecViewScopeEntry(scope: TagRecViewScope, bucket: string): 'all' | string[] {
  return scope[bucket] ?? 'all'
}

/**
 * 桶合并 (删主题/并入主题): from 的查看范围并入 to, 按**并集**语义 ('all' 吸收一切; 缺键 = 全看亦吸收);
 * 就地改传入 scope (valtio proxy 可写)
 */
export function tagRecViewScopeAbsorb(scope: TagRecViewScope, fromId: string, toId: string): void {
  if (fromId === toId) return
  const from = scope[fromId]
  delete scope[fromId]
  if (from === undefined || from === 'all') {
    scope[toId] = 'all' // from 全看 => 并入后 to 全看
    return
  }
  const to = scope[toId]
  if (to === undefined || to === 'all') return // to 已全看, 无需并
  scope[toId] = [...new Set([...to, ...from])]
}

/**
 * 导出用 legacy 字段 (activeThemeId) 推导: 恰好「只看一个主题」(其余桶显式空) 时给该 id, 否则 null。
 * 查看范围是本代模型, 导出 JSON 沿用旧键供旧端/旧解析读
 */
export function tagRecViewScopeLegacyActiveTheme(scope: TagRecViewScope, themeIds: readonly string[]): string | null {
  const buckets = [...themeIds, TAG_REC_VIEW_UNASSIGNED]
  const active = buckets.filter((b) => {
    const v = scope[b]
    if (v === undefined) return true // 缺键 = 全看
    return v === 'all' || v.length > 0
  })
  if (active.length === 1 && active[0] !== TAG_REC_VIEW_UNASSIGNED) return active[0]
  return null
}

/**
 * 摘要文案 (tabbar 触发器/下拉脚注): 「主题：全选」/「主题：未选 (点此全选)」/「主题：A、B(部分)…」
 * - 满 = 桶缺键/'all'/数组覆盖该桶全部 L1; 空 = 桶 [] 或数组为空; 空桶不列
 */
export function tagRecViewScopeSummary(
  scope: TagRecViewScope,
  buckets: readonly { id: string; name: string; l1Count: number }[],
): string {
  const stateOf = (b: { id: string; l1Count: number }): 'full' | 'none' | 'half' => {
    const v = scope[b.id]
    if (v === undefined || v === 'all') return 'full'
    if (!v.length) return 'none'
    return v.length >= b.l1Count ? 'full' : 'half'
  }
  const states = buckets.map((b) => ({ b, s: stateOf(b) }))
  if (states.every((x) => x.s === 'full')) return '主题：全选'
  if (states.every((x) => x.s === 'none')) return '主题：未选 (点此全选)'
  const parts = states.filter((x) => x.s !== 'none').map((x) => (x.s === 'full' ? x.b.name : `${x.b.name}(部分)`))
  return '主题：' + (parts.length > 3 ? parts.slice(0, 3).join('、') + ` 等${parts.length}个` : parts.join('、'))
}
