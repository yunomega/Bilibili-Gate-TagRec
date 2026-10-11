import { describe, expect, it, vi } from 'vitest'
import { addTagRecCondition, newTagRecCombination, tagRecConditionAtom } from './combination'
import { createTagRecFactoryDims, createTagRecFactoryFilterCore, type TagRecFilterSettings } from './filter-engine'
import { parseTagRecConfig, type TagRecConfigExportV1 } from './import-export'
import {
  buildMyShareRows,
  buildShareEditUrl,
  buildSharePageUrl,
  buildSharePatchBody,
  buildSharePayload,
  buildSharePkgPayload,
  collectSharePositiveTagIds, // [tag-rec] 票 31
  createShareFactoryFilterConfig,
  expandShareSelection,
  extractShareImportFromText,
  formatShareUpdatedAgo, // [tag-rec] 票 31
  isShareFactoryFilterConfig,
  normalizeShareLikeActed, // [tag-rec] 票 19
  normalizeShareRejections,
  normalizeShareTokenEntries,
  parseSharePkgForEdit,
  planShareImport,
  preflightShareIssues,
  probeOutcomeToRemote,
  removeShareToken,
  resolveShareImportL1Enabled, // [tag-rec] 分享导入 L1 反向取消
  resolveShareLikePrompt, // [tag-rec] 票 19
  SHARE_GUARD_LIMITS,
  SHARE_LIKE_ACTED_MAX, // [tag-rec] 票 19
  upsertShareLikeActed, // [tag-rec] 票 19
  upsertShareToken,
  type ShareLikeActed, // [tag-rec] 票 19
} from './share'
import type { TagBlacklistEntry, TagGroup, TagIdEntry, TagL1Group, TagTheme } from './types'

// filter-engine -> _pipeline -> endpoints/$common 触浏览器环境; 纯函数测试以 mock 隔掉 (同 import-export.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const e = (id: number, name = `tag${id}`): TagIdEntry => ({ id, name })
const g = (id: string, ids: number[], extra: Partial<TagGroup> = {}): TagGroup => ({
  id,
  name: id,
  tag_ids: ids.map((id) => e(id)),
  weight: 1,
  enabled: true,
  addedAt: 100,
  ...extra,
})
const l1 = (id: string, extra: Partial<TagL1Group> = {}): TagL1Group => ({
  id,
  name: `一级${id}`,
  enabled: true,
  weight: 1,
  addedAt: 50,
  ...extra,
})
const theme = (id: string): TagTheme => ({ id, name: `主题${id}`, addedAt: 10 })
const bl = (id: number): TagBlacklistEntry => ({ id, name: `bl${id}` })

describe('$modules/tag-rec/model/share — 勾选集展开 (票 16 tag-share)', () => {
  const groups = [
    g('g1', [1], { l1Id: 'A' }),
    g('g2', [2], { l1Id: 'A' }),
    g('g3', [3], { l1Id: 'B' }),
    g('g4', [4]), // 裸奔组 (防御态)
  ]

  it('L2 勾选 = 该项本身; L1 勾选 = 麾下全部 L2 (整棵子树)', () => {
    expect(expandShareSelection({ l1Ids: [], groupIds: ['g3'] }, groups).map((x) => x.id)).toEqual(['g3'])
    expect(expandShareSelection({ l1Ids: ['A'], groupIds: [] }, groups).map((x) => x.id)).toEqual(['g1', 'g2'])
  })

  it('混选 = 并集 (勾中 L2 ∪ 勾中 L1 麾下); 同组去重保序 (favorites 序)', () => {
    // g1 既被 L2 直勾又是 L1-A 麾下 => 只出一次, 按 favorites 序
    expect(expandShareSelection({ l1Ids: ['A'], groupIds: ['g1', 'g3'] }, groups).map((x) => x.id)).toEqual([
      'g1',
      'g2',
      'g3',
    ])
  })

  it('空 L1 / 失效 id => 空集; 裸奔组不被 L1 勾选卷入', () => {
    expect(expandShareSelection({ l1Ids: ['EMPTY'], groupIds: [] }, groups)).toEqual([])
    expect(expandShareSelection({ l1Ids: ['A'], groupIds: [] }, groups).map((x) => x.id)).not.toContain('g4')
    expect(expandShareSelection({ l1Ids: [], groupIds: [] }, groups)).toEqual([])
  })
})

describe('$modules/tag-rec/model/share — payload 裁剪', () => {
  const l1s = [
    l1('A', { themeId: 't1' }),
    l1('B', { themeId: 't2' }),
    l1('C'), // 未被引用的 L1 => 应裁掉
  ]
  const themes = [theme('t1'), theme('t2'), theme('t3')] // t3 未被引用 => 应裁掉
  const groups = [
    g('g1', [1, 2], { l1Id: 'A', name: '组一' }),
    g('g2', [3], { l1Id: 'B', name: '组二' }),
    g('g3', [4], { l1Id: 'ghost-l1', name: '悬挂组' }), // l1Id 指向节外 => 悬挂引用保原值
    g('g4', [5], { name: '无归属组' }),
  ]
  const blacklist = [bl(9), bl(10)]

  it('l1/themes 裁到被勾组实际归属链; 悬挂引用保原值', () => {
    const p = buildSharePayload({
      groups: [groups[0], groups[2]],
      l1: l1s,
      themes,
      blacklist,
      includeBlacklist: true,
    })
    expect(p.version).toBe(2) // The marketplace still accepts the legacy contract.
    expect(p.favorites.map((x) => x.id)).toEqual(['g1', 'g3'])
    // l1: 只收实际被引用的 A; 悬挂 l1Id (ghost-l1) 节内无对应节点, 组上引用原样保留
    expect(p.l1.map((x) => x.id)).toEqual(['A'])
    expect(p.favorites[1].l1Id).toBe('ghost-l1')
    // themes: A.themeId=t1 => 只收 t1; t2/t3 裁掉
    expect(p.themes?.map((x) => x.id)).toEqual(['t1'])
    expect(p.l1[0].themeId).toBe('t1')
    expect(p.blacklist).toEqual(blacklist)
    // 视图态不携: activeThemeId 键缺席 (导入侧不动当前主题)
    expect('activeThemeId' in p).toBe(false)
  })

  it('l1 上悬挂 themeId 保原值但 themes 节无对应节点 (planTagRecImport 兜底)', () => {
    const dangling = [l1('X', { themeId: 'ghost-theme' })]
    const p = buildSharePayload({
      groups: [g('gx', [1], { l1Id: 'X' })],
      l1: dangling,
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })
    expect(p.l1.map((x) => x.id)).toEqual(['X'])
    expect(p.l1[0].themeId).toBe('ghost-theme')
    expect(p.themes).toEqual([])
  })

  it('黑名单随勾选含/空; filterConfig 出厂占位 (无私配)', () => {
    const withBl = buildSharePayload({ groups: [groups[0]], l1: l1s, themes, blacklist, includeBlacklist: true })
    const withoutBl = buildSharePayload({
      groups: [groups[0]],
      l1: l1s,
      themes,
      blacklist,
      includeBlacklist: false,
    })
    expect(withBl.blacklist).toHaveLength(2)
    expect(withoutBl.blacklist).toEqual([])
    // 出厂占位: presets 空 (票26 起服务端深度档放宽 11 后实物预设可过, 占位仍是缺省档)
    expect(withoutBl.filterConfig.presets).toEqual([])
    expect(withoutBl.filterConfig.activePreset).toBe('')
    expect(withoutBl.filterConfig.enabled).toBe(true) // 出厂 core
    expect(withoutBl.filterConfig.dims.likeRate).toEqual({ enabled: false, value: 0.02 })
  })

  it('产物完整过入方向 parseTagRecConfig 校验 (v2 结构合法)', () => {
    const p = buildSharePayload({
      groups,
      l1: l1s,
      themes,
      blacklist,
      includeBlacklist: true,
    })
    const res = parseTagRecConfig(JSON.stringify(p))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.favorites).toHaveLength(4)
      expect(res.data.l1).toHaveLength(2) // A+B (g3 悬挂不影响节裁剪)
      expect(res.data.themes).toHaveLength(2)
    }
  })

  it('产物过本地预检 (与服务端防护档同口径, 自洽回归)', () => {
    const payload = buildSharePayload({
      groups,
      l1: l1s,
      themes,
      blacklist,
      includeBlacklist: true,
    })
    expect(preflightShareIssues({ mid: 123, title: 't', payload })).toEqual([])
  })
})

