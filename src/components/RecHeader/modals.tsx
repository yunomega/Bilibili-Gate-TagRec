import { once } from 'es-toolkit'
import { lazy, Suspense } from 'react'
import { proxy, useSnapshot } from 'valtio'
import { APP_CLS_ROOT, createReactRoot } from '$common'
import { AppRoot } from '$components/AppRoot'

// [tag-rec] 票 perf-08: 弹层图(ModalSettings 全部 pane + ModalFeed)惰性求值,
// SystemJS 单文件内 module.import 边界保留 —— 首次打开弹层才 eval
const ModalSettings = lazy(() => import('$components/ModalSettings').then((m) => ({ default: m.ModalSettings })))
const ModalFeed = lazy(() => import('$components/Recommends/ModalFeed').then((m) => ({ default: m.ModalFeed })))

export const modalsState = proxy({
  modalFeedVisible: false,
  modalSettingsVisible: false,
})

export function useModalsState() {
  return useSnapshot(modalsState)
}

export function toggleModalFeed() {
  if (modalsState.modalFeedVisible) {
    hideModalFeed()
  } else {
    showModalFeed()
  }
}
export function showModalFeed() {
  renderOnce()
  modalsState.modalFeedVisible = true
}
export function hideModalFeed() {
  modalsState.modalFeedVisible = false
}

export function toggleModalSettings() {
  if (modalsState.modalSettingsVisible) {
    hideModalSettings()
  } else {
    showModalSettings()
  }
}
export function showModalSettings() {
  renderOnce()
  modalsState.modalSettingsVisible = true
}
export function hideModalSettings() {
  modalsState.modalSettingsVisible = false
}

export function registerSettingsGmCommand() {
  GM.registerMenuCommand?.('⚙️ 设置', showModalSettings)
}

const renderOnce = once(function render() {
  const container = document.createElement('div')
  container.classList.add('modals-container', APP_CLS_ROOT)
  document.body.appendChild(container)
  createReactRoot(container).render(
    <AppRoot>
      <ModalsContainer />
    </AppRoot>,
  )
})

function ModalsContainer() {
  const { modalFeedVisible, modalSettingsVisible } = useModalsState()
  return (
    // [tag-rec] lazy import 配套 Suspense (ModalFeed/ModalSettings 均 React.lazy)
    <Suspense fallback={null}>
      <ModalFeed show={modalFeedVisible} onHide={hideModalFeed} />
      <ModalSettings show={modalSettingsVisible} onHide={hideModalSettings} />
    </Suspense>
  )
}
