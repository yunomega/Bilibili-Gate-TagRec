import { describe, expect, it, vi } from 'vitest'
import {
  createTagRecBuiltinPresets,
  createTagRecFactoryFilterCore,
  removeTagRecPreset,
  type TagRecFilterSettings,
} from './filter-engine'
import {
  applyCsvRowResolution,
  checkCsvRowConflict,
  csvEscapeField,
  csvRecordsToImportRows,
  favoritesToCsv,
  mergeTagRecConfigExports,
  parseCsvText,
  parseTagIdCell,
  parseTagRecConfig,
  planCsvImport,
  planTagRecImport,
  resetCsvRowForRetry,
  resolveTagRecImportApply,
  serializeTagRecConfig,
  stringifyTagRecConfig,
  TAG_REC_EXPORT_VERSION,
  validateTagRecFilterSettings,
  type CsvImportRow,
  type TagRecConfigExportV1,
} from './import-export'
import type { TagBlacklistEntry, TagGroup, TagIdEntry, TagL1Group } from './types'

// filter-engine -> _pipeline -> endpoints/$common 触浏览器环境; 纯函数测试以 mock 隔掉 (同 filter-engine.test.ts 手法)
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
const filterSettings = (): TagRecFilterSettings => ({
  ...createTagRecFactoryFilterCore(),
  activePreset: '淘沙',
  presets: createTagRecBuiltinPresets(),
})

const row = (partial: Partial<CsvImportRow>): CsvImportRow => ({
  key: 'r0',
  index: 0,
  rawName: 'foo',
  tagIds: [],
  negTagIds: [],
  resolvedEntries: [],
  source: 'name',
  checked: false,
  status: 'ready',
  ...partial,
})

