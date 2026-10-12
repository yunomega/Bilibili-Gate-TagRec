import { cloneDeep } from 'es-toolkit'
import { proxy, subscribe } from 'valtio'
import { appWarn } from '$common'
import { settings } from '$modules/settings'
import { perfMark, perfMarkBytes } from '$utility/perf-mark' // [tag-rec] perf 票 01
import toast from '$utility/toast'
import { proxyMapWithGmStorageLazy, proxySetWithGmStorageLazy, proxyWithGmStorageLazy } from '$utility/valtio' // [tag-rec] perf 票 03: 同步骨架+后台水合变体, 模块图脱 TLA
import { setTagRecSamplingView } from '../api/sampling-view'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  hasTagRecCombination,
  newTagRecCombination,
  removeTagRecCondition,
  seedTagRecCombination,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  validateTagRecCombination,
  type TagRecCombination,
} from '../model/combination'
import {
  blacklistHas,
  canSplitTagId,
  clampWeight,
  computeMergeGroups,
  computeNegativeAdd,
  dedupeTagIdEntries,
  findGroupByTagId,
  findGroupsByNegativeTagId,
  findGroupsByTagIds,
  groupNegativeTagIds,
  intersectCheck,
  makeTagGroup,
  makeTagL1Group,
  makeTagTheme,
  pickNewBlacklistEntries,
  removeTagIdFromGroup,
  setGroupNegativeTagIds,
  summarizeGroupNames,
  type NegativeAddResult,
} from '../model/favorites'
import { compareMergeSources, mergeTagGroups } from '../model/merge-groups'
import {
  pruneSediment,
  sedimentClear,
  sedimentConfirm,
  sedimentMerge,
  sedimentNoteDig,
  trimSedimentPoolEdges,
  type SedimentNode,
} from '../model/sediment'
import { addToSeenSet, clearSeenSet, DEFAULT_SEEN_CAP } from '../model/seen'
import { tagRecViewedGroupIds, type TagRecGroupScope } from '../model/theme-scope-draft'
import {
  TAG_REC_VIEW_UNASSIGNED,
  tagRecViewBucketOf,
  tagRecViewScopeAbsorb,
  tagRecViewScopeEntry,
  tagRecViewScopeLegacyActiveTheme,
  tagRecViewScopeSummary,
  tagRecViewScopeViewedIds,
  type TagRecViewScope,
} from '../model/view-scope'
import { tagRecCombinationBlocksHydrated } from './combination-blocks'
import { reconcileTagRecMergedGroupContext, tagRecSharedSession } from './session'
import type { TagClique } from '../model/tag-norm'
import type { TagBlacklistEntry, TagGroup, TagIdEntry, TagL1Group, TagTheme } from '../model/types'

/**
 * [tag-rec] GM 持久 store (spec §3.x)
 * - favorites: 收藏表二级标签组, `tag-rec:favorites`, proxyWithGmStorage<{list: TagGroup[]}> (§3.1)
 * - favorites-l1: 一级组(容器), `tag-rec:favorites-l1`, proxyWithGmStorage<{list, migrated}> (票 17)
 * - themes: 主题 (L1 归属筛子, 票 26), `tag-rec:themes`, proxyWithGmStorage<{list: TagTheme[]}>
 * - active-theme: tab1 当前主题 id, `tag-rec:active-theme`, proxyWithGmStorage<{id: string|null}> (null=全部)
 * - blacklist: 标签黑名单, `tag-rec:blacklist`, proxyWithGmStorage<{list: TagBlacklistEntry[]}> (§3.2)
 * - sediment: 沉淀池, `tag-rec:sediment`, proxyMapWithGmStorage (含跨 tab 同步, §3.5)
 * - seen: 已看 bvid 集合, `tag-rec:seen`, proxySetWithGmStorage (FIFO 容量, 两 tab 共享, §3.4)
 *
 * 装载 (票 30 并行 => 票 perf-03 脱 TLA): 顶层不再 await —— 7 个持久位先立同步骨架 proxy,
 * GM 读后台水合 (Object.assign/replaceAllWith 回填, valtio 响应式消费方自动接住);
 * 模块图求值不再挂 GM 往返 —— 须读真值的链路 (service 构造期深链消费/语境签名/拉取)
 * 经 `tagRecStoresHydrated` 闸控 (useRefresh 建 tag-rec service 前)。
 */
const favoritesStoreLazy = proxyWithGmStorageLazy({ list: [] as TagGroup[] }, 'tag-rec:favorites')
const favoritesL1StoreLazy = proxyWithGmStorageLazy(
  { list: [] as TagL1Group[], migrated: false },
  'tag-rec:favorites-l1',
)
const themesStoreLazy = proxyWithGmStorageLazy({ list: [] as TagTheme[] }, 'tag-rec:themes')
const activeThemeStoreLazy = proxyWithGmStorageLazy({ id: null as string | null }, 'tag-rec:active-theme')
/**
 * 查看范围 (会话视图筛): {scope: 桶键=>'all'|L1 id 数组}
 * - 缺键 = 'all' (默认全看); 全选 = 空 scope; 主题内细选 = 数组
 * - 刷新后按收藏表启用状态恢复，不读取旧版保存的临时范围。
 */
// 查看范围是会话覆盖。旧版保存的范围不再回填，刷新后跟随收藏表的启用状态。
const viewScopeInitial: { scope: TagRecViewScope; groupScope: TagRecGroupScope } = { scope: {}, groupScope: {} }
const viewScopeStore = proxy(viewScopeInitial)
const blacklistStoreLazy = proxyWithGmStorageLazy({ list: [] as TagBlacklistEntry[] }, 'tag-rec:blacklist')
const sedimentPool = proxyMapWithGmStorageLazy<string, SedimentNode>('tag-rec:sediment')
const seenPool = proxySetWithGmStorageLazy<string>('tag-rec:seen')

// 采样视角 settings → api 层单向同步 (api 不 import settings 防模块环): 启动灌初值 + 变更随订
setTagRecSamplingView(settings.tagRec?.samplingView)
try {
  subscribe(settings.tagRec, () => setTagRecSamplingView(settings.tagRec?.samplingView))
} catch {
  // 测试桩 settings 非 valtio proxy 时无订阅面, 启动值已灌
}

const favoritesStore = favoritesStoreLazy.proxy
const favoritesL1Store = favoritesL1StoreLazy.proxy
const themesStore = themesStoreLazy.proxy
const activeThemeStore = activeThemeStoreLazy.proxy
const blacklistStore = blacklistStoreLazy.proxy

