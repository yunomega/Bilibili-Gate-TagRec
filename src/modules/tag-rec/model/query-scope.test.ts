import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { createTagRecQueryMatcher } from './query-scope'
import type { TagRecItemExtend } from '$define'

const match = createTagRecQueryMatcher([
  { id: 7, name: '医生' },
  { id: 9, name: '护士' },
])
const related = (patch: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'tag-rec:BV1',
  bvid: 'BV1',
  title: 'cosplay',
  pic: '',
  stat: {},
  source: { via: 'all-v2-related', groupNames: ['医生·相关'] },
  ...patch,
})

describe('仅看的原查询范围', () => {
  it('UP 搜索只认服务器查询关键词，不把归因组名当成标签证据', () => {
    expect(match(related({ source: { via: 'up-search', groupNames: ['cosplay'], queryKeyword: '医生' } }))).toBe(true)
    expect(match(related({ source: { via: 'up-search', groupNames: ['医生'], queryKeyword: 'cosplay' } }))).toBe(false)
    expect(match(related({ source: { via: 'up-search', groupNames: ['医生'] } }))).toBe(false)
  })

  it('主池与精确搜索已有查询证据, 不要求主池额外补查标签', () => {
    for (const via of ['tag-top', 'all-v2-exact'] as const)
      expect(match(related({ source: { via, groupNames: ['医生'] } }))).toBe(true)
  })

  it('相关池须命中原查询标签/id/标题, 归因写医生不算命中', () => {
    for (const via of ['all-v2-related', 'archive-related'] as const) {
      const source = { via, groupNames: ['医生·相关'] }
      expect(match(related({ source, ownTagNames: ['cosplay'] }))).toBe(false)
      expect(match(related({ source }))).toBe(false)
      expect(match(related({ source, ownTagNames: ['医生', 'cosplay'] }))).toBe(true)
      expect(match(related({ source, ownTagIds: [7, 8] }))).toBe(true)
      expect(match(related({ source, title: '医生 cosplay' }))).toBe(true)
      expect(match(related({ source, ownTagNames: ['护士', 'cosplay'] }))).toBe(true)
    }
  })

  it('标签整名归一, 标题延用至少两字符的查询匹配, 空查询不放行相关池', () => {
    const english = createTagRecQueryMatcher([{ id: 7, name: 'Doctor' }])
    expect(english(related({ ownTagNames: ['ＤＯＣＴＯＲ', 'cosplay'] }))).toBe(true)
    expect(english(related({ ownTagNames: ['Doctor Who', 'cosplay'] }))).toBe(false)
    expect(createTagRecQueryMatcher([{ id: 7, name: '医' }])(related({ title: '医学生 cosplay' }))).toBe(false)
    expect(createTagRecQueryMatcher([])(related())).toBe(false)
  })
})