describe.concurrent('$modules/tag-rec/model/import-export — JSON (§6.1)', () => {
  it('命名空组备份往返保留归属、负向、权重和配置；导入时保持停用', () => {
    const empty = g('empty', [], {
      name: '待补标签',
      l1Id: 'parent',
      enabled: false,
      weight: 3,
      note: '计划',
      negative_tag_ids: [e(9)],
      overrides: { negative: { title: ['屏蔽词'] } },
    })
    const input = { l1: [l1('parent')], favorites: [empty], blacklist: [], filterConfig: filterSettings() }
    const parsed = parseTagRecConfig(stringifyTagRecConfig(serializeTagRecConfig(input)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.favorites).toEqual([empty])
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [] })
    expect(plan.invalidGroups).toEqual([])
    expect(plan.favoritesToAdd[0]).toMatchObject({ ...empty, l1Id: plan.l1ToAdd[0].id })
  })
  it('三件往返无损 + version 字段', () => {
    const input = {
      l1: [l1('L1'), l1('L2', { enabled: false, weight: 0, note: 'n' })],
      favorites: [g('a', [1, 2], { name: '组A', weight: 3, note: 'n' }), g('b', [3], { enabled: false, weight: 0 })],
      blacklist: [{ id: 9, name: 'black' }] as TagBlacklistEntry[],
      filterConfig: filterSettings(),
    }
    const text = stringifyTagRecConfig(serializeTagRecConfig(input))
    const parsed = parseTagRecConfig(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.version).toBe(2) // Plain tag groups remain compatible with the marketplace.
    expect(parsed.data.l1).toEqual(input.l1)
    expect(parsed.data.favorites).toEqual(input.favorites)
    expect(parsed.data.blacklist).toEqual(input.blacklist)
    expect(parsed.data.filterConfig).toEqual(input.filterConfig)
  })

  it('逐件校验拦坏数据', () => {
    expect(parseTagRecConfig('not json').ok).toBe(false)
    expect(parseTagRecConfig('[]').ok).toBe(false)
    expect(parseTagRecConfig('{}').ok).toBe(false) // 缺 version
    const base = serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: filterSettings() })
    expect(parseTagRecConfig(JSON.stringify({ ...base, version: TAG_REC_EXPORT_VERSION + 1 })).ok).toBe(false)
    expect(parseTagRecConfig(JSON.stringify({ ...base, version: '1' })).ok).toBe(false) // 非数
    // 无名空组 / id 非整数 / name 缺失仍拒；命名空组允许备份。
    expect(parseTagRecConfig(JSON.stringify({ ...base, favorites: [g('a', [], { name: '  ' })] })).ok).toBe(false)
    expect(parseTagRecConfig(JSON.stringify({ ...base, favorites: [g('a', [1.5] as unknown as number[])] })).ok).toBe(
      false,
    )
    // blacklist 结构
    expect(parseTagRecConfig(JSON.stringify({ ...base, blacklist: [{ id: 'x', name: 'n' }] })).ok).toBe(false)
    // filterConfig 结构垃圾仍拒 (非对象 / presets 坏条目); 缺键经归一填出厂不再拒 (见宽容归一用例)
    expect(parseTagRecConfig(JSON.stringify({ ...base, filterConfig: 5 })).ok).toBe(false)
    expect(
      parseTagRecConfig(JSON.stringify({ ...base, filterConfig: { ...filterSettings(), presets: [{ name: 1 }] } })).ok,
    ).toBe(false)
  })

  it('favorites/l1 enabled 键可缺 (分享包剥键档), 在则须布尔 —— 缺省与布尔皆过, 非布尔仍拒', () => {
    const base = serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: filterSettings() })
    const strip = (o: TagGroup | TagL1Group) => {
      const c: Record<string, unknown> = { ...o }
      delete c.enabled
      return c
    }
    // 缺省合法: 组/L1 均无 enabled 键
    const bare = {
      ...base,
      favorites: [strip(g('a', [1], { name: 'x' }))],
      l1: [strip(l1('A'))],
    }
    expect(parseTagRecConfig(JSON.stringify(bare)).ok).toBe(true)
    // 布尔合法 (本地备份档携开关位回导)
    const withBool = { ...bare, favorites: [{ ...bare.favorites[0], enabled: false }] }
    expect(parseTagRecConfig(JSON.stringify(withBool)).ok).toBe(true)
    // 非布尔仍拒 (组/L1 同口径)
    const badG = { ...bare, favorites: [{ ...bare.favorites[0], enabled: 'yes' }] }
    expect(parseTagRecConfig(JSON.stringify(badG)).ok).toBe(false)
    const badL1 = { ...bare, l1: [{ ...bare.l1[0], enabled: 1 }] }
    expect(parseTagRecConfig(JSON.stringify(badL1)).ok).toBe(false)
  })

  it('filterConfig 宽容归一 (票 46): dims/score 缺键填出厂值; 存在但畸形仍拒', () => {
    const base = serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: filterSettings() })
    // 旧档缺后加的 dims 键 (partition*/titleKeywords 票 33/34 前导出) => 填出厂不拒档
    const legacyDims: Record<string, unknown> = { ...filterSettings().dims }
    delete legacyDims.partitionBlock
    delete legacyDims.partitionAllow
    delete legacyDims.titleKeywords
    delete legacyDims.upBlacklist
    const legacy = { ...filterSettings(), dims: legacyDims }
    const parsed = parseTagRecConfig(JSON.stringify({ ...base, filterConfig: legacy }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.filterConfig.dims.partitionBlock).toEqual({ enabled: false, list: [] })
    expect(parsed.data.filterConfig.dims.partitionAllow).toEqual({ enabled: false, list: [] })
    expect(parsed.data.filterConfig.dims.titleKeywords).toEqual({ enabled: false, list: [] })
    expect(parsed.data.filterConfig.dims.likeRate).toEqual({ enabled: false, value: 0.02 }) // 缺键补当前出厂值
    // filterConfig:{} / dims:{} 极端缺省 => 全出厂回落
    expect(parseTagRecConfig(JSON.stringify({ ...base, filterConfig: {} })).ok).toBe(true)
    expect(parseTagRecConfig(JSON.stringify({ ...base, filterConfig: { dims: {} } })).ok).toBe(true)
    // presets config 同款宽容
    const legacyPreset = {
      ...filterSettings(),
      presets: [{ name: '旧档', config: { ...createTagRecFactoryFilterCore(), dims: {} } }],
    }
    const p2 = parseTagRecConfig(JSON.stringify({ ...base, filterConfig: legacyPreset }))
    expect(p2.ok).toBe(true)
    if (!p2.ok) return
    expect(p2.data.filterConfig.presets[0].config.dims.partitionBlock).toEqual({ enabled: false, list: [] })
    // 存在但畸形仍拒
    const badDim = {
      ...filterSettings(),
      dims: { ...filterSettings().dims, partitionBlock: { enabled: 'x', list: [] } },
    }
    expect(parseTagRecConfig(JSON.stringify({ ...base, filterConfig: badDim })).ok).toBe(false)
    const badPreset = { ...filterSettings(), presets: [{ name: '坏', config: { dims: 'x' } }] }
    expect(parseTagRecConfig(JSON.stringify({ ...base, filterConfig: badPreset })).ok).toBe(false)
  })

  it('presets 导入剥伪造 builtin + activePreset 悬空置空 (AUDIT-19 僵尸预设/悬空激活防护)', () => {
    const base = serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: filterSettings() })
    const cfg = createTagRecFactoryFilterCore()
    const forged = {
      ...filterSettings(),
      activePreset: '伪造内置',
      presets: [
        { name: '全放', builtin: true, config: cfg }, // 出厂名 => builtin 保留
        { name: '伪造内置', builtin: true, config: cfg }, // 非出厂名 => 剥 builtin
        { name: '普通', config: cfg },
      ],
    }
    const parsed = parseTagRecConfig(JSON.stringify({ ...base, filterConfig: forged }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const f = parsed.data.filterConfig
    expect(f.presets.find((p) => p.name === '全放')?.builtin).toBe(true) // 出厂名 builtin 保留
    expect(f.presets.find((p) => p.name === '伪造内置')?.builtin).toBeFalsy() // 伪造 builtin 剥除
    expect(f.activePreset).toBe('伪造内置') // 在归一后名单内 => 保留
    // 剥 builtin 后可删 => 非僵尸 (filter-engine 拒操作语义不动)
    expect(removeTagRecPreset(f, '伪造内置')).toBe(true)
    // 悬空 activePreset (指向不存在预设名) => 置 '' 自定义态
    const dangling = parseTagRecConfig(
      JSON.stringify({
        ...base,
        filterConfig: { ...filterSettings(), activePreset: '不存在预设', presets: forged.presets },
      }),
    )
    expect(dangling.ok && dangling.data.filterConfig.activePreset).toBe('')
  })

  it('.validateTagRecFilterSettings 各维度字段类型', () => {
    const ok = filterSettings()
    expect(validateTagRecFilterSettings(ok)).toBe(true)
    expect(validateTagRecFilterSettings({ ...ok, strictMode: 1 })).toBe(false)
    expect(validateTagRecFilterSettings({ ...ok, activePreset: 3 })).toBe(false)
    const badDim = { ...ok, dims: { ...ok.dims, duration: { enabled: true, min: 'x', max: 0 } } }
    expect(validateTagRecFilterSettings(badDim)).toBe(false)
    const badPart = { ...ok, dims: { ...ok.dims, partition: { enabled: true, mode: 'x', list: [] } } }
    expect(validateTagRecFilterSettings(badPart)).toBe(false)
    const badScore = { ...ok, score: { weights: { view: 'a' }, anchors: ok.score.anchors } }
    expect(validateTagRecFilterSettings(badScore)).toBe(false)
    // 自定义 preset 名+config 合法 => 过
    const withCustom = { ...ok, presets: [...ok.presets, { name: '自定义', config: createTagRecFactoryFilterCore() }] }
    expect(validateTagRecFilterSettings(withCustom)).toBe(true)
  })

  it('.planTagRecImport 重叠照常入表 (票 14 跨组重复合法), overlapped 信息上报; 无效组拒', () => {
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [
        g('new1', [10, 11], { name: '可入' }),
        g('new2', [2], { name: '撞表内' }), // id 2 已在 existing —— 照常入, 上报
        g('new3', [11], { name: '撞本批' }), // id 11 已被 new1 收 —— 照常入, 上报
        g('bad', [], { name: '' } as Partial<TagGroup>),
      ],
      blacklist: [
        { id: 1, name: '已黑' },
        { id: 2, name: '新黑' },
      ],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, { favorites: [g('exist', [2])], blacklist: [{ id: 1, name: '已黑' }] })
    expect(plan.favoritesToAdd.map((x) => x.id)).toEqual(['new1', 'new2', 'new3'])
    expect(plan.invalidGroups).toEqual(['(未命名组)'])
    expect(plan.overlappedGroups).toEqual([
      { name: '撞表内', hitGroupName: 'exist' },
      { name: '撞本批', hitGroupName: '可入' },
    ])
    expect(plan.blacklistToAdd).toEqual([{ id: 2, name: '新黑' }])
  })

  it('.planTagRecImport conflicts 清单 (feat: 冲突交用户裁量): 共享 id / 同源撞车逐条记录', () => {
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [
        // 导出再导回的典型: 同组 id + 正向全共享 => sameEntity 命中宿主
        g('hostA', [1, 2, 3], { name: '回导A' }),
        // 部分重叠: 与 hostA 共享 1 个 id (跨组重复合法, 但报冲突交裁量)
        g('newC', [2, 9], { name: '部叠C' }),
        // 完全不重叠 => 不进冲突清单
        g('clean', [8], { name: '无冲突' }),
      ],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, {
      favorites: [g('hostA', [1, 2, 3], { name: '宿主A' }), g('hostB', [4, 5], { name: '宿主B' })],
      blacklist: [],
    })
    expect(plan.conflicts).toHaveLength(2)
    const dup = plan.conflicts.find((c) => c.group.name === '回导A')!
    // 同源撞车组 id 已换新 uuid (不落重复实体 id); hits[0] = 原宿主
    expect(dup.group.id).not.toBe('hostA')
    expect(dup.hits[0]).toMatchObject({ id: 'hostA', name: '宿主A', shared: [1, 2, 3], sameEntity: true })
    const part = plan.conflicts.find((c) => c.group.name === '部叠C')!
    expect(part.hits[0]).toMatchObject({ id: 'hostA', shared: [2], sameEntity: false })
    expect(plan.conflicts.some((c) => c.group.name === '无冲突')).toBe(false)
    // favoritesToAdd 仍是全量 —— 并入/保留/跳过的裁量在调用侧, plan 只产素材
    expect(plan.favoritesToAdd).toHaveLength(3)
  })

  it('.planTagRecImport 本批内互撞也进 conflicts (同档两组共享 id: 后者命中先行者)', () => {
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [g('x1', [1, 2], { name: '先行者' }), g('x2', [2, 3], { name: '后者' })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, { favorites: [], blacklist: [] })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].group.name).toBe('后者')
    expect(plan.conflicts[0].hits[0]).toMatchObject({ name: '先行者', shared: [2], sameEntity: false })
    // 宿主 id = 先行者的入表 id
    expect(plan.conflicts[0].hits[0].id).toBe(plan.favoritesToAdd[0].id)
  })

  it('.planTagRecImport 负向成员随组导入: 互斥剔除 + strict 透传', () => {
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [g('g1', [1, 2], { negative_tag_ids: [e(2, '撞正向'), e(7)], negative_strict: true })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, { favorites: [], blacklist: [] })
    expect(plan.favoritesToAdd).toHaveLength(1)
    expect(plan.favoritesToAdd[0].negative_tag_ids).toEqual([e(7)])
    expect(plan.favoritesToAdd[0].negative_strict).toBe(true)
  })

  it('.planTagRecImport 组 id 撞车换新 id; weight/ids 规范化保留', () => {
    const data = serializeTagRecConfig({
      l1: [],
      favorites: [g('dup-id', [8, 8, 9], { weight: 9 })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, { favorites: [g('dup-id', [77])], blacklist: [] })
    expect(plan.favoritesToAdd).toHaveLength(1)
    expect(plan.favoritesToAdd[0].id).not.toBe('dup-id')
    expect(plan.favoritesToAdd[0].tag_ids.map((x) => x.id)).toEqual([8, 9])
    expect(plan.favoritesToAdd[0].weight).toBe(5) // clamp
  })

  it('l1 节往返 (票 17): 导出携一级组+组归属, 导入还原 l1ToAdd 与组 l1Id 对回', () => {
    const data = serializeTagRecConfig({
      l1: [l1('L1a', { weight: 3 }), l1('L1b', { enabled: false, note: 'n' })],
      favorites: [
        g('ga', [1], { l1Id: 'L1a' }),
        g('gb', [2], { l1Id: 'L1b' }),
        g('gc', [3]), // 无归属
      ],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const parsed = parseTagRecConfig(stringifyTagRecConfig(data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [], l1: [] })
    expect(plan.l1ToAdd).toEqual([
      { id: 'L1a', name: '一级L1a', enabled: true, weight: 3, addedAt: 50 },
      { id: 'L1b', name: '一级L1b', enabled: false, weight: 1, note: 'n', addedAt: 50 },
    ])
    expect(plan.favoritesToAdd.map((x) => x.l1Id)).toEqual(['L1a', 'L1b', undefined])
  })

  it('l1 id 撞车复用既有不重复建; 悬挂 l1Id 不携归属 (落表 auto-wrap); 组指认表内既有 L1 直接对回', () => {
    const existingL1 = l1('L1a', { name: '表内壳' })
    const data = serializeTagRecConfig({
      l1: [l1('L1a', { name: '文件壳' }), l1('L1x')],
      favorites: [
        g('g1', [1], { l1Id: 'L1a' }), // 指到撞车 L1 => 对回表内同 id 壳
        g('g2', [2], { l1Id: 'L1x' }),
        g('g3', [3], { l1Id: 'ghost' }), // 悬挂 => 不携归属
        g('g4', [4], { l1Id: 'L1host' }), // 不在文件节内但在表内 => 认表内既有
      ],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, {
      favorites: [],
      blacklist: [],
      l1: [existingL1, l1('L1host')],
    })
    expect(plan.l1ToAdd.map((x) => x.id)).toEqual(['L1x']) // L1a 复用既有, 只新增 L1x
    expect(plan.favoritesToAdd.map((x) => x.l1Id)).toEqual(['L1a', 'L1x', undefined, 'L1host'])
  })

  it('旧版导出 (无 l1 节) 照常解析: l1 归一为 [], 组不带归属 (auto-wrap 兜底)', () => {
    const legacy = JSON.stringify({
      version: 1,
      favorites: [g('old', [9])],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const parsed = parseTagRecConfig(legacy)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.l1).toEqual([])
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [] })
    expect(plan.l1ToAdd).toEqual([])
    expect(plan.favoritesToAdd[0].l1Id).toBeUndefined()
    // l1 节存在但结构不合法 => 拒
    const bad = JSON.parse(legacy) as Record<string, unknown>
    bad.l1 = [{ id: 'x', name: '  ' }] // 空名
    expect(parseTagRecConfig(JSON.stringify(bad)).ok).toBe(false)
  })

  it('themes/activeThemeId 节往返 (票 26/46): themeId 随 L1 对回, 当前主题还原', () => {
    const theme = { id: 'T1', name: '主题一', addedAt: 7 }
    const data = serializeTagRecConfig({
      themes: [theme],
      activeThemeId: 'T1',
      l1: [l1('L1a', { themeId: 'T1' }), l1('L1b')],
      favorites: [g('ga', [1], { l1Id: 'L1a' })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const parsed = parseTagRecConfig(stringifyTagRecConfig(data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.themes).toEqual([theme])
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [] })
    expect(plan.themesToAdd).toEqual([theme])
    expect(plan.synthesizedThemes).toBe(0)
    expect(plan.l1ToAdd).toEqual([
      { id: 'L1a', name: '一级L1a', themeId: 'T1', enabled: true, weight: 1, addedAt: 50 },
      { id: 'L1b', name: '一级L1b', enabled: true, weight: 1, addedAt: 50 },
    ])
    expect(plan.activeThemeId).toBe('T1')
  })

  it('悬挂 themeId 合成兜底 (票 46): 历史导出无 themes 节 => 按首个引用 L1 名补建主题, 归属不丢', () => {
    // 「完美」档形状: l1 携 themeId 但文件无 themes 节 (主题节从未写盘的历史版本产物)
    const data = serializeTagRecConfig({
      l1: [l1('L1a', { themeId: 'ghostT' }), l1('L1b', { themeId: 'ghostT' }), l1('L1c', { themeId: 'ghostT2' })],
      favorites: [g('ga', [1])],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    delete data.themes // 模拟历史导出缺节
    const plan = planTagRecImport(data, { favorites: [], blacklist: [] })
    expect(plan.themesToAdd).toEqual([
      { id: 'ghostT', name: '一级L1a', addedAt: 50 },
      { id: 'ghostT2', name: '一级L1c', addedAt: 50 },
    ])
    expect(plan.synthesizedThemes).toBe(2)
    expect(plan.l1ToAdd.map((x) => x.themeId)).toEqual(['ghostT', 'ghostT', 'ghostT2'])
  })

  it('themeId/activeThemeId 语义细节: 引用表内既有主题不重复建; 悬挂 activeThemeId 不动当前; null => 「全部」', () => {
    const existingTheme = { id: 'Texist', name: '表内主题', addedAt: 1 }
    const data = serializeTagRecConfig({
      themes: [existingTheme],
      l1: [l1('L1a', { themeId: 'Texist' })],
      favorites: [],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(data, { favorites: [], blacklist: [], themes: [existingTheme] })
    expect(plan.themesToAdd).toEqual([]) // id 撞车复用既有
    expect(plan.l1ToAdd[0].themeId).toBe('Texist')

    // activeThemeId 悬挂 (节内/表内皆无且无 L1 引用) => undefined 不动当前
    const dangling = { ...data, activeThemeId: 'ghostActive' }
    expect(planTagRecImport(dangling, { favorites: [], blacklist: [] }).activeThemeId).toBeUndefined()
    // null => 明示「全部」复位
    const cleared = { ...data, activeThemeId: null }
    expect(planTagRecImport(cleared, { favorites: [], blacklist: [] }).activeThemeId).toBeNull()
    // activeThemeId 恰好是被合成的悬挂引用 => 对回合成主题
    const danglingL1 = serializeTagRecConfig({
      l1: [l1('L1x', { themeId: 'ghostT' })],
      favorites: [],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    delete danglingL1.themes
    const plan2 = planTagRecImport({ ...danglingL1, activeThemeId: 'ghostT' }, { favorites: [], blacklist: [] })
    expect(plan2.activeThemeId).toBe('ghostT')
    // themes 节结构不合法 => 拒
    const badThemes = { ...data, themes: [{ id: 'x', name: '  ' }] }
    expect(parseTagRecConfig(JSON.stringify(badThemes)).ok).toBe(false)
  })

  it('overrides 深层畸形消毒 (R3-04): dims/score/pools 畸形键弃之不拒档; negative 深校透传', () => {
    const base = serializeTagRecConfig({
      l1: [l1('L1a')],
      favorites: [g('ga', [1])],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const raw = JSON.parse(stringifyTagRecConfig(base)) as Record<string, any>
    // 组层: 畸形 dims 键 / score 异物与非法值 / pools 非白名单键+畸形槽; negative 合法原样
    raw.favorites[0].overrides = {
      dims: {
        viewMin: { enabled: true, value: 'x' }, // 值非数 => 整键弃
        pubdate: { enabled: true, win: {} }, // win 非法 => 整键弃
        likeMin: { enabled: true, value: 5 }, // 合法保留
        duration: 'x', // 非对象 => 弃
        名单维: { enabled: true }, // 白名单外 => 弃
      },
      score: {
        weights: { view: 'x', likeRate: 0.5, evil: 9 }, // 只收白名单数值键
        anchors: { viewLog10: 7, bad: 'x' },
      },
      pools: {
        tagTop: { dims: { viewMin: { enabled: true } } }, // 槽内畸形 => 槽弃
        archiveRelated: { smallPoolThreshold: 7 }, // 合法槽保留
        evilPool: { smallPoolThreshold: 1 }, // 非池键 => 弃
      },
      negative: { title: ['广告'] }, // 已深校 => 透传
      smallPoolThreshold: 3,
    }
    // L1 层同款 (无格槽): dims 畸形弃 + negative 透传
    raw.l1[0].overrides = {
      dims: { viewMin: 'x', coinMax: { enabled: true, value: 2 } },
      score: { weights: { coinRate: 0.9 } },
      negative: { up: [{ name: 'x', mid: 42 }] },
    }
    const parsed = parseTagRecConfig(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [] })
    const ov = plan.favoritesToAdd[0].overrides
    expect(ov?.dims).toEqual({ likeMin: { enabled: true, value: 5 } })
    expect(ov?.score?.weights).toEqual({ likeRate: 0.5 })
    expect(ov?.score?.anchors).toEqual({ viewLog10: 7 })
    expect(ov?.pools).toEqual({ archiveRelated: { smallPoolThreshold: 7 } })
    expect(ov?.negative?.title).toEqual(['广告'])
    expect(ov?.smallPoolThreshold).toBe(3)
    const l1ov = plan.l1ToAdd[0].overrides
    expect(l1ov?.dims).toEqual({ coinMax: { enabled: true, value: 2 } })
    expect(l1ov?.score?.weights).toEqual({ coinRate: 0.9 })
    expect(l1ov?.negative?.up).toEqual([{ name: 'x', mid: 42 }])
    // filterConfig.pools 同消毒点: 畸形槽弃
    const raw2 = structuredClone(base) as Record<string, any>
    raw2.filterConfig.pools = {
      allV2: { score: { weights: { view: 'x', favRate: 0.4 } } }, // 'x' 滤除, 合法键留
      bogus: { smallPoolThreshold: 1 },
    }
    const p2 = parseTagRecConfig(JSON.stringify(raw2))
    expect(p2.ok).toBe(true)
    if (!p2.ok) return
    expect(p2.data.filterConfig.pools).toEqual({ allV2: { score: { weights: { favRate: 0.4 } } } })
  })

  it('分区名单 number 迁移 (R3-05): v2 一级分区段只发 v1 键保死值; v1/v2 叶段双键等值', () => {
    const base = serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: filterSettings() })
    const raw = structuredClone(base) as Record<string, any>
    raw.filterConfig.dims.partitionBlock = { enabled: true, list: [1010, 4, 2079] }
    const parsed = parseTagRecConfig(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.filterConfig.dims.partitionBlock.list).toEqual([
      { name: '#1010', v1: 1010 }, // v2 pid 段: 死值保死 —— 双键会复活成整分区屏蔽
      { name: '#4', v1: 4, v2: 4 }, // v1 段双键 (旧义活值, 叶展开属可接受升级)
      { name: '#2079', v1: 2079, v2: 2079 }, // v2 叶段双键等值 (旧义等值还原)
    ])
    // 旧形 partition{mode,list} 同路径
    const raw2 = structuredClone(base) as Record<string, any>
    raw2.filterConfig.dims.partition = { enabled: true, mode: 'allow', list: [1010] }
    const p2 = parseTagRecConfig(JSON.stringify(raw2))
    expect(p2.ok).toBe(true)
    if (!p2.ok) return
    expect(p2.data.filterConfig.dims.partitionAllow.list).toEqual([{ name: '#1010', v1: 1010 }])
  })

  it('.mergeTagRecConfigExports 批量合并: 节 concat + 同签名组/黑名单去重 + 末件 filterConfig/activeThemeId 胜出', () => {
    const a = serializeTagRecConfig({
      themes: [{ id: 'T1', name: '主题一', addedAt: 1 }],
      activeThemeId: 'T1',
      l1: [l1('LA')],
      favorites: [g('g1', [1, 2], { name: '组一' }), g('dup', [5], { name: '重复组' })],
      blacklist: [{ id: 1, name: '黑一' }],
      filterConfig: { ...filterSettings(), activePreset: '淘沙' },
    })
    const b = serializeTagRecConfig({
      themes: [{ id: 'T2', name: '主题二', addedAt: 2 }],
      activeThemeId: 'T2',
      l1: [l1('LB')],
      favorites: [
        g('other-id', [5], { name: '重复组' }), // 同签名 (名+id集相同) 异 id => 去重收首件
        g('g2', [9], { name: '组二' }),
      ],
      blacklist: [
        { id: 1, name: '黑一' }, // 同 id 重份 => 去重
        { id: 2, name: '黑二' },
      ],
      filterConfig: { ...filterSettings(), activePreset: '全放' },
    })
    const merged = mergeTagRecConfigExports([a, b])
    expect(merged.themes?.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(merged.l1.map((x) => x.id)).toEqual(['LA', 'LB'])
    expect(merged.favorites.map((x) => x.name)).toEqual(['组一', '重复组', '组二'])
    expect(merged.favorites[1].id).toBe('dup')
    expect(merged.blacklist.map((x) => x.id)).toEqual([1, 2])
    expect(merged.activeThemeId).toBe('T2') // 末件胜出
    expect(merged.filterConfig.activePreset).toBe('全放')
    // 同 id 异内容 = 真冲突, 不去重 (签名不同照常入批)
    const c = serializeTagRecConfig({
      l1: [],
      favorites: [g('same', [7, 8], { name: '异内容' })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const d = serializeTagRecConfig({
      l1: [],
      favorites: [g('same', [1], { name: '原版' })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    expect(mergeTagRecConfigExports([c, d]).favorites).toHaveLength(2)
  })

  it('A17: batch import preserves distinct L2 and inherited L1 source declarations for conflict review', () => {
    const pack = (enabled: boolean, atParent: boolean) =>
      serializeTagRecConfig({
        l1: [l1('P', { overrides: atParent ? { poolsEnabled: { tagTop: enabled } } : undefined })],
        favorites: [
          g('same', [7], {
            name: 'same',
            l1Id: 'P',
            overrides: !atParent ? { poolsEnabled: { tagTop: enabled } } : undefined,
          }),
        ],
        blacklist: [],
        filterConfig: filterSettings(),
      })
    for (const atParent of [false, true]) {
      const merged = mergeTagRecConfigExports([pack(false, atParent), pack(true, atParent)])
      expect(merged.favorites).toHaveLength(2)
      const plan = planTagRecImport(merged, { favorites: [], blacklist: [] })
      expect(plan.favoritesToAdd).toHaveLength(2)
      expect(plan.conflicts).toHaveLength(1)
      if (atParent) {
        expect(merged.favorites[0].l1Id).not.toBe(merged.favorites[1].l1Id)
        expect(plan.l1ToAdd.map((l) => l.overrides?.poolsEnabled?.tagTop)).toEqual([false, true])
      } else expect(plan.favoritesToAdd.map((g) => g.overrides?.poolsEnabled?.tagTop)).toEqual([false, true])
    }
  })

  it('.mergeTagRecConfigExports 单文件等价原样 + 合并件走同一 plan (跨文件共享 id 进 conflicts)', () => {
    const single = serializeTagRecConfig({
      themes: [{ id: 'T1', name: '主题一', addedAt: 1 }],
      activeThemeId: null,
      l1: [l1('LA')],
      favorites: [g('x', [1, 2], { name: 'A组' })],
      blacklist: [{ id: 1, name: '黑一' }],
      filterConfig: filterSettings(),
    })
    const mergedSingle = mergeTagRecConfigExports([single])
    expect(mergedSingle).toEqual({ ...single, version: 2 })
    // 两文件合批: 跨文件共享 id => 后者命中先行者 (冲突裁量与单文件同管线)
    const b = serializeTagRecConfig({
      l1: [],
      favorites: [g('y', [2, 3], { name: 'B组' })],
      blacklist: [],
      filterConfig: filterSettings(),
    })
    const plan = planTagRecImport(mergeTagRecConfigExports([single, b]), { favorites: [], blacklist: [] })
    expect(plan.favoritesToAdd.map((x) => x.name)).toEqual(['A组', 'B组'])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].group.name).toBe('B组')
    expect(plan.conflicts[0].hits[0]).toMatchObject({ name: 'A组', shared: [2] })
    expect(plan.activeThemeId).toBeNull() // b 声明 null (serialize 缺省写 null) => 末件胜出 = 「全部」复位
    expect(plan.blacklistToAdd).toEqual([{ id: 1, name: '黑一' }])
  })
})

describe.concurrent('$modules/tag-rec/model/import-export — CSV 出方向 (§6.2)', () => {
  it('列正确 + 多 id `;` 连 + enabled/note', () => {
    const csv = favoritesToCsv([
      g('a', [1, 2, 3], { name: '多id组', weight: 4, note: '备注', negative_tag_ids: [e(8), e(9)] }),
      g('b', [7], { name: '单', enabled: false, weight: 0 }),
    ])
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('name,tag_id,weight,enabled,note,neg_tag_id')
    expect(lines[1]).toBe('多id组,1;2;3,4,true,备注,8;9')
    expect(lines[2]).toBe('单,7,0,false,,')
  })

  it('.csvEscapeField 转义/引号惯例', () => {
    expect(csvEscapeField('plain')).toBe('plain')
    expect(csvEscapeField('a,b')).toBe('"a,b"')
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscapeField('line\nbreak')).toBe('"line\nbreak"')
    // 含逗号+引号+换行的组名出方向不炸
    const csv = favoritesToCsv([g('x', [1], { name: 'a,"b"\nc' })])
    expect(csv).toContain('"a,""b""\nc",1,1,true,,')
  })

  it('产物可回导: export => parseCsvText => csvRecordsToImportRows', () => {
    const groups = [g('a', [1, 2], { name: '组A' }), g('b', [3], { name: '组,B' })]
    const rows = csvRecordsToImportRows(parseCsvText(favoritesToCsv(groups)))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ rawName: '组A', tagIds: [1, 2], source: 'id-column' })
    expect(rows[1]).toMatchObject({ rawName: '组,B', tagIds: [3], source: 'id-column' })
  })

  it('往返 neg_tag_id 不丢 (AUDIT-43): neg 列回读为 negTagIds, plan 落组 negative_tag_ids', () => {
    const rows = csvRecordsToImportRows(
      parseCsvText(
        favoritesToCsv([
          g('a', [1, 2], { name: '组A', negative_tag_ids: [e(8), e(9)] }),
          g('b', [3], { name: '无负向' }),
        ]),
      ),
    )
    expect(rows.map((r) => r.negTagIds)).toEqual([[8, 9], []])
    // 走完 modal 解析路径 (id 列逐条 ById 反查名) 后确认入表 => 负向 id 随组还原, 正向不染
    const resolved = rows.map((r) => ({
      ...applyCsvRowResolution(
        r,
        r.tagIds.map((id) => ({ id, name: `tag${id}` })),
      ),
      checked: true,
    }))
    const plan = planCsvImport(resolved, [])
    expect(plan.toAdd.map((x) => x.tag_ids.map((y) => y.id))).toEqual([[1, 2], [3]])
    expect(plan.toAdd.map((x) => x.negative_tag_ids?.map((y) => y.id))).toEqual([[8, 9], undefined])
  })
})

describe.concurrent('$modules/tag-rec/model/import-export — CSV 入方向 (§6.2)', () => {
  it('.parseCsvText RFC 惯例: 引号字段/"" 转义/CRLF/BOM', () => {
    expect(parseCsvText('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseCsvText('"x,y",z')).toEqual([['x,y', 'z']])
    expect(parseCsvText('"a""b",c')).toEqual([['a"b', 'c']])
    expect(parseCsvText('﻿name,tag_id\nfoo,1')).toEqual([
      ['name', 'tag_id'],
      ['foo', '1'],
    ])
    expect(parseCsvText('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseCsvText('only')).toEqual([['only']])
    expect(parseCsvText('')).toEqual([])
  })

  it('.parseTagIdCell `;` 连 + 去重 + 滤非法', () => {
    expect(parseTagIdCell('1;2;3')).toEqual([1, 2, 3])
    expect(parseTagIdCell(' 12 ; 34 ')).toEqual([12, 34])
    expect(parseTagIdCell('5;5;abc;-1;0')).toEqual([5])
    expect(parseTagIdCell('')).toEqual([])
    expect(parseTagIdCell(undefined)).toEqual([])
  })

  it('.csvRecordsToImportRows header 检测 + 空行丢弃 + source 标记', () => {
    const rows = csvRecordsToImportRows([
      ['name', 'tag_id', 'weight', 'enabled', 'note', 'neg_tag_id'],
      ['foo', ''],
      ['bar', '12;34'],
      ['', ''],
      ['baz'],
    ])
    expect(rows.map((r) => [r.rawName, r.tagIds])).toEqual([
      ['foo', []],
      ['bar', [12, 34]],
      ['baz', []],
    ])
    expect(rows[0].source).toBe('name')
    expect(rows[1].source).toBe('id-column')
    // 无 header 的纯名单同样过
    expect(csvRecordsToImportRows([['solo']])).toHaveLength(1)
    // header 只判首个非空行: 中段存在名为 name 的标签不误杀
    expect(csvRecordsToImportRows([['foo'], ['name', '9']]).map((r) => r.rawName)).toEqual(['foo', 'name'])
    // 首行空记录后接 header 照样识别 (大小写/空白容忍)
    expect(
      csvRecordsToImportRows([[''], ['NAME', 'tag_id ', 'weight', 'enabled', 'note', 'neg_tag_id'], ['foo']]),
    ).toHaveLength(1)
  })

  it('组名恰为「name」的首行不误杀 (AUDIT-43): 表头须整行恰为导出列序', () => {
    // 组名 = name 的数据行照常入 (旧实现 col0=='name' 一刀切跳过丢首行)
    expect(csvRecordsToImportRows([['name', '5'], ['name'], ['foo', '6']]).map((r) => [r.rawName, r.tagIds])).toEqual([
      ['name', [5]],
      ['name', []],
      ['foo', [6]],
    ])
    // 出方向产物里首个组就叫 name: 行有真实数据列 != 表头 => 可回导
    const csv = favoritesToCsv([g('x', [5], { name: 'name' })])
    expect(csvRecordsToImportRows(parseCsvText(csv)).map((r) => r.rawName)).toEqual(['name'])
    // 列序相符但不完整 => 不当表头 (收窄代价: 手写简表头 name,tag_id 落成一行待解析「name」, 不静默丢数据)
    expect(
      csvRecordsToImportRows([
        ['name', 'tag_id'],
        ['foo', '1'],
      ]).map((r) => r.rawName),
    ).toEqual(['name', 'foo'])
  })

  it('.applyCsvRowResolution 状态机: 全成 => resolved 默认勾; 任一空 => 待解析', () => {
    const r = row({ key: 'r1', tagIds: [11] })
    const ok = applyCsvRowResolution(r, [{ id: 11, name: '解析名', use: 42 }])
    expect(ok).toMatchObject({ status: 'resolved', checked: true, use: 42, tagIds: [11] })
    expect(ok.resolvedEntries).toEqual([{ id: 11, name: '解析名', tag_type: undefined }])
    const fail = applyCsvRowResolution(r, [undefined])
    expect(fail).toMatchObject({ status: 'pending', checked: false })
    // 多 id: 任一失败 => 待解析; 全成 => use 取 max
    const multi = row({ key: 'r2', tagIds: [1, 2] })
    expect(applyCsvRowResolution(multi, [{ id: 1, name: 'a' }, undefined]).status).toBe('pending')
    const done = applyCsvRowResolution(multi, [
      { id: 1, name: 'a', use: 5 },
      { id: 2, name: 'b', use: 99 },
    ])
    expect(done.use).toBe(99)
    expect(done.resolvedEntries.map((x) => x.name)).toEqual(['a', 'b'])
  })

  it('.checkCsvRowConflict: 命中既有表 => 「与组X重复」徽标仍勾 (票 14 不拦截); 未命中保 resolved', () => {
    const existing = [g('宿主组', [7])]
    const resolved = row({ status: 'resolved', checked: true, tagIds: [7], resolvedEntries: [e(7)] })
    const hit = checkCsvRowConflict(resolved, existing)
    expect(hit).toMatchObject({ status: 'conflict', checked: true, conflictGroupName: '宿主组' })
    const miss = checkCsvRowConflict(
      row({ status: 'resolved', checked: true, tagIds: [9], resolvedEntries: [e(9)] }),
      existing,
    )
    expect(miss.status).toBe('resolved')
    // 非 resolved 行不动
    const pending = row({ status: 'pending' })
    expect(checkCsvRowConflict(pending, existing)).toBe(pending)
  })

  it('.resetCsvRowForRetry 清产物回 ready', () => {
    const r = resetCsvRowForRetry(row({ status: 'conflict', resolvedEntries: [e(1)], use: 5, conflictGroupName: 'x' }))
    expect(r).toMatchObject({ status: 'ready', resolvedEntries: [], conflictGroupName: undefined })
  })

  it('.planCsvImport 不勾不进表 + 重叠照常入表 (票 14), overlaps 信息上报', () => {
    const rows = [
      row({ key: 'a', rawName: '组1', status: 'resolved', checked: true, tagIds: [1], resolvedEntries: [e(1, '甲')] }),
      row({ key: 'b', rawName: '组2', status: 'resolved', checked: false, tagIds: [2], resolvedEntries: [e(2)] }), // 不勾
      row({ key: 'c', rawName: '组3', status: 'conflict', checked: true, tagIds: [1], resolvedEntries: [e(1)] }), // 撞 a
      row({ key: 'd', rawName: '组4', status: 'conflict', checked: true, tagIds: [7], resolvedEntries: [e(7)] }), // 撞表内
      row({ key: 'e', rawName: '待解析', status: 'pending', tagIds: [8] }), // 非 resolved
    ]
    const plan = planCsvImport(rows, [g('既有组', [7])])
    expect(plan.toAdd).toHaveLength(3) // a/c/d 全入 (c/d 重复徽标不拦)
    expect(plan.toAdd[0].tag_ids).toEqual([{ id: 1, name: '甲' }])
    expect(plan.overlaps).toEqual([
      { key: 'c', groupName: '组1' },
      { key: 'd', groupName: '既有组' },
    ])
  })

  it('.planCsvImport 组名空回落首 id 名', () => {
    const plan = planCsvImport(
      [row({ key: 'a', rawName: '', status: 'resolved', checked: true, tagIds: [3], resolvedEntries: [e(3, '名三')] })],
      [],
    )
    expect(plan.toAdd[0].name).toBe('名三')
  })

  it('.planCsvImport negTagIds 落组 (AUDIT-43): 借表内/本批真名, 缺名 #id 占位, 与本组正向撞车剔除', () => {
    const rows = [
      row({
        key: 'a',
        rawName: '组1',
        status: 'resolved',
        checked: true,
        tagIds: [1],
        resolvedEntries: [e(1, '甲')],
        negTagIds: [7, 8],
      }),
      row({
        key: 'b',
        rawName: '组2',
        status: 'resolved',
        checked: true,
        tagIds: [2],
        resolvedEntries: [e(2)],
        negTagIds: [1, 2, 9], // 1 借本批行 a 的解析名; 2 撞本组正向被互斥剔; 9 无源落占位
      }),
      row({
        key: 'c',
        rawName: '不勾',
        status: 'resolved',
        checked: false,
        tagIds: [3],
        resolvedEntries: [e(3)],
        negTagIds: [4],
      }),
    ]
    const plan = planCsvImport(rows, [g('exist', [5], { negative_tag_ids: [e(8, '负八')] })])
    expect(plan.toAdd).toHaveLength(2)
    expect(plan.toAdd[0].negative_tag_ids).toEqual([
      { id: 7, name: '#7' },
      { id: 8, name: '负八' },
    ])
    expect(plan.toAdd[1].negative_tag_ids).toEqual([
      { id: 1, name: '甲' },
      { id: 9, name: '#9' },
    ])
  })
})

describe.concurrent('$modules/tag-rec/model/import-export — resolveTagRecImportApply (票 18 裁量/勾选子集 => 落表决议)', () => {
  const data = (): TagRecConfigExportV1 => ({
    version: TAG_REC_EXPORT_VERSION,
    themes: [{ id: 't1', name: '主题t1', addedAt: 10 }],
    l1: [l1('A', { themeId: 't1' }), l1('B', { themeId: 't1' })],
    favorites: [g('n1', [1], { l1Id: 'A' }), g('n2', [2], { l1Id: 'B' }), g('n3', [3], { l1Id: 'B' })],
    blacklist: [],
    filterConfig: filterSettings(),
  })
  const empty = { favorites: [] as TagGroup[], blacklist: [] as TagBlacklistEntry[], l1: [], themes: [] }

  it('无裁量无子集 => 全量照 plan (主题/L1/组全落; merges 空; skippedCount 0)', () => {
    const plan = planTagRecImport(data(), empty)
    const r = resolveTagRecImportApply(plan)
    expect(r.groupsToAdd.map((x) => x.id)).toEqual(['n1', 'n2', 'n3'])
    expect(r.l1ToAdd.map((x) => x.id)).toEqual(['A', 'B'])
    expect(r.themesToAdd.map((x) => x.id)).toEqual(['t1'])
    expect(r.merges).toEqual([])
    expect(r.skippedCount).toBe(0)
  })

  it('choices: merge => merges 记 hits[0] 宿主; skip => 剔除并计数; 缺省 => keep 照常', () => {
    const plan = planTagRecImport(data(), { ...empty, favorites: [g('e0', [1])] }) // n1 与 e0 共享 tag 1
    expect(plan.conflicts.map((c) => c.group.id)).toEqual(['n1'])
    const merged = resolveTagRecImportApply(plan, { choices: { n1: 'merge' } })
    expect(merged.merges).toEqual([{ targetId: 'e0', src: plan.favoritesToAdd[0] }])
    expect(merged.groupsToAdd.map((x) => x.id)).toEqual(['n2', 'n3'])
    expect(merged.skippedCount).toBe(0)
    const skipped = resolveTagRecImportApply(plan, { choices: { n1: 'skip' } })
    expect(skipped.groupsToAdd.map((x) => x.id)).toEqual(['n2', 'n3'])
    expect(skipped.merges).toEqual([])
    expect(skipped.skippedCount).toBe(1)
    // 缺省 keep —— 冲突组照常入 (跨组共享 id 本就合法)
    expect(resolveTagRecImportApply(plan).groupsToAdd.map((x) => x.id)).toEqual(['n1', 'n2', 'n3'])
  })

  it('onlyGroupIds (分享勾选子集): 只落勾选组; 新 L1/主题裁到实际入表组的归属链', () => {
    const plan = planTagRecImport(data(), empty)
    const r = resolveTagRecImportApply(plan, { onlyGroupIds: new Set(['n3']) })
    expect(r.groupsToAdd.map((x) => x.id)).toEqual(['n3'])
    expect(r.l1ToAdd.map((x) => x.id)).toEqual(['B']) // n3 的归属; A 空壳裁掉
    expect(r.themesToAdd.map((x) => x.id)).toEqual(['t1']) // B.themeId=t1 仍被引用
    expect(r.skippedCount).toBe(0) // 未勾不算「跳过」
  })

  it('onlyGroupIds × skip 叠加: 勾选但裁量跳过的组也不保归属 (n1 落 => 只要 A)', () => {
    const plan = planTagRecImport(data(), { ...empty, favorites: [g('e0', [2])] }) // n2 与 e0 共享 tag 2
    const r = resolveTagRecImportApply(plan, { onlyGroupIds: new Set(['n1', 'n2']), choices: { n2: 'skip' } })
    expect(r.groupsToAdd.map((x) => x.id)).toEqual(['n1'])
    expect(r.skippedCount).toBe(1)
    expect(r.l1ToAdd.map((x) => x.id)).toEqual(['A']) // n2 skip => B 空壳裁掉
  })

  it('onlyGroupIds × merge: 并入组的归属 L1 仍保留 (并入失败回落照常入表要用)', () => {
    const plan = planTagRecImport(data(), { ...empty, favorites: [g('e0', [3])] }) // n3 与 e0 共享 tag 3
    const r = resolveTagRecImportApply(plan, {
      onlyGroupIds: new Set(['n3']),
      choices: { n3: 'merge' },
    })
    expect(r.merges).toEqual([{ targetId: 'e0', src: plan.favoritesToAdd[2] }])
    expect(r.groupsToAdd).toEqual([])
    expect(r.l1ToAdd.map((x) => x.id)).toEqual(['B']) // merge src 仍计归属 (宿主缺席回落时组带壳入)
  })
})

describe('R8 仅看家族 + 池筛选 (归一/往返)', () => {
  it('filterConfig 往返: 新键透传; 词表单字符丢; upAllow 条目保形; poolsEnabled 稀疏化 (只留 false)', () => {
    const fc = filterSettings()
    fc.dims.upAllow = { enabled: true, list: [{ name: 'UP甲', mid: 7 }, { name: 'UP乙' }] }
    fc.dims.titleAllow = { enabled: true, list: ['实况', 'a'] }
    fc.dims.descAllow = { enabled: false, list: ['预约'] }
    fc.poolsEnabled = { allV2Related: false, tagTop: true } // true 项手写注入: 归一时应丢弃
    const parsed = parseTagRecConfig(
      stringifyTagRecConfig(serializeTagRecConfig({ l1: [], favorites: [], blacklist: [], filterConfig: fc })),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const got = parsed.data.filterConfig
    expect(got.dims.upAllow).toEqual({ enabled: true, list: [{ name: 'UP甲', mid: 7 }, { name: 'UP乙' }] })
    expect(got.dims.titleAllow).toEqual({ enabled: true, list: ['实况'] })
    expect(got.dims.descAllow).toEqual({ enabled: false, list: ['预约'] }) // 关闸存表留待下次开
    expect(got.poolsEnabled).toEqual({ allV2Related: false })
  })

  it('组 overrides 新键: plan 归一透传 (poolsEnabled 稀疏化; 旧包缺键 => 出厂空维)', () => {
    const gRaw = g('a', [1], {
      overrides: {
        negative: {
          upAllow: { enabled: true, list: [{ name: 'X' }] },
          titleAllow: { enabled: true, list: ['词'] },
        },
        poolsEnabled: { tagTop: false, allV2: true },
      },
    })
    const parsed = parseTagRecConfig(
      stringifyTagRecConfig(
        serializeTagRecConfig({ l1: [l1('L1')], favorites: [gRaw], blacklist: [], filterConfig: filterSettings() }),
      ),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planTagRecImport(parsed.data, { favorites: [], blacklist: [] })
    const ov = plan.favoritesToAdd[0].overrides
    expect(ov?.negative?.upAllow).toEqual({ enabled: true, list: [{ name: 'X' }] })
    expect(ov?.negative?.titleAllow).toEqual({ enabled: true, list: ['词'] })
    expect(ov?.poolsEnabled).toEqual({ tagTop: false, allV2: true })
  })

  it('R8 迁移期宽容: 站点旧编辑器形状 (up 字符串 / partitionBlock 包装 / 分区字符串名) 通过校验', () => {
    const legacyUp: unknown = ['UP甲']
    const legacyBlock: unknown = { enabled: true, list: ['游戏'] }
    const legacyAllow: unknown = { enabled: true, list: ['生活'] }
    const gRaw = g('a', [1], {
      overrides: {
        negative: {
          up: legacyUp as never,
          partitionBlock: legacyBlock as never,
          partitionAllow: legacyAllow as never,
        },
      },
    })
    const parsed = parseTagRecConfig(
      stringifyTagRecConfig(
        serializeTagRecConfig({ l1: [], favorites: [gRaw], blacklist: [], filterConfig: filterSettings() }),
      ),
    )
    expect(parsed.ok).toBe(true) // 宽容收 (读侧 coerceTagRecNegativeShapes 收敛为规范形)
  })

  it('旧包兼容: filterConfig 缺新键 => 出厂空维 (enabled:false 空表)', () => {
    const fc = filterSettings() as unknown as Record<string, unknown>
    const dims = { ...(fc.dims as Record<string, unknown>) }
    delete dims.upAllow
    delete dims.titleAllow
    delete dims.descAllow
    const legacyFc: Record<string, unknown> = { ...fc, dims }
    const parsed = parseTagRecConfig(
      stringifyTagRecConfig(
        serializeTagRecConfig({
          l1: [],
          favorites: [],
          blacklist: [],
          filterConfig: legacyFc as never,
        }),
      ),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.filterConfig.dims.upAllow).toEqual({ enabled: false, list: [] })
    expect(parsed.data.filterConfig.dims.titleAllow).toEqual({ enabled: false, list: [] })
    expect(parsed.data.filterConfig.poolsEnabled).toBeUndefined()
  })
})
