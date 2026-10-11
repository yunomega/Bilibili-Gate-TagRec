import { useEffect, useRef } from 'react'
import { useOnInView } from 'react-intersection-observer'
import { useSnapshot } from 'valtio'
import { checkIsTagRec, type RecItemType } from '$define'
import { isTagRecSeenTab } from '../model/seen'
import { seen } from '../store'
import { tagRecSharedSession } from '../store/session'
import type { ETab } from '$enums'

/**
 * [tag-rec] 已看标记 hook (spec §4.5) —— VideoCard/index.tsx 注册行专用
 * - 仅 tab∈{TagRecFav,TagRecCustom} 生效 (其它 tab skip 早退, 不挂 observer)
 * - useOnInView({threshold:0.5}) ≥50% 进视口即 seen.add(bvid)，不触发卡片重渲染
 * - triggerOnce: 入过视口的卡片不再重复观察
 * - 被过滤/被拉黑剔除的条目不渲染 => 不计已看 (§4.5)
 * @returns observer ref, 挂到卡片根元素
 */
export function useTagRecSeen(item: RecItemType | undefined, tab: ETab) {
  const { scopeEditing } = useSnapshot(tagRecSharedSession)
  const enabled = isTagRecSeenTab(tab)
  const bvid = item && checkIsTagRec(item) ? item.bvid : undefined
  const visibleBvid = useRef<string | undefined>(undefined)
  const ref = useOnInView(
    (inView) => {
      if (!inView || !enabled || !bvid) return
      visibleBvid.current = bvid
      if (!tagRecSharedSession.scopeEditing) seen.add(bvid)
    },
    { threshold: 0.5, triggerOnce: true, skip: !enabled || !bvid },
  )
  useEffect(() => {
    // 挑选范围时入过视口的卡片，关闭面板后仍补记；triggerOnce 已解除观察。
    if (enabled && bvid && visibleBvid.current === bvid && !scopeEditing) seen.add(bvid)
  }, [enabled, bvid, scopeEditing])
  return ref
}
