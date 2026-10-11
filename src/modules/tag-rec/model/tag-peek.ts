import type { TagGroup, TagIdEntry } from './types'

/**
 * [tag-rec] 组内标签的查看与勾选（B1：换查询单元，不动 view-scope）
 *
 * 背景：「只看」选择器的粒度是二级组（`view-scope` 最低到 groupScope），面板也只渲染到组名，
 * 所以组内 tag 既看不见、也选不了。本模块只给两件纯逻辑：
 *   1) 组内标签 chips 的勾选累积（跨组，按 tag id 去重）
 *   2) 「只看选中的标签」的查询计划 —— 首个当锚点（**传名**，走文本解析全管线，同 🏷 弹层 #id 口径），
 *      其余进 tab2 的扩选暂存位（`pushExpandedIds`）
 *
 * 语义边界：这条路是**会话级换查询单元**（tab2 临时查询，用完即弃），
 * 不写收藏表、不落 view-scope、不构成长期画像 —— 与「查看范围」是两件事。
 */

/** 勾选态切换（跨组累积；按 tag id 去重，保序） */
export function toggleTagSelection(prev: readonly TagIdEntry[], entry: TagIdEntry): TagIdEntry[] {
  return prev.some((x) => x.id === entry.id) ? prev.filter((x) => x.id !== entry.id) : [...prev, entry]
}

/** 查询计划：空选 => undefined；否则首个当锚点、其余进扩选 */
export function buildTagQueryPlan(
  picked: readonly TagIdEntry[],
): { anchor: TagIdEntry; expanded: TagIdEntry[] } | undefined {
  const [anchor, ...expanded] = picked
  return anchor ? { anchor, expanded } : undefined
}

/** 组内标签 chip 行（选中态由 picked 投影；保组内原序。q 非空时命中标签排前，稳定序） */
export type TagPeekRow = { id: number; name: string; picked: boolean }

export function tagPeekRows(group: Pick<TagGroup, 'tag_ids'>, picked: readonly TagIdEntry[], q = ''): TagPeekRow[] {
  const on = new Set(picked.map((x) => x.id))
  const rows = group.tag_ids.map((e) => ({ id: e.id, name: e.name, picked: on.has(e.id) }))
  const k = q.trim().toLowerCase()
  if (!k) return rows
  const hit = (name: string) => name.toLowerCase().includes(k)
  return rows.sort((a, b) => Number(hit(b.name)) - Number(hit(a.name)))
}

/** 该组内被选中的个数（行尾徽标「选 N」用） */
export function tagPeekPickedCount(group: Pick<TagGroup, 'tag_ids'>, picked: readonly TagIdEntry[]): number {
  const on = new Set(picked.map((x) => x.id))
  return group.tag_ids.filter((e) => on.has(e.id)).length
}

/**
 * 组级搜索命中：组名 或 组内任一标签名 含 q（大小写不敏感；空 q => false）。
 * 场景：组名是繁体「學生會也有洞」，但组内挂着简体 tag「学生会也有洞」——
 * 组名打不中简体词，tag 变体能。等于借 tag 列表白嫖了繁简/别名覆盖，无需简繁转换库。
 */
export function groupTagMatches(group: Pick<TagGroup, 'name' | 'tag_ids'>, q: string): boolean {
  const k = q.trim().toLowerCase()
  if (!k) return false
  return group.name.toLowerCase().includes(k) || group.tag_ids.some((e) => e.name.toLowerCase().includes(k))
}
