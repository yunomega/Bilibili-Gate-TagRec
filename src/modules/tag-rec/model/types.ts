/**
 * [tag-rec] 自有 schema (spec §3.1 / §3.2)
 * `TagRecItemExtend` 已进 `src/define/index.ts` (spec §3.7)
 */

import type { TagRecCombination } from './combination'
import type { TagRecGroupOverrides, TagRecL1Overrides } from './filter-engine'

export type TagIdEntry = {
  id: number
  name: string
  tag_type?: 'topic' | 'old_channel' | 'bgm'
}

/** 来源池键 (via→池归并: tag-top→tagTop, all-v2-exact→allV2, all-v2-related→allV2Related, archive-related→archiveRelated) */
export type TagRecPoolKey = 'tagTop' | 'allV2' | 'allV2Related' | 'archiveRelated'

/** 分区名单条目 (filter-scope 票03): 双体系 id 由显示名解析、允许单边空; 匹配按 id 不按名 */
export type TagRecPartitionEntry = {
  name: string // 录入时显示名快照 (UI 展示)
  v1?: number // v1 体系 id (tid: 主分区或叶)
  v2?: number // v2 体系 id (pid_v2 一级 或 tidv2 叶)
  level?: 'parent' | 'leaf'
}

/**
 * 组级负向规则容器 (filter-scope 票02/03): 名单沿「会话 > L2 > L1 > 全局」链叠加,
 * 任一否决即死; 多归属条目任一认领组放行即活 (票01)。
 * 存量顶层字段 negative_tag_ids/negative_strict 迁入 tagIds/strict(导入/迁移期只读别名)。
 */
export type TagRecNegativeRules = {
  tagIds?: TagIdEntry[] // tag_id 键: 原组内负向成员 (ownTagNames 名归一 + 负向池 bvid 交集)
  strict?: boolean // 严格校验开关 (原 negative_strict; 键存在=override)
  tagBlock?: TagRecTagListRule // 自定义标签屏蔽, 独立于原组内负向成员
  tagAllow?: TagRecTagListRule // 自定义标签仅看, 链上最近的启用非空名单生效
  up?: { name: string; mid?: number }[] // UP 主屏蔽名单 (mid 主判, name 归一等值兜底)
  title?: string[] // 标题屏蔽词 (归一化子串, ≥2 字符, 命中即滤)
  desc?: string[] // 简介屏蔽词 —— 仅 all-v2-exact/all-v2-related/archive-related 池判定
  partitionBlock?: TagRecPartitionEntry[] // 分区屏蔽池: 命中即滤 (常效, 无开关)
  partitionAllow?: { enabled: boolean; list: TagRecPartitionEntry[] } // 分区仅看池: 独立开关默认关 (防误杀); 开=本组流量只剩命中分区
  // R8 仅看家族 (域收窄; 同分区先例: 就近覆盖, 与同实体屏蔽池同存时屏蔽先判赢)
  upAllow?: { enabled: boolean; list: { name: string; mid?: number }[] } // 仅看 UP 主
  titleAllow?: { enabled: boolean; list: string[] } // 仅看标题词
  descAllow?: { enabled: boolean; list: string[] } // 仅看简介词
  /** @deprecated 旧形单列表+mode; 读取侧 groupNegativeMerged 兼容折叠, 新写一律双池键 */
  partition?: { mode: 'block' | 'allow'; list: TagRecPartitionEntry[] }
}

export type TagRecTagListRule = { enabled: boolean; list: TagIdEntry[]; strict?: boolean }

/** 收藏表表项 = 二级标签组；空组保留配置，添加正向标签后才有查询资格。 */
export type TagGroup = {
  id: string // 收藏项自身 key(合并/黑名单引用用)
  name: string // 显示名, 可改
  l1Id?: string // 所属一级组 id (票 17 层级: 单父; addGroup 缺省自动套新 L1, 旧组一次性迁移补齐)
  tag_ids: TagIdEntry[] // 正向变体: id+name 快照, 渲染零二次调用
  combination?: TagRecCombination // 完整条件；tag_ids 为正向标签的兼容投影，不承担试验身份
  negative_tag_ids?: TagIdEntry[] // 负向成员 (票 14) —— 已迁 overrides.negative.tagIds, 顶层位仅作导入/迁移期只读别名
  negative_strict?: boolean // 同上 —— 迁 overrides.negative.strict, 顶层只读别名
  overrides?: TagRecGroupOverrides // 组级配置 (filter-scope: dims/score/格池槽 + negative 名单容器)
  weight: number // 0~5, 默认 1; 0=挂起(不入抽、仅 tab2 手动可选)
  enabled: boolean // false=停用(tab1 不抽、tab2 不可选、面板置灰)
  note?: string
  addedAt: number
}

/**
 * 一级组 = 二级组的容器 (票 17): tab1 唯一抽签单位; enabled 是麾下整棵子树的批量开关
 * 永不持 tag_ids; 可持负向规则容器 —— 麾下 L2 eval 时沿 l1Id 上溯继承 (filter-scope 票01/02)
 */
export type TagL1Group = {
  id: string
  name: string
  themeId?: string // 所属主题 id (票 26: 单父归属, 与 L2.l1Id 同款; 未归属只在「全部」档出现)
  enabled: boolean
  weight: number // 0~5 牌堆张数, 语义同 TagGroup.weight
  overrides?: TagRecL1Overrides // 一级组配置: 麾下组链上继承 (无 pools —— 格 = L2×池)
  note?: string
  addedAt: number
}

/**
 * 主题 = 一级组的归属标签 (票 26): 过滤筛子不是容器 —— 无 weight/enabled/tag 字段;
 * tab1 tabbar 选中主题 => deck 入堆资格外加 `l1.themeId===当前主题` (零写入, 不改 L1 enabled)
 */
export type TagTheme = {
  id: string
  name: string
  addedAt: number
}

/** 旧全局黑名单条目 (票 14 起休眠: schema/store 保留, 管线不读, 仅供「导入旧黑名单到组」) */
export type TagBlacklistEntry = {
  id: number
  name: string // name 为展示快照
}