/**
 * [tag-rec] perf 票 03: 7 持久位后台水合完成信号
 * - fail-open: 单笔 GM 读失败记 warn 后照样放行 (该位退回空骨架初值), 不把模块图拖死
 * - 须读真值链路一律 await: tag-rec service 构造 (useRefresh 闸控 —— 构造期消费深链/拍签名)
 * - AUDIT-08: 逐项 settle 结果落 `storeHydrateOk` —— 迁移/收边这类「写型」收尾只允许在对应位
 *   读成功时跑: 读败空骨架的 `migrated=false` 会骗过迁移哨兵, 伪迁移落盘覆盖真 L1 数据不可自愈
 */
const storeHydrationMap = {
  favorites: favoritesStoreLazy,
  favoritesL1: favoritesL1StoreLazy,
  themes: themesStoreLazy,
  activeTheme: activeThemeStoreLazy,
  blacklist: blacklistStoreLazy,
  sediment: sedimentPool,
  seen: seenPool,
  combinationBlocks: { hydrated: tagRecCombinationBlocksHydrated },
} as const
const storeHydrateOk: Partial<Record<keyof typeof storeHydrationMap, boolean>> = {}

export const tagRecStoresHydrated: Promise<void> = Promise.allSettled(
  Object.values(storeHydrationMap).map((s) => s.hydrated),
).then((res) => {
  ;(Object.keys(storeHydrationMap) as (keyof typeof storeHydrationMap)[]).forEach(
    (name, i) => (storeHydrateOk[name] = res[i].status === 'fulfilled'),
  )
  const failed = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed.length)
    appWarn(
      'tag-rec stores hydrate failed:',
      failed.map((r) => r.reason),
    )

  // [tag-rec] perf 票 01: 语义改为「后台水合完成点」(原顶层 await 完成点); 字节数仅 perfprobe 时计
  perfMark('tagrec-stores')
  perfMarkBytes('tagrec-store-bytes', () => ({
    favorites: JSON.stringify(favoritesStore),
    favoritesL1: JSON.stringify(favoritesL1Store),
    themes: JSON.stringify(themesStore),
    blacklist: JSON.stringify(blacklistStore),
    sediment: JSON.stringify(Object.fromEntries(sedimentPool.map)),
    seen: JSON.stringify([...seenPool.set]),
  }))
})

export { activeThemeStore, blacklistStore, favoritesL1Store, favoritesStore, themesStore, viewScopeStore }

// #region 收藏表 (§3.1) —— 不变式在门面层强制执行, 纯逻辑见 model/favorites.ts

export type AddTagIdsResult = {
  added: number // 新入组 id 数
  skipped: number // 本组内已存在而跳过
  moved: number // 同组互斥: 原负向被转正向的 id 数 (票 14)
  alsoIn: string[] // 也存在于这些组名 (跨组重复合法, 纯信息)
}

