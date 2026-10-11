import type { theme } from 'antd'
import type { TagRecConditionField } from '../model/combination'
import type { TagRecMaterial } from '../store/workbench-state'

type AntdToken = ReturnType<typeof theme.useToken>['token']

export type TagRecTone = { fg: string; bg: string; bd: string }

// 条件按字段分色 (antd 预设色板 token, 暗色主题随档): 标签蓝/UP绿/标题金/简介紫/分区青, 排除统一红。
// 条件卡大药丸、书架小药丸、可选条件抽屉与视频「选条件」面板共用这一套, 字段一眼可辨。
export function tagRecFieldTones(token: AntdToken) {
  const fieldTones: Record<TagRecConditionField, TagRecTone> = {
    tag: { fg: token.blue7, bg: token.blue1, bd: token.blue3 },
    up: { fg: token.green7, bg: token.green1, bd: token.green3 },
    title: { fg: token.gold7, bg: token.gold1, bd: token.gold3 },
    desc: { fg: token.purple7, bg: token.purple1, bd: token.purple3 },
    partition: { fg: token.cyan7, bg: token.cyan1, bd: token.cyan3 },
  }
  const excludeTone = { fg: token.red7, bg: token.red1, bd: token.red3 }
  const neutralTone = {
    fg: token.colorTextSecondary,
    bg: token.colorFillQuaternary,
    bd: token.colorBorderSecondary,
  }
  // 素材字段色: 排除红 > atom 字段色 > 过滤中性 > 未解析按标签蓝
  const materialTone = (material: TagRecMaterial): TagRecTone =>
    material.exclude
      ? excludeTone
      : material.atom
        ? (fieldTones[material.atom.field] ?? neutralTone)
        : material.filter
          ? neutralTone
          : fieldTones.tag
  return { fieldTones, excludeTone, neutralTone, materialTone }
}
