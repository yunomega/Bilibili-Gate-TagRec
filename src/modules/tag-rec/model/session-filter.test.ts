import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { makeTagGroup, makeTagL1Group } from './favorites'
import {
  computeScore,
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  resolveTagRecEffective,
  resolveTagRecItemScoreParams,
  type TagRecSessionFilterPatch,
} from './filter-engine'
import {
  createTagRecSessionFilterBase,
  diffTagRecSessionFilter,
  materializeTagRecSessionFilter,
} from './session-filter'
import type { TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const context = () => {
  const core = createTagRecFactoryFilterCore()
  const l1 = makeTagL1Group({
    name: '父组',
    overrides: {
      dims: { viewMin: { enabled: true, value: 300 } },
      score: { weights: { favRate: 7 } },
      smallPoolThreshold: 11,
      poolsEnabled: { allV2: false },
    },
  })!
  const group = makeTagGroup({
    name: '组',
    tag_ids: [{ id: 1, name: 'x' }],
    l1Id: l1.id,
    overrides: {
      dims: { duration: { enabled: true, min: 90, max: 0 } },
      score: { anchors: { viewLog10: 4 } },
      pools: { tagTop: { dims: { likeMin: { enabled: true, value: 12 } } } },
      negative: {
        up: [{ name: '组屏蔽' }],
        title: ['组屏蔽词'],
        upAllow: { enabled: true, list: [{ name: '组UP' }] },
        titleAllow: { enabled: true, list: ['组标题'] },
        descAllow: { enabled: true, list: ['组简介'] },
        partitionAllow: { enabled: true, list: [{ name: '组分区', v2: 17 }] },
        tagAllow: { enabled: true, strict: true, list: [{ id: 3, name: '组标签' }] },
      },
    },
  })!
  return { core, l1, group }
}

describe('本次过滤的字段差分与继承', () => {
  it('一条临时屏蔽不会遮蔽组、一级组、格的阈值、评分、小池阈值和来源开关', () => {
    const { core, group, l1 } = context()
    const patch: TagRecSessionFilterPatch = { dims: { titleKeywords: { enabled: true, list: ['临时广告'] } } }
    const eff = resolveTagRecEffective(core, 'tagTop', group, l1, patch)
    expect(eff.cfg.dims.viewMin.value).toBe(300)
    expect(eff.cfg.dims.duration.min).toBe(90)
    expect(eff.cfg.dims.likeMin.value).toBe(12)
    expect(eff.cfg.score.weights.favRate).toBe(7)
    expect(eff.cfg.score.anchors.viewLog10).toBe(4)
    expect(eff.cfg.smallPoolThreshold).toBe(11)
    expect(eff.poolsEnabled.allV2).toBe(false)
    expect(eff.neg.up.map((x) => x.v.name)).toEqual(['组屏蔽'])
    expect(eff.neg.title.map((x) => x.v)).toEqual(['临时广告', '组屏蔽词'])
    expect(eff.neg.titleAllow?.list).toEqual(['组标题'])
  })

  it('未修改的字段持续继承新的全局和组配置，而声明字段保持本次值', () => {
    const { core, group, l1 } = context()
    const patch: TagRecSessionFilterPatch = {
      dims: { viewMax: { enabled: true, value: 1000 } },
      score: { weights: { view: 1 } },
    }
    l1.overrides!.dims!.viewMin!.value = 500
    core.score.weights.likeRate = 9
    group.overrides!.score!.anchors!.viewLog10 = 6
    const { cfg } = resolveTagRecEffective(core, 'tagTop', group, l1, patch)
    expect(cfg.dims.viewMin.value).toBe(500)
    expect(cfg.dims.viewMax.value).toBe(1000)
    expect(cfg.score.weights.likeRate).toBe(9)
    expect(cfg.score.weights.view).toBe(1)
    expect(cfg.score.anchors.viewLog10).toBe(6)
  })

  const allows = [
    { key: 'upAllow', rule: { enabled: true, list: [{ name: '临时UP' }] } },
    { key: 'titleAllow', rule: { enabled: true, list: ['临时标题'] } },
    { key: 'descAllow', rule: { enabled: true, list: ['临时简介'] } },
    { key: 'partitionAllow', rule: { enabled: true, list: [{ name: '临时分区', v2: 4 }] } },
    { key: 'tagAllow', rule: { enabled: true, strict: false, list: [{ id: 9, name: '临时标签' }] } },
  ] as const

  it.each(allows)('$key 本次仅看优先于组，并保留组屏蔽', ({ key, rule }) => {
    const { core, group, l1 } = context()
    const patch: TagRecSessionFilterPatch = { dims: { [key]: structuredClone(rule) } }
    const eff = resolveTagRecEffective(core, 'tagTop', group, l1, patch)
    expect(eff.neg[key]?.list).toEqual(rule.list)
    expect(eff.neg[key]?.scope).toBe('会话')
    expect(eff.neg.title.map((x) => x.v)).toContain('组屏蔽词')
  })

  it.each(allows)('$key 明确关闭或清空可以解除下层仅看，删掉声明则恢复继承', ({ key, rule }) => {
    const { core, group, l1 } = context()
    const disabled: TagRecSessionFilterPatch = { dims: { [key]: { ...structuredClone(rule), enabled: false } } }
    const empty: TagRecSessionFilterPatch = { dims: { [key]: { ...structuredClone(rule), list: [] } } }
    expect(resolveTagRecEffective(core, 'tagTop', group, l1, disabled).neg[key]).toBeUndefined()
    expect(resolveTagRecEffective(core, 'tagTop', group, l1, empty).neg[key]).toBeUndefined()
    expect(resolveTagRecEffective(core, 'tagTop', group, l1, { dims: {} }).neg[key]?.scope).toBe('组')
  })

  it('表单显示选定组的仅看与参数；一次编辑只提交改过的维度和评分字段', () => {
    const { core, group, l1 } = context()
    const base = createTagRecSessionFilterBase(core, group, l1)
    expect(base.dims.titleAllow.list).toEqual(['组标题'])
    expect(base.dims.viewMin.value).toBe(300)
    expect(diffTagRecSessionFilter(base, base)).toBeUndefined()
    const next = materializeTagRecSessionFilter(base)
    next.dims.titleAllow.enabled = false
    next.score.weights.view = 2
    next.poolsEnabled!.allV2 = true
    expect(diffTagRecSessionFilter(next, base)).toEqual({
      dims: { titleAllow: { enabled: false, list: ['组标题'] } },
      score: { weights: { view: 2 } },
      poolsEnabled: { allV2: true },
    })
    next.dims.titleAllow = structuredClone(base.dims.titleAllow)
    next.score.weights.view = base.score.weights.view
    next.poolsEnabled!.allV2 = false
    expect(diffTagRecSessionFilter(next, base)).toBeUndefined()
  })

  it('池临时差分比本次整档优先，只改变声明池，其余格和评分继续继承', () => {
    const { core, group, l1 } = context()
    const patch: TagRecSessionFilterPatch = {
      dims: { viewMin: { enabled: true, value: 600 } },
      score: { weights: { view: 2 } },
      pools: { allV2: { dims: { viewMin: { enabled: true, value: 20 } }, score: { weights: { view: 3 } } } },
      poolsEnabled: { allV2: true },
    }
    const tag = resolveTagRecEffective(core, 'tagTop', group, l1, patch)
    const search = resolveTagRecEffective(core, 'allV2', group, l1, patch)
    expect(tag.cfg.dims.viewMin.value).toBe(600)
    expect(tag.cfg.dims.likeMin.value).toBe(12)
    expect(tag.cfg.score.weights.view).toBe(2)
    expect(search.cfg.dims.viewMin.value).toBe(20)
    expect(search.cfg.score.weights.view).toBe(3)
    expect(search.cfg.score.weights.favRate).toBe(7)
    expect(search.poolsEnabled.allV2).toBe(true)
  })

  it('兜底算分与主流程使用同一组归因链和本次差分', () => {
    const { core, group, l1 } = context()
    const patch: TagRecSessionFilterPatch = { dims: {}, score: { weights: { view: 2 } } }
    const resolve = createTagRecScopeResolver({
      core,
      sessionCore: patch,
      groupsById: new Map([[group.id, group]]),
      l1ById: new Map([[l1.id, l1]]),
    })
    const video: TagRecItemExtend = {
      api: EApiType.TagRec,
      uniqId: 'v',
      bvid: 'v',
      title: '',
      pic: '',
      stat: { view: 5000, favorite: 100, like: 300, coin: 5, danmaku: 10, reply: 5 },
      source: { via: 'tag-top', groupIds: [group.id], groupNames: [group.name] },
    }
    const params = resolveTagRecItemScoreParams(video, resolve)
    expect(params.weights.view).toBe(2)
    expect(params.weights.favRate).toBe(7)
    expect(computeScore(video, params)).toEqual(computeScore(video, resolve({ id: group.id }, 'tagTop').cfg.score))
  })
})
