import { beforeEach, describe, expect, it, vi } from 'vitest'

// share-tokens -> $common (appWarn) + ../model/share -> import-export -> filter-engine -> _pipeline -> endpoints
// —— 同 import-export.test.ts 隔浏览器环境手法
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, dflt?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : dflt)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
  deleteValue: vi.fn((key: string) => Promise.resolve(void gmKv.delete(key))), // [tag-rec] 票 19
  listValues: vi.fn(() => Promise.resolve([...gmKv.keys()])),
})

const { appWarn } = await import('$common')
const {
  clearPendingShareLike, // [tag-rec] 票 19
  forgetShareToken,
  markShareLikeDismissed, // [tag-rec] 票 19
  markShareLiked, // [tag-rec] 票 19
  readPendingShareLike, // [tag-rec] 票 19
  readShareLikeActed, // [tag-rec] 票 19
  readShareTokens,
  rememberPendingShareLike, // [tag-rec] 票 19
  rememberShareToken,
} = await import('./share-tokens')

const KEY = 'tag-rec:share-tokens'

describe('$modules/tag-rec/store/share-tokens — GM 记账 (票 16 tag-share)', () => {
  beforeEach(() => {
    gmKv.clear()
    vi.mocked(appWarn).mockClear()
  })

  it('remember => read 往返: shareId → {token,title,createdAt} 落到 tag-rec:share-tokens', async () => {
    await rememberShareToken('s1', { token: 'tok-1', title: '分享A', createdAt: 100 })
    expect(gmKv.get('tag-rec:share-token:s1')).toEqual({ token: 'tok-1', title: '分享A', createdAt: 100 })
    await rememberShareToken('s2', { token: 'tok-2', title: '分享B', createdAt: 200 })
    const map = await readShareTokens()
    expect(Object.keys(map).sort()).toEqual(['s1', 's2'])
    expect(map.s2).toEqual({ token: 'tok-2', title: '分享B', createdAt: 200 })
    // 同 id 覆写 (重传同分享场景)
    await rememberShareToken('s1', { token: 'tok-1b', title: '分享A改', createdAt: 300 })
    expect((await readShareTokens()).s1).toEqual({ token: 'tok-1b', title: '分享A改', createdAt: 300 })
  })

  it('forget 摘账; 空读 => {}', async () => {
    expect(await readShareTokens()).toEqual({})
    await rememberShareToken('s1', { token: 't', title: 'A', createdAt: 1 })
    await forgetShareToken('s1')
    expect(await readShareTokens()).toEqual({})
    await forgetShareToken('ghost') // 无键 no-op 不炸
  })

  it('GM 存值畸形 (非对象) => 读回落 {}; GM 读失败 => fail-open {} + warn', async () => {
    gmKv.set(KEY, ['not', 'a', 'map'])
    expect(await readShareTokens()).toEqual({})
    gmKv.set(KEY, 42)
    expect(await readShareTokens()).toEqual({})

    // 读失败: getValue 抛 => {} + appWarn; 写路径同样吞错不炸
    gmKv.clear()
    vi.mocked(GM.getValue).mockRejectedValueOnce(new Error('gm-down'))
    expect(await readShareTokens()).toEqual({})
    expect(vi.mocked(appWarn)).toHaveBeenCalled()
    vi.mocked(GM.setValue).mockRejectedValueOnce(new Error('gm-down'))
    await rememberShareToken('s1', { token: 't', title: 'A', createdAt: 1 }) // 静默失败
    expect(gmKv.has('tag-rec:share-token:s1')).toBe(false)
  })
})

