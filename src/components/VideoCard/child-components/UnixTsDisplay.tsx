import dayjs from 'dayjs'
import { memo, useMemo, useSyncExternalStore } from 'react'
import { subscribe } from 'valtio'
import { valtioFactory } from '$utility/valtio'
import { formatRecentTimestamp, isRecentTimestamp } from '$utility/video'

const $now = valtioFactory(() => Date.now())
const updateWhenVisible = () => {
  if (document.visibilityState === 'visible') $now.update()
}
const subscribeNow = (notify: () => void) => subscribe($now.state, notify)
// update every half minute
const firstTimeout = (dayjs().add(1, 'minute').startOf('minute').valueOf() - $now.get()) % 30_000
setTimeout(() => {
  updateWhenVisible()
  setInterval(updateWhenVisible, 30_000)
}, firstTimeout)
// update when switch tab back
document.addEventListener('visibilitychange', updateWhenVisible)

export const UnixTsDisplay = memo(function UnixTsDisplay({
  ts,
  includeTime,
}: {
  ts: number | undefined
  includeTime?: boolean
}) {
  if (!ts) return null
  return isRecentTimestamp(ts) ? (
    <ReactiveImpl ts={ts} includeTime={includeTime} />
  ) : (
    <PlainImpl ts={ts} includeTime={includeTime} />
  )
})

function PlainImpl({ ts, includeTime }: { ts: number; includeTime?: boolean }) {
  return useMemo(() => formatRecentTimestamp(ts, true, includeTime ?? false), [ts, includeTime])
}

function ReactiveImpl({ ts, includeTime }: { ts: number; includeTime?: boolean }) {
  const getSnapshot = useMemo(() => {
    let previousNow: number | undefined
    let formatted: string | undefined
    return () => {
      const now = $now.get()
      if (now !== previousNow) {
        previousNow = now
        // 首次挂载也读当前时间，避免共用时钟上次更新距今已有半分钟。
        formatted = formatRecentTimestamp(ts, true, includeTime ?? false)
      }
      return formatted
    }
  }, [ts, includeTime])
  // 昨天的日期、同一分钟等文案不变时，不再重渲染或重新挂载时间节点。
  return useSyncExternalStore(subscribeNow, getSnapshot, getSnapshot)
}
