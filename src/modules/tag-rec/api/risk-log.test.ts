import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RISK_LOG_EVENT_RING_MAX, RISK_LOG_REQUEST_LEDGER_MAX } from './risk-log'

// settings 懒加载 (默认开): 显式 mock, 避免真 settings 模块在 node 环境求值
vi.mock('$modules/settings', () => ({ settings: { tagRec: { riskLog: { enabled: true } } } }))
// $common 在 node 环境会读 location, 隔离之
vi.mock('$common', () => ({ appWarn: vi.fn() }))

// GM 替身: 多页键合并 / clear 删除 / 落盘断言
const store = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: (k: string, def: unknown) => Promise.resolve(store.has(k) ? store.get(k) : def),
  setValue: (k: string, v: unknown) => {
    store.set(k, v)
    return Promise.resolve()
  },
  deleteValue: (k: string) => {
    store.delete(k)
    return Promise.resolve()
  },
  listValues: () => Promise.resolve([...store.keys()]),
})

const log = () => import('./risk-log')

const okRes = { status: 200, data: { code: 0, message: '0' } }
const riskRes = { status: 412, data: '<html>安全风控</html>' }

describe('票 11: 风控命中观测记录器', () => {
  beforeEach(async () => {
    const m = await log()
    m.clear()
    store.clear()
  })

  it('ok 响应只进内存请求账, 不建事件', async () => {
    const m = await log()
    m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, params: { tag_name: 'a' }, res: okRes })
    const dump = await m.dump()
    expect(dump.events.length).toBe(0)

    // 随后命中: 事件窗口里能看到前面那笔 ok
    m.recordAnonRequest({ endpoint: '/x/web-interface/tag/top', attempt: 0, res: riskRes })
    const dump2 = await m.dump()
    expect(dump2.events.length).toBe(1)
    expect(dump2.events[0].outcome).toBe('risk')
    expect(dump2.events[0].window.total).toBe(2)
    expect(dump2.events[0].window.perEndpoint['/x/tag/info']).toBe(1)
    expect(dump2.events[0].backoff).toMatchObject({ engaged: false, intervalMs: 0 })
    expect(dump2.events[0].fingerprint).toMatchObject({ has: false, disabled: false })
  })

  it('命中事件: 原始证据 (status/code/bodySnippet) + 参数白名单', async () => {
    const m = await log()
    m.recordAnonRequest({
      endpoint: '/x/tag/info?tag_name=galgame',
      attempt: 1,
      params: { tag_name: 'galgame', pn: 2, mid: 12345, cookie: 'SESSDATA=xxx' },
      res: riskRes,
    })
    const dump = await m.dump()
    const e = dump.events[0]
    expect(e.status).toBe(412)
    expect(e.bodySnippet).toBe('<html>安全风控</html>')
    expect(e.attempt).toBe(1)
    expect(e.endpoint).toBe('/x/tag/info') // query 不入端点
    expect(e.params).toEqual({ tag_name: 'galgame', pn: '2' }) // pn 在白名单; mid/cookie 被滤掉
    // 请求账 recent 行带白名单参数 —— 命中前的重复分页请求可核对页码
    expect(e.window.recent.at(-1)?.[3]).toBe(JSON.stringify({ tag_name: 'galgame', pn: '2' }))
  })

  it('可疑码 (-799/-403) 记为 suspicious; 已并入风控判定的 -352/-101 记为 risk', async () => {
    const m = await log()
    for (const code of [-799, -352, -403, -101]) {
      m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, res: { status: 200, data: { code, message: 'x' } } })
    }
    const dump = await m.dump()
    expect(dump.events.map((e) => [e.code, e.outcome])).toEqual([
      [-799, 'suspicious'],
      [-352, 'risk'],
      [-403, 'suspicious'],
      [-101, 'risk'],
    ])
  })

  it('abort 不入账; 网络错误入账不建事件', async () => {
    const m = await log()
    m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, err: new DOMException('Aborted', 'AbortError') })
    m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 1, err: new TypeError('network') })
    const dump = await m.dump()
    expect(dump.events.length).toBe(0)
  })

  it('上游最小钩子: 只认 412/code -412/可疑码; 非 JSON (text 抓取) 不误报', async () => {
    const m = await log()
    // 非 JSON 但 status 200 => 不建事件 (上游含 responseType:'text' 页面抓取)
    m.recordUpstreamResponse('logged-in', '/x/space/wbi/acc/info?mid=1', { status: 200, data: '<html>page</html>' })
    // code -799 => suspicious
    m.recordUpstreamResponse('logged-in', '/x/space/wbi/acc/info?mid=1', { status: 200, data: { code: -799 } })
    // HTTP 412 => risk
    m.recordUpstreamResponse('app', '/x/v2/feed/index', { status: 412, data: { code: -412 } })
    const dump = await m.dump()
    expect(dump.events.length).toBe(2)
    expect(dump.events[0]).toMatchObject({
      channel: 'logged-in',
      outcome: 'suspicious',
      code: -799,
      endpoint: '/x/space/wbi/acc/info',
    })
    expect(dump.events[1]).toMatchObject({ channel: 'app', outcome: 'risk', status: 412 })
  })

  it('事件环形上限 = RISK_LOG_EVENT_RING_MAX', async () => {
    const m = await log()
    for (let i = 0; i < RISK_LOG_EVENT_RING_MAX + 5; i++) {
      m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, res: riskRes })
    }
    const dump = await m.dump()
    expect(dump.events.length).toBe(RISK_LOG_EVENT_RING_MAX)
  })

  it('请求账环形上限 = RISK_LOG_REQUEST_LEDGER_MAX (窗口 total 不无界增长)', async () => {
    const m = await log()
    for (let i = 0; i < RISK_LOG_REQUEST_LEDGER_MAX + 1; i++) {
      m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, res: okRes })
    }
    m.recordAnonRequest({ endpoint: '/x/tag/top', attempt: 0, res: riskRes })
    const dump = await m.dump()
    const e = dump.events.at(-1)!
    expect(e.window.total).toBe(RISK_LOG_REQUEST_LEDGER_MAX)
  })

  it('多页键合并 (dump 按 ts 升序) + clear 只清本页', async () => {
    const m = await log()
    store.set('tag-rec:risk-events:otherpage', [
      { ts: 1, pageId: 'otherpage', channel: 'anon', endpoint: '/x/a', outcome: 'risk' },
    ])
    m.recordAnonRequest({ endpoint: '/x/tag/info', attempt: 0, res: riskRes })
    const dump = await m.dump()
    expect(dump.pageCount).toBe(2)
    expect(dump.events.length).toBe(2)
    expect(dump.events[0].ts).toBeLessThanOrEqual(dump.events[1].ts)

    const summary = await m.summary()
    expect(summary.total).toBe(2)
    expect(summary.byOutcome.risk).toBe(2)

    m.clear()
    const dump2 = await m.dump()
    expect(dump2.events.length).toBe(1) // 只剩他页
    expect(store.has('tag-rec:risk-events:otherpage')).toBe(true)
  })
})
