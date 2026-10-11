import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { planTagRecRecall } from '../service/recall-plan'
import {
  addTagRecCondition,
  evalTagRecCombination,
  evalTagRecConditionAtom,
  excludeTagRecCondition,
  findTagRecCondition,
  isTagRecCombinationIntersection,
  mergeTagRecCombinationFilters,
  newTagRecCombination,
  prepareTagRecWorkingGroup,
  removeTagRecCondition,
  seedTagRecCombination,
  tagRecCombinationOverflows,
  tagRecCombinationSignature,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  validateTagRecCombination,
  type TagRecConditionGroup,
} from './combination'
import { makeTagGroup } from './favorites'
import { createTagRecFactoryFilterCore, createTagRecScopeResolver, evalTagRecItem } from './filter-engine'
import {
  favoritesToCsv,
  mergeTagRecConfigExports,
  parseTagRecConfig,
  planTagRecImport,
  serializeTagRecConfig,
} from './import-export'
import type { TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn() }))
const video = (fields: Partial<TagRecItemExtend> = {}): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'tag-rec:BV1',
  bvid: 'BV1',
  title: '三体 人物',
  pic: '',
  stat: {},
  partial: true,
  source: { via: 'all-v2-exact', groupNames: ['组'], groupIds: ['g'] },
  srcRank: 0,
  ...fields,
})
const twoTags = () => {
  const combo = newTagRecCombination()
  addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '程心' }))
  addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 2, name: '罗辑' }))
  return combo
}

