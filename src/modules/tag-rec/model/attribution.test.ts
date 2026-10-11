import { describe, expect, it } from 'vitest'
import {
  formatTagRecAttributionLabel,
  joinTagRecAttributionLabels,
  resolveTagRecThemeNameOfGroups,
  tagRecAttributionLabelOfGroup,
  tagRecAttributionPathOfGroup,
} from './attribution'

describe('$modules/tag-rec/model/attribution (R7 卡片归因标签)', () => {
  it('徽章展示父子组；同名父子只展示一次，主题保留到详情', () => {
    expect(formatTagRecAttributionLabel({ theme: '我心里危险的东西', l1: '山田杏奈', group: 'L2' })).toBe(
      '山田杏奈 › L2',
    )
    expect(formatTagRecAttributionLabel({ l1: '山田杏奈', group: 'L2' })).toBe('山田杏奈 › L2')
    expect(formatTagRecAttributionLabel({ l1: '综漫', group: '综漫' })).toBe('综漫')
    expect(formatTagRecAttributionLabel({ group: 'L2' })).toBe('L2') // 裸奔防御
    expect(formatTagRecAttributionLabel({ theme: 'T' })).toBeUndefined() // 只有主题无意义
    expect(formatTagRecAttributionLabel({})).toBeUndefined()
  })

  it('.labelOfGroup: 全链解析; 悬挂 l1Id/themeId 逐级回退', () => {
    const l1ById = new Map([
      ['l1a', { name: '山田杏奈', themeId: 't1' }],
      ['l1b', { name: '京太郎', themeId: 'ghost' }], // 悬挂主题
    ])
    const themeById = new Map([['t1', { name: '我心里危险的东西' }]])
    expect(tagRecAttributionLabelOfGroup({ name: 'L2', l1Id: 'l1a' }, l1ById, themeById)).toBe('山田杏奈 › L2')
    expect(tagRecAttributionLabelOfGroup({ name: 'L2', l1Id: 'l1b' }, l1ById, themeById)).toBe('京太郎 › L2')
    expect(tagRecAttributionPathOfGroup({ name: 'L2', l1Id: 'l1a' }, l1ById, themeById)).toBe(
      '我心里危险的东西 › 山田杏奈 › L2',
    )
    expect(tagRecAttributionPathOfGroup({ name: 'L2', l1Id: 'l1b' }, l1ById, themeById)).toBe('未归属 › 京太郎 › L2')
    expect(tagRecAttributionLabelOfGroup({ name: 'L2', l1Id: 'ghost' }, l1ById, themeById)).toBe('L2') // 悬挂 L1 => 组名
    expect(tagRecAttributionLabelOfGroup({ name: 'L2' }, l1ById, themeById)).toBe('L2') // 未归属 => 组名
  })

  it('多来源去重，常态只显示首条及其余数量', () => {
    expect(joinTagRecAttributionLabels(['A', 'B'])).toBe('A +1')
    expect(joinTagRecAttributionLabels(['A', 'A', 'B'])).toBe('A +1')
    expect(joinTagRecAttributionLabels(['A', 'A'], 2)).toBe('A +1') // 同名但不同真实组
    expect(joinTagRecAttributionLabels(['A', 'B', 'C'])).toBe('A +2')
    expect(joinTagRecAttributionLabels(['A', 'B', 'C', 'D'])).toBe('A +3')
    expect(joinTagRecAttributionLabels([])).toBeUndefined()
    expect(joinTagRecAttributionLabels(undefined)).toBeUndefined()
    expect(joinTagRecAttributionLabels(['', ''])).toBeUndefined()
  })

  it('R9 .resolveThemeName: 组→L1→themeId→主题表; 多认领取首个命中; 无主题 undefined', () => {
    const l1ById = new Map([
      ['l1a', { name: '银河城', themeId: 'th1' }],
      ['l1b', { name: '裸L1' }],
    ])
    const themeById = new Map([['th1', { name: '独立游戏' }]])
    const groups = [{ name: '类恶魔城', l1Id: 'l1a' }, { name: '裸组' }]
    expect(resolveTagRecThemeNameOfGroups(['类恶魔城'], groups, l1ById, themeById)).toBe('独立游戏')
    expect(resolveTagRecThemeNameOfGroups(['不存在', '类恶魔城'], groups, l1ById, themeById)).toBe('独立游戏')
    expect(resolveTagRecThemeNameOfGroups(['裸组'], groups, l1ById, themeById)).toBeUndefined()
    expect(resolveTagRecThemeNameOfGroups([], groups, l1ById, themeById)).toBeUndefined()
    expect(resolveTagRecThemeNameOfGroups(undefined, groups, l1ById, themeById)).toBeUndefined()
  })
})