// 票26: 「含过滤配置」opt-in —— 勾上 = 真实私配整套随包; 不勾 = 出厂占位 (导入侧借此判别该不该出「带入」勾选)
describe('$modules/tag-rec/model/share — 票26 filterConfig opt-in', () => {
  /** 一份「非占位」私配: 自定义阈值 + 名单 + 池覆盖 + 自定义预设 (嵌套到最深合法路径) */
  const realFilter = (): TagRecFilterSettings => ({
    ...createTagRecFactoryFilterCore(),
    strictMode: true,
    dims: {
      ...createTagRecFactoryDims(),
      likeRate: { enabled: true, value: 0.05 },
      titleKeywords: { enabled: true, list: ['广告', '带货'] },
      upBlacklist: { enabled: true, list: [{ name: '营销号', mid: 42 }] },
    },
    pools: { tagTop: { smallPoolThreshold: 5 } },
    activePreset: '严档',
    presets: [
      {
        name: '严档',
        config: {
          ...createTagRecFactoryFilterCore(),
          strictMode: true,
          pools: {
            archiveRelated: { dims: { pubdate: { enabled: true, tod: { from: 0, to: 360 } } } },
          },
        },
      },
    ],
  })
  const groups = [g('g1', [1], { name: '组' })]

  it('缺省/不勾 => 出厂占位 (isShareFactoryFilterConfig 判 true)', () => {
    const p = buildSharePayload({ groups, l1: [], themes: [], blacklist: [], includeBlacklist: false })
    expect(isShareFactoryFilterConfig(p.filterConfig)).toBe(true)
    expect(p.filterConfig.presets).toEqual([])
    expect(p.filterConfig.activePreset).toBe('')
  })

  it('opt-in => 真实私配整套随包 (预设/池覆盖/名单全保) 且克隆断引用', () => {
    const fc = realFilter()
    const p = buildSharePayload({
      groups,
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
      filterConfig: fc,
    })
    expect(isShareFactoryFilterConfig(p.filterConfig)).toBe(false)
    expect(p.filterConfig.activePreset).toBe('严档')
    expect(p.filterConfig.presets).toHaveLength(1)
    expect(p.filterConfig.dims.titleKeywords.list).toEqual(['广告', '带货'])
    expect(p.filterConfig.pools?.tagTop?.smallPoolThreshold).toBe(5)
    // serialize 深拷贝: 改产物不渗回源 (payload 与 settings 零共享)
    p.filterConfig.presets[0].config.dims.likeRate.value = 0.99
    p.filterConfig.dims.titleKeywords.list.push('渗透')
    expect(fc.presets[0].config.dims.likeRate.value).toBe(0.02)
    expect(fc.dims.titleKeywords.list).toEqual(['广告', '带货'])
  })

  it('opt-in 产物整链自洽: JSON 往返过 parseTagRecConfig + 本地预检 (深度 11 不拒)', () => {
    const p = buildSharePayload({
      groups,
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
      filterConfig: realFilter(),
    })
    const res = parseTagRecConfig(JSON.stringify(p))
    expect(res.ok).toBe(true)
    if (res.ok) {
      // 归一往返后预设嵌套池覆盖仍存
      expect(res.data.filterConfig.presets[0].config.pools?.archiveRelated?.dims?.pubdate?.tod).toEqual({
        from: 0,
        to: 360,
      })
      expect(isShareFactoryFilterConfig(res.data.filterConfig)).toBe(false)
    }
    // presets[].config.pools.*.dims.pubdate.tod = 合法路径 (档=24) —— 防护镜像须放行
    expect(preflightShareIssues({ mid: 1, title: 't', payload: p })).toEqual([])
  })

  it('isShareFactoryFilterConfig: 归一字面量判占位 / 差一键即真配 / undefined 安全', () => {
    expect(isShareFactoryFilterConfig(createShareFactoryFilterConfig())).toBe(true)
    expect(isShareFactoryFilterConfig(undefined)).toBe(false)
    // 假阳容忍: 内容恰好等于出厂字面量的私配判占位 (无可带入差异, 同一语义档)
    const lookalike = realFilter()
    lookalike.strictMode = false
    lookalike.dims = createTagRecFactoryDims()
    lookalike.pools = createTagRecFactoryFilterCore().pools
    lookalike.activePreset = ''
    lookalike.presets = []
    expect(isShareFactoryFilterConfig(lookalike)).toBe(true)
    // 差一键即真配
    const tweaked = createShareFactoryFilterConfig()
    tweaked.strictMode = true
    expect(isShareFactoryFilterConfig(tweaked)).toBe(false)
  })
})

