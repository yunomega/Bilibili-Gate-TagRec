import { FloatButton } from 'antd'
import { delay } from 'es-toolkit'
import { APP_CLS_ROOT, appWarn, createReactRoot } from '$common'
import { AppRoot, SetupForPage } from '$components/AppRoot'
import { GateFloatEntry } from '$components/GateFloatEntry'
import { registerSettingsGmCommand } from '$components/RecHeader/modals'
import { getCurrentUsingTab } from '$components/RecHeader/tab' // [tag-rec] 票 perf-09
import { PureRecommend } from '$components/Recommends/PureRecommend'
import { prewarmTabService } from '$modules/rec-services/service-map' // [tag-rec] 票 perf-09
import { settings } from '$modules/settings'
import { getEntryTab, getOnlyTab, inGateEntry } from '$routes'
import { isSafari } from '$ua'
import { poll, tryAction, tryToRemove } from '$utility/dom'
import { perfMark } from '$utility/perf-mark' // [tag-rec] perf 票 01
import { initDefaultHomepageLargePreview } from '../default-homepage'
import { initMyRelations } from './init-relations'
import type { Root } from 'react-dom/client'

const bewlyEnabledSelector = 'html.bewly-design:not(:has(#i_cecream,#app))'
function hasBewlyBewly() {
  return !!document.querySelector(bewlyEnabledSelector)
}

// 有时入口检测不到 bewly, bewly 比本脚本后运行, 在渲染完成后, 持续检测一段时间, 检测到取消渲染
function tryDetectBewlyBewly() {
  return tryAction(
    bewlyEnabledSelector,
    () => {
      appWarn(`unmount for using bewly-design`)
      root?.unmount()
    },
    {
      pollTimeout: 5_000,
      warnOnTimeout: false,
    },
  )
}

let root: Root | undefined

export async function initHomepage() {
  tryToRemove('.adblock-tips') // 提示有插件影响
  tryToRemove('.vip-login-tip') // 登录-大会员券
  tryAction('html.gray', (el) => el.classList.remove('gray')) // 变灰
  registerSettingsGmCommand()
  if (hasBewlyBewly()) {
    return appWarn(`quit for using bewly-design`)
  }

  // wait fetch login info
  // await initLoginStorePromise

  // fetch relations
  initMyRelations()

  const shouldInit = settings.pureRecommend || inGateEntry() || getOnlyTab() || getEntryTab() // [tag-rec] getEntryTab 尾项
  if (shouldInit) {
    await initHomepagePureRecommend()
    tryDetectBewlyBewly()
  } else {
    initHomepageGateFloatEntry()
    if (settings.videoCard.videoPreview.addTo.defaultHomepage) {
      initDefaultHomepageLargePreview()
    }
  }
}

function initHomepageGateFloatEntry() {
  const container = document.createElement('section')
  container.classList.add(APP_CLS_ROOT)
  document.body.append(container)

  root = createReactRoot(container)
  root.render(
    <AppRoot>
      <SetupForPage antd baseGlobalStyle />
      <GateFloatEntry />
    </AppRoot>,
  )
}

// [tag-rec] 票 perf-09: 与下方 header-poll/createReactRoot/React 首渲窗口并行,
//   预建当前 tab 的 service 并发起首个 loadMore, 经 useRefresh 'reuse' 的
//   existingService/serviceRegistry 通道喂给组件 —— 抹平 mount→fetch 串行段。
//   纯优化: 任何失败静默吞掉, 正常挂载路径不受影响。
function prewarmCurrentTabService() {
  try {
    prewarmTabService(getCurrentUsingTab())
  } catch {
    // noop
  }
}

async function initHomepagePureRecommend() {
  // let bilibili default content run
  if (isSafari) await delay(500)

  prewarmCurrentTabService() // [tag-rec] 票 perf-09

  tryToRemove('#i_cecream .bili-feed4-layout, body > #app .bili-feed4-layout') // main content
  tryToRemove('.bili-feed4 .header-channel')
  tryToRemove('.palette-button-wrap') // 右侧浮动按钮

  const biliLayout = document.createElement('div')
  biliLayout.classList.add('bili-feed4-layout', 'pure-recommend', APP_CLS_ROOT)
  // biliLayout should come after header+channel
  await poll(() => document.querySelector('.bili-feed4 .bili-header'), { interval: 20, timeout: 2_000 })
  document.body.append(biliLayout)

  const container = document.createElement('div')
  biliLayout.append(container)
  perfMark('premount') // [tag-rec] perf 票 01: bili-header poll 通过、React 挂载前
  root = createReactRoot(container)
  root.render(
    <AppRoot>
      <SetupForPage antd baseGlobalStyle homePageGlobalStyle />
      <PureRecommend />
      <FloatButton.BackTop
        style={{
          // right
          insetInlineEnd: 'var(--back-top-right, 24px)',
        }}
      />
    </AppRoot>,
  )
  // [tag-rec] AUDIT-13: root.render() 只是调度, 真实 commit/paint 在其后 —— 'mounted' 打在调用点会让
  //   gm/index.ts 的冷启回放隔离窗提前关闭 (回放 drain 撞上 React 首渲 commit)。挪进首帧 rAF 回调:
  //   commit 必早于同帧 rAF。mark 名 `gate:mounted` 是 gm/index.ts 的哨兵消费点 (另一代理独占文件), 不可改;
  //   'first-frame' 紧随其后同窗打出
  requestAnimationFrame(() => {
    perfMark('mounted')
    perfMark('first-frame')
  })
}
