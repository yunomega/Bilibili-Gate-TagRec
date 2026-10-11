import { notifyTagRecSeenCleared } from '$modules/rec-services/service-map'
import { sediment, seen } from '../store'
import { tagRecSharedSession } from '../store/session'

/** 恢复浏览过的内容，从头召回但保留标签关系；两 tab 的内存状态在下次刷新时重新建立。 */
export function clearTagRecSeenRecords() {
  seen.clear()
  sediment.resetDigProgress()
  notifyTagRecSeenCleared()
  tagRecSharedSession.recoveryRevision += 1
}

/** 观察语料与进度可重新采集；刷新时同时丢弃服务内的旧挖掘进度。 */
export function clearTagRecSedimentRecords() {
  sediment.clear()
  tagRecSharedSession.recoveryRevision += 1
}
