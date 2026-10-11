import { throttle } from 'es-toolkit'
import { useSyncExternalStore } from 'react'
import { subscribe } from 'valtio'
import { valtioFactory } from '$utility/valtio'

type Size = [width: number, height: number]
let size: Size = [window.innerWidth, window.innerHeight]

export function useWindowSize() {
  return useSyncExternalStore(subscribeSize, getSize)
}

const subscribeSize = (notify: () => void) => subscribe($windowSize.state, notify)
const getSize = () => {
  const { width, height } = $windowSize.get()
  if (size[0] !== width || size[1] !== height) size = [width, height]
  return size
}

export const $windowSize = valtioFactory(() => ({ width: window.innerWidth, height: window.innerHeight }), {
  equals: (prev, next) => prev.width === next.width && prev.height === next.height,
})

window.addEventListener('resize', $windowSize.updateThrottled)
window.addEventListener('orientationchange', $windowSize.updateThrottled)
document.addEventListener('scroll', throttle($windowSize.update, 1000), { passive: true })
