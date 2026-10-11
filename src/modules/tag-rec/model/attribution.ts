import { getVersion, snapshot } from 'valtio/vanilla'
import { tagRecConditionAtoms } from './combination'
import { tagRecClaimsForGroup, tagRecGroupKey } from './relevance'
import { normalizeTagName } from './tag-norm'
import type { TagRecItemExtend, TagRecSourceClaim } from '$define'
import type { TagGroup, TagL1Group, TagTheme } from './types'

/**
 * 归因勋章显示「一级组 › 二级组 › 命中子标签 +N」，同名父子去重。
 * 完整路径和同组其他命中放在详情中；+N 按实际组编号计数，避免同名组少算。
 */

/** 工作副本组 id (与 store/workbench 的 TAG_REC_WORKING_GROUP_ID 同值; 模型层不引 store 图)。 */
const WORKING_GROUP_ID = '__tagrec_working__'

/** 单组归因标签 (调用侧已解析好名字) */
export function formatTagRecAttributionLabel(names: {
  theme?: string
  l1?: string
  group?: string
}): string | undefined {
  const { l1, group } = names
  if (l1 && group && l1 !== group) return `${l1} › ${group}`
  return l1 || group || undefined
}

/** 完整路径只在来源详情中显示；同名父子也保留两个层级。 */
export function tagRecAttributionPathOfGroup(
  g: Pick<TagGroup, 'name' | 'l1Id'>,
  l1ById: ReadonlyMap<string, Pick<TagL1Group, 'name' | 'themeId'>>,
  themeById: ReadonlyMap<string, Pick<TagTheme, 'name'>>,
): string {
  const l1 = g.l1Id ? l1ById.get(g.l1Id) : undefined
  const theme = l1?.themeId ? themeById.get(l1.themeId) : undefined
  return l1 ? `${theme?.name ?? '未归属'} › ${l1.name} › ${g.name}` : g.name
}

/** 由组实体解析标签 (favorites 组 + L1 表 + 主题表注入; 主路径组源条目用) */
export function tagRecAttributionLabelOfGroup(
  g: Pick<TagGroup, 'name' | 'l1Id'>,
  l1ById: ReadonlyMap<string, Pick<TagL1Group, 'name' | 'themeId'>>,
  themeById: ReadonlyMap<string, Pick<TagTheme, 'name'>>,
): string | undefined {
  const l1 = g.l1Id ? l1ById.get(g.l1Id) : undefined
  const theme = l1?.themeId ? themeById.get(l1.themeId) : undefined
  return formatTagRecAttributionLabel({ theme: theme?.name, l1: l1?.name, group: g.name })
}

/**
 * R9: 卡片归属主题名 (「收藏到主题夹」用) —— 组名(剥 ·相关) → favorites 组 → L1 → 主题表;
 * 多认领取首个命中; 未归属/无主题/组不存在 => undefined
 */
export function resolveTagRecThemeNameOfGroups(
  groupNames: readonly string[] | undefined,
  groups: readonly Pick<TagGroup, 'name' | 'l1Id'>[],
  l1ById: ReadonlyMap<string, Pick<TagL1Group, 'name' | 'themeId'>>,
  themeById: ReadonlyMap<string, Pick<TagTheme, 'name'>>,
): string | undefined {
  for (const name of groupNames ?? []) {
    const g = groups.find((x) => x.name === name)
    if (!g) continue
    const l1 = g.l1Id ? l1ById.get(g.l1Id) : undefined
    const theme = l1?.themeId ? themeById.get(l1.themeId) : undefined
    if (theme?.name) return theme.name
  }
  return undefined
}

/** 首条来源 + 其余数量；没有稳定编号的旧条目才按标签去重计数。 */
export function joinTagRecAttributionLabels(
  labels: readonly string[] | undefined,
  sourceCount?: number,
): string | undefined {
  const uniq = [...new Set((labels ?? []).filter(Boolean))]
  if (!uniq.length) return undefined
  const count = Math.max(uniq.length, sourceCount ?? 0)
  return uniq[0] + (count > 1 ? ` +${count - 1}` : '')
}

/**
 * 卡片数据失效钩子: normalize 侧注册实现 (WeakMap 按 item 对象记忆, 归因字段被重写后
 * 同一对象重交付会冻住旧徽标), service 侧交付时调用 —— 注册表放模型层, 避免 service
 * 引入 filter/normalize 的 UI 重依赖图。
 */
let cardDataInvalidator: ((item: TagRecItemExtend) => void) | undefined
export function registerTagRecCardDataInvalidator(fn: (item: TagRecItemExtend) => void) {
  cardDataInvalidator = fn
}
export function invalidateTagRecCardData(item: TagRecItemExtend) {
  cardDataInvalidator?.(item)
}

