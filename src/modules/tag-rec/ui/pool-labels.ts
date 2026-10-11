import type { TagRecPoolKey } from '../model/types'

/**
 * [tag-rec] 四池中文标 (R8 中立模块 —— filter-form 与 scope-config-editor 双向引用会成环, 标签放这)
 * 与 filtercfg.js / 站页 POOL_LABELS 同口径
 */
export const TAG_REC_POOL_LABELS: Record<TagRecPoolKey, string> = {
  tagTop: 'tag/top 池',
  allV2: '搜索池 (all/v2·精确)',
  allV2Related: '搜索相关池 (all/v2·相关)',
  archiveRelated: '推荐相关池 (archive/related)',
}
export const TAG_REC_POOL_KEYS = Object.keys(TAG_REC_POOL_LABELS) as TagRecPoolKey[]