// 006 缺口2: 「随包携带全局排除」opt-in —— 勾上 = combinationExclusions 随包 (serialize 升 v3); 不勾 = 键不携
describe('$modules/tag-rec/model/share — 006 全局排除 opt-in', () => {
  const groups = [g('g1', [1], { name: '组' })]
  const atom = () => tagRecConditionAtom('tag', e(9, '屏蔽tag'))

  it('缺省/空清单 => 键不携 (version 不升 v3); 传入 => v3 + 深拷贝断引用', () => {
    const off = buildSharePayload({ groups, l1: [], themes: [], blacklist: [], includeBlacklist: false })
    expect('combinationExclusions' in off).toBe(false)
    expect(off.version).toBe(2)
    const empty = buildSharePayload({
      groups,
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
      combinationExclusions: [],
    })
    expect('combinationExclusions' in empty).toBe(false)
    expect(empty.version).toBe(2)

    const src = [atom()]
    const on = buildSharePayload({
      groups,
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
      combinationExclusions: src,
    })
    expect(on.version).toBe(3)
    expect(on.combinationExclusions).toEqual(src)
    expect(on.combinationExclusions![0]).not.toBe(src[0]) // serialize 深拷贝: 产物与 store 清单零共享
  })

  it('opt-in 产物整链自洽: parseTagRecConfig 过 + planShareImport 出 combinationExclusionsToAdd + 预检放行', () => {
    const p = buildSharePayload({
      groups,
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
      combinationExclusions: [atom(), tagRecConditionAtom('up', { name: 'UP', mid: 11 })],
    })
    const res = parseTagRecConfig(JSON.stringify(p))
    expect(res.ok).toBe(true)
    const r = planShareImport({ payload: p, existing: { favorites: [], blacklist: [] } })
    expect(r.plan.combinationExclusionsToAdd).toEqual(p.combinationExclusions)
    expect(preflightShareIssues({ mid: 1, title: 't', payload: p })).toEqual([])
  })
})

describe('$modules/tag-rec/model/share — preflight 防护镜像', () => {
  const payload = (): TagRecConfigExportV1 =>
    buildSharePayload({
      groups: [g('g1', [1], { name: '组' })],
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })

  it('标题必填 / mid 形态 / 组数与组内 id 上限', () => {
    expect(preflightShareIssues({ mid: 1, title: '  ', payload: payload() }).map((x) => x.field)).toContain('title')
    expect(preflightShareIssues({ mid: 0, title: 't', payload: payload() }).map((x) => x.field)).toContain('mid')
    const many = Array.from({ length: SHARE_GUARD_LIMITS.MAX_GROUPS + 1 }, (_, i) => g(`g${i}`, [i + 1]))
    const p = buildSharePayload({ groups: many, l1: [], themes: [], blacklist: [], includeBlacklist: false })
    expect(preflightShareIssues({ mid: 1, title: 't', payload: p }).map((x) => x.field)).toContain('payload.favorites')
    const fat = buildSharePayload({
      groups: [
        g(
          'fat',
          Array.from({ length: 101 }, (_, i) => i + 1),
        ),
      ],
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })
    expect(
      preflightShareIssues({ mid: 1, title: 't', payload: fat }).some(
        (x) => x.field === 'payload.favorites[0].tag_ids',
      ),
    ).toBe(true)
  })

  it('字符串 >200 (递归, 含深层组名) / tag_id 非安全正整数 / 深度 >11 / 体积 >1MB', () => {
    const longName = buildSharePayload({
      groups: [g('g1', [1], { name: 'n'.repeat(201) })],
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })
    expect(preflightShareIssues({ mid: 1, title: 't', payload: longName }).map((x) => x.field)).toContain(
      '$.payload.favorites[0].name',
    )

    const badId = payload()
    badId.favorites[0].tag_ids = [{ id: 0, name: 'x' }]
    expect(preflightShareIssues({ mid: 1, title: 't', payload: badId }).map((x) => x.field)).toContain(
      'payload.favorites[0].tag_ids[0].id',
    )

    // 深度: payload.favorites[0] 里塞 20 层嵌套对象 (票47 档=24; evil 链 > 上限即拒)
    const deep = payload()
    let v: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) v = { next: v }
    ;(deep.favorites[0] as Record<string, unknown>).evil = v
    expect(preflightShareIssues({ mid: 1, title: 't', payload: deep }).some((x) => x.reason.includes('深度'))).toBe(
      true,
    )

    // 体积: 200 组 × (100 正向 + 100 负向) 条目 ≈ 1.7MB
    const fat = buildSharePayload({
      groups: Array.from({ length: 200 }, (_, i) =>
        g(
          `g${i}`,
          Array.from({ length: 100 }, (__, j) => i * 1000 + j + 1),
          {
            negative_tag_ids: Array.from({ length: 100 }, (__, j) => e(9_000_000 + i * 1000 + j, 'xxxxxxxxxxxxxxxx')),
          },
        ),
      ),
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })
    const issues = preflightShareIssues({ mid: 1, title: 't', payload: fat })
    expect(issues.some((x) => x.field === 'body' && x.reason.includes('字节'))).toBe(true)
  })

  // 006 缺口3 毒包防线: 服务端不做 schema 校验会透传落库, 下载方 parseTagRecConfig 整包硬拒
  it('畸形 combination / combinationExclusions / v2 携组合 => 预检拦 (镜像下载方硬拒面)', () => {
    // 合法组合组 => v3 自洽放行
    const combo = newTagRecCombination()
    addTagRecCondition(combo, tagRecConditionAtom('tag', e(7)))
    const ok = buildSharePayload({
      groups: [g('g1', [1], { name: '组', combination: combo })],
      l1: [],
      themes: [],
      blacklist: [],
      includeBlacklist: false,
    })
    expect(ok.version).toBe(3)
    expect(preflightShareIssues({ mid: 1, title: 't', payload: ok })).toEqual([])

    // 畸形 combination (kind:'atom' 顶替组) => 拦; payload() 是 v2, 携组合同步出版本档 issue
    const bad = payload()
    ;(bad.favorites[0] as Record<string, unknown>).combination = {
      version: 1,
      include: { kind: 'atom', id: 'x' },
      exclude: [],
    }
    const badFields = preflightShareIssues({ mid: 1, title: 't', payload: bad }).map((x) => x.field)
    expect(badFields).toContain('payload.favorites[0].combination')
    expect(badFields).toContain('payload.version')
    expect(parseTagRecConfig(JSON.stringify(bad)).ok).toBe(false) // 镜像依据: 下载方确实硬拒

    // 合法组合但 version 回退 v2 => 拦 (版本门槛, 同 parseTagRecConfig L167 口径)
    const downgraded = structuredClone(ok)
    downgraded.version = 2
    expect(preflightShareIssues({ mid: 1, title: 't', payload: downgraded }).map((x) => x.field)).toContain(
      'payload.version',
    )
    expect(parseTagRecConfig(JSON.stringify(downgraded)).ok).toBe(false)

    // 畸形 combinationExclusions => 拦 (v3 下仍拦 —— 失败源是原子形状而非版本)
    const badEx = structuredClone(ok)
    ;(badEx as { combinationExclusions?: unknown }).combinationExclusions = [{ kind: 'group', id: 'x' }]
    expect(preflightShareIssues({ mid: 1, title: 't', payload: badEx }).map((x) => x.field)).toContain(
      'payload.combinationExclusions',
    )
    expect(parseTagRecConfig(JSON.stringify(badEx)).ok).toBe(false)

    // v2 + 合法排除清单 => 拦 (版本门槛); 合法 v3 排除已在上个 describe 整链自洽
    const v2ex = payload()
    v2ex.combinationExclusions = [tagRecConditionAtom('tag', e(9))]
    const v2exFields = preflightShareIssues({ mid: 1, title: 't', payload: v2ex }).map((x) => x.field)
    expect(v2exFields).toContain('payload.combinationExclusions')
    expect(parseTagRecConfig(JSON.stringify(v2ex)).ok).toBe(false)
  })
})

