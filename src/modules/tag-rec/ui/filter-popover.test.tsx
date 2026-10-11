import { renderToStaticMarkup } from 'react-dom/server'
import { proxy, snapshot } from 'valtio'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTagRecBuiltinPresets,
  createTagRecFactoryFilterCore,
  type TagRecFilterCore,
  type TagRecSessionFilterPatch,
} from '../model/filter-engine'
import { DimsSection } from './filter-form'
import { FilterPopover } from './tabbar-custom'
import type * as Antd from 'antd'
import type { Select } from 'antd'
import type { ComponentProps } from 'react'
vi.mock('./workbench', () => ({ TagRecWorkbenchView: () => null }))

const h = await vi.hoisted(async () => {
  const { proxy } = await import('valtio')
  return {
    session: proxy({ queryRevision: 0, filterOverride: undefined as TagRecFilterCore | undefined, tempWriteLog: [] }),
    favSession: proxy({
      filterScopeRevision: 0,
      filterOverride: undefined as TagRecSessionFilterPatch | undefined,
      tempWriteLog: [],
    }),
    settings: proxy({ tagRec: { filter: { presets: [], activePreset: '淘沙' } } }),
    selects: [] as ComponentProps<typeof Select>[],
  }
})

// 保留真实 FilterPopover -> SessionFilterEditor -> useSnapshot/名单表单链。
// SSR 展开 Popover 内容, 隔离浏览器/GM 与取数边界, 检查已有会话覆盖的首次渲染及后续深编辑。
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
    Select: (props: ComponentProps<typeof Select>) => {
      h.selects.push(props)
      return null
    },
  }
})
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$common/emotion-css', () => ({ usePopoverBorderColor: () => '#ddd' }))
vi.mock('$components/Recommends/rec.shared', () => ({ useOnRefresh: () => vi.fn(), useRecSelfContext: vi.fn() }))
vi.mock('$components/_base/HelpInfo', () => ({ HelpInfo: () => null }))
vi.mock('$modules/antd', () => ({ antModal: {} }))
vi.mock('$modules/antd/custom', () => ({ AntdTooltip: ({ children }: { children: unknown }) => children }))
vi.mock('$modules/rec-services/_base', () => ({ usePopupContainer: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: h.settings, useSettingsSnapshot: () => snapshot(h.settings) }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('../store', () => ({ favorites: {}, favoritesL1Store: {}, favoritesStore: {} }))
vi.mock('../store/session', () => ({
  tagRecCustomSession: h.session,
  tagRecFavSession: h.favSession,
  tagRecSharedSession: {},
  beginTagRecCustomQuery: vi.fn(),
  resetTagRecCustomFilter: vi.fn(),
  resetTagRecFavFilter: vi.fn(),
  switchTagRecGroupContext: vi.fn(),
}))
vi.mock('../service/temp-writes', () => ({
  canKeepTempEntryToGlobal: vi.fn(),
  clearTagRecTempWrites: vi.fn(),
  keepTagRecTempEntryToGlobal: vi.fn(),
  keepTagRecTempEntryToGroup: vi.fn(),
  removeTagRecTempWriteAt: vi.fn(),
}))
vi.mock('./banner', () => ({ TagRecBanner: () => null }))
vi.mock('./candidate-list', () => ({ TagRecCandidateList: () => null }))
vi.mock('./candidate-resolve-picker', () => ({ CandidateResolvePicker: () => null }))

const renderFilter = () => renderToStaticMarkup(<FilterPopover getPopupContainer={() => document.body} />)

beforeEach(() => {
  Object.assign(h.settings.tagRec.filter, createTagRecFactoryFilterCore(), {
    presets: createTagRecBuiltinPresets(),
    activePreset: '淘沙',
  })
  h.session.filterOverride = undefined
  h.favSession.filterOverride = undefined
  h.selects.length = 0
})

describe('会话过滤弹层', () => {
  it('主题推荐共享过滤入口，但显示本查看范围自己的临时名单', () => {
    h.favSession.filterOverride = { dims: { titleAllow: { enabled: true, list: ['主题临时词'] } } }
    const markup = renderToStaticMarkup(<FilterPopover scope='fav' getPopupContainer={() => document.body} />)
    expect(markup).toContain('本查看范围临时过滤 · 切换范围自动清除')
    expect(markup).toContain('主题临时词')
    expect(markup).toContain('清除临时过滤')
    expect(h.session.filterOverride).toBeUndefined()
    expect(renderFilter()).not.toContain('主题临时词')
  })

  it('跟随全局时正常渲染, 仅打开不产生会话覆盖', () => {
    expect(renderFilter()).toContain('跟随「标签过滤」')
    expect(h.session.filterOverride).toBeUndefined()
  })

  it('已有覆盖时以真实 proxy 渲染, 后续名单编辑仍可正常订阅', () => {
    const core = proxy(createTagRecFactoryFilterCore())
    const globalBefore = snapshot(h.settings)
    h.session.filterOverride = core
    const markup = renderFilter()
    expect(markup).toContain('本锚点临时过滤 · 换锚点池自动清除')
    expect(markup).toContain('清除临时过滤')
    expect(markup).toContain('aria-label="关闭临时过滤面板"')
    expect(markup.indexOf('清除临时过滤')).toBeLessThan(markup.indexOf('名单 (屏蔽 / 仅看)'))

    core.dims.titleAllow.enabled = true
    core.dims.titleAllow.list.push('回归关键词')
    expect(renderFilter()).toContain('回归关键词')
    expect(h.session.filterOverride).toBe(core)
    expect(snapshot(h.settings)).toBe(globalBefore)
  })

  it('预设、作用范围和名单下拉共享弹层内部容器', () => {
    renderFilter()
    expect(h.selects).toHaveLength(4)
    const container = h.selects[0].getPopupContainer
    expect(container).toBeTypeOf('function')
    for (const select of h.selects) expect(select.getPopupContainer).toBe(container)
  })

  it('时长维: 预设档下拉写回秒端点; 非预设端点落「自定义」并露时:分输入', () => {
    const core = proxy(createTagRecFactoryFilterCore())
    const renderRow = () =>
      renderToStaticMarkup(<DimsSection core={core} snap={snapshot(core)} disabled={false} only='numeric' />)
    renderRow()
    const dur = h.selects.find((s) =>
      (s.options as { label: string }[] | undefined)?.some((o) => o.label === '剧场版 ≥60分'),
    )!
    expect(dur.value).toBe('any')
    ;(dur.onChange as (v: string) => void)('mid')
    expect(core.dims.duration).toMatchObject({ min: 300, max: 1800 })
    core.dims.duration.min = 95
    h.selects.length = 0
    const markup = renderRow()
    expect(
      h.selects.find((s) => (s.options as { label: string }[] | undefined)?.some((o) => o.label === '剧场版 ≥60分'))!
        .value,
    ).toBe('custom')
    expect(markup).toContain('时')
    expect(markup).toContain('分')
  })
})
