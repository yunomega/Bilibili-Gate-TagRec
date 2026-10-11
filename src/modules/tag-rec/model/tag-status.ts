import { stripRelatedSuffix } from './dig'
import { findGroupsByNegativeTagId, findGroupsByTagId } from './favorites'
import { normalizeTagName } from './tag-norm'
import type { TagGroup, TagIdEntry } from './types'

/**
 * [tag-rec] 标签弹层行状态归类 (spec §4.6; 零依赖叶子模块, 可测)
 * 票 19: 判定集收窄到「本卡落点集」scope —— 属性命中落点集 => 该态生效 (⛔ 红 / ★ 实心);
 *   落点集外宿主分开返回 (*Outside), 不给本卡反向通路; 票 23 起渲染不再消费 (「·他组」chip 删),
 *   字段保留给相关组 Modal/调试等知情通路。
 *   ⛔ 二态翻转素材: negative = 落点集内全部负向宿主 —— 非空 => 清这些; 空 => 加进全部落点
 * 「组X变体」判定复用解析管线同款归一化 (normalizeTagName: 小写+去空白+NFKC), 同样限定落点集
 */
export type VideoTagStatus = {
  /** 落点集内正向宿主 (★ 激活态 + 移出/停用动作对象; 空 => 本语境按未收藏渲染) */
  faved: TagGroup[]
  /** 落点集外正向宿主 (票 23 前「已收藏@「X」·他组」chip 素材; 现渲染不消费, 留作知情通路素材) */
  favedOutside: TagGroup[]
  /** 落点集内负向宿主 (⛔ 激活态 + 解黑对象; 空 => 本语境未黑, 点击加进全部落点) */
  negative: TagGroup[]
  /** 落点集外负向宿主 (票 23 前「负向@「X」·他组」chip 素材; 现渲染不消费, 留作知情通路素材) */
  negativeOutside: TagGroup[]
  /** 落点集内「组X变体」命中 (归一化同形不同 tag_id; 按落点集序首个) */
  variant?: { group: TagGroup; entry: TagIdEntry }
}

/**
 * @param tag 视频 tag
 * @param tag.id tag_id (宿主判定主键)
 * @param tag.name tag 名 (变体归一化判定原料)
 * @param scope 本卡落点集 = 判定集 = 动作集 (票 19): 归因名解析出的来源组 + 未归属名的草稿组;
 *   空集 (非 tag-rec 卡) => 全不激活, 落点集外宿主全进 *Outside 只读位
 * @param universe 宿主枚举全集 (收藏表组 + 草稿组伪组); 缺省 = scope (单集语义同票 14 旧行为)
 */
export function classifyVideoTagStatus(
  tag: { id: number; name: string },
  scope: readonly TagGroup[],
  universe: readonly TagGroup[] = scope,
): VideoTagStatus {
  const scopeIds = new Set(scope.map((g) => g.id))
  const inScope = (g: TagGroup) => scopeIds.has(g.id)

  // 已收藏: tag_id ∈ 组 tag_ids[] (按 id, 不按收藏项 id); 全量宿主按落点内/外分流 (票 19 复数版)
  const favedAll = findGroupsByTagId(universe, tag.id)
  // 负向: tag_id ∈ 组 negative_tag_ids; 同法分流
  const negAll = findGroupsByNegativeTagId(universe, tag.id)

  // 组X变体: 与落点集内条目归一化同形但 tag_id 不同 => 该组的字形变体
  const norm = normalizeTagName(tag.name)
  let variant: VideoTagStatus['variant']
  for (const g of scope) {
    const entry = g.tag_ids.find((e) => e.id !== tag.id && normalizeTagName(e.name) === norm)
    if (entry) {
      variant = { group: g, entry }
      break
    }
  }

  return {
    faved: favedAll.filter(inScope),
    favedOutside: favedAll.filter((g) => !inScope(g)),
    negative: negAll.filter(inScope),
    negativeOutside: negAll.filter((g) => !inScope(g)),
    variant,
  }
}

/** 草稿组在弹层展示用的占位 id (非收藏表真组; statusGroups 伪组与本卡落点集共用) */
export const DRAFT_GROUP_ID = '__draft__'

/**
 * 本卡落点集解析 (票 19: 状态判定集与动作集同收窄到此; 复用票 14 Q2 写入侧语义)
 * 优先使用卡片的稳定组 ID；旧名称只接受唯一匹配，未归属输入词可落草稿组。
 * tab2 组语境恒 1 组 (票 21), 多落点只剩 tab1 多归因卡; 空 => ⛔ 点击走 Modal 兜底
 * 票 20 顺带修: 归因名可带 via 后缀 (兜底流旁路归因 `${组名}·相关`, fallback-ladder.ts) ——
 * 剥掉后缀再按名查组, 对齐 service 侧 negEntriesOf 的 attributionKey (stripRelatedSuffix) 语义;
 * statusGroups 含草稿组伪组 iff 会话草稿组存在, 故不再回读 session (保持纯函数可测)
 */
export function resolveLandingGroups<G extends Pick<TagGroup, 'id' | 'name'>>(
  groups: readonly G[],
  statusGroups: readonly G[],
  sourceGroupNames: readonly string[],
  sourceGroupIds?: readonly string[],
): G[] {
  if (sourceGroupIds?.length) {
    const ids = new Set(sourceGroupIds)
    return groups.filter((g) => ids.has(g.id))
  }
  const names = sourceGroupNames.map(stripRelatedSuffix)
  // 历史条目仅有名称时只允许唯一匹配；同名歧义留给显式组选择。
  const counts = new Map<string, number>()
  for (const g of groups) counts.set(g.name, (counts.get(g.name) ?? 0) + 1)
  const set = new Set(names)
  const named = groups.filter((g) => set.has(g.name) && counts.get(g.name) === 1)
  const hasUnowned = names.some((n) => !groups.some((g) => g.name === n))
  const draftAsGroup = statusGroups.find((g) => g.id === DRAFT_GROUP_ID)
  const targets = [...named]
  if (hasUnowned && draftAsGroup) targets.push(draftAsGroup)
  return targets
}

/** view/detail/tag 的 tag_type => TagIdEntry.tag_type; 枚举外取值 (如数值 type) 不落 */
export function parseTagType(raw: unknown): TagIdEntry['tag_type'] {
  return raw === 'topic' || raw === 'old_channel' || raw === 'bgm' ? raw : undefined
}

/** view/detail/tag 行 => 收藏表条目 (id+name 快照 + opportunistic tag_type, spec §3.1) */
export function videoTagToTagIdEntry(tag: { tag_id: number; tag_name: string; tag_type?: string }): TagIdEntry {
  const tag_type = parseTagType(tag.tag_type)
  return { id: tag.tag_id, name: tag.tag_name, ...(tag_type && { tag_type }) }
}
