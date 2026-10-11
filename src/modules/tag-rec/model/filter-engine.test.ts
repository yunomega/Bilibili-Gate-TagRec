import { proxy } from 'valtio'
import { describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  mergeTagRecCombinationFilters,
  newTagRecCombination,
  tagRecConditionAtom,
} from './combination'
import { makeTagGroup, makeTagL1Group } from './favorites'
import {
  applyDiversityGuard,
  applyTagRecPreset,
  applyTagRecPresetToCore,
  applyTagRecScopeEntriesToGroupOverrides,
  applyTagRecScopeEntriesToL1Overrides,
  assignTagRecFilterCore,
  cloneTagRecFilterCore,
  coerceTagRecNegativeShapes,
  computeScore,
  computeTagRecFilterSignature,
  createTagRecBuiltinPresets,
  createTagRecFactoryFilterCore,
  createTagRecScopeResolver,
  diffTagRecScopeOverride,
  evalTagRecItem,
  groupNegativeMerged,
  hasTagRecGroupConfig,
  isTagRecSmallPoolDegraded,
  mergeTagRecNegativeRules,
  mergeTagRecScopeOverrideForImport,
  migrateLegacyPartitionId,
  normalizeTagRecNegativeDraft,
  poolOfVia,
  removeTagRecPreset,
  renameTagRecPreset,
  resolvePoolScoreParams,
  resolveTagRecEffective,
  resolveTagRecEffectiveProvenance,
  restoreTagRecBuiltinPreset,
  runTagRecFilter,
  runTagRecScoreStage,
  sortTagRecItems,
  upsertTagRecPreset,
  type TagRecFilterCore,
  type TagRecFilterCtx,
  type TagRecFilterSettings,
  type TagRecGroupOverrides,
  type TagRecL1Overrides,
  type TagRecScoreParams,
} from './filter-engine'
import type { TagRecItemExtend } from '$define'
import type { TagGroup, TagIdEntry } from './types'

// filter-engine -> _pipeline -> endpoints/$common 触浏览器环境; 纯函数测试以 mock 隔掉 (同 _pipeline.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const item = (
  bvid: string,
  stat: TagRecItemExtend['stat'] = {},
  extra: Partial<TagRecItemExtend> = {},
): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: `tag-rec:${bvid}`,
  bvid,
  title: bvid,
  pic: '',
  stat,
  source: { via: 'tag-top', groupNames: ['组A'] },
  ...extra,
})

/** 全维关闭底配置 (总开关开): 逐维测试时按需开 */
const baseCfg = (): TagRecFilterCore => {
  const c = createTagRecFactoryFilterCore()
  c.dims.likeRate.enabled = false
  return c
}

const fullStat = { view: 1000, like: 60, favorite: 60, coin: 30, danmaku: 10, reply: 20, share: 5 }
const scoreParams: TagRecScoreParams = {
  weights: { view: 0.25, likeRate: 0.3, favRate: 0.2, coinRate: 0.15, interactRate: 0.1 },
  anchors: { viewLog10: 7, likeRate: 0.12, favRate: 0.06, coinRate: 0.03, interactRate: 0.03 },
}

// #region 测试适配器 (旧扁平调用 => 新生效链 API)
type LegacyNegCtx = {
  entriesOf?: (x: TagRecItemExtend) => TagIdEntry[]
  pools?: ReadonlyMap<number, ReadonlySet<string>>
  strict?: boolean
}
type LegacyCtx = Omit<TagRecFilterCtx, 'negative'> & { negative?: LegacyNegCtx }

/** 负向条目集 => 合成 TagGroup (overrides.negative 承载) */
const groupWithNeg = (name: string, entries: readonly TagIdEntry[], strict = false): TagGroup =>
  makeTagGroup({
    name,
    tag_ids: [{ id: 1, name: 'pos' }],
    overrides: { negative: { tagIds: [...entries], strict: strict || undefined } },
  })!

/** 条目名单 => 名=>组 映射 (同名组并集负向, 与组级名单语义一致) */
const groupsFromItems = (items: readonly TagRecItemExtend[], neg?: LegacyNegCtx): Map<string, TagGroup> => {
  const map = new Map<string, TagGroup>()
  if (!neg?.entriesOf) return map
  for (const it of items) {
    const entries = neg.entriesOf(it)
    if (!entries.length) continue
    for (const n of it.source.groupNames) {
      const prev = map.get(n)
      const merged = [...(prev?.overrides?.negative?.tagIds ?? []), ...entries]
      const seen = new Set<number>()
      const dedup = merged.filter((e) => !seen.has(e.id) && (seen.add(e.id), true))
      map.set(n, groupWithNeg(n, dedup, neg.strict))
    }
  }
  return map
}

/** 单条评估: 旧 evalFilterDims 等价物 —— 返回 {pass, dropCounts} (首失败维记 1) */
const evalDims = (
  it: TagRecItemExtend,
  cfg: TagRecFilterCore,
  ctx: LegacyCtx = {},
): { pass: boolean; dropCounts: Record<string, number> } => {
  const groupsByName = groupsFromItems([it], ctx.negative)
  const resolve = createTagRecScopeResolver({ core: cfg, groupsByName })
  const r = evalTagRecItem(it, resolve, {
    poolSize: ctx.poolSize,
    negative: ctx.negative?.pools ? { pools: ctx.negative.pools } : undefined,
    now: ctx.now,
    scoreOf: ctx.scoreOf,
    confirmPartitions: ctx.confirmPartitions,
    deferPartitions: ctx.deferPartitions,
  })
  return r.pass ? { pass: true, dropCounts: {} } : { pass: false, dropCounts: { [r.drop!.dim]: 1 } }
}

/** 聚合过滤: 旧 runTagRecFilter(items,cfg,ctx) 等价物 */
const runFilter = (items: TagRecItemExtend[], cfg: TagRecFilterCore, ctx: LegacyCtx = {}) =>
  runTagRecFilter(items, {
    resolve: createTagRecScopeResolver({ core: cfg, groupsByName: groupsFromItems(items, ctx.negative) }),
    pools: ctx.negative?.pools,
    poolSize: ctx.poolSize,
    now: ctx.now,
    scoreOf: ctx.scoreOf,
  })
// #endregion

