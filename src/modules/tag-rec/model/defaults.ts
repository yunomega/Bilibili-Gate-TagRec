import { isEqual } from 'es-toolkit'
import { cloneTagRecFilterCore, createTagRecFactoryFilterCore, type TagRecFilterCore } from './filter-engine'

/** 只迁移未经定制的旧出厂淘沙档；任一其他字段改动都保留用户的显式条件。 */
export function migrateTagRecDefaultQualityGate(core: TagRecFilterCore): boolean {
  const legacy = createTagRecFactoryFilterCore()
  legacy.dims.likeRate.enabled = true
  if (!isEqual(cloneTagRecFilterCore(core), cloneTagRecFilterCore(legacy))) return false
  core.dims.likeRate.enabled = false
  return true
}