/** 每页交付时解析来源与子标签；来源和名字索引整页复用，卡片渲染不查表或补请求。 */
export function createTagRecAttributionEnricher(
  groups: readonly Pick<TagGroup, 'id' | 'name' | 'l1Id' | 'tag_ids' | 'combination'>[],
  l1Groups: readonly Pick<TagL1Group, 'id' | 'name' | 'themeId'>[],
  themes?: readonly Pick<TagTheme, 'id' | 'name'>[],
) {
  // 真实收藏表用共享快照，避免遍历时生成整表的跟踪代理；纯数据调用保持直接读取。
  const groupList = getVersion(groups) === undefined ? groups : snapshot(groups)
  const l1List = getVersion(l1Groups) === undefined ? l1Groups : snapshot(l1Groups)
  const themeList = themes && (getVersion(themes) === undefined ? themes : snapshot(themes))
  const groupById = new Map(groupList.map((g) => [g.id, g]))
  const l1ById = new Map(l1List.map((g) => [g.id, g]))
  const themeById = new Map(themeList?.map((t) => [t.id, t]))
  const normalizedMembers = new Map<string, { name: string; norm: string }[]>()

  return (item: TagRecItemExtend) => {
    const claims = item.activeSourceClaims ?? item.source.claims ?? [item.source]
    const sources = [...new Set(claims.flatMap((claim) => (claim.input ? [] : (claim.groupIds ?? []))))].flatMap(
      (id) => {
        const g = groupById.get(id)
        return g && (!item.eligibleGroupKeys || item.eligibleGroupKeys.includes(tagRecGroupKey({ id }))) ? [g] : []
      },
    )
    if (!sources.length) return sources
    const ownNames = new Set(item.ownTagNames?.map(normalizeTagName))
    const children = sources.map((g) => {
      const groupClaims = tagRecClaimsForGroup(item, { id: g.id })
      const recalledIds = new Set(
        groupClaims.filter((claim) => claim.via === 'tag-top').flatMap((claim) => claim.tagIds ?? []),
      )
      let names: string[] = []
      if (recalledIds.size) {
        names = g.tag_ids.filter((e) => recalledIds.has(e.id)).map((e) => e.name)
      }
      // 配方编辑后旧 tag/top 召回 id 可能不再属于本组 tag_ids: 交集为空时回落自身名单,
      // 否则「新试验 › 命中标签」在徽标与详情同时丢失 (recalledIds 非空卡死 ownNames 分支)
      if (!names.length && ownNames.size) {
        let members = normalizedMembers.get(g.id)
        if (!members) {
          members = g.tag_ids.map((e) => ({ name: e.name, norm: normalizeTagName(e.name) }))
          normalizedMembers.set(g.id, members)
        }
        names = members.filter((e) => ownNames.has(e.norm)).map((e) => e.name)
      }
      return [...new Set(names.filter(Boolean))]
    })
    // 展示用召回词重算 (组合组专属): 配方编辑后旧召回词不再解释当前信息流 —— 收敛到仍属配方的
    //   条件值 (tag/up/title/desc/partition); 输入词与经典组认领保持原样。只写展示字段, 证据不动。
    const comboValues = new Map<string, Set<string>>()
    for (const g of sources)
      if (g.combination) {
        const values = new Set<string>()
        for (const atom of tagRecConditionAtoms(g.combination.include)) {
          const value = typeof atom.value === 'string' ? atom.value : atom.value.name
          const norm = value ? normalizeTagName(value) : ''
          if (norm) values.add(norm)
        }
        if (values.size) comboValues.set(g.id, values)
      }
    if (comboValues.size) {
      const liveOf = (claim: Pick<TagRecSourceClaim, 'groupIds' | 'queryKeyword'>) => {
        const ids = (claim.groupIds ?? []).filter((id) => groupById.has(id))
        const groups = ids.map((id) => groupById.get(id)!)
        // 任一认领组为经典组 (无组合) 或无法解析 => 不筛 (经典组语境没有配方编辑残留问题)
        if (!groups.length || groups.some((g) => !g.combination)) return true
        const kw = normalizeTagName(claim.queryKeyword ?? '')
        return !!kw && ids.some((id) => comboValues.get(id)?.has(kw))
      }
      const kept = new Set<string>()
      for (const claim of item.source.claims ?? []) {
        const kw = claim.queryKeyword?.trim()
        if (kw && (claim.input || liveOf(claim))) kept.add(kw)
      }
      const top = item.source.queryKeyword?.trim()
      if (top && liveOf({ groupIds: item.source.groupIds, queryKeyword: top })) kept.add(top)
      item.source.attributionKeywords = [...kept]
    }
    item.source.attributionLabels = sources.map((g, i) => {
      // 工作副本组 (新组合/试改副本) 不是真实收藏组: 徽标只给命中标签, 不带「L1 › 组」前缀;
      //   无命中时才回落组名 (已随试验显示名同步) —— 默认占位名 (新试验) 不再混进徽标
      const working = g.id === WORKING_GROUP_ID
      const base = working ? g.name : tagRecAttributionLabelOfGroup(g, l1ById, themeById)!
      const up = tagRecClaimsForGroup(item, { id: g.id }).find((claim) => claim.via === 'up-search')
      const names = children[i]!
      const label = names.length ? `${names[0]}${names.length > 1 ? ` 等${names.length}个标签` : ''}` : ''
      if (up?.queryKeyword) return working ? `搜索「${up.queryKeyword}」` : `${base} › 搜索「${up.queryKeyword}」`
      return working ? label || base : label ? `${base} › ${label}` : base
    })
    const paths = sources.map((g) =>
      g.id === WORKING_GROUP_ID
        ? g.name
        : themes
          ? tagRecAttributionPathOfGroup(g, l1ById, themeById)
          : tagRecAttributionLabelOfGroup(g, l1ById, themeById)!,
    )
    item.source.attributionPaths = paths.map((path, i) => {
      const base = paths.indexOf(path) !== paths.lastIndexOf(path) ? `${path} (#${sources[i]!.id.slice(0, 6)})` : path
      const up = tagRecClaimsForGroup(item, { id: sources[i]!.id }).find((claim) => claim.via === 'up-search')
      if (up?.queryKeyword) return `${base} › UP 投稿搜索「${up.queryKeyword}」`
      return children[i]!.length ? `${base} › ${children[i]!.join('、')}` : base
    })
    return sources
  }
}