describe('$modules/tag-rec/model/share — 拒绝归一化 / 链接 / token 记账纯函数', () => {
  it('normalizeShareRejections: 单条形 {error,field,reason,word|category}', () => {
    expect(
      normalizeShareRejections({ error: 'moderation_rejected', field: 'title', reason: '命中敏感词', word: 'xx' }),
    ).toEqual([{ field: 'title', reason: '命中敏感词', word: 'xx' }])
    expect(normalizeShareRejections({ error: 'bad_request', reason: 'title 必填且为非空字符串' })).toEqual([
      { reason: 'title 必填且为非空字符串' },
    ])
  })

  it('normalizeShareRejections: reasons[] 多条形 (票面预留); 垃圾输入 => []', () => {
    expect(
      normalizeShareRejections({
        reasons: [
          { field: 'description', reason: 'r1', category: 'hate' },
          { reason: 'r2' },
          { noReason: true }, // 无 reason 的条目被滤掉
        ],
      }),
    ).toEqual([{ field: 'description', reason: 'r1', category: 'hate' }, { reason: 'r2' }])
    expect(normalizeShareRejections(undefined)).toEqual([])
    expect(normalizeShareRejections('oops')).toEqual([])
    expect(normalizeShareRejections({})).toEqual([])
    expect(normalizeShareRejections({ error: 'internal' })).toEqual([]) // 无 reason
  })

  it('buildSharePageUrl: `${site}/?share=<id>` query 定位 (单页站)', () => {
    expect(buildSharePageUrl('https://tag-share.example.com', 'abcDEF123_')).toBe(
      'https://tag-share.example.com/?share=abcDEF123_',
    )
    expect(buildSharePageUrl('http://localhost:8787', 'x')).toBe('http://localhost:8787/?share=x')
  })

  it('buildShareEditUrl: 详情位 + #key=<token> fragment 递送管理 token (不进服务端/日志)', () => {
    const u = buildShareEditUrl('https://tag-share.example.com', 's1', 'tok/with?chars')
    expect(u.startsWith('https://tag-share.example.com/?share=s1#')).toBe(true)
    const hash = new URL(u).hash
    expect(hash.startsWith('#key=')).toBe(true)
    expect(new URLSearchParams(hash.slice(1)).get('key')).toBe('tok/with?chars') // 编码往返
  })

  it('upsertShareToken/removeShareToken: 记账纯变换', () => {
    const m0 = {}
    const m1 = upsertShareToken(m0, 's1', { token: 't1', title: 'A', createdAt: 1 })
    const m2 = upsertShareToken(m1, 's2', { token: 't2', title: 'B', createdAt: 2 })
    expect(Object.keys(m2).sort()).toEqual(['s1', 's2'])
    expect(m1).not.toHaveProperty('s2') // 不改原图
    // 同 id 覆写
    const m3 = upsertShareToken(m2, 's1', { token: 't1x', title: 'A2', createdAt: 3 })
    expect(m3.s1).toEqual({ token: 't1x', title: 'A2', createdAt: 3 })
    expect(removeShareToken(m3, 's1')).toEqual({ s2: { token: 't2', title: 'B', createdAt: 2 } })
    expect(removeShareToken(m3, 'ghost')).toEqual(m3) // 无键 no-op (内容等价)
  })
})

describe('$modules/tag-rec/model/share — 票 18/27 粘贴导入文本抽取', () => {
  it('整段深链 URL (含 gate-tab + groups 子集); 子集参顺带抽出', () => {
    expect(
      extractShareImportFromText(
        'https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=abcDEF123_&tag-rec-groups=g1%2Cg2',
      ),
    ).toEqual({ kind: 'share', shareId: 'abcDEF123_', groupIds: ['g1', 'g2'] })
  })

  it('站点分享页 ?share=<id> / 任意 host+path 上的 tag-rec-share 参', () => {
    expect(extractShareImportFromText('https://tag-share.example.com/?share=abcDEF123_')).toEqual({
      kind: 'share',
      shareId: 'abcDEF123_',
      groupIds: undefined,
    })
    expect(extractShareImportFromText('http://localhost:8787/some/path?tag-rec-share=abcDEF123_&x=1')).toMatchObject({
      kind: 'share',
      shareId: 'abcDEF123_',
    })
  })

  it('裸 shareId (nanoid 10 位) / 自由文本内嵌 token / 动态文字+链接混贴', () => {
    expect(extractShareImportFromText('  abcDEF123_  ')).toEqual({
      kind: 'share',
      shareId: 'abcDEF123_',
      groupIds: undefined,
    })
    expect(extractShareImportFromText('看这个分享 abcDEF123_ 不错')).toMatchObject({
      kind: 'share',
      shareId: 'abcDEF123_',
    })
    expect(
      extractShareImportFromText(
        '分享了一组标签 https://www.bilibili.com/?gate-tab=tag-rec-fav&tag-rec-share=Zz9-yy_8Kk 快试试',
      ),
    ).toMatchObject({ kind: 'share', shareId: 'Zz9-yy_8Kk' })
  })

  it('票27 试改版导入码: fork 深链 hash 参 / 裸码 / 码优先于内嵌 shareId 边界不误判', () => {
    const code = 'z.' + 'A'.repeat(40)
    expect(extractShareImportFromText(`https://www.bilibili.com/?gate-tab=tag-rec-fav#tag-rec-pkg=${code}`)).toEqual({
      kind: 'pkg',
      code,
    })
    expect(extractShareImportFromText(`tag-rec-pkg=${code}`)).toEqual({ kind: 'pkg', code })
    expect(extractShareImportFromText(code)).toEqual({ kind: 'pkg', code }) // 裸码 (z./r. 前缀)
    expect(extractShareImportFromText('r.' + 'B'.repeat(20))).toEqual({ kind: 'pkg', code: 'r.' + 'B'.repeat(20) })
  })

  it('无效输入 => undefined (空/短 id/长 token 边界不误抽/无 token 文本/无 share 参链接)', () => {
    expect(extractShareImportFromText('')).toBeUndefined()
    expect(extractShareImportFromText(' '.repeat(3))).toBeUndefined()
    expect(extractShareImportFromText('abc123')).toBeUndefined() // 短于 10
    expect(extractShareImportFromText('?tag-rec-share=short')).toBeUndefined() // 参值不足 10
    expect(extractShareImportFromText('xabcDEF123_y')).toBeUndefined() // 12 位长 token 边界不内嵌误抽
    expect(extractShareImportFromText('没有链接也没有 id')).toBeUndefined()
    expect(extractShareImportFromText('https://www.bilibili.com/?gate-tab=tag-rec-fav')).toBeUndefined()
    expect(extractShareImportFromText('z.太短')).toBeUndefined() // 码体非 base64url 字符
    expect(extractShareImportFromText('xtag-rec-pkg=z.' + 'A'.repeat(40))).toBeUndefined() // 前缀字母粘连不误抽
  })
})

