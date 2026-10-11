import { theme } from 'antd'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useSnapshot } from 'valtio'
import { tagRecDiscoveryPreferences } from '../store/discovery-ui'

const DiscoveryShelfContext = createContext<HTMLElement | null>(null)
export const useTagRecDiscoveryShelf = () => useContext(DiscoveryShelfContext)
const DiscoveryToolbarContext = createContext<HTMLElement | null>(null)
export const useTagRecDiscoveryToolbar = () => useContext(DiscoveryToolbarContext)
const DiscoveryHeaderContext = createContext<HTMLElement | null>(null)
/** 当前组合卡槽位: 与工具栏同处一个吸顶栈, 展开时随页面滚动一起吸住。 */
export const useTagRecDiscoveryHeader = () => useContext(DiscoveryHeaderContext)
const DiscoveryMetaContext = createContext<HTMLElement | null>(null)
/** 元信息行槽位 (来源池开关/待核实/视频大小): 展开时挂进吸顶栈底, 收起时留在正文流里。 */
export const useTagRecDiscoveryMeta = () => useContext(DiscoveryMetaContext)

/** Both page and modal keep the shelf beside the actual video grid. */
export function TagRecDiscoveryLayout({
  controls,
  children,
  stickyTop = 0,
}: {
  controls: ReactNode
  children: ReactNode
  stickyTop?: number
}) {
  const { collapsed } = useSnapshot(tagRecDiscoveryPreferences)
  const { token } = theme.useToken()
  const stackBackground = `var(--bilibili-gate--bg, ${token.colorBgContainer})`
  const [shelf, setShelf] = useState<HTMLElement | null>(null)
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
  const [header, setHeader] = useState<HTMLElement | null>(null)
  const [meta, setMeta] = useState<HTMLElement | null>(null)
  const shelfWidth = collapsed ? 48 : 216

  const aside = (
    <aside
      ref={setShelf}
      aria-label='我的组合书架'
      css={{
        // 书架有自己的列；列表单独滚动，标题、搜索和管理入口始终可见。
        'position': 'sticky',
        'top': stickyTop,
        'display': 'flex',
        'minWidth': 0,
        'maxHeight': `calc(100dvh - ${stickyTop + 16}px)`,
        'overflow': 'hidden',
        'boxSizing': 'border-box',
        'border': `1px solid ${token.colorBorderSecondary}`,
        'borderRadius': 12,
        'background': stackBackground,
        '@media (max-width: 1100px)': { position: 'relative', top: 0, maxHeight: collapsed ? 56 : 380 },
      }}
    />
  )
  return (
    <DiscoveryShelfContext.Provider value={shelf}>
      <DiscoveryToolbarContext.Provider value={toolbar}>
        <DiscoveryHeaderContext.Provider value={header}>
          <DiscoveryMetaContext.Provider value={meta}>
            <div
              data-discovery-layout
              data-collapsed={collapsed}
              css={{
                'display': 'grid',
                'gridTemplateColumns': `${shelfWidth}px minmax(0, 1fr)`,
                'gap': 16,
                'width': '100%',
                'alignItems': 'start',
                '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 },
              }}
            >
              {aside}
              <main style={{ minWidth: 0 }}>
                {/* 吸顶栈: 工具栏 + 当前组合卡 (展开时) 一起吸住; 内容从它下面滚过去。
                  背景用插件页面底色 (缺失时回落 antd 容器色), 保证滚过去的内容不会从缝里透出来;
                  ::before 上溢 6px —— 补齐标签栏与吸顶栈之间的轻量留白,
                  用它盖住那条缝, 否则滚动时卡片会从 tab bar 与工具栏之间穿过去 */}
                <div
                  data-discovery-sticky-stack
                  css={{
                    'position': 'sticky',
                    'top': stickyTop,
                    'zIndex': 100,
                    'paddingBottom': 4,
                    'background': stackBackground,
                    '&::before': {
                      content: '""',
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: -6,
                      height: 6,
                      background: stackBackground,
                    },
                  }}
                >
                  <div ref={setToolbar} data-discovery-toolbar />
                  <div ref={setHeader} data-discovery-header />
                  <div ref={setMeta} data-discovery-meta />
                </div>
                {controls}
                {children}
              </main>
            </div>
          </DiscoveryMetaContext.Provider>
        </DiscoveryHeaderContext.Provider>
      </DiscoveryToolbarContext.Provider>
    </DiscoveryShelfContext.Provider>
  )
}
