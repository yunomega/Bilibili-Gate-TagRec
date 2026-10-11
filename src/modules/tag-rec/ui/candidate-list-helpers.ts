import type { CandidateRow } from '../model/resolve'
import type { TagIdEntry } from '../model/types'

/**
 * A2 实修: 「顺手存成项」按钮按并入来源分解 —— 并入集 = 已选行 ∪ 扩选暂存 ∪ 查询词(锚点独立槽位),
 *   与 saveAsFavoriteGroup 的 checked∪expandedIds∪anchor 三路去重合并口径对齐:
 *   - 已选 = 勾中且未入暂存的行 (expanded 行/已解析 id 在暂存位的行不重计 —— 并入按 tag_id 去重);
 *   - 扩选 = expandedIds 暂存条数;
 *   - 查询词 = 锚点独立槽位, 仅当它没被前两路覆盖才计 (勾中锚点行/锚点已入暂存 => 不再虚报名额)。
 *   防「按钮显示 2、实际存进 4」的落差: 用户按之前即知实际会带入哪些来源。
 */
export function tagRecSaveCountParts(opts: {
  rows: readonly Pick<CandidateRow, 'checked' | 'expanded' | 'tag_id'>[]
  expandedIds: readonly TagIdEntry[]
  anchor: TagIdEntry | undefined
}): string[] {
  const expIds = new Set(opts.expandedIds.map((e) => e.id))
  const checkedNew = opts.rows.filter(
    (r) => r.checked && !r.expanded && (r.tag_id === undefined || !expIds.has(r.tag_id)),
  ).length
  const anchor = opts.anchor
  const anchorExtra = !!anchor && !opts.rows.some((r) => r.checked && r.tag_id === anchor.id) && !expIds.has(anchor.id)
  return [
    checkedNew ? `${checkedNew} 已选` : '',
    opts.expandedIds.length ? `${opts.expandedIds.length} 扩选` : '',
    anchorExtra ? '查询词' : '',
  ].filter(Boolean)
}