describe('$modules/tag-rec/model/share — 票 18 planShareImport (groups 子集 => Modal 初态映射)', () => {
  const payload = () =>
    buildSharePayload({
      groups: [
        g('g1', [1], { l1Id: 'A', name: '组一' }),
        g('g2', [2], { l1Id: 'A', name: '组二' }),
        g('g3', [3], { l1Id: 'B', name: '组三' }),
      ],
      l1: [l1('A', { themeId: 't1' }), l1('B', { themeId: 't1' })],
      themes: [theme('t1')],
      blacklist: [bl(9)],
      includeBlacklist: true,
    })
  const existing = { favorites: [] as TagGroup[], blacklist: [] as TagBlacklistEntry[] }

  it('无子集 => 整包全列 (payload 序); missingGroupCount=0', () => {
    const r = planShareImport({ payload: payload(), existing })
    expect(r.plan.favoritesToAdd.map((x) => x.id)).toEqual(['g1', 'g2', 'g3'])
    expect(r.plan.l1ToAdd.map((x) => x.id)).toEqual(['A', 'B'])
    expect(r.missingGroupCount).toBe(0)
    expect(r.plan.blacklistToAdd).toHaveLength(1)
  })

  it('有子集 => 只列指定组且按 payload 序 (非请求序); 不在包内的 id 计 missing', () => {
    const r = planShareImport({
      payload: payload(),
      requestedGroupIds: ['g3', 'ghost', 'g1'],
      existing,
    })
    expect(r.plan.favoritesToAdd.map((x) => x.id)).toEqual(['g1', 'g3'])
    expect(r.missingGroupCount).toBe(1)
  })

  it('子集全不在包内 => 空清单 + 全计 missing; 空数组子集视同未指定 (整包)', () => {
    const r = planShareImport({ payload: payload(), requestedGroupIds: ['ghost1', 'ghost2'], existing })
    expect(r.plan.favoritesToAdd).toEqual([])
    expect(r.missingGroupCount).toBe(2)
    const emptyArr = planShareImport({ payload: payload(), requestedGroupIds: [], existing })
    expect(emptyArr.plan.favoritesToAdd).toHaveLength(3)
    expect(emptyArr.missingGroupCount).toBe(0)
  })

  it('子集裁剪后冲突检测照常 (与既有表 id 共享 => conflicts)', () => {
    const r = planShareImport({
      payload: payload(),
      requestedGroupIds: ['g1'],
      existing: { ...existing, favorites: [g('e0', [1, 9], { name: '既有组' })] },
    })
    expect(r.plan.conflicts).toHaveLength(1)
    expect(r.plan.conflicts[0].group.id).toBe('g1')
    expect(r.plan.conflicts[0].hits[0].id).toBe('e0')
  })
})