export const favorites = {
  /** 实时引用 (mergeGroups 会整体换 list, 用 getter 防捕获旧数组) */
  get list() {
    return favoritesStore.list
  },

  findGroupByTagId(tagId: number) {
    return findGroupByTagId(favoritesStore.list, tagId)
  },
  /** 交集查重 (§3.1 不变式2): 任一 id 已入表 => 命中组 (excludeGroupId 排除自身组) */
  intersectCheck(tagIds: readonly number[], excludeGroupId?: string) {
    return intersectCheck(favoritesStore.list, tagIds, excludeGroupId)
  },

  /**
   * 入表建组: 空 ids 拒 (不变式1); 跨组 id 重复合法不拦截 (票 14), 命中仅信息提示
   * 可携负向成员 (negative_tag_ids/negative_strict; 草稿组升级路径用)
   * tag_type 缺省 = opportunistic 待回填 (§3.1)
   * 票 17「无裸奔 L2」: input.l1Id 指认既有一级组 (须存在, 失效回落自动套); 缺省自动套同名新 L1
   * (默认不启用 —— 新收藏的标签不进推荐流, 直到面板主动开); 返回 {group, l1=归属 L1}
   */
  addGroup(input: {
    combination?: TagGroup['combination']
    name?: string
    l1Id?: string
    tag_ids: TagIdEntry[]
    negative_tag_ids?: TagIdEntry[]
    negative_strict?: boolean
    weight?: number
    enabled?: boolean
    note?: string
    overrides?: TagGroup['overrides'] // 组级配置槽 (草稿组升级带名单容器, 实修)
  }): { group: TagGroup; l1: TagL1Group } | undefined {
    const tag_ids = dedupeTagIdEntries(input.tag_ids)
    if (!tag_ids.length && !input.name?.trim()) {
      toast('请填写组名')
      return undefined
    }
    const hits = findGroupsByTagIds(
      favoritesStore.list,
      tag_ids.map((e) => e.id),
    )
    const group = makeTagGroup({ ...input, tag_ids })
    if (!group) return undefined // 防御: 上已过空 ids 检查
    let l1 = input.l1Id ? favoritesL1Store.list.find((x) => x.id === input.l1Id) : undefined
    if (l1) group.l1Id = l1.id
    else l1 = ensureL1ForGroup(group)
    favoritesStore.list.push(group)
    // 票 12: 跨组重复仅提示 —— 枚举全部正向宿主 (≤3 + 等 n 组封顶)
    if (hits.length) toast(`已入表 (提示: 其中标签也存在于组 ${summarizeGroupNames(hits.map((g) => g.name))})`)
    return { group, l1 }
  },

  /**
   * 批量入表 (CSV/JSON 导入): 绕过 addGroup 门面逐行 toast (批量场景会刷屏),
   * 但同守「无裸奔 L2」不变式 —— 组携合法 l1Id 保留归属, 缺省/失效逐组自动套新 L1;
   * 规范化 (空 ids 拒建/正负互斥) 已由 planCsvImport/planTagRecImport 同款执行
   */
  addGroups(groups: readonly TagGroup[]): number {
    for (const g of groups) {
      if (g.l1Id && favoritesL1Store.list.some((l) => l.id === g.l1Id)) continue
      ensureL1ForGroup(g)
    }
    favoritesStore.list.push(...groups)
    return groups.length
  },

  /** 显示字段行内编辑 (name/weight/enabled/note/negative_strict/overrides; 资格类变更由消费侧感知, 见票 05 牌组指纹) */
  updateGroup(
    id: string,
    patch: Partial<Pick<TagGroup, 'name' | 'weight' | 'enabled' | 'note' | 'negative_strict' | 'overrides'>>,
  ): boolean {
    const g = favoritesStore.list.find((x) => x.id === id)
    if (!g) return false
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) {
        toast('组名不能为空')
        return false
      }
      g.name = name
    }
    if (patch.weight !== undefined) g.weight = clampWeight(patch.weight)
    if (patch.enabled !== undefined) {
      g.enabled = patch.enabled && (g.tag_ids.length > 0 || hasTagRecCombination(g.combination))
      tagRecSharedSession.tempEnabledGroupIds = tagRecSharedSession.tempEnabledGroupIds.filter((x) => x !== id)
      if (g.l1Id) {
        const entry = viewScopeStore.groupScope[g.l1Id]
        if (entry)
          viewScopeStore.groupScope[g.l1Id] = g.enabled ? [...new Set([...entry, id])] : entry.filter((x) => x !== id)
        const parent = favoritesL1Store.list.find((l) => l.id === g.l1Id)
        if (g.enabled && parent && (parent.enabled || tagRecSharedSession.tempEnabledL1Ids.includes(parent.id))) {
          const bucket = tagRecViewBucketOf(parent, new Set(themesStore.list.map((t) => t.id)))
          const parents = viewScopeStore.scope[bucket]
          if (Array.isArray(parents)) viewScopeStore.scope[bucket] = [...new Set([...parents, parent.id])]
        }
      }
    }
    if (patch.note !== undefined) g.note = patch.note
    if (patch.negative_strict !== undefined) g.negative_strict = patch.negative_strict
    if (patch.overrides !== undefined) g.overrides = patch.overrides // 整槽替换 (GroupConfigModal 差分产物)
    return true
  },

  removeGroup(id: string) {
    const idx = favoritesStore.list.findIndex((x) => x.id === id)
    if (idx === -1) return false
    favoritesStore.list.splice(idx, 1)
    tagRecSharedSession.tempEnabledGroupIds = tagRecSharedSession.tempEnabledGroupIds.filter((x) => x !== id)
    return true
  },

  /** 批量删除 (票 44 吸顶条「删除」): 一遍 filter 等价逐 id removeGroup; 失效 id 静默跳过; 不 toast 调用侧汇总 */
  removeGroups(ids: readonly string[]): number {
    const set = new Set(ids)
    const before = favoritesStore.list.length
    favoritesStore.list = favoritesStore.list.filter((g) => !set.has(g.id))
    tagRecSharedSession.tempEnabledGroupIds = tagRecSharedSession.tempEnabledGroupIds.filter((x) => !set.has(x))
    return before - favoritesStore.list.length
  },

  /** 「清空收藏表」(票 44 危险区): L2 全清, 返回删除数; 一级组容器/主题/黑名单/沉淀/已看均不动 */
  clearAll(): number {
    const n = favoritesStore.list.length
    favoritesStore.list = []
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledGroupIds = []
    return n
  },

  /**
   * 并入指定目标组：先计算整批成员和统一配置，再应用到目标并删除源组。
   *   target 自身在源列表内 => 跳过 (并入自己=其他源并入它); 返回并入的源组数 (undefined=目标失效)
   */
  mergeGroupsInto(sourceIds: readonly string[], targetId: string): number | undefined {
    const target = favoritesStore.list.find((g) => g.id === targetId)
    if (!target) {
      toast('目标标签组不存在')
      return undefined
    }
    const ids = new Set(sourceIds)
    const sources = favoritesStore.list.filter((g) => g.id !== targetId && ids.has(g.id))
    if (!sources.length) return 0
    if ([target, ...sources].some((g) => g.combination)) {
      toast('完整组合请在标签发掘中选取条件，再存为二级组')
      return undefined
    }
    const merged = mergeTagGroups(target, sources)
    Object.assign(target, merged)
    favoritesStore.list = favoritesStore.list.filter((g) => g.id === targetId || !ids.has(g.id))
    reconcileTagRecMergedGroupContext(
      sources.map((g) => g.id),
      targetId,
    )
    return sources.length
  },

  /** 新组以最早源组为基准，与并入既有组共用规则。 */
  mergeGroupsToNew(sourceIds: readonly string[], name: string): TagGroup | undefined {
    const sources = favoritesStore.list.filter((g) => sourceIds.includes(g.id)).sort(compareMergeSources)
    const base = sources[0]
    if (!base || !name.trim()) return undefined
    if (sources.some((g) => g.combination)) {
      toast('完整组合请在标签发掘中选取条件，再存为二级组')
      return undefined
    }
    const merged = mergeTagGroups(base, sources.slice(1))
    const created = favorites.addGroup({
      name,
      l1Id: merged.l1Id,
      tag_ids: merged.tag_ids,
      negative_tag_ids: merged.negative_tag_ids,
      negative_strict: merged.negative_strict,
      overrides: merged.overrides,
      enabled: merged.enabled,
      weight: merged.weight,
      note: merged.note,
    })?.group
    if (!created) return undefined
    favorites.removeGroups(sources.map((g) => g.id))
    reconcileTagRecMergedGroupContext(
      sources.map((g) => g.id),
      created.id,
    )
    return created
  },

  /** 合并成组 (组手术只在面板): 并入最早 addedAt 组, id 并集去重, 其余组删除 */
  mergeGroups(ids: readonly string[]): boolean {
    const selected = favoritesStore.list.filter((g) => ids.includes(g.id))
    const res = computeMergeGroups(selected)
    if (!res) {
      toast('至少勾选 2 组')
      return false
    }
    const keep = favoritesStore.list.find((g) => g.id === res.keepId)!
    if (favorites.mergeGroupsInto(res.absorbedIds, keep.id) === undefined) return false
    toast(`已合并 ${selected.length} 组为「${keep.name}」(${keep.tag_ids.length} 个 tag_id)`)
    return true
  },

  /**
   * 向既有组加 id (面板「添加变体」勾选落地 / 票 20 弹层四档入组):
   * 本组已有 => 跳过; 跨组重复合法照常加入, 命中组名进 alsoIn 信息上报 (票 14);
   * 同组正负互斥: 撞负向的自动移出负向转正向 (moved);
   * opts.silent: 抑制门面自带 toast, 调用侧按返回结果自报 (弹层「已并入组「A」,共 N 个标签」)
   */
  addTagIdsToGroup(groupId: string, entries: readonly TagIdEntry[], opts?: { silent?: boolean }): AddTagIdsResult {
    const res: AddTagIdsResult = { added: 0, skipped: 0, moved: 0, alsoIn: [] }
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return res
    const inGroup = new Set(g.tag_ids.map((e) => e.id))
    const alsoIn = new Set<string>()
    for (const e of dedupeTagIdEntries(entries)) {
      if (g.combination) {
        if (inGroup.has(e.id)) {
          res.skipped++
          continue
        }
        const copy = cloneDeep(g)
        const negative = groupNegativeTagIds(copy)
        const moved = negative.some((n) => n.id === e.id)
        if (moved)
          setGroupNegativeTagIds(
            copy,
            negative.filter((n) => n.id !== e.id),
          )
        if (
          !addTagRecCondition(copy.combination!, tagRecConditionAtom('tag', e)) ||
          !validateTagRecCombination(copy.combination)
        ) {
          res.skipped++
          if (!opts?.silent) toast('组合条件已达上限，请先简化')
          continue
        }
        Object.assign(g, copy, { tag_ids: tagRecCombinationTagIds(copy.combination) })
        inGroup.add(e.id)
        res.added++
        if (moved) res.moved++
        const hit = findGroupByTagId(
          favoritesStore.list.filter((other) => other.id !== g.id),
          e.id,
        )
        if (hit) alsoIn.add(hit.name)
        continue
      }
      const negative = groupNegativeTagIds(g)
      if (negative.some((n) => n.id === e.id)) {
        setGroupNegativeTagIds(
          g,
          negative.filter((n) => n.id !== e.id),
        )
        res.moved++
      }
      if (inGroup.has(e.id)) {
        res.skipped++
        continue
      }
      const hit = findGroupByTagId(favoritesStore.list, e.id)
      if (hit) alsoIn.add(hit.name)
      g.tag_ids.push({ ...e })
      inGroup.add(e.id)
      res.added++
    }
    res.alsoIn = [...alsoIn]
    if (!opts?.silent) {
      // 一次并入的多类结果合并一条 toast (票 UX-01: 不再同屏叠三条)
      const parts: string[] = []
      if (res.added) parts.push(`已加入 ${res.added} 个标签到「${g.name}」`)
      if (res.moved) parts.push(`${res.moved} 个从负向移出转为正向`)
      if (!res.added && !res.moved && res.skipped) parts.push('所选标签均已在组内')
      if (res.alsoIn.length) parts.push(`提示: 其中标签也存在于组 ${summarizeGroupNames(res.alsoIn)}`)
      if (parts.length) toast(parts.join(' · '), parts.length > 1 ? 3500 : undefined)
    }
    return res
  },

  /**
   * 加负向成员 (票 14; computeNegativeAdd 守互斥):
   * 撞正向 => 自动移出正向转负向 (唯一正向拒移 => refusedSole); 已是负向 => skipped
   */
  addNegativeToGroup(groupId: string, entries: readonly TagIdEntry[]): NegativeAddResult {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    const empty: NegativeAddResult = { added: 0, moved: 0, skipped: 0, refusedSole: [] }
    if (!g) return empty
    if (g.combination) {
      const combo = cloneDeep(g.combination)
      for (const entry of dedupeTagIdEntries(entries)) {
        const matches = tagRecConditionAtoms(combo.include).filter((a) => a.field === 'tag' && a.value.id === entry.id)
        matches.forEach((a) => removeTagRecCondition(combo, a.id))
        if (excludeTagRecCondition(combo, tagRecConditionAtom('tag', entry))) empty.added++
        else empty.skipped++
        if (matches.length) empty.moved++
      }
      if (!validateTagRecCombination(combo)) {
        toast('组合条件已达上限，请先简化')
        return { added: 0, moved: 0, skipped: entries.length, refusedSole: [] }
      }
      g.combination = combo
      g.tag_ids = tagRecCombinationTagIds(g.combination)
      return empty
    }
    const res = computeNegativeAdd(g, entries)
    g.tag_ids = res.tag_ids
    setGroupNegativeTagIds(g, res.negative_tag_ids)
    return { added: res.added, moved: res.moved, skipped: res.skipped, refusedSole: res.refusedSole }
  },

  removeNegativeFromGroup(groupId: string, tagId: number): boolean {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return false
    if (g.combination) {
      const negative = groupNegativeTagIds(g)
      const next = negative.filter((entry) => entry.id !== tagId)
      if (next.length === negative.length) return false
      setGroupNegativeTagIds(g, next)
      return true
    }
    const negative = groupNegativeTagIds(g)
    const next = negative.filter((e) => e.id !== tagId)
    if (next.length === negative.length) return false
    setGroupNegativeTagIds(g, next)
    return true
  },

  /** id → 含其为负向成员的全部组 (弹层「负向@组名」素材) */
  negativeGroupsOfTag(tagId: number): TagGroup[] {
    return findGroupsByNegativeTagId(favoritesStore.list, tagId)
  },

  /**
   * 「组现状面板」直写条件树 (wayfinding 004): clone → mutate → validate → 落盘并重导 tag_ids 投影;
   *   与 addNegativeToGroup 同款的收藏侧直写通道。校验失败整批丢弃并 toast, 不落半成品。
   *   无组合的组首次走此通道时先把既有 tag_ids 播种成 tag 行原子 ——
   *   否则新建空组合的投影重导会把扁平成员冲掉 (扁平名单 ≡ any-tag 行)。
   */
  editGroupCombination(groupId: string, mutate: (combo: TagRecCombination) => void): boolean {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return false
    const combo = g.combination ? cloneDeep(g.combination) : newTagRecCombination()
    // 播种 all-or-nothing: 预算不足仍落盘的话, 投影重导会把未播种的成员静默抹掉 (审计: 静默数据丢失)
    if (!g.combination && !seedTagRecCombination(combo, g.tag_ids)) {
      toast('该组标签数超过组合节点上限，无法转为组合条件，未保存')
      return false
    }
    mutate(combo)
    if (!validateTagRecCombination(combo)) {
      toast('组合条件已达上限或形状不合法，未保存')
      return false
    }
    g.combination = combo
    g.tag_ids = tagRecCombinationTagIds(combo)
    return true
  },

  /** 移出最后一个标签保留空组，关闭保存开关及临时入抽资格。 */
  removeTagIdFromGroup(groupId: string, tagId: number): boolean {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return false
    const res = removeTagIdFromGroup(g, tagId)
    if (!res.ok) {
      toast('标签不在组内')
      return false
    }
    if (g.combination) {
      tagRecConditionAtoms(g.combination.include)
        .filter((a) => a.field === 'tag' && a.value.id === tagId)
        .forEach((a) => removeTagRecCondition(g.combination!, a.id))
      g.tag_ids = tagRecCombinationTagIds(g.combination)
    } else g.tag_ids = res.tag_ids.map((e) => ({ ...e }))
    if (!g.tag_ids.length && !hasTagRecCombination(g.combination)) this.updateGroup(groupId, { enabled: false })
    return true
  },

  /** 「拆为新项」: id 移出源组并建同名新组 (源组须 ≥2 id; 新组过 addGroup 不变式) */
  splitTagToNewGroup(groupId: string, tagId: number): TagGroup | undefined {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return undefined
    if (g.combination) {
      toast('完整组合请在标签发掘中用分支试验拆选，原组会保留')
      return undefined
    }
    if (!canSplitTagId(g)) {
      toast('单标签组无需拆分')
      return undefined
    }
    const entry = g.tag_ids.find((e) => e.id === tagId)
    if (!entry) return undefined
    g.tag_ids = g.tag_ids.filter((e) => e.id !== tagId).map((e) => ({ ...e }))
    return favorites.addGroup({ name: entry.name, tag_ids: [{ ...entry }] })?.group
  },

  /**
   * tag_type opportunistic 回填 (§3.1): view/detail/tag 免费给的枚举值,
   * 表内已存在条目缺 tag_type 时顺手补上; 返回回填条数
   */
  backfillTagTypes(items: readonly { id: number; tag_type?: TagIdEntry['tag_type'] }[]): number {
    let n = 0
    for (const { id, tag_type } of items) {
      if (!tag_type) continue
      const g = findGroupByTagId(favoritesStore.list, id)
      const e = g?.tag_ids.find((x) => x.id === id)
      if (e && !e.tag_type) {
        e.tag_type = tag_type
        n++
      }
    }
    return n
  },
}
// #endregion

