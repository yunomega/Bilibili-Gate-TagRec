import { EApiType } from '$enums'
import { normalizeTagRecPartition } from './partition'
import { parseAllV2TagField } from './tag-norm'
import type { TagRecItemExtend } from '$define'
import type { TagTopItem } from '../api/endpoints'

/**
 * [tag-rec] 各源条目 => 统一字段视图 (spec §3.7)
 * 过滤/算分只认归一键, 不认来源字段名
 */

type StatView = TagRecItemExtend['stat']
type ItemSource = TagRecItemExtend['source']

/** 安全取数: number / 数字字符串 => number, 其余 => undefined */
export function pickNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** stat 除 view 外全缺 => partial: 不算分, 排全部有分条目之后 (spec §3.3) */
export function isPartialStat(stat: StatView): boolean {
  const keys: (keyof StatView)[] = ['like', 'favorite', 'coin', 'danmaku', 'reply', 'share']
  return !keys.some((k) => stat[k] !== undefined)
}

// #region tag/top 源 —— 字段直取 (owner/tid/tnamev2/stat 七项)
export function normalizeTagTopItem(
  item: TagTopItem,
  {
    via = 'tag-top',
    groupNames,
    groupIds,
    attributionLabels,
    srcRank,
  }: {
    via?: 'tag-top' | 'archive-related'
    groupNames: string[]
    groupIds?: string[]
    /** R7: 卡片归因标签 (主题·L1; 主路径组源条目填) */
    attributionLabels?: string[]
    srcRank: number
  },
): TagRecItemExtend {
  const stat: StatView = {
    view: item.stat?.view,
    like: item.stat?.like,
    favorite: item.stat?.favorite,
    coin: item.stat?.coin,
    danmaku: item.stat?.danmaku,
    reply: item.stat?.reply,
    share: item.stat?.share,
  }
  const source: ItemSource = {
    via,
    groupNames,
    ...(groupIds?.length ? { groupIds } : {}),
    ...(attributionLabels?.length ? { attributionLabels } : {}),
  }
  return {
    api: EApiType.TagRec,
    uniqId: `tag-rec:${item.bvid}`,
    bvid: item.bvid ?? '',
    aid: item.aid,
    cid: item.cid,
    title: item.title ?? '',
    desc: item.desc,
    fieldEvidence: {
      title: item.title === undefined ? 'missing' : 'complete',
      desc: item.desc === undefined ? 'missing' : 'complete',
    },
    pic: item.pic ?? '',
    duration: item.duration,
    pubdate: item.pubdate,
    owner: item.owner,
    ...normalizeTagRecPartition(item),
    stat,
    partial: isPartialStat(stat),
    source,
    srcRank,
  }
}
// #endregion

// #region all/v2 源 —— 字段名归一 (Phase 2 用, 端点接入归票 03)
/**
 * all/v2 (search/all/v2) 视频条目字段视图; 以实测响应为准
 * 与 tag/top 不同名: play/favorites/review/author/typeid/typename
 */
export type AllV2VideoItem = {
  bvid?: string
  aid?: number
  id?: number // = aid
  title?: string // 含 <em class="keyword"> 高亮标记
  description?: string
  pic?: string // 协议相对 "//i2.hdslb.com/..."
  play?: number | string
  danmaku?: number
  like?: number
  favorites?: number
  review?: number
  author?: string
  mid?: number // 票 33 起映射 owner.mid (右键「屏蔽此 UP」upBlacklist mid 维匹配原料)
  typeid?: number | string
  typename?: string
  tidv2?: number | string
  tid_v2?: number | string
  tnamev2?: string
  tname_v2?: string
  pid_v2?: number | string
  pid_name_v2?: string
  pubdate?: number
  duration?: string // "m:ss"/"h:mm:ss" 字符串, 归一化时解析成秒 (票04)
  tag?: string // 逗号分隔 tag 字段, Phase 2 共现挖掘用
}

/** 剥掉 all/v2 title 里的 <em class="keyword"> 等 HTML 高亮标记 */
export function stripHighlightTags(s: string): string {
  return s.replaceAll(/<[^>]+>/g, '')
}

/** 协议相对 URL "//i2.hdslb.com/..." => "https://..." */
export function normalizePicUrl(pic?: string): string | undefined {
  if (!pic) return undefined
  return pic.startsWith('//') ? `https:${pic}` : pic
}

/** all/v2 duration "m:ss"/"h:mm:ss" => 秒 (filter-scope 票04: 让搜索池能吃 duration 维); 失败 => undefined → miss 豁免 */
export function parseAllV2Duration(dur?: string): number | undefined {
  if (!dur) return undefined
  const parts = dur.split(':')
  if (parts.length < 2 || parts.length > 3) return undefined
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined
  if (parts.length === 2) return nums[0] * 60 + nums[1]
  return nums[0] * 3600 + nums[1] * 60 + nums[2]
}

/**
 * all/v2 => TagRecItemExtend (spec §3.7 归一映射)
 * play→view, favorites→favorite, review→reply, author→owner.name, typeid→tid；新版分区保留原生字段。
 * 无 coin/share/face => 触发缺字段豁免 (owner.mid 票 33 起补映射; duration 字符串解析成秒归票04)
 */
export function normalizeAllV2Item(
  item: AllV2VideoItem,
  {
    via,
    groupNames,
    groupIds,
    attributionLabels,
    srcRank,
  }: {
    via: 'all-v2-exact' | 'all-v2-related'
    groupNames: string[]
    groupIds?: string[]
    /** R7: 卡片归因标签 (主题·L1; 主路径组源条目填) */
    attributionLabels?: string[]
    srcRank: number
  },
): TagRecItemExtend {
  const stat: StatView = {
    view: pickNum(item.play),
    like: pickNum(item.like),
    favorite: pickNum(item.favorites),
    danmaku: pickNum(item.danmaku),
    reply: pickNum(item.review),
    // coin/share: 源无此字段
  }
  const source: ItemSource = {
    via,
    groupNames,
    ...(groupIds?.length ? { groupIds } : {}),
    ...(attributionLabels?.length ? { attributionLabels } : {}),
  }
  const ownTagNames = parseAllV2TagField(item.tag) // all/v2 自报 tag 名名单 (负向名匹配原料, spec §3.2)
  return {
    api: EApiType.TagRec,
    uniqId: `tag-rec:${item.bvid}`,
    bvid: item.bvid ?? '',
    aid: item.aid ?? item.id,
    title: stripHighlightTags(item.title ?? ''),
    desc: item.description,
    fieldEvidence: {
      title: item.title === undefined ? 'missing' : 'complete',
      desc: item.description === undefined ? 'missing' : 'partial',
    },
    pic: normalizePicUrl(item.pic) ?? '',
    duration: parseAllV2Duration(item.duration), // "m:ss"/"h:mm:ss" => 秒 (票04: 让搜索池能吃 duration 维)
    pubdate: item.pubdate,
    // owner: author→name; 票 33 补 mid (右键屏蔽 upBlacklist mid 维原料); 仍无 face
    owner: item.author || item.mid !== undefined ? { name: item.author, mid: item.mid } : undefined,
    ...normalizeTagRecPartition(item),
    tnamev2: item.tnamev2 ?? item.tname_v2,
    stat,
    partial: isPartialStat(stat),
    source,
    srcRank,
    ...(ownTagNames.length && { ownTagNames }),
  }
}
// #endregion
