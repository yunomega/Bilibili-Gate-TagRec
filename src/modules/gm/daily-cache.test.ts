import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$common', () => ({ appWarn: vi.fn(), APP_NAME: 'test', APP_NAMESPACE: 'test' }))

const gmKv = new Map<string, unknown>()
const defaultList = () => Promise.resolve([...gmKv.keys()])
let listImpl: () => Promise<string[]> = defaultList
const deleteValueMock = vi.fn((key: string) => Promise.resolve(void gmKv.delete(key)))
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string) => Promise.resolve(gmKv.get(key))),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
  deleteValue: deleteValueMock,
  listValues: vi.fn(() => listImpl()),
})

const { appWarn } = await import('$common')
const { dailyCache } = await import('./daily-cache')

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('$modules/gm/daily-cache 持久层审计回归', () => {
  afterEach(() => {
    vi.useRealTimers()
    listImpl = defaultList
    gmKv.clear()
    deleteValueMock.mockClear()
    vi.mocked(appWarn).mockClear()
  })

  it('AUDIT-30(a): cleanUp listValues 异常被接住 => appWarn 记录, 无 unhandled rejection', async () => {
    listImpl = () => Promise.reject(new Error('list-down'))
    dailyCache('dc-fail') // 构造即 fire-and-forget cleanUp —— 修复前拒绝无人接
    await flushMicrotasks()
    expect(vi.mocked(appWarn)).toHaveBeenCalled()
  })

  it('AUDIT-30(b): 跨零点窗只删严格更旧键 —— 新日键/异名键/非日键不误删', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T23:59:59.900'))
    let resolveList!: (keys: string[]) => void
    listImpl = () => new Promise((r) => (resolveList = r))
    dailyCache('dc-mid') // cleanUp 发出 listValues (悬空跨过零点)
    vi.setSystemTime(new Date('2025-06-02T00:00:00.100'))
    // 快照里既有新日键 (他 tab/并发刚写) 也有旧键 —— 旧实现按捕获的昨日界会删 06-02
    resolveList(['dc-mid:2025-05-30', 'dc-mid:2025-06-01', 'dc-mid:2025-06-02', 'other:2020-01-01', 'dc-mid:odd'])
    await flushMicrotasks()

    const deleted = deleteValueMock.mock.calls.map(([k]) => k)
    expect(deleted).toEqual(expect.arrayContaining(['dc-mid:2025-05-30', 'dc-mid:2025-06-01']))
    expect(deleted).not.toContain('dc-mid:2025-06-02') // 新日键存活
    expect(deleted).not.toContain('other:2020-01-01') // 异名前缀不动
    expect(deleted).not.toContain('dc-mid:odd') // 非日格式键保守保留
  })

  it('set/get 走当日键往返; cleanUp 失败不传染读写', async () => {
    const dc = dailyCache<string>('dc-io')
    await dc.set('v1')
    let key = ''
    for (const k of gmKv.keys()) {
      if (k.startsWith('dc-io:')) {
        key = k
        break
      }
    }
    expect(gmKv.get(key)).toBe('v1')
    expect(await dc.get()).toBe('v1')

    listImpl = () => Promise.reject(new Error('list-down'))
    await dc.set('v2') // set 内 cleanUp 失败被接住, setValue 照常
    await flushMicrotasks()
    expect(await dc.get()).toBe('v2')
    expect(vi.mocked(appWarn)).toHaveBeenCalled()
  })
})
