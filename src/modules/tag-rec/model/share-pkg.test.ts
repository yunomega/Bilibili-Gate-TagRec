import { describe, expect, it } from 'vitest'
import { decodeSharePkgCode, encodeSharePkgCode, extractSharePkgCode, type SharePkgEnvelope } from './share-pkg'

const env: SharePkgEnvelope = {
  v: 1,
  sid: 'abcDEF123_',
  title: '我的试改版',
  desc: '删了两组, 改了权重',
  payload: {
    version: 2,
    themes: [{ id: 't1', name: '主题A' }],
    l1: [],
    favorites: [{ id: 'g1', name: '组1', tag_ids: [{ id: 1, name: '东方project' }] }],
    blacklist: [],
    filterConfig: { placeholder: true },
  },
}

describe('$modules/tag-rec/model/share-pkg — 票 27 试改版导入码编解码', () => {
  it('往返: encodeSharePkgCode → decodeSharePkgCode 还原信封 (z 档压缩)', async () => {
    const code = await encodeSharePkgCode(env)
    expect(code).toMatch(/^z\.[\w-]+$/) // deflate 档, base64url 字符集
    expect(code).not.toContain('=') // 无 padding —— 直接嵌 URL fragment 安全
    const back = await decodeSharePkgCode(code)
    expect(back).toEqual(env)
  })

  it('往返不丢 sid/title/desc/payload; 缺省位也还原', async () => {
    const minimal: SharePkgEnvelope = { v: 1, payload: { version: 2, favorites: [] } }
    const back = await decodeSharePkgCode(await encodeSharePkgCode(minimal))
    expect(back).toEqual(minimal)
  })

  it('r 档 (未压缩兜底) 解码亦认', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(env))
    const raw =
      'r.' +
      btoa(String.fromCodePoint(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
    expect(await decodeSharePkgCode(raw)).toEqual(env)
  })

  it('畸形输入 => undefined (前缀非法/码体损毁/非 JSON/壳不合法/空串)', async () => {
    expect(await decodeSharePkgCode('')).toBeUndefined()
    expect(await decodeSharePkgCode('x.' + 'A'.repeat(40))).toBeUndefined() // 未知 mode
    expect(await decodeSharePkgCode('z.!!!')).toBeUndefined() // 非 base64url
    expect(await decodeSharePkgCode('z.' + btoa('not-deflate').replace(/=+$/, ''))).toBeUndefined() // 解压炸
    const toRaw = (json: string) => 'r.' + btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    expect(await decodeSharePkgCode(toRaw('{"hello":1}'))).toBeUndefined() // v!==1 且 payload 非对象
    expect(await decodeSharePkgCode(toRaw('{"v":1}'))).toBeUndefined() // 壳合法但 payload 缺
  })

  it('W4-5: 体量双闸 —— 编码串超 512KB 拒; 解压产物超 8MB 中途 cancel 拒', async () => {
    // 编码长闸: 合法前缀合法字符但超长 => 不进解码
    expect(await decodeSharePkgCode('r.' + 'A'.repeat(512 * 1024 + 1))).toBeUndefined()
    expect(await decodeSharePkgCode('z.' + 'A'.repeat(512 * 1024 + 1))).toBeUndefined()

    // 解压产物闸: 高膨胀合法 JSON (>8MB) => 流式读 cancel, 返 undefined 而非驻留内存
    const big = { v: 1 as const, payload: { version: 2, favorites: [], blob: 'a'.repeat(9 * 1024 * 1024) } }
    const code = await encodeSharePkgCode(big)
    expect(code.length).toBeLessThan(512 * 1024) // deflate 把 9MB 重复串压到 KB 级 —— 专挑编码闸过、产物闸炸
    expect(await decodeSharePkgCode(code)).toBeUndefined()
  })

  it('.extractSharePkgCode: 深链 hash 参 / 裸参 / 裸码三形态; 边界不误抽', () => {
    const code = 'z.' + 'A'.repeat(40)
    expect(extractSharePkgCode(`https://www.bilibili.com/?gate-tab=tag-rec-fav#tag-rec-pkg=${code}`)).toBe(code)
    expect(extractSharePkgCode(`foo#tag-rec-pkg=${code}&bar=1`)).toBe(code)
    expect(extractSharePkgCode(`tag-rec-pkg=${code}`)).toBe(code)
    expect(extractSharePkgCode(code)).toBe(code)
    expect(extractSharePkgCode('xtag-rec-pkg=' + code)).toBeUndefined() // 前缀粘连
    expect(extractSharePkgCode('z.短')).toBeUndefined() // 码体过短/字符外
    expect(extractSharePkgCode('')).toBeUndefined()
    expect(extractSharePkgCode('没有码')).toBeUndefined()
  })
})
