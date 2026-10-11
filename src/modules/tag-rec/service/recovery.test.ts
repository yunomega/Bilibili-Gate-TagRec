import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/settings', () => ({ settings: { tagRec: {} } }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
vi.mock('$modules/rec-services/service-map', () => ({ notifyTagRecSeenCleared: vi.fn() }))
vi.stubGlobal('GM', { getValue: vi.fn(() => Promise.resolve(undefined)), setValue: vi.fn(() => Promise.resolve()) })

const { favoritesStore, sediment, seen, tagRecStoresHydrated } = await import('../store')
const { tagRecSharedSession } = await import('../store/session')
const { clearTagRecSeenRecords, clearTagRecSedimentRecords } = await import('./recovery')
const { notifyTagRecSeenCleared } = await import('$modules/rec-services/service-map')
await tagRecStoresHydrated

beforeEach(() => {
  favoritesStore.list = [
    { id: 'g', name: '收藏组', tag_ids: [{ id: 1, name: '标签' }], enabled: true, weight: 1, addedAt: 1 },
  ]
  seen.clear()
  seen.add('BV-old')
  sediment.clear()
  sediment.noteDig('标签', { keyword: '标签', nextPage: 30, exhausted: true })
  sediment.confirm('标签')
  tagRecSharedSession.recoveryRevision = 0
  vi.mocked(notifyTagRecSeenCleared).mockClear()
})

describe('推荐记录恢复', () => {
  it('清空已看穿透内存去重并重置进度，收藏及标签关系保留', () => {
    clearTagRecSeenRecords()
    expect(seen.set.size).toBe(0)
    expect(notifyTagRecSeenCleared).toHaveBeenCalledOnce()
    expect(tagRecSharedSession.recoveryRevision).toBe(1)
    expect(favoritesStore.list[0].tag_ids).toHaveLength(1)
    expect(sediment.map.get('标签')?.dig).toBeUndefined()
    expect(sediment.map.get('标签')?.confirmed).toBe(true)
  })
  it('清空沉淀同时使当前服务失效，已看及收藏保留', () => {
    clearTagRecSedimentRecords()
    expect(sediment.map.size).toBe(0)
    expect(tagRecSharedSession.recoveryRevision).toBe(1)
    expect(seen.has('BV-old')).toBe(true)
    expect(favoritesStore.list).toHaveLength(1)
  })
})
