import { renderToStaticMarkup } from 'react-dom/server'
import { proxy } from 'valtio'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTagRecFactoryFilterCore } from '../model/filter-engine'
import { TagRecScopeConfigEditor } from './scope-config-editor'
import type * as Antd from 'antd'
import type { ComponentProps } from 'react'
import type { TagRecNegativeRules } from '../model/types'

const h = await vi.hoisted(async () => {
  const { proxy } = await import('valtio')
  return {
    settings: proxy({ tagRec: { filter: { presets: [], activePreset: '' } } }),
    onOks: [] as (() => void)[],
  }
})

// SSR 直出 Modal 内容 (rc-dialog 走 portal, 无 document 时不渲染); 其余 antd 用真件
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof Antd>()
  return {
    ...actual,
    Modal: ({ title, children, onOk }: ComponentProps<typeof actual.Modal>) => {
      h.onOks.push(onOk as () => void)
      return (
        <div>
          {title}
          {children}
        </div>
      )
    },
  }
})
// $common 顶层读 location (Node 无此全局); 隔离掉即可让 filter-engine/_pipeline 链在 node 环境加载
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$modules/antd', () => ({ antModal: {} }))
vi.mock('$modules/settings', () => ({ settings: h.settings, useSettingsSnapshot: () => h.settings }))
vi.mock('$components/_base/HelpInfo', () => ({ HelpInfo: () => null }))
vi.mock('$components/ModalSettings/tab-panes/shared', () => ({ sharedClassNames: { settingsLine: '' } }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('../store', () => ({
  favoritesStore: proxy({ list: [] }),
  favoritesL1Store: proxy({ list: [] }),
  themesStore: proxy({ list: [] }),
}))
vi.mock('./candidate-resolve-picker', () => ({ CandidateResolvePicker: () => null }))
// 断掉 api -> request -> $common 的真链 (与 filter-engine.test.ts 同口径)
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const core = () => createTagRecFactoryFilterCore()

const renderEditor = (neg: TagRecNegativeRules | undefined, onSave = vi.fn()) => {
  const base = core()
  const markup = renderToStaticMarkup(
    <TagRecScopeConfigEditor
      title='标签组「类恶魔城」配置'
      core={base}
      slots={[{ key: 'group', label: '整组 (各池共用)' }]}
      resolve={() => base}
      resolveBase={() => base}
      negativeOf={() => neg}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  )
  return { markup, onSave }
}

beforeEach(() => {
  h.onOks.length = 0
})

describe('组配置弹层名单 tab: R8 仅看家族可配置', () => {
  it('与临时过滤同档: 渲染 UP主/标题/简介 三个仅看行并回显既有名单', () => {
    const { markup } = renderEditor({
      upAllow: { enabled: true, list: [{ name: 'UP甲', mid: 7 }] },
      titleAllow: { enabled: true, list: ['标题词'] },
      descAllow: { enabled: false, list: ['简介词'] },
    })
    // 默认停在「名单」tab: 阈值 tab 的维度开关区不渲染 => 下面的标签只可能来自名单区新行
    expect(markup).not.toContain('维度开关')
    expect(markup).toContain('UP 主·仅看')
    expect(markup).toContain('标题·仅看词')
    expect(markup).toContain('简介·仅看词')
    expect(markup).toContain('UP甲 (mid:7)')
    expect(markup).toContain('标题词')
    expect(markup).toContain('简介词')
  })

  it('存盘把三个仅看键写进 negative 容器 (打包上传下载同一容器)', () => {
    const { onSave } = renderEditor({
      upAllow: { enabled: true, list: [{ name: 'UP甲', mid: 7 }] },
      titleAllow: { enabled: true, list: ['标题词'] },
      descAllow: { enabled: false, list: ['简介词'] },
    })
    h.onOks.at(-1)!()
    expect(onSave).toHaveBeenCalledTimes(1)
    const entries = onSave.mock.calls[0][0] as { key: string; negative?: TagRecNegativeRules }[]
    expect(entries[0].key).toBe('group')
    expect(entries[0].negative).toEqual({
      upAllow: { enabled: true, list: [{ name: 'UP甲', mid: 7 }] },
      titleAllow: { enabled: true, list: ['标题词'] },
      descAllow: { enabled: false, list: ['简介词'] },
    })
  })
})