describe.concurrent('$modules/tag-rec/model/filter-engine', () => {
  // #region 总开关 & 出厂「淘沙」
  it('总开关关 = 完全不过滤', () => {
    const c = baseCfg()
    c.enabled = false
    c.dims.viewMin = { enabled: true, value: 99999 }
    expect(evalDims(item('a', { view: 1 }), c)).toEqual({ pass: true, dropCounts: {} })
  })

  it('出厂「淘沙」不设质量硬门槛；显式开启点赞率后仍按 0.02 筛选', () => {
    const c = createTagRecFactoryFilterCore()
    expect(evalDims(item('default-low', { view: 1000, like: 10 }), c).pass).toBe(true)
    c.dims.likeRate.enabled = true
    // like/view = 10/1000 = 0.01 < 0.02 => 砍
    expect(evalDims(item('a', { view: 1000, like: 10 }), c)).toEqual({
      pass: false,
      dropCounts: { likeRate: 1 },
    })
    // 0.03 >= 0.02 => 过
    expect(evalDims(item('b', { view: 1000, like: 30 }), c).pass).toBe(true)
    // 缺 like => 缺字段豁免放行 (非严格模式)
    expect(evalDims(item('c', { view: 1000 }), c).pass).toBe(true)
    // 无 view 也算比率不可成 => 豁免
    expect(evalDims(item('d', { like: 5 }), c).pass).toBe(true)
  })
  // #endregion

  // #region 维度独立开关
  it('绝对值族 viewMin/viewMax', () => {
    const c = baseCfg()
    c.dims.viewMin = { enabled: true, value: 500 }
    c.dims.viewMax = { enabled: true, value: 2000 }
    expect(evalDims(item('a', { view: 499 }), c).dropCounts).toEqual({ viewMin: 1 })
    expect(evalDims(item('b', { view: 2001 }), c).dropCounts).toEqual({ viewMax: 1 })
    expect(evalDims(item('c', { view: 1000 }), c).pass).toBe(true)
    // 缺 view => 豁免 / 严格反转 (首命中维记数)
    expect(evalDims(item('d', {}), c).pass).toBe(true)
    const strict = baseCfg()
    strict.strictMode = true
    strict.dims.viewMin = { enabled: true, value: 500 }
    expect(evalDims(item('e', {}), strict).dropCounts).toEqual({ viewMin: 1 })
    // 参数未设 (value<=0) => 无约束不吃严格
    strict.dims.viewMin = { enabled: true, value: 0 }
    expect(evalDims(item('f', {}), strict).pass).toBe(true)
  })

  it('stat 绝对值族 ± 七项 (票04): like/fav/coin/danmaku/reply/share min|max 分键归因', () => {
    const c = baseCfg()
    c.dims.likeMin = { enabled: true, value: 50 }
    c.dims.coinMax = { enabled: true, value: 40 }
    expect(evalDims(item('a', { ...fullStat, like: 10 }), c).dropCounts).toEqual({ likeMin: 1 })
    expect(evalDims(item('b', { ...fullStat, coin: 99 }), c).dropCounts).toEqual({ coinMax: 1 })
    expect(evalDims(item('c', fullStat), c).pass).toBe(true)
    // 缺 stat 字段豁免; strict 反转记首 miss 维 (评估序 likeMin 在 coinMax 前)
    expect(evalDims(item('d', { view: 100 }), c).pass).toBe(true)
    const strict = { ...c, strictMode: true }
    expect(evalDims(item('e', { view: 100 }), strict).dropCounts).toEqual({ likeMin: 1 })
  })

  it('比率族 like/fav/coin/interact/share 每 view 独立判定', () => {
    const c = baseCfg()
    c.dims.likeRate = { enabled: true, value: 0.05 }
    c.dims.favRate = { enabled: true, value: 0.05 }
    c.dims.coinRate = { enabled: true, value: 0.05 }
    c.dims.interactRate = { enabled: true, value: 0.05 }
    c.dims.shareRate = { enabled: true, value: 0.05 }
    const good = item('g', { view: 1000, like: 60, favorite: 60, coin: 60, danmaku: 40, reply: 20, share: 60 })
    expect(evalDims(good, c).pass).toBe(true)
    // 每项单独砍 (首命中归因: 顺序靠前的先记)
    const only = (k: keyof typeof fullStat, v: number) => item('x', { ...fullStat, [k]: v })
    expect(evalDims(only('like', 10), c).dropCounts).toEqual({ likeRate: 1 })
    expect(evalDims(only('favorite', 10), c).dropCounts).toEqual({ favRate: 1 })
    expect(evalDims(only('coin', 10), c).dropCounts).toEqual({ coinRate: 1 })
    expect(
      evalDims(only('danmaku', 0), {
        ...c,
        dims: {
          ...c.dims,
          interactRate: { enabled: true, value: 0.05 },
          likeRate: { enabled: false, value: 0.05 },
          favRate: { enabled: false, value: 0.05 },
          coinRate: { enabled: false, value: 0.05 },
        },
      }).dropCounts,
    ).toEqual({ interactRate: 1 })
    expect(
      evalDims(only('share', 10), {
        ...c,
        dims: {
          ...c.dims,
          likeRate: { enabled: false, value: 0.05 },
          favRate: { enabled: false, value: 0.05 },
          coinRate: { enabled: false, value: 0.05 },
          interactRate: { enabled: false, value: 0.05 },
        },
      }).dropCounts,
    ).toEqual({ shareRate: 1 })
    // interactRate = (danmaku+reply)/view 需两字段齐
    const c2 = baseCfg()
    c2.dims.interactRate = { enabled: true, value: 0.01 }
    expect(evalDims(item('i', { view: 1000, danmaku: 50 }), c2).pass).toBe(true) // 缺 reply 豁免
    c2.strictMode = true
    expect(evalDims(item('i2', { view: 1000, danmaku: 50 }), c2).dropCounts).toEqual({ interactRate: 1 })
  })

  it('元信息族 duration / pubdate (token 形, 票04)', () => {
    const c = baseCfg()
    c.dims.duration = { enabled: true, min: 30, max: 600 }
    expect(evalDims(item('a', { view: 1 }, { duration: 20 }), c).dropCounts).toEqual({ duration: 1 })
    expect(evalDims(item('b', { view: 1 }, { duration: 700 }), c).dropCounts).toEqual({ duration: 1 })
    expect(evalDims(item('c', { view: 1 }, { duration: 100 }), c).pass).toBe(true)
    expect(evalDims(item('d', { view: 1 }), c).pass).toBe(true) // 缺 duration 豁免

    const now = Date.UTC(2026, 0, 31)
    const day = 86400
    const sec = now / 1000
    const ctx = { now }
    c.dims.pubdate = { enabled: true, win: 'days', days: 7 } // 近 7 天 (旧 withinDays:7 等价)
    expect(evalDims(item('e', { view: 1 }, { pubdate: sec - 8 * day }), c, ctx).dropCounts).toEqual({
      pubdate: 1,
    })
    expect(evalDims(item('f', { view: 1 }, { pubdate: sec - 6 * day }), c, ctx).pass).toBe(true)
    c.dims.pubdate = { enabled: true, from: sec - 10 * day } // 不早于 (旧 since 等价)
    expect(evalDims(item('g', { view: 1 }, { pubdate: sec - 20 * day }), c, ctx).dropCounts).toEqual({
      pubdate: 1,
    })
    expect(evalDims(item('h', { view: 1 }), c, ctx).pass).toBe(true) // 缺 pubdate 豁免
    // to 上界 + tod 一天内时段
    c.dims.pubdate = { enabled: true, to: sec - 5 * day }
    expect(evalDims(item('i', { view: 1 }, { pubdate: sec - 1 * day }), c, ctx).dropCounts).toEqual({
      pubdate: 1,
    })
    const noon = new Date('2026-01-30T12:00:00').getTime() / 1000
    const early = new Date('2026-01-30T02:00:00').getTime() / 1000
    c.dims.pubdate = { enabled: true, tod: { from: 8 * 60, to: 22 * 60 } } // 08:00~22:00
    expect(evalDims(item('j', { view: 1 }, { pubdate: noon }), c).pass).toBe(true)
    expect(evalDims(item('k', { view: 1 }, { pubdate: early }), c).dropCounts).toEqual({ pubdate: 1 })
    // 跨零点时段 (22:00~06:00)
    c.dims.pubdate = { enabled: true, tod: { from: 22 * 60, to: 6 * 60 } }
    expect(evalDims(item('l', { view: 1 }, { pubdate: early }), c).pass).toBe(true)
    expect(evalDims(item('m', { view: 1 }, { pubdate: noon }), c).dropCounts).toEqual({ pubdate: 1 })
  })

  it('upBlacklist: mid/name 命中剔除, 缺 owner 豁免 (全局名单走 dims; 组层名单走 overrides.negative)', () => {
    const c = baseCfg()
    c.dims.upBlacklist = { enabled: true, list: [{ name: '坏蛋UP' }, { name: 'x', mid: 42 }] }
    expect(evalDims(item('a', { view: 1 }, { owner: { name: '坏蛋UP' } }), c).dropCounts).toEqual({
      upBlacklist: 1,
    })
    expect(evalDims(item('b', { view: 1 }, { owner: { mid: 42, name: '别的名' } }), c).dropCounts).toEqual({
      upBlacklist: 1,
    })
    expect(evalDims(item('c', { view: 1 }, { owner: { mid: 43, name: '好人' } }), c).pass).toBe(true)
    expect(evalDims(item('d', { view: 1 }), c).pass).toBe(true) // 缺 owner 豁免
  })

  it('partition 双池: block 命中即滤 / allow 独立开关默认关; 三分区字段皆缺豁免 (票03 拆池实修)', () => {
    const c = baseCfg()
    c.dims.partitionBlock = {
      enabled: true,
      list: [
        { name: '某区', v1: 100 },
        { name: '另区', v1: 200 },
      ],
    }
    expect(evalDims(item('a', { view: 1 }, { tid: 100 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('b', { view: 1 }, { tid: 300 }), c).pass).toBe(true)
    // 仅看池独立开关: enabled=false 即使有表也不生效 (防误杀)
    c.dims.partitionAllow = { enabled: false, list: [{ name: '某区', v1: 100 }] }
    expect(evalDims(item('c0', { view: 1 }, { tid: 300 }), c).pass).toBe(true)
    c.dims.partitionAllow.enabled = true
    expect(evalDims(item('c', { view: 1 }, { tid: 300 }), c).dropCounts).toEqual({ partitionAllow: 1 })
    // 仅看命中条目过 (屏蔽池摘清后)
    c.dims.partitionBlock.list = []
    expect(evalDims(item('d', { view: 1 }, { tid: 100 }), c).pass).toBe(true)
    // 同分区两池同存 => 屏蔽先判赢 (仅看域内命中屏蔽照样死)
    c.dims.partitionBlock.list = [{ name: '某区', v1: 100 }]
    expect(evalDims(item('e', { view: 1 }, { tid: 100 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('f', { view: 1 }), c).pass).toBe(true) // 缺 tid 豁免 (allow 下也放行)
  })

  it('partitionBlock: 一级分区静态表展开 + v2 直判 tidv2/pid_v2 (票03/07)', () => {
    const c = baseCfg()
    // v1 一级分区 23 (电影) 展开叶集含 147/145/146/83/23
    c.dims.partitionBlock = { enabled: true, list: [{ name: '电影', v1: 23 }] }
    expect(evalDims(item('a', { view: 1 }, { tid: 147 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('b', { view: 1 }, { tid: 17 }), c).pass).toBe(true)
    // v2 叶条目: tidv2 直判 (2079 = 单机联机)
    c.dims.partitionBlock = { enabled: true, list: [{ name: '单机联机', v2: 2079 }] }
    expect(evalDims(item('c', { view: 1 }, { tid: 17, tidv2: 2079 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('d', { view: 1 }, { tid: 17, tidv2: 3000 }), c).pass).toBe(true)
    // v2 一级条目: pid_v2 等值 (1008 = 游戏) + tidv2 叶集展开
    c.dims.partitionBlock = { enabled: true, list: [{ name: '游戏', v2: 1008 }] }
    expect(evalDims(item('e', { view: 1 }, { pid_v2: 1008, tidv2: 2064 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('f', { view: 1 }, { pid_v2: 1001, tidv2: 2079 }), c).pass).toBe(true) // 原生父分区优先于静态表推断
    expect(evalDims(item('g', { view: 1 }, { pid_v2: 1001, tidv2: 2001 }), c).pass).toBe(true)
    // 双键条目 = 两体系通吃 (旧 number[] 迁移形 {v1:n,v2:n})
    c.dims.partitionBlock = { enabled: true, list: [{ name: '#2079', v1: 2079, v2: 2079 }] }
    expect(evalDims(item('h', { view: 1 }, { tidv2: 2079 }), c).dropCounts).toEqual({ partitionBlock: 1 })
    expect(evalDims(item('i', { view: 1 }, { tid: 2079 }), c).dropCounts).toEqual({ partitionBlock: 1 })
  })

  it('partitionAllow: 新版缺字段保持未知，交付要求确认命中', () => {
    const c = baseCfg()
    c.dims.partitionAllow = { enabled: true, list: [{ name: '单机联机', v2: 2079 }] }
    const allV2 = (bvid: string, tid = 100) =>
      item(bvid, { view: 1 }, { tid, source: { via: 'all-v2-exact', groupNames: ['组A'] } })
    // 同步暂存不把缺新版字段判为不符；交付阶段使用 confirmPartitions。
    expect(evalDims(allV2('a'), c).pass).toBe(true)
    expect(evalDims(allV2('a-final'), c, { confirmPartitions: true }).dropCounts).toEqual({ partitionAllow: 1 })
    // strict 反转: miss => fail (缺=不过, 与既有语义一致)
    const strict = { ...c, strictMode: true }
    expect(evalDims(allV2('b'), strict).dropCounts).toEqual({ partitionAllow: 1 })
    // tag/top 条目携 tidv2 => v2 侧可判: 命中放行 / 未命中 fail
    expect(evalDims(item('c', { view: 1 }, { tid: 1, tidv2: 2079 }), c).pass).toBe(true)
    expect(evalDims(item('d', { view: 1 }, { tid: 1, tidv2: 3000 }), c).dropCounts).toEqual({ partitionAllow: 1 })
    // OR 名单：旧版不符并不能否定尚未确认的新版候选。
    c.dims.partitionAllow = {
      enabled: true,
      list: [
        { name: '单机联机', v2: 2079 },
        { name: '电影', v1: 23 },
      ],
    }
    expect(evalDims(allV2('e', 147), c).pass).toBe(true)
    expect(evalDims(allV2('f', 100), c).pass).toBe(true)
    expect(evalDims(allV2('f-final', 100), c, { confirmPartitions: true }).dropCounts).toEqual({ partitionAllow: 1 })
    // 有不同双键的新版条目，以新版为准，不能拿旧分区猜测。
    c.dims.partitionAllow = { enabled: true, list: [{ name: '#100', v1: 100, v2: 2079 }] }
    expect(evalDims(allV2('g', 100), c, { confirmPartitions: true }).pass).toBe(false)
    expect(evalDims(item('h', { view: 1 }, { tidv2: 2079 }), c).pass).toBe(true) // tid 缺 v1 侧死, v2 侧命中
  })

  it('migrateLegacyPartitionId (R3-05): v2 一级分区段只发 v1 键保死值; 余者双键等值还原', () => {
    expect(migrateLegacyPartitionId(1010)).toEqual({ name: '#1010', v1: 1010 }) // v2 pid 段死值保死 (无 v2 键)
    expect(migrateLegacyPartitionId(1032)).toEqual({ name: '#1032', v1: 1032 })
    expect(migrateLegacyPartitionId(4)).toEqual({ name: '#4', v1: 4, v2: 4 }) // v1 段双键
    expect(migrateLegacyPartitionId(2079)).toEqual({ name: '#2079', v1: 2079, v2: 2079 }) // v2 叶段双键等值
    expect(migrateLegacyPartitionId(999)).toEqual({ name: '#999', v1: 999, v2: 999 }) // 表外段双键
  })

  it('titleKeywords: 子串命中剔除 (归一化不区分大小写), 空表无约束', () => {
    const c = baseCfg()
    c.dims.titleKeywords = { enabled: true, list: ['广告', 'AD'] }
    expect(evalDims(item('a', { view: 1 }, { title: '这是AD推广' }), c).dropCounts).toEqual({ titleKeywords: 1 })
    expect(evalDims(item('b', { view: 1 }, { title: '正常视频' }), c).pass).toBe(true)
    c.dims.titleKeywords = { enabled: true, list: [] }
    expect(evalDims(item('c', { view: 1 }, { title: '广告' }), c).pass).toBe(true)
  })

  it('titleKeywords (W1-3): 单字符词不入匹配 (1 字词等于全命中的等价物, 判无效不剔除)', () => {
    const c = baseCfg()
    c.dims.titleKeywords = { enabled: true, list: ['e'] }
    expect(evalDims(item('a', { view: 1 }, { title: 'get e everywhere' }), c).pass).toBe(true)
    expect(evalDims(item('b', { view: 1 }, { title: '不含那个字' }), c).pass).toBe(true)
    // 混表: ≥2 字符的照常生效, <2 的被跳过
    c.dims.titleKeywords = { enabled: true, list: ['e', '广告'] }
    expect(evalDims(item('c', { view: 1 }, { title: 'e 广告' }), c).dropCounts).toEqual({ titleKeywords: 1 })
    expect(evalDims(item('d', { view: 1 }, { title: 'eee' }), c).pass).toBe(true)
  })

  it('descKeywords (W1-3): 单字符 desc 词同样不入匹配', () => {
    const c = baseCfg()
    c.dims.descKeywords = { enabled: true, list: ['a'] }
    const mk = (desc: string) => item('x', { view: 1 }, { desc, source: { via: 'all-v2-exact', groupNames: [] } })
    expect(evalDims(mk('a a a'), c).pass).toBe(true)
  })

  it('descKeywords: 仅搜索/相关池判定, tag/top 池不判 (票02)', () => {
    const c = baseCfg()
    c.dims.descKeywords = { enabled: true, list: ['引流'] }
    const mk = (via: TagRecItemExtend['source']['via']) =>
      item('x', { view: 1 }, { desc: '关注公众号引流', source: { via, groupNames: ['组A'] } })
    expect(evalDims(mk('all-v2-exact'), c).dropCounts).toEqual({ descKeywords: 1 })
    expect(evalDims(mk('archive-related'), c).dropCounts).toEqual({ descKeywords: 1 })
    expect(evalDims(mk('tag-top'), c).pass).toBe(true) // tag/top 池不评估 desc 维
    expect(evalDims(item('y', { view: 1 }), c).pass).toBe(true) // 缺 desc 豁免
  })

  it('minScore: 分数门槛 + 缺分豁免', () => {
    const c = baseCfg()
    c.dims.minScore = { enabled: true, value: 50 }
    const scoreOf = (v?: number) => (_it: TagRecItemExtend, _p: TagRecScoreParams) => v
    expect(evalDims(item('a', fullStat), c, { scoreOf: scoreOf(40) }).dropCounts).toEqual({ minScore: 1 })
    expect(evalDims(item('b', fullStat), c, { scoreOf: scoreOf(60) }).pass).toBe(true)
    // 内部算分路径 (scoreOf 缺省): 满分条目过 50
    expect(
      evalDims(item('c', { view: 1e7, like: 2e6, favorite: 1e6, coin: 5e5, danmaku: 5e5, reply: 5e5 }), c).pass,
    ).toBe(true)
    // partial => 无分 => 豁免; strict => 不过
    expect(evalDims(item('d', { view: 100 }, { partial: true }), c).pass).toBe(true)
    const strict = { ...c, strictMode: true }
    expect(evalDims(item('e', { view: 100 }, { partial: true }), strict).dropCounts).toEqual({ minScore: 1 })
  })

  it('黑名单维(组内负向): 负向池 bvid 交集 + all/v2 自报名名单 按名匹配 (票 14)', () => {
    const c = baseCfg()
    const negEntry = { id: 7, name: '考研' }
    // 负向池: tid 7 的 tag/top 池含 bvid 'hit'
    const neg: LegacyNegCtx = {
      entriesOf: (it) => (it.source.groupNames.includes('G') ? [negEntry] : []),
      pools: new Map([[7, new Set(['hit'])]]),
    }
    const gitem = (bvid: string, extra: Partial<TagRecItemExtend> = {}) => ({
      ...item(bvid, fullStat, extra),
      source: { via: 'tag-top' as const, groupNames: ['G'] },
    })
    expect(evalDims(gitem('hit'), c, { negative: neg }).dropCounts).toEqual({ blacklist: 1 }) // 池交集命中
    expect(evalDims(gitem('miss'), c, { negative: neg }).pass).toBe(true)
    // all/v2 自报名单按名匹配 (归一化: 大小写/空白)
    expect(evalDims(gitem('v2hit', { ownTagNames: ['数学', 'Kao Yan'] }), c, { negative: neg }).pass).toBe(true) // 'Kao Yan' 归一≠'考研'
    expect(evalDims(gitem('v2hit2', { ownTagNames: ['数学', ' 考研 '] }), c, { negative: neg }).dropCounts).toEqual({
      blacklist: 1,
    })
    // 非本组条目 / 无负向 => 该维不适用放行 (不吃 strictMode)
    const strict = { ...c, strictMode: true }
    expect(evalDims(item('x', fullStat), c, { negative: neg }).pass).toBe(true)
    expect(evalDims(gitem('hit'), strict, { negative: { entriesOf: () => [], pools: new Map() } }).pass).toBe(true)
    expect(evalDims(gitem('hit'), c).pass).toBe(true) // 无 negative => 放行
  })
  // #endregion

  // #region 生效链 (票01/02/03/05)
  it('生效链: L2 overrides > L1 > 池槽 > 全局, 就近覆盖 (票01)', () => {
    const c = baseCfg()
    c.dims.viewMin = { enabled: true, value: 100 } // 全局
    c.pools = { tagTop: { dims: { viewMin: { enabled: true, value: 200 } } } } // 池层
    const l1 = makeTagL1Group({
      name: 'L1',
      overrides: { dims: { viewMin: { enabled: true, value: 300 } } },
    })!
    const g = makeTagGroup({
      name: 'G',
      tag_ids: [{ id: 1, name: 'x' }],
      l1Id: l1.id,
      overrides: { dims: { viewMin: { enabled: true, value: 400 } } },
    })!
    // 无组 => 池槽覆盖全局 (tagTop 池 => 200)
    expect(resolveTagRecEffective(c, 'tagTop').cfg.dims.viewMin.value).toBe(200)
    // L1 覆盖池层 (300); L2 覆盖 L1 (400); 格槽再覆盖 L2
    expect(resolveTagRecEffective(c, 'tagTop', undefined, l1).cfg.dims.viewMin.value).toBe(200) // 无组不挂 L1
    expect(resolveTagRecEffective(c, 'tagTop', { ...g, overrides: undefined }, l1).cfg.dims.viewMin.value).toBe(300)
    expect(resolveTagRecEffective(c, 'tagTop', g, l1).cfg.dims.viewMin.value).toBe(400)
    const g2 = {
      ...g,
      overrides: { ...g.overrides, pools: { tagTop: { dims: { viewMin: { enabled: true, value: 500 } } } } },
    }
    expect(resolveTagRecEffective(c, 'tagTop', g2, l1).cfg.dims.viewMin.value).toBe(500)
    // 别的池不受 tagTop 格槽影响
    expect(resolveTagRecEffective(c, 'allV2', g2, l1).cfg.dims.viewMin.value).toBe(400)
    // smallPoolThreshold 标量同链
    expect(resolveTagRecEffective(c, 'tagTop', g, l1).cfg.smallPoolThreshold).toBe(15)
    const g3 = { ...g, overrides: { ...g.overrides, smallPoolThreshold: 5 } }
    expect(resolveTagRecEffective(c, 'tagTop', g3, l1).cfg.smallPoolThreshold).toBe(5)
  })

  it('名单叠加: L1+L2+全局并集, kill-list 各层绝对; 仅看就近覆盖 (票01/02)', () => {
    const c = baseCfg()
    c.dims.upBlacklist = { enabled: true, list: [{ name: '全局黑名单' }] }
    c.dims.titleKeywords = { enabled: true, list: ['全局词'] }
    const l1 = makeTagL1Group({ name: 'L1', overrides: { negative: { title: ['L1词'], up: [{ name: 'L1黑' }] } } })!
    const g = makeTagGroup({
      name: 'G',
      tag_ids: [{ id: 1, name: 'x' }],
      l1Id: l1.id,
      overrides: { negative: { title: ['组词'], up: [{ name: '组黑' }] } },
    })!
    const eff = resolveTagRecEffective(c, 'tagTop', g, l1)
    expect(eff.neg.title.map((e) => e.v).sort()).toEqual(['L1词', '全局词', '组词'])
    expect(eff.neg.up.map((e) => e.v.name).sort()).toEqual(['L1黑', '全局黑名单', '组黑'])
    // 任一否决即死: 组词命中即可
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map([['G', g]]),
      l1ById: new Map([[l1.id, l1]]),
    })
    const kill = (title: string) =>
      evalTagRecItem(item('v', { view: 1 }, { title, source: { via: 'tag-top', groupNames: ['G'] } }), resolve)
    expect(kill('含组词的视频').pass).toBe(false)
    expect(kill('含L1词').pass).toBe(false)
    expect(kill('含全局词').pass).toBe(false)
    // 仅看就近覆盖 (拆池实修): L2 allow 开且非空时全局 allow 失效
    const c2 = baseCfg()
    c2.dims.partitionAllow = { enabled: true, list: [{ name: '全区', v1: 23 }] }
    const g2 = makeTagGroup({
      name: 'G2',
      tag_ids: [{ id: 1, name: 'x' }],
      overrides: { negative: { partitionAllow: { enabled: true, list: [{ name: '组区', v1: 188 }] } } },
    })!
    const resolve2 = createTagRecScopeResolver({ core: c2, groupsByName: new Map([['G2', g2]]) })
    const it188 = item('v', { view: 1 }, { tid: 188, source: { via: 'tag-top', groupNames: ['G2'] } })
    const it23 = item('w', { view: 1 }, { tid: 23, source: { via: 'tag-top', groupNames: ['G2'] } })
    expect(evalTagRecItem(it188, resolve2).pass).toBe(true) // L2 仅看生效
    expect(evalTagRecItem(it23, resolve2).pass).toBe(false) // 全局仅看被覆盖 => 188 组拒 23
  })

  it('草稿组兜底 (fallbackGroup): 未归属来源名与空认领条目皆落草稿链 (实修: 未存成项先屏蔽)', () => {
    const c = baseCfg()
    const draft = makeTagGroup({
      name: '草稿',
      tag_ids: [{ id: 1, name: 'x' }],
      overrides: {
        negative: {
          title: ['草稿词'],
          partitionBlock: [{ name: '游戏', v1: 4, v2: 1008 }],
        },
      },
    })!
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map(), // 收藏表空 —— 一切来源名皆未归属
      fallbackGroup: draft,
    })
    const kill = (extra: Partial<TagRecItemExtend>) => evalTagRecItem(item('v', { view: 1 }, extra), resolve)
    // 来源名未命中收藏表 => 草稿链
    const named = (title: string) => kill({ title, source: { via: 'tag-top', groupNames: ['输入词'] } })
    expect(named('含草稿词').pass).toBe(false)
    expect(named('正常标题').pass).toBe(true)
    // 草稿分区屏蔽池生效 (未存成项也能屏分区)
    expect(kill({ pid_v2: 1008, tidv2: 2064, source: { via: 'tag-top', groupNames: ['输入词'] } }).pass).toBe(false)
    // 空认领条目 (无 groupNames) 同样落草稿链
    expect(kill({ title: '含草稿词', source: { via: 'tag-top', groupNames: [] } }).pass).toBe(false)
  })

  it('多归属任一放行 + 首认领组归因 (票01)', () => {
    const c = baseCfg()
    const gA = makeTagGroup({
      name: 'A',
      tag_ids: [{ id: 1, name: 'x' }],
      overrides: { negative: { title: ['杀A'] } },
    })!
    const gB = makeTagGroup({ name: 'B', tag_ids: [{ id: 2, name: 'y' }] })!
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map([
        ['A', gA],
        ['B', gB],
      ]),
    })
    // A 拒 B 放 => 活 (任一放行)
    const it1 = item('v', { view: 1 }, { title: '杀A', source: { via: 'tag-top', groupNames: ['A', 'B'] } })
    expect(evalTagRecItem(it1, resolve).pass).toBe(true)
    // 只归 A => 死, 归因 titleKeywords@A
    const it2 = item('w', { view: 1 }, { title: '杀A', source: { via: 'tag-top', groupNames: ['A'] } })
    const r = evalTagRecItem(it2, resolve)
    expect(r.pass).toBe(false)
    expect(r.drop).toEqual({ dim: 'titleKeywords', scope: 'A' })
  })

  it('A1-3: groupIds 权威归因 —— 同名组不互相错账; id miss 不回退名查', () => {
    const c = baseCfg()
    // 两个同名组「X」: 宽松者在前 (名查会先命中它), 严格者带杀词
    const loose = makeTagGroup({ id: 'g-loose', name: 'X', tag_ids: [{ id: 1, name: 'a' }] })!
    const strictG = makeTagGroup({
      id: 'g-strict',
      name: 'X',
      tag_ids: [{ id: 2, name: 'b' }],
      overrides: { negative: { title: ['杀词'] } },
    })!
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map([['X', loose]]), // 名查里严格者被同名遮蔽 (旧实现的碰撞面)
      groupsById: new Map([
        ['g-loose', loose],
        ['g-strict', strictG],
      ]),
    })
    // id 归因 g-strict => 杀词生效 (旧名查会解到 loose 放行 —— 错账放行)
    const hit = item(
      'v',
      { view: 1 },
      { title: '杀词', source: { via: 'tag-top', groupNames: ['X'], groupIds: ['g-strict'] } },
    )
    const r = evalTagRecItem(hit, resolve)
    expect(r.pass).toBe(false)
    expect(r.drop).toEqual({ dim: 'titleKeywords', scope: 'X' }) // scope 标签以权威组名回填
    // id 归因 g-loose => 同名严组规则不外溢 (旧名查若先解到 strict 会冤杀)
    const ok = item(
      'w',
      { view: 1 },
      { title: '杀词', source: { via: 'tag-top', groupNames: ['X'], groupIds: ['g-loose'] } },
    )
    expect(evalTagRecItem(ok, resolve).pass).toBe(true)
    // id 给了但表里没该组 (已删) => 落兜底全局链, 不撞同名组规则
    const ghost = item(
      'z',
      { view: 1 },
      { title: '杀词', source: { via: 'tag-top', groupNames: ['X'], groupIds: ['gone'] } },
    )
    expect(evalTagRecItem(ghost, resolve).pass).toBe(true)
    // 纯名链 (词归因) 仍走名查 —— 兼容旧路径
    const nameOnly = item('y', { view: 1 }, { title: '杀词', source: { via: 'tag-top', groupNames: ['X'] } })
    expect(evalTagRecItem(nameOnly, resolve).pass).toBe(true) // 解到 loose
  })

  it('池槽算分: allV2 显式参数 (coinRate 权重 0 + 锚 0 封禁), tagTop 走全局 (票05)', () => {
    const c = createTagRecFactoryFilterCore()
    const tagTop = resolvePoolScoreParams(c, 'tagTop')
    const allV2 = resolvePoolScoreParams(c, 'allV2')
    expect(tagTop.weights).toEqual(c.score.weights) // 缺槽=继承全局
    expect(allV2.weights.coinRate).toBe(0)
    expect(allV2.anchors.coinRate).toBe(0)
    expect(allV2.weights.likeRate).toBeCloseTo(0.375) // coin 摊还 3:2:1
    // via => 池键归并 (搜索相关独立成池)
    expect(poolOfVia('all-v2-exact')).toBe('allV2')
    expect(poolOfVia('all-v2-related')).toBe('allV2Related')
    expect(poolOfVia('archive-related')).toBe('archiveRelated')
    expect(poolOfVia('tag-top')).toBe('tagTop')
  })

  it('allV2Related 池: 缺槽 score 回退 allV2 档 (同字段形), 显式格覆盖胜出', () => {
    const c = createTagRecFactoryFilterCore()
    // 缺槽 => 继承 allV2 槽参数 (coinRate=0 字段形适配)
    const rel = resolvePoolScoreParams(c, 'allV2Related')
    expect(rel.weights.coinRate).toBe(0)
    expect(rel.weights.likeRate).toBeCloseTo(0.375)
    // 显式池槽 => 覆盖胜出
    c.pools = { ...c.pools, allV2Related: { score: { weights: { view: 1 } } } }
    expect(resolvePoolScoreParams(c, 'allV2Related').weights.view).toBe(1)

    // 生效链同款 (走真 resolver, 连 poolOfVia 一起过): all-v2-related 条目吃 allV2Related 格, 不吃 allV2 格
    const g = makeTagGroup({
      name: 'G',
      tag_ids: [{ id: 1, name: 't' }],
      overrides: {
        pools: {
          allV2: { dims: { viewMin: { enabled: true, value: 99999 } } }, // 搜索池格: 99999 起
          allV2Related: { dims: { viewMin: { enabled: true, value: 1 } } }, // 搜索相关格: 1 起
        },
      },
    })!
    const resolve = createTagRecScopeResolver({ core: c, groupsByName: new Map([['G', g]]) })
    const relItem = item('r', { view: 100 }, { source: { via: 'all-v2-related', groupNames: ['G'] } })
    const exItem = item('e', { view: 100 }, { source: { via: 'all-v2-exact', groupNames: ['G'] } })
    expect(evalTagRecItem(relItem, resolve).pass).toBe(true)
    expect(evalTagRecItem(exItem, resolve).pass).toBe(false)

    // 且 相关池(archiveRelated) 格不再误伤 all-v2-related (此前的归类坑)
    const c2 = baseCfg()
    const g2 = makeTagGroup({
      name: 'G2',
      tag_ids: [{ id: 1, name: 't' }],
      overrides: { pools: { archiveRelated: { dims: { viewMax: { enabled: true, value: 1 } } } } },
    })!
    const resolve2 = createTagRecScopeResolver({ core: c2, groupsByName: new Map([['G2', g2]]) })
    const rel2 = item('r2', { view: 999 }, { source: { via: 'all-v2-related', groupNames: ['G2'] } })
    expect(evalTagRecItem(rel2, resolve2).pass).toBe(true)
    const arch = item('a', { view: 999 }, { source: { via: 'archive-related', groupNames: ['G2'] } })
    expect(evalTagRecItem(arch, resolve2).pass).toBe(false)
  })
  // #endregion

  // #region 缺字段豁免 / 严格模式
  it('缺字段豁免: all/v2 形态 (无 coin/share/duration/owner.mid) 不被冤杀; strictMode 反转', () => {
    const c = baseCfg()
    c.dims.coinRate = { enabled: true, value: 0.01 }
    c.dims.shareRate = { enabled: true, value: 0.01 }
    c.dims.duration = { enabled: true, min: 60, max: 0 }
    c.dims.upBlacklist = { enabled: true, list: [{ name: 'x', mid: 42 }] }
    const v2 = item('v2', { view: 1000, like: 100, favorite: 50, danmaku: 10, reply: 5 }, { owner: { name: '某人' } })
    expect(evalDims(v2, c).pass).toBe(true)
    const strict = { ...c, strictMode: true }
    // strict 下首命中 miss 维 = duration (评估序: stat± → duration/pubdate → 比率族)
    expect(evalDims(v2, strict).dropCounts).toEqual({ duration: 1 })
  })
  // #endregion

  // #region 小池降级
  it('小池降级: 池有效条数 < threshold => 比率族+minScore 失效, 硬条件仍生效', () => {
    const c = baseCfg()
    c.dims.likeRate = { enabled: true, value: 0.5 } // 严苛比率
    c.dims.minScore = { enabled: true, value: 99 }
    c.dims.viewMin = { enabled: true, value: 100 } // 硬条件
    const lowRatio = item('a', { view: 1000, like: 1 }) // like/view=0.001
    const lowView = item('b', { view: 50, like: 10 })
    // 大池 (>=15): 比率+minScore 生效 => 砍
    expect(evalDims(lowRatio, c, { poolSize: 15 }).pass).toBe(false)
    // 小池 (14<15): 比率+minScore 失效 => 过; 但硬条件仍砍 lowView
    expect(evalDims(lowRatio, c, { poolSize: 14 }).pass).toBe(true)
    expect(evalDims(lowView, c, { poolSize: 14 }).dropCounts).toEqual({ viewMin: 1 })
    expect(isTagRecSmallPoolDegraded(c, 14)).toBe(true)
    expect(isTagRecSmallPoolDegraded(c, 15)).toBe(false)
    expect(isTagRecSmallPoolDegraded(c, undefined)).toBe(false)
  })
  // #endregion

  // #region runTagRecFilter 聚合
  it('.runTagRecFilter: 分维度计数 (首命中归因) + 合计 + degraded 标记 + byScope 双键', () => {
    const c = createTagRecFactoryFilterCore()
    c.dims.likeRate.enabled = true
    const items = [
      item('a', { view: 1000, like: 50 }), // 过
      item('b', { view: 1000, like: 5 }), // likeRate 砍
      item('c', { view: 0, like: 0 }), // 比率不可成 => 豁免
    ]
    const r = runFilter(items, c, { poolSize: 100 })
    expect(r.items.map((x) => x.bvid)).toEqual(['a', 'c'])
    expect(r.stats.dropped).toBe(1)
    expect(r.stats.byDim).toEqual({ likeRate: 1 })
    expect(r.stats.byScope).toEqual({ 'likeRate@组A': 1 }) // 组链首维, 无组层名单 => scope=组名
    expect(r.stats.degraded).toBe(false)
    // 小池 + 黑名单(组内负向池交集)命中
    const c2 = baseCfg()
    c2.dims.viewMin = { enabled: true, value: 100 }
    const r2 = runFilter([item('a', { view: 10 }), item('b', { view: 500 }), item('c', { view: 500 })], c2, {
      negative: {
        entriesOf: (it) => (it.bvid === 'c' ? [{ id: 7, name: 'neg' }] : []),
        pools: new Map([[7, new Set(['c'])]]),
      },
    })
    expect(r2.items.map((x) => x.bvid)).toEqual(['b'])
    expect(r2.stats.dropped).toBe(2)
    expect(r2.stats.byDim).toEqual({ viewMin: 1, blacklist: 1 })
    expect(r2.stats.degraded).toBe(true) // 3 < 15
  })

  it('.runTagRecFilter 总开关关 => 全放 + 不计数 + 不降级', () => {
    const c = createTagRecFactoryFilterCore()
    c.enabled = false
    const r = runFilter([item('a', { view: 1, like: 0 })], c)
    expect(r.items.length).toBe(1)
    expect(r.stats.dropped).toBe(0)
    expect(r.stats.byDim).toEqual({})
    expect(r.stats.degraded).toBe(false)
  })
  // #endregion

  // #region 综合分
  it('.computeScore: Σ(w·min(1,c/anchor))×100 + 截断', () => {
    const it = item('a', fullStat)
    const r = computeScore(it, scoreParams)
    // view: log10(1001)/7 ≈ 0.4286 ; like 0.06/0.12=0.5 ; fav 0.06/0.06=1 ; coin 0.03/0.03=1 ; interact 0.03/0.03=1
    const expectScore = (0.25 * (Math.log10(1001) / 7) + 0.3 * 0.5 + 0.2 + 0.15 + 0.1) * 100
    expect(r.partial).toBe(false)
    expect(r.score).toBeCloseTo(expectScore, 6)
    // 截断: 超锚分量按 1 计
    expect(r.components.favRate).toBe(1)
  })

  it('.computeScore 缺分量跳过 + 权重重归一', () => {
    const it = item('a', { view: 1000, like: 120, favorite: 60, danmaku: 30, reply: 30 }) // 无 coin
    const r = computeScore(it, scoreParams)
    const viewC = Math.log10(1001) / 7
    // coinRate 分量缺 => 权重 0.15 出归一分母
    const expectScore = ((0.25 * viewC + 0.3 * 1 + 0.2 * 1 + 0.1 * 1) / 0.85) * 100
    expect(r.score).toBeCloseTo(expectScore, 6)
    expect(r.components.coinRate).toBeUndefined()
  })

  it('.computeScore partial (stat 只剩 view) 不算分', () => {
    const r = computeScore(item('a', { view: 1000 }), scoreParams)
    expect(r).toMatchObject({ score: undefined, partial: true })
    // item.partial 显式标记同样生效 (stat 有 like 但标 partial 仍不算分)
    const r2 = computeScore(item('b', fullStat, { partial: true }), scoreParams)
    expect(r2.score).toBeUndefined()
  })

  it('.runTagRecScoreStage: 写回公开分数，缺统计按同批中位质量排序', () => {
    const items = [
      item('low', { view: 10, like: 0, favorite: 0, coin: 0, danmaku: 0, reply: 0 }, { srcRank: 0 }),
      item('high', { view: 1e6, like: 2e5, favorite: 1e5, coin: 5e4, danmaku: 5e4, reply: 5e4 }, { srcRank: 9 }),
      item('mid', { view: 1e4, like: 500, favorite: 200, coin: 100, danmaku: 50, reply: 50 }, { srcRank: 1 }),
      item('p', { view: 99999 }, { srcRank: 2 }),
    ]
    const { items: out } = runTagRecScoreStage(items, { score: scoreParams } as TagRecFilterCore)
    expect(out.map((x) => x.bvid)).toEqual(['high', 'mid', 'p', 'low'])
    expect(out[0].score).toBeGreaterThan(out[1].score ?? 0)
    expect(out[2].partial).toBe(true)
    expect(out[2].score).toBeUndefined()
  })

  it('.sortTagRecItems 排序键委托 compareTagRecItems (score→srcRank→bvid)', () => {
    const out = sortTagRecItems([
      item('a', { view: 1 }, { score: 50, srcRank: 3 }),
      item('b', { view: 1 }, { score: 80, srcRank: 9 }),
      item('c', { view: 1 }, { score: 80, srcRank: 1 }),
      item('p', { view: 999 }, { partial: true }),
    ])
    expect(out.map((x) => x.bvid)).toEqual(['c', 'b', 'a', 'p'])
  })
  // #endregion

  // #region diversityGuard (票09 两轴)
  const guardOn = (maxShare = 0.6) => ({
    group: { enabled: true, maxShare },
    up: { enabled: false, max: 4 },
  })

  it('.applyDiversityGuard: 单组占每切片 ≤60%, 超额顺延下一切片', () => {
    const mk = (g: string, i: number) => item(`${g}${i}`, fullStat, { source: { via: 'tag-top', groupNames: [g] } })
    // 14 条组A 在前 + 6 条组B: sliceSize=10, quota=6
    const items = [
      ...Array.from({ length: 14 }, (_, i) => mk('A', i)),
      ...Array.from({ length: 6 }, (_, i) => mk('B', i)),
    ]
    const { items: out, deferred } = applyDiversityGuard(items, { sliceSize: 10, guard: guardOn() })
    expect(out.length).toBe(20)
    // 第 1 切片 (满 10): 组A 6 条触 quota, 其余位置由 B 填上 => A0-5, B0-3
    expect(out.slice(0, 10).map((x) => x.bvid)).toEqual(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'B0', 'B1', 'B2', 'B3'])
    // 顺延: 超额 A6-13 后移 (原序保留), B 组相对序亦不乱
    expect(out.filter((x) => x.bvid.startsWith('A')).map((x) => x.bvid)).toEqual(
      Array.from({ length: 14 }, (_, i) => `A${i}`),
    )
    expect(out.filter((x) => x.bvid.startsWith('B')).map((x) => x.bvid)).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5'])
    // 每一切片内部: A 计数 ≤ quota (含压实前移后的切片 —— 逐块贪心保证)
    const cntAIn = (lo: number, hi: number) => out.slice(lo, hi).filter((x) => x.bvid.startsWith('A')).length
    expect(cntAIn(0, 10)).toBeLessThanOrEqual(6)
    expect(cntAIn(10, 18)).toBeLessThanOrEqual(6) // 第 2 块 (8 条)
    expect(cntAIn(18, 20)).toBeLessThanOrEqual(6) // 第 3 块 (2 条)
    expect(deferred.group).toBeGreaterThan(0)
  })

  it('.applyDiversityGuard UP 轴: 同一 owner.mid 每切片 ≤max, 缺 mid 豁免 (票09)', () => {
    const mk = (i: number, mid?: number) =>
      item(`u${i}`, fullStat, mid === undefined ? {} : { owner: { name: `u${mid}`, mid } })
    // 8 条同 mid=7 + 4 条无 mid: sliceSize=10, upMax=4
    const items = [...Array.from({ length: 8 }, (_, i) => mk(i, 7)), ...Array.from({ length: 4 }, (_, i) => mk(i + 8))]
    const { items: out, deferred } = applyDiversityGuard(items, {
      sliceSize: 10,
      guard: { group: { enabled: false, maxShare: 0.6 }, up: { enabled: true, max: 4 } },
    })
    expect(out.length).toBe(12)
    expect(deferred.up).toBe(4) // u4-u7 顺延
    expect(out.slice(0, 10).map((x) => x.bvid)).toEqual(['u0', 'u1', 'u2', 'u3', 'u8', 'u9', 'u10', 'u11', 'u4', 'u5'])
    // 缺 mid 者不占 UP 配额
  })

  it('.applyDiversityGuard 单组池不卡死 (无法达 60% 按序放行)', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`x${i}`, fullStat))
    const { items: out } = applyDiversityGuard(items, { sliceSize: 10, guard: guardOn() })
    expect(out.map((x) => x.bvid)).toEqual(items.map((x) => x.bvid))
  })
  // #endregion

  // #region 预设引擎
  const filterWithPresets = (): TagRecFilterSettings => ({
    ...createTagRecFactoryFilterCore(),
    activePreset: '淘沙',
    presets: createTagRecBuiltinPresets(),
  })

  it('applyTagRecPreset 整套覆盖 + activePreset 跟随', () => {
    const f = filterWithPresets()
    expect(applyTagRecPreset(f, '只看高质量')).toBe(true)
    expect(f.activePreset).toBe('只看高质量')
    expect(f.smallPoolThreshold).toBe(15)
    expect(f.dims.minScore).toEqual({ enabled: true, value: 50 })
    expect(f.dims.likeRate).toEqual({ enabled: true, value: 0.06 })
    expect(applyTagRecPreset(f, '不存在')).toBe(false)
    // 「全放」= enabled:false
    expect(applyTagRecPreset(f, '全放')).toBe(true)
    expect(f.enabled).toBe(false)
  })

  it('restoreTagRecBuiltinPreset 恢复出厂; 自定义档拒恢复', () => {
    const f = filterWithPresets()
    const p = f.presets.find((x) => x.name === '淘沙')!
    p.config.dims.likeRate.value = 0.5 // 用户改坏
    expect(restoreTagRecBuiltinPreset(f, '淘沙')).toBe(true)
    expect(f.presets.find((x) => x.name === '淘沙')!.config.dims.likeRate.value).toBe(0.02)
    upsertTagRecPreset(f, { name: '我的', config: createTagRecFactoryFilterCore() })
    expect(restoreTagRecBuiltinPreset(f, '我的')).toBe(false)
    expect(restoreTagRecBuiltinPreset(f, '不存在')).toBe(false)
  })

  it('自定义预设 增/删/改名; 内置拒删拒改名', () => {
    const f = filterWithPresets()
    const cfg = createTagRecFactoryFilterCore()
    cfg.dims.viewMin = { enabled: true, value: 100 }
    upsertTagRecPreset(f, { name: '自定义1', config: cfg })
    expect(f.presets.find((x) => x.name === '自定义1')?.config.dims.viewMin.enabled).toBe(true)
    // 同名覆盖
    cfg.dims.viewMin.value = 200
    upsertTagRecPreset(f, { name: '自定义1', config: cfg })
    expect(f.presets.filter((x) => x.name === '自定义1').length).toBe(1)
    expect(f.presets.find((x) => x.name === '自定义1')!.config.dims.viewMin.value).toBe(200)
    // 改名 + activePreset 跟随
    applyTagRecPreset(f, '自定义1')
    expect(renameTagRecPreset(f, '自定义1', '改名了')).toBe(true)
    expect(f.activePreset).toBe('改名了')
    expect(renameTagRecPreset(f, '淘沙', 'x')).toBe(false) // 内置拒改
    expect(renameTagRecPreset(f, '改名了', '淘沙')).toBe(false) // 重名拒
    // 删除
    expect(removeTagRecPreset(f, '淘沙')).toBe(false) // 内置拒删
    expect(removeTagRecPreset(f, '改名了')).toBe(true)
    expect(f.activePreset).toBe('') // 删中 active => 置空
    expect(removeTagRecPreset(f, '不存在')).toBe(false)
  })

  it('assignTagRecFilterCore 深拷贝覆盖 (快照不共享引用)', () => {
    const dst = createTagRecFactoryFilterCore()
    const src = createTagRecFactoryFilterCore()
    src.dims.viewMin = { enabled: true, value: 7 }
    assignTagRecFilterCore(dst, src)
    expect(dst.dims.viewMin.value).toBe(7)
    src.dims.viewMin.value = 999
    expect(dst.dims.viewMin.value).toBe(7) // 不共享
  })

  it('旧预设缺新增名单维度或包含 undefined 时，反复切换与直接求解均不崩溃', () => {
    const old = createTagRecFactoryFilterCore()
    delete (old.dims as Partial<typeof old.dims>).upAllow
    delete (old.dims as Partial<typeof old.dims>).descKeywords
    ;(old.dims as Partial<typeof old.dims>).titleAllow = undefined
    expect(() => resolveTagRecEffective(old, 'tagTop')).not.toThrow()
    const filter = {
      ...createTagRecFactoryFilterCore(),
      activePreset: '',
      presets: [{ name: '旧高质量', config: old }, ...createTagRecBuiltinPresets()],
    }
    for (const name of ['旧高质量', '淘沙', '旧高质量', '只看高质量']) {
      expect(applyTagRecPreset(filter, name)).toBe(true)
      expect(filter.dims.upAllow).toEqual({ enabled: false, list: [] })
      expect(filter.dims.descKeywords).toEqual({ enabled: false, list: [] })
      expect(() => resolveTagRecEffective(filter, 'tagTop')).not.toThrow()
    }
  })

  it('cloneTagRecFilterCore 会话副本: 深拷贝且独立 (tab2 override 初值)', () => {
    const src = filterWithPresets() // settings 形态 (含 presets/activePreset) 亦可作 core 源
    src.dims.likeRate = { enabled: true, value: 0.09 }
    const copy = cloneTagRecFilterCore(src)
    expect(copy).not.toHaveProperty('presets')
    expect(copy).not.toHaveProperty('activePreset')
    expect(copy.enabled).toBe(src.enabled)
    expect(copy.smallPoolThreshold).toBe(src.smallPoolThreshold)
    expect(copy.dims.likeRate).toEqual({ enabled: true, value: 0.09 })
    src.dims.likeRate.value = 0.01
    src.score.weights.view = 0.99
    expect(copy.dims.likeRate.value).toBe(0.09) // 不共享
    expect(copy.score.weights.view).toBe(0.25)
  })

  it('applyTagRecPresetToCore 按名整套覆盖到任意 core (tab2 会话副本绑预设)', () => {
    const presets = createTagRecBuiltinPresets()
    const core = createTagRecFactoryFilterCore()
    core.enabled = false
    expect(applyTagRecPresetToCore(presets, core, '只看高质量')).toBe(true)
    expect(core.enabled).toBe(true)
    expect(core.smallPoolThreshold).toBe(15)
    expect(core.dims.minScore).toEqual({ enabled: true, value: 50 })
    expect(applyTagRecPresetToCore(presets, core, '不存在')).toBe(false)
    // 覆盖是深拷贝: 再改 core 不回写预设快照
    core.dims.likeRate.value = 0.99
    expect(presets.find((x) => x.name === '只看高质量')!.config.dims.likeRate.value).toBe(0.06)
  })

  it('valtio proxy 场景: clone/applyToCore 直接吃 settings 侧 proxy (pane/tab2 接线形态)', () => {
    const filter = proxy(filterWithPresets())
    const override = proxy({ value: cloneTagRecFilterCore(filter) }) // 模拟 filterOverride 初始化
    expect(override.value.dims.likeRate).toEqual({ enabled: false, value: 0.02 })
    filter.dims.likeRate.value = 0.77 // 源 proxy 再改 => 副本不受影响
    expect(override.value.dims.likeRate.value).toBe(0.02)
    // proxy 预设表 => 覆盖到 proxy 副本
    expect(applyTagRecPresetToCore(filter.presets, override.value, '全放')).toBe(true)
    expect(override.value.enabled).toBe(false)
    expect(filter.enabled).toBe(true) // 只写副本, 不动全局
  })
  // #endregion

  // #region 票12: draft-基准差分 => 稀疏 override (GroupConfigModal 存盘核)
  it('diffTagRecScopeOverride: 等值不键化, 差异整 dim/逐字段 score/标量', () => {
    const base = createTagRecFactoryFilterCore()
    const draft = cloneTagRecFilterCore(base)

    // 无差 => undefined (槽位删键回继承)
    expect(diffTagRecScopeOverride(draft, base)).toBeUndefined()

    draft.dims.likeRate = { enabled: true, value: 0.09 }
    draft.dims.viewMin.value = 5000 // 子字段改 => 整 dim 对象键化
    draft.score.weights.view = 0.4
    draft.score.anchors.likeRate = 0.2
    draft.smallPoolThreshold = 50
    draft.dims.upBlacklist.list.push({ name: 'x' }) // 名单维不进 patch (结构性除外)
    const patch = diffTagRecScopeOverride(draft, base)
    expect(patch?.dims?.likeRate).toEqual({ enabled: true, value: 0.09 })
    expect(patch?.dims?.viewMin).toEqual({ enabled: base.dims.viewMin.enabled, value: 5000 })
    expect(patch?.dims).not.toHaveProperty('upBlacklist')
    expect(patch?.dims).not.toHaveProperty('titleKeywords')
    expect(patch?.score).toEqual({ weights: { view: 0.4 }, anchors: { likeRate: 0.2 } })
    expect(patch?.smallPoolThreshold).toBe(50)

    // 抄回基准 = 回继承 (patch 摘空 => undefined)
    draft.dims.likeRate = { ...base.dims.likeRate }
    const patch2 = diffTagRecScopeOverride(draft, base)
    expect(patch2?.dims).not.toHaveProperty('likeRate')
    expect(patch2?.dims?.viewMin).toBeDefined()
  })

  it('normalizeTagRecNegativeDraft: trim/去重/摘空; 全空 => undefined', () => {
    expect(normalizeTagRecNegativeDraft(undefined)).toBeUndefined()
    expect(normalizeTagRecNegativeDraft({})).toBeUndefined()
    expect(
      normalizeTagRecNegativeDraft({
        up: [],
        title: ['  ', ''],
        strict: false,
        partition: { mode: 'block', list: [] },
      }),
    ).toBeUndefined()
    expect(normalizeTagRecNegativeDraft({ title: ['  a ', 'a', ''] })?.title).toEqual(['a']) // trim+去重
    const n = normalizeTagRecNegativeDraft({
      up: [
        { name: ' up ', mid: 7 },
        { name: '', mid: undefined },
      ],
      title: [' x '],
      strict: true,
      partition: { mode: 'allow', list: [{ name: '动画', v2: 1 }] },
    })
    // 拆池实修: 旧形 partition{mode:'allow'} 读期折叠 => partitionAllow 且迁移保持开 (旧仅看语义常效)
    expect(n).toEqual({
      up: [{ name: 'up', mid: 7 }],
      title: ['x'],
      strict: true,
      partitionAllow: { enabled: true, list: [{ name: '动画', v2: 1 }] },
    })
  })

  it('hasTagRecGroupConfig: 本层槽/negative/格槽任一有内容 => true', () => {
    expect(hasTagRecGroupConfig(undefined)).toBe(false)
    expect(hasTagRecGroupConfig({})).toBe(false)
    expect(hasTagRecGroupConfig({ dims: { likeRate: { enabled: true, value: 0.1 } } })).toBe(true)
    expect(hasTagRecGroupConfig({ negative: { title: ['x'] } })).toBe(true)
    expect(hasTagRecGroupConfig({ negative: {} })).toBe(false)
    expect(hasTagRecGroupConfig({ pools: { allV2: { smallPoolThreshold: 5 } } })).toBe(true)
    expect(hasTagRecGroupConfig({ pools: {} })).toBe(false)
  })

  it('mergeTagRecNegativeRules (导入并入): 各槽身份键并集去重 + strict/allowEnabled 取 OR + 旧 partition 折叠', () => {
    const merged = mergeTagRecNegativeRules(
      {
        up: [{ name: 'UP甲', mid: 7 }],
        title: ['屏蔽词A'],
        tagIds: [{ id: 1, name: 't1' }],
        partitionBlock: [{ name: '游戏', v1: 4 }],
        // 旧形 partition{mode:'allow'} 折叠进仅看池 (存量数据读期兼容同链)
        partition: { mode: 'allow', list: [{ name: '动画', v1: 1 }] },
      },
      {
        up: [{ name: 'UP甲', mid: 7 }, { name: 'up乙' }],
        title: ['屏蔽词A', '屏蔽词B'],
        tagIds: [
          { id: 1, name: 't1-dup' },
          { id: 2, name: 't2' },
        ],
        strict: true,
        partitionBlock: [
          { name: '游戏', v1: 4 },
          { name: '音乐', v1: 3 },
        ],
        partitionAllow: { enabled: true, list: [{ name: '影视', v1: 5 }] },
      },
    )
    expect(merged).toEqual({
      tagIds: [
        { id: 1, name: 't1' },
        { id: 2, name: 't2' },
      ],
      strict: true,
      up: [{ name: 'UP甲', mid: 7 }, { name: 'up乙' }],
      title: ['屏蔽词A', '屏蔽词B'],
      partitionBlock: [
        { name: '游戏', v1: 4 },
        { name: '音乐', v1: 3 },
      ],
      // 仅看池: 旧形折叠项 + 新池项并集, enabled OR => true
      partitionAllow: {
        enabled: true,
        list: [
          { name: '动画', v1: 1 },
          { name: '影视', v1: 5 },
        ],
      },
    })
    expect(mergeTagRecNegativeRules(undefined, undefined)).toBeUndefined()
    expect(mergeTagRecNegativeRules({}, {})).toBeUndefined()
  })

  it('mergeTagRecScopeOverrideForImport (导入并入): 名单并集; 标量槽目标已有保留/缺则领养; 格槽逐键', () => {
    const out = mergeTagRecScopeOverrideForImport(
      { dims: { viewMin: { enabled: true, value: 100 } }, negative: { title: ['a'] } },
      {
        dims: { viewMin: { enabled: true, value: 999 } }, // 目标已有 => 不盖
        score: { weights: { likeRate: 2 } }, // 目标缺 => 领养
        smallPoolThreshold: 7,
        negative: { title: ['b'] },
        pools: { allV2: { smallPoolThreshold: 3 }, tagTop: { dims: { viewMin: { enabled: true, value: 1 } } } },
      },
    )
    expect(out?.dims).toEqual({ viewMin: { enabled: true, value: 100 } })
    expect(out?.score).toEqual({ weights: { likeRate: 2 } })
    expect(out?.smallPoolThreshold).toBe(7)
    expect(out?.negative?.title).toEqual(['a', 'b'])
    expect(out?.pools).toEqual({
      allV2: { smallPoolThreshold: 3 },
      tagTop: { dims: { viewMin: { enabled: true, value: 1 } } },
    })
    // 目标已有格槽不被入档盖
    const keep = mergeTagRecScopeOverrideForImport(
      { pools: { allV2: { smallPoolThreshold: 1 } } },
      { pools: { allV2: { smallPoolThreshold: 9 }, tagTop: { smallPoolThreshold: 2 } } },
    )
    expect(keep?.pools).toEqual({ allV2: { smallPoolThreshold: 1 }, tagTop: { smallPoolThreshold: 2 } })
    // src 空 => 原样返回 dst (undefined 透传)
    expect(mergeTagRecScopeOverrideForImport(undefined, undefined)).toBeUndefined()
  })
  // #endregion

  // #region 实修票①: 过滤生效签名 (service 侧「变 => 清跨轮 seenBvids」的触发器)
  it('computeTagRecFilterSignature: 生效链输入任一变 => 签名变; 与链无关字段/组序 => 稳定', () => {
    const core = createTagRecFactoryFilterCore()
    const gA = makeTagGroup({ id: 'a', name: '组A', tag_ids: [{ id: 1, name: 'x' }] })!
    const gB = makeTagGroup({ id: 'b', name: '组B', tag_ids: [{ id: 2, name: 'y' }] })!
    const l1 = makeTagL1Group({ id: 'l1', name: 'L1', enabled: true })!
    const sig = (over: Partial<Parameters<typeof computeTagRecFilterSignature>[0]> = {}) =>
      computeTagRecFilterSignature({ core, groups: [gA, gB], l1s: [l1], ...over })
    const base = sig()

    // 同输入恒等 + 组序无关 (链解析与表序无关)
    expect(sig({ groups: [gB, gA] })).toBe(base)

    // 全局: 维度变 / 总开关变 / 池槽变 各入签
    const dimCore = cloneTagRecFilterCore(core)
    dimCore.dims.viewMin = { enabled: true, value: 100 }
    expect(sig({ core: dimCore })).not.toBe(base)
    expect(sig({ core: { ...core, enabled: false } })).not.toBe(base)
    const poolCore = cloneTagRecFilterCore(core)
    poolCore.pools = { allV2: { smallPoolThreshold: 7 } }
    expect(sig({ core: poolCore })).not.toBe(base)
    // 会话覆盖副本有无即差
    expect(sig({ sessionCore: cloneTagRecFilterCore(core) })).not.toBe(base)

    // 组层: 负向顶层别名 / overrides.negative 容器 / 负向严格标 / 格槽 overrides / 改名 各入签
    const gNegAlias = makeTagGroup({
      id: 'a',
      name: '组A',
      tag_ids: [{ id: 1, name: 'x' }],
      negative_tag_ids: [{ id: 9, name: 'neg' }],
    })!
    expect(sig({ groups: [gNegAlias, gB] })).not.toBe(base)
    const gNegOv = { ...gA, overrides: { negative: { tagIds: [{ id: 9, name: 'neg' }] } } }
    expect(sig({ groups: [gNegOv, gB] })).not.toBe(base)
    const gStrict = { ...gA, negative_strict: true }
    expect(sig({ groups: [gStrict, gB] })).not.toBe(base)
    const gDimOv = { ...gA, overrides: { dims: { viewMin: { enabled: true, value: 5 } } } }
    expect(sig({ groups: [gDimOv, gB] })).not.toBe(base)
    expect(sig({ groups: [{ ...gA, name: '组A2' }, gB] })).not.toBe(base) // 链按名解析 => 改名=链变

    // L1 overrides 入签; 草稿兜底组伪形入签
    const l1Ov = { ...l1, overrides: { dims: { viewMax: { enabled: true, value: 9 } } } }
    expect(sig({ l1s: [l1Ov] })).not.toBe(base)
    const draft = { name: 'd', negative_tag_ids: [{ id: 7, name: 'n' }], negative_strict: true }
    expect(sig({ fallbackGroup: draft })).not.toBe(base)

    // 与生效链无关的字段不入签: tag_ids 成员/weight/id 变 (语境签名另管全清) 不得误触发过滤复位
    const gSameChain = makeTagGroup({ id: 'zzz', name: '组A', tag_ids: [{ id: 99, name: 'w' }], weight: 5 })!
    expect(sig({ groups: [gSameChain, gB] })).toBe(base)
    expect(sig({ groups: [{ ...gA, addedAt: 1 }, gB] })).toBe(base)
  })
  // #endregion

  // #region R6: 槽位存盘组装 (applyTagRecScopeEntries*)
  describe('applyTagRecScopeEntriesToGroupOverrides (R6 槽位组装)', () => {
    const prev: TagRecGroupOverrides = {
      dims: { viewMin: { enabled: true, value: 100 } },
      score: { weights: { view: 2 } },
      smallPoolThreshold: 9,
      negative: { up: [{ name: 'UP甲' }] },
    }

    it('只开格槽保存: 组级三键与名单原样保留 (旧实现误清 bug 回归)', () => {
      const next = applyTagRecScopeEntriesToGroupOverrides(prev, [
        { key: 'cell:allV2', patch: { dims: { likeRate: { enabled: true, value: 0.05 } } } },
      ])!
      expect(next.dims).toEqual(prev.dims)
      expect(next.score).toEqual(prev.score)
      expect(next.smallPoolThreshold).toBe(9)
      expect(next.negative).toEqual(prev.negative)
      expect(next.pools).toEqual({ allV2: { dims: { likeRate: { enabled: true, value: 0.05 } } } })
    })

    it('组槽三键整槽替换: patch 缺键 = 摘回继承 (重置静默失效防呆)', () => {
      // 用户把 score 全重置回继承: patch 只含 dims → 旧 score 槽必须清掉而非残留
      const next = applyTagRecScopeEntriesToGroupOverrides(prev, [
        { key: 'group', patch: { dims: { viewMin: { enabled: true, value: 50 } } }, negative: prev.negative },
      ])!
      expect(next.dims).toEqual({ viewMin: { enabled: true, value: 50 } })
      expect(next.score).toBeUndefined()
      expect(next.smallPoolThreshold).toBeUndefined()
      expect(next.negative).toEqual(prev.negative)
    })

    it('组槽全重置: patch 与名单皆空 => 槽键全摘; 仅剩 pools 时容器保留', () => {
      const next = applyTagRecScopeEntriesToGroupOverrides({ ...prev, pools: { tagTop: { smallPoolThreshold: 3 } } }, [
        { key: 'group' },
      ])!
      expect(next).toEqual({ pools: { tagTop: { smallPoolThreshold: 3 } } })
      const empty = applyTagRecScopeEntriesToGroupOverrides({ dims: prev.dims }, [{ key: 'group' }])
      expect(empty).toBeUndefined()
    })

    it('格槽摘槽: patch 缺 = pools[P] 删键; pools 全空连容器摘', () => {
      const next = applyTagRecScopeEntriesToGroupOverrides(
        { pools: { tagTop: { smallPoolThreshold: 3 }, allV2: { smallPoolThreshold: 5 } } },
        [{ key: 'cell:tagTop' }],
      )!
      expect(next.pools).toEqual({ allV2: { smallPoolThreshold: 5 } })
      const none = applyTagRecScopeEntriesToGroupOverrides({ pools: { tagTop: { smallPoolThreshold: 3 } } }, [
        { key: 'cell:tagTop' },
      ])
      expect(none).toBeUndefined()
    })

    it('L1 版: 单槽语义同口径 (只动 l1 键, 未开槽原样)', () => {
      const prevL1: TagRecL1Overrides = {
        dims: { viewMin: { enabled: true, value: 100 } },
        negative: { title: ['词'] },
      }
      const untouched = applyTagRecScopeEntriesToL1Overrides(prevL1, [])
      expect(untouched).toEqual(prevL1)
      const next = applyTagRecScopeEntriesToL1Overrides(prevL1, [{ key: 'l1', patch: { smallPoolThreshold: 12 } }])!
      expect(next.dims).toBeUndefined()
      expect(next.smallPoolThreshold).toBe(12)
      expect(next.negative).toBeUndefined()
    })

    it('底稿不污染: prev 不被就地改 (cloneDeep 副本)', () => {
      const frozen = structuredClone(prev)
      applyTagRecScopeEntriesToGroupOverrides(prev, [{ key: 'group' }])
      expect(prev).toEqual(frozen)
    })
  })
  // #endregion

  // #region R8 仅看家族 (upAllow/titleAllow/descAllow) + 池筛选 (poolsEnabled)
  describe('R8 仅看家族 (域收窄: 缺字段 miss, 非严格豁免 / strict 反转; 屏蔽先判赢)', () => {
    const evalWith = (cfg: TagRecFilterCore, it: TagRecItemExtend) => {
      const resolve = createTagRecScopeResolver({ core: cfg, groupsByName: new Map() })
      return evalTagRecItem(it, resolve)
    }

    it('.upAllow: 命中放行 (mid 主判/名兜底); 未命中拒; 缺字段 miss; 空表/关闸不生效', () => {
      const c = baseCfg()
      c.dims.upAllow = { enabled: true, list: [{ name: 'UP甲' }, { mid: 777, name: '' }] }
      const hitName = item('v', { view: 1 }, { owner: { name: 'UP甲', mid: 1 } })
      const hitMid = item('w', { view: 1 }, { owner: { name: '别的名', mid: 777 } })
      const miss = item('x', { view: 1 }, { owner: { name: 'UP乙', mid: 2 } })
      const noOwner = item('y', { view: 1 }, { owner: undefined })
      expect(evalWith(c, hitName).pass).toBe(true)
      expect(evalWith(c, hitMid).pass).toBe(true)
      const r = evalWith(c, miss)
      expect(r.pass).toBe(false)
      expect(r.drop?.dim).toBe('upAllow')
      expect(evalWith(c, noOwner).pass).toBe(true) // miss 非严格豁免
      expect(evalWith({ ...c, strictMode: true }, noOwner).pass).toBe(false) // strict 反转
      const cEmpty = baseCfg()
      cEmpty.dims.upAllow = { enabled: true, list: [] }
      expect(evalWith(cEmpty, miss).pass).toBe(true) // 空表不生效
      const cOff = baseCfg()
      cOff.dims.upAllow = { enabled: false, list: [{ name: 'UP甲' }] }
      expect(evalWith(cOff, miss).pass).toBe(true) // 关闸不生效
    })

    it('.titleAllow: 子串命中放行; 未命中拒; 标题缺 miss', () => {
      const c = baseCfg()
      c.dims.titleAllow = { enabled: true, list: ['实况'] }
      expect(evalWith(c, item('v', { view: 1 }, { title: '某某实况录像' })).pass).toBe(true)
      const r = evalWith(c, item('w', { view: 1 }, { title: '攻略' }))
      expect(r.pass).toBe(false)
      expect(r.drop?.dim).toBe('titleAllow')
      expect(evalWith(c, item('x', { view: 1 }, { title: '' })).pass).toBe(true) // miss 豁免
    })

    it('.descAllow 统一语义: v2 池命中放行/未命中拒; tag/top 无 desc => miss (非严格豁免 / strict 杀)', () => {
      const c = baseCfg()
      c.dims.descAllow = { enabled: true, list: ['预约'] }
      const v2hit = item('v', { view: 1 }, { desc: '本期预约开启', source: { via: 'all-v2-exact', groupNames: ['G'] } })
      const v2miss = item('w', { view: 1 }, { desc: '无关键字', source: { via: 'all-v2-exact', groupNames: ['G'] } })
      const tagTop = item('x', { view: 1 }, { desc: undefined, source: { via: 'tag-top', groupNames: ['G'] } })
      expect(evalWith(c, v2hit).pass).toBe(true)
      const r = evalWith(c, v2miss)
      expect(r.pass).toBe(false)
      expect(r.drop?.dim).toBe('descAllow')
      expect(evalWith(c, tagTop).pass).toBe(true) // 统一语义: 缺字段 miss 豁免 (不硬编码池豁免)
      expect(evalWith({ ...c, strictMode: true }, tagTop).pass).toBe(false) // strict 反转
    })

    it('屏蔽先判赢: 同实体两池同存 => 屏蔽维先归因', () => {
      const c = baseCfg()
      c.dims.upBlacklist = { enabled: true, list: [{ name: 'UP甲' }] }
      c.dims.upAllow = { enabled: true, list: [{ name: 'UP乙' }] }
      const r = evalWith(c, item('v', { view: 1 }, { owner: { name: 'UP甲', mid: 1 } }))
      expect(r.pass).toBe(false)
      expect(r.drop?.dim).toBe('upBlacklist') // 屏蔽排前
    })

    it('组级 upAllow 就近覆盖全局 (L2 开且非空 => 全局失效)', () => {
      const c = baseCfg()
      c.dims.upAllow = { enabled: true, list: [{ name: '全局UP' }] }
      const g = makeTagGroup({
        name: 'G',
        tag_ids: [{ id: 1, name: 'x' }],
        overrides: { negative: { upAllow: { enabled: true, list: [{ name: '组UP' }] } } },
      })!
      const resolve = createTagRecScopeResolver({ core: c, groupsByName: new Map([['G', g]]) })
      const src = { via: 'tag-top' as const, groupNames: ['G'] }
      expect(
        evalTagRecItem(item('v', { view: 1 }, { owner: { name: '组UP', mid: 1 }, source: src }), resolve).pass,
      ).toBe(true)
      expect(
        evalTagRecItem(item('w', { view: 1 }, { owner: { name: '全局UP', mid: 2 }, source: src }), resolve).pass,
      ).toBe(false)
    })

    it('draft 归一: {enabled,list} 整体存; up 条目 trim; 词表去重', () => {
      const n = normalizeTagRecNegativeDraft({
        upAllow: { enabled: true, list: [{ name: '  UP甲  ' }, { name: '', mid: 5 }] },
        titleAllow: { enabled: false, list: [' 实况 ', '实况'] },
        descAllow: { enabled: true, list: ['预约'] },
      })!
      expect(n.upAllow).toEqual({ enabled: true, list: [{ name: 'UP甲' }, { name: '', mid: 5 }] })
      expect(n.titleAllow).toEqual({ enabled: false, list: ['实况'] })
      expect(n.descAllow).toEqual({ enabled: true, list: ['预约'] })
    })

    it('merge 并入: 列表并集去重; enabled 取 OR (同 partitionAllow 口径)', () => {
      const m = mergeTagRecNegativeRules(
        { upAllow: { enabled: false, list: [{ name: 'A' }] }, titleAllow: { enabled: true, list: ['x'] } },
        {
          upAllow: { enabled: true, list: [{ name: 'A' }, { name: 'B' }] },
          titleAllow: { enabled: false, list: ['y'] },
        },
      )!
      expect(m.upAllow).toEqual({ enabled: true, list: [{ name: 'A' }, { name: 'B' }] })
      expect(m.titleAllow).toEqual({ enabled: true, list: ['x', 'y'] })
      expect(hasTagRecGroupConfig({ poolsEnabled: { tagTop: false } })).toBe(true)
      expect(hasTagRecGroupConfig({ poolsEnabled: { tagTop: true } })).toBe(true)
    })
  })

  describe('R8 兼容收敛 (站点旧编辑器形状 => 规范形, 读侧就地)', () => {
    it('up 字符串条目 => {name}; partitionBlock {enabled,list} 包装 => 裸数组; 分区字符串名 => 表解析条目', () => {
      const legacyUp: unknown = ['UP甲', 'UP乙']
      const legacyBlock: unknown = { enabled: true, list: ['游戏'] }
      const g = makeTagGroup({
        name: 'G',
        tag_ids: [{ id: 1, name: 'x' }],
        overrides: {
          negative: {
            up: legacyUp as never,
            partitionBlock: legacyBlock as never,
          },
        },
      })!
      const merged = groupNegativeMerged(g)
      expect(merged.up).toEqual([{ name: 'UP甲' }, { name: 'UP乙' }])
      expect(Array.isArray(merged.partitionBlock)).toBe(true)
      expect(merged.partitionBlock).toHaveLength(1)
      expect(merged.partitionBlock![0].name).toBe('游戏')
      expect(merged.partitionBlock![0].v1 !== undefined || merged.partitionBlock![0].v2 !== undefined).toBe(true)
      // 表解析不到的字符串条目丢弃 (不冒充可判条目)
      const g2 = makeTagGroup({
        name: 'G2',
        tag_ids: [{ id: 2, name: 'y' }],
        overrides: { negative: { partitionBlock: ['不存在的分区名'] as never } },
      })!
      expect(groupNegativeMerged(g2).partitionBlock).toEqual([])
      // 无变化路径返回原引用 (免 churn)
      const plain = { up: [{ name: 'A' }] }
      expect(coerceTagRecNegativeShapes(plain)).toBe(plain)
    })

    it('draft 归一走收敛: 字符串 up / 包装 partitionBlock 经 normalizeTagRecNegativeDraft 得规范形', () => {
      const legacyUp: unknown = ['UP甲']
      const legacyBlock: unknown = { enabled: true, list: ['游戏'] }
      const n = normalizeTagRecNegativeDraft({
        up: legacyUp as never,
        partitionBlock: legacyBlock as never,
      })!
      expect(n.up).toEqual([{ name: 'UP甲', mid: undefined }])
      expect(Array.isArray(n.partitionBlock)).toBe(true)
      expect(n.partitionBlock![0].name).toBe('游戏')
    })
  })

  describe('R8 池筛选 (poolsEnabled: 纯产出层, 后台照取照算)', () => {
    it('eval: 关掉的池条目拒 (dim poolFilter); 其余池照常', () => {
      const c = baseCfg()
      c.poolsEnabled = { allV2Related: false }
      const resolve = createTagRecScopeResolver({ core: c, groupsByName: new Map() })
      const related = item('v', { view: 1 }, { source: { via: 'all-v2-related', groupNames: ['G'] } })
      const exact = item('w', { view: 1 }, { source: { via: 'all-v2-exact', groupNames: ['G'] } })
      const r = evalTagRecItem(related, resolve)
      expect(r.pass).toBe(false)
      expect(r.drop?.dim).toBe('poolFilter')
      expect(evalTagRecItem(exact, resolve).pass).toBe(true)
    })

    it('链解析: 本次 > 组 > L1 > 全局 逐池就近；本次未声明继续继承', () => {
      const c = baseCfg()
      c.poolsEnabled = { tagTop: false }
      const l1 = makeTagL1Group({ name: 'L1', overrides: { poolsEnabled: { tagTop: true, allV2: false } } })!
      const g = makeTagGroup({
        name: 'G',
        tag_ids: [{ id: 1, name: 'x' }],
        l1Id: l1.id,
        overrides: { poolsEnabled: { allV2: true } },
      })!
      const eff = resolveTagRecEffective(c, 'tagTop', g, l1)
      expect(eff.poolsEnabled.tagTop).toBe(true) // 组未声明 => L1 true 覆盖全局 false
      expect(eff.poolsEnabled.allV2).toBe(true) // 组声明 true 覆盖 L1 false
      expect(eff.poolsEnabled.allV2Related).toBe(true) // 缺省=取
      const gNoL1 = makeTagGroup({ name: 'G2', tag_ids: [{ id: 2, name: 'y' }] })!
      expect(resolveTagRecEffective(c, 'tagTop', gNoL1).poolsEnabled.tagTop).toBe(false) // 无声明 => 全局
      const session = createTagRecFactoryFilterCore()
      session.poolsEnabled = { allV2: false }
      const effSession = resolveTagRecEffective(c, 'tagTop', g, l1, session)
      expect(effSession.poolsEnabled.tagTop).toBe(true) // 本次未声明 => 继承 L1
      expect(effSession.poolsEnabled.allV2).toBe(false) // 会话声明生效
    })
  })
  // #endregion
})

