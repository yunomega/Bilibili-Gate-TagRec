import { shuffle } from 'es-toolkit'
import { hasTagRecCombination } from '../model/combination'
import { groupState, TAG_GROUP_WEIGHT_MAX } from '../model/favorites'
import type { TagGroup, TagIdEntry, TagL1Group } from '../model/types'

/**
 * [tag-rec] 牌组循环抽样 (spec §4.3 tab1 选组 / §3.6 deck 会话态; 票 17 升维三层)
 * - 抽样内核 = 加权不放回牌堆 WeightedIdPile: {id,weight} 单位按 weight=张数入堆,
 *   不放回抽 K 个不同 id (同单位重复卡抽到即废, weight 只影响中抽概率无配额);
 *   残堆先续抽，抽干仍不足 K 时仅补尚未抽中的单位。
 * - L1/L2 三层公平性 (票 17, TagRecUnitsDeck):
 *   外层: 可抽 L1 (enabled&&weight>0 且麾下 ≥1 可抽 L2) 按 weight 不放回抽 K 个不同 L1
 *   中层: 被抽中 L1 麾下可抽 L2 按各自 weight 入小堆；预取窗口可分配多个不同 L2。
 *   内层: 抽中 L2 的 tag_ids ≤10 全量, >10 按同会话共享游标轮转取 10 切片 (pickTagIdsForRound)
 * - 查看范围 (R7, 原票 26 主题筛升级): drawUnits 携 viewedL1Ids => 外层单位再筛范围内 L1;
 *   零写入 (不改 L1 enabled), undefined = 不筛
 * - 资格指纹: 外层覆盖 当前主题 id + L1 表 {id,enabled,weight,themeId} + 每组 l1Id 归属 + L2 既有资格项, 变即重建;
 *   name/note 等显示字段不入指纹 (改了不动牌堆); 组序不敏感 (排序后指纹)
 * - 生命周期由调用方管理；收藏推荐与库存同会话共享，资格变化时重建，不落盘。
 */

/** 入抽资格 = 三态「正常」 (enabled && weight>0); 挂起(weight=0)/停用不入堆 */
export function isDeckDrawable(
  g: Pick<TagGroup, 'weight' | 'enabled'> & Partial<Pick<TagGroup, 'tag_ids' | 'combination'>>,
): boolean {
  return groupState(g) === 'normal' && (!g.tag_ids || g.tag_ids.length > 0 || hasTagRecCombination(g.combination))
}

/** 二级组会话覆盖只产生副本，空组与 weight=0 仍由抽样资格拒绝。 */
export function withTagRecGroupScope(
  groups: readonly TagGroup[],
  viewedGroupIds?: ReadonlySet<string>,
  temporary?: readonly string[],
): TagGroup[] {
  const temp = new Set(temporary)
  return groups.map((g) => {
    const enabled = (g.enabled || temp.has(g.id)) && (!viewedGroupIds || viewedGroupIds.has(g.id))
    return enabled === g.enabled ? g : { ...g, enabled }
  })
}

/**
 * L1 入抽资格 (票 17, 语义同 L2: enabled && weight>0);
 * R7 查看范围: viewedL1Ids 非空时还要求 L1 在范围内 (undefined = 不筛; 范围展开见 model/view-scope);
 * 麾下 ≥1 可抽 L2 才实际入外层堆 —— 见 TagRecUnitsDeck
 */
export function isL1Drawable(
  l1: Pick<TagL1Group, 'id' | 'enabled' | 'weight'>,
  viewedL1Ids?: ReadonlySet<string>,
): boolean {
  if (!l1.enabled || l1.weight <= 0) return false
  if (viewedL1Ids && !viewedL1Ids.has(l1.id)) return false
  return true
}

/**
 * R7 临时打开合流: temp 集内的 L1 视同 enabled (返回映射副本, 不改 store)。
 * 会话级 —— 刷新还原; 合流后 deck 判定/指纹/计数全链自然生效
 */
export function withTagRecTempEnables(
  l1s: readonly TagL1Group[],
  tempEnabledIds: readonly string[] | undefined,
): TagL1Group[] {
  if (!tempEnabledIds?.length) return [...l1s]
  const set = new Set(tempEnabledIds)
  return l1s.map((l) => (set.has(l.id) && !l.enabled ? { ...l, enabled: true } : l))
}

