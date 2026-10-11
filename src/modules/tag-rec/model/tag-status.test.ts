import { describe, expect, it } from 'vitest'
import {
  classifyVideoTagStatus,
  DRAFT_GROUP_ID,
  parseTagType,
  resolveLandingGroups,
  videoTagToTagIdEntry,
} from './tag-status'
import type { TagGroup } from './types'

const g = (id: string, ids: { id: number; name: string }[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: id,
  tag_ids: ids.map((x) => ({ ...x })),
  weight: 1,
  enabled: true,
  addedAt: 0,
  ...extra,
})

describe.concurrent('$modules/tag-rec/model/tag-status', () => {
  it('stable IDs isolate same-name groups; ambiguous legacy names cannot authorize writes', () => {
    const twins = [g('one', [], { name: '教程' }), g('two', [], { name: '教程' })]
    expect(resolveLandingGroups(twins, twins, ['教程'], ['two']).map((x) => x.id)).toEqual(['two'])
    expect(resolveLandingGroups(twins, twins, ['教程'])).toEqual([])
    expect(resolveLandingGroups(twins, twins, ['教程'], ['deleted'])).toEqual([])
    twins[1].name = '改名'
    expect(resolveLandingGroups(twins, twins, ['教程'], ['two']).map((x) => x.id)).toEqual(['two'])
  })
  // A: 正向 id1 'Foo Bar' + 负向 id7 'bad'; B: 正向 id2/id6 'shared' + 负向 id7; C: 正向 id8/id6 'shared'
  const groups = [
    g('A', [{ id: 1, name: 'Foo Bar' }], { negative_tag_ids: [{ id: 7, name: 'bad' }] }),
    g(
      'B',
      [
        { id: 2, name: 'baz' },
        { id: 6, name: 'shared' },
      ],
      { negative_tag_ids: [{ id: 7, name: 'bad' }] },
    ),
    g('C', [
      { id: 8, name: 'other' },
      { id: 6, name: 'shared' },
    ]),
  ]
  // tab2 草稿组伪组 (与弹层 DRAFT_GROUP_ID 同形): 只持负向位
  const draft = g('__draft__', [], { negative_tag_ids: [{ id: 5, name: 'dneg' }] })
  const universe = [...groups, draft]

  it('.classifyVideoTagStatus 落点集内负向 => 激活; 落点集外负向 => 不激活但进「他组」位 (票 19)', () => {
    // 组 A 语境: tag7 黑于 A(落点内) + B(落点外)
    const s = classifyVideoTagStatus({ id: 7, name: 'bad' }, [groups[0]], universe)
    expect(s.negative.map((x) => x.id)).toEqual(['A'])
    expect(s.negativeOutside.map((x) => x.id)).toEqual(['B'])
    // 组 C 语境: tag7 仅黑于他组 => 本语境视为未黑
    const s2 = classifyVideoTagStatus({ id: 7, name: 'bad' }, [groups[2]], universe)
    expect(s2.negative).toEqual([])
    expect(s2.negativeOutside.map((x) => x.id)).toEqual(['A', 'B'])
    // tag1 正向于 A: A 语境无负向态, 也无「负向·他组」
    const s3 = classifyVideoTagStatus({ id: 1, name: 'Foo Bar' }, [groups[0]], universe)
    expect(s3.negative).toEqual([])
    expect(s3.negativeOutside).toEqual([])
  })

  it('⛔ 二态翻转素材: 落点集内宿主枚举 = 解黑对象; 落点集内无黑 => 全加落点 (票 19 Q2-a)', () => {
    // 部分黑: 多归因卡落点 [A,C], tag7 仅黑于落点内 A => negative 枚举 [A] (一点清 A; B 落点外不动)
    const partial = classifyVideoTagStatus({ id: 7, name: 'bad' }, [groups[0], groups[2]], universe)
    expect(partial.negative.map((x) => x.id)).toEqual(['A'])
    // 落点集内全黑: 落点 [A,B] 皆黑 => 一击全解, 无「部分黑」稳态
    const all = classifyVideoTagStatus({ id: 7, name: 'bad' }, [groups[0], groups[1]], universe)
    expect(all.negative.map((x) => x.id)).toEqual(['A', 'B'])
    // 白: 落点集内零负向 => negative 空, 动作侧加全部落点
    const white = classifyVideoTagStatus({ id: 42, name: 'fresh' }, [groups[0], groups[1]], universe)
    expect(white.negative).toEqual([])
  })

  it('faved 落点集内/外分流 + 多宿主全枚举 (票 19: first-match => 复数版)', () => {
    // tag6 正向于 B、C 两组; scope=[B]: 内 [B], 外 [C]
    const s = classifyVideoTagStatus({ id: 6, name: 'shared' }, [groups[1]], universe)
    expect(s.faved.map((x) => x.id)).toEqual(['B'])
    expect(s.favedOutside.map((x) => x.id)).toEqual(['C'])
    // scope=[B,C]: 双宿主全在落点集内
    const s2 = classifyVideoTagStatus({ id: 6, name: 'shared' }, [groups[1], groups[2]], universe)
    expect(s2.faved.map((x) => x.id)).toEqual(['B', 'C'])
    expect(s2.favedOutside).toEqual([])
    // tag 仅在落点集外收藏: 本语境按未收藏渲染 (faved 空), 他组宿主仍只读可见
    const s3 = classifyVideoTagStatus({ id: 6, name: 'shared' }, [groups[0]], universe)
    expect(s3.faved).toEqual([])
    expect(s3.favedOutside.map((x) => x.id)).toEqual(['B', 'C'])
  })

  it('草稿组作落点 (tab2 输入语境): 草稿组负向激活, 收藏表宿主落「他组」', () => {
    const s = classifyVideoTagStatus({ id: 5, name: 'dneg' }, [draft], universe)
    expect(s.negative.map((x) => x.id)).toEqual(['__draft__'])
    expect(s.negativeOutside).toEqual([])
    // tag7 黑于收藏表 A/B: 草稿组语境下全是「他组」只读
    const s2 = classifyVideoTagStatus({ id: 7, name: 'bad' }, [draft], universe)
    expect(s2.negative).toEqual([])
    expect(s2.negativeOutside.map((x) => x.id)).toEqual(['A', 'B'])
  })

  it('变体判定限定落点集; 空落点集 (非 tag-rec 卡) 全不激活', () => {
    // 'foo  bar' 归一化同形于 A 内 id1 'Foo Bar' (不同 tag_id)
    const inScope = classifyVideoTagStatus({ id: 42, name: 'foo  bar' }, [groups[0]], universe)
    expect(inScope.variant).toMatchObject({ group: { id: 'A' }, entry: { id: 1 } })
    // A 不在落点集 => 变体不成立 (落点集外不产出 variant 位)
    const outScope = classifyVideoTagStatus({ id: 42, name: 'foo  bar' }, [groups[1]], universe)
    expect(outScope.variant).toBeUndefined()
    // 空落点集: 正/负宿主全降「他组」只读 (弹层 ⛔ 点击走 Modal 兜底)
    const none = classifyVideoTagStatus({ id: 1, name: 'Foo Bar' }, [], universe)
    expect(none).toMatchObject({ faved: [], favedOutside: [{ id: 'A' }], negative: [], negativeOutside: [] })
    const noneNeg = classifyVideoTagStatus({ id: 7, name: 'bad' }, [], universe)
    expect(noneNeg.negative).toEqual([])
    expect(noneNeg.negativeOutside.map((x) => x.id)).toEqual(['A', 'B'])
  })

  it('.classifyVideoTagStatus universe 缺省 = scope (单集语义同票 14 旧行为)', () => {
    const s = classifyVideoTagStatus({ id: 7, name: 'bad' }, groups)
    expect(s.negative.map((x) => x.id)).toEqual(['A', 'B'])
    expect(s.negativeOutside).toEqual([])
    const f = classifyVideoTagStatus({ id: 6, name: 'shared' }, groups)
    expect(f.faved.map((x) => x.id)).toEqual(['B', 'C'])
    // 同名同 id 不算变体 (faved 命中; 变体防御 e.id !== tag.id)
    const same = classifyVideoTagStatus({ id: 1, name: 'Foo Bar' }, groups)
    expect(same.faved.map((x) => x.id)).toEqual(['A'])
    expect(same.variant).toBeUndefined()
    // 无状态
    expect(classifyVideoTagStatus({ id: 99, name: 'zzz' }, groups)).toEqual({
      faved: [],
      favedOutside: [],
      negative: [],
      negativeOutside: [],
      variant: undefined,
    })
  })

  it('.resolveLandingGroups: 归因名解析落点组 + 未归属名挂草稿组伪组 (票 19)', () => {
    // 多归因 => 全部命中组
    expect(resolveLandingGroups(groups, universe, ['A', 'B']).map((x) => x.id)).toEqual(['A', 'B'])
    // 未归属名 + 草稿组伪组在列 => 落点含草稿组
    expect(resolveLandingGroups(groups, universe, ['zzz']).map((x) => x.id)).toEqual([DRAFT_GROUP_ID])
    expect(resolveLandingGroups(groups, universe, ['A', 'zzz']).map((x) => x.id)).toEqual(['A', DRAFT_GROUP_ID])
    // statusGroups 无草稿组伪组 => 未归属名无处可落
    expect(resolveLandingGroups(groups, groups, ['zzz'])).toEqual([])
    expect(resolveLandingGroups(groups, universe, [])).toEqual([])
  })

  it('.resolveLandingGroups: via 后缀归因名剥掉再按名查组 (票 20 顺带修; `A·相关` 兜底流旁路归因, 同 service attributionKey)', () => {
    // `A·相关` => 落点组 A (此前按原名查不到 => 误落草稿/Modal)
    expect(resolveLandingGroups(groups, universe, ['A·相关']).map((x) => x.id)).toEqual(['A'])
    // 剥离后仍不归属 => 挂草稿组 (同 negEntriesOf 未归属名回落草稿负向)
    expect(resolveLandingGroups(groups, universe, ['zzz·相关']).map((x) => x.id)).toEqual([DRAFT_GROUP_ID])
    // 混合: 裸名 + via 名 + 未归属名
    expect(resolveLandingGroups(groups, universe, ['A', 'B·相关', 'zzz']).map((x) => x.id)).toEqual([
      'A',
      'B',
      DRAFT_GROUP_ID,
    ])
    // 剥离后与裸名重复命中同组 => 只算一次 (set 语义)
    expect(resolveLandingGroups(groups, universe, ['A', 'A·相关']).map((x) => x.id)).toEqual(['A'])
  })

  it('.parseTagType 只收枚举值', () => {
    expect(parseTagType('topic')).toBe('topic')
    expect(parseTagType('old_channel')).toBe('old_channel')
    expect(parseTagType('bgm')).toBe('bgm')
    expect(parseTagType('channel')).toBeUndefined()
    expect(parseTagType(0)).toBeUndefined() // tag/info 数值 type 不映射
    expect(parseTagType(undefined)).toBeUndefined()
  })

  it('.videoTagToTagIdEntry opportunistic 带 tag_type', () => {
    expect(videoTagToTagIdEntry({ tag_id: 1, tag_name: 'a', tag_type: 'topic' })).toEqual({
      id: 1,
      name: 'a',
      tag_type: 'topic',
    })
    expect(videoTagToTagIdEntry({ tag_id: 2, tag_name: 'b' })).toEqual({ id: 2, name: 'b' })
    expect(videoTagToTagIdEntry({ tag_id: 3, tag_name: 'c', tag_type: '???' })).toEqual({ id: 3, name: 'c' })
  })
})
