import { afterEach, describe, expect, it, vi } from 'vitest'
import { evalTagRecPartitionEntry, mergeTagRecPartitionFields } from '../model/partition'
import { getCachedTagRecPartition, rememberTagRecPartition } from './partition-cache'

afterEach(() => vi.useRealTimers())

describe('分区事实缓存', () => {
  it('旧字段召回不会不断延长旧新版证据的有效期', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
    const bvid = 'partition-native-ttl'
    rememberTagRecPartition(bvid, { tidv2: 2071, pid_v2: 1008 })
    vi.setSystemTime(Date.now() + 30 * 60_000)
    rememberTagRecPartition(bvid, { typeid: 65 })
    expect(getCachedTagRecPartition(bvid)?.tidv2).toBe(2071)
    vi.setSystemTime(Date.now() + 31 * 60_000)
    expect(getCachedTagRecPartition(bvid)).toBeUndefined()
  })

  it('同 BV 新版叶分区变化，旧候选和缓存的父分区都不能继续参与判定', () => {
    const bvid = 'partition-new-leaf'
    const old = { tidv2: 2071, pid_v2: 1008, tnamev2: '旧游戏' }
    rememberTagRecPartition(bvid, old)
    const previous = getCachedTagRecPartition(bvid)
    rememberTagRecPartition(bvid, { tid_v2: 2090 })
    const current = getCachedTagRecPartition(bvid)!
    expect(previous?.pid_v2).toBe(1008)
    expect(current.pid_v2).toBeUndefined()
    expect(mergeTagRecPartitionFields(old, current).pid_v2).toBeUndefined()
    expect(evalTagRecPartitionEntry(mergeTagRecPartitionFields(old, current), { name: '游戏', v2: 1008 })).toBe(
      'mismatch',
    )
  })
})
