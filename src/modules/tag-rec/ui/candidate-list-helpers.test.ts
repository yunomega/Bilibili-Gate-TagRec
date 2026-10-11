import { describe, expect, it } from 'vitest'
import { tagRecSaveCountParts } from './candidate-list-helpers'

// A2 实修: 「顺手存成项」按钮按并入来源分解 —— 已选行 ∪ 扩选暂存 ∪ 查询词, 与
//   saveAsFavoriteGroup 三路去重口径对齐 (勾中锚点行/已入暂存的锚点不再虚报)

const row = (checked: boolean, extra: { expanded?: boolean; tag_id?: number } = {}) => ({
  checked,
  expanded: extra.expanded ?? false,
  tag_id: extra.tag_id,
})
const anchor = { id: 100, name: '锚点' }

describe('tagRecSaveCountParts (草稿语境「顺手存成项」来源分解)', () => {
  it('三源全在 => 全段; 各源计数=并入贡献', () => {
    const parts = tagRecSaveCountParts({
      rows: [row(true, { tag_id: 1 }), row(true, { tag_id: 2 }), row(false, { tag_id: 3 })],
      expandedIds: [{ id: 50, name: '扩' }],
      anchor,
    })
    expect(parts).toEqual(['2 已选', '1 扩选', '查询词'])
  })

  it('锚点已被勾中行覆盖 => 查询词段消失 (不双计同 id)', () => {
    const parts = tagRecSaveCountParts({
      rows: [row(true, { tag_id: 100 }), row(true, { tag_id: 1 })],
      expandedIds: [],
      anchor,
    })
    expect(parts).toEqual(['2 已选'])
  })

  it('锚点已在扩选暂存 => 查询词段消失', () => {
    const parts = tagRecSaveCountParts({
      rows: [],
      expandedIds: [{ id: 100, name: '锚点' }],
      anchor,
    })
    expect(parts).toEqual(['1 扩选'])
  })

  it('勾中的 expanded 行经暂存位计入扩选段, 已选不重复计', () => {
    const parts = tagRecSaveCountParts({
      rows: [row(true, { expanded: true, tag_id: 50 }), row(true, { tag_id: 1 })],
      expandedIds: [{ id: 50, name: '扩' }],
      anchor: undefined,
    })
    expect(parts).toEqual(['1 已选', '1 扩选'])
  })

  it('边角: 行晚解析后 id 撞暂存位 => 仍归扩选段不虚增; 未解析行计已选', () => {
    const parts = tagRecSaveCountParts({
      rows: [row(true, { tag_id: 50 }), row(true)], // 未解析行 (tag_id undefined)
      expandedIds: [{ id: 50, name: '扩' }],
      anchor: undefined,
    })
    expect(parts).toEqual(['1 已选', '1 扩选'])
  })

  it('全空 => 无段; 纯锚点 => 仅查询词', () => {
    expect(tagRecSaveCountParts({ rows: [], expandedIds: [], anchor: undefined })).toEqual([])
    expect(tagRecSaveCountParts({ rows: [], expandedIds: [], anchor })).toEqual(['查询词'])
  })
})
