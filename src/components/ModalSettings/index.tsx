import { css } from '@emotion/react'
import { Tabs } from 'antd'
import { useSnapshot } from 'valtio'
import { BaseModal, BaseModalClassNames, ModalClose } from '$components/_base/BaseModal'
import { IconForConfig } from '$modules/icon'
import { TabPaneTagFavorites } from '$modules/tag-rec/ui/pane-tag-favorites' // [tag-rec]
import { TabPaneTagFilter } from '$modules/tag-rec/ui/pane-tag-filter' // [tag-rec]
import { modalSettingsStore, TabPaneKey } from './shared'
import { TabPaneAdvance } from './tab-panes/pane-advance'
import { TabPaneBasic } from './tab-panes/pane-basic'
import { TabPaneFilter } from './tab-panes/pane-filter'
import { TabPaneOtherPages } from './tab-panes/pane-other-pages'
import { TabPaneRecTabsConfig } from './tab-panes/pane-rec-tab-config'
import { TabPaneVideoCard } from './tab-panes/pane-video-card'
import { sharedClassNames } from './tab-panes/shared'
import { ThemesSelect } from './theme'

const customTabsCss = css`
  &.ant-tabs {
    .ant-tabs-tab {
      justify-content: end;
      padding-inline: 5px 15px; /* 8 24 */
    }

    /* https://github.com/ant-design/ant-design/issues/43541 */
    .ant-tabs-nav-operations {
      display: none;
    }
  }
`

export function ModalSettings({ show, onHide }: { show: boolean; onHide: () => void }) {
  const { tab } = useSnapshot(modalSettingsStore)

  return (
    <BaseModal
      show={show}
      onHide={onHide}
      hideWhenMaskOnClick={true}
      hideWhenEsc={true}
      width='calc(100vw - 48px)' /* [tag-rec] 近最大化 (原 width={900}) */
      clsModalMask='[&:has(svg.peeking)]:bg-transparent'
      /* 近最大化 (feat: 点开设置即大面板): 高固定 calc(100vh-48px) + 摘 90vh 上限, 留 24px 外边距保浮层观感 */
      clsModal='max-h-unset h-[calc(100vh-48px)] [&:has(svg.peeking)]:opacity-10'
    >
      <div className={BaseModalClassNames.modalHeader}>
        <div className={BaseModalClassNames.modalTitle}>
          <IconForConfig className='mr-4px mt--2px size-26px' />
          设置
        </div>
        <ModalClose onClick={onHide} />
      </div>

      {/* issue 设置项里面的滚动条怎么是双份的 */}
      <main className={BaseModalClassNames.modalBody} style={{ overflow: 'hidden' }}>
        <Tabs
          tabPlacement='start'
          size='middle'
          css={customTabsCss}
          activeKey={tab}
          onChange={(tab) => (modalSettingsStore.tab = tab as TabPaneKey)}
          items={[
            {
              label: '常规设置',
              key: TabPaneKey.Basic,
              children: <TabPaneBasic />,
            },
            {
              label: '视频卡片',
              key: TabPaneKey.VideoCard,
              children: <TabPaneVideoCard />,
            },
            {
              label: '内容过滤',
              key: TabPaneKey.Filter,
              children: <TabPaneFilter />,
            },
            {
              label: '主题选择',
              key: TabPaneKey.ThemeSelect,
              children: (
                <div className={sharedClassNames.tabPane}>
                  <ThemesSelect />
                </div>
              ),
            },
            {
              label: 'Tab 设置',
              key: TabPaneKey.VideoSourceTabConfig,
              children: <TabPaneRecTabsConfig />,
            },
            {
              label: '其他页面',
              key: TabPaneKey.OtherPages,
              children: <TabPaneOtherPages />,
            },
            {
              label: '标签收藏', // [tag-rec]
              key: TabPaneKey.TagRecFavorites,
              children: <TabPaneTagFavorites />,
            },
            {
              label: '标签过滤', // [tag-rec]
              key: TabPaneKey.TagRecFilter,
              children: <TabPaneTagFilter />,
            },
            {
              label: '高级设置',
              key: TabPaneKey.Advance,
              children: <TabPaneAdvance />,
            },
          ]}
        />
      </main>
    </BaseModal>
  )
}
