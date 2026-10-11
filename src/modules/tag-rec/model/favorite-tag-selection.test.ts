import { describe, expect, it } from 'vitest'
import { createTagRecFavoriteTagIndex } from './favorite-tag-selection'

describe('收藏层级标签快照', () => {
  it('主题、一级、二级只展开正向成员, 重叠选择按 ID 去重, 不复制配置或负向', () => {
    const groups = [
      {
        id: 'a',
        name: '二级A',
        l1Id: 'l1',
        enabled: false,
        tag_ids: [{ id: 1, name: '标签A' }],
        negative_tag_ids: [{ id: 9, name: '负向' }],
      },
      {
        id: 'b',
        name: '二级B',
        l1Id: 'l1',
        tag_ids: [
          { id: 1, name: '别名' },
          { id: 2, name: '标签B' },
        ],
        overrides: { negative: { tagAllow: { enabled: true, list: [{ id: 8, name: '仅看配置' }] } } },
      },
      { id: 'c', name: '二级C', l1Id: 'l2', tag_ids: [{ id: 3, name: '标签C' }] },
      { id: 'orphan', name: '未归属', tag_ids: [{ id: 4, name: '标签D' }] },
    ]
    const l1s = [
      { id: 'l1', name: '一级A', themeId: 'theme' },
      { id: 'l2', name: '一级B', themeId: 'other' },
    ]
    const index = createTagRecFavoriteTagIndex(groups, l1s, [
      { id: 'theme', name: '主题A' },
      { id: 'other', name: '主题B' },
      { id: 'empty', name: '空主题' },
    ])
    const selected = index.select(['theme:theme', 'l1:l1', 'l2:a', 'missing'])
    expect(selected).toEqual([
      { id: 1, name: '标签A' },
      { id: 2, name: '标签B' },
    ])
    expect(index.options.find((option) => option.value === 'l2:b')?.label).toBe(
      '二级组 · 主题A / 一级A / 二级B (2 标签)',
    )
    expect(index.options.find((option) => option.value === 'theme:empty')?.disabled).toBe(true)
    expect(index.select(['l2:orphan'])).toEqual([{ id: 4, name: '标签D' }])
    groups[0].tag_ids[0].name = '收藏后续改名'
    expect(selected[0].name).toBe('标签A')
    selected[1].name = '名单改名'
    expect(groups[1].tag_ids[1].name).toBe('标签B')
  })

  it('万条成员与重叠选项本地展开, 不限成员数也不重复返回', () => {
    const tags = Array.from({ length: 10_000 }, (_, i) => ({ id: i + 1, name: `标签${i + 1}` }))
    const index = createTagRecFavoriteTagIndex(
      [{ id: 'a', name: '大组', l1Id: 'l1', tag_ids: tags }],
      [{ id: 'l1', name: '一级', themeId: 'theme' }],
      [{ id: 'theme', name: '主题' }],
    )
    const selected = index.select(['theme:theme', 'l1:l1', 'l2:a'])
    expect(selected).toHaveLength(10_000)
    expect(selected[9_999]).toEqual(tags[9_999])
    expect(selected[9_999]).not.toBe(tags[9_999])
  })
})
