/** Suggest literal phrases, not dictionary tokens. Exact names inside brackets stay intact. */
export function tagRecMaterialWords(text: string): string[] {
  const clean = text
    .replaceAll(/(?:https?:\/\/|www\.)[^\s<>，。；]+/gi, '\n')
    .replaceAll(/(?:提取码|提取碼|访问码|访问碼|密码|密碼)[\s:：]*[\da-z]+/gi, '\n')
  const names = [...clean.matchAll(/[《「『【（([]([^《》「」『』【】（）()[\]\n]{2,32})[》」』】）)\]]/g)].map(
    (match) => match[1],
  )
  const parts = clean.split(/[\n\r\t，,。.!！?？；;：:、/|《》「」『』【】（）()[\]]+/)
  const noise = /^(?:链接|連結|提取码|提取碼|本人|简介|视频|标题|我的|之一|通过网盘分享的文件|pdf|https?|www|com|\d+)$/i
  return [...new Set([...names, ...parts, ...tagRecSegmentWords(clean)].map((part) => part.trim()))]
    .filter((part) => part.length >= 2 && part.length <= 32 && /[\p{L}\p{N}]/u.test(part) && !noise.test(part))
    .slice(0, 24)
}

type WordSegmenter = { segment: (input: string) => Iterable<{ segment: string; isWordLike?: boolean }> }

/** 浏览器内建 ICU 切词 (零依赖, Chromium 直用): 无标点标题也能给出词级建议; 老环境返回空回退现状。 */
function getSegmenter(): WordSegmenter | undefined {
  const ctor = (
    Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => WordSegmenter }
  ).Segmenter
  if (!ctor) return undefined
  try {
    return new ctor('zh', { granularity: 'word' })
  } catch {
    return undefined
  }
}

/** 词级切分结果 (过噪声过滤前的原文词, ≥1 字符); 无 Segmenter 环境为空数组。 */
export function tagRecSegmentWords(text: string): string[] {
  const segmenter = getSegmenter()
  if (!segmenter) return []
  const words: string[] = []
  for (const part of segmenter.segment(text)) if (part.isWordLike) words.push(part.segment)
  return words
}

export type TagRecMaterialSegment = { text: string; word: boolean }

/**
 * 原文渲染用: 词段 (可点, ≥2 字符) 与标点/空白 (不可点) 交替切分, 相邻同类合并;
 * 无 Segmenter 环境返回单段纯文本 (保留原有拖选取词行为)。
 */
export function tagRecMaterialSegments(text: string): TagRecMaterialSegment[] {
  const segmenter = getSegmenter()
  if (!segmenter) return [{ text, word: false }]
  const out: TagRecMaterialSegment[] = []
  for (const part of segmenter.segment(text)) {
    const word = !!part.isWordLike && part.segment.trim().length >= 2
    const last = out.at(-1)
    if (last && last.word === word) last.text += part.segment
    else out.push({ text: part.segment, word })
  }
  return out
}
