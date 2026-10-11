import { subscribe } from 'valtio'
import { describe, expect, it, vi } from 'vitest'
import { valtioFactory } from './valtio'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))

describe('valtioFactory 更新通知', () => {
  it('尺寸不变时保留原值且不通知，尺寸变化时通知订阅者', () => {
    let width = 100
    const store = valtioFactory(() => ({ width, height: 200 }), {
      equals: (prev, next) => prev.width === next.width && prev.height === next.height,
    })
    const notify = vi.fn()
    const off = subscribe(store.state, notify, true)
    try {
      const previous = store.get()
      for (let i = 0; i < 10; i++) store.update()
      expect(store.get()).toBe(previous)
      expect(notify).not.toHaveBeenCalled()
      width = 300
      store.update()
      expect(store.get()).toEqual({ width: 300, height: 200 })
      expect(notify).toHaveBeenCalledOnce()
    } finally {
      off()
    }
  })

  it('未传比较器时保留原来的更新行为', () => {
    const store = valtioFactory(() => ({ value: 1 }))
    const previous = store.get()
    const notify = vi.fn()
    const off = subscribe(store.state, notify, true)
    try {
      store.update()
      expect(store.get()).not.toBe(previous)
      expect(notify).toHaveBeenCalledOnce()
    } finally {
      off()
    }
  })
})
