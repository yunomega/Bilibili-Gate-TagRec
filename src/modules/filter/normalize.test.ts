/**
 * [tag-rec] apiTagRecAdapter 的真实单测。
 *
 * normalize.tsx 的其余 import 都是卡片渲染/服务层依赖（antd、图标、rec-services 等），
 * 在 node 测试环境会连带拉进 DOM/GM/IndexedDB 依赖；这里只保留 TagRec 分支真正用到的
 * 纯逻辑（attribution、$utility/video、$utility/url），其余按需 mock，保证零产品代码改动。
 */
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EApiType } from '$enums'
import { normalizeCardData } from './normalize'
import type { TagRecItemExtend, TagRecSourceClaim } from '$define'

const mocks = vi.hoisted(() => ({
  settings: { tagRec: { showAttributionBadge: true } },
}))

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('$components/VideoCard/card-badges', () => ({
  defineCardBadges: (...items: any[]) =>
    items
      .flat()
      .filter(Boolean)
      .filter((x: any) => !!(x.icon || x.text)),
}))
vi.mock('$components/VideoCard/stat-item', () => ({
  AppRecommendApiIconType: { Play: 1, Like: 2, Danmaku: 3, BangumiFollow: 4, DynamicFeedLike: 20 },
  defineStatItems: (items: any[]) => items,
}))
vi.mock('$modules/antd/custom', () => ({ AntdTooltip: () => null }))
vi.mock('$modules/rec-services/dynamic-feed/api/df-normalize', () => ({ normalizeDynamicFeedItem: vi.fn() }))
vi.mock('$modules/rec-services/fav/fav-util', () => ({ isFavFolderPrivate: () => false }))
vi.mock('$modules/rec-services/fav/views', () => ({
  IconForCollection: () => null,
  IconForPrivateFolder: () => null,
  IconForPublicFolder: () => null,
}))
vi.mock('$modules/rec-services/history/enums', () => ({
  ApiDtToDeviceTypeStringMap: {},
  buildHistoryItemUrl: () => '',
  EHistoryBusiness: {},
  EHistoryDeviceType: {},
  EHistoryDeviceTypeConfig: {},
  EHistoryDeviceTypeString: {},
}))
vi.mock('$modules/rec-services/hot/rank/rank-tab', () => ({
  isPgcSeasonRankItem: () => false,
  isPgcWebRankItem: () => false,
}))
vi.mock('$modules/rec-services/space-upload', () => ({ spaceUploadAvatarCache: { get: () => undefined } }))
vi.mock('$modules/rec-services/space-upload/api/helper', () => ({ SpaceUploadItemHelper: class {} }))
vi.mock('$modules/rec-services/space-upload/store', () => ({ buildSpaceUploadVideoCardUrl: () => '' }))
vi.mock('$modules/rec-services/watchlater/helper', () => ({ buildWatchlaterVideoCardUrl: () => '' }))
vi.mock('$modules/settings', () => ({ settings: mocks.settings }))

// 直 import 时补挂 duration 插件 (src/index.ts 才挂载; extend 幂等)
dayjs.extend(duration)

const claim = (queryKeyword?: string, via: TagRecItemExtend['source']['via'] = 'tag-top'): TagRecSourceClaim => ({
  via,
  groupNames: ['科幻'],
  groupIds: ['g1'],
  queryKeyword,
})

const tagRecItem = (fields: Partial<TagRecItemExtend> = {}): TagRecItemExtend => {
  const base: TagRecItemExtend = {
    api: EApiType.TagRec,
    uniqId: 'tag-rec:BV1',
    bvid: 'BV1',
    title: '三体 人物',
    pic: 'http://i0.hdslb.com/cover.jpg',
    duration: 300,
    stat: { view: 100, like: 5, danmaku: 3 },
    source: { via: 'tag-top', groupNames: ['科幻'], groupIds: ['g1'] },
  }
  return { ...base, ...fields, source: { ...base.source, ...fields.source } }
}

beforeEach(() => {
  mocks.settings.tagRec.showAttributionBadge = true
})

