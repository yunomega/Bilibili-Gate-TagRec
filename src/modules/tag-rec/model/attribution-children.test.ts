import { proxy } from 'valtio/vanilla'
import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { createTagRecAttributionEnricher, joinTagRecAttributionLabels } from './attribution'
import { addTagRecCondition, newTagRecCombination, tagRecConditionAtom } from './combination'
import type { TagRecItemExtend } from '$define'

const groups = [
  {
    id: 'A',
    name: '恐怖收集者',
    l1Id: 'L1',
    tag_ids: [
      { id: 1, name: '恐怖' },
      { id: 2, name: '怪谈' },
      { id: 3, name: '惊悚' },
    ],
  },
  { id: 'B', name: '游戏', l1Id: 'L1', tag_ids: [{ id: 4, name: 'Minecraft' }] },
]
const l1s = [{ id: 'L1', name: '兴趣', themeId: 'T' }]
const themes = [{ id: 'T', name: '主题' }]
const video = (source: Partial<TagRecItemExtend['source']> = {}, ownTagNames?: string[]): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: 'tag-rec:BV-badge',
  bvid: 'BV-badge',
  title: '测试视频',
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupNames: ['恐怖收集者'], groupIds: ['A'], ...source },
  ownTagNames,
})

describe('归因勋章子标签', () => {
  it('只展示实际召回子标签，常态收起同组其他命中，详情列全', () => {
    const item = video({ tagIds: [2, 1] })
    createTagRecAttributionEnricher(groups, l1s, themes)(item)
    expect(item.source.attributionLabels).toEqual(['兴趣 › 恐怖收集者 › 恐怖 等2个标签'])
    expect(item.source.attributionPaths).toEqual(['主题 › 兴趣 › 恐怖收集者 › 恐怖、怪谈'])
    expect(item.source.attributionPaths?.[0]).not.toContain('惊悚')
  })

  it('多组分别匹配各自子标签，勋章 +N 仍表示其余来源组', () => {
    const item = video({ groupNames: ['恐怖收集者', '游戏'], groupIds: ['A', 'B'], tagIds: [2, 4] })
    createTagRecAttributionEnricher(groups, l1s, themes)(item)
    expect(item.source.attributionLabels).toEqual(['兴趣 › 恐怖收集者 › 怪谈', '兴趣 › 游戏 › Minecraft'])
    expect(joinTagRecAttributionLabels(item.source.attributionLabels, item.source.groupIds?.length)).toBe(
      '兴趣 › 恐怖收集者 › 怪谈 +1',
    )
  })

  it('搜索源只展示视频自报名单内的组成员，字形归一且去重', () => {
    const item = video({ via: 'all-v2-exact', groupNames: ['游戏'], groupIds: ['B'] }, [
      'ＭＩＮＥＣＲＡＦＴ',
      '其他',
      'minecraft',
    ])
    createTagRecAttributionEnricher(groups, l1s)(item)
    expect(item.source.attributionLabels).toEqual(['兴趣 › 游戏 › Minecraft'])
    expect(item.source.attributionPaths).toEqual(['兴趣 › 游戏 › Minecraft'])
  })

  it('工作台组入表后按 ownTagNames 命中组合标签, 徽标只给标签不带占位组名', () => {
    const working = {
      id: '__tagrec_working__',
      name: '新试验',
      tag_ids: [
        { id: 1, name: '清霄' },
        { id: 2, name: '原神' },
      ],
    }
    const item = video(
      {
        via: 'archive-related',
        groupNames: ['新试验·相关'],
        groupIds: ['__tagrec_working__'],
        claims: [
          { via: 'archive-related', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '清霄' },
        ],
      },
      ['清霄', '原神', '无关词'],
    )
    createTagRecAttributionEnricher([...groups, working], l1s)(item)
    // 工作副本组: 徽标只出命中标签 (无「L1 › 组」前缀); 详情路径以试验名打头
    expect(item.source.attributionLabels).toEqual(['清霄 等2个标签'])
    expect(item.source.attributionPaths).toEqual(['新试验 › 清霄、原神'])
    // 无命中时回落组名 (已随试验显示名同步), 不再拼占位后缀
    const bare = video({ via: 'archive-related', groupNames: ['新试验·相关'], groupIds: ['__tagrec_working__'] }, [
      '别的',
    ])
    createTagRecAttributionEnricher([...groups, working], l1s)(bare)
    expect(bare.source.attributionLabels).toEqual(['新试验'])
  })

  it('相关视频不继承种子的子标签，没有命中证据的旧条目只显示组名', () => {
    for (const item of [video({ via: 'archive-related', tagIds: [1] }), video()]) {
      createTagRecAttributionEnricher(groups, l1s, themes)(item)
      expect(item.source.attributionLabels).toEqual(['兴趣 › 恐怖收集者'])
      expect(item.source.attributionPaths).toEqual(['主题 › 兴趣 › 恐怖收集者'])
    }
  })

  it('稳定编号优先；编号缺失或已删除时不按同名组猜测子标签', () => {
    for (const groupIds of [undefined, ['deleted']]) {
      const item = video({ groupIds, tagIds: [1] })
      createTagRecAttributionEnricher(groups, l1s)(item)
      expect(item.source.attributionLabels).toBeUndefined()
    }
  })

  it('同名不同组仍能在详情区分，重复来源及重复标签名不会多算', () => {
    const twins = ['first-id', 'second-id'].map((id) => ({
      id,
      name: '同名组',
      tag_ids: [
        { id: 1, name: '恐怖' },
        { id: 2, name: '恐怖' },
      ],
    }))
    const item = video({ groupNames: ['同名组'], groupIds: ['first-id', 'second-id', 'first-id'], tagIds: [1, 2] })
    createTagRecAttributionEnricher(twins, [])(item)
    expect(item.source.attributionLabels).toEqual(['同名组 › 恐怖', '同名组 › 恐怖'])
    expect(item.source.attributionPaths).toEqual(['同名组 (#first-) › 恐怖', '同名组 (#second) › 恐怖'])
    expect(joinTagRecAttributionLabels(item.source.attributionLabels, 2)).toBe('同名组 › 恐怖 +1')
  })

  it('收藏表用快照读取；下一页采用改名和删改后的成员', () => {
    const state = proxy({ groups: groups.map((g) => ({ ...g, tag_ids: [...g.tag_ids] })) })
    const first = video({ tagIds: [1] })
    createTagRecAttributionEnricher(state.groups, l1s)(first)
    state.groups[0]!.name = '改名'
    state.groups[0]!.tag_ids.splice(0, 1)
    const next = video({ tagIds: [1] })
    createTagRecAttributionEnricher(state.groups, l1s)(next)
    expect(first.source.attributionLabels).toEqual(['兴趣 › 恐怖收集者 › 恐怖'])
    expect(next.source.attributionLabels).toEqual(['兴趣 › 改名'])
  })

  const workingGroup = (...names: string[]) => {
    const combination = newTagRecCombination()
    names.forEach((name, i) => addTagRecCondition(combination, tagRecConditionAtom('tag', { id: i + 1, name })))
    return {
      id: '__tagrec_working__',
      name: '新试验',
      tag_ids: names.map((name, i) => ({ id: i + 1, name })),
      combination,
    }
  }

  it('组合组展示词按当前配方重算: 删掉的条件词不再上徽标, 保留词原样下传', () => {
    const working = workingGroup('清宵', '心月狐')
    const stale = video(
      {
        via: 'archive-related',
        groupNames: ['新试验·相关'],
        groupIds: ['__tagrec_working__'],
        queryKeyword: '鸣潮',
        claims: [
          { via: 'archive-related', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '鸣潮' },
        ],
      },
      ['清宵', '别的'],
    )
    createTagRecAttributionEnricher([...groups, working], l1s)(stale)
    expect(stale.source.attributionKeywords).toEqual([])
    expect(stale.source.attributionLabels).toEqual(['清宵'])

    const live = video(
      {
        via: 'all-v2-related',
        groupNames: ['新试验·相关'],
        groupIds: ['__tagrec_working__'],
        queryKeyword: '清宵',
        claims: [
          { via: 'all-v2-related', groupNames: ['新试验'], groupIds: ['__tagrec_working__'], queryKeyword: '清宵' },
        ],
      },
      ['清宵'],
    )
    createTagRecAttributionEnricher([...groups, working], l1s)(live)
    expect(live.source.attributionKeywords).toEqual(['清宵'])
  })

  it('旧 tag/top 召回 id 不属于当前配方时回落自身名单 (命中标签不再被卡死)', () => {
    const working = workingGroup('清宵')
    const item = video(
      {
        via: 'tag-top',
        groupNames: ['新试验'],
        groupIds: ['__tagrec_working__'],
        tagIds: [99],
        claims: [
          {
            via: 'tag-top',
            groupNames: ['新试验'],
            groupIds: ['__tagrec_working__'],
            tagIds: [99],
            queryKeyword: '鸣潮',
          },
        ],
      },
      ['清宵'],
    )
    createTagRecAttributionEnricher([working], l1s)(item)
    expect(item.source.attributionLabels).toEqual(['清宵'])
    expect(item.source.attributionKeywords).toEqual([])
  })
})
