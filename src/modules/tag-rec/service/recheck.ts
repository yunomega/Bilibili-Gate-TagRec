import { fetchArchiveRelated, fetchTagTop } from '../api/endpoints'
import { fetchUpSearchPage } from '../api/up-search'
import { normalizeAllV2Item, normalizeTagTopItem } from '../model/normalize-item'
import { tagRecGroupKey } from '../model/relevance'
import { runPhase2Round } from '../model/resolve'
import { tagRecConsumerSource, type TagRecConsumer, type TagRecRecallPlan } from './recall-plan'
import type { TagRecItemExtend } from '$define'
import type { TagRecChainKey } from '../model/filter-engine'
import type { TagRecPoolKey } from '../model/types'

export type TagRecRecheckSelection = { key: TagRecChainKey; pools: TagRecPoolKey[]; keyword?: string }
export type TagRecRecheckOption = TagRecRecheckSelection & { label: string; value: string }
export type TagRecRecheckResult = { requests: number; added: number; empty: boolean; failed: boolean; stale: boolean }

export function tagRecRecheckOptions(plan: TagRecRecallPlan): TagRecRecheckOption[] {
  const options: TagRecRecheckOption[] = []
  const add = (key: TagRecChainKey, name: string, pool: TagRecPoolKey, keyword?: string) => {
    const labels = { tagTop: '标签池', allV2: '搜索池', allV2Related: '搜索相关', archiveRelated: '推荐相关' }
    const selection = { key, pools: [pool], ...(keyword ? { keyword } : {}) }
    options.push({
      ...selection,
      value: JSON.stringify(selection),
      label: `${name || '本次输入'} · ${labels[pool]}${keyword ? ' · ' + keyword : ''}`,
    })
  }
  for (const s of plan.tagTop) for (const c of s.consumers) add(c.key, c.name, 'tagTop')
  for (const s of plan.up) for (const c of s.consumers ?? []) add(c.key, c.name, 'allV2', s.keyword)
  for (const s of plan.dig) {
    for (const c of s.exactConsumers) add(c.key, c.name, 'allV2', s.keyword)
    for (const c of s.relatedConsumers) add(c.key, c.name, 'allV2Related', s.keyword)
  }
  for (const c of plan.archiveConsumers) add(c.key, c.name, 'archiveRelated')
  return [...new Map(options.map((option) => [option.value, option])).values()]
}