/**
 * 小池降级「相关兜底放行」(2026-10-06): 池浅 (filterStats.degraded) 时放行 related 路由
 * (搜索相关/推荐相关) 的组合 mismatch —— 恢复工作台之前的语义: 相关条带「相关」徽标交付、
 * 不冒充命中标签; 精确/标签池的 mismatch、组合排除/屏蔽、全局排除、来源闸一概不受影响。
 */
describe('$modules/tag-rec/model/filter-engine 小池相关兜底放行', () => {
  const combinationWithTag = () => {
    const c = newTagRecCombination()
    addTagRecCondition(c, tagRecConditionAtom('tag', { id: 7, name: 'kingexit' }))
    return c
  }
  const groupWith = (combination: ReturnType<typeof combinationWithTag>) =>
    makeTagGroup({ id: 'g1', name: 'G', tag_ids: [{ id: 7, name: 'kingexit' }], combination })!
  const relatedItem = (bvid: string, extra: Partial<TagRecItemExtend> = {}) =>
    item(bvid, {}, { source: { via: 'all-v2-related', groupNames: ['G'] }, ownTagNames: ['RPG'], ...extra })

  it('池浅时 related 路由 mismatch 放行; 精确/标签池 mismatch 仍拒 (不冒充命中)', () => {
    const resolve = createTagRecScopeResolver({
      core: baseCfg(),
      groupsByName: new Map([['G', groupWith(combinationWithTag())]]),
    })
    const related = relatedItem('BV-related')
    const exact = item('BV-exact', {}, { source: { via: 'all-v2-exact', groupNames: ['G'] }, ownTagNames: ['RPG'] })
    // 缺省 (未降级): 相关条也按「已确认不符」拒绝
    expect(evalTagRecItem(related, resolve, { deferPartitions: true }).pass).toBe(false)
    // 池浅 + relatedFallback: 相关路由放行
    expect(evalTagRecItem(related, resolve, { deferPartitions: true, relatedFallback: true }).pass).toBe(true)
    // 精确路由不被兜底: 关键词/搜索命中不能证明标签
    expect(evalTagRecItem(exact, resolve, { deferPartitions: true, relatedFallback: true }).pass).toBe(false)
  })

  it('合并认领 (exact 主路 + related claim) 不被 related 兜底赦免 mismatch —— 徽标会冒充命中', () => {
    const resolve = createTagRecScopeResolver({
      core: baseCfg(),
      groupsByName: new Map([['G', groupWith(combinationWithTag())]]),
    })
    const mixed = item(
      'BV-mixed',
      {},
      {
        source: {
          via: 'all-v2-exact',
          groupNames: ['G'],
          claims: [
            { via: 'all-v2-exact', groupNames: ['G'], srcRank: 0 },
            { via: 'all-v2-related', groupNames: ['G·相关'], srcRank: 1 },
          ],
        },
        ownTagNames: ['RPG'],
      },
    )
    // 条目有可证认领 (allV2) => mismatch 是实锤, 附带的 related claim 不得赦免;
    //   否则徽标按主路由显示「搜索」, 兜底放行不可见 (违背「不冒充命中」)
    expect(evalTagRecItem(mixed, resolve, { deferPartitions: true, relatedFallback: true }).pass).toBe(false)
  })

  it('命中组合排除的相关条目不被兜底 (排除绝对, 设计稿 B04)', () => {
    const combination = combinationWithTag()
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', '广告'))
    const resolve = createTagRecScopeResolver({
      core: baseCfg(),
      groupsByName: new Map([['G', groupWith(combination)]]),
    })
    const blocked = relatedItem('BV-blocked', { desc: '含广告内容', fieldEvidence: { desc: 'complete' } })
    const clean = relatedItem('BV-clean', { desc: '正常简介', fieldEvidence: { desc: 'complete' } })
    expect(evalTagRecItem(blocked, resolve, { deferPartitions: true, relatedFallback: true }).pass).toBe(false)
    expect(evalTagRecItem(clean, resolve, { deferPartitions: true, relatedFallback: true }).pass).toBe(true)
  })
})

