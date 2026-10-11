import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TagRecTidDryTracker } from '../service/_pipeline'
import { DRY_TID_TTL_MS, isPersistedDryTid, persistDryTid } from './dry-tids-store'

// _pipeline 链上的 IO 边界同 _pipeline.test.ts 手法; GM 桩内存 kv (同 favorites-l1.test.ts)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const STORAGE_KEY = 'tag-rec:dry-tids'
const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, def?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : def)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
})

const rows = () => (gmKv.get(STORAGE_KEY) ?? []) as [number, number][]
/** 微任务排空 (note() 内 persist 是 void 火忘, 走池链 ~4 hop —— 20 轮稳达) */
const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// 串行: store 模块级 map/防抖是单例, 用例用不同 tid 防串态
describe('$modules/tag-rec/api/dry-tids-store (票39 空源记忆跨会话)', () => {
  beforeEach(() => {
    gmKv.clear()
    vi.mocked(GM.getValue).mockClear()
    vi.mocked(GM.setValue).mockClear()
  })

  it('empty 标干经 tracker.note 落盘; F5 (模块重载) 后持久图命中 isDry', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new TagRecTidDryTracker({ persistEmpty: true })
      tracker.note([{ tid: 7, fetched: 0, contributed: 0, ok: true }]) // 空响应即干 => empty 分流落盘
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1_100) // 防抖聚合窗口落盘
      expect(isPersistedDryTid(7)).toBe(true)
      expect(rows()).toEqual([[7, expect.any(Number)]])
      expect(rows()[0][1]).toBeGreaterThan(Date.now())

      // F5 = 模块重载: 同 GM 仓重读 => 内存图空的 tracker 也判干 (不再重打死源)
      vi.resetModules()
      const store2 = await import('./dry-tids-store')
      await store2.loadDryTids()
      expect(store2.isPersistedDryTid(7)).toBe(true)
      const tracker2 = new (await import('../service/_pipeline')).TagRecTidDryTracker({ persistEmpty: true })
      expect(tracker2.isDry(7)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('TTL 到期自然复活: 读侧放行 + 重载读盘即弃到期项', async () => {
    vi.useFakeTimers()
    try {
      await persistDryTid(8)
      expect(isPersistedDryTid(8)).toBe(true)

      await vi.advanceTimersByTimeAsync(DRY_TID_TTL_MS + 1) // 越过 60min TTL
      expect(isPersistedDryTid(8)).toBe(false) // 到期 => 重获一轮探测机会
      await vi.advanceTimersByTimeAsync(1_000) // 顺手消化任何挂起 flush

      vi.resetModules()
      const store2 = await import('./dry-tids-store')
      await store2.loadDryTids()
      expect(store2.isPersistedDryTid(8)).toBe(false) // 读盘惰性过期: 死记录不再复活
    } finally {
      vi.useRealTimers()
    }
  })

  it('零新增连击只落内存图不落盘: 三页到顶才干, 且 F5 后重获机会', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new TagRecTidDryTracker({ persistEmpty: true })
      // 首页两轮零新增 => 进 pn=2; 深页同 => 进 pn=3; 到顶连击 => 干 (翻页游标只走内存)
      for (const pn of [1, 1, 2, 2, 3]) tracker.note([{ tid: 9, pn, fetched: 5, contributed: 0, ok: true }])
      expect(tracker.isDry(9)).toBe(false)
      tracker.note([{ tid: 9, pn: 3, fetched: 5, contributed: 0, ok: true }])
      expect(tracker.isDry(9)).toBe(true)
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(1_100)
      expect(rows().some(([tid]) => tid === 9)).toBe(false) // 语义分裂: zeroNewStreak 不持久
      expect(isPersistedDryTid(9)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('签名变 clear 只清内存图: 持久图保留 (tid 干是源属性, TTL 兜底复活)', async () => {
    const tracker = new TagRecTidDryTracker({ persistEmpty: true })
    tracker.note([{ tid: 10, fetched: 0, contributed: 0, ok: true }])
    await flushMicrotasks()
    expect(tracker.isDry(10)).toBe(true)

    tracker.clear() // 成员签名变 => 内存干态全清
    expect(tracker.size).toBe(0)
    expect(tracker.isDry(10)).toBe(true) // 持久图仍判干 —— 空源不因语境切换重获机会

    // 对照: 会话级 tracker (persistEmpty 关, tab1 形态) clear 后即刻复活
    const sessionTracker = new TagRecTidDryTracker()
    sessionTracker.note([{ tid: 11, fetched: 0, contributed: 0, ok: true }])
    expect(sessionTracker.isDry(11)).toBe(true)
    sessionTracker.clear()
    expect(sessionTracker.isDry(11)).toBe(false)
    await flushMicrotasks()
    expect(rows().some(([tid]) => tid === 11)).toBe(false) // 会话级 tracker 也不写盘
  })
})