describe('完整组合的可执行语义', () => {
  it('完整标签 ID 优先于同名标签，失效的目标组不会悄悄写入默认组', () => {
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '三体' }))
    expect(evalTagRecCombination(video({ ownTagIds: [9], ownTagNames: ['三体'] }), combo).state).toBe('mismatch')
    expect(addTagRecCondition(combo, tagRecConditionAtom('title', '人物'), 'removed-group')).toBe(false)
    expect(combo.include.children).toHaveLength(1)
  })
  it('同字段默认任一命中，跨字段相且，可切为全部并按命中数计相关性', () => {
    const combo = twoTags()
    expect(evalTagRecCombination(video({ ownTagIds: [1, 2] }), combo)).toMatchObject({ state: 'match', hits: 2 })
    expect(evalTagRecCombination(video({ ownTagIds: [1] }), combo).state).toBe('match')
    addTagRecCondition(combo, tagRecConditionAtom('up', { name: '读书UP', mid: 11 }))
    expect(evalTagRecCombination(video({ ownTagIds: [1], owner: { name: '其他', mid: 12 } }), combo).state).toBe(
      'mismatch',
    )
    const row = combo.include.children.at(0)!
    if (row.kind === 'group') row.mode = 'all'
    expect(evalTagRecCombination(video({ ownTagIds: [1], owner: { name: '读书UP', mid: 11 } }), combo).state).toBe(
      'mismatch',
    )
  })
  it('完整空标签名单是未命中；缺名单、截断简介为未知；确切命中无需补全', () => {
    const combo = newTagRecCombination()
    excludeTagRecCondition(combo, tagRecConditionAtom('tag', { id: 2, name: '罗辑' }))
    expect(evalTagRecCombination(video(), combo).state).toBe('unknown')
    expect(evalTagRecCombination(video({ ownTagIds: [] }), combo).state).toBe('match')
    excludeTagRecCondition(combo, tagRecConditionAtom('desc', '动画'))
    expect(evalTagRecCombination(video({ ownTagIds: [], desc: '' }), combo).state).toBe('unknown')
    expect(
      evalTagRecCombination(video({ ownTagIds: [], desc: '', fieldEvidence: { desc: 'complete' } }), combo).state,
    ).toBe('match')
    expect(
      evalTagRecCombination(video({ ownTagIds: [], desc: '动画片段', fieldEvidence: { desc: 'partial' } }), combo)
        .state,
    ).toBe('mismatch')
  })
  it('新完整证据覆盖旧召回线索；同名标签、标题和 UP 身份独立', () => {
    const combo = twoTags()
    expect(
      evalTagRecCombination(
        video({ ownTagIds: [], source: { via: 'tag-top', groupNames: ['组'], tagIds: [1] } }),
        combo,
      ).state,
    ).toBe('mismatch')
    expect(tagRecConditionKey(tagRecConditionAtom('title', '程心'))).not.toBe(
      tagRecConditionKey(tagRecConditionAtom('tag', { name: '程心', id: 1 })),
    )
    expect(tagRecConditionKey(tagRecConditionAtom('up', { name: '同名', mid: 1 }))).not.toBe(
      tagRecConditionKey(tagRecConditionAtom('up', { name: '同名', mid: 2 })),
    )
  })
  it('定向重查只在 claims 记录标签证据时，tag 原子仍按 claim 的 tagIds 命中', () => {
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '三体' }))
    const rechecked = video({
      ownTagIds: undefined,
      source: { via: 'tag-top', groupNames: ['组'], claims: [{ via: 'tag-top', groupNames: ['组'], tagIds: [1] }] },
    })
    expect(evalTagRecCombination(rechecked, combo).state).toBe('match')
    const unrelated = video({
      ownTagIds: undefined,
      source: { via: 'tag-top', groupNames: ['组'], claims: [{ via: 'tag-top', groupNames: ['组'], tagIds: [9] }] },
    })
    expect(evalTagRecCombination(unrelated, combo).state).toBe('unknown')
  })
  it('复杂或条件可嵌套；未知分支不会否决已满足的任一分支', () => {
    const combo = twoTags()
    combo.include.mode = 'any'
    addTagRecCondition(combo, tagRecConditionAtom('desc', '宇宙'))
    expect(evalTagRecCombination(video({ ownTagIds: [1] }), combo).state).toBe('match')
    excludeTagRecCondition(combo, tagRecConditionAtom('partition', { name: '动画', v1: 1, level: 'parent' }))
    expect(evalTagRecCombination(video({ ownTagIds: [1] }), combo).state).toBe('unknown')
  })
  it('新建的空嵌套组不扩大 OR，填入条件才改变执行语义', () => {
    const combo = twoTags()
    combo.include.mode = 'any'
    const signature = tagRecCombinationSignature(combo)
    const empty = { kind: 'group' as const, id: 'editing', mode: 'all' as const, children: [] }
    combo.include.children.push(empty)
    expect(tagRecCombinationSignature(combo)).toBe(signature)
    expect(evalTagRecCombination(video({ ownTagIds: [] }), combo).state).toBe('mismatch')
    addTagRecCondition(combo, tagRecConditionAtom('title', '三体'), empty.id)
    expect(evalTagRecCombination(video({ ownTagIds: [] }), combo).state).toBe('match')
  })
  it('删条件只剪「被本次删空」的组, 用户建好的空落点组保留', () => {
    const combo = twoTags()
    const tagRow = combo.include.children.find(
      (child): child is TagRecConditionGroup => child.kind === 'group' && child.name === 'tag',
    )!
    combo.include.children.push({ kind: 'group', id: 'keep-empty', mode: 'any', name: '条件组', children: [] })
    removeTagRecCondition(combo, tagRow.children.at(0)!.id)
    expect(tagRecConditionAtoms(combo.include)).toHaveLength(1)
    expect(findTagRecCondition(combo.include, 'keep-empty')).toBeTruthy()
    removeTagRecCondition(combo, tagRow.children.at(0)!.id)
    expect(tagRecConditionAtoms(combo.include)).toHaveLength(0)
    expect(findTagRecCondition(combo.include, tagRow.id)).toBeUndefined()
    expect(findTagRecCondition(combo.include, 'keep-empty')).toBeTruthy()
  })
  it('交集判定: ≥2 个直属分支各需 tag 证据才成立, 单层计数不递归', () => {
    const tagAtom = (id: number, name: string) => tagRecConditionAtom('tag', { id, name })
    const group = (children: TagRecConditionGroup['children'], id = crypto.randomUUID()) => ({
      kind: 'group' as const,
      id,
      mode: 'any' as const,
      children,
    })
    const combo = twoTags() // 同字段自动归组 => 单 tag 分支
    expect(isTagRecCombinationIntersection(combo)).toBe(false)
    // 第二个 tag 分支 => 交集成立
    combo.include.children.push(group([tagAtom(3, 'cos')]))
    expect(isTagRecCombinationIntersection(combo)).toBe(true)
    combo.include.mode = 'any' // 根组任一命中 => 无交集压力
    expect(isTagRecCombinationIntersection(combo)).toBe(false)
    combo.include.mode = 'all'
    // tag 分支 + 标题词分支: 标题自证不需要 tag 证据 => 不交集
    const mixed = newTagRecCombination()
    addTagRecCondition(mixed, tagAtom(1, '至冬'))
    mixed.include.children.push(group([tagRecConditionAtom('title', 'cos')]))
    expect(isTagRecCombinationIntersection(mixed)).toBe(false)
    // 平铺 tag 原子直达根 = 各自独立分支
    const flat = newTagRecCombination()
    flat.include.children.push(tagAtom(1, 'a'), tagAtom(2, 'b'))
    expect(isTagRecCombinationIntersection(flat)).toBe(true)
    // 嵌套不展开: 分支内含 tag 的 any 子组按一分支计; 空组不算分支
    const nested = newTagRecCombination()
    addTagRecCondition(nested, tagAtom(1, 'x'))
    nested.include.children.push(group([group([tagAtom(2, 'y'), tagAtom(3, 'z')])])) // 一组里又套一tag组
    expect(isTagRecCombinationIntersection(nested)).toBe(true)
    nested.include.children.push(group([])) // 空编辑落点不构成第三个分支
    expect(isTagRecCombinationIntersection(nested)).toBe(true)
    // all 子组递归展开: 单个子组 all{a,b} 与两兄弟 tag 分支同语义 => 交集成立
    const allSub = newTagRecCombination()
    allSub.include.children.push({
      kind: 'group',
      id: 'sub',
      mode: 'all',
      children: [tagAtom(1, 'a'), tagAtom(2, 'b')],
    })
    expect(isTagRecCombinationIntersection(allSub)).toBe(true)
    // 混维不充数: all{tag, title} 只算一个 tag 分支
    const mixSub = newTagRecCombination()
    mixSub.include.children.push({
      kind: 'group',
      id: 'sub2',
      mode: 'all',
      children: [tagAtom(1, 'a'), tagRecConditionAtom('title', 'b')],
    })
    expect(isTagRecCombinationIntersection(mixSub)).toBe(false)
    // tagAllow「仅看标签」= 必过 tag 约束: 纯 tag 并集 + 组合内仅看 => 交集 ((a∨b)∧c)
    const allowCombo = newTagRecCombination()
    allowCombo.include.mode = 'any'
    addTagRecCondition(allowCombo, tagAtom(1, 'a'))
    addTagRecCondition(allowCombo, tagAtom(2, 'b'))
    expect(isTagRecCombinationIntersection(allowCombo)).toBe(false) // 纯并集 = 单 tag 约束
    allowCombo.filters = { dims: { tagAllow: { enabled: true, list: [{ id: 9, name: 'c' }] } } }
    expect(isTagRecCombinationIntersection(allowCombo)).toBe(true)
    // 生效链 tagAllow 走 extra 参数 (resolver 侧 neg.tagAllow) —— 与组合内同口径
    const pureAny = newTagRecCombination()
    pureAny.include.mode = 'any'
    addTagRecCondition(pureAny, tagAtom(1, 'a'))
    addTagRecCondition(pureAny, tagAtom(2, 'b'))
    expect(isTagRecCombinationIntersection(pureAny, true)).toBe(true)
    // 混维并集不吃: title 路径可零 tag 证据过关 => 树的 tag 证据分支为 0
    const mixedAny = newTagRecCombination()
    mixedAny.include.mode = 'any'
    addTagRecCondition(mixedAny, tagAtom(1, 'a'))
    addTagRecCondition(mixedAny, tagRecConditionAtom('title', 'x'))
    expect(isTagRecCombinationIntersection(mixedAny, true)).toBe(false)
  })
  it('显式过滤名单也按三态核实，关闭辅助过滤不解除组合的明确排除', () => {
    const combo = newTagRecCombination()
    combo.filters = { dims: { descKeywords: { enabled: true, list: ['动画'] } } }
    expect(evalTagRecCombination(video({ desc: '片段', fieldEvidence: { desc: 'partial' } }), combo).state).toBe(
      'unknown',
    )
    combo.filters.enabled = false
    excludeTagRecCondition(combo, tagRecConditionAtom('desc', '动画'))
    expect(evalTagRecCombination(video({ desc: '动画', fieldEvidence: { desc: 'complete' } }), combo).state).toBe(
      'mismatch',
    )
  })
  it('会话差分可解除收藏中的辅助名单，组合的明确排除仍由用户单独撤回', () => {
    const combo = twoTags()
    combo.filters = { dims: { titleAllow: { enabled: true, list: ['宇宙'] } } }
    const group = makeTagGroup({ id: 'g', name: '组', tag_ids: [], combination: combo })!
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    const resolve = createTagRecScopeResolver({
      core,
      groupsById: new Map([['g', group]]),
      sessionCore: { dims: { titleAllow: { enabled: false, list: [] } } },
    })
    expect(evalTagRecItem(video({ ownTagIds: [1] }), resolve).pass).toBe(true)
    excludeTagRecCondition(group.combination!, tagRecConditionAtom('title', '三体'))
    const afterExclude = createTagRecScopeResolver({
      core,
      groupsById: new Map([['g', group]]),
      sessionCore: { dims: { titleAllow: { enabled: false, list: [] } } },
    })
    expect(evalTagRecItem(video({ ownTagIds: [1] }), afterExclude).pass).toBe(false)
  })
  it('临时查看仅放未知，真实排除仍生效，过滤总开关关闭仍守组合', () => {
    const combo = twoTags()
    excludeTagRecCondition(combo, tagRecConditionAtom('desc', '动画'))
    const group = makeTagGroup({ id: 'g', name: '组', tag_ids: [], combination: combo })!
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    const resolve = (allowUnverified = false) =>
      createTagRecScopeResolver({ core, groupsById: new Map([['g', group]]), allowUnverified })
    expect(evalTagRecItem(video({ ownTagIds: [1] }), resolve()).pass).toBe(false)
    expect(evalTagRecItem(video({ ownTagIds: [1] }), resolve(true)).pass).toBe(true)
    expect(evalTagRecItem(video({ ownTagIds: [1], desc: '动画' }), resolve(true)).pass).toBe(false)
    expect(
      evalTagRecItem(
        video({ ownTagIds: [1] }),
        createTagRecScopeResolver({ core, globalExclusionsInvalid: true, allowUnverified: true }),
      ).pass,
    ).toBe(false)
  })
  it('搜索响应的完整标签名单直接判命中/不含，不再降级成未知', () => {
    const combo = twoTags()
    const row = combo.include.children.at(0)!
    if (row.kind === 'group') row.mode = 'all'
    const group = makeTagGroup({ id: 'g', name: '组', tag_ids: [], combination: combo })!
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    const resolve = (allowUnverified = false) =>
      createTagRecScopeResolver({ core, groupsById: new Map([['g', group]]), allowUnverified })
    // all/v2 自带的 tag 名单是完整名单: 罗辑不在名单 => 确认不满足, 不是「未知」再去补查
    const onlyChengxin = video({ ownTagNames: ['程心'] })
    expect(evalTagRecCombination(onlyChengxin, combo).state).toBe('mismatch')
    expect(evalTagRecItem(onlyChengxin, resolve(true)).pass).toBe(false)
    expect(evalTagRecCombination(video({ ownTagNames: ['程心', '罗辑'] }), combo).state).toBe('match')
    // tag/top 召回证据仍然有效, 即使名单里没有同名项
    const tagTopOnly = video({
      ownTagNames: ['别的'],
      source: { via: 'tag-top', groupNames: ['组'], groupIds: ['g'], tagIds: [1] },
    })
    expect(evalTagRecConditionAtom(tagTopOnly, tagRecConditionAtom('tag', { id: 1, name: '程心' })).state).toBe('match')
    expect(evalTagRecConditionAtom(tagTopOnly, tagRecConditionAtom('tag', { id: 2, name: '罗辑' })).state).toBe(
      'mismatch',
    )
    // 合并后的 tag/top 认领同样有效 (证据在 claims 而非顶层 source)
    const merged = video({
      ownTagNames: ['别的'],
      source: {
        via: 'all-v2-exact',
        groupNames: ['组'],
        groupIds: ['g'],
        claims: [{ via: 'tag-top', groupNames: ['组'], groupIds: ['g'], tagIds: [1] }],
      },
    })
    expect(evalTagRecConditionAtom(merged, tagRecConditionAtom('tag', { id: 1, name: '程心' })).state).toBe('match')
    // 非 tag/top 认领携带的 tagIds 不算召回证据 (衍生条剥除的强制层, 防未来产点污染)
    const derived = video({
      ownTagNames: ['别的'],
      source: {
        via: 'archive-related',
        groupNames: ['组·相关'],
        groupIds: ['g'],
        claims: [{ via: 'archive-related', groupNames: ['组'], groupIds: ['g'], tagIds: [1] }],
      },
    })
    expect(evalTagRecConditionAtom(derived, tagRecConditionAtom('tag', { id: 1, name: '程心' })).state).toBe('mismatch')
  })
  it('来源和单格稀疏覆盖逐字段继承，不凭空增加分数或来源键', () => {
    const patch = mergeTagRecCombinationFilters(
      { dims: {}, pools: { allV2: { smallPoolThreshold: 5, dims: { viewMin: { enabled: true, value: 30 } } } } },
      { dims: {}, pools: { allV2: { dims: { viewMax: { enabled: true, value: 100 } } } } },
    )!
    expect(patch.pools?.allV2).toEqual({
      smallPoolThreshold: 5,
      dims: { viewMin: { enabled: true, value: 30 }, viewMax: { enabled: true, value: 100 } },
    })
    expect(patch.score).toBeUndefined()
    expect(patch.poolsEnabled).toBeUndefined()
  })
  it('旧收藏的正负和仅看名单在副本中可编辑，原收藏不变', () => {
    const original = makeTagGroup({
      id: 'g',
      name: '组',
      tag_ids: [{ id: 1, name: '三体' }],
      negative_tag_ids: [{ id: 2, name: '动画' }],
      overrides: {
        negative: { upAllow: { enabled: true, list: [{ name: 'UP', mid: 11 }] } },
        dims: { viewMin: { enabled: true, value: 3 } },
      },
    })!
    const before = JSON.stringify(original)
    const working = prepareTagRecWorkingGroup(original)
    expect(working.combination?.exclude[0].field).toBe('tag')
    expect(working.combination?.filters?.dims.viewMin?.value).toBe(3)
    expect(working.overrides).toBeUndefined()
    expect(JSON.stringify(original)).toBe(before)
  })
  it('没有标签的 UP-only 组合可保存和召回，UID 是真实定向源而非标签', () => {
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('up', { name: 'UP', mid: 11 }))
    const group = makeTagGroup({ id: 'g', name: 'UP组', tag_ids: [], combination: combo })!
    expect(group.enabled).toBe(true)
    expect(group.tag_ids).toEqual([])
    const resolve = createTagRecScopeResolver({
      core: createTagRecFactoryFilterCore(),
      groupsById: new Map([['g', group]]),
    })
    const plan = planTagRecRecall({ roundSources: [], scopeConsumers: [{ key: { id: 'g' }, name: 'UP组' }] }, resolve)
    expect(plan.tagTop).toEqual([])
    expect(plan.dig).toEqual([])
    expect(plan.up).toMatchObject([{ mid: 11, keyword: '' }])
  })
  it('UP 与标签相且时按作者目录召回，不把标签名误当标题检索限制', () => {
    const combo = twoTags()
    addTagRecCondition(combo, tagRecConditionAtom('up', { name: 'UP', mid: 11 }))
    const group = makeTagGroup({ id: 'g', name: '组', tag_ids: [], combination: combo })!
    const resolve = createTagRecScopeResolver({
      core: createTagRecFactoryFilterCore(),
      groupsById: new Map([['g', group]]),
    })
    const plan = planTagRecRecall({ roundSources: [], scopeConsumers: [{ key: { id: 'g' }, name: '组' }] }, resolve)
    expect(plan.up).toMatchObject([{ mid: 11, keyword: '' }])
  })
  it('重复借用同一证据到不同分支不会虚增相关性', () => {
    const combo = twoTags()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '程心' }), combo.include.id)
    expect(evalTagRecCombination(video({ ownTagIds: [1] }), combo).hits).toBe(1)
  })
  it('v3 往返保留完整条件和全局排除；旧版格式及未知约束拒绝', () => {
    const combo = twoTags()
    combo.filters = { dims: { duration: { enabled: true, min: 20, max: 60 } }, poolsEnabled: { tagTop: false } }
    const group = makeTagGroup({ id: 'g', name: '组', tag_ids: [], combination: combo })!
    const global = tagRecConditionAtom('up', { name: 'UP', mid: 11 })
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [group],
      blacklist: [],
      combinationExclusions: [global],
      filterConfig: { ...createTagRecFactoryFilterCore(), activePreset: '', presets: [] },
    })
    expect(data.version).toBe(3)
    const parsed = parseTagRecConfig(JSON.stringify(data))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [], l1: [] })
      expect(tagRecCombinationSignature(plan.favoritesToAdd[0].combination!)).toBe(tagRecCombinationSignature(combo))
      expect(plan.combinationExclusionsToAdd).toEqual([global])
    }
    expect(parseTagRecConfig(JSON.stringify({ ...data, version: 2 })).ok).toBe(false)
    expect(favoritesToCsv.bind(null, [group])).toThrow('JSON')
    const other = structuredClone(data)
    other.favorites[0].combination!.include.mode = 'all'
    const row = other.favorites[0].combination!.include.children.at(0)!
    if (row.kind === 'group') row.mode = 'all'
    expect(mergeTagRecConfigExports([data, other]).favorites).toHaveLength(2)
    expect(validateTagRecCombination({ ...combo, filters: { dims: { mystery: { enabled: true, value: 1 } } } })).toBe(
      false,
    )
    expect(validateTagRecCombination({ ...combo, include: { ...combo.include, mode: 'xor' } })).toBe(false)
  })
})

