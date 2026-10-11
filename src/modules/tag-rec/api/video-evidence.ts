import { fetchVideoDetail } from './endpoints'
import { SessionFetchCache } from './session-fetch-cache'
import {
  getCachedTagRecVideoEvidence,
  rememberTagRecVideoEvidence,
  type TagRecVideoEvidence,
} from './video-evidence-store'
import type { TagRecItemExtend } from '$define'

export { getCachedTagRecVideoEvidence } from './video-evidence-store'
export type { TagRecVideoEvidence } from './video-evidence-store'

const cache = new SessionFetchCache<string, TagRecVideoEvidence | undefined>({
  dedupeMs: 15_000,
  maxAgeMs: 0,
  maxEntries: 2_000,
  isCacheable: () => false,
})
/** A single bounded detail request supplies every missing content field; an absent description is still unknown. */
export function fetchTagRecVideoEvidence(bvid: string, signal?: AbortSignal): Promise<TagRecVideoEvidence | undefined> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const cached = getCachedTagRecVideoEvidence(bvid)
  if (cached) return Promise.resolve(cached)
  return cache.fetch(
    bvid,
    async (entrySignal) => {
      // 与分区核验共享同一条 /view/detail 在途 (审计 §8-1): 并发补查同一 BV 不再双发整包;
      //   最后一个等待者离开时 entrySignal 取消排队/在途取数, 共享期间互不传染
      const data = await fetchVideoDetail(bvid, entrySignal)
      if (!data) return
      return rememberTagRecVideoEvidence(bvid, data)
    },
    signal,
  )
}
export function mergeTagRecVideoEvidence(item: TagRecItemExtend, fields?: TagRecVideoEvidence): TagRecItemExtend {
  if (!fields) return item
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  const evidence = { ...item.fieldEvidence }
  for (const field of ['title', 'desc'] as const) {
    const state = fields.fieldEvidence?.[field]
    // A response omitting a field cannot erase stronger evidence already on the card.
    if (state && (state !== 'missing' || evidence[field] === undefined)) evidence[field] = state
  }
  return { ...item, ...present, fieldEvidence: evidence }
}
