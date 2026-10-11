import { useHotkey, type RegisterableHotkey } from '@tanstack/react-hotkeys'
import { isEqual, pick } from 'es-toolkit'
import { get, set } from 'es-toolkit/compat'
import { antMessage } from '$modules/antd'
import { settings, type BooleanSettingsPath, type Settings } from '$modules/settings'

// [tag-rec] 票 perf-08: 快捷键注册抽轻模块,
// RecHeader 常驻渲染不再急切拉起整个 ModalSettings/pane 图

function useHotkeyForConfig(hotkey: RegisterableHotkey, configPath: BooleanSettingsPath, label: string) {
  return useHotkey(hotkey, (e) => {
    const current = Boolean(get(settings, configPath))
    const newValue = !current
    set(settings, configPath, newValue)
    antMessage.success({ content: `已${newValue ? '启用' : '禁用'}「${label}」`, key: `hotkey-${hotkey}` })
  })
}

type CardBorderState = Partial<Pick<Settings['style']['videoCard'], 'useBorder' | 'useBorderOnlyOnHover'>>
const borderCycleList: CardBorderState[] = [
  { useBorder: false }, // no border
  { useBorder: true, useBorderOnlyOnHover: true }, // on hover
  { useBorder: true, useBorderOnlyOnHover: false }, // always
]
export const borderCycleListLabels = ['「卡片边框」: 禁用', '「卡片边框」: 仅在悬浮时显示', '「卡片边框」: 总是显示']

export function useVideoCardBorderHotkeySetup() {
  return useHotkey('Shift+B', (e) => {
    const curState: CardBorderState = pick(settings.style.videoCard, ['useBorder', 'useBorderOnlyOnHover'])
    const curIndex = borderCycleList.findIndex((state) => {
      return isEqual(state, pick(curState, Object.keys(state) as (keyof CardBorderState)[]))
    })
    if (curIndex === -1) throw new Error('unexpected curIndex = -1')

    const nextIndex = (curIndex + 1) % borderCycleList.length
    const nextState = borderCycleList[nextIndex]
    Object.assign(settings.style.videoCard, nextState)

    const nextLabel = borderCycleListLabels[nextIndex]
    antMessage.success({ key: 'hotkey-border', content: nextLabel })
  })
}

// empty component for conditional render
export function ModalSettingsHotkey() {
  useHotkeyForConfig('Shift+P', 'videoCard.imgPreview.autoPreviewWhenHover', '自动预览: 鼠标悬浮')
  useVideoCardBorderHotkeySetup()
  return null
}