describe('节点预算按节点计不按原子计 (审计 U07)', () => {
  const atom = (id: number) => tagRecConditionAtom('tag', { id, name: `t${id}` })
  const comboAtNodes = (n: number) => {
    const combo = newTagRecCombination()
    // 根下裸原子: root(1) + n-1 个原子 = n 节点; 根下无 field 行组 → 下个原子须新建行组
    for (let i = 0; i < n - 1; i++) combo.include.children.push(atom(i + 1))
    return combo
  }
  it('127 节点时新建行组的原子须拒 (+2=129 超限),落既有行组可达 128 边界', () => {
    const combo = comboAtNodes(127)
    expect(addTagRecCondition(combo, tagRecConditionAtom('title', '新词'))).toBe(false)
    expect(validateTagRecCombination(combo)).toBe(true) // 失败不修改原对象
    const combo2 = comboAtNodes(127)
    // 先建一个 title 行组里的原子 → 第二个 title 原子落既有行组 (+1=128 恰好)
    expect(addTagRecCondition(combo2, tagRecConditionAtom('title', '词a'))).toBe(false) // 127+2=129 仍拒
    const combo3 = comboAtNodes(126)
    expect(addTagRecCondition(combo3, tagRecConditionAtom('title', '词a'))).toBe(true) // 126+2=128 边界放行
    expect(validateTagRecCombination(combo3)).toBe(true)
    // 已有 title 行组后再加一个 → +1 → 129 → 拒
    expect(addTagRecCondition(combo3, tagRecConditionAtom('title', '词b'))).toBe(false)
  })
  it('嫁接按节点数计: 组壳+成员全计入预算', async () => {
    const { graftTagRecConditionTree } = await import('./combination')
    const combo = comboAtNodes(126)
    const tree: TagRecConditionGroup = {
      kind: 'group',
      id: 'donor',
      mode: 'any',
      children: [tagRecConditionAtom('tag', { id: 91, name: 'x' }), tagRecConditionAtom('tag', { id: 92, name: 'y' })],
    }
    // 组树 3 节点 (壳+2原子): 126+3=129 须拒 (旧口径只数 2 原子会放行出 129 节点)
    expect(graftTagRecConditionTree(combo, tree)).toBe(false)
    const combo2 = comboAtNodes(125)
    expect(graftTagRecConditionTree(combo2, tree)).toBe(true) // 125+3=128 边界放行
    expect(validateTagRecCombination(combo2)).toBe(true)
  })
  it('播种 all-or-nothing: 126 个扁平 tag 全落 (root+行组+126=128), 127 个返回 false', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `t${i}` }))
    const combo = newTagRecCombination()
    expect(seedTagRecCombination(combo, tags(126))).toBe(true)
    expect(validateTagRecCombination(combo)).toBe(true)
    expect(tagRecConditionAtoms(combo.include).filter((a) => a.field === 'tag')).toHaveLength(126)
    // 127 个须整体判失败 —— 静默截断会让调用侧按截断投影重导 tag_ids 丢成员
    expect(seedTagRecCombination(newTagRecCombination(), tags(127))).toBe(false)
  })
  it('tagRecCombinationOverflows 只对「无组合且超预算」的扁平组为真', () => {
    const flat = (n: number) =>
      makeTagGroup({ id: 'g', tag_ids: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `t${i}` })) })!
    expect(tagRecCombinationOverflows(flat(126))).toBe(false)
    expect(tagRecCombinationOverflows(flat(127))).toBe(true)
    // 已带组合的组不走播种 (组合即权威), 永不判溢出
    expect(tagRecCombinationOverflows({ ...flat(127), combination: newTagRecCombination() })).toBe(false)
  })
})