/**
 * 交集收窄 (根「全部命中」× ≥2 直属 tag 分支): tagTop/allV2Related/archiveRelated 缺省档
 * 改「不取」把火力集中 allV2 精准搜索池, 显式声明照常胜出;
 * 兜底衔接处 related 条的 unknown 随降级放行 (停补查后它们只能停在 unknown)。
 */
describe('$modules/tag-rec/model/filter-engine 交集收窄', () => {
  const intersectionCombo = () => {
    const c = newTagRecCombination()
    addTagRecCondition(c, tagRecConditionAtom('tag', { id: 1, name: '至冬' }))
    c.include.children.push({
      kind: 'group',
      id: 'sub-cos',
      mode: 'any',
      children: [tagRecConditionAtom('tag', { id: 2, name: 'cos' })],
    })
    return c
  }
  const groupWith = (combination: ReturnType<typeof intersectionCombo>) =>
    makeTagGroup({ id: 'gi', name: 'G', tag_ids: [{ id: 1, name: '至冬' }], combination })!

  it('resolver: 交集链只留 allV2 精准搜索池缺省开, 显式声明照常胜出; 非交集组合不收窄', () => {
    const c = baseCfg()
    const g = groupWith(intersectionCombo())
    const eff = resolveTagRecEffective(c, 'allV2', g)
    expect(eff.intersection).toBe(true)
    expect(eff.poolsEnabled.tagTop).toBe(false)
    expect(eff.poolsEnabled.allV2).toBe(true)
    expect(eff.poolsEnabled.allV2Related).toBe(false)
    expect(eff.poolsEnabled.archiveRelated).toBe(false)
    // 显式「使用」(任何层声明) 可开回 —— 收窄池也一样
    const session = createTagRecFactoryFilterCore()
    session.poolsEnabled = { tagTop: true, archiveRelated: true }
    const effSession = resolveTagRecEffective(c, 'allV2', g, undefined, session)
    expect(effSession.poolsEnabled.tagTop).toBe(true)
    expect(effSession.poolsEnabled.archiveRelated).toBe(true)
    expect(effSession.poolsEnabled.allV2Related).toBe(false) // 未声明的仍收窄
    // 非交集组合: 全池缺省照常
    const plain = newTagRecCombination()
    addTagRecCondition(plain, tagRecConditionAtom('tag', { id: 1, name: '至冬' }))
    const effPlain = resolveTagRecEffective(c, 'allV2', groupWith(plain))
    expect(effPlain.intersection).toBeFalsy()
    expect(effPlain.poolsEnabled.tagTop).toBe(true)
    expect(effPlain.poolsEnabled.archiveRelated).toBe(true)
  })

  it('兜底衔接: 交集链 related 条 unknown 随降级放行; 非交集 unknown 仍待核实', () => {
    const c = baseCfg()
    // 交集下相关池缺省收窄 —— related 兜底路由只在显式开回池时才有来路
    c.poolsEnabled = { archiveRelated: true }
    const resolve = createTagRecScopeResolver({
      core: c,
      groupsByName: new Map([['G', groupWith(intersectionCombo())]]),
    })
    const unknown = item('BV-arch', fullStat, { source: { via: 'archive-related', groupNames: ['G'] } })
    // 未降级: 待核实仍拒
    expect(evalTagRecItem(unknown, resolve, { deferPartitions: false }).pass).toBe(false)
    // 降级: 交集 + related 路由 => unknown 随兜底放行
    expect(evalTagRecItem(unknown, resolve, { deferPartitions: false, relatedFallback: true }).pass).toBe(true)
    // 非交集链: unknown 不吃兜底 (相关条照旧需要证据补查)
    const plain = newTagRecCombination()
    addTagRecCondition(plain, tagRecConditionAtom('tag', { id: 1, name: '至冬' }))
    const plainResolve = createTagRecScopeResolver({
      core: baseCfg(),
      groupsByName: new Map([['G', groupWith(plain)]]),
    })
    expect(evalTagRecItem(unknown, plainResolve, { deferPartitions: false, relatedFallback: true }).pass).toBe(false)
  })
})