/** 资格指纹 (spec §4.3): 只含 {id,weight,enabled,tag_ids}; 组序不敏感; name/note 不参与 */
export function deckFingerprint(groups: readonly TagGroup[]): string {
  return groups
    .map(
      (g) =>
        `${g.id}=${g.enabled ? 1 : 0}:${g.weight}:${g.tag_ids.map((e) => e.id).join(',')}:${hasTagRecCombination(g.combination) ? 1 : 0}`,
    )
    .sort()
    .join('|')
}

/** 建堆: 资格组各 push weight 张 id 卡, 洗牌 (weight 读侧钳制同 WeightedIdPile, 防持久层脏数据) */
export function buildDeckPile(groups: readonly TagGroup[], shuffleFn: <T>(arr: T[]) => T[]): string[] {
  const pile: string[] = []
  for (const g of groups) {
    if (!isDeckDrawable(g)) continue
    for (let i = 0, w = Math.min(Math.floor(g.weight) || 0, TAG_GROUP_WEIGHT_MAX); i < w; i++) pile.push(g.id)
  }
  return shuffleFn(pile)
}

/** L2 资格指纹项 (票 17: 既有项 + l1Id 归属 —— 归属变更视同资格变更) */
const l2FpEntry = (g: TagGroup) =>
  `${g.id}=${g.enabled ? 1 : 0}:${g.weight}@${g.l1Id ?? ''}#${g.tag_ids.map((e) => e.id).join(',')}:${hasTagRecCombination(g.combination) ? 1 : 0}`

/**
 * 外层资格指纹 (票 17 + R7): 查看范围 (L1 id 集展开) + L1 表 {id,enabled,weight} +
 * 每组 l1Id 归属 + L2 自身资格项; 组序不敏感; name/note 不入指纹 —— 任一变即重建整棵牌堆
 * (查看范围变更视同资格变更, 「资格变即重建」语义保持)
 * AUDIT-A1-2: 指纹收窄到「会影响抽取结果」的字段 —— 不可抽实体 (停用/挂起/范围外) 只留
 *   id+不可抽位: 挂起组改 tag_ids / 停用 L1 改 weight 不再炸掉整棵牌堆与共享态;
 *   其资格字段在该实体转可抽时随「off→on」翻转自然入指纹, 重建时机不丢。
 */
export function unitsFingerprint(
  groups: readonly TagGroup[],
  l1s: readonly TagL1Group[],
  viewedL1Ids?: ReadonlySet<string>,
): string {
  // 麾下 ≥1 可抽 L2 才实际入外层堆 (drawUnits 同判据) —— 空可抽 L1 的字段变也不影响抽取结果, 折叠
  const l1WithDrawableChild = new Set(groups.filter((g) => g.l1Id && isDeckDrawable(g)).map((g) => g.l1Id as string))
  const activeParents = new Set(
    l1s.filter((l) => isL1Drawable(l, viewedL1Ids) && l1WithDrawableChild.has(l.id)).map((l) => l.id),
  )
  const l1Part = l1s
    .map((l) =>
      // 范围外即不可抽 —— off 位折叠其余字段
      isL1Drawable(l, viewedL1Ids) && l1WithDrawableChild.has(l.id) ? `L1#${l.id}=1:${l.weight}` : `L1#${l.id}=0`,
    )
    .sort()
    .join('|')
  const l2Part = groups
    .map((g) => (g.l1Id && activeParents.has(g.l1Id) && isDeckDrawable(g) ? l2FpEntry(g) : `${g.id}=0`))
    .sort()
    .join('|')
  const viewPart = viewedL1Ids ? [...viewedL1Ids].sort().join(',') : ''
  return `view=${viewPart}::${l1Part}::${l2Part}`
}

type PileUnit = { id: string; weight: number }

/**
 * 加权不放回牌堆内核 (spec §3.6 机制): units 由调用侧按可抽过滤;
 * 资格指纹变 / 余量 <K => 整副重洗; 逐张抽, 同单位重复卡抽到即废, 返回 ≤K 个不同 id (抽出顺序)
 */
class WeightedIdPile {
  private pile: string[] = []
  private fingerprint = ''

  constructor(private readonly shuffleFn: <T>(arr: T[]) => T[] = shuffle) {}

  /** 当前堆内剩余牌数 (诊断/测试观测用) */
  get pileSize() {
    return this.pile.length
  }

  private reshuffle(units: readonly PileUnit[]) {
    const pile: string[] = []
    // AUDIT-A1-7: weight 读侧钳制 —— 持久层脏数据 (手改 GM/旧版写入) 可注入超大 weight,
    //   不经 clampWeight 写路径直入建堆会按 weight 张数爆内存; 读侧兜底与写侧同上限
    for (const u of units) {
      const w = Math.min(Math.max(Math.floor(u.weight) || 0, 0), TAG_GROUP_WEIGHT_MAX)
      for (let i = 0; i < w; i++) pile.push(u.id)
    }
    this.pile = this.shuffleFn(pile)
  }