describe('share token independent-record regression', () => {
  beforeEach(() => gmKv.clear())

  it('simultaneous uploads preserve both credentials without a shared ledger write', async () => {
    await Promise.all([
      rememberShareToken('a', { token: 'ta', title: 'A', createdAt: 1 }),
      rememberShareToken('b', { token: 'tb', title: 'B', createdAt: 2 }),
    ])
    expect(Object.keys(await readShareTokens()).sort()).toEqual(['a', 'b'])
  })

  it('legacy credentials stay readable and deletion cannot resurrect an old record', async () => {
    gmKv.set(KEY, { old: { token: 'to', title: 'Old', createdAt: 1 } })
    await rememberShareToken('new', { token: 'tn', title: 'New', createdAt: 2 })
    expect(Object.keys(await readShareTokens()).sort()).toEqual(['new', 'old'])
    await Promise.all([
      forgetShareToken('old'),
      rememberShareToken('another', { token: 'tx', title: 'X', createdAt: 3 }),
    ])
    expect(Object.keys(await readShareTokens()).sort()).toEqual(['another', 'new'])
    expect(gmKv.get(KEY)).toHaveProperty('old') // 兼容数据未被整表改写
  })
})

// [tag-rec] 票 19: 回赞闭环 GM 键 (pending-like 挂账 + like-acted 已赞/已拒记忆集)
describe('$modules/tag-rec/store/share-tokens — 票 19 回赞 pending + 已赞/已拒集', () => {
  const PENDING_KEY = 'tag-rec:share-pending-like'
  const ACTED_KEY = 'tag-rec:share-like-acted'

  beforeEach(() => {
    gmKv.clear()
    vi.mocked(appWarn).mockClear()
  })

  it('pending: remember => read => clear 往返; 未写 => undefined; 后写顶替 (末次导入赢)', async () => {
    expect(await readPendingShareLike()).toBeUndefined()
    await rememberPendingShareLike('s1')
    expect(await readPendingShareLike()).toBe('s1')
    expect(gmKv.get(PENDING_KEY)).toBe('s1')
    await clearPendingShareLike()
    expect(await readPendingShareLike()).toBeUndefined()
    // 畸形存值 => undefined (同「无账」)
    gmKv.set(PENDING_KEY, 42)
    expect(await readPendingShareLike()).toBeUndefined()
    // 覆写语义: 新导入挂账顶替旧账
    await rememberPendingShareLike('s1')
    await rememberPendingShareLike('s2')
    expect(await readPendingShareLike()).toBe('s2')
  })

  it('acted: mark liked/dismissed 读写; 两集互斥后动作者赢; 畸形 GM => 空集归一', async () => {
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: [] })
    await markShareLiked('s1')
    await markShareLikeDismissed('s2')
    expect(await readShareLikeActed()).toEqual({ liked: ['s1'], dismissed: ['s2'] })
    expect(gmKv.get(ACTED_KEY)).toEqual({ liked: ['s1'], dismissed: ['s2'] })
    // 后动作者赢: s1 转拒 => 两集搬迁
    await markShareLikeDismissed('s1')
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: ['s2', 's1'] })
    // 同 id 幂等不双份
    await markShareLiked('s1')
    await markShareLiked('s1')
    expect(await readShareLikeActed()).toEqual({ liked: ['s1'], dismissed: ['s2'] })
    // 畸形存值 => 归一空集 (字符串/字段非数组)
    gmKv.set(ACTED_KEY, 'garbage')
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: [] })
    gmKv.set(ACTED_KEY, { liked: 'nope', dismissed: [1, 'x'] })
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: ['x'] })
  })

  it('acted GM 读失败 => 空集 + warn (fail-open); 写路径读败拒写/setValue 抛静默', async () => {
    vi.mocked(GM.getValue).mockRejectedValueOnce(new Error('gm-down'))
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: [] })
    expect(vi.mocked(appWarn)).toHaveBeenCalled()
    // 写路径读败 => 拒写 (防空图覆写, 同账本口径)
    vi.mocked(GM.getValue).mockRejectedValueOnce(new Error('gm-down'))
    await markShareLiked('s1')
    expect(gmKv.has(ACTED_KEY)).toBe(false)
    // setValue 抛 => 静默不炸
    vi.mocked(GM.getValue).mockResolvedValueOnce({ liked: [], dismissed: [] })
    vi.mocked(GM.setValue).mockRejectedValueOnce(new Error('gm-down'))
    await markShareLiked('s1')
  })
})