/**
 * 生效值归因 (wayfinding 003): 会话位拆「组合.filters → 会话」两层顺序应用,
 * 键存在性回放得逐字段胜者层。面板「生效值表」的数据源。
 */
describe('$modules/tag-rec/model/filter-engine 生效值归因 provenance', () => {
  const dim = (value: number) => ({ enabled: true, value })

  it('逐字段胜者层: 池<L1<组<格<会话位<会话格; 等值声明也占层', () => {
    const c = baseCfg()
    c.dims.viewMin = dim(100)
    c.pools = { tagTop: { dims: { viewMin: dim(200) } } }
    const l1 = makeTagL1Group({ name: 'L1', overrides: { dims: { viewMin: dim(300) } } })!
    const g = makeTagGroup({
      name: 'G',
      tag_ids: [{ id: 1, name: 'x' }],
      l1Id: l1.id,
      overrides: { dims: { viewMin: dim(400) } },
    })!
    const eff = resolveTagRecEffectiveProvenance(c, 'tagTop', g, l1)
    expect(eff.cfg.dims.viewMin.value).toBe(400)
    expect(eff.prov.dims.viewMin).toBe('l2')
    // 格槽再压组层; 同值覆盖同样计声明
    const g2 = { ...g, overrides: { ...g.overrides, pools: { tagTop: { dims: { viewMin: dim(400) } } } } }
    expect(resolveTagRecEffectiveProvenance(c, 'tagTop', g2, l1).prov.dims.viewMin).toBe('cell')
    // 会话格最高
    const session = { dims: {}, pools: { tagTop: { dims: { viewMin: dim(500) } } } }
    const eff2 = resolveTagRecEffectiveProvenance(c, 'tagTop', g2, l1, session)
    expect(eff2.cfg.dims.viewMin.value).toBe(500)
    expect(eff2.prov.dims.viewMin).toBe('sessionCell')
    // 未声明键不记账: viewMax 无任何层声明 => 无条目 (面板归「全局/出厂」)
    expect(eff2.prov.dims.viewMax).toBeUndefined()
  })

  it('组合.filters 与会话拆层归因: 同位两层, 会话赢但来源各记', () => {
    const c = baseCfg()
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 7, name: 'kingexit' }))
    combo.filters = { dims: { viewMin: dim(5000) }, poolsEnabled: { archiveRelated: false } }
    const g = makeTagGroup({ id: 'gc', name: 'G', tag_ids: [{ id: 7, name: 'kingexit' }], combination: combo })!
    const session = { dims: { viewMin: dim(8000) } }
    const eff = resolveTagRecEffectiveProvenance(c, 'tagTop', g, undefined, session)
    // 会话赢值, 但归因各记各层
    expect(eff.cfg.dims.viewMin.value).toBe(8000)
    expect(eff.prov.dims.viewMin).toBe('session')
    expect(eff.prov.poolsEnabled.archiveRelated).toBe('combination')
    expect(eff.poolsEnabled.archiveRelated).toBe(false)
    // 与生产口径等价: resolve(合并 patch) === provenance 拆解
    const merged = resolveTagRecEffective(
      c,
      'tagTop',
      g,
      undefined,
      mergeTagRecCombinationFilters(combo.filters, session),
    )
    expect(eff.cfg.dims.viewMin.value).toBe(merged.cfg.dims.viewMin.value)
    expect(eff.poolsEnabled).toEqual(merged.poolsEnabled)
    expect(eff.neg.tagIds).toEqual(merged.neg.tagIds)
  })

  it('组合.filters 声明名单维时来源标「组合」而非「会话」', () => {
    const c = baseCfg()
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 7, name: 'kingexit' }))
    combo.filters = { dims: { titleKeywords: { enabled: true, list: ['组合词'] } } }
    const g = makeTagGroup({ id: 'gl', name: 'G', tag_ids: [{ id: 7, name: 'kingexit' }], combination: combo })!
    const eff = resolveTagRecEffectiveProvenance(c, 'tagTop', g)
    expect(eff.neg.title.map((e) => e.v)).toEqual(['组合词'])
    expect(eff.neg.title[0].scope).toBe('组合')
  })

  it('smallPoolThreshold/enabled/poolsEnabled 归因 + 交集派生层标 derived', () => {
    const c = baseCfg()
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', { id: 1, name: '至冬' }))
    combo.include.children.push({
      kind: 'group',
      id: 'sub-cos',
      mode: 'any',
      children: [tagRecConditionAtom('tag', { id: 2, name: 'cos' })],
    })
    const g = makeTagGroup({ id: 'gi', name: 'G', tag_ids: [{ id: 1, name: '至冬' }], combination: combo })!
    const eff = resolveTagRecEffectiveProvenance(c, 'allV2', g)
    expect(eff.intersection).toBe(true)
    expect(eff.prov.poolsEnabled.tagTop).toBe('derived')
    expect(eff.prov.poolsEnabled.allV2).toBe('derived') // 交集缺省档 (值 true 也是派生)
    // 组层声明阈值 => l2; 会话声明开关 => session
    const g2 = { ...g, overrides: { smallPoolThreshold: 5 } }
    const eff2 = resolveTagRecEffectiveProvenance(c, 'allV2', g2, undefined, { dims: {}, enabled: false })
    expect(eff2.prov.smallPoolThreshold).toBe('l2')
    expect(eff2.prov.enabled).toBe('session')
    expect(eff2.cfg.enabled).toBe(false)
    // 组显式开回收窄池 => l2 胜出 derived
    const g3 = { ...g, overrides: { poolsEnabled: { tagTop: true } } }
    expect(resolveTagRecEffectiveProvenance(c, 'allV2', g3).prov.poolsEnabled.tagTop).toBe('l2')
  })
})

/**
 * 票 001 漂移守卫: 交付档位映射 (`service/item-order.ts` 的 TIER_BY_VIA, 叶子模块本地维护)
 * 必须与 `poolOfVia` 同口径 —— 两张表一旦分叉, 首屏档位顺序就会悄悄错位 (评审指出)。
 */
describe('交付档位与 poolOfVia 同口径 (001 漂移守卫)', () => {
  const vias = ['tag-top', 'all-v2-exact', 'up-search', 'all-v2-related', 'archive-related'] as const
  const poolTierOrder = ['tagTop', 'allV2', 'allV2Related', 'archiveRelated']
  it('每个 via 的池序 = 档位序 (up-search 与 all-v2-exact 同池同档)', async () => {
    const { poolOfVia } = await import('./filter-engine')
    const { tagRecDeliveryTierOf } = await import('../service/item-order')
    const tierOf = (via: (typeof vias)[number]) => tagRecDeliveryTierOf({ source: { via } } as never)
    for (const via of vias) {
      expect(poolTierOrder.indexOf(poolOfVia(via)), via).toBe(tierOf(via))
    }
  })
})
