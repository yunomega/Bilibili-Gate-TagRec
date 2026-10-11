/**
 * [tag-rec] tag 文本层纯函数 (零依赖叶子模块, 供 resolve/sediment/各面板复用)
 * 字形归一: 小写 + 去空白 + NFKC (spec §4.1; CONTEXT 字形变体定义)
 * 输入分流: 纯数字 = tag_id 直输逃生口 (全局统一)
 */

/** 字形归一化: NFKC 归一 => 小写 => 去全部空白 => 同形判定键 (normName) */
export function normalizeTagName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replaceAll(/\s+/g, '')
}

export type ParsedTagInput = { kind: 'id'; id: number } | { kind: 'name'; name: string }

/** 输入分流: trim; 纯数字 => tag_id 直输; 其余 => tag 名; 空 => undefined */
export function parseTagInput(raw: string): ParsedTagInput | undefined {
  const input = raw.trim()
  if (!input) return undefined
  if (/^\d+$/.test(input)) return { kind: 'id', id: Number(input) }
  return { kind: 'name', name: input }
}

/** 一个视频的 tag 团 (tag 字段解析结果; sediment.merge 语料单元) */
export type TagClique = { bvid?: string; tags: string[] }

/** all/v2 `tag` 字段半角逗号分隔; tag 名内可含全角「,」等字符, 只按半角切; trim + 保序去重 */
export function parseAllV2TagField(tag?: string): string[] {
  if (!tag) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tag.split(',')) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
