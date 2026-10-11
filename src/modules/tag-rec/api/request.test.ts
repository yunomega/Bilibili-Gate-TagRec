import { afterEach, describe, expect, it, vi } from 'vitest'
import { gmAnonGet } from './request'

type GmXhrOpts = {
  onload?: (res: { status: number; responseText?: string; responseHeaders?: string }) => void
  onerror?: () => void
  ontimeout?: () => void
  onabort?: () => void
}

afterEach(() => vi.unstubAllGlobals())

describe('$modules/tag-rec/api/request', () => {
  it('gmAnonGet 前置 abort 判 (AUDIT-18): 已 aborted signal => 即拒 AbortError, GM_xhr 不发', async () => {
    const xhr = vi.fn()
    vi.stubGlobal('GM', { xmlHttpRequest: xhr })
    const ctrl = new AbortController()
    ctrl.abort() // abort 事件已过 => 只挂 addEventListener 的旧实现会放孤儿请求照发
    await expect(gmAnonGet('/x/tag/info', { tag_name: 'a' }, ctrl.signal)).rejects.toThrow('Aborted')
    expect(xhr).not.toHaveBeenCalled()
  })

  it('空 body 与「非空非 JSON」分流: emptyBody 标志只对零字节置位', async () => {
    let captured: GmXhrOpts = {}
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn((opts: GmXhrOpts) => {
        captured = opts
        return { abort: vi.fn() }
      }),
    })
    // 零字节 (tag/top 深页池底) => emptyBody + data=undefined
    let p = gmAnonGet('/x/web-interface/tag/top', {})
    captured.onload?.({ status: 200, responseText: '' })
    await expect(p).resolves.toEqual({ status: 200, data: undefined, emptyBody: true })
    // 纯空白同理
    p = gmAnonGet('/x/web-interface/tag/top', {})
    captured.onload?.({ status: 200, responseText: '  \n' })
    await expect(p).resolves.toEqual({ status: 200, data: undefined, emptyBody: true })
    // 非空但非 JSON (HTML 风控页) => data=undefined 且无 emptyBody —— 风控判定照常接住
    p = gmAnonGet('/x/web-interface/tag/top', {})
    captured.onload?.({ status: 200, responseText: '<html>risk</html>' })
    await expect(p).resolves.toEqual({ status: 200, data: undefined })
    expect((await p).emptyBody).toBeUndefined()
  })

  it('onload => resolve {status,data}; 在途 abort => 转发 handle.abort + AbortError', async () => {
    let captured: GmXhrOpts = {}
    const abort = vi.fn()
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn((opts: GmXhrOpts) => {
        captured = opts
        return { abort }
      }),
    })
    const p = gmAnonGet('/x/tag/info', {}, new AbortController().signal)
    captured.onload?.({ status: 200, responseText: '{"code":0}' })
    await expect(p).resolves.toEqual({ status: 200, data: { code: 0 } })

    const ctrl = new AbortController()
    const p2 = gmAnonGet('/x/tag/info', {}, ctrl.signal)
    const check = expect(p2).rejects.toThrow('Aborted')
    ctrl.abort() // 在途 abort => 转发 handle.abort
    captured.onabort?.()
    await check
    expect(abort).toHaveBeenCalledTimes(1)
  })
})

describe('GM transport lifecycle audit', () => {
  it('settles cancellation even when the manager never calls onabort', async () => {
    const abort = vi.fn()
    vi.stubGlobal('GM', { xmlHttpRequest: vi.fn(() => ({ abort })) })
    const controller = new AbortController()
    const result = gmAnonGet('/x/tag/info', {}, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(abort).toHaveBeenCalledOnce()
  })
  it('supports synchronous callbacks without accessing uninitialized cleanup variables', async () => {
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn((options: GmXhrOpts) => {
        options.onload?.({ status: 200, responseText: '{"code":0}' })
        return { abort: vi.fn() }
      }),
    })
    expect(await gmAnonGet('/x/tag/info', {})).toEqual({ status: 200, data: { code: 0 } })
  })
  it('preserves Retry-After headers for the shared rate limiter', async () => {
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn((options: GmXhrOpts) => {
        options.onload?.({ status: 429, responseText: '{}', responseHeaders: 'Retry-After: 120' })
        return { abort: vi.fn() }
      }),
    })
    expect(await gmAnonGet('/x/tag/info', {})).toMatchObject({ status: 429, responseHeaders: 'Retry-After: 120' })
  })
  it('cancels a handle returned after synchronous cancellation during construction', async () => {
    const controller = new AbortController()
    const abort = vi.fn()
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn(() => {
        controller.abort()
        return { abort }
      }),
    })
    await expect(gmAnonGet('/x/tag/info', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(abort).toHaveBeenCalledOnce()
  })
  it('detaches listeners when request construction throws', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn(() => {
        throw new Error('manager unavailable')
      }),
    })
    await expect(gmAnonGet('/x/tag/info', {}, controller.signal)).rejects.toThrow('manager unavailable')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it.each(['onerror', 'ontimeout'] as const)('settles %s and removes its abort listener', async (callback) => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    vi.stubGlobal('GM', {
      xmlHttpRequest: vi.fn((options: GmXhrOpts) => {
        options[callback]?.()
        return { abort: vi.fn() }
      }),
    })
    await expect(gmAnonGet('/x/tag/info', {}, controller.signal)).rejects.toBeInstanceOf(TypeError)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