// 分享包开关位语义: 「分享是数据不是视图态」—— enabled 出方向剥键, 入方向归一默认档 (组=true/L1=true 全启用)
describe('$modules/tag-rec/model/share — enabled 剥键 + 导入归一 + 包编辑模型', () => {
  const l1s = [l1('A', { themeId: 't1' }), l1('B')]
  const themes = [theme('t1')]
  const groups = [
    g('g1', [1, 2], { l1Id: 'A', enabled: false, name: '组一' }), // 上传方停用态不该外泄
    g('g2', [3], { l1Id: 'B', enabled: true, name: '组二' }),
  ]
  const existing = { favorites: [] as TagGroup[], blacklist: [] as TagBlacklistEntry[] }
  const payload = () => buildSharePayload({ groups, l1: l1s, themes, blacklist: [bl(9)], includeBlacklist: true })

  it('buildSharePayload: favorites/l1 条目 enabled 键全剥; activeThemeId 不携', () => {
    const p = payload()
    expect(p.favorites.every((f) => !('enabled' in f))).toBe(true)
    expect(p.l1.every((l) => !('enabled' in l))).toBe(true)
    expect('activeThemeId' in p).toBe(false)
  })

  it('planShareImport: 开关位不沿用 —— 组/L1 皆归一 true (默认全启用); 老包私带反向值同归; 私带 activeThemeId 不生效', () => {
    const p = payload()
    // 模拟旧版/私改包把视图态塞回来: 组/L1 皆停用 => 归一后全启用 (组入表即用 / L1 默认全启用)
    p.favorites[0].enabled = false
    p.l1[0].enabled = false
    p.activeThemeId = 't1'
    const r = planShareImport({ payload: p, existing })
    expect(r.plan.favoritesToAdd.every((f) => f.enabled === true)).toBe(true)
    expect(r.plan.l1ToAdd.every((l) => l.enabled === true)).toBe(true)
    expect(r.plan.activeThemeId).toBeUndefined()
  })

  it('planShareImport: 缺 enabled 键的新 L1 归一 true (Modal 反向取消的默认底 = 全启用)', () => {
    const p = payload()
    expect(p.l1.every((l) => !('enabled' in l))).toBe(true) // 出方向剥键: 包内本就无开关位
    const r = planShareImport({ payload: p, existing })
    expect(r.plan.l1ToAdd.every((l) => l.enabled === true)).toBe(true)
  })

  it('parseSharePkgForEdit: payload 拆成可编辑行 (负向双源并集/strict 任源 true; 归属全保)', () => {
    const p = payload()
    // overrides.negative 双源档: 顶层 negative_tag_ids={8} ∪ overrides.negative.tagIds={9}, strict 在 overrides
    const f0 = p.favorites[0] as unknown as Record<string, unknown>
    f0.negative_tag_ids = [{ id: 8, name: 'b8' }]
    f0.overrides = { negative: { tagIds: [{ id: 9, name: 'b9' }], strict: true } }
    const edit = parseSharePkgForEdit(p)
    expect(edit).toBeDefined()
    if (!edit) return
    expect(edit.groups.map((x) => x.id)).toEqual(['g1', 'g2'])
    expect(edit.l1.map((x) => x.id)).toEqual(['A', 'B'])
    expect(edit.themes.map((x) => x.id)).toEqual(['t1'])
    expect(edit.blacklist.map((x) => x.id)).toEqual([9])
    expect(edit.groups[0].negIds.map((x) => x.id)).toEqual([8, 9]) // 顶层先序 ∪ overrides 后序
    expect(edit.groups[0].negStrict).toBe(true)
    expect(edit.groups[0].l1Id).toBe('A')
    expect(edit.l1[0].themeId).toBe('t1')
    // 坏形不崩: 非对象/缺 favorites 皆 undefined
    expect(parseSharePkgForEdit(undefined)).toBeUndefined()
    expect(parseSharePkgForEdit({ version: 2 })).toBeUndefined()
  })

  it('buildSharePkgPayload: 编辑回写 —— 改名/改挂/删组/摘 tag; 空壳 L1·主题自动裁; enabled/activeThemeId 恒剥', () => {
    const edit = parseSharePkgForEdit(payload())
    if (!edit) throw new Error('parse failed')
    const out = buildSharePkgPayload({
      ...edit,
      groups: edit.groups
        .filter((x) => x.id !== 'g2') // 删组
        .map((x) =>
          x.id === 'g1'
            ? { ...x, name: '改名组', l1Id: 'B', tagIds: x.tagIds.slice(1), note: '备' } // 改挂 B + 摘除一个 tag
            : x,
        ),
      l1: [...edit.l1, { id: 'C', name: '空壳L1', weight: 1, raw: {} }], // 无引用 => 裁
    })
    const favs = out.favorites as Record<string, unknown>[]
    expect(favs).toHaveLength(1)
    expect(favs[0].name).toBe('改名组')
    expect(favs[0].l1Id).toBe('B')
    expect(favs[0].tag_ids).toEqual([{ id: 2, name: 'tag2' }])
    expect(favs[0].note).toBe('备')
    expect(favs[0].enabled).toBeUndefined()
    // A 失去唯一引用裁掉; B 留下; C 空壳裁掉
    const l1Out = out.l1 as Record<string, unknown>[]
    expect(l1Out.map((x) => x.id)).toEqual(['B'])
    expect(l1Out[0].enabled).toBeUndefined()
    // B 无 themeId => 主题 t1 随 A 一起裁掉
    expect(out.themes).toEqual([])
    expect('activeThemeId' in out).toBe(false)
    expect((out.blacklist as { id: number }[]).map((x) => x.id)).toEqual([9])
    // 重建产物仍过入方向校验 (保存档 = 可重审合法包)
    expect(parseTagRecConfig(JSON.stringify(out)).ok).toBe(true)
  })

  it('buildSharePkgPayload: 负向双源折叠顶层 + 悬挂 l1Id/themeId 摘键 + 名回落', () => {
    const p = payload()
    const f0 = p.favorites[0] as unknown as Record<string, unknown>
    f0.negative_tag_ids = [{ id: 8, name: 'b8' }]
    f0.overrides = { negative: { tagIds: [{ id: 9, name: 'b9' }], strict: true } }
    const edit = parseSharePkgForEdit(p)
    if (!edit) throw new Error('parse failed')
    const out = buildSharePkgPayload({
      ...edit,
      groups: edit.groups.map((x) =>
        x.id === 'g1' ? { ...x, name: '  ', l1Id: 'ghost-l1' } : { ...x, l1Id: 'ghost' },
      ),
      l1: edit.l1.map((x) => (x.id === 'A' ? { ...x, themeId: 'ghost-theme' } : x)),
    })
    const favs = out.favorites as Record<string, unknown>[]
    // 悬挂 l1Id 摘键 => 所有 L1 变空壳全裁
    expect(favs.every((f) => !('l1Id' in f))).toBe(true)
    expect(out.l1).toEqual([])
    expect(out.themes).toEqual([])
    // 负向折叠: overrides.negative 摘键连壳, 顶层承载并集 + strict
    expect(favs[0].negative_tag_ids).toEqual([
      { id: 8, name: 'b8' },
      { id: 9, name: 'b9' },
    ])
    expect(favs[0].negative_strict).toBe(true)
    expect(favs[0].overrides).toBeUndefined()
    // 空名回落首个正向 tag 名
    expect(favs[0].name).toBe('tag1')
  })
})

