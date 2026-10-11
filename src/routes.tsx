import { ETab, isTagRecTab } from '$enums' // [tag-rec] isTagRecTab/getEntryTab 引入
import { SHOW_DYNAMIC_FEED_ONLY } from '$modules/rec-services/dynamic-feed/store'
import { SHOW_FAV_TAB_ONLY } from '$modules/rec-services/fav/store'
import { SHOW_SPACE_UPLOAD_ONLY } from '$modules/rec-services/space-upload/store'

export function getOnlyTab() {
  if (SHOW_DYNAMIC_FEED_ONLY) return ETab.DynamicFeed
  if (SHOW_FAV_TAB_ONLY) return ETab.Fav
  if (SHOW_SPACE_UPLOAD_ONLY) return ETab.SpaceUpload
  const t = getGateTabParam()
  // tagrec 深链落的是完整 app —— 只激活不收栏,走 getEntryTab();非 tagrec 值保持单栏语义
  if (t && !isTagRecTab(t)) return t
}

function getGateTabParam(): ETab | null {
  return searchParams.get(GateQueryKey.Tab) as ETab | null
}

/** [tag-rec] gate-tab=tag-rec-* 落点 —— 「入口激活」而非 onlyTab: 激活该 tab,tab 栏全量可见 */
export function getEntryTab(): ETab | undefined {
  const t = getGateTabParam()
  return t && isTagRecTab(t) ? t : undefined
}

export enum GateQueryKey {
  MainSwitch = 'gate',
  Tab = 'gate-tab',
}

export const searchParams = new URL(location.href).searchParams

export function inGateEntry() {
  return searchParams.has(GateQueryKey.MainSwitch)
}

export function getGateEntryHref() {
  const u = new URL(location.href)
  u.search = ''
  u.searchParams.set(GateQueryKey.MainSwitch, '1')
  return u.href
}
