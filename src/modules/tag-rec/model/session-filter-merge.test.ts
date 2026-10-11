import { describe, expect, it, vi } from 'vitest'
import { cloneTagRecFilterCore, createTagRecFactoryFilterCore } from './filter-engine'
import { diffTagRecSessionFilterForGroup, summarizeSessionFilterDiff } from './session-filter-merge'

// filter-engine -> _pipeline -> endpoints/$common 触浏览器环境; 纯函数测试以 mock 隔掉 (同 filter-engine.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

describe('diffTagRecSessionFilterForGroup (会话临时过滤 => 组 override 差集)', () => {
  const base = () => createTagRecFactoryFilterCore()
  const session = () => cloneTagRecFilterCore(base())

  it('无差异 => undefined (不出并入提示)', () => {
    expect(diffTagRecSessionFilterForGroup(session(), base())).toBeUndefined()
  })

  it('阈值/时间窗差分 => dims patch (稀疏: 只写改过的键)', () => {
    const s = session()
    s.dims.minScore = { enabled: true, value: 12 }
    s.dims.pubdate = { enabled: true, win: 'd7' }
    const d = diffTagRecSessionFilterForGroup(s, base())
    expect(d?.dims).toEqual({ minScore: { enabled: true, value: 12 }, pubdate: { enabled: true, win: 'd7' } })
    expect(d?.negative).toBeUndefined()
  })

  it('屏蔽族 = 只写新增条目 (并集语义); 已在全局的条目不重复落', () => {
    const b = base()
    b.dims.titleKeywords = { enabled: true, list: ['已有词'] }
    const s = cloneTagRecFilterCore(b)
    s.dims.titleKeywords.list.push('新增词')
    s.dims.upBlacklist = { enabled: true, list: [{ name: 'X', mid: 1 }] }
    const d = diffTagRecSessionFilterForGroup(s, b)
    expect(d?.negative?.title).toEqual(['新增词'])
    expect(d?.negative?.up).toEqual([{ name: 'X', mid: 1 }])
  })

  it('屏蔽维闸关 => 不写 (不偷渡闸后条目成常效)', () => {
    const s = session()
    s.dims.titleKeywords = { enabled: false, list: ['没开闸的词'] }
    const d = diffTagRecSessionFilterForGroup(s, base())
    expect(d?.negative?.title).toBeUndefined()
  })

  it('仅看族 = 整份写入 (就近覆盖); 与全局相同/关闭 => 不写', () => {
    const s = session()
    s.dims.tagAllow = { enabled: true, list: [{ id: 7, name: '只看它' }], strict: true }
    s.dims.partitionAllow = { enabled: false, list: [{ name: '动画', v1: 1 }] } // 关闸 => 不落
    const d = diffTagRecSessionFilterForGroup(s, base())
    expect(d?.negative?.tagAllow).toEqual({ enabled: true, strict: true, list: [{ id: 7, name: '只看它' }] })
    expect(d?.negative?.partitionAllow).toBeUndefined()
  })

  it('仅看与全局相同 => 不写 (无 override 意义)', () => {
    const b = base()
    b.dims.titleAllow = { enabled: true, list: ['同词'] }
    const s = cloneTagRecFilterCore(b)
    expect(diffTagRecSessionFilterForGroup(s, b)?.negative?.titleAllow).toBeUndefined()
  })

  it('tagBlock: 新增 tag 落 negative.tagBlock, 带 strict', () => {
    const s = session()
    s.dims.tagBlock = { enabled: true, list: [{ id: 9, name: '屏蔽tag' }], strict: true }
    const d = diffTagRecSessionFilterForGroup(s, base())
    expect(d?.negative?.tagBlock).toEqual({
      enabled: true,
      strict: true,
      list: [{ id: 9, name: '屏蔽tag' }],
    })
  })

  it('score 逐字段差分 / smallPoolThreshold / poolsEnabled / pools', () => {
    const s = session()
    s.score.weights.likeRate = 0.9
    s.smallPoolThreshold = 5
    s.poolsEnabled = { tagTop: false }
    s.pools = { ...s.pools, allV2: { dims: { viewMin: { enabled: true, value: 100 } } } }
    const d = diffTagRecSessionFilterForGroup(s, base())
    expect(d?.score?.weights).toEqual({ likeRate: 0.9 })
    expect(d?.score?.anchors).toBeUndefined()
    expect(d?.smallPoolThreshold).toBe(5)
    expect(d?.poolsEnabled).toEqual({ tagTop: false })
    expect(d?.pools?.allV2?.dims).toEqual({ viewMin: { enabled: true, value: 100 } })
  })

  it('core.enabled / strictMode 不在组槽位 => 不产生差集', () => {
    const s = session()
    s.enabled = false
    s.strictMode = true
    expect(diffTagRecSessionFilterForGroup(s, base())).toBeUndefined()
  })

  it('summarizeSessionFilterDiff 摘要覆盖各桶', () => {
    const s = session()
    s.dims.titleKeywords = { enabled: true, list: ['a', 'b'] }
    s.dims.tagAllow = { enabled: true, list: [{ id: 1, name: 'x' }] }
    s.dims.minScore = { enabled: true, value: 1 }
    s.smallPoolThreshold = 9
    const d = diffTagRecSessionFilterForGroup(s, base())!
    const text = summarizeSessionFilterDiff(d)
    expect(text).toContain('屏蔽类新增 2 条')
    expect(text).toContain('仅看名单 1 条')
    expect(text).toContain('阈值/时间窗 1 项')
    expect(text).toContain('小池阈值')
  })
})