/** 正常续页和首屏探测分开；单次至多4个请求身份、每词1页，不写普通游标。 */
export class TagRecRecheckExecutor {
  private running = new Map<string, Promise<TagRecRecheckResult>>()
  run(
    identity: string,
    options: {
      plan: TagRecRecallPlan
      seeds?: readonly TagRecItemExtend[]
      current: () => boolean
      accept: (items: TagRecItemExtend[]) => number
      onStart?: () => void
      noteSearch?: (key: string, keyword: string, empty: boolean | undefined) => void
      mergeCorpus?: (key: string, result: Awaited<ReturnType<typeof runPhase2Round>>) => void
      signal?: AbortSignal
    },
  ): Promise<TagRecRecheckResult> {
    const existing = this.running.get(identity)
    if (existing) return existing
    options.onStart?.()
    const promise = this.execute(options).finally(() => {
      if (this.running.get(identity) === promise) this.running.delete(identity)
    })
    this.running.set(identity, promise)
    return promise
  }
  private async execute(options: Parameters<TagRecRecheckExecutor['run']>[1]): Promise<TagRecRecheckResult> {
    const { plan, signal } = options
    const result: TagRecRecheckResult = { requests: 0, added: 0, empty: true, failed: false, stale: false }
    const current = () => !signal?.aborted && options.current()
    const requests: (() => Promise<TagRecItemExtend[]>)[] = []
    for (const source of plan.tagTop)
      requests.push(async () =>
        (await fetchTagTop(source.tid, { signal })).map((raw, srcRank) => {
          const item = normalizeTagTopItem(raw, { ...tagRecConsumerSource(source.consumers), srcRank })
          // Keep the recalled tag id on the top-level source too, not only on the claims:
          // the combination tag atom reads source.tagIds, and omitting it staged every
          // rechecked item as unknown (0 delivered after a scoped recheck).
          item.source.tagIds = [source.tid]
          item.source.claims = source.consumers.map((c) => ({
            ...tagRecConsumerSource([c]),
            via: 'tag-top',
            tagIds: [source.tid],
            queryKeyword: c.queryKeyword ?? source.keyword,
          }))
          return item
        }),
      )
    for (const source of plan.up)
      requests.push(async () =>
        // fresh: 定向重查就是要拿新数据 —— 绕过完成页缓存直接打网络 (在途档仍合并)
        (await fetchUpSearchPage(source.mid, source.keyword, 1, signal, { fresh: true })).items.map((raw, srcRank) => {
          const item = normalizeTagTopItem(raw, { ...tagRecConsumerSource(source.consumers ?? []), srcRank })
          item.source.via = 'up-search'
          item.source.queryKeyword = source.keyword
          item.source.input = source.input
          item.source.claims = source.consumers?.map((c) => ({
            ...tagRecConsumerSource([c]),
            via: 'up-search',
            queryKeyword: source.keyword,
          }))
          return item
        }),
      )
    for (const source of plan.dig)
      requests.push(async () => {
        const res = await runPhase2Round({
          keyword: source.keyword,
          inputNorm: source.key,
          matchNorms: source.crossNorms,
          fromPage: 1,
          pageCount: 1,
          signal,
          withSuggest: false,
          resolveVariants: false,
        })
        if (res.allPagesFailed) {
          if (current()) options.noteSearch?.(source.key, source.keyword, undefined)
          throw new Error('首屏重查失败')
        }
        if (!current()) return []
        // Q4-C: 组合词源语料同主路径 —— 归并各成员真实锚点, 组合键不落谱
        if (source.crossNorms) for (const n of source.crossNorms) options.mergeCorpus?.(n, res)
        else options.mergeCorpus?.(source.key, res)
        options.noteSearch?.(source.key, source.keyword, res.videos.length === 0)
        if (res.videos.length) result.empty = false
        return (
          [
            ['all-v2-exact', res.analysis.exact, source.exactConsumers],
            ['all-v2-related', res.analysis.related, source.relatedConsumers],
          ] as const
        )
          .flatMap(([via, raws, consumers]) =>
            raws.map((raw, srcRank) => {
              const item = normalizeAllV2Item(raw, { ...tagRecConsumerSource(consumers), via, srcRank })
              item.source.claims = consumers.map((c) => ({
                ...tagRecConsumerSource([c]),
                via,
                queryKeyword: source.keyword,
              }))
              return item
            }),
          )
          .filter((item) => item.source.claims?.length)
      })
    for (const seed of (options.seeds ?? []).slice(0, 3)) {
      const claims = seed.activeSourceClaims ?? seed.source.claims ?? [seed.source]
      const matchClaim = (c: TagRecConsumer) =>
        claims.find((claim) =>
          typeof c.key === 'object' && c.key?.id
            ? claim.groupIds?.includes(c.key.id)
            : tagRecGroupKey(c.key) === tagRecGroupKey(claim.input ? undefined : claim.groupNames[0]),
        )
      const allowed = plan.archiveConsumers.filter((c) => matchClaim(c) !== undefined)
      if (!allowed.length) continue
      requests.push(async () =>
        (await fetchArchiveRelated(seed.bvid, { signal })).map((raw, srcRank) => {
          const item = normalizeTagTopItem(raw, { ...tagRecConsumerSource(allowed), via: 'archive-related', srcRank })
          // 衍生条继承种子命中词: 徽标显示标签名而非组占位名; tagIds 照 normalizeArchiveRelated
          //   一并下传 —— 旧语境判定靠归因认「只因被删原子召回」的残留, eval 借不到 (via 闸)
          item.source.claims = allowed.map((c) => {
            const seed = matchClaim(c)
            return {
              ...tagRecConsumerSource([c]),
              via: 'archive-related' as const,
              queryKeyword: seed?.queryKeyword,
              ...(seed?.tagIds?.length ? { tagIds: seed.tagIds } : {}),
            }
          })
          item.source.queryKeyword = allowed.map((c) => matchClaim(c)?.queryKeyword).find(Boolean)
          return item
        }),
      )
    }
    for (const request of requests.slice(0, 4)) {
      if (!current()) {
        result.stale = true
        break
      }
      result.requests++
      try {
        const items = await request()
        if (!current()) {
          result.stale = true
          break
        }
        if (items.length) result.empty = false
        result.added += options.accept(items)
      } catch {
        if (!current()) {
          result.stale = true
          break
        }
        result.failed = true
        result.empty = false // 失败不能证明物理源为空。
      }
    }
    return result
  }
}
