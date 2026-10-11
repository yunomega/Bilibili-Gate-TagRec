import { cloneDeep } from 'es-toolkit'
import type { TagRecItemExtend } from '$define'

/**
 * [tag-rec] 已交付内容的**有界回放池** (票 002)。
 *
 * 解决什么: 交付时条目会被消费出队 (tag-rec-custom.tsx 的 delivered/consumed), `seen` 又只存 bvid,
 *   于是「显示已看」打开后**没有内容可放**, 只能靠重新取数 (游标已越过 → 实际无效)。
 *   这里把"这个条件交付过什么"连**顺序**一起留下: 开关打开时零请求回放, 第一次什么样切回来还什么样。
 *
 * 边界:
 *   - 按**条件签名**分组 (不同条件互不串味); 超条件数上限按 LRU 淘汰最久未写的条件
 *   - 每条件有界: 超限**保留最早的那批** (首屏语义 = 第一次看到的内容; 交付顺序即档位顺序)
 *   - 存的是**深克隆快照** (审计: 交付后 enrich 改写归因、证据合并 Object.assign 都不改池内
 *     内容 —— 回放的语义就是"第一次什么样"); 回放返回新数组, 条目即池内快照
 */
export type TagRecDeliveryReplayLimits = {
  /** 最多记住多少个条件签名 */
  maxConditions: number
  /** 每个条件最多记住多少条已交付条目 */
  maxItemsPerCondition: number
}

const DEFAULT_LIMITS: TagRecDeliveryReplayLimits = { maxConditions: 12, maxItemsPerCondition: 120 }

type Slot = { items: TagRecItemExtend[]; seen: Set<string> }

export type TagRecDeliveryReplay = {
  remember: (conditionKey: string, items: readonly TagRecItemExtend[]) => void
  replay: (conditionKey: string) => TagRecItemExtend[]
  forget: (conditionKey: string) => void
  clear: () => void
  /** 已记住的条件数 (诊断/测试用) */
  size: () => number
}

export function createTagRecDeliveryReplay(limits: Partial<TagRecDeliveryReplayLimits> = {}): TagRecDeliveryReplay {
  const { maxConditions, maxItemsPerCondition } = { ...DEFAULT_LIMITS, ...limits }
  const slots = new Map<string, Slot>()

  const touch = (key: string, slot: Slot) => {
    slots.delete(key)
    slots.set(key, slot) // Map 保序 = LRU 顺序 (最久未写在前)
    while (slots.size > maxConditions) slots.delete(slots.keys().next().value!)
  }

  return {
    remember(conditionKey, items) {
      if (!conditionKey || !items.length) return
      const slot = slots.get(conditionKey) ?? { items: [], seen: new Set<string>() }
      for (const item of items) {
        const bvid = item.bvid
        if (bvid && slot.seen.has(bvid)) continue
        if (slot.items.length >= maxItemsPerCondition) break // 保最早: 满了就不再收新条
        slot.items.push(cloneDeep(item))
        if (bvid) slot.seen.add(bvid)
      }
      touch(conditionKey, slot)
    },
    replay(conditionKey) {
      const slot = slots.get(conditionKey)
      if (!slot) return []
      touch(conditionKey, slot) // 读也算访问, 免得刚切回就被淘汰
      return [...slot.items]
    },
    forget(conditionKey) {
      slots.delete(conditionKey)
    },
    clear() {
      slots.clear()
    },
    size() {
      return slots.size
    },
  }
}
