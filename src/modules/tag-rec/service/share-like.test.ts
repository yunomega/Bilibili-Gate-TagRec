import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecItemTypeOrSeparator } from '$define'

// share-like -> api/share -> login-info/$request 浏览器环境; model/share -> filter-engine -> _pipeline -> endpoints;
// store/session -> api/backoff (axios/promise.map 真依赖, 模块级无浏览器调用) —— 同 share-tokens.test.ts 手法
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$modules/bilibili/user/login-info', () => ({ fetchLoginInfo: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))

const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, dflt?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : dflt)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
  deleteValue: vi.fn((key: string) => Promise.resolve(void gmKv.delete(key))),
  xmlHttpRequest: vi.fn(),
})

const toast = (await import('$utility/toast')).default
const { fetchLoginInfo } = await import('$modules/bilibili/user/login-info')
const { EApiType } = await import('$enums')
const { tagRecSharedSession } = await import('../store/session')
const { readPendingShareLike, readShareLikeActed } = await import('../store/share-tokens')
const { actShareLike, dismissShareLike, noteShareLikeDelivered, reevaluateShareLike, resetTagRecShareLikeState } =
  await import('./share-like')

const PENDING_KEY = 'tag-rec:share-pending-like'
const ACTED_KEY = 'tag-rec:share-like-acted'

