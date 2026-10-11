import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { makeTagGroup } from './favorites'
import {
  applyTagRecScopeEntriesToGroupOverrides,
  assignTagRecFilterCore,
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  evalTagRecItem,
  evalTagRecTagList,
  mergeTagRecNegativeRules,
  normalizeTagRecNegativeDraft,
  runTagRecFilter,
} from './filter-engine'
import {
  normalizeTagRecFilterSettings,
  parseTagRecConfig,
  serializeTagRecConfig,
  validateTagRecFilterSettings,
} from './import-export'
import type { TagRecItemExtend } from '$define'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const tag = { id: 7, name: 'AI 漫剧' }
const video = (ownTagNames?: string[]): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'tag-rec:BV1',
  bvid: 'BV1',
  title: '标题出现AI漫剧',
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['查询组'] },
  ownTagNames,
})
const core = () => {
  const c = createTagRecFactoryFilterCore()
  c.dims.likeRate.enabled = false
  return c
}

describe('自由解析标签过滤', () => {
  it('整名归一匹配, 多个仅看标签取 OR, 不用标题或查询来源冒充视频标签', () => {
    const cfg = core()
    cfg.dims.tagAllow = { enabled: true, list: [tag, { id: 8, name: '原神' }] }
    const resolve = createTagRecScopeResolver({ core: cfg })
    expect(evalTagRecItem(video(['ＡＩ漫剧']), resolve).pass).toBe(true)
    expect(evalTagRecItem(video(['原神']), resolve).pass).toBe(true)
    expect(evalTagRecItem(video(['AI漫剧完结']), resolve).drop?.dim).toBe('tagAllow')
    expect(evalTagRecItem(video(['其他标签']), resolve).pass).toBe(false)
    expect(evalTagRecItem(video([]), resolve).pass).toBe(false)
    expect(evalTagRecTagList({ ...video(), ownTagIds: [7] }, [tag], 'allow')).toBe('pass')
  })

  it('屏蔽先于仅看; 选定组、草稿兜底的负向仍参与过滤', () => {
    const cfg = core()
    cfg.dims.tagBlock = { enabled: true, list: [tag] }
    cfg.dims.tagAllow = { enabled: true, list: [tag] }
    expect(evalTagRecItem(video([tag.name]), createTagRecScopeResolver({ core: cfg })).drop).toEqual({
      dim: 'tagBlock',
      scope: '全局',
    })
    const group = makeTagGroup({ name: '查询组', tag_ids: [{ id: 1, name: '查询标签' }], negative_tag_ids: [tag] })!
    cfg.dims.tagBlock.enabled = false
    const selected = createTagRecScopeResolver({ core: cfg, groupsByName: new Map([[group.name, group]]) })
    const draft = createTagRecScopeResolver({ core: cfg, fallbackGroup: group })
    expect(evalTagRecItem(video([tag.name]), selected).drop?.dim).toBe('blacklist')
    expect(evalTagRecItem(video([tag.name]), draft).drop?.dim).toBe('blacklist')
  })

  it('会话名单替换全局整档名单, 不受查询组正向成员限制', () => {
    const global = core()
    global.dims.tagAllow = { enabled: true, list: [{ id: 1, name: '全局标签' }] }
    const session = core()
    session.dims.tagAllow = { enabled: true, list: [tag] }
    const group = makeTagGroup({ name: '查询组', tag_ids: [{ id: 9, name: '原神' }] })!
    const resolve = createTagRecScopeResolver({
      core: global,
      sessionCore: session,
      groupsByName: new Map([[group.name, group]]),
    })
    expect(evalTagRecItem(video([tag.name]), resolve).pass).toBe(true)
    expect(evalTagRecItem(video(['原神']), resolve).drop).toEqual({ dim: 'tagAllow', scope: '会话' })
    expect(group.tag_ids).toEqual([{ id: 9, name: '原神' }])
  })

  it('浅池命中是正证据, 未命中未知; 严格标签缺字段留到切片补查', () => {
    const cfg = core()
    cfg.dims.tagBlock = { enabled: true, strict: true, list: [tag] }
    cfg.strictMode = true
    const resolve = createTagRecScopeResolver({ core: cfg })
    const pools = new Map([[tag.id, new Set(['BV1'])]])
    expect(runTagRecFilter([video()], { resolve, pools }).stats.byDim.tagBlock).toBe(1)
    expect(runTagRecFilter([video()], { resolve, pools: new Map() }).items).toHaveLength(1)
    expect(evalTagRecTagList(video(), [tag], 'allow', new Map())).toBe('miss')
    expect(evalTagRecTagList(video(), [tag], 'allow', pools)).toBe('pass')
  })

  it('关闭/空名单不约束; 小池降级不放宽标签名单', () => {
    const cfg = core()
    cfg.strictMode = true
    cfg.dims.tagAllow = { enabled: true, strict: true, list: [] }
    const resolve = createTagRecScopeResolver({ core: cfg })
    expect(evalTagRecItem(video(), resolve).pass).toBe(true)
    cfg.dims.tagAllow.list = [tag]
    expect(
      runTagRecFilter([video(['其他'])], { resolve: createTagRecScopeResolver({ core: cfg }), poolSize: 1 }).stats.byDim
        .tagAllow,
    ).toBe(1)
    cfg.enabled = false
    expect(evalTagRecItem(video([]), createTagRecScopeResolver({ core: cfg })).pass).toBe(true)
  })

  it('旧预设补空名单, 新名单和严格开关可往返, 畸形条目拒绝', () => {
    const legacy = core()
    delete (legacy.dims as Partial<typeof legacy.dims>).tagBlock
    delete (legacy.dims as Partial<typeof legacy.dims>).tagAllow
    const dst = core()
    assignTagRecFilterCore(dst, legacy)
    expect(dst.dims.tagAllow).toEqual({ enabled: false, list: [], strict: false })
    const saved = { ...core(), activePreset: '自定义', presets: [{ name: '旧预设', config: legacy }] }
    saved.dims.tagAllow = { enabled: true, strict: true, list: [tag, tag] }
    const serialized = JSON.stringify(saved)
    const normalized = normalizeTagRecFilterSettings(JSON.parse(serialized))!
    expect(normalized.dims.tagAllow).toEqual({ enabled: true, strict: true, list: [tag] })
    expect(normalized.presets[0].config.dims.tagBlock.enabled).toBe(false)
    expect(validateTagRecFilterSettings(normalized)).toBe(true)
    expect(
      normalizeTagRecFilterSettings({
        ...saved,
        dims: { ...saved.dims, tagAllow: { enabled: true, list: [{ id: 0, name: '坏数据' }] } },
      }),
    ).toBeUndefined()
    expect(
      normalizeTagRecFilterSettings({
        ...saved,
        dims: { ...saved.dims, tagAllow: { enabled: true, strict: 'true', list: [tag] } },
      }),
    ).toBeUndefined()
  })

  it('组/L1 屏蔽叠加; 仅看按会话 > L2 > L1 > 全局选最近开启非空名单', () => {
    const global = core()
    global.dims.tagAllow = { enabled: true, list: [{ id: 1, name: '全局标签' }] }
    global.dims.tagBlock = { enabled: true, list: [{ id: 2, name: '全局屏蔽' }] }
    const l1 = {
      id: 'l1',
      name: '一级',
      enabled: true,
      weight: 1,
      addedAt: 1,
      overrides: {
        negative: {
          tagBlock: { enabled: true, list: [{ id: 3, name: '一级屏蔽' }] },
          tagAllow: { enabled: true, list: [{ id: 4, name: '一级仅看' }] },
        },
      },
    }
    const group = makeTagGroup({ name: '查询组', tag_ids: [{ id: 9, name: '查询标签' }] })!
    group.l1Id = l1.id
    group.overrides = {
      negative: {
        tagBlock: { enabled: true, list: [{ id: 5, name: '二级屏蔽' }] },
        tagAllow: { enabled: true, list: [tag] },
      },
    }
    const resolver = (sessionCore?: ReturnType<typeof core>) =>
      createTagRecScopeResolver({
        core: global,
        sessionCore,
        groupsByName: new Map([[group.name, group]]),
        l1ById: new Map([[l1.id, l1]]),
      })
    expect(evalTagRecItem(video([tag.name]), resolver()).pass).toBe(true)
    expect(evalTagRecItem(video(['一级仅看']), resolver()).drop).toEqual({ dim: 'tagAllow', scope: '查询组' })
    for (const [name, scope] of [
      ['全局屏蔽', '全局'],
      ['一级屏蔽', '一级'],
      ['二级屏蔽', '查询组'],
    ]) {
      expect(evalTagRecItem(video([tag.name, name]), resolver()).drop).toEqual({ dim: 'tagBlock', scope })
    }
    group.overrides.negative!.tagAllow!.enabled = false
    expect(evalTagRecItem(video(['一级仅看']), resolver()).pass).toBe(true)
    group.overrides.negative!.tagAllow!.enabled = true
    group.overrides.negative!.tagAllow!.list = []
    expect(evalTagRecItem(video(['一级仅看']), resolver()).pass).toBe(true)
    const session = core()
    session.dims.tagAllow = { enabled: true, strict: true, list: [{ id: 6, name: '会话仅看' }] }
    expect(evalTagRecItem(video(['一级仅看']), resolver(session)).drop).toEqual({ dim: 'tagAllow', scope: '会话' })
    expect(evalTagRecItem(video(['会话仅看', '二级屏蔽']), resolver(session)).drop).toEqual({
      dim: 'tagBlock',
      scope: '查询组',
    })
  })

  it('关闭严格时缺标签不会被数值维严格模式误杀; 组关闸保留名单, 清本层回继承', () => {
    const cfg = core()
    cfg.strictMode = true
    cfg.dims.tagAllow = { enabled: true, strict: false, list: [tag] }
    expect(evalTagRecItem(video(), createTagRecScopeResolver({ core: cfg })).pass).toBe(true)
    const rule = { enabled: false, strict: true, list: [tag, tag] }
    const negative = normalizeTagRecNegativeDraft({ tagAllow: rule })!
    expect(negative.tagAllow).toEqual({ ...rule, list: [tag] })
    expect(
      mergeTagRecNegativeRules(negative, { tagAllow: { enabled: true, list: [{ id: 8, name: '另一个标签' }] } })
        ?.tagAllow,
    ).toEqual({ enabled: true, strict: true, list: [tag, { id: 8, name: '另一个标签' }] })
    expect(applyTagRecScopeEntriesToGroupOverrides({ negative }, [{ key: 'group' }])).toBeUndefined()
  })

  it('大名单在同一解析器内只建立一次索引, 多组多池逐视频匹配不重复扫描名单', () => {
    let reads = 0
    const cfg = core()
    cfg.dims.tagAllow = {
      enabled: true,
      list: Array.from({ length: 10_000 }, (_, i) => ({
        id: i + 1,
        get name() {
          reads++
          return `标签${i + 1}`
        },
      })),
    }
    const a = makeTagGroup({ name: '组A', tag_ids: [{ id: 1, name: 'A' }] })!
    const b = makeTagGroup({ name: '组B', tag_ids: [{ id: 2, name: 'B' }] })!
    const resolve = createTagRecScopeResolver({
      core: cfg,
      groupsByName: new Map([
        [a.name, a],
        [b.name, b],
      ]),
    })
    for (const group of [a, b])
      for (const via of ['tag-top', 'all-v2-exact', 'all-v2-related', 'archive-related'] as const) {
        for (let i = 0; i < 10; i++)
          expect(
            evalTagRecItem({ ...video(['标签9999']), source: { via, groupNames: [group.name] } }, resolve).pass,
          ).toBe(true)
      }
    expect(reads).toBe(10_000)
  })

  it('组和一级标签名单 JSON 往返, 导入拒绝畸形开关/成员', () => {
    const group = makeTagGroup({ name: '查询组', tag_ids: [{ id: 9, name: '查询标签' }] })!
    group.overrides = {
      negative: {
        tagAllow: { enabled: true, strict: true, list: [tag] },
        tagBlock: { enabled: false, strict: false, list: [{ id: 8, name: '屏蔽' }] },
      },
    }
    const l1 = { id: 'l1', name: '一级', enabled: true, weight: 1, addedAt: 1, overrides: group.overrides }
    group.l1Id = l1.id
    const exported = serializeTagRecConfig({
      favorites: [group],
      l1: [l1],
      blacklist: [],
      filterConfig: { ...core(), activePreset: '自定义', presets: [] },
    })
    const parsed = parseTagRecConfig(JSON.stringify(exported))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.data.favorites[0].overrides?.negative).toEqual(group.overrides.negative)
      expect(parsed.data.l1?.[0].overrides?.negative).toEqual(l1.overrides.negative)
    }
    for (const invalid of [
      { enabled: true, strict: 'true', list: [tag] },
      { enabled: true, list: [{ id: 0, name: '坏标签' }] },
    ]) {
      const broken = { ...exported, favorites: [{ ...group, overrides: { negative: { tagAllow: invalid } } }] }
      expect(parseTagRecConfig(JSON.stringify(broken)).ok).toBe(false)
    }
  })
})