// #region 一级组 (票 17: L1/L2 层级) —— L1 = tab1 唯一抽签单位; 麾下 L2 非空才可入外层堆; 负向只在 L2

/** 无裸奔 L2 收口 (票 17): 组缺归属 => 自动套同名新 L1 (默认不启用, weight 继承组 weight); 返回所套 L1 */
function ensureL1ForGroup(group: TagGroup): TagL1Group {
  const l1 = makeTagL1Group({ name: group.name, weight: group.weight })! // 组名恒非空 (makeTagGroup 回落首 id 名) => 恒建
  favoritesL1Store.list.push(l1)
  group.l1Id = l1.id
  return l1
}

/**
 * 一次性迁移 (票 17): favorites.list 内无合法 l1Id 的旧组各套一个自动 L1
 * (同名/默认不启用/weight 继承旧组 weight —— 启用即恢复原曝光);
 * migrated flag 持久在 favorites-l1 store 内防重跑 —— 幂等, 重复调用 no-op
 */
export function migrateFavoritesToL1() {
  if (favoritesL1Store.migrated) return
  favoritesL1Store.migrated = true // 先置 flag: 本迁产生的 L1 写入也属迁移内容
  for (const g of favoritesStore.list) {
    if (g.l1Id && favoritesL1Store.list.some((l) => l.id === g.l1Id)) continue
    ensureL1ForGroup(g)
  }
}

