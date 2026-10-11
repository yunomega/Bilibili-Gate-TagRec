import { css } from '@emotion/react'
import { useMemoizedFn, usePrevious } from 'ahooks'
import { Radio, Segmented } from 'antd'
import { Fragment, useDeferredValue, useEffect, useMemo, type ReactNode } from 'react'
import { useSnapshot, type UseSnapshotOptions } from 'valtio'
import { HelpInfo } from '$components/_base/HelpInfo'
import { ETab } from '$enums'
import { getLoginStatus, toastNeedLogin, useLoginStatus } from '$modules/login-status'
import { getSettingsSnapshot, settings, useSettingsSnapshot } from '$modules/settings'
import { shouldShowTagRecCustomDot } from '$modules/tag-rec/model/favorites' // [tag-rec]
import { favoritesStore } from '$modules/tag-rec/store' // [tag-rec]
import { getEntryTab, getOnlyTab } from '$routes'
import { proxyWithGmStorage } from '$utility/valtio'
import { TabConfig, TabIcon, type TabConfigItem } from './tab-config'
import { ALL_TAB_KEYS, CONFIGURABLE_TAB_KEYS } from './tab-enum'

/**
 * initial tab
 */
export const videoSourceTabState = await proxyWithGmStorage<{ value: ETab }>(
  { value: ETab.AppRecommend },
  `video-source-tab`,
)
{
  const onlyTab = getOnlyTab()
  const entryTab = getEntryTab()
  if (onlyTab) videoSourceTabState.value = onlyTab
  else if (entryTab) videoSourceTabState.value = entryTab
  // [tag-rec] 落点引导不靠 toast —— tab 栏全量可见本身是入口,「标签发掘」发现走一次性红点
}

function getSortedTabKeys(customTabKeysOrder: ETab[]) {
  return CONFIGURABLE_TAB_KEYS.slice().sort((a, b) => {
    let aIndex = customTabKeysOrder.indexOf(a)
    let bIndex = customTabKeysOrder.indexOf(b)
    if (aIndex === -1) aIndex = ALL_TAB_KEYS.indexOf(a)
    if (bIndex === -1) bIndex = ALL_TAB_KEYS.indexOf(b)
    return aIndex - bIndex
  })
}

export function useSortedTabKeys(options?: UseSnapshotOptions) {
  const { customTabKeysOrder } = useSettingsSnapshot(options)
  return useMemo(() => getSortedTabKeys(customTabKeysOrder), [customTabKeysOrder])
}

export function useCurrentDisplayingTabKeys() {
  const { hidingTabKeys, customTabKeysOrder } = useSettingsSnapshot()
  const logined = useLoginStatus()
  const onlyTab = useMemo(getOnlyTab, [])
  const keys = useMemo(() => {
    const tabkeys = getSortedTabKeys(customTabKeysOrder)
    return tabkeys.filter((key) => {
      if (key === ETab.AppRecommend && !logined) return true // when not logined, show AppRecommend regardless of `hidingTabKeys`
      return !hidingTabKeys.includes(key)
    })
  }, [hidingTabKeys, customTabKeysOrder, logined])

  if (onlyTab) return [onlyTab]
  return keys
}

function useCurrentDisplayingTabConfigList(): ({ key: ETab } & TabConfigItem)[] {
  const keys = useCurrentDisplayingTabKeys()
  return useMemo(() => keys.map((key) => ({ key, ...TabConfig[key] })), [keys])
}

export function useCurrentUsingTab(): ETab {
  const tab = useSnapshot(videoSourceTabState).value
  const displayingTabKeys = useCurrentDisplayingTabKeys()
  const logined = useLoginStatus()
  const fallbackTab = ETab.AppRecommend

  // only tab
  // login status 需要 service 自己保证
  if (displayingTabKeys.length === 1) return displayingTabKeys[0]

  // invalid
  if (!displayingTabKeys.includes(tab)) return fallbackTab

  // not logined
  if (
    !logined && // 不允许游客访问
    !TabConfig[tab].anonymousUsage
  ) {
    return fallbackTab
  }

  return tab
}

// [tag-rec] 票 perf-09: 非 hook 版「当前 tab」解析, 镜像 useCurrentDisplayingTabKeys +
//   useCurrentUsingTab 的判定(onlyTab > 单可见 tab > 隐藏/未登录 fallback AppRecommend),
//   供 initHomepagePureRecommend 在 mount 前按当前 tab 预热 service。
export function getCurrentUsingTab(): ETab {
  const { hidingTabKeys, customTabKeysOrder } = getSettingsSnapshot()
  const logined = getLoginStatus()
  const fallbackTab = ETab.AppRecommend

  const onlyTab = getOnlyTab()
  if (onlyTab) return onlyTab

  const displayingTabKeys = getSortedTabKeys([...customTabKeysOrder]).filter((key) => {
    if (key === ETab.AppRecommend && !logined) return true // 同 useCurrentDisplayingTabKeys
    return !hidingTabKeys.includes(key)
  })
  if (displayingTabKeys.length === 1) return displayingTabKeys[0]

  const tab = videoSourceTabState.value
  if (!displayingTabKeys.includes(tab)) return fallbackTab
  if (!logined && !TabConfig[tab].anonymousUsage) return fallbackTab
  return tab
}

