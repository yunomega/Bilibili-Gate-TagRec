import { expect, it } from 'vitest'
import { TagRecAutoContinuation } from './auto-continuation'

it('滚动续批不重叠，两批完成之间至少间隔八秒', () => {
  const gate = new TagRecAutoContinuation()
  expect(gate.start(0)).toBe(true)
  expect(gate.start(100)).toBe(false)
  gate.finish(5_000, 6)
  expect(gate.delay(6_000)).toBe(7_000)
  expect(gate.start(12_999)).toBe(false)
  expect(gate.start(13_000)).toBe(true)
})
it('连续两批没有新视频进入歇息，一分钟冷却到期自动再试，手动继续或有产出后清账', () => {
  const gate = new TagRecAutoContinuation()
  gate.start(0)
  gate.finish(1_000, 0)
  gate.start(9_000)
  gate.finish(10_000, 0)
  expect(gate.stalled).toBe(true)
  expect(gate.delay(30_000)).toBe(40_000)
  expect(gate.start(69_999)).toBe(false)
  expect(gate.start(70_000)).toBe(true)
  gate.finish(71_000, 0)
  expect(gate.stalled).toBe(true)
  expect(gate.delay(72_000)).toBe(59_000) // 探针仍零产 => 冷却从本轮重算, 不 0 延迟忙循环
  gate.resume()
  expect(gate.start(80_000)).toBe(true)
  gate.finish(81_000, 3)
  gate.start(89_000)
  gate.finish(90_000, 0)
  expect(gate.stalled).toBe(false)
})
