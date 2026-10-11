import { afterEach, describe, expect, it, vi } from 'vitest'

// GM 桩内存 kv (同 dry-tids-store.test.ts 手法); 独立文件 => 模块单例 map/防抖不串态
const STORAGE_KEY = 'tag-rec:dry-tids'
const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, def?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : def)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
})

const { DRY_TID_TTL_MS, isPersistedDryTid, loadDryTids, persistDryTid } = await import('./dry-tids-store')
const rows = () => (gmKv.get(STORAGE_KEY) ?? []) as [number, number][]

describe('$modules/tag-rec/api/dry-tids-store 持久层审计回归', () => {
  afterEach(() => vi.useRealTimers())

  it('AUDIT-26: flush 滤 TTL 死项 —— 过期 emptyUntil 不随下批写回携尸', async () => {
    vi.useFakeTimers()
    await loadDryTids()
    await persistDryTid(1)
    await vi.advanceTimersByTimeAsync(1_100) // 聚合窗落盘
    expect(rows().map(([tid]) => tid)).toEqual([1])

    await vi.advanceTimersByTimeAsync(DRY_TID_TTL_MS + 60_000) // 越过 TTL => tid1 死
    expect(isPersistedDryTid(1)).toBe(false)

    await persistDryTid(2)
    await vi.advanceTimersByTimeAsync(1_100) // flush2: 死项 tid1 被滤, 不再回写
    expect(rows().map(([tid]) => tid)).toEqual([2])
    expect(rows()[0][1]).toBeGreaterThan(Date.now())
  })
})