const item = (): RecItemTypeOrSeparator => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${Math.random()}`,
  bvid: 'BV1',
  title: 't',
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['G'] },
})
const sep = (): RecItemTypeOrSeparator => ({ api: EApiType.Separator, uniqId: `sep:${Math.random()}`, content: null })
const items = (n: number) => Array.from({ length: n }, item)
const flush = () => new Promise((r) => setTimeout(r, 0))

const loginOk = (mid = 42) =>
  vi.mocked(fetchLoginInfo).mockResolvedValue({
    isOk: () => true,
    value: { isLogin: true, mid, uname: 'tester' },
  } as never)
const xhrOnce = (status: number, body: unknown) =>
  vi.mocked(GM.xmlHttpRequest).mockImplementationOnce((opts) => {
    const res = {
      status,
      responseText: typeof body === 'string' ? body : JSON.stringify(body),
    } as unknown as Parameters<NonNullable<typeof opts.onload>>[0]
    opts.onload?.(res)
    return undefined as never
  })

describe('$modules/tag-rec/service/share-like — 票 19 回赞闭环编排 (spec §6)', () => {
  beforeEach(() => {
    gmKv.clear()
    resetTagRecShareLikeState()
    tagRecSharedSession.shareLike = undefined
    vi.clearAllMocks()
  })

  it('上屏累计 ≥20 + pending 在 + 未赞未拒 => 武装 shareLike, pending 保留 (R7: 显示后才消费)', async () => {
    gmKv.set(PENDING_KEY, 's1')
    noteShareLikeDelivered(items(19))
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined() // 19 未达标
    noteShareLikeDelivered(items(1)) // 跨切片累计到 20
    await flush()
    expect(tagRecSharedSession.shareLike).toEqual({ shareId: 's1', busy: false })
    expect(await readPendingShareLike()).toBe('s1') // R7: 武装不清账 —— 会话丢失后仍可重武装
    // 已武装 => 后续上屏不再读账重武装 (单次在显)
    expect(tagRecSharedSession.shareLike?.shareId).toBe('s1')
    // 模拟「会话丢失」(reload) => pending 仍在 => 重评估可再武装 (修旧「提前清账永久丢提示」)
    tagRecSharedSession.shareLike = undefined
    reevaluateShareLike()
    await flush()
    expect(tagRecSharedSession.shareLike).toEqual({ shareId: 's1', busy: false })
  })

  it('分隔符不算「条」; pending 缺席 => 不武装', async () => {
    gmKv.set(PENDING_KEY, 's1')
    noteShareLikeDelivered([...items(19), sep()]) // 19 条 + 分隔符仍 19
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
    gmKv.clear()
    resetTagRecShareLikeState()
    noteShareLikeDelivered(items(30)) // pending 缺席 => 条数再够也不武装
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
  })

  it('已赞/已拒集命中 => 不武装 + 清 pending (记忆集永挡)', async () => {
    gmKv.set(PENDING_KEY, 's1')
    gmKv.set(ACTED_KEY, { liked: ['s1'], dismissed: [] })
    noteShareLikeDelivered(items(25))
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
    expect(await readPendingShareLike()).toBeUndefined()
    // 已拒同理
    gmKv.set(PENDING_KEY, 's2')
    gmKv.set(ACTED_KEY, { liked: [], dismissed: ['s2'] })
    noteShareLikeDelivered(items(20))
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
    expect(await readPendingShareLike()).toBeUndefined()
  })

  it('reevaluateShareLike: 先满 20 再挂 pending => 补评估即武装 (不等下次上屏)', async () => {
    noteShareLikeDelivered(items(20))
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined() // pending 尚未挂
    gmKv.set(PENDING_KEY, 's1')
    reevaluateShareLike() // noteShareImportDone 同款补刀
    await flush()
    expect(tagRecSharedSession.shareLike).toEqual({ shareId: 's1', busy: false })
  })

  it('[赞一个] ok => 入已赞集 + 横幅消 + toast; already:true 同款成功档; R7: act 消费 pending', async () => {
    gmKv.set(PENDING_KEY, 's1')
    tagRecSharedSession.shareLike = { shareId: 's1', busy: false }
    loginOk()
    xhrOnce(200, { likes_count: 5, liked: true, already: false })
    await actShareLike()
    await flush()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
    expect(await readShareLikeActed()).toEqual({ liked: ['s1'], dismissed: [] })
    expect(await readPendingShareLike()).toBeUndefined() // R7: act 才消费 pending
    expect(vi.mocked(toast)).toHaveBeenCalled()
    // already => 同样入已赞集
    tagRecSharedSession.shareLike = { shareId: 's2', busy: false }
    xhrOnce(200, { likes_count: 6, liked: true, already: true })
    await actShareLike()
    await flush()
    expect(await readShareLikeActed()).toEqual({ liked: ['s1', 's2'], dismissed: [] })
  })

  it('[赞一个] 403(pending/removed)/404/429/网络错 => 安静收下入已拒集', async () => {
    for (const [status, body, sid] of [
      [403, { error: 'like_rejected', status: 'removed' }, 's1'],
      [404, { error: 'not_found' }, 's2'],
      [429, { error: 'rate_limited' }, 's3'],
    ] as const) {
      tagRecSharedSession.shareLike = { shareId: sid, busy: false }
      loginOk()
      xhrOnce(status, body)
      await actShareLike()
      await flush()
      expect(tagRecSharedSession.shareLike).toBeUndefined()
    }
    expect((await readShareLikeActed()).dismissed).toEqual(['s1', 's2', 's3'])
  })

  it('[赞一个] 未登录 => toast 引导 + 横幅留 (不写记忆集, 不发 xhr)', async () => {
    tagRecSharedSession.shareLike = { shareId: 's1', busy: false }
    vi.mocked(fetchLoginInfo).mockResolvedValue({
      isOk: () => true,
      value: { isLogin: false },
    } as never)
    await actShareLike()
    expect(tagRecSharedSession.shareLike).toEqual({ shareId: 's1', busy: false })
    expect(vi.mocked(toast)).toHaveBeenCalled()
    expect(vi.mocked(GM.xmlHttpRequest)).not.toHaveBeenCalled()
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: [] })
  })

  it('[不了] => 入已拒集 + 横幅消; busy 在飞 => act 拒重入', async () => {
    tagRecSharedSession.shareLike = { shareId: 's1', busy: false }
    dismissShareLike()
    expect(tagRecSharedSession.shareLike).toBeUndefined()
    await flush()
    expect(await readShareLikeActed()).toEqual({ liked: [], dismissed: ['s1'] })
    // busy 防重点: 在飞时第二次 act 直接 return
    tagRecSharedSession.shareLike = { shareId: 's2', busy: true }
    await actShareLike()
    expect(vi.mocked(GM.xmlHttpRequest)).not.toHaveBeenCalled()
  })
})
