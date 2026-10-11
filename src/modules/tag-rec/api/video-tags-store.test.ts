import { describe, expect, it, vi } from 'vitest'
import { getPersistedVideoTags, persistVideoTags, VIDEO_TAGS_STORE_CAP } from './video-tags-store'

// store 惰性 pool(): 首次调用才触 GM.getValue —— GM 桩内存 kv (同 dry-tids-store.test.ts 手法)
const STORAGE_KEY = 'tag-rec:video-tags'
const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, def?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : def)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
})

// 串行: store 模块级 map/防抖是单例, 用例用不同 bvid 防串态
describe('$modules/tag-rec/api/video-tags-store', () => {
  it('AUDIT-11: name-only 回写不清完整条目 tag_id/tag_type (防乒乓降级), 归一名命中补齐', async () => {
    const bvid = 'BV-audit11-a'
    await persistVideoTags(bvid, [
      { tag_id: 11, tag_name: '原神', tag_type: 'topic' },
      { tag_id: 22, tag_name: 'Demons Roots', tag_type: 'old_channel' },
    ])
    // 深挖流 name-only 覆盖 (resolve.ts runPhase2Round 落盘形态)
    await persistVideoTags(bvid, [{ tag_name: '原神' }, { tag_name: 'demons  roots' }, { tag_name: '新名' }])
    expect(await getPersistedVideoTags(bvid)).toEqual([
      { tag_id: 11, tag_name: '原神', tag_type: 'topic' },
      { tag_id: 22, tag_name: 'demons  roots', tag_type: 'old_channel' }, // 归一名命中, 新写法名保留
      { tag_id: undefined, tag_name: '新名', tag_type: undefined }, // 旧名单外 => id 缺口照常落
    ])
  })

  it('name-only 先写 (无旧条目) => 原样落 name-only 白嫖位; 后续完整写整体覆盖', async () => {
    const bvid = 'BV-audit11-b'
    await persistVideoTags(bvid, [{ tag_name: 'a' }, { tag_name: 'b' }])
    expect(await getPersistedVideoTags(bvid)).toEqual([
      { tag_id: undefined, tag_name: 'a', tag_type: undefined },
      { tag_id: undefined, tag_name: 'b', tag_type: undefined },
    ])
    await persistVideoTags(bvid, [
      { tag_id: 1, tag_name: 'a', tag_type: 'bgm' },
      { tag_id: 2, tag_name: 'c' },
    ])
    // 成员以新名单为准 ('b' 弃); 完整写自带 id/type 为准
    expect(await getPersistedVideoTags(bvid)).toEqual([
      { tag_id: 1, tag_name: 'a', tag_type: 'bgm' },
      { tag_id: 2, tag_name: 'c', tag_type: undefined },
    ])
  })

  it('新条目自带 id 不被旧条目同名片覆盖; name-only 反复写幂等', async () => {
    const bvid = 'BV-audit11-c'
    await persistVideoTags(bvid, [{ tag_id: 1, tag_name: 'x' }])
    await persistVideoTags(bvid, [{ tag_id: 9, tag_name: 'x' }]) // 新写自带 id => 不动
    expect((await getPersistedVideoTags(bvid))?.[0].tag_id).toBe(9)
    await persistVideoTags(bvid, [{ tag_name: 'x' }]) // name-only 再写 => 借回 id 9
    expect((await getPersistedVideoTags(bvid))?.[0].tag_id).toBe(9)
  })

  it('name-only 子集快照不收缩完整名单 (合并而非覆盖); 权威写仍可整单替换', async () => {
    const bvid = 'BV-partial-shrink'
    await persistVideoTags(bvid, [
      { tag_id: 1, tag_name: 'A' },
      { tag_id: 2, tag_name: 'B' },
      { tag_id: 3, tag_name: 'C' },
    ])
    // 晚到的旧搜索快照只含子集 (无 tag_id => 推断 partial) —— 成员/id 都不丢
    await persistVideoTags(bvid, [{ tag_name: 'A' }, { tag_name: 'B' }])
    expect(await getPersistedVideoTags(bvid)).toEqual([
      { tag_id: 1, tag_name: 'A', tag_type: undefined },
      { tag_id: 2, tag_name: 'B', tag_type: undefined },
      { tag_id: 3, tag_name: 'C', tag_type: undefined },
    ])
    // 权威写 (带 id) 整单替换照旧; 显式 partial:false 的空名单也允许收缩到「无标签」
    await persistVideoTags(bvid, [{ tag_id: 9, tag_name: 'Z' }])
    expect(await getPersistedVideoTags(bvid)).toEqual([{ tag_id: 9, tag_name: 'Z', tag_type: undefined }])
    await persistVideoTags(bvid, [], { partial: false })
    expect(await getPersistedVideoTags(bvid)).toEqual([])
  })

  it('W1-7: 读命中促活 —— 常读条目挪尾不被新写挤掉 (LRU 语义, 非 FIFO)', async () => {
    const hot = 'BV-lru-hot'
    await persistVideoTags(hot, [{ tag_name: 'h' }]) // 最老位
    for (let i = 0; i < VIDEO_TAGS_STORE_CAP - 1; i++) {
      await persistVideoTags(`BV-lru-${i}`, [{ tag_name: 'x' }]) // 填满至 cap
    }
    await getPersistedVideoTags(hot) // 读命中 => 挪到最新位
    await persistVideoTags('BV-lru-overflow', [{ tag_name: 'y' }]) // 淘汰此刻最旧 = BV-lru-0, 非 hot
    expect(await getPersistedVideoTags(hot)).toBeTruthy()
    expect(await getPersistedVideoTags('BV-lru-0')).toBeUndefined()
  })

  it('防抖聚合落盘窗口内多次写合并; LRU 命中位刷新不丢', async () => {
    await persistVideoTags('BV-audit11-d', [{ tag_id: 1, tag_name: 'a' }])
    await persistVideoTags('BV-audit11-e', [{ tag_name: 'b' }])
    // 模块级防抖单例: 前序用例可能已占窗口 —— waitFor 轮询覆盖「旧窗先落/新窗再排」两分支
    await vi.waitFor(
      () => {
        const rows = (gmKv.get(STORAGE_KEY) ?? []) as [string, unknown][]
        expect(rows.map(([k]) => k)).toEqual(expect.arrayContaining(['BV-audit11-d', 'BV-audit11-e']))
      },
      { timeout: 3_000, interval: 50 },
    )
  })
})