  /**
   * AUDIT-A1-1: 残堆不再按「剩余卡数<K」整副丢弃 —— 残堆中的未抽中单位下轮先出,
   *   抽干残堆仍未凑够 K 时以「剔除本轮已中 id」的单位集补一副新堆续抽 (一副不放回跨轮保持,
   *   权重仍按卡数影响中抽概率)。旧实现轮首丢弃残堆 ⇒ 尾部单位 (size-biased 排序中低权更易居尾)
   *   系统性跳员: 3 组各 w1/k2 下总有一组被丢, 5v1 权重下轻组缺席约 40% 轮次。
   */
  draw(units: readonly PileUnit[], fingerprint: string, k: number): string[] {
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.reshuffle(units)
    }

    const pickedIds: string[] = []
    const picked = new Set<string>()
    while (picked.size < k) {
      if (!this.pile.length) {
        const rest = units.filter((u) => !picked.has(u.id))
        if (!rest.length) break
        this.reshuffle(rest)
        if (!this.pile.length) break // 防御: 全零权单位集
      }
      const id = this.pile.pop()!
      if (picked.has(id)) continue // 同单位重复卡, 抽到即废
      picked.add(id)
      pickedIds.push(id)
    }
    return pickedIds
  }
}

export class TagRecDeck {
  private readonly core: WeightedIdPile

  /**
   * @param shuffleFn 洗牌注入点 (默认 es-toolkit shuffle; 测试传确定性实现)
   */
  constructor(shuffleFn: <T>(arr: T[]) => T[] = shuffle) {
    this.core = new WeightedIdPile(shuffleFn)
  }

  /** 当前堆内剩余牌数 (诊断/测试观测用) */
  get pileSize() {
    return this.core.pileSize
  }

  /**
   * 一轮抽组 (退化路径 = 无层级直抽 L2): 资格指纹比对 (变即重建) => 剩余<K 整副重洗 => 不放回抽至多 K 个不同组
   * 返回按抽出顺序的组 (不足 K 返回实际抽得数; 无资格组返回 [])
   */
  drawGroups(groups: readonly TagGroup[], k: number): TagGroup[] {
    const units = groups.filter(isDeckDrawable).map((g) => ({ id: g.id, weight: g.weight }))
    const pickedIds = this.core.draw(units, deckFingerprint(groups), k)
    const byId = new Map(groups.map((g) => [g.id, g]))
    return pickedIds.map((id) => byId.get(id)).filter((g): g is TagGroup => !!g)
  }
}

/**
 * 三层公平抽样 deck (票 17): 外层 L1 加权不放回 => 中层被抽中 L1 麾下 L2 加权抽 1
 * 返回解析后的 L2 组集 —— 下游 sources/roundNegsByGroup/groupNames 全链路不感知层级
 */
export class TagRecUnitsDeck {
  private readonly outer: WeightedIdPile
  /** 中层小堆: l1Id => 麾下 L2 牌堆 (懒建, 被外层抽中才抽) */
  private readonly inners = new Map<string, WeightedIdPile>()

  /**
   * @param shuffleFn 洗牌注入点 (默认 es-toolkit shuffle; 测试传确定性实现)
   */
  constructor(private readonly shuffleFn: <T>(arr: T[]) => T[] = shuffle) {
    this.outer = new WeightedIdPile(shuffleFn)
  }

  /** 外层堆剩余牌数 (诊断/测试观测用) */
  get pileSize() {
    return this.outer.pileSize
  }

