import { describe, expect, it, vi } from 'vitest'

// GM 桩内存 kv (同 dry-tids-store.test.ts 手法); tag-info-store 仅 type-import endpoints, 无网络依赖
const STORAGE_KEY = 'tag-rec:tag-info'
const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, def?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : def)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
})

const { TAG_INFO_STORE_CAP, getPersistedTagInfoById, getPersistedTagInfoByName, persistTagInfo } =
  await import('./tag-info-store')

describe('$modules/tag-rec/api/tag-info-store 持久层审计回归', () => {
  it('AUDIT-27: 读命中促活 —— 热键不被后续冷写顶淘汰 (LRU 读亦动序)', async () => {
    // 每 info 占 n:+i: 双键 => cap/2 条恰好填满池, tag0 双键在淘汰头部
    const n = TAG_INFO_STORE_CAP / 2
    for (let i = 0; i < n; i++) await persistTagInfo({ id: i, name: `tag${i}` }, `tag${i}`)

    // 读命中 n:tag0 => 促活移尾 (修复前读不动序, tag0 仍是头部)
    expect((await getPersistedTagInfoByName('tag0'))?.id).toBe(0)

    // 再写一条 => 淘汰最旧两槽: 修复后 = i:0(未被促活的孪生键) + n:tag1; 修复前 = n:tag0 + i:0
    await persistTagInfo({ id: 99999, name: 'overflow' }, 'overflow')
    expect(await getPersistedTagInfoByName('tag0')).toBeTruthy()
    expect(await getPersistedTagInfoByName('tag1')).toBeUndefined() // 新头部被顶出
    expect(await getPersistedTagInfoById(0)).toBeUndefined() // n:/i: 拆半残渣 —— 已知可容忍
    expect((await getPersistedTagInfoById(99999))?.name).toBe('overflow')
  })
})
