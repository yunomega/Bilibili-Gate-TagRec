import { describe, expect, it, vi } from 'vitest'

// share.ts -> $modules/bilibili/user/login-info -> $request 浏览器环境; ../model/share -> filter-engine -> _pipeline -> endpoints
// —— 同 share-tokens.test.ts/model/share.test.ts 隔离手法
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$modules/bilibili/user/login-info', () => ({ fetchLoginInfo: vi.fn() }))

const { fetchLoginInfo } = await import('$modules/bilibili/user/login-info')
const { fetchShareUploader, normalizeDupCheckOutcome, normalizeShareLikeOutcome } = await import('./share')

// Result.isOk 现为类型谓词 (this is Ok<...>) —— mock 字面量直给 () => true 不满足谓词签名, 断言式 mock 走双层 cast
const okRes = (value: unknown): Awaited<ReturnType<typeof fetchLoginInfo>> =>
  ({ isOk: () => true, value }) as unknown as Awaited<ReturnType<typeof fetchLoginInfo>>

describe('fetchShareUploader — 票34: nav 登录态取 mid+uname+face,服务端零 B 站调用', () => {
  it('登录态全字段: face 顺字段落 avatar (http 原样上送,服务端归一 https+白名单)', async () => {
    vi.mocked(fetchLoginInfo).mockResolvedValue(
      okRes({ isLogin: true, mid: 42, uname: '上传者', face: 'http://i2.hdslb.com/bfs/face/x.jpg' }),
    )
    const u = await fetchShareUploader()
    expect(u).toEqual({
      kind: 'user',
      user: { mid: 42, nickname: '上传者', avatar: 'http://i2.hdslb.com/bfs/face/x.jpg' },
    })
  })

  it('face 缺/空 => 不带 avatar;uname 缺 => UID 回落', async () => {
    vi.mocked(fetchLoginInfo).mockResolvedValue(okRes({ isLogin: true, mid: 7, uname: '', face: '' }))
    expect(await fetchShareUploader()).toEqual({ kind: 'user', user: { mid: 7, nickname: 'UID:7' } })
  })

  // [tag-rec] UIUX-U1-8: 三态分流 —— 未登录与拉取失败不再同压成 undefined (分享 Modal 失败态出「重试」)
  it('未登录 => not-logged-in; Err/reject/畸形响应 => error', async () => {
    vi.mocked(fetchLoginInfo).mockResolvedValue(okRes({ isLogin: false }))
    expect(await fetchShareUploader()).toEqual({ kind: 'not-logged-in' })

    vi.mocked(fetchLoginInfo).mockResolvedValue({ isOk: () => false } as unknown as Awaited<
      ReturnType<typeof fetchLoginInfo>
    >)
    expect(await fetchShareUploader()).toEqual({ kind: 'error' })

    vi.mocked(fetchLoginInfo).mockRejectedValue(new Error('network down'))
    expect(await fetchShareUploader()).toEqual({ kind: 'error' })

    vi.mocked(fetchLoginInfo).mockResolvedValue(okRes({ isLogin: true, mid: 'x' }))
    expect(await fetchShareUploader()).toEqual({ kind: 'error' })
  })
})

