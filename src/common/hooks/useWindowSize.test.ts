import { subscribe } from 'valtio'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $windowSize } from './useWindowSize'

vi.hoisted(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 600 }))
  vi.stubGlobal('document', new EventTarget())
})
vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))

afterEach(() => {
  $windowSize.updateThrottled.cancel()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('共享窗口尺寸', () => {
  it('滚动不通知尺寸订阅者，原生窗口缩放和旋转会更新', async () => {
    vi.useFakeTimers()
    const notify = vi.fn()
    const off = subscribe($windowSize.state, notify, true)
    try {
      document.dispatchEvent(new Event('scroll'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(notify).not.toHaveBeenCalled()
      Object.assign(window, { innerWidth: 900, innerHeight: 500 })
      window.dispatchEvent(new Event('resize'))
      await vi.advanceTimersByTimeAsync(100)
      expect($windowSize.get()).toEqual({ width: 900, height: 500 })
      expect(notify).toHaveBeenCalledOnce()
      Object.assign(window, { innerWidth: 500, innerHeight: 900 })
      window.dispatchEvent(new Event('orientationchange'))
      await vi.advanceTimersByTimeAsync(100)
      expect($windowSize.get()).toEqual({ width: 500, height: 900 })
      expect(notify).toHaveBeenCalledTimes(2)
    } finally {
      off()
    }
  })
})
