import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import {
  isPartialStat,
  normalizeAllV2Item,
  normalizePicUrl,
  normalizeTagTopItem,
  pickNum,
  stripHighlightTags,
  type AllV2VideoItem,
} from './normalize-item'
import type { TagTopItem } from '../api/endpoints'

const tagTopItem: TagTopItem = {
  aid: 117092451943617,
  bvid: 'BV1Wggw66E4w',
  cid: 40897085692,
  tid: 17,
  tname: '单机游戏',
  tidv2: 2079,
  tnamev2: '单机游戏',
  pic: 'http://i0.hdslb.com/bfs/archive/foo.jpg',
  title: '某标签视频',
  desc: 'desc',
  duration: 11200,
  pubdate: 1786689238,
  owner: { mid: 57503805, name: '某UP', face: 'https://i0.hdslb.com/bfs/face/foo.jpg' },
  stat: { view: 2427, danmaku: 1, reply: 3, favorite: 76, coin: 11, share: 6, like: 59 },
}

describe.concurrent('$modules/tag-rec/model/normalize-item', () => {
  it('.normalizeTagTopItem 直取 owner/tid/tnamev2/stat 七项', () => {
    const ret = normalizeTagTopItem(tagTopItem, { groupNames: ['组A'], srcRank: 5 })
    expect(ret.api).toBe(EApiType.TagRec)
    expect(ret.uniqId).toBe('tag-rec:BV1Wggw66E4w')
    expect(ret.bvid).toBe('BV1Wggw66E4w')
    expect(ret.aid).toBe(117092451943617)
    expect(ret.cid).toBe(40897085692)
    expect(ret.title).toBe('某标签视频')
    expect(ret.pic).toBe('http://i0.hdslb.com/bfs/archive/foo.jpg')
    expect(ret.duration).toBe(11200)
    expect(ret.pubdate).toBe(1786689238)
    expect(ret.owner).toEqual({ mid: 57503805, name: '某UP', face: 'https://i0.hdslb.com/bfs/face/foo.jpg' })
    expect(ret.tid).toBe(17)
    expect(ret.tidv2).toBe(2079) // v2 子分区 id 直取 (partition 维原料)
    expect(ret.tnamev2).toBe('单机游戏')
    expect(ret.stat).toEqual({ view: 2427, like: 59, favorite: 76, coin: 11, danmaku: 1, reply: 3, share: 6 })
    expect(ret.partial).toBe(false)
    expect(ret.source).toEqual({ via: 'tag-top', groupNames: ['组A'] })
    expect(ret.srcRank).toBe(5)
  })

  it('.normalizeTagTopItem stat 只剩 view => partial', () => {
    const item: TagTopItem = { bvid: 'BV1x', title: 't', pic: 'p', stat: { view: 100 } }
    const ret = normalizeTagTopItem(item, { groupNames: ['g'], srcRank: 0 })
    expect(ret.stat.view).toBe(100)
    expect(ret.partial).toBe(true)
  })

  it('.normalizeAllV2Item 归一映射 + 缺字段豁免', () => {
    const item: AllV2VideoItem = {
      bvid: 'BV1n4h46tEQP',
      aid: 117318289984923,
      title: '<em class="keyword">原神</em>7.1版本剧情合集',
      description: '会加快更新的',
      pic: '//i2.hdslb.com/bfs/archive/bar.jpg',
      play: 531061,
      danmaku: 11475,
      like: 9346,
      favorites: 5291,
      review: 4097,
      author: '泛音1572',
      mid: 23084818, // 票 33 起映射 owner.mid
      typeid: '172', // 字符串 id
      typename: '手机游戏',
      pubdate: 1790135762,
      duration: '451:39', // spec 不映射
      tag: '原神,手游',
    }
    const ret = normalizeAllV2Item(item, { via: 'all-v2-exact', groupNames: ['组B'], srcRank: 2 })
    expect(ret.api).toBe(EApiType.TagRec)
    expect(ret.uniqId).toBe('tag-rec:BV1n4h46tEQP')
    expect(ret.bvid).toBe('BV1n4h46tEQP')
    expect(ret.aid).toBe(117318289984923)
    // title 剥 HTML 标记; pic 补 https:
    expect(ret.title).toBe('原神7.1版本剧情合集')
    expect(ret.pic).toBe('https://i2.hdslb.com/bfs/archive/bar.jpg')
    // 归一映射: play→view favorites→favorite review→reply
    expect(ret.stat).toEqual({
      view: 531061,
      like: 9346,
      favorite: 5291,
      danmaku: 11475,
      reply: 4097,
      coin: undefined,
      share: undefined,
    })
    // author→owner.name; mid→owner.mid (票 33); 无 face
    expect(ret.owner).toEqual({ name: '泛音1572', mid: 23084818 })
    // 旧 typeid 保留；旧 typename 不能冒充新版分区名。
    expect(ret.tid).toBe(172)
    expect(ret.tnamev2).toBeUndefined()
    // duration 'h:mm:ss' => 秒 (票04: all/v2 时长串归一化)
    expect(ret.duration).toBe(27099)
    expect(ret.partial).toBe(false)
    expect(ret.source).toEqual({ via: 'all-v2-exact', groupNames: ['组B'] })
    expect(ret.srcRank).toBe(2)
  })

  it('.normalizeAllV2Item 缺 stat 字段 => partial', () => {
    const ret = normalizeAllV2Item(
      { bvid: 'BVx', title: 't', play: 123 },
      { via: 'all-v2-related', groupNames: [], srcRank: 0 },
    )
    expect(ret.stat.view).toBe(123)
    expect(ret.partial).toBe(true)
  })

  it('.pickNum', () => {
    expect(pickNum(42)).toBe(42)
    expect(pickNum('172')).toBe(172)
    expect(pickNum('abc')).toBeUndefined()
    expect(pickNum(undefined)).toBeUndefined()
    expect(pickNum(null)).toBeUndefined()
    expect(pickNum(NaN)).toBeUndefined()
  })

  it('.stripHighlightTags', () => {
    expect(stripHighlightTags('<em class="keyword">原神</em>版本')).toBe('原神版本')
    expect(stripHighlightTags('无标记')).toBe('无标记')
    expect(stripHighlightTags('')).toBe('')
  })

  it('.normalizePicUrl', () => {
    expect(normalizePicUrl('//i2.hdslb.com/x.jpg')).toBe('https://i2.hdslb.com/x.jpg')
    expect(normalizePicUrl('http://i0.hdslb.com/x.jpg')).toBe('http://i0.hdslb.com/x.jpg')
    expect(normalizePicUrl(undefined)).toBeUndefined()
  })

  it('.isPartialStat', () => {
    expect(isPartialStat({ view: 1 })).toBe(true)
    expect(isPartialStat({})).toBe(true)
    expect(isPartialStat({ view: 1, like: 1 })).toBe(false)
  })
})