export const favoritesL1 = {
  get list() {
    return favoritesL1Store.list
  },

  /** 面板新建 L1: 默认不启用 (麾下整棵入堆资格需显式开, spec); 空名拒建 */
  addL1(input: { name?: string; enabled?: boolean; weight?: number; note?: string }): TagL1Group | undefined {
    const l1 = makeTagL1Group(input)
    if (!l1) {
      toast('一级组名不能为空')
      return undefined
    }
    favoritesL1Store.list.push(l1)
    return l1
  },

  /**
   * 批量入 L1 表 (JSON 导入): 规范化/id 撞车复用已由 planTagRecImport 完成;
   * 须在 favorites.addGroups 之前落表 —— 组携 l1Id 的归属校验要能看到新 L1, 否则被 auto-wrap 截胡
   */
  addL1s(items: readonly TagL1Group[]): number {
    favoritesL1Store.list.push(...items.map((l) => ({ ...l })))
    return items.length
  },

  /** 显示字段行内编辑 (name/weight/enabled/note/overrides; 资格类变更由外层牌堆指纹感知) */
  updateL1(
    id: string,
    patch: Partial<Pick<TagL1Group, 'name' | 'weight' | 'enabled' | 'note' | 'overrides'>>,
  ): boolean {
    const l1 = favoritesL1Store.list.find((x) => x.id === id)
    if (!l1) return false
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) {
        toast('一级组名不能为空')
        return false
      }
      l1.name = name
    }
    if (patch.weight !== undefined) l1.weight = clampWeight(patch.weight)
    if (patch.enabled !== undefined) {
      l1.enabled = patch.enabled
      // 收藏表显式开关优先于这个一级组此前的临时覆盖。
      tagRecSharedSession.tempEnabledL1Ids = tagRecSharedSession.tempEnabledL1Ids.filter((x) => x !== id)
      delete viewScopeStore.groupScope[id]
      const children = new Set(favoritesStore.list.filter((g) => g.l1Id === id).map((g) => g.id))
      tagRecSharedSession.tempEnabledGroupIds = tagRecSharedSession.tempEnabledGroupIds.filter((x) => !children.has(x))
      const bucket = tagRecViewBucketOf(l1, new Set(themesStore.list.map((t) => t.id)))
      const entry = viewScopeStore.scope[bucket]
      if (Array.isArray(entry)) {
        viewScopeStore.scope[bucket] = patch.enabled ? [...new Set([...entry, id])] : entry.filter((x) => x !== id)
      }
    }
    if (patch.note !== undefined) l1.note = patch.note
    if (patch.overrides !== undefined) l1.overrides = patch.overrides // 整槽替换 (GroupConfigModal 差分产物)
    return true
  },

  /** 非空阻塞 (spec: 不做级联删除防误伤): 麾下还有 L2 时拒删并提示; 空 L1 可删 */
  removeL1(id: string): boolean {
    const idx = favoritesL1Store.list.findIndex((x) => x.id === id)
    if (idx === -1) return false
    const l1 = favoritesL1Store.list[idx]
    const children = favoritesStore.list.filter((g) => g.l1Id === id).length
    if (children) {
      toast(`一级组「${l1.name}」下还有 ${children} 个标签组, 请先移走或删除`)
      return false
    }
    favoritesL1Store.list.splice(idx, 1)
    return true
  },

  /**
   * 级联删除 (票 44 用户裁, 覆盖非空阻塞原裁): 麾下 L2 一并删 —— 「L1 勾选/删除 = 整棵子树」语义;
   *   调用侧 confirm 明示麾下计数。批量吸顶条与行内删除共用此口 (删 L1 = 删子树, 一处语义)
   */
  removeL1Tree(id: string): boolean {
    const idx = favoritesL1Store.list.findIndex((x) => x.id === id)
    if (idx === -1) return false
    favorites.removeGroups(favoritesStore.list.filter((g) => g.l1Id === id).map((g) => g.id))
    delete viewScopeStore.groupScope[id]
    tagRecSharedSession.tempEnabledL1Ids = tagRecSharedSession.tempEnabledL1Ids.filter((x) => x !== id)
    favoritesL1Store.list.splice(idx, 1)
    return true
  },

  /**
   * 「清空收藏表」配套 (票 44 危险区): 一级组全清, 返回删除数 —— 绕过 removeL1 非空阻塞
   *   (调用侧语义本就是全表清空, 先清 L2 再清 L1 壳); 主题名册不动 (主题是无 L1 依附的独立实体)
   */
  clearAll(): number {
    const n = favoritesL1Store.list.length
    favoritesL1Store.list = []
    return n
  },

  /**
   * 指认 L2 所属一级组 (面板「所属一级组」下拉): l1Id 须存在, 否则拒;
   * undefined => 自动套同名新 L1 (同 addGroup 缺省路径); 返回最终归属的 L1
   */
  assignGroupToL1(groupId: string, l1Id?: string): TagL1Group | undefined {
    const g = favoritesStore.list.find((x) => x.id === groupId)
    if (!g) return undefined
    if (l1Id === undefined) return ensureL1ForGroup(g)
    const l1 = favoritesL1Store.list.find((x) => x.id === l1Id)
    if (!l1) {
      toast('目标一级组不存在')
      return undefined
    }
    g.l1Id = l1.id
    return l1
  },

  /**
   * 批量改挂 (票 31 吸顶条「移到一级组…」): 逐组 assignGroupToL1 同款语义的薄封装;
   * l1Id 缺省 => 首组 auto-wrap 套同名新 L1、余组同挂 (与行内「新建一级组…」入口同款);
   * 改挂后清空的源一级组 = 空壳 => 删除并把名字汇总进返回值 (删空壳非数据, 调用侧 toast 不二次确认);
   * 返回 {l1 最终归属, moved, removedShells 删壳名清单} | undefined (无有效组 / 目标失效)
   */
  moveGroupsToL1(
    groupIds: readonly string[],
    l1Id?: string,
  ): { l1: TagL1Group; moved: number; removedShells: string[] } | undefined {
    const groups = favoritesStore.list.filter((g) => groupIds.includes(g.id))
    if (!groups.length) return undefined
    // 先记源: 改挂后逐源查空壳
    const sourceIds = new Set(groups.map((g) => g.l1Id).filter((x): x is string => !!x))
    let l1: TagL1Group | undefined
    if (l1Id === undefined) {
      l1 = favoritesL1.assignGroupToL1(groups[0].id) // 首组 auto-wrap 得新 L1
      if (!l1) return undefined
      for (const g of groups.slice(1)) favoritesL1.assignGroupToL1(g.id, l1.id)
    } else {
      l1 = favoritesL1Store.list.find((x) => x.id === l1Id)
      if (!l1) {
        toast('目标一级组不存在')
        return undefined
      }
      for (const g of groups) favoritesL1.assignGroupToL1(g.id, l1.id)
    }
    const removedShells: string[] = []
    for (const sid of sourceIds) {
      if (sid === l1.id) continue // 源即目标不可能是空壳
      const shell = favoritesL1Store.list.find((x) => x.id === sid)
      if (shell && !favoritesStore.list.some((g) => g.l1Id === sid)) {
        removedShells.push(shell.name)
        favoritesL1.removeL1(sid) // 空壳必过非空阻塞
      }
    }
    return { l1, moved: groups.length, removedShells }
  },

  /**
   * 一级组并入 (票 29 面板 L1 行内「并入…」): 源麾下全部 L2 逐组改指目标 => 删空壳源;
   * 单次动作替代「勾选+滚回顶部」合并链路; sourceId===targetId / 任一端失效 => 拒;
   * 返回并入 L2 数 (undefined=拒; 0=源本就空, 等同删壳)
   */
  mergeL1IntoL1(sourceId: string, targetId: string): number | undefined {
    if (sourceId === targetId) return undefined
    const source = favoritesL1Store.list.find((x) => x.id === sourceId)
    const target = favoritesL1Store.list.find((x) => x.id === targetId)
    if (!source || !target) {
      toast('一级组不存在')
      return undefined
    }
    const sourceName = source.name
    const targetName = target.name
    const children = favoritesStore.list.filter((g) => g.l1Id === sourceId)
    for (const g of children) favoritesL1.assignGroupToL1(g.id, targetId)
    favoritesL1.removeL1(sourceId) // 麾下已空 => 非空阻塞必过
    toast(`已将一级组「${sourceName}」麾下 ${children.length} 个标签组并入「${targetName}」, 源一级组已删`)
    return children.length
  },
}

