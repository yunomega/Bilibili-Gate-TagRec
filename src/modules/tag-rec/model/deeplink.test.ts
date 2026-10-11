import { describe, expect, it } from 'vitest'
import {
  buildShareImportDeepLink,
  buildTagRecCustomDeepLink,
  parseTagRecDeepLink,
  parseTagRecPkgHash,
  parseTagRecShareDeepLink,
} from './deeplink'

describe('$modules/tag-rec/model/deeplink (票 24 深链二级参数)', () => {
  it('.buildTagRecCustomDeepLink: input/group 挂到 `?gate-tab=tag-rec-custom` 一级深链', () => {
    expect(buildTagRecCustomDeepLink('https://www.bilibili.com', { input: 12345 })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-custom&tag-rec-input=12345',
    )
    expect(buildTagRecCustomDeepLink('https://www.bilibili.com', { group: 'g-1' })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-custom&tag-rec-group=g-1',
    )
    // 空值不挂参 (防御: 调用侧传空字符串/空 id 不出脏参)
    expect(buildTagRecCustomDeepLink('https://www.bilibili.com', { input: ' ' })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-custom',
    )
  })

  const CLEAR = ['tag-rec-group', 'tag-rec-input', 'tag-rec-new', 'tag-rec-id']

  it('.parseTagRecDeepLink: input 参 => 直输目标; 无二级参 => 无目标无清参', () => {
    expect(parseTagRecDeepLink('?gate-tab=tag-rec-custom&tag-rec-input=12345')).toEqual({
      target: { kind: 'input', input: '12345' },
      paramsToClear: CLEAR,
    })
    expect(parseTagRecDeepLink('?gate-tab=tag-rec-custom')).toEqual({ target: undefined, paramsToClear: [] })
    expect(parseTagRecDeepLink('')).toEqual({ target: undefined, paramsToClear: [] })
  })

  it('.parseTagRecDeepLink: group 优先于 input (两参同现); 空值视同无参但仍清参', () => {
    expect(parseTagRecDeepLink('?tag-rec-input=9&tag-rec-group=g-2')).toEqual({
      target: { kind: 'group', groupId: 'g-2' },
      paramsToClear: CLEAR,
    })
    // group 空值 => 落到 input; 两参都空 => 无目标但参数仍在 => 照常清
    expect(parseTagRecDeepLink('?tag-rec-group=&tag-rec-input=7').target).toEqual({ kind: 'input', input: '7' })
    expect(parseTagRecDeepLink('?tag-rec-group=')).toEqual({
      target: undefined,
      paramsToClear: CLEAR,
    })
  })

  it('.parseTagRecDeepLink: new+id => 新组合种子目标; 缺/坏 id => 回落 input 语义', () => {
    expect(parseTagRecDeepLink('?tag-rec-new=%E5%8E%9F%E7%A5%9E&tag-rec-id=9975923')).toEqual({
      target: { kind: 'new', id: 9975923, name: '原神' },
      paramsToClear: CLEAR,
    })
    expect(parseTagRecDeepLink('?tag-rec-new=foo&tag-rec-id=abc').target).toEqual({ kind: 'input', input: 'foo' })
    expect(parseTagRecDeepLink('?tag-rec-new=foo').target).toEqual({ kind: 'input', input: 'foo' })
    // new 优先于 input; group 仍最优先
    expect(parseTagRecDeepLink('?tag-rec-input=bar&tag-rec-new=foo&tag-rec-id=7').target).toEqual({
      kind: 'new',
      id: 7,
      name: 'foo',
    })
    expect(parseTagRecDeepLink('?tag-rec-group=g1&tag-rec-new=foo&tag-rec-id=7').target).toEqual({
      kind: 'group',
      groupId: 'g1',
    })
    expect(buildTagRecCustomDeepLink('https://www.bilibili.com', { seed: { id: 9975923, name: '原神' } })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-custom&tag-rec-new=%E5%8E%9F%E7%A5%9E&tag-rec-id=9975923',
    )
  })
})