// 「默认全启用 + 反向取消」落表裁决: plan 层归一 true, Modal 只维护 disabledL1Ids 反向集 (纯函数可测)
describe('$modules/tag-rec/model/share — 分享导入 L1 启用裁决 (默认全启用 + 反向取消)', () => {
  it('默认 (空反向集) => 作用域内全启用; 顺序 = 新增 L1 先, 再落表组归属 (去重保序)', () => {
    const decisions = resolveShareImportL1Enabled({
      groups: [{ l1Id: 'A' }, { l1Id: undefined }, { l1Id: 'B' }, { l1Id: 'A' }],
      l1ToAdd: [{ id: 'NEW' }],
      disabledL1Ids: new Set(),
    })
    expect(decisions).toEqual([
      { id: 'NEW', enabled: true },
      { id: 'A', enabled: true },
      { id: 'B', enabled: true },
    ])
  })

  it('反向取消集内的落停用; 集外 (作用域外) id 不影响裁决', () => {
    const decisions = resolveShareImportL1Enabled({
      groups: [{ l1Id: 'A' }, { l1Id: 'B' }],
      l1ToAdd: [{ id: 'NEW' }],
      disabledL1Ids: new Set(['B', 'NEW', 'ghost']),
    })
    expect(decisions).toEqual([
      { id: 'NEW', enabled: false },
      { id: 'A', enabled: true },
      { id: 'B', enabled: false },
    ])
  })

  it('边界: 空输入 => 空裁决; 缺 l1ToAdd 安全; 裸奔组 (无 l1Id) 不入作用域', () => {
    expect(resolveShareImportL1Enabled({ groups: [], disabledL1Ids: new Set() })).toEqual([])
    expect(resolveShareImportL1Enabled({ groups: [{ l1Id: undefined }], disabledL1Ids: new Set(['x']) })).toEqual([])
    expect(resolveShareImportL1Enabled({ groups: [{ l1Id: 'A' }], disabledL1Ids: new Set(['A']) })).toEqual([
      { id: 'A', enabled: false },
    ])
  })

  it('闭环: planShareImport 归一 true + 取消 B => 落表裁决 B 停用, 其余启用', () => {
    const r = planShareImport({
      payload: buildSharePayload({
        groups: [g('g1', [1], { l1Id: 'A' }), g('g2', [2], { l1Id: 'B' })],
        l1: [l1('A'), l1('B')],
        themes: [],
        blacklist: [],
        includeBlacklist: false,
      }),
      existing: { favorites: [], blacklist: [] },
    })
    expect(r.plan.l1ToAdd.every((l) => l.enabled === true)).toBe(true)
    const decisions = resolveShareImportL1Enabled({
      groups: r.plan.favoritesToAdd,
      l1ToAdd: r.plan.l1ToAdd,
      disabledL1Ids: new Set(['B']),
    })
    expect(decisions).toEqual([
      { id: 'A', enabled: true },
      { id: 'B', enabled: false },
    ])
  })
})

describe('$modules/tag-rec/model/share — 票 17 我的分享: 账本行归一 + reconcile 归并 + PATCH 体', () => {
  it('normalizeShareTokenEntries: 正常条目按 createdAt desc, 并列按 shareId 字典序', () => {
    const rows = normalizeShareTokenEntries({
      sOld: { token: 't1', title: '旧', createdAt: 100 },
      sNew: { token: 't2', title: '新', createdAt: 300 },
      sMid: { token: 't3', title: '中', createdAt: 200 },
      sTie1: { token: 't4', title: '并列b', createdAt: 300 },
      sTie0: { token: 't5', title: '并列a', createdAt: 300 },
    })
    expect(rows.map((r) => r.shareId)).toEqual(['sNew', 'sTie0', 'sTie1', 'sMid', 'sOld'])
    expect(rows[0]).toEqual({ shareId: 'sNew', token: 't2', title: '新', createdAt: 300 })
  })

  it('normalizeShareTokenEntries: 畸形条目不丢 —— token 缺/非串 => 失权(undefined), title/createdAt 缺省兜底', () => {
    const rows = normalizeShareTokenEntries({
      ok: { token: 't', title: 'A', createdAt: 1 },
      noToken: { title: 'B', createdAt: 2 },
      emptyToken: { token: '', title: 'C', createdAt: 3 },
      nonObj: 'garbage',
      numCreatedAt: { token: 't2', title: 42, createdAt: 'x' },
      arr: [],
    })
    const byId = Object.fromEntries(rows.map((r) => [r.shareId, r]))
    expect(byId.ok).toEqual({ shareId: 'ok', token: 't', title: 'A', createdAt: 1 })
    expect(byId.noToken?.token).toBeUndefined()
    expect(byId.emptyToken?.token).toBeUndefined()
    expect(byId.nonObj).toEqual({ shareId: 'nonObj', token: undefined, title: '', createdAt: 0 })
    expect(byId.numCreatedAt).toEqual({ shareId: 'numCreatedAt', token: 't2', title: '', createdAt: 0 })
    expect(byId.arr).toEqual({ shareId: 'arr', token: undefined, title: '', createdAt: 0 })
  })

  it('normalizeShareTokenEntries: map 非平面对象 => [] (GM 读到的垃圾值同空账本)', () => {
    expect(normalizeShareTokenEntries(undefined)).toEqual([])
    expect(normalizeShareTokenEntries(null)).toEqual([])
    expect(normalizeShareTokenEntries(['a'])).toEqual([])
    expect(normalizeShareTokenEntries(42)).toEqual([])
  })

  it('buildMyShareRows: probes 归并 remote; 未覆盖 => unprobed', () => {
    const map = { s1: { token: 't1', title: 'A', createdAt: 1 }, s2: { token: 't2', title: 'B', createdAt: 2 } }
    const rows = buildMyShareRows(map, { s2: 'removed' })
    const byId = Object.fromEntries(rows.map((r) => [r.shareId, r]))
    expect(byId.s1?.remote).toBe('unprobed')
    expect(byId.s2?.remote).toBe('removed')
    expect(buildMyShareRows(map).every((r) => r.remote === 'unprobed')).toBe(true)
  })

  it('probeOutcomeToRemote: not-found=>gone; failed=>unprobed 静默; ok 按 meta.status 直译 (缺省 published)', () => {
    expect(probeOutcomeToRemote('not-found')).toBe('gone')
    expect(probeOutcomeToRemote('failed')).toBe('unprobed')
    expect(probeOutcomeToRemote('ok', 'removed')).toBe('removed')
    expect(probeOutcomeToRemote('ok', 'pending')).toBe('pending')
    expect(probeOutcomeToRemote('ok', 'published')).toBe('published')
    expect(probeOutcomeToRemote('ok')).toBe('published') // meta.status 缺省兜底
    expect(probeOutcomeToRemote('ok', 'weird-status')).toBe('published') // 未知值不当下架/待审标
  })

  it('buildSharePatchBody: title trim 必填; description 缺省不携键 / 空串=>null 显式清空 / 有值 trim', () => {
    expect(buildSharePatchBody({ title: '  新标题  ' })).toEqual({ title: '新标题' })
    expect(buildSharePatchBody({ title: 't', description: '  新描述 ' })).toEqual({
      title: 't',
      description: '新描述',
    })
    // 显式清空语义: 空串 => null (worker validatePatchBody 口径)
    expect(buildSharePatchBody({ title: 't', description: ' '.repeat(3) })).toEqual({
      title: 't',
      description: null,
    })
    // 远端现值未知 => 不携键 (防 PATCH 把没见到的描述误清)
    const noDesc = buildSharePatchBody({ title: 't' })
    expect(noDesc && 'description' in noDesc).toBe(false)
  })

  it('buildSharePatchBody: 空标题/超长 => undefined (调用侧拦保存)', () => {
    expect(buildSharePatchBody({ title: ' '.repeat(3) })).toBeUndefined()
    expect(buildSharePatchBody({ title: 'x'.repeat(SHARE_GUARD_LIMITS.MAX_STRING_LEN + 1) })).toBeUndefined()
    expect(
      buildSharePatchBody({ title: 't', description: 'x'.repeat(SHARE_GUARD_LIMITS.MAX_STRING_LEN + 1) }),
    ).toBeUndefined()
    // 边界: 恰好 200 字放行
    expect(buildSharePatchBody({ title: 'x'.repeat(SHARE_GUARD_LIMITS.MAX_STRING_LEN) })).toBeDefined()
  })
})