// store 水合完成后首个空闲拍执行一次性迁移 —— 须排在 (a) GM 回填后 (空骨架上跑会把 migrated
// 哨兵提前置位, 真数据落地时迁移已过) 与 (b) proxyWithGmStorage* 的 setTimeout subscribe
// 挂载后 (迁移产生的变更才会随订阅落盘); 旧版靠「顶层 await => setTimeout」天然达成,
// 脱 TLA 后显式挂在水合完成信号上 (票 perf-03)
// AUDIT-08: fail-open 下相关位读败时不得跑 —— favorites-l1 空骨架的 migrated=false 会骗过
// 哨兵, 给每组套伪 L1 再落盘覆盖真数据 (不可自愈); favorites 读败同跳过 (组表不全时迁移
// 会把 migrated 置位而漏包); 跳过则下轮会话真值水合后自愈重试。trim 幂等可容忍, 同型收口
void tagRecStoresHydrated.then(() =>
  setTimeout(() => {
    if (storeHydrateOk.favorites && storeHydrateOk.favoritesL1) migrateFavoritesToL1()
    // [tag-rec] 票 perf-11: 存量 sediment 大池一次性收边 (生产环境已见 8.1MB 级池) ——
    // 收敛式幂等无需哨兵; subscribe 已挂载 => 裁剪增量落盘, GM 存根与后续回放载荷同步瘦身
    if (storeHydrateOk.sediment) trimSedimentPoolEdges(sedimentPool.map)
  }),
)
// #endregion

// #region 主题 (票 26: L1 归属标签 —— 过滤筛子不是容器; tab1「主题」下拉一键切换工作集)
/**
 * 当前主题持久位 (独立 key): null = 「全部」档无筛 (现状)
 * 落盘用 null 而非 undefined —— null 哨兵在存储层显式往返 (键始终在、回读可判);
 *   undefined 依赖序列化丢键语义, 回读落骨架缺省值, 链路隐晦不可靠
 */