  /**
   * 供给抽样: 外层不放回抽 ≤K 个不同 L1；缺省每父组抽 1 个 L2，预取窗口可分配多个。
   * R7 查看范围: viewedL1Ids 非空 => 外层单位只留范围内的 L1 (undefined = 不筛; 纯过滤, 零写入)
   * 返回按抽出顺序的 L2 组 (不足 K 返回实际抽得数; 无可抽单位返回 [])
   */
  drawUnits(
    groups: readonly TagGroup[],
    l1s: readonly TagL1Group[],
    k: number,
    viewedL1Ids?: ReadonlySet<string>,
    /** A5: 调用侧本轮已算过的语境签名可复用 (fav: contextSignature = unitsFingerprint 同源),
     *    省每轮一次 O(L1+L2×ids) 全表映射+排序; 缺省自算 */
    fingerprint?: string,
    /** 收藏推荐预取：同一父组可取多个不同 L2，所有父组合计不超过本窗口。缺省仍为每父组 1 个。 */
    maxGroups?: number,
  ): TagGroup[] {
    // 可抽 L2 按归属 L1 聚合; 裸奔/悬挂已删 L1 的组不成单位 —— 「无裸奔」不变式由 store 收口, 此处防御
    const childrenByL1 = new Map<string, TagGroup[]>()
    for (const g of groups) {
      if (!g.l1Id || !isDeckDrawable(g)) continue
      const arr = childrenByL1.get(g.l1Id) ?? []
      arr.push(g)
      childrenByL1.set(g.l1Id, arr)
    }
    // 外层单位 = 可抽 L1 且麾下 ≥1 可抽 L2 (空 L1 保留但无资格入堆, spec); R7: 查看范围再筛
    const units = l1s.filter((l) => isL1Drawable(l, viewedL1Ids) && childrenByL1.has(l.id))
    const groupLimit = maxGroups === undefined ? undefined : Math.max(0, Math.floor(maxGroups) || 0)
    const pickedL1Ids = this.outer.draw(
      units.map((l) => ({ id: l.id, weight: l.weight })),
      fingerprint ?? unitsFingerprint(groups, l1s, viewedL1Ids),
      groupLimit === undefined ? k : Math.min(k, groupLimit),
    )

    // 已删 L1 的中层小堆顺手清 (防长跑泄漏; 留存者靠指纹比对自愈)
    const aliveL1 = new Set(l1s.map((l) => l.id))
    for (const key of this.inners.keys()) if (!aliveL1.has(key)) this.inners.delete(key) // Map 活迭代器, 边遍历边删安全

    const allocations = new Map(pickedL1Ids.map((id) => [id, 1]))
    let remaining = (groupLimit ?? pickedL1Ids.length) - pickedL1Ids.length
    while (remaining > 0) {
      let advanced = false
      for (const id of pickedL1Ids) {
        if (remaining <= 0) break
        if (allocations.get(id)! >= childrenByL1.get(id)!.length) continue
        allocations.set(id, allocations.get(id)! + 1)
        remaining--
        advanced = true
      }
      if (!advanced) break
    }
    const out: TagGroup[] = []
    for (const l1Id of pickedL1Ids) {
      const children = childrenByL1.get(l1Id) ?? []
      if (!children.length) continue // 防御: 外层单位已保证 ≥1
      let inner = this.inners.get(l1Id)
      if (!inner) this.inners.set(l1Id, (inner = new WeightedIdPile(this.shuffleFn)))
      // 中层指纹 = 麾下可抽 L2 资格集 (成员进出/资格字段变即重建该小堆; 未变续抽)
      const gids = inner.draw(
        children.map((g) => ({ id: g.id, weight: g.weight })),
        children.map(l2FpEntry).sort().join('|'),
        allocations.get(l1Id)!,
      )
      for (const gid of gids) {
        const g = children.find((x) => x.id === gid)
        if (g) out.push(g)
      }
    }
    return out
  }
}

/** 内层轮转切片大小 (票 17: 大组请求封顶 10/轮, tag 逐轮轮询雨露均沾) */
export const TAG_IDS_ROUND_SLICE = 10

/**
 * 内层 tag 轮转 (票 17, 两 tab 共用纯函数):
 * tag_ids ≤10 => 全量; >10 => 从 cursor 起取 10 切片并回绕推进, 逐轮覆盖全量
 * 游标存取归调用侧 —— AUDIT-20 起落在梯队共享盒 (TagRecLadderSharedState.tagCursors/queryCursor,
 * 跨 service 重建存活防大组首片饿死, 语境签名变随盒同清); 纯函数, 不改传入参数
 */
export function pickTagIdsForRound(
  tagIds: readonly TagIdEntry[],
  cursor: number,
): { entries: TagIdEntry[]; nextCursor: number } {
  if (tagIds.length <= TAG_IDS_ROUND_SLICE) return { entries: tagIds.slice(), nextCursor: 0 }
  const n = tagIds.length
  const offset = Number.isFinite(cursor) ? Math.trunc(cursor) : 0
  const start = ((offset % n) + n) % n // 防御: 负值/越界游标归一
  const entries = Array.from({ length: TAG_IDS_ROUND_SLICE }, (_, i) => tagIds[(start + i) % n])
  return { entries, nextCursor: (start + TAG_IDS_ROUND_SLICE) % n }
}
