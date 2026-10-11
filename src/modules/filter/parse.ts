export const REG_MID_WITH_REMARK = /^(?<mid>\d+)\((?<remark>[\S ]+)\)$/
export const REG_MID = /^\d+$/

export function parseUpRepresent(author: string): Partial<{ mid: string; remark: string }> {
  if (REG_MID_WITH_REMARK.test(author)) {
    const groups = REG_MID_WITH_REMARK.exec(author)?.groups
    const mid = groups?.mid
    const remark = groups?.remark
    return { mid, remark }
  }

  // 会有纯数字的用户名么?
  if (REG_MID.test(author)) {
    return { mid: author, remark: undefined }
  }

  return {}
}

export function parseFilterByAuthor(keywords: readonly string[]) {
  const blockUpMids = new Set<string>()
  const blockUpNames = new Set<string>()

  keywords.forEach((keyword) => {
    const { mid } = parseUpRepresent(keyword)
    mid ? blockUpMids.add(mid) : blockUpNames.add(keyword)
  })

  return { blockUpMids, blockUpNames }
}

export function parseFilterByTitle(keywords: string[] | readonly string[]) {
  const titleRegexList: RegExp[] = []
  const titleKeywordList: string[] = []
  keywords.forEach((keyword) => {
    if (keyword.startsWith('/') && keyword.endsWith('/')) {
      const regex = new RegExp(keyword.slice(1, -1), 'i')
      titleRegexList.push(regex)
    } else {
      titleKeywordList.push(keyword)
    }
  })

  function test(title: string) {
    return (
      titleKeywordList.some((keyword) => title.includes(keyword)) || titleRegexList.some((regex) => regex.test(title))
    )
  }

  return { titleKeywordList, titleRegexList, test }
}

// 调用者只传 snapshot() 的只读名单，以快照身份失效；可编辑名单仍用上面的即时解析接口。
function cacheSnapshotRules<T>(parse: (keywords: readonly string[]) => T) {
  const cache = new WeakMap<readonly string[], T>()
  return (keywords: readonly string[]): T => {
    let parsed = cache.get(keywords)
    if (!parsed) {
      parsed = parse(keywords)
      cache.set(keywords, parsed)
    }
    return parsed
  }
}

export const getSnapshotAuthorFilter = cacheSnapshotRules(parseFilterByAuthor)
export const getSnapshotTitleFilter = cacheSnapshotRules(parseFilterByTitle)