describe('$modules/tag-rec/api/share — 票 19 POST /shares/:id/like 响应归一', () => {
  it('200 {likes_count, liked:true, already:false|true} => ok; already=true 幂等命中不翻转失败', () => {
    expect(normalizeShareLikeOutcome(200, { likes_count: 7, liked: true, already: false })).toEqual({
      kind: 'ok',
      likesCount: 7,
      already: false,
    })
    expect(normalizeShareLikeOutcome(200, { likes_count: 7, liked: true, already: true })).toEqual({
      kind: 'ok',
      likesCount: 7,
      already: true,
    })
  })

  it('2xx 宽容档: 字段缺省/非对象体不翻转失败 (liked 语义以状态码为准)', () => {
    expect(normalizeShareLikeOutcome(200, undefined)).toEqual({ kind: 'ok', likesCount: 0, already: false })
    expect(normalizeShareLikeOutcome(200, 'oops')).toEqual({ kind: 'ok', likesCount: 0, already: false })
    expect(normalizeShareLikeOutcome(200, { likes_count: 'x', already: 1 })).toEqual({
      kind: 'ok',
      likesCount: 0,
      already: false,
    })
    expect(normalizeShareLikeOutcome(201, { likes_count: 3 })).toEqual({ kind: 'ok', likesCount: 3, already: false })
  })

  it('403 like_rejected => rejected, status 原样透传 (pending|removed); 缺省 => ""', () => {
    expect(normalizeShareLikeOutcome(403, { error: 'like_rejected', status: 'pending' })).toEqual({
      kind: 'rejected',
      status: 'pending',
    })
    expect(normalizeShareLikeOutcome(403, { error: 'like_rejected', status: 'removed' })).toEqual({
      kind: 'rejected',
      status: 'removed',
    })
    expect(normalizeShareLikeOutcome(403, { error: 'like_rejected' })).toEqual({ kind: 'rejected', status: '' })
    expect(normalizeShareLikeOutcome(403, undefined)).toEqual({ kind: 'rejected', status: '' })
  })

  it('404 => not-found; 429 => rate-limited', () => {
    expect(normalizeShareLikeOutcome(404, { error: 'not_found' })).toEqual({ kind: 'not-found' })
    expect(normalizeShareLikeOutcome(404, undefined)).toEqual({ kind: 'not-found' })
    expect(normalizeShareLikeOutcome(429, { error: 'rate_limited' })).toEqual({ kind: 'rate-limited' })
  })

  it('400 坏 mid / 其余状态码 => failed (reason|error 透传, 双缺 => HTTP 码兜底)', () => {
    expect(normalizeShareLikeOutcome(400, { error: 'bad_mid', reason: 'mid 须为安全正整数' })).toEqual({
      kind: 'failed',
      message: 'mid 须为安全正整数',
    })
    expect(normalizeShareLikeOutcome(400, { error: 'bad_mid' })).toEqual({ kind: 'failed', message: 'bad_mid' })
    expect(normalizeShareLikeOutcome(500, undefined)).toEqual({ kind: 'failed', message: 'HTTP 500' })
    expect(normalizeShareLikeOutcome(418, 'teapot')).toEqual({ kind: 'failed', message: 'HTTP 418' })
  })
})

describe('票 31 POST /shares/dup-check 响应归一 —— 失败一律 failed (调用侧静默放行, 不挡上传)', () => {
  it('200 {dups:[...]} => ok; 字段归一: updated_at→updatedAt / title_match→titleMatch / similarity 缺省 0', () => {
    expect(
      normalizeDupCheckOutcome(200, {
        dups: [
          { id: 'abc123defg', title: '我的标签组', updated_at: 1_700_000_000_000, similarity: 0.82 },
          { id: 'xyz987uvwx', title: '同名分享', similarity: 1, title_match: true },
        ],
      }),
    ).toEqual({
      kind: 'ok',
      dups: [
        { id: 'abc123defg', title: '我的标签组', updatedAt: 1_700_000_000_000, similarity: 0.82 },
        { id: 'xyz987uvwx', title: '同名分享', similarity: 1, titleMatch: true },
      ],
    })
  })

  it('200 无命中 / dups 缺省非数组 => ok 空集 (调用侧以 dups.length 判)', () => {
    expect(normalizeDupCheckOutcome(200, { dups: [] })).toEqual({ kind: 'ok', dups: [] })
    expect(normalizeDupCheckOutcome(200, {})).toEqual({ kind: 'ok', dups: [] })
    expect(normalizeDupCheckOutcome(200, { dups: 'oops' })).toEqual({ kind: 'ok', dups: [] })
  })

  it('畸形条目剔除 (id/title 非字符串即剔), 其余字段缺省宽容; 至多 5 条截断', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, title: `t${i}`, similarity: 0.5 }))
    const res = normalizeDupCheckOutcome(200, {
      dups: [
        { id: 'a', title: 'ok', similarity: 0.9 },
        { title: '缺 id' },
        { id: 1, title: 'id 非字符串' },
        { id: 'b' }, // 缺 title 剔除
        'junk',
        null,
        ...many,
      ],
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.dups.length).toBe(5) // 'a' + many 前 4 条 = 契约至多 5
    expect(res.dups[0]).toEqual({ id: 'a', title: 'ok', similarity: 0.9 })
    expect(res.dups[1].id).toBe('id0')
  })

  it('非 2xx 一律 failed —— 不区分错误形态 (软提醒静默兜底)', () => {
    expect(normalizeDupCheckOutcome(400, { error: 'bad_request' })).toEqual({ kind: 'failed' })
    expect(normalizeDupCheckOutcome(404, undefined)).toEqual({ kind: 'failed' }) // 端点未上线同形
    expect(normalizeDupCheckOutcome(500, { reason: 'boom' })).toEqual({ kind: 'failed' })
    expect(normalizeDupCheckOutcome(0, undefined)).toEqual({ kind: 'failed' })
  })
})