describe('TagRec 卡片归因徽章 (apiTagRecAdapter)', () => {
  it('有实际召回标签时下钻到标签名：按序去重、去空白，优先于来源组名', () => {
    const card = normalizeCardData(
      tagRecItem({
        source: {
          via: 'tag-top',
          groupNames: ['科幻'],
          groupIds: ['g1'],
          attributionLabels: ['科幻 › 三体 等2个标签'],
          claims: [claim('三体'), claim(' 三体 '), claim('程心')],
        },
      }),
    )
    expect(card.recommendReason).toBe('三体 · 程心')
    expect(card.recommendReasonDetails).toEqual(['科幻 › 三体 等2个标签'])
  })

  it('召回关键词就是归因徽章；无关键词才回落来源组归因', () => {
    const tagTop = normalizeCardData(
      tagRecItem({ source: { via: 'tag-top', groupNames: ['科幻'], groupIds: ['g1'], queryKeyword: ' 三体 ' } }),
    )
    expect(tagTop.recommendReason).toBe('三体')

    // 搜索 / UP 搜索来源的 queryKeyword 是召回原因, 同样展示
    const search = normalizeCardData(
      tagRecItem({ source: { via: 'all-v2-exact', groupNames: ['科幻'], groupIds: ['g1'], queryKeyword: '三体' } }),
    )
    expect(search.recommendReason).toBe('三体')

    const upSearch = normalizeCardData(
      tagRecItem({ source: { via: 'up-search', groupNames: ['cosplay'], groupIds: ['g1'], queryKeyword: '护士' } }),
    )
    expect(upSearch.recommendReason).toBe('护士')

    const fallbackGroups = normalizeCardData(
      tagRecItem({ source: { via: 'all-v2-exact', groupNames: ['科幻', '奇幻'], groupIds: ['g1', 'g2'] } }),
    )
    expect(fallbackGroups.recommendReason).toBe('科幻 +1')
  })

  it('工作副本占位名（新试验）不会漏进徽章详情', () => {
    const card = normalizeCardData(
      tagRecItem({
        source: { via: 'all-v2-exact', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '清霄' },
      }),
    )
    expect(card.recommendReason).toBe('清霄')
    expect(card.recommendReasonDetails).toEqual(['清霄'])
  })

  it('相似衍生条继承种子命中词时徽标显示标签名, via 徽标独立显示「相似」', () => {
    const card = normalizeCardData(
      tagRecItem({
        source: {
          via: 'archive-related',
          groupNames: ['新试验·相关'],
          groupIds: ['__tagrec_working__'],
          queryKeyword: '清霄',
          claims: [
            { via: 'archive-related', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '清霄' },
          ],
        },
      }),
    )
    expect(card.recommendReason).toBe('清霄')
    expect(card.cardBadges).toEqual([{ key: 'tag-rec:via', text: '相似', className: 'bg-[#fa8c16]' }])
  })

  it('富化器重算展示词后徽标以它为准: 删条件后的旧召回词不再上卡', () => {
    const filtered = normalizeCardData(
      tagRecItem({
        source: {
          via: 'archive-related',
          groupNames: ['新试验·相关'],
          groupIds: ['__tagrec_working__'],
          queryKeyword: '鸣潮',
          claims: [
            { via: 'archive-related', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '鸣潮' },
          ],
          attributionKeywords: [],
          attributionLabels: ['新试验 › 清宵'],
        },
      }),
    )
    expect(filtered.recommendReason).toBe('新试验 › 清宵')
    expect(filtered.recommendReasonDetails).toEqual(['新试验 › 清宵'])

    const live = normalizeCardData(
      tagRecItem({
        source: {
          via: 'all-v2-related',
          groupNames: ['新试验·相关'],
          groupIds: ['__tagrec_working__'],
          queryKeyword: '鸣潮',
          attributionKeywords: ['清宵'],
        },
      }),
    )
    expect(live.recommendReason).toBe('清宵')
  })

  it('关闭归因徽章时 recommendReason 与详情都为空，但 via 来源徽标仍在', () => {
    mocks.settings.tagRec.showAttributionBadge = false
    const card = normalizeCardData(
      tagRecItem({
        source: {
          via: 'all-v2-exact',
          groupNames: ['科幻'],
          groupIds: ['g1'],
          claims: [claim('三体', 'all-v2-exact')],
        },
      }),
    )
    expect(card.recommendReason).toBeUndefined()
    expect(card.recommendReasonDetails).toBeUndefined()
    expect(card.cardBadges).toEqual([{ key: 'tag-rec:via', text: '搜索' }])
  })

  it('via 来源徽标映射为中文，tag-top 不画徽标，橙标只给相关/相似', () => {
    const viaBadge = (via: TagRecItemExtend['source']['via']) =>
      normalizeCardData(tagRecItem({ source: { via, groupNames: ['科幻'], groupIds: ['g1'] } })).cardBadges
    expect(viaBadge('up-search')).toEqual([{ key: 'tag-rec:via', text: 'UP搜索' }])
    expect(viaBadge('all-v2-exact')).toEqual([{ key: 'tag-rec:via', text: '搜索' }])
    expect(viaBadge('all-v2-related')).toEqual([{ key: 'tag-rec:via', text: '相关', className: 'bg-[#fa8c16]' }])
    expect(viaBadge('archive-related')).toEqual([{ key: 'tag-rec:via', text: '相似', className: 'bg-[#fa8c16]' }])
    expect(viaBadge('tag-top')).toBeUndefined()
  })

  it('归因详情优先用完整路径 attributionPaths 并去重', () => {
    const card = normalizeCardData(
      tagRecItem({
        source: {
          via: 'tag-top',
          groupNames: ['科幻'],
          groupIds: ['g1'],
          attributionLabels: ['科幻 › 三体'],
          attributionPaths: ['科幻 › 三体', '科幻 › 三体', '奇幻 › 程心'],
        },
      }),
    )
    expect(card.recommendReason).toBe('科幻 › 三体')
    expect(card.recommendReasonDetails).toEqual(['科幻 › 三体', '奇幻 › 程心'])
  })

  it('透传 tagRec 字段与基础视频字段，封面/头像走 https', () => {
    const card = normalizeCardData(
      tagRecItem({
        desc: '简介',
        tid: 4,
        tidv2: 123,
        tnamev2: '影视杂谈',
        pid_v2: 181,
        pid_name_v2: '影视',
        owner: { mid: 7, name: 'UP', face: 'http://i0.hdslb.com/face.jpg' },
        source: { via: 'tag-top', groupNames: ['科幻'], groupIds: ['g1'] },
      }),
    )
    expect(card).toMatchObject({
      bvid: 'BV1',
      href: '/video/BV1/',
      durationDisplay: '05:00',
      cover: 'https://i0.hdslb.com/cover.jpg',
      authorFace: 'https://i0.hdslb.com/face.jpg',
      tagRecGroupNames: ['科幻'],
      tagRecGroupIds: ['g1'],
      tagRecDesc: '简介',
      tagRecTid: 4,
      tagRecTidv2: 123,
      tagRecTnamev2: '影视杂谈',
      tagRecPidV2: 181,
      tagRecPidNameV2: '影视',
    })
    expect(card.statItems).toEqual([
      { field: 'play', value: 100 },
      { field: 'danmaku', value: 3 },
      { field: 'like', value: 5 },
    ])
  })
})
