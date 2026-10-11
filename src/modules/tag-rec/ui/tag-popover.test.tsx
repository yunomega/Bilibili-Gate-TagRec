import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseTagRecDeepLink } from '../model/deeplink'
import { TagRecTagPopover } from './tag-popover'
import type * as React from 'react'
vi.mock('../store/workbench', () => ({
  addTagRecWorkingCondition: vi.fn(),
  excludeTagRecWorkingCondition: vi.fn(),
  removeTagRecWorkingCondition: vi.fn(),
}))
vi.mock('../store/combination-blocks', () => ({ blockTagRecConditionGlobally: vi.fn() }))

const h = await vi.hoisted(async () => {
  const { proxy } = await import('valtio')
  return {
    loadedStates: [] as unknown[],
    favorites: proxy({ list: [] }),
    session: proxy({ selectedGroupIds: [], expandedIds: [], draftGroup: undefined, anchor: undefined }),
  }
})

// SSR 从加载完成状态展开真实弹层/标签行, 只隔离取数与浏览器/GM 边界。
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(h.loadedStates.length ? h.loadedStates.shift() : initial),
  }
})
vi.mock('$modules/antd', () => ({ antMessage: {}, defineAntMenus: (items: unknown[]) => items.filter(Boolean) }))
vi.mock('$modules/antd/custom', () => ({ AntdTooltip: ({ children }: { children: unknown }) => children }))
vi.mock('$modules/icon', () => ({ IconForFav: () => null, IconForFaved: () => null }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchVideoTags: vi.fn(), invalidateVideoTagsCache: vi.fn() }))
vi.mock('../store', () => ({ favorites: {}, favoritesStore: h.favorites }))
vi.mock('../store/session', () => ({
  tagRecCustomSession: h.session,
  pushExpandedIds: vi.fn(),
  removeExpandedId: vi.fn(),
}))
vi.mock('./icons', () => ({ IconForTagBlock: () => null }))

describe('视频标签弹层 tag_id 跳转', () => {
  it.each(['三角洲行动', 'A&B / 中文+标签', '12345'])('标签「%s」链接在标签发掘开新组合', (name) => {
    vi.stubGlobal('location', { origin: 'https://www.bilibili.com' })
    try {
      h.loadedStates = [[{ tag_id: 2642704, tag_name: name }], 'ok']
      const html = renderToStaticMarkup(<TagRecTagPopover bvid='BV1xx411c7mD' />)
      const link = html.match(/<a\b[^>]*>\s*#2642704\s*<\/a>/)?.[0]
      expect(link).toBeDefined()
      const href = link!.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&')
      const url = new URL(href)
      expect(url.origin).toBe('https://www.bilibili.com')
      expect(url.pathname).toBe('/')
      expect(url.searchParams.get('gate-tab')).toBe('tag-rec-custom')
      expect(parseTagRecDeepLink(url.search).target).toEqual({ kind: 'new', id: 2642704, name })
      expect(link).toContain('target="_blank"')
      expect(link).toContain('新标签页打开「标签发掘」· 以此标签开新组合')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
