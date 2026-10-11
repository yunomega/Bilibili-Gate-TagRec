import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { addTagRecCondition, newTagRecCombination, tagRecConditionAtom } from './combination'
import {
  compareFallbackItems,
  cooccurVocab,
  countCooccurDegree,
  deriveGroupCliques,
  digResumeFromSediment,
  newDigStream,
  selectCooccurSeeds,
  stripRelatedSuffix,
  TAG_REC_AUTO_DIG_MAX,
  TAG_REC_CLIQUE_MAX,
  TAG_REC_CROSS_CLIQUE_MAX,
  TAG_REC_SEED_COUNT,
  TAG_REC_SEED_MIN_SCORE,
  TAG_REC_SEED_POOL_MAX,
  TAG_REC_TEXT_SEED_PAGE_CAP,
} from './dig'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type { SedimentNode } from './sediment'
import type { TagIdEntry } from './types'

const item = (bvid: string, extra: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'all-v2-related', groupNames: [] },
  ...extra,
})

const entry = (id: number, name: string): TagIdEntry => ({ id, name })
const group = (name: string, tag_ids: TagIdEntry[]) => ({ name, tag_ids })

describe.concurrent('$modules/tag-rec/model/dig (票13)', () => {
  it('.stripRelatedSuffix `X·相关` => X, 无后缀原样 (负向归因回落)', () => {
    expect(stripRelatedSuffix('组A·相关')).toBe('组A')
    expect(stripRelatedSuffix('Demons Roots·相关')).toBe('Demons Roots')
    expect(stripRelatedSuffix('组A')).toBe('组A')
    expect(stripRelatedSuffix('相关')).toBe('相关')
  })

  // #region D7 同义词簇派生
  it('.deriveGroupCliques 成员规范名按归一化去重成簇, keyword=首个成员规范名, 归属组名', () => {
    const groups = [
      group('G1', [entry(1, 'Demons Roots'), entry(2, 'demonsroots'), entry(3, '空洞骑士')]),
      group('G2', [entry(4, 'demons roots'), entry(5, '原神')]),
    ]
    const cliques = deriveGroupCliques(groups)
    // demonsroots 同形 3 写法 (跨 G1/G2) 并成一簇, 归属两组
    // W1-8: 簇序 = 组间轮转首发序 (G2 原神先于 G1 空洞骑士出簇), 不再组序+组内序
    expect(cliques).toEqual([
      { key: 'demonsroots', keyword: 'Demons Roots', attribution: ['G1', 'G2'] },
      { key: '原神', keyword: '原神', attribution: ['G2'] },
      { key: '空洞骑士', keyword: '空洞骑士', attribution: ['G1'] },
    ])
  })

  it('.deriveGroupCliques (W1-8): 组间轮转公平 —— 簇帽下前组不再独占名额', () => {
    const groups = [
      group('G1', [entry(1, 'a'), entry(2, 'b'), entry(3, 'c'), entry(4, 'd'), entry(5, 'e')]),
      group('G2', [entry(6, 'x'), entry(7, 'y')]),
    ]
    const cliques = deriveGroupCliques(groups)
    expect(cliques).toHaveLength(TAG_REC_CLIQUE_MAX) // 5
    // 轮转: a,x,b,y,c —— G2 两簇全进; 旧实现组序截断只留 a..e, G2 颗粒无收
    expect(cliques.map((c) => c.key)).toEqual(['a', 'x', 'b', 'y', 'c'])
    expect(cliques.filter((c) => c.attribution.includes('G2'))).toHaveLength(2)
  })

  it('.deriveGroupCliques 簇数上限 TAG_REC_CLIQUE_MAX 截断 (单组时仍组内序取前)', () => {
    const groups = [
      group('G', [entry(1, 'a'), entry(2, 'b'), entry(3, 'c'), entry(4, 'd'), entry(5, 'e'), entry(6, 'f')]),
    ]
    const cliques = deriveGroupCliques(groups)
    expect(TAG_REC_CLIQUE_MAX).toBe(5)
    expect(cliques).toHaveLength(5)
    expect(cliques.map((c) => c.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('.deriveGroupCliques 空成员/空组 => 空', () => {
    expect(deriveGroupCliques([])).toEqual([])
    expect(deriveGroupCliques([group('G', [])])).toEqual([])
  })

  it('.deriveGroupCliques (Q6b/Q7a): 组合 title/desc 词 —— 短词带 pageCap, 长词不开流', () => {
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 1, name: '原神' }))
    addTagRecCondition(combination, tagRecConditionAtom('title', '三体'))
    addTagRecCondition(combination, tagRecConditionAtom('title', 'BS赛博物志之q群机器人大王佩特罗'))
    const cliques = deriveGroupCliques([{ id: '__tagrec_working__', name: '新试验', tag_ids: [], combination }])
    // tag 种子全量深挖 (无 cap); 短文本词开流但限页
    expect(cliques.find((c) => c.key === '原神')?.pageCap).toBeUndefined()
    expect(cliques.find((c) => c.key === '三体')?.pageCap).toBe(TAG_REC_TEXT_SEED_PAGE_CAP)
    // 20 字长词不开流 (纯本地精确匹配, 搜索结果纯噪声)
    expect(cliques.some((c) => c.key === normalizeTagName('BS赛博物志之q群机器人大王佩特罗'))).toBe(false)
  })

  // #region Q4-C 交集组合词流
  const tagAtom = (id: number, name: string) => tagRecConditionAtom('tag', { id, name })
  const subgroup = (id: string, atoms: ReturnType<typeof tagAtom>[]) => ({
    kind: 'group' as const,
    id,
    mode: 'any' as const,
    children: atoms,
  })

  it('.deriveGroupCliques (Q4-C): 交集组合 => 跨分支组合词流; 非交集零产', () => {
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagAtom(1, '原神'))
    addTagRecCondition(combo, tagAtom(2, '芙宁娜')) // 同字段归组 => 分支1
    combo.include.children.push(subgroup('b2', [tagAtom(3, 'cos'), tagAtom(4, 'Cosplay')])) // 分支2
    const cliques = deriveGroupCliques([{ id: 'g', name: '组', tag_ids: [], combination: combo }])
    const cross = cliques.filter((c) => c.crossNorms)
    expect(cross.map((c) => c.keyword).sort()).toEqual(
      ['原神 cos', '原神 Cosplay', '芙宁娜 cos', '芙宁娜 Cosplay'].sort(),
    )
    const pair = cross.find((c) => c.keyword === '原神 cos')!
    expect(pair.key).toBe('cos 原神') // 归一序对 (反向同键不重复建流)
    expect(pair.crossNorms).toEqual(['原神', 'cos'])
    expect(pair.groupIds).toEqual(['g'])
    expect(pair.attribution).toEqual(['组'])
    // 单词流照常开 (原神/芙宁娜/cos/cosplay 各一簇 —— cos 与 cosplay 归一不同名不并簇)
    expect(
      cliques
        .filter((c) => !c.crossNorms)
        .map((c) => c.key)
        .sort(),
    ).toEqual(['cos', 'cosplay', '原神', '芙宁娜'].sort())
    // 非交集 (单 tag 分支) => 零组合词流
    const flat = newTagRecCombination()
    addTagRecCondition(flat, tagAtom(5, 'a'))
    const noCross = deriveGroupCliques([{ name: 'G', tag_ids: [], combination: flat }])
    expect(noCross.every((c) => !c.crossNorms)).toBe(true)
  })

  it('.deriveGroupCliques (Q4-C): 跨组同 pair 归一去重并归属; 新 pair 数量帽 TAG_REC_CROSS_CLIQUE_MAX', () => {
    const comboA = newTagRecCombination()
    addTagRecCondition(comboA, tagAtom(1, '原神'))
    comboA.include.children.push(subgroup('a2', [tagAtom(2, 'cos')]))
    const comboB = newTagRecCombination()
    addTagRecCondition(comboB, tagAtom(3, 'cos')) // B 分支序反置 => 同 pair 'cos 原神'
    comboB.include.children.push(subgroup('b2', [tagAtom(4, '原神')]))
    const cliques = deriveGroupCliques([
      { id: 'g1', name: '甲', tag_ids: [], combination: comboA },
      { id: 'g2', name: '乙', tag_ids: [], combination: comboB },
    ])
    const cross = cliques.filter((c) => c.crossNorms)
    expect(cross).toHaveLength(1)
    expect(cross[0].attribution).toEqual(['甲', '乙'])
    expect(cross[0].groupIds).toEqual(['g1', 'g2'])
    // 数量帽: 4×3=12 对 > cap
    const wide = newTagRecCombination()
    wide.include.children.push(
      subgroup('w1', [tagAtom(1, 'a'), tagAtom(2, 'b'), tagAtom(3, 'c'), tagAtom(4, 'd')]),
      subgroup('w2', [tagAtom(5, 'e'), tagAtom(6, 'f'), tagAtom(7, 'g')]),
    )
    const capped = deriveGroupCliques([{ name: 'G', tag_ids: [], combination: wide }]).filter((c) => c.crossNorms)
    expect(capped).toHaveLength(TAG_REC_CROSS_CLIQUE_MAX)
  })

  it('.deriveGroupCliques (Q4-C 扩展): tag × title/desc 混合维组合词流 —— 非真交集也产 pair, 长词除外', () => {
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagAtom(1, '至冬')) // tag 分支
    addTagRecCondition(combo, tagRecConditionAtom('title', 'cos')) // title 分支 (同字段归组)
    addTagRecCondition(combo, tagRecConditionAtom('title', '一段很长的标题关键词超过了十二字')) // 长词不配 pair
    const cliques = deriveGroupCliques([{ id: 'g', name: '组', tag_ids: [], combination: combo }])
    const cross = cliques.filter((c) => c.crossNorms)
    // (tag 分支) × (title 分支) => 唯一 pair; 交集判据不含此形但召回密度逻辑同构
    expect(cross).toHaveLength(1)
    expect(cross[0].keyword).toBe('至冬 cos')
    expect(cross[0].crossNorms).toEqual(['至冬', 'cos'])
    // 同词跨支 (tag X ∩ title 含 X) => norm 同词不配对
    const degenerate = newTagRecCombination()
    addTagRecCondition(degenerate, tagAtom(2, 'cos'))
    addTagRecCondition(degenerate, tagRecConditionAtom('title', 'cos'))
    expect(deriveGroupCliques([{ name: 'G', tag_ids: [], combination: degenerate }]).every((c) => !c.crossNorms)).toBe(
      true,
    )
    // 根组任一命中 => 并集语义, 配对只会截小召回 => 零产
    const anyRoot = newTagRecCombination()
    anyRoot.include.mode = 'any'
    addTagRecCondition(anyRoot, tagAtom(3, 'a'))
    addTagRecCondition(anyRoot, tagRecConditionAtom('title', 'b'))
    expect(deriveGroupCliques([{ name: 'G', tag_ids: [], combination: anyRoot }]).every((c) => !c.crossNorms)).toBe(
      true,
    )
  })

  it('.deriveGroupCliques (Q4-C 扩展): all 子组展开为逐分支 + 过滤 allow-list 作必需伪分支', () => {
    // 单个 all 子组 all{a,b} —— 与两兄弟分支同语义 => 组合词照产
    const allSub = newTagRecCombination()
    allSub.include.children.push({
      kind: 'group',
      id: 'sub',
      mode: 'all',
      children: [tagAtom(1, 'a'), tagAtom(2, 'b')],
    })
    const subCross = deriveGroupCliques([{ name: 'G', tag_ids: [], combination: allSub }]).filter((c) => c.crossNorms)
    expect(subCross.map((c) => c.keyword)).toEqual(['a b'])

    // 任一命中根 + titleAllow 必过过滤 => 每个成员词 × 过滤词配对
    const anyFiltered = newTagRecCombination()
    anyFiltered.include.mode = 'any'
    addTagRecCondition(anyFiltered, tagAtom(1, 'a'))
    addTagRecCondition(anyFiltered, tagAtom(2, 'b'))
    anyFiltered.filters = { dims: { titleAllow: { enabled: true, list: ['cos'] } } }
    const filteredCross = deriveGroupCliques([{ name: 'G', tag_ids: [], combination: anyFiltered }]).filter(
      (c) => c.crossNorms,
    )
    expect(filteredCross.map((c) => c.keyword).sort()).toEqual(['a cos', 'b cos'])
    // 过滤关掉/名单空 => 回退零产 (任一命中语义不变)
    anyFiltered.filters!.dims.titleAllow!.enabled = false
    expect(deriveGroupCliques([{ name: 'G', tag_ids: [], combination: anyFiltered }]).every((c) => !c.crossNorms)).toBe(
      true,
    )
  })

  it('.deriveGroupCliques (Q4-C 盲区): any 根内 all 子组内配 + 生效链 extra + 页帽/轮转', () => {
    // any[a, all{x,y}] —— x×y 是唯一瞄准 all 备选的查询; a 不与 x/y 配 (截并集无谓开销)
    const nested = newTagRecCombination()
    nested.include.mode = 'any'
    nested.include.children.push(tagAtom(1, 'a'), {
      kind: 'group',
      id: 'sub',
      mode: 'all',
      children: [tagAtom(10, 'x'), tagAtom(11, 'y')],
    })
    const nestedCross = deriveGroupCliques([{ name: 'G', tag_ids: [], combination: nested }]).filter(
      (c) => c.crossNorms,
    )
    expect(nestedCross.map((c) => c.keyword)).toEqual(['x y'])

    // 生效链「仅看」名单 (extra) —— 会话面板开的 titleAllow 组合内 filters 看不到也照配
    const withExtra = newTagRecCombination()
    addTagRecCondition(withExtra, tagAtom(1, '至冬'))
    const cross2 = deriveGroupCliques([
      {
        name: 'G',
        tag_ids: [],
        combination: withExtra,
        extra: { allowTitle: ['cos'], allowTags: [{ id: 9, name: 'miku' }] },
      },
    ]).filter((c) => c.crossNorms)
    expect(cross2.map((c) => c.keyword).sort()).toEqual(['miku cos', '至冬 cos', '至冬 miku'])

    // 屏蔽词不进查询 —— 词在生效链被滤死, 配它整流白烧
    const blocked = deriveGroupCliques([
      {
        name: 'G',
        tag_ids: [],
        combination: withExtra,
        extra: { allowTitle: ['cos'], allowTags: [{ id: 9, name: 'miku' }], blockNorms: new Set(['cos']) },
      },
    ]).filter((c) => c.crossNorms)
    expect(blocked.map((c) => c.keyword)).toEqual(['至冬 miku'])

    // 页帽: tag×tag 是真产线不设帽; 含 title/desc 词的 pair 继承文本试探帽
    const capped = cross2.find((c) => c.keyword === '至冬 cos')
    const uncapped = cross2.find((c) => c.keyword === '至冬 miku')
    expect(capped?.pageCap).toBe(TAG_REC_TEXT_SEED_PAGE_CAP)
    expect(uncapped?.pageCap).toBeUndefined()

    // pairSalt 轮转: 4×4=16 对超帽 8, 不同盐取不同窗口 —— 牺牲位逐轮换
    const wide = newTagRecCombination()
    wide.include.children.push(
      subgroup('w1', [tagAtom(1, 'a'), tagAtom(2, 'b'), tagAtom(3, 'c'), tagAtom(4, 'd')]),
      subgroup('w2', [tagAtom(5, 'e'), tagAtom(6, 'f'), tagAtom(7, 'g'), tagAtom(8, 'h')]),
    )
    const keys = (salt: number) =>
      deriveGroupCliques([{ name: 'G', tag_ids: [], combination: wide }], Infinity, salt)
        .filter((c) => c.crossNorms)
        .map((c) => c.key)
    const s0 = keys(0)
    const s8 = keys(8)
    expect(s0).toHaveLength(TAG_REC_CROSS_CLIQUE_MAX)
    expect(s8).toHaveLength(TAG_REC_CROSS_CLIQUE_MAX)
    expect(new Set([...s0, ...s8]).size).toBeGreaterThan(TAG_REC_CROSS_CLIQUE_MAX) // 两窗不重合 => 轮转生效
  })
  // #endregion
  // #endregion

  // #region D2 词表与共现度
  it('.cooccurVocab 锚点邻域词表 = sediment 节点 cooccur 键并集 (多 norm 合并)', () => {
    const pool = new Map<string, SedimentNode>()
    const node = (cooccur: Record<string, unknown>): SedimentNode => ({
      variants: [],
      cooccur: cooccur as SedimentNode['cooccur'],
      lastSeen: 0,
    })
    pool.set('demonsroots', node({ ラビリンス: {}, sequelblight: {} }))
    pool.set('空洞骑士', node({ 丝之歌: {} }))
    const vocab = cooccurVocab(pool, ['demonsroots', '空洞骑士'])
    expect([...vocab].sort()).toEqual(['sequelblight', 'ラビリンス', '丝之歌'].sort())
    // 未命中节点 / 空词表
    expect(cooccurVocab(pool, ['不存在']).size).toBe(0)
    expect(cooccurVocab(new Map(), ['x']).size).toBe(0)
  })

  it('.countCooccurDegree 自身 tag 归一化后命中词表的个数 (同 norm 多写法只计一次)', () => {
    const vocab = new Set(['aaa', 'bbb'])
    expect(countCooccurDegree(['AAA', 'A A A', 'ccc'], vocab)).toBe(1) // aaa/AAA/A A A 同形
    expect(countCooccurDegree(['AAA', 'BbB'], vocab)).toBe(2)
    expect(countCooccurDegree(['ccc'], vocab)).toBe(0)
    expect(countCooccurDegree([], vocab)).toBe(0)
  })
  // #endregion

  // #region D2 共现选种
  it('.selectCooccurSeeds 默认共现优先，显式分数门槛仍做硬筛选', () => {
    const cands = [
      { bvid: 'low-co', cooccur: 1, score: 90 },
      { bvid: 'best', cooccur: 5, score: 60 },
      { bvid: 'tie', cooccur: 5, score: 80 }, // 同共现按分排序
      { bvid: 'strong-low', cooccur: 9, score: 10 },
      { bvid: 'zero', cooccur: 0, score: 99 }, // 零共现剔除
      { bvid: 'mid', cooccur: 3, score: 50 },
    ]
    expect(TAG_REC_SEED_COUNT).toBe(3)
    expect(TAG_REC_SEED_MIN_SCORE).toBe(0)
    expect(selectCooccurSeeds(cands)).toEqual(['strong-low', 'tie', 'best'])
    expect(selectCooccurSeeds(cands, { minScore: 30 })).toEqual(['tie', 'best', 'mid'])
  })

  it('.selectCooccurSeeds 种子不足取全部; 全不达标 => 空', () => {
    expect(selectCooccurSeeds([{ bvid: 'a', cooccur: 2, score: 40 }])).toEqual(['a'])
    expect(selectCooccurSeeds([{ bvid: 'b', cooccur: 0, score: 90 }])).toEqual([])
    expect(selectCooccurSeeds([])).toEqual([])
  })
  // #endregion

  // #region D1/D3 兜底堆排序
  it('.compareFallbackItems 同相关性层按质量与来源序，不将缺统计强制排尾', () => {
    const sorted = [
      item('kw-high', { score: 90, srcRank: 0 }), // 关键词 related 高分
      item('arch-mid', { score: 90, srcRank: 3, source: { via: 'archive-related', groupNames: [] } }), // 同分: archive 优先
      item('arch-low', { score: 40, srcRank: 0, source: { via: 'archive-related', groupNames: [] } }),
      item('partial', { partial: true, stat: { view: 999 }, source: { via: 'archive-related', groupNames: [] } }),
      item('noscore', { srcRank: 0 }),
    ]
      .sort(compareFallbackItems)
      .map((x) => x.bvid)
    expect(sorted).toEqual(['arch-mid', 'kw-high', 'arch-low', 'partial', 'noscore'])
  })

  it('.compareFallbackItems partial 组内按 view desc', () => {
    const sorted = [
      item('p1', { partial: true, stat: { view: 10 } }),
      item('p2', { partial: true, stat: { view: 900 } }),
      item('scored', { score: 1 }),
    ].sort(compareFallbackItems)
    expect(sorted.map((x) => x.bvid)).toEqual(['scored', 'p2', 'p1'])
  })
  // #endregion

  // #region 票 36: 深挖游标 sediment 水合 (建流 resume)
  it('.newDigStream resume 参数: 缺省页1新流; 给游标 => 续页 + exhausted 复活', () => {
    expect(newDigStream({ key: 'a', keyword: 'A', attribution: [] })).toMatchObject({
      nextPage: 1,
      exhausted: false,
    })
    const s = newDigStream({ key: 'a', keyword: 'A', attribution: [] }, { nextPage: 7, exhausted: true })
    expect(s.nextPage).toBe(7)
    expect(s.exhausted).toBe(true)
    expect(s.keyword).toBe('A')
  })

  it('.digResumeFromSediment: keyword 精确等值才水合; 无 dig/拼写变/脏游标 => 按新流', () => {
    const node = (dig?: SedimentNode['dig']): SedimentNode => ({ variants: [], cooccur: {}, lastSeen: 0, dig })
    expect(digResumeFromSediment(undefined, 'A')).toBeUndefined() // 查无节点
    expect(digResumeFromSediment(node(), 'A')).toBeUndefined() // 老节点无 dig 字段
    // 同 norm 异拼写 (key 同 keyword 不同) => 不误续
    expect(digResumeFromSediment(node({ keyword: 'a ', nextPage: 7, lastAt: 0 }), 'A')).toBeUndefined()
    expect(digResumeFromSediment(node({ keyword: 'A', nextPage: 7, lastAt: 0 }), 'A')).toEqual({
      nextPage: 7,
      exhausted: false,
    })
    // exhausted 随游标水合复活 (A 档: 跨会话不再自动重扫)
    expect(digResumeFromSediment(node({ keyword: 'A', nextPage: 52, exhausted: true, lastAt: 0 }), 'A')).toEqual({
      nextPage: 52,
      exhausted: true,
      stopReason: 'legacy',
      retryAt: 3600000,
    })
    // 脏 nextPage (0 / NaN / 负数) => 按新流
    expect(digResumeFromSediment(node({ keyword: 'A', nextPage: 0, lastAt: 0 }), 'A')).toBeUndefined()
    expect(digResumeFromSediment(node({ keyword: 'A', nextPage: NaN, lastAt: 0 }), 'A')).toBeUndefined()
  })
  // #endregion

  it('参数快照: K=3 自动深挖 / 池<12 触发选种 (票32) / score>=30 / top3 / 簇<=5', () => {
    expect(TAG_REC_AUTO_DIG_MAX).toBe(3)
    expect(TAG_REC_SEED_POOL_MAX).toBe(12)
    expect(TAG_REC_SEED_MIN_SCORE).toBe(0)
    expect(TAG_REC_SEED_COUNT).toBe(3)
    expect(TAG_REC_CLIQUE_MAX).toBe(5)
  })
})
