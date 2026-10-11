import { describe, expect, it, vi } from 'vitest'

import { tagRecBackoff } from '../api/backoff'
import { fetchAllV2Search, fetchSuggest, fetchTagInfoByName, type TagInfo } from '../api/endpoints'
import {
  analyzeAllV2Videos,
  buildCandidateRows,
  candidateRowKey,
  compareCandidateRows,
  mergeCandidateRows,
  mergeTagRecCooccurAliases,
  normalizeTagName,
  parseAllV2TagField,
  parseTagInput,
  resolveCandidateRows,
  runPhase2Round,
  sortCandidateRows,
  type CandidateRow,
} from './resolve'
import type { AllV2VideoItem } from './normalize-item'

// endpoints 是 IO 边界 (经 $common 触浏览器环境); 纯函数测试以 mock 隔掉网络层
vi.mock('../api/endpoints', () => ({
  ALLV2_PAGE_CAP: 50,
  fetchAllV2Search: vi.fn(() => Promise.resolve([])),
  fetchSuggest: vi.fn(() => Promise.resolve([])),
  fetchTagInfoById: vi.fn(() => Promise.resolve(undefined)),
  fetchTagInfoByName: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../api/backoff', () => ({ tagRecBackoff: { isEngaged: false } }))
vi.mock('../api/video-tags-store', () => ({ persistVideoTags: vi.fn(() => Promise.resolve()) }))

const video = (bvid: string, tag?: string): AllV2VideoItem => ({ bvid, title: bvid, tag })
const info = (id: number, name: string, use?: number): TagInfo => ({ id, name, use })

describe.concurrent('$modules/tag-rec/model/resolve', () => {
  // #region 归一化同形判定
  it('.normalizeTagName 小写+去空白+NFKC 同形', () => {
    expect(normalizeTagName('Demons Roots')).toBe('demonsroots')
    expect(normalizeTagName('demons roots')).toBe('demonsroots')
    expect(normalizeTagName('DEMONS ROOTS')).toBe('demonsroots')
    expect(normalizeTagName('demonsroots')).toBe('demonsroots')
    expect(normalizeTagName('demons  roots')).toBe('demonsroots') // 双空格
    expect(normalizeTagName(' demons roots ')).toBe('demonsroots')
    // NFKC: 全角字母/全角空格归一
    expect(normalizeTagName('Ｄｅｍｏｎｓ　Ｒｏｏｔｓ')).toBe('demonsroots')
    expect(normalizeTagName('原神')).toBe('原神')
    // 不同形
    expect(normalizeTagName('魔之根源')).not.toBe('demonsroots')
    expect(normalizeTagName('')).toBe('')
  })
  // #endregion

  // #region 输入分流
  it('.parseTagInput 纯数字 => id 直输; 文本 => name; 空 => undefined', () => {
    expect(parseTagInput('7945544')).toEqual({ kind: 'id', id: 7945544 })
    expect(parseTagInput('  42  ')).toEqual({ kind: 'id', id: 42 })
    expect(parseTagInput('原神')).toEqual({ kind: 'name', name: '原神' })
    expect(parseTagInput('Demons Roots')).toEqual({ kind: 'name', name: 'Demons Roots' })
    expect(parseTagInput('123abc')).toEqual({ kind: 'name', name: '123abc' }) // 非纯数字
    expect(parseTagInput('')).toBeUndefined()
    expect(parseTagInput(' '.repeat(3))).toBeUndefined()
  })
  // #endregion

  // #region all/v2 tag 字段解析
  it('.parseAllV2TagField 半角逗号切分/trim/去重; 全角逗号不切', () => {
    expect(parseAllV2TagField('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(parseAllV2TagField(' a , b ,c ')).toEqual(['a', 'b', 'c'])
    expect(parseAllV2TagField('a,b,a,c')).toEqual(['a', 'b', 'c']) // 去重保序
    expect(parseAllV2TagField('风仙亦是仙，古剑通幽玄,原神')).toEqual(['风仙亦是仙，古剑通幽玄', '原神'])
    expect(parseAllV2TagField('')).toEqual([])
    expect(parseAllV2TagField(undefined)).toEqual([])
    expect(parseAllV2TagField('a,,b,')).toEqual(['a', 'b'])
  })
  // #endregion

  // #region Phase 2 分析: 精确/相关分流 + 变体 + 共现频次排序
  it('.analyzeAllV2Videos 四重产出原料', () => {
    const videos = [
      video('BV1', 'Demons Roots,RPG,攻略'), // hit
      video('BV2', 'demons roots,RPG'), // hit (另一写法)
      video('BV3', 'demonsroots,RPG,魔之根源'), // hit (再一写法)
      video('BV4', 'RPG,其它'), // miss
      video('BV5', '无关'), // miss
      video('BV6'), // 无 tag => 票 13 D6 放行进 related 档 (不丢弃, 不进共现语料)
    ]
    const ret = analyzeAllV2Videos(videos, normalizeTagName('Demons Roots'))
    // ② 精确召回: tag 命中锚点子集
    expect(ret.exact.map((v) => v.bvid)).toEqual(['BV1', 'BV2', 'BV3'])
    // ③ 兜底留存 (含空 tag 字段条目, D6)
    expect(ret.related.map((v) => v.bvid)).toEqual(['BV4', 'BV5', 'BV6'])
    // ① 字形变体: 同形去重写法
    expect(ret.glyphSpellings.sort()).toEqual(['Demons Roots', 'demons roots', 'demonsroots'].sort())
    // 语义别名共现频次排序: RPG 3 次, 攻略/魔之根源各 1 次 (miss 视频不计)
    expect(ret.cooccurAliases[0]).toMatchObject({ name: 'RPG', count: 3 })
    expect(ret.cooccurAliases.map((a) => a.norm)).not.toContain('demonsroots')
    expect(ret.cooccurAliases.find((a) => a.name === '魔之根源')?.count).toBe(1)
    expect(ret.cooccurAliases.find((a) => a.name === '其它')).toBeUndefined() // miss 视频不计共现
    // sediment 语料 = 全部有 tag 视频
    expect(ret.cliques).toHaveLength(5)
  })

  it('.analyzeAllV2Videos (Q4-C): matchNorms 多键分桶 —— 任一构成成员命中即 exact', () => {
    const videos = [
      video('BV1', '原神,cosplay,米哈游'), // 双成员
      video('BV2', '原神,日常'), // 单成员
      video('BV3', '美食,探店'), // 双不沾 => related
      video('BV4'), // 空 tag => D6 related
      { bvid: 'BV5', title: '原神 cos 正片' }, // 空 tag 标题含成员词 => exact
    ]
    const ret = analyzeAllV2Videos(videos, '原神 cos', ['原神', 'cos'])
    expect(ret.exact.map((v) => v.bvid)).toEqual(['BV1', 'BV2', 'BV5'])
    expect(ret.related.map((v) => v.bvid)).toEqual(['BV3', 'BV4'])
    // 命中集成员不计别名共现 (两边都是锚点)
    expect(ret.cooccurAliases.map((a) => a.norm)).not.toContain('cos')
    expect(ret.cooccurAliases.map((a) => a.norm)).not.toContain('原神')
    expect(ret.cooccurAliases.find((a) => a.name === '米哈游')?.count).toBe(1)
  })

  it('.analyzeAllV2Videos 票35: 标题含输入词同划 exact (去高亮/归一化子串; 空tag标题命中也进 exact)', () => {
    const norm = normalizeTagName('Demons Roots')
    const videos = [
      { bvid: 'BVa', title: '<em class="keyword">Demons Roots</em>实况', tag: 'RPG' }, // 标题命中(tag未含)
      { bvid: 'BVb', title: 'demons roots 全流程', tag: '其它' }, // 归一化+去空格命中
      { bvid: 'BVc', title: 'Demons Roots 速通' }, // 空 tag 标题命中 => 也进 exact
      { bvid: 'BVd', title: '完全无关标题', tag: 'RPG' }, // 双不沾 => related
      { bvid: 'BVe', title: '无关' }, // 空 tag 无命中 => related (D6)
    ]
    const ret = analyzeAllV2Videos(videos, norm)
    expect(ret.exact.map((v) => v.bvid)).toEqual(['BVa', 'BVb', 'BVc'])
    expect(ret.related.map((v) => v.bvid)).toEqual(['BVd', 'BVe'])
  })
  // #endregion

  // #region 候选行排序/徽章
  const row = (p: Partial<CandidateRow> & { tag_name: string }): CandidateRow => ({
    key: candidateRowKey(p),
    badge: 'cooccur',
    checked: false,
    ...p,
  })

  it('.sortCandidateRows 共现先于使用量，低使用量相关标签不被热门标签挤掉', () => {
    const rows = sortCandidateRows([
      row({ tag_name: '无use高频', cooccur: 9 }),
      row({ tag_name: '小', use: 10 }),
      row({ tag_name: '大', use: 999 }),
      row({ tag_name: '无use低频', cooccur: 1 }),
      row({ tag_name: '中', use: 100 }),
    ])
    expect(rows.map((r) => r.tag_name)).toEqual(['无use高频', '无use低频', '大', '中', '小'])
  })

  it('.sortCandidateRows 精确 > 共现 > 联想，使用量不跨相关性层抢位', () => {
    const rows = sortCandidateRows([
      row({ tag_name: '热门联想', badge: 'suggest', use: 1e9 }),
      row({ tag_name: '共现', badge: 'cooccur', cooccur: 2 }),
      row({ tag_name: '精确', badge: 'exact' }),
    ])
    expect(rows.map((r) => r.tag_name)).toEqual(['精确', '共现', '热门联想'])
  })

  it('.compareCandidateRows 同 use 时共现频次降序', () => {
    const a = row({ tag_name: 'a', cooccur: 3 })
    const b = row({ tag_name: 'b', cooccur: 8 })
    expect(compareCandidateRows(a, b)).toBeGreaterThan(0)
    expect(sortCandidateRows([a, b])[0].tag_name).toBe('b')
  })

  it('.candidateRowKey 有 id 按 id, 无 id 按归一名', () => {
    expect(candidateRowKey({ tag_name: 'x', tag_id: 5 })).toBe('id:5')
    expect(candidateRowKey({ tag_name: 'Demons Roots' })).toBe('n:demonsroots')
  })

  it('.mergeCandidateRows 去重/强徽章胜/保留勾选态', () => {
    const existing = sortCandidateRows([
      row({ tag_name: '别名A', tag_id: 7, badge: 'suggest', checked: true, expanded: true }),
    ])
    const incoming = [
      row({ tag_name: '别名A', tag_id: 7, badge: 'cooccur', cooccur: 5 }),
      row({ tag_name: '新B', tag_id: 8, badge: 'cooccur' }),
    ]
    const merged = mergeCandidateRows(existing, incoming)
    expect(merged).toHaveLength(2)
    const a = merged.find((r) => r.tag_id === 7)!
    expect(a.badge).toBe('cooccur') // 共现 > 联想
    expect(a.checked).toBe(true) // 用户态保留
    expect(a.expanded).toBe(true)
    expect(a.cooccur).toBe(5)
  })

  it('.mergeCandidateRows A5 上界: 未触及行截 200, 已触行 (勾选/在途/败绩) 不受截', () => {
    // 排序尾部 = 无 use + 低 cooccur → 被截的应是低分未触及行
    const existing = sortCandidateRows(
      Array.from({ length: 210 }, (_, i) => row({ tag_name: `t${i}`, cooccur: 210 - i })),
    )
    const merged = mergeCandidateRows(existing, [])
    expect(merged).toHaveLength(200)
    expect(merged.some((r) => r.tag_name === 't209')).toBe(false) // 最低分未触及行出列

    const pinned = sortCandidateRows([
      ...Array.from({ length: 199 }, (_, i) => row({ tag_name: `p${i}`, cooccur: 199 - i })),
      row({ tag_name: '低分但已勾', cooccur: 1, checked: true }),
      row({ tag_name: '低分在途', cooccur: 1, resolving: true }),
      row({ tag_name: '低分败绩', cooccur: 1, resolveFailed: true }),
    ])
    const merged2 = mergeCandidateRows(pinned, [])
    expect(merged2).toHaveLength(202) // 199 未触及 + 3 已触行不占额
    expect(merged2.find((r) => r.tag_name === '低分但已勾')?.checked).toBe(true)
    expect(merged2.some((r) => r.tag_name === '低分在途')).toBe(true)
    expect(merged2.some((r) => r.tag_name === '低分败绩')).toBe(true)
  })

  it('.buildCandidateRows 徽章/默认勾/票18 惰性入清单', () => {
    const rows = buildCandidateRows({
      anchor: info(267, 'demons roots', 485),
      variantEntries: [info(267, 'demons roots', 485), info(131, 'DemonsRoots', 131), info(333, '魔之根源', 333)],
      aliases: [
        { name: 'RPG', count: 3 },
        { name: '低频别名', count: 1 },
      ],
      suggest: ['demons roots 攻略', 'demonsroots'], // 后者与输入同形 => 跳过
      inputNorm: 'demonsroots',
    })
    const byId = new Map(rows.map((r) => [r.tag_id, r]))
    // 锚点 + 变体: 精确徽章默认勾 (同 id 267 去重为一行)
    expect(byId.get(267)).toMatchObject({ badge: 'exact', checked: true, use: 485 })
    expect(byId.get(131)).toMatchObject({ badge: 'exact', checked: true })
    expect(byId.get(333)).toMatchObject({ badge: 'exact', checked: true })
    // 共现别名惰性入清单: 无 tag_id/use, 带共现频次, 不勾
    const rpg = rows.find((r) => r.tag_name === 'RPG')!
    expect(rpg).toMatchObject({ badge: 'cooccur', checked: false, cooccur: 3 })
    expect(rpg.tag_id).toBeUndefined()
    expect(rpg.use).toBeUndefined()
    // suggest: 与锚点同形跳过; 其余联想行同样无 id 入清单
    expect(rows.find((r) => r.tag_name === 'demonsroots')).toBeUndefined()
    const sug = rows.find((r) => r.tag_name === 'demons roots 攻略')!
    expect(sug).toMatchObject({ badge: 'suggest', checked: false })
    expect(sug.tag_id).toBeUndefined()
    // 排序: 已解析行 use 降序在前 (485>333>131); 未解析行按共现频次垫后 (RPG3 > 低频1 > 联想0)
    expect(rows.slice(0, 3).map((r) => r.tag_id)).toEqual([267, 333, 131])
    expect(rows.slice(3).map((r) => r.tag_name)).toEqual(['RPG', '低频别名', 'demons roots 攻略'])
  })

  it('.resolveCandidateRows 惰性解析: 成功回填 id/use, 失败标 resolveFailed, 同形名去重', async () => {
    vi.mocked(fetchTagInfoByName).mockImplementation((name) =>
      Promise.resolve(name === '别名A' ? info(9, '别名A', 8000) : undefined),
    )
    const rows = await resolveCandidateRows([
      row({ tag_name: '别名A', checked: true }),
      row({ tag_name: '别名a', checked: true }), // 与「别名A」归一同形 => 共享一次请求
      row({ tag_name: '别名B', checked: true }),
      row({ tag_name: '已解析', tag_id: 5, checked: true }),
    ])
    expect(rows[0]).toMatchObject({ tag_id: 9, use: 8000, resolveFailed: false })
    expect(rows[1]).toMatchObject({ tag_id: 9, use: 8000, resolveFailed: false }) // 共享解析结果
    expect(rows[2].resolveFailed).toBe(true)
    expect(rows[3].tag_id).toBe(5) // 已解析行不发请求
    expect(vi.mocked(fetchTagInfoByName)).toHaveBeenCalledTimes(2)
  })
  // #endregion

  // #region 票 38: suggest 双门槛 (退避避让 + 空结果轮不发)
  it('.runPhase2Round suggest 门槛 —— 退避期/空结果轮不发联想, 常态有货照发', async () => {
    const gate = tagRecBackoff as { isEngaged: boolean }
    const round = () =>
      runPhase2Round({ keyword: 'k', inputNorm: 'k', fromPage: 1, withSuggest: true, resolveVariants: false })

    // 常态 + 本页有视频 => 联想照常
    vi.mocked(fetchAllV2Search).mockResolvedValue([video('BV1', 'RPG')])
    vi.mocked(fetchSuggest).mockResolvedValue(['联想词'])
    const r1 = await round()
    expect(fetchSuggest).toHaveBeenCalledTimes(1)
    expect(r1.newCandidates.find((r) => r.tag_name === '联想词')?.badge).toBe('suggest')

    // 退避期 => 零联想发数
    gate.isEngaged = true
    vi.mocked(fetchSuggest).mockClear()
    const r2 = await round()
    expect(fetchSuggest).not.toHaveBeenCalled()
    expect(r2.newCandidates.some((r) => r.badge === 'suggest')).toBe(false)

    // 解退避但空结果轮 => 也不发 (videos.length 门槛)
    gate.isEngaged = false
    vi.mocked(fetchAllV2Search).mockResolvedValue([])
    await round()
    expect(fetchSuggest).not.toHaveBeenCalled()
  })
  // #endregion

  it('.mergeTagRecCooccurAliases 跨页累加: 同词计数相加、新词追加、归一化去重', () => {
    const merged = mergeTagRecCooccurAliases(
      [{ name: '原神', count: 3 }],
      [
        { name: '原神', norm: '原神', count: 2 },
        { name: '原神薇斯纳', norm: '原神薇斯纳', count: 5 },
      ],
    )
    expect(merged).toEqual([
      { name: '原神', count: 5 },
      { name: '原神薇斯纳', count: 5 },
    ])
    // 无 prev 计数 (仅名字) 也按 0 起累; 归一化去重同形不同写法不重复计行
    expect(
      mergeTagRecCooccurAliases([{ name: 'Demons Roots' }], [{ name: 'demonsroots', norm: 'demonsroots', count: 4 }]),
    ).toEqual([{ name: 'Demons Roots', count: 4 }])
  })
})