export const themes = {
  get list() {
    return themesStore.list
  },

  /** 批量入主题表 (JSON 导入): 撞车复用/悬挂合成已由 planTagRecImport 完成, 与 favoritesL1.addL1s 同款静默批写 */
  addThemes(items: readonly TagTheme[]): number {
    themesStore.list.push(...items.map((t) => ({ ...t })))
    return items.length
  },

  /** 面板「新建主题」: 纯筛子实体 (无 weight/enabled/tag); 空名拒建 */
  addTheme(input: { name?: string }): TagTheme | undefined {
    const t = makeTagTheme(input)
    if (!t) {
      toast('主题名不能为空')
      return undefined
    }
    themesStore.list.push(t)
    return t
  },

  /** 改名 (预留管理入口): 空名拒改 */
  updateTheme(id: string, patch: Partial<Pick<TagTheme, 'name'>>): boolean {
    const t = themesStore.list.find((x) => x.id === id)
    if (!t) return false
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) {
        toast('主题名不能为空')
        return false
      }
      t.name = name
    }
    return true
  },

  /**
   * 删主题: 麾下 L1 的 themeId 清回 undefined (落回「未归属」桶); 零迁移对偶操作
   * R7: 该主题的查看范围桶按并集并入「未归属」桶 (麾下 L1 的视图尽量保续)
   */
  removeTheme(id: string): boolean {
    const idx = themesStore.list.findIndex((x) => x.id === id)
    if (idx === -1) return false
    const t = themesStore.list[idx]
    themesStore.list.splice(idx, 1)
    for (const l1 of favoritesL1Store.list) {
      if (l1.themeId === id) delete l1.themeId
    }
    tagRecViewScopeAbsorb(viewScopeStore.scope, id, TAG_REC_VIEW_UNASSIGNED)
    toast(`已删除主题「${t.name}」, 其麾下的一级组回落「全部」档`)
    return true
  },

  /**
   * 批量删主题 (名册勾选「删除」): 一遍 filter 等价逐 id removeTheme 的存储面 ——
   *   麾下 L1 themeId 清回落「未归属」; 查看范围桶逐个并入「未归属」; 失效 id 静默跳过;
   *   不逐条 toast, 调用侧汇总。返回删除数
   */
  removeThemes(ids: readonly string[]): number {
    const dead = new Set(ids)
    const before = themesStore.list.length
    for (const l1 of favoritesL1Store.list) {
      if (l1.themeId && dead.has(l1.themeId)) delete l1.themeId
    }
    themesStore.list = themesStore.list.filter((t) => !dead.has(t.id))
    for (const id of dead) tagRecViewScopeAbsorb(viewScopeStore.scope, id, TAG_REC_VIEW_UNASSIGNED)
    return before - themesStore.list.length
  },

  /** 「清空收藏表」配套 (危险区): 名册全清 + 麾下 L1 themeId 清回 + 查看范围复位全看, 返回删除数 */
  clearAll(): number {
    const n = themesStore.list.length
    themesStore.list = []
    for (const l1 of favoritesL1Store.list) {
      if (l1.themeId !== undefined) delete l1.themeId
    }
    viewScope.selectAll()
    return n
  },

  /**
   * 并入主题 (feat: 主题复选并入 —— 清 0-L1 空壳主路径): 源主题麾下 L1 的 themeId 全改挂 target,
   *   源主题删; target 自身在源列表内 => 跳过 (并入自己=其余并入它); 目标失效 => undefined;
   *   R7: 源主题查看范围桶按并集并入 target 桶 (并入后看的是同一撮, 视图保续)
   */
  mergeThemesInto(sourceIds: readonly string[], targetId: string): number | undefined {
    const target = themesStore.list.find((t) => t.id === targetId)
    if (!target) {
      toast('目标主题不存在')
      return undefined
    }
    const srcSet = new Set(sourceIds.filter((id) => id !== targetId))
    if (!srcSet.size) return 0
    for (const l1 of favoritesL1Store.list) {
      if (l1.themeId && srcSet.has(l1.themeId)) l1.themeId = targetId
    }
    themesStore.list = themesStore.list.filter((t) => !srcSet.has(t.id))
    for (const id of srcSet) tagRecViewScopeAbsorb(viewScopeStore.scope, id, targetId)
    return srcSet.size
  },

  /**
   * 指认 L1 所属主题 (面板 L1 行「所属主题」下拉, 与 assignGroupToL1 同款单父语义):
   * themeId 须存在否则拒; undefined => 清回未归属 (落「全部」档)
   */
  assignL1ToTheme(l1Id: string, themeId?: string): boolean {
    const l1 = favoritesL1Store.list.find((x) => x.id === l1Id)
    if (!l1) return false
    if (themeId === undefined) {
      delete l1.themeId
      return true
    }
    const t = themesStore.list.find((x) => x.id === themeId)
    if (!t) {
      toast('目标主题不存在')
      return false
    }
    l1.themeId = t.id
    return true
  },

  /**
   * 查看范围切换 (tabbar 深链/旧入口): 只写查看范围 —— 零写入裁决, 不动任何 L1 enabled;
   * undefined => 全看 (清空记录); id => 只看该主题 (其余桶清空); 失效 id 拒
   */
  setActive(themeId?: string): boolean {
    if (themeId !== undefined && !themesStore.list.some((t) => t.id === themeId)) {
      toast('目标主题不存在')
      return false
    }
    if (themeId === undefined) viewScope.selectAll()
    else viewScope.onlyThemes([themeId])
    return true
  },
}
// #endregion

// #region 查看范围 (R7: 零写入视图筛 —— 主题下拉双列复选树/横幅「只看这个包的主题」的读写口)
/**
 * 查看范围门面: 记录形 {桶 => 'all'|L1 id 数组}, 缺键 = 全看 (model/view-scope 纯逻辑)
 * - 写口只改会话范围与临时开启; 绝不碰 favoritesL1.enabled
 * - 桶 = 主题 id | 未归属哨兵 (无主题/悬挂已删主题的 L1)
 */
