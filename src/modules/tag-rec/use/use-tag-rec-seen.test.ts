import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ETab } from '$enums'
import { useTagRecSeen } from './use-tag-rec-seen'
import type { RecItemType } from '$define'

const h = vi.hoisted(() => ({
  editing: false,
  effects: [] as (() => void)[],
  visible: { current: undefined as string | undefined },
  onIntersection: undefined as ((inView: boolean) => void) | undefined,
  options: undefined as { skip: boolean; threshold: number; triggerOnce: boolean } | undefined,
  add: vi.fn(),
}))
vi.mock('react', () => ({
  useEffect: (effect: () => void) => h.effects.push(effect),
  useRef: () => h.visible,
}))
vi.mock('valtio', () => ({ useSnapshot: () => ({ scopeEditing: h.editing }) }))
vi.mock('react-intersection-observer', () => ({
  useOnInView: (callback: (inView: boolean) => void, options: typeof h.options) => {
    h.onIntersection = callback
    h.options = options
    return vi.fn()
  },
}))
vi.mock('$define', () => ({ checkIsTagRec: () => true }))
vi.mock('../store', () => ({ seen: { add: h.add } }))
vi.mock('../store/session', () => ({
  tagRecSharedSession: {
    get scopeEditing() {
      return h.editing
    },
  },
}))

describe('挑选范围期间暂停已看记录', () => {
  beforeEach(() => {
    h.editing = false
    h.effects = []
    h.visible.current = undefined
    h.onIntersection = undefined
    h.options = undefined
    h.add.mockClear()
  })
  const useRun = (tab = ETab.TagRecFav, bvid = 'BV1-test') => {
    h.effects = []
    useTagRecSeen({ bvid } as RecItemType, tab)
    h.effects.forEach((effect) => effect())
  }
  it('面板打开，即使卡片进入视口也不记已看', () => {
    h.editing = true
    useRun()
    h.onIntersection!(true)
    expect(h.add).not.toHaveBeenCalled()
  })
  it('面板关闭后恢复正常记录', () => {
    useRun()
    h.onIntersection!(true)
    expect(h.add).toHaveBeenCalledWith('BV1-test')
  })
  it('挑选期间已进入视口，关闭面板后补记', () => {
    h.editing = true
    useRun()
    h.onIntersection!(true)
    expect(h.add).not.toHaveBeenCalled()
    h.editing = false
    useRun()
    expect(h.add).toHaveBeenCalledWith('BV1-test')
  })
  it('未进入视口不记录，并保留半屏与单次观察条件', () => {
    useRun()
    h.onIntersection!(false)
    expect(h.add).not.toHaveBeenCalled()
    expect(h.options).toEqual({ threshold: 0.5, triggerOnce: true, skip: false })
  })
  it('非标签 tab 与缺失 bvid 不观察、不记录', () => {
    useRun(ETab.PcRecommend)
    expect(h.options?.skip).toBe(true)
    h.onIntersection!(true)
    useRun(ETab.TagRecCustom, '')
    expect(h.options?.skip).toBe(true)
    h.onIntersection!(true)
    expect(h.add).not.toHaveBeenCalled()
  })
  it('卡片换成另一个视频，不把旧视频的可见状态带过去', () => {
    h.editing = true
    useRun()
    h.onIntersection!(true)
    h.editing = false
    useRun(ETab.TagRecFav, 'BV2-new')
    expect(h.add).not.toHaveBeenCalled()
  })
})