// [tag-rec] 票 19: 回赞闭环纯逻辑 (spec §6)
describe('$modules/tag-rec/model/share — 票 19 回赞记忆集归一 + 触发判定', () => {
  const actedOf = (liked: string[] = [], dismissed: string[] = []): ShareLikeActed => ({ liked, dismissed })

  it('resolveShareLikePrompt: pending 在 ∧ 未赞未拒 ∧ 条数够 => shareId; 任一不满足 => undefined', () => {
    // 全条件满足 (边界 20 与超量 99 皆出)
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 20, acted: actedOf() })).toBe('s1')
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 99, acted: actedOf() })).toBe('s1')
    // pending 缺席 => 不出
    expect(resolveShareLikePrompt({ pendingShareId: undefined, renderedCount: 99, acted: actedOf() })).toBeUndefined()
    // 条数不够 (边界 19) => 不出
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 19, acted: actedOf() })).toBeUndefined()
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 0, acted: actedOf() })).toBeUndefined()
    // 已赞集命中 => 永不再出 (条数再够也不出)
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 99, acted: actedOf(['s1']) })).toBeUndefined()
    // 已拒集命中 => 同理
    expect(
      resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 99, acted: actedOf([], ['s1']) }),
    ).toBeUndefined()
    // 别 id 在集不挡本 id
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 20, acted: actedOf(['o1'], ['o2']) })).toBe(
      's1',
    )
    // minRendered 注入 (边界测试用)
    expect(resolveShareLikePrompt({ pendingShareId: 's1', renderedCount: 5, acted: actedOf(), minRendered: 5 })).toBe(
      's1',
    )
  })

  it('normalizeShareLikeActed: 畸形容忍 => 空集; 字段非数组滤掉; 去重保序滤非串', () => {
    expect(normalizeShareLikeActed(undefined)).toEqual({ liked: [], dismissed: [] })
    expect(normalizeShareLikeActed(null)).toEqual({ liked: [], dismissed: [] })
    expect(normalizeShareLikeActed(['x'])).toEqual({ liked: [], dismissed: [] })
    expect(normalizeShareLikeActed(42)).toEqual({ liked: [], dismissed: [] })
    expect(normalizeShareLikeActed({ liked: 'nope' })).toEqual({ liked: [], dismissed: [] })
    expect(normalizeShareLikeActed({ liked: ['a', 'a', 1, '', 'b'], dismissed: [null, 'x', 'x'] })).toEqual({
      liked: ['a', 'b'],
      dismissed: ['x'],
    })
  })

  it('upsertShareLikeActed: 入集去重 + 对侧摘除 (后动作者赢) + FIFO 截尾上限, 不改原对象', () => {
    const a0 = actedOf(['s1'], ['d1'])
    const a1 = upsertShareLikeActed(a0, 's2', 'liked')
    expect(a1).toEqual({ liked: ['s1', 's2'], dismissed: ['d1'] })
    expect(a0).toEqual(actedOf(['s1'], ['d1'])) // 不改原对象
    // 同 id 重复入同集不双份
    expect(upsertShareLikeActed(a1, 's2', 'liked')).toEqual(a1)
    // 后动作者赢: 已拒转已赞 => 对侧摘除
    expect(upsertShareLikeActed(a0, 'd1', 'liked')).toEqual({ liked: ['s1', 'd1'], dismissed: [] })
    expect(upsertShareLikeActed(a0, 's1', 'dismissed')).toEqual({ liked: [], dismissed: ['d1', 's1'] })
    // FIFO 截尾: 超上限丢最旧
    const full = actedOf(Array.from({ length: SHARE_LIKE_ACTED_MAX }, (_, i) => `s${i}`))
    const a3 = upsertShareLikeActed(full, 'new', 'liked')
    expect(a3.liked).toHaveLength(SHARE_LIKE_ACTED_MAX)
    expect(a3.liked[0]).toBe('s1')
    expect(a3.liked.at(-1)).toBe('new')
  })
})

describe('票 31 (tag-share): dup-check 纯逻辑', () => {
  it('collectSharePositiveTagIds: payload.favorites[].tag_ids[].id 拍平去重保序; 非法 id 滤掉', () => {
    expect(collectSharePositiveTagIds([g('g1', [1, 2, 3]), g('g2', [3, 4]), g('g3', [5])])).toEqual([1, 2, 3, 4, 5])
    expect(collectSharePositiveTagIds([])).toEqual([])
    expect(collectSharePositiveTagIds([g('g1', [2]), g('g2', [2, 2])])).toEqual([2])
    // 非法 id (0/负数/非整数) 滤掉 —— dup-check 语义只要安全正整数
    const dirty = {
      tag_ids: [
        { id: 0, name: 'a' },
        { id: -1, name: 'b' },
        { id: 1.5, name: 'c' },
        { id: 7, name: 'd' },
      ],
    }
    expect(collectSharePositiveTagIds([dirty])).toEqual([7])
  })

  it('formatShareUpdatedAgo: 刚刚/分钟/小时/天/月/年 分档; 缺省·非法·未来值 → 刚刚', () => {
    const now = Date.parse('2026-06-01T00:00:00Z')
    const M = 60_000
    const H = 3_600_000
    const D = 86_400_000
    expect(formatShareUpdatedAgo(now - 30_000, now)).toBe('刚刚')
    expect(formatShareUpdatedAgo(now - 5 * M, now)).toBe('5 分钟前')
    expect(formatShareUpdatedAgo(now - 3 * H, now)).toBe('3 小时前')
    expect(formatShareUpdatedAgo(now - 2 * D, now)).toBe('2 天前')
    expect(formatShareUpdatedAgo(now - 45 * D, now)).toBe('1 个月前')
    expect(formatShareUpdatedAgo(now - 400 * D, now)).toBe('1 年前')
    expect(formatShareUpdatedAgo(undefined, now)).toBe('刚刚')
    expect(formatShareUpdatedAgo(0, now)).toBe('刚刚')
    expect(formatShareUpdatedAgo(NaN, now)).toBe('刚刚')
    expect(formatShareUpdatedAgo(now + 10 * D, now)).toBe('刚刚') // 未来值回落
  })
})
