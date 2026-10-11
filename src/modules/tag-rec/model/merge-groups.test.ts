import { describe, expect, it } from 'vitest'
import { makeTagGroup } from './favorites'
import { mergeTagGroups, mergeTagRecGroupOverrides } from './merge-groups'

describe('group merge contract', () => {
  it('fills missing dimensions and cell fields while preserving false, zero, and target allow rules', () => {
    const target = {
      dims: { viewMin: { enabled: false, value: 0 } },
      score: { weights: { view: 0 } },
      smallPoolThreshold: 0,
      poolsEnabled: { tagTop: false },
      pools: { allV2: { dims: { viewMin: { enabled: false, value: 0 } } } },
      negative: { strict: false, title: ['advert'], upAllow: { enabled: false, list: [{ name: 'A' }] } },
    }
    const source = {
      dims: { viewMin: { enabled: true, value: 100 }, pubdate: { enabled: true, win: 'd7' as const } },
      score: { weights: { view: 5, likeRate: 2 } },
      smallPoolThreshold: 30,
      poolsEnabled: { tagTop: true, allV2: false },
      pools: { allV2: { dims: { duration: { enabled: true, min: 10, max: 60 } } } },
      negative: { strict: true, title: ['spoiler'], upAllow: { enabled: true, list: [{ name: 'B' }] } },
    }
    const snapshot = structuredClone(target)
    const result = mergeTagRecGroupOverrides(target, source)!
    expect(result.dims).toEqual({ viewMin: target.dims.viewMin, pubdate: source.dims.pubdate })
    expect(result.score?.weights).toEqual({ view: 0, likeRate: 2 })
    expect(result.smallPoolThreshold).toBe(0)
    expect(result.poolsEnabled).toEqual({ tagTop: false, allV2: false })
    expect(result.pools?.allV2?.dims).toEqual({ ...source.pools.allV2.dims, ...target.pools.allV2.dims })
    expect(result.negative?.title).toEqual(['advert', 'spoiler'])
    expect(result.negative?.strict).toBe(false)
    expect(result.negative?.upAllow).toEqual(target.negative.upAllow)
    expect(target).toEqual(snapshot)
  })

  it('batch result is order-independent, retains target ownership, and keeps positive members mutually exclusive', () => {
    const target = makeTagGroup({
      id: 'target',
      l1Id: 'parent',
      name: 'Target',
      addedAt: 1,
      tag_ids: [{ id: 1, name: 'one' }],
    })!
    const a = makeTagGroup({
      id: 'a',
      l1Id: 'other',
      addedAt: 2,
      tag_ids: [{ id: 2, name: 'two' }],
      overrides: {
        negative: {
          tagIds: [
            { id: 1, name: 'one' },
            { id: 99, name: 'blocked' },
          ],
          strict: true,
        },
      },
    })!
    const b = makeTagGroup({ id: 'b', addedAt: 3, tag_ids: [{ id: 99, name: 'blocked' }] })!
    const merged = mergeTagGroups(target, [b, a])
    expect(merged).toEqual(mergeTagGroups(target, [a, b]))
    expect(merged.l1Id).toBe('parent')
    expect(merged.tag_ids.map((e) => e.id)).toEqual([1, 2, 99])
    expect(merged.overrides?.negative?.tagIds).toEqual([])
    expect(merged.overrides?.negative?.strict).toBe(true)
    expect(target.tag_ids.map((e) => e.id)).toEqual([1])
  })
})