describe('$modules/tag-rec/model/deeplink — 票 18 分享导入深链 (tab1 语境)', () => {
  const O = 'https://www.bilibili.com'
  const CLEAR = ['tag-rec-share', 'tag-rec-groups']

  it('.buildShareImportDeepLink: gate-tab=tag-rec-fav + share (+可选 groups csv)', () => {
    expect(buildShareImportDeepLink(O, { shareId: 'abcDEF123_' })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=abcDEF123_',
    )
    expect(buildShareImportDeepLink(O, { shareId: 'abcDEF123_', groups: ['g1', 'g2'] })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=abcDEF123_&tag-rec-groups=g1%2Cg2',
    )
    // groups 缺席/空集 => 不挂参 (整包语义); shareId 空白 => 不挂参 (防御)
    expect(buildShareImportDeepLink(O, { shareId: 'abcDEF123_', groups: [] })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=abcDEF123_',
    )
    expect(buildShareImportDeepLink(O, { shareId: ' ' })).toBe('https://www.bilibili.com/?gate-tab=tag-rec-fav')
    // groups 归一: 空白 trim / 重复去重保序 / 空 token 丢
    expect(buildShareImportDeepLink(O, { shareId: 's', groups: [' g1 ', 'g1', '', 'g2'] })).toBe(
      'https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=s&tag-rec-groups=g1%2Cg2',
    )
  })

  it('.parseTagRecShareDeepLink: share 独现 => 整包 (groupIds 无); share+groups => 子集数组', () => {
    expect(parseTagRecShareDeepLink('?gate-tab=tag-rec-fav&tag-rec-share=abcDEF123_')).toEqual({
      shareId: 'abcDEF123_',
      groupIds: undefined,
      paramsToClear: CLEAR,
    })
    expect(parseTagRecShareDeepLink('?tag-rec-share=ab-CD_ef12&tag-rec-groups=g1,g2')).toEqual({
      shareId: 'ab-CD_ef12',
      groupIds: ['g1', 'g2'],
      paramsToClear: CLEAR,
    })
    // shareId 空白 trim
    expect(parseTagRecShareDeepLink('?tag-rec-share=%20ab-CD_ef12%20').shareId).toBe('ab-CD_ef12')
  })

  it('.parseTagRecShareDeepLink: groups 归一 —— 空白/空 token 丢, 重复去重保序; 空值 => undefined 但仍清参', () => {
    expect(parseTagRecShareDeepLink('?tag-rec-share=ab-CD_ef12&tag-rec-groups=%20g1%20,,g1,g2,').groupIds).toEqual([
      'g1',
      'g2',
    ])
    expect(parseTagRecShareDeepLink('?tag-rec-share=ab-CD_ef12&tag-rec-groups=')).toEqual({
      shareId: 'ab-CD_ef12',
      groupIds: undefined,
      paramsToClear: CLEAR,
    })
  })

  it('.parseTagRecShareDeepLink (W6-10): shareId 非 nanoid(10) 形态 => 视同缺席 (清参但不触发导入)', () => {
    for (const bad of ['s', 'abcDEF123', 'abcDEF12345', 'abcDEF123_!', 'abcDEF123_ extra']) {
      expect(parseTagRecShareDeepLink(`?tag-rec-share=${encodeURIComponent(bad)}`)).toEqual({
        shareId: undefined,
        groupIds: undefined,
        paramsToClear: CLEAR,
      })
    }
    // 非法 shareId 时孤 groups 照常解出 (无导入触发)
    expect(parseTagRecShareDeepLink('?tag-rec-share=x&tag-rec-groups=g1')).toEqual({
      shareId: undefined,
      groupIds: ['g1'],
      paramsToClear: CLEAR,
    })
  })

  it('.parseTagRecShareDeepLink: 无参 => 无载荷无清参; 空 shareId / 孤 groups 参 => 清参但无 shareId', () => {
    expect(parseTagRecShareDeepLink('?gate-tab=tag-rec-fav')).toEqual({
      shareId: undefined,
      groupIds: undefined,
      paramsToClear: [],
    })
    expect(parseTagRecShareDeepLink('')).toEqual({ shareId: undefined, groupIds: undefined, paramsToClear: [] })
    // 孤 groups 参: ids 照常解出且清参, 但 shareId 缺席 (调用侧不触发导入)
    expect(parseTagRecShareDeepLink('?tag-rec-groups=g1')).toEqual({
      shareId: undefined,
      groupIds: ['g1'],
      paramsToClear: CLEAR,
    })
    expect(parseTagRecShareDeepLink('?tag-rec-share=')).toEqual({
      shareId: undefined,
      groupIds: undefined,
      paramsToClear: CLEAR,
    })
  })

  it('两族二级参数独立: share/groups 不进 tab2 解析视野; input/group 不进 share 解析', () => {
    expect(parseTagRecShareDeepLink('?tag-rec-input=7&tag-rec-group=g1')).toEqual({
      shareId: undefined,
      groupIds: undefined,
      paramsToClear: [],
    })
    expect(parseTagRecDeepLink('?tag-rec-share=s&tag-rec-groups=g1')).toEqual({
      target: undefined,
      paramsToClear: [],
    })
  })
})

describe('$modules/tag-rec/model/deeplink — 票 27 试改版 hash 参 (tag-rec-pkg)', () => {
  const code = 'z.' + 'A'.repeat(40)

  it('.parseTagRecPkgHash: `#tag-rec-pkg=<code>` / hash 内多参 / `&` 前导', () => {
    expect(parseTagRecPkgHash(`#tag-rec-pkg=${code}`)).toEqual({ code, hasPkg: true })
    expect(parseTagRecPkgHash(`?x=1#tag-rec-pkg=${code}&y=2`)).toEqual({ code, hasPkg: true })
    expect(parseTagRecPkgHash(`#a=1&tag-rec-pkg=${code}`)).toEqual({ code, hasPkg: true })
  })

  it('.parseTagRecPkgHash: 百分号编码还原; 空值/缺席/纯文本 => 相应降级', () => {
    expect(parseTagRecPkgHash('#tag-rec-pkg=z.AAA%2D')).toEqual({ code: 'z.AAA-', hasPkg: true })
    expect(parseTagRecPkgHash('#tag-rec-pkg=')).toEqual({ code: undefined, hasPkg: true }) // 空值仍标 hasPkg (清 hash)
    expect(parseTagRecPkgHash('')).toEqual({ code: undefined, hasPkg: false })
    expect(parseTagRecPkgHash('#other=1')).toEqual({ code: undefined, hasPkg: false })
    expect(parseTagRecPkgHash('?tag-rec-pkg=' + code)).toEqual({ code: undefined, hasPkg: false }) // query 形态不认 (仅 fragment)
  })

  it('.parseTagRecPkgHash: query 参互不串扰 —— share 解析不采 hash, pkg 解析不采 search', () => {
    expect(parseTagRecShareDeepLink(`?tag-rec-share=ab-CD_ef12`)).toMatchObject({ shareId: 'ab-CD_ef12' })
    expect(parseTagRecPkgHash('?tag-rec-share=s')).toEqual({ code: undefined, hasPkg: false })
  })
})
