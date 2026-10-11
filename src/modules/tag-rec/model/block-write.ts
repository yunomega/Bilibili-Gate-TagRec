import { normalizeTagName } from './tag-norm'

/**
 * [tag-rec] 票 33 右键屏蔽「双写」规划层 —— 纯函数可单测 (spec §4.7 备忘)
 * - 「屏蔽此 UP」= filter.byAuthor.keywords (推荐类 tab) + tagRec.filter.dims.upBlacklist (标签两 tab)
 * - 「按标题关键词屏蔽…」= filter.byTitle.keywords + tagRec.filter.dims.titleKeywords
 *   单写任一边另一面漏放; 落定由调用侧做: 全局侧走 updateSettingsInnerArray 门面 (多 tab 安全),
 *   dims 侧照 filter-form 先例直写 settings proxy + 开维
 * - W1-3: 归一化后 <2 字符的词不产出 (spec ≥2 字符; 单字符词 includes 几乎必中 = 静默灭池)
 */

/** 屏蔽词是否达判定下限 (归一化后 ≥2 字符 —— 与 scopedSubstringHit 消费口径一致) */
const isKeywordUsable = (w: string): boolean => normalizeTagName(w).length >= 2

/** dims.upBlacklist 条目形 (= TagRecFilterDims['upBlacklist']['list'][number]) */
export type TagRecUpBlockEntry = { name: string; mid?: number }

/**
 * 「屏蔽此 UP」双写规划:
 * - 全局侧一项: 有 mid 写 mid 串 (parseFilterByAuthor 口径: 数字=mid, 非数字=name), 无 mid 退名
 * - tagRec 侧一项 {name, mid?}; 去重并入既有逻辑 (filter-form 同口径: 有 mid 按 mid, 无则按 name)
 * @returns 两侧各自的待写项 (undefined = 该侧已存在, 跳过)
 */
export function planUpBlockWrite(
  up: { name?: string; mid?: number },
  globalKeywords: readonly string[],
  tagRecList: readonly TagRecUpBlockEntry[],
): { globalAdd?: string; tagRecAdd?: TagRecUpBlockEntry } {
  const globalContent = up.mid !== undefined ? `${up.mid}` : up.name?.trim() || undefined
  const globalAdd = globalContent && !globalKeywords.includes(globalContent) ? globalContent : undefined

  const tagRecAdd: TagRecUpBlockEntry = { name: up.name?.trim() ?? '', mid: up.mid }
  const tagRecDup = tagRecList.some((e) => (up.mid !== undefined ? e.mid === up.mid : e.name === tagRecAdd.name))

  return { globalAdd, tagRecAdd: tagRecDup ? undefined : tagRecAdd }
}

/**
 * 「按标题关键词屏蔽」双写规划: 逐词两表各查 (表内 dedupe 含输入自身重复)
 * - 两表皆已有 => skipped (toast 注明跳过数)
 * - 单边缺 => 补缺侧 (计入对应 adds); 全空/全重 => adds 皆空
 */
export function planTitleKeywordWrites(
  words: readonly string[],
  globalKeywords: readonly string[],
  tagRecList: readonly string[],
): { globalAdds: string[]; tagRecAdds: string[]; skipped: string[] } {
  const g = new Set(globalKeywords)
  const t = new Set(tagRecList)
  const seen = new Set<string>()
  const globalAdds: string[] = []
  const tagRecAdds: string[] = []
  const skipped: string[] = []
  for (const raw of words) {
    const w = raw.trim()
    if (!w || !isKeywordUsable(w) || seen.has(w)) continue
    seen.add(w)
    if (g.has(w) && t.has(w)) {
      skipped.push(w)
      continue
    }
    if (!g.has(w)) globalAdds.push(w)
    if (!t.has(w)) tagRecAdds.push(w)
  }
  return { globalAdds, tagRecAdds, skipped }
}

/**
 * 标题片段切段 (票 33 裁量: 仓库无现成分词, 按标点/空白/符号切)
 * trim 去空 + 大小写不敏感去重 (dims.titleKeywords 命中本就是小写子串比较), 保留先现形
 */
const TITLE_SEGMENT_SEP = /[\s\p{P}\p{S}]+/u

export function splitTitleToSegments(title: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of title.split(TITLE_SEGMENT_SEP)) {
    const seg = raw.trim()
    if (!isKeywordUsable(seg)) continue
    const k = seg.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(seg)
  }
  return out
}