export const viewScope = {
  get scope(): TagRecViewScope {
    return viewScopeStore.scope
  },

  /** 桶列表 (主题 + 未归属; 含麾下 L1 计数) —— 下拉左列/摘要/展开共用 */
  buckets(): { id: string; name: string; l1Count: number }[] {
    const l1s = favoritesL1Store.list
    const out = themesStore.list.map((t) => ({
      id: t.id,
      name: t.name,
      l1Count: l1s.filter((l) => l.themeId === t.id).length,
    }))
    out.push({
      id: TAG_REC_VIEW_UNASSIGNED,
      name: '未归属',
      l1Count: l1s.filter((l) => !l.themeId || !themesStore.list.some((t) => t.id === l.themeId)).length,
    })
    return out
  },

  /** 桶当前形 ('all' | string[]; 缺键 => 'all') */
  entryOf(bucket: string): 'all' | string[] {
    return tagRecViewScopeEntry(viewScopeStore.scope, bucket)
  },

  /** L1 是否在查看范围 */
  isViewed(l1: Pick<TagL1Group, 'id' | 'themeId'>): boolean {
    const themeIds = new Set(themesStore.list.map((t) => t.id))
    return tagRecViewScopeViewedIds(viewScopeStore.scope, [l1], themeIds).has(l1.id)
  },

  /** 展开 L1 id 集 (deck 判定/指纹/计数共用) */
  viewedL1Ids(): Set<string> {
    const themeIds = new Set(themesStore.list.map((t) => t.id))
    return tagRecViewScopeViewedIds(viewScopeStore.scope, favoritesL1Store.list, themeIds)
  },

  viewedGroupIds(): Set<string> | undefined {
    return tagRecViewedGroupIds(favoritesStore.list, viewScopeStore.groupScope)
  },

  /** 设桶 (undefined/'all' = 删键回缺省全看; [] = 整桶取消; 数组 = 主题内细选) */
  setBucket(bucket: string, value: 'all' | string[] | undefined): void {
    if (value === undefined || value === 'all') delete viewScopeStore.scope[bucket]
    else viewScopeStore.scope[bucket] = value
  },

  /** 全选 (清空记录 = 缺省全看) */
  selectAll(): void {
    viewScopeStore.scope = {}
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledGroupIds = []
  },

  /** 收藏表「用此筛选看推荐」: 替换本次范围并临时开启所选主题的停用一级组; 未勾选则恢复长期启用集。 */
  previewThemes(themeIds: ReadonlySet<string>): void {
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledGroupIds = []
    if (!themeIds.size) {
      this.selectAll()
      tagRecSharedSession.tempEnabledL1Ids = []
      return
    }
    const scope: TagRecViewScope = {}
    for (const b of this.buckets()) scope[b.id] = themeIds.has(b.id) ? 'all' : []
    const existingThemes = new Set(themesStore.list.map((t) => t.id))
    const temporary = favoritesL1Store.list
      .filter((l) => !l.enabled && themeIds.has(tagRecViewBucketOf(l, existingThemes)))
      .map((l) => l.id)
    viewScopeStore.scope = scope
    tagRecSharedSession.tempEnabledL1Ids = temporary
  },

  /** 只看这些主题 (其余桶与未归属清空) —— 横幅「只看这个包的主题」/ setActive 单主题 */
  onlyThemes(themeIds: readonly string[]): void {
    viewScopeStore.groupScope = {}
    tagRecSharedSession.tempEnabledGroupIds = []
    const wanted = new Set(themeIds)
    const scope: TagRecViewScope = {}
    for (const b of this.buckets()) {
      scope[b.id] = b.id !== TAG_REC_VIEW_UNASSIGNED && wanted.has(b.id) ? 'all' : []
    }
    viewScopeStore.scope = scope
  },

  /** 摘要文案 (tabbar 触发器): 「主题：全选」/「主题：A、B(部分)…」 */
  summaryText(): string {
    return tagRecViewScopeSummary(viewScopeStore.scope, this.buckets())
  },

  /** 导出用 legacy activeThemeId (恰好只看单主题 => 该 id; 否则 null; 旧解析端兼容读) */
  legacyActiveThemeId(): string | null {
    return tagRecViewScopeLegacyActiveTheme(
      viewScopeStore.scope,
      themesStore.list.map((t) => t.id),
    )
  },
}

// #endregion

// #region 标签黑名单 (§3.2) —— 按 tag_id 存, 仅作用于本脚本两 tab
export const blacklist = {
  get list() {
    return blacklistStore.list
  },

  has(id: number) {
    return blacklistHas(blacklistStore.list, id)
  },

  /** 入黑名单 (候选清单勾选语义): 按 id 去重, 已在表跳过; 返回新增数 */
  add(entries: readonly TagIdEntry[]): number {
    const adding = pickNewBlacklistEntries(blacklistStore.list, entries)
    if (!adding.length) {
      toast('所选标签均已在黑名单')
      return 0
    }
    blacklistStore.list.push(...adding)
    toast(`已拉黑 ${adding.length} 个标签 (仅作用于「主题推荐/标签发掘」两 tab)`)
    return adding.length
  },

  remove(id: number) {
    const idx = blacklistStore.list.findIndex((e) => e.id === id)
    if (idx === -1) return false
    blacklistStore.list.splice(idx, 1)
    return true
  },
}
// #endregion

// #region 沉淀池 (§3.5 草案) —— 只写 tag↔tag 共现事实边; 草稿组不沉淀; 已知 id 路径不经过
export const sediment = {
  map: sedimentPool.map,

  /** Phase 2 共现边写路径: anchorNorm = 调用侧锚点归一名; items = 视频 tag 团 */
  merge(anchorNorm: string, items: TagClique[]) {
    if (!items.length) return
    sedimentMerge(sedimentPool.map, anchorNorm, items)
  },

  /** 候选清单勾选确认 => confirmed 强信号 */
  confirm(normName: string) {
    sedimentConfirm(sedimentPool.map, normName)
  },

  /**
   * 票 36: 深挖游标回写 —— digPass 页游标成功推进后调用 (allPagesFailed 由调用侧整流跳过);
   * 水合读端 = `sediment.map.get(key)?.dig` (建流点经 digResumeFromSediment 纯函数)
   */
  noteDig(normName: string, dig: Parameters<typeof sedimentNoteDig>[2]) {
    sedimentNoteDig(sedimentPool.map, normName, dig)
  },

  /** 清空已看后从头召回旧内容，保留标签关系与用户确认的变体。 */
  resetDigProgress() {
    for (const node of sedimentPool.map.values()) delete node.dig
  },

  /** LRU 手动触发 (merge 内已自动 prune) */
  prune() {
    return pruneSediment(sedimentPool.map)
  },

  /** 清空可重采的标签关系与发掘进度，用户收藏保留。 */
  clear() {
    sedimentClear(sedimentPool.map)
  },
}
// #endregion

// #region 已看 seen-set (§3.4) —— bvid 集合; 只计肉眼可见的展示 (≥50% 进视口), 被拉取/被滤除不计
// 两 tab 共享; 收藏表/黑名单变动不动本 set (门面层不加联动)
export const seen = {
  /** 原始集合 (读: has/遍历; 写一律走 add/clear 保 FIFO 不变式) */
  set: seenPool.set,

  has(bvid: string) {
    return seenPool.set.has(bvid)
  },

  /** ≥50% 进视口 (useTagRecSeen) 即记: 先查重; 超容量 FIFO 删最旧 */
  add(bvid: string) {
    return addToSeenSet(seenPool.set, bvid, settings.tagRec.seenCap ?? DEFAULT_SEEN_CAP)
  },

  /** 清空浏览去重记录，刷新与服务状态复位由恢复入口协调。 */
  clear() {
    clearSeenSet(seenPool.set)
  },
}
// #endregion
