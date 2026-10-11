import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TagRecThemeScopePicker } from './theme-scope-picker'
import type * as Antd from 'antd'
import type { ComponentProps } from 'react'
import type { TagGroup, TagL1Group, TagTheme } from '../model/types'
import type { TagRecViewScope } from '../model/view-scope'

const h = await vi.hoisted(async () => {
  const { proxy } = await import('valtio')
  const theme: TagTheme = { id: 't1', name: 'T', addedAt: 1 }
  const l1: TagL1Group = { id: 'l1', name: 'L', themeId: 't1', enabled: true, weight: 1, addedAt: 1 }
  const groups: TagGroup[] = [
    {
      id: 'g1',
      name: 'G1',
      l1Id: 'l1',
      enabled: true,
      weight: 1,
      addedAt: 1,
      tag_ids: [
        { id: 11, name: 'CHIP-A' },
        { id: 12, name: 'CHIP-B' },
        { id: 13, name: 'CHIP-C' },
      ],
    },
    { id: 'g2', name: 'G2', l1Id: 'l1', enabled: true, weight: 1, addedAt: 1, tag_ids: [{ id: 14, name: 'CHIP-D' }] },
  ]
  const scope: TagRecViewScope = {}
  const groupScope: Record<string, string[]> = {}
  return {
    favoritesStore: proxy({ list: groups }),
    favoritesL1Store: proxy({ list: [l1] }),
    themesStore: proxy({ list: [theme] }),
    viewScopeStore: proxy({ scope, groupScope }),
    session: proxy({ tempEnabledL1Ids: [] as string[], tempEnabledGroupIds: [] as string[], scopeEditing: false }),
    tab: { value: '' },
    begin: vi.fn(),
    push: vi.fn(),
  }
})

// 强制读取 content，确保关闭态本身也不会构造隐藏列表。
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof Antd>()
  return {
    ...actual,
    Popover: ({ content, children }: ComponentProps<typeof actual.Popover>) => (
      <div>
        {typeof content === 'function' ? content() : content}
        {children}
      </div>
    ),
  }
})
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$enums', () => ({ ETab: { TagRecCustom: 'tag-rec-custom' } }))
vi.mock('$components/RecHeader/tab', () => ({ videoSourceTabState: h.tab }))
vi.mock('../store', () => ({
  favorites: {},
  favoritesL1: {},
  favoritesStore: h.favoritesStore,
  favoritesL1Store: h.favoritesL1Store,
  themesStore: h.themesStore,
  viewScopeStore: h.viewScopeStore,
}))
vi.mock('../store/session', () => ({
  tagRecSharedSession: h.session,
  beginTagRecCustomQuery: h.begin,
  pushExpandedIds: h.push,
}))

const render = () => renderToStaticMarkup(<TagRecThemeScopePicker onChanged={() => {}} />)

describe('「只看」选择器关闭态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.viewScopeStore.scope = {}
    h.viewScopeStore.groupScope = {}
  })

  it('显示已提交的触发器，不构造隐藏树或搜索控件', () => {
    const html = render()
    expect(html).toContain('主题：当前启用')
    expect(html).not.toContain('观看一级组：L')
    expect(html).not.toContain('搜索主题、一级组、二级组或标签')
    expect(html).not.toContain('保存选择')
  })

  it('临时范围仍正确显示已提交的组名摘要', () => {
    h.viewScopeStore.groupScope = { l1: ['g1'] }
    const html = render()
    expect(html).toContain('只看：G1')
    expect(html).not.toContain('观看二级组')
  })

  it('未展开组内标签时不泄漏标签名，也不出底部动作条', () => {
    const html = render()
    expect(html).not.toContain('CHIP-A')
    expect(html).not.toContain('CHIP-D')
    expect(html).not.toContain('只看选中的标签')
  })
})
