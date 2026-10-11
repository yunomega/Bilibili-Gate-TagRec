import { describe, expect, it } from 'vitest'
import { tagRecMaterialSegments, tagRecMaterialWords, tagRecSegmentWords } from './material-words'

describe('视频标题和简介的短语建议', () => {
  it('保留作品名和完整短语，不拆成单字', () => {
    const text = '【TAB/附谱】我推的孩子日剧版 第2集主题曲「草々不一」/ ロクデナシ 帽皇角色曲 双吉他谱'
    const phrases = tagRecMaterialWords(text)
    expect(phrases).toContain('草々不一')
    expect(phrases).toContain('我推的孩子日剧版 第2集主题曲')
    expect(phrases).not.toContain('我')
    expect(phrases).not.toContain('推')
    expect(phrases.every((phrase) => text.includes(phrase))).toBe(true)
  })
  it('简介去除网址和提取码，保留书名与原文片段', () => {
    const text =
      '去年的年度歌之一，原版吉他太少了大部分得自己编。\n通过网盘分享的文件：《我推的孩子》帽皇电视剧角色曲.pdf\n链接: https://pan.baidu.com/s/1tIrd21WPyRnQ0syJWJmp0g\n提取码: xkv7\n想私自扒谱的可以私信我。'
    const phrases = tagRecMaterialWords(text)
    expect(phrases).toContain('我推的孩子')
    expect(phrases).toContain('原版吉他太少了大部分得自己编')
    expect(phrases.join(' ')).not.toMatch(/https|baidu|xkv7|1tIrd|提取码|链接|pdf/)
    expect(phrases.every((phrase) => phrase.length >= 2 && text.includes(phrase))).toBe(true)
  })
  it('无标点标题按 ICU 切词给出词级建议，整条标题 (<=32) 同时保留', () => {
    const text = 'BS 赛博物志之q群机器人大王佩特罗'
    const phrases = tagRecMaterialWords(text)
    expect(phrases).toContain(text) // 整条标题是合法的精确匹配短语
    expect(phrases).toContain('博物')
    expect(phrases).toContain('机器')
    expect(tagRecSegmentWords(text)).toContain('大王')
  })
  it('超长无分隔文本整条不进建议 (留给原文拖选)，切词只给词级、有数量上限并去重', () => {
    const long = '字'.repeat(100)
    const suggestions = tagRecMaterialWords(long)
    expect(suggestions).not.toContain(long) // 整条 (>32 字符) 不进建议
    expect(suggestions.every((phrase) => phrase.length >= 2 && phrase.length <= 32)).toBe(true)
    expect(tagRecMaterialWords('三体，三体')).toEqual(['三体'])
    expect(tagRecMaterialWords(Array.from({ length: 50 }, (_, i) => `短语${i}`).join('，'))).toHaveLength(24)
  })
})

describe('原文渲染的词段切分', () => {
  it('词段可点、标点与单字不可点，相邻同类合并', () => {
    const segments = tagRecMaterialSegments('机器 · 大王')
    expect(segments.filter((segment) => segment.word).map((segment) => segment.text)).toEqual(['机器', '大王'])
    expect(segments.map((segment) => segment.text).join('')).toBe('机器 · 大王')
    expect(segments.filter((segment) => !segment.word).every((segment) => segment.text.includes(' '))).toBe(true)
  })
  it('单字不成词段 (不提供可点入口)', () => {
    // ICU 对「三体」这类词典外词会切成单字 —— 单字不提供可点入口, 整条仍可拖选
    expect(tagRecMaterialSegments('a的b')).toEqual([{ text: 'a的b', word: false }])
    expect(tagRecMaterialSegments('三体').filter((segment) => segment.word)).toEqual([])
  })
})
