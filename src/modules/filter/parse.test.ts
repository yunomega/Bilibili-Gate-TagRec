import { proxy, snapshot } from 'valtio'
import { describe, expect, it } from 'vitest'
import { getSnapshotAuthorFilter, getSnapshotTitleFilter, parseFilterByAuthor, parseFilterByTitle } from './parse'

describe('不可变过滤名单缓存', () => {
  it('共用同一份作者快照的解析，保留 MID、备注和名字匹配', () => {
    const rules = Object.freeze(['123', '123(别名)', '456(UP 名称)', '名字', '名字'])
    const parsed = getSnapshotAuthorFilter(rules)
    expect(getSnapshotAuthorFilter(rules)).toBe(parsed)
    expect(parsed).toEqual(parseFilterByAuthor(rules))
    expect([...parsed.blockUpMids]).toEqual(['123', '456'])
    expect([...parsed.blockUpNames]).toEqual(['名字'])
  })

  it('无关设置更新沿用缓存，增删名单立即失效', () => {
    const state = proxy({ keywords: ['123'], enabled: true })
    const original = getSnapshotAuthorFilter(snapshot(state).keywords)
    state.enabled = false
    expect(getSnapshotAuthorFilter(snapshot(state).keywords)).toBe(original)
    state.keywords.push('456')
    const added = getSnapshotAuthorFilter(snapshot(state).keywords)
    expect([...added.blockUpMids]).toEqual(['123', '456'])
    expect(added).not.toBe(original)
    state.keywords.splice(0, 1)
    expect([...getSnapshotAuthorFilter(snapshot(state).keywords).blockUpMids]).toEqual(['456'])
    expect([...original.blockUpMids]).toEqual(['123'])
  })

  it('原始解析接口不缓存，可编辑数组增删立即生效', () => {
    const rules = ['123']
    const original = parseFilterByAuthor(rules)
    rules.push('456')
    expect([...parseFilterByAuthor(rules).blockUpMids]).toEqual(['123', '456'])
    expect([...original.blockUpMids]).toEqual(['123'])
    expect(parseFilterByAuthor(Object.freeze(rules))).not.toBe(parseFilterByAuthor(rules))
  })

  it('标题正则和普通关键词语义一致，重复匹配不积累正则状态', () => {
    const rules = Object.freeze(['旅游', '/^foo\\d+$/'])
    const cached = getSnapshotTitleFilter(rules)
    const fresh = parseFilterByTitle(rules)
    expect(getSnapshotTitleFilter(rules)).toBe(cached)
    for (let i = 0; i < 3; i++) {
      for (const title of ['旅游攻略', 'FOO123', 'foo', 'prefixfoo123', '其他内容']) {
        expect(cached.test(title)).toBe(fresh.test(title))
      }
    }
    expect(cached.test('FOO123')).toBe(true)
    expect(cached.test('旅游攻略')).toBe(true)
    expect(cached.test('prefixfoo123')).toBe(false)
  })

  it('可编辑标题名单的增删立即生效，非法正则仍报告错误', () => {
    const rules = ['旧词']
    const original = parseFilterByTitle(rules)
    rules[0] = '新词'
    expect(parseFilterByTitle(rules).test('新词')).toBe(true)
    expect(parseFilterByTitle(rules).test('旧词')).toBe(false)
    expect(original.test('旧词')).toBe(true)
    expect(() => getSnapshotTitleFilter(Object.freeze(['/[/']))).toThrow(SyntaxError)
  })
})