export function useDeferredTab() {
  const tab = useDeferredValue(useCurrentUsingTab())
  const prevTab = usePrevious(tab)
  const tabOrders = useSortedTabKeys()
  const direction = useMemo(() => {
    return prevTab
      ? tabOrders.indexOf(tab) > tabOrders.indexOf(prevTab)
        ? ('right' as const)
        : ('left' as const)
      : undefined
  }, [tabOrders, tab]) // only SYNC with `tab`
  return { tab, prevTab, direction }
}

const radioBtnCss = css`
  /* as child */
  vertical-align: top;

  /* as container */
  height: 32px;
  line-height: 0;
  --ant-border-radius: 16px;

  &:has(:focus-visible) {
    outline: none;
    outline-offset: unset;
  }

  .ant-radio-button-label {
    display: inline-block;
    height: 100%;
  }
`

// [tag-rec] 「标签发掘」tab 内联红点: ~6px 实心圆紧跟 label, inline 元素不占额外行高
const tagRecCustomDotEl = <span className='ml-4px inline-block size-6px rounded-full bg-red-500 align-middle' />

export function VideoSourceTab({ className }: { className?: string }) {
  const tab = useCurrentUsingTab()
  const currentTabConfigList = useCurrentDisplayingTabConfigList()
  const { __internalRecTabRenderAsSegments, tagRec } = useSettingsSnapshot()
  // [tag-rec] 「标签发掘」tab 内联红点 (一次性发现引导): 收藏表非空 (手动收藏/分享导入皆可) 且未见过该 tab
  const { list: tagFavGroups } = useSnapshot(favoritesStore)
  const showTagRecCustomDot = shouldShowTagRecCustomDot(tagRec.customTabSeen, tagFavGroups.length)
  // 激活一次即置位落盘 (覆盖点击/深链 onlyTab/程序化切换 share-import 全部入口), 红点永不再现
  useEffect(() => {
    if (tab === ETab.TagRecCustom && !settings.tagRec.customTabSeen) settings.tagRec.customTabSeen = true
  }, [tab])
  const onChangeTab = useMemoizedFn((newTab: ETab) => {
    if (!TabConfig[newTab].anonymousUsage && !getLoginStatus()) {
      return toastNeedLogin()
    }
    videoSourceTabState.value = newTab
  })

  const renderAsRadio = (
    <Radio.Group
      optionType='button'
      buttonStyle='solid'
      size='middle'
      value={tab}
      className={className}
      onFocus={(e) => {
        // 不移除 focus, refresh `r` 无法响应
        const target = e.target as HTMLElement
        target.blur()
      }}
      onChange={(e) => {
        const newValue = e.target.value as ETab
        onChangeTab(newValue)
      }}
    >
      {currentTabConfigList.map(({ key, label }) => (
        <Radio.Button
          css={radioBtnCss}
          className='video-source-tab' // can be used to customize css
          tabIndex={-1}
          value={key}
          key={key}
        >
          <span className='h-full inline-flex-center align-top'>
            <TabIcon tabKey={key} className='mr-4px' active={key === tab} />
            {label}
            {key === ETab.TagRecCustom && showTagRecCustomDot && tagRecCustomDotEl} {/* [tag-rec] 红点 */}
          </span>
        </Radio.Button>
      ))}
    </Radio.Group>
  )

  let renderAsSegment: ReactNode
  {
    const options = useMemo(() => {
      return currentTabConfigList.map(({ key, label }) => {
        return {
          value: key,
          label: (
            <div className='flex items-center gap-x-6px'>
              <TabIcon tabKey={key} active={key === tab} />
              {label}
              {key === ETab.TagRecCustom && showTagRecCustomDot && tagRecCustomDotEl} {/* [tag-rec] 红点 */}
            </div>
          ),
        }
      })
    }, [currentTabConfigList, tab, showTagRecCustomDot])
    renderAsSegment = <Segmented<ETab> size='middle' options={options} value={tab} onChange={onChangeTab} />
  }

  return (
    <div className='flex-v-center'>
      {__internalRecTabRenderAsSegments ? renderAsSegment : renderAsRadio}
      <HelpInfo className='ml-6px size-16px'>
        <>
          {currentTabConfigList.map(({ key, label, desc, extraHelpInfo }) => (
            <Fragment key={key}>
              <div className='h-22px flex items-center'>
                <TabIcon tabKey={key} className='mr-4px' active />
                {label}: {desc}
              </div>
              {!!extraHelpInfo && extraHelpInfo}
            </Fragment>
          ))}
        </>
      </HelpInfo>
    </div>
  )
}
