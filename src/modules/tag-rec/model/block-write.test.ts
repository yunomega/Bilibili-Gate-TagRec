import { describe, expect, it } from 'vitest'
import { planTitleKeywordWrites, planUpBlockWrite, splitTitleToSegments } from './block-write'

describe('$modules/tag-rec/model/block-write (票 33 右键屏蔽双写规划)', () => {
  it('.planUpBlockWrite 有 mid: 全局写 mid 串 + tagRec 写 {name,mid}', () => {
    const plan = planUpBlockWrite({ name: '某UP', mid: 42 }, [], [])
    expect(plan.globalAdd).toBe('42') // parseFilterByAuthor 口径: 数字串=mid
    expect(plan.tagRecAdd).toEqual({ name: '某UP', mid: 42 })
  })

  it('.planUpBlockWrite 无 mid 退名: 全局写名, tagRec 写 {name}', () => {
    const plan = planUpBlockWrite({ name: '某UP' }, [], [])
    expect(plan.globalAdd).toBe('某UP')
    expect(plan.tagRecAdd).toEqual({ name: '某UP', mid: undefined })
  })

  it('.planUpBlockWrite 双表去重: 全局含 mid 串 / tagRec 按 mid 命中 => 各侧跳过', () => {
    const plan = planUpBlockWrite({ name: '某UP', mid: 42 }, ['42', '别的'], [{ name: '别人', mid: 42 }])
    expect(plan.globalAdd).toBeUndefined()
    expect(plan.tagRecAdd).toBeUndefined()
    // 单边存在 => 另一侧仍补
    const p2 = planUpBlockWrite({ name: '某UP', mid: 42 }, ['42'], [])
    expect(p2.globalAdd).toBeUndefined()
    expect(p2.tagRecAdd).toEqual({ name: '某UP', mid: 42 })
  })

  it('.planUpBlockWrite tagRec 去重口径同 filter-form: 无 mid 按 name, 有 mid 不按 name 误伤', () => {
    // 无 mid => 名命中即重复
    expect(planUpBlockWrite({ name: '某UP' }, [], [{ name: '某UP' }]).tagRecAdd).toBeUndefined()
    // 有 mid => 只按 mid 判重; 同名无 mid 条目不挡 {name,mid} 升级项
    const p = planUpBlockWrite({ name: '某UP', mid: 42 }, [], [{ name: '某UP' }])
    expect(p.tagRecAdd).toEqual({ name: '某UP', mid: 42 })
  })

  it('.planTitleKeywordWrites 逐词两表各查: 双有=skipped, 单边缺=补缺侧', () => {
    const plan = planTitleKeywordWrites(
      ['新词', '两边都有', '仅全局', '仅tagRec'],
      ['两边都有', '仅全局'],
      ['两边都有', '仅tagRec'],
    )
    expect(plan.globalAdds).toEqual(['新词', '仅tagRec'])
    expect(plan.tagRecAdds).toEqual(['新词', '仅全局'])
    expect(plan.skipped).toEqual(['两边都有'])
  })

  it('.planTitleKeywordWrites 输入内 trim/去重/去空', () => {
    const plan = planTitleKeywordWrites([' 词A ', '词A', '', ' '.repeat(3)], [], [])
    expect(plan.globalAdds).toEqual(['词A'])
    expect(plan.tagRecAdds).toEqual(['词A'])
    expect(plan.skipped).toEqual([])
  })

  it('.splitTitleToSegments 标点/空白/符号切段 + trim 去空 + 单字符段不入 (W1-3)', () => {
    expect(splitTitleToSegments('【原神】7.1版本 剧情合集!!')).toEqual(['原神', '1版本', '剧情合集']) // '7' 单字符被丢
    expect(splitTitleToSegments('hello world，你好～世界')).toEqual(['hello', 'world', '你好', '世界'])
    expect(splitTitleToSegments('a b 的 x')).toEqual([]) // 全单字符 => 空 (1 字词会命中一切, 不可作屏蔽词)
    expect(splitTitleToSegments('')).toEqual([])
  })

  it('.splitTitleToSegments 大小写不敏感去重, 留先现形', () => {
    expect(splitTitleToSegments('AD 广告 ad 推广')).toEqual(['AD', '广告', '推广'])
  })
})
