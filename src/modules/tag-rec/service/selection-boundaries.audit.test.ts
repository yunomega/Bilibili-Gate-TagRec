import { describe, expect, it } from 'vitest'
import { EApiType } from '$enums'
import { pickTagIdsForRound, TagRecUnitsDeck, unitsFingerprint } from './deck'
import { tagRecDiscoveryPolicy } from './discovery-policy'
import { previewTagRecFairSlice, rankTagRecFairSlice, TagRecFairState, trimTagRecStock } from './fair-queue'
import type { RecItemTypeOrSeparator, TagRecItemExtend } from '$define'
import type { TagGroup, TagL1Group } from '../model/types'

const parent = (id: string, enabled = true): TagL1Group => ({ id, name: id, enabled, weight: 1, addedAt: 0 })
const group = (id: string, l1Id: string): TagGroup => ({
  id,
  name: id,
  l1Id,
  enabled: true,
  weight: 1,
  addedAt: 0,
  tag_ids: [{ id: 1, name: id }],
})
const item = (bvid: string, owner = 'a'): TagRecItemExtend => ({
  api: EApiType.TagRec,
  uniqId: bvid,
  bvid,
  title: bvid,
  pic: '',
  stat: {},
  source: { via: 'tag-top', groupIds: [owner], groupNames: [owner] },
})

describe('selection boundaries and stock accounting', () => {
  it.each(['disabled', 'outside'] as const)('does not reset active piles when a %s parent child changes', (kind) => {
    const parents = [parent('A'), parent('B'), parent('X', kind !== 'disabled')]
    const groups = [group('a', 'A'), group('b', 'B'), group('x', 'X')]
    const view = kind === 'outside' ? new Set(['A', 'B']) : undefined
    const fingerprint = unitsFingerprint(groups, parents, view)
    const deck = new TagRecUnitsDeck(<T>(values: T[]) => values)
    expect(deck.drawUnits(groups, parents, 1, view).map((g) => g.id)).toEqual(['b'])
    groups[2] = { ...groups[2], weight: 5, tag_ids: [{ id: 9, name: 'changed' }] }
    expect(unitsFingerprint(groups, parents, view)).toBe(fingerprint)
    expect(deck.drawUnits(groups, parents, 1, view).map((g) => g.id)).toEqual(['a'])
    expect(
      unitsFingerprint(
        groups,
        parents.map((p) => ({ ...p, enabled: true })),
      ),
    ).not.toBe(fingerprint)
  })

  it('still invalidates the pile when an active child changes', () => {
    const a = group('a', 'A')
    expect(unitsFingerprint([a], [parent('A')])).not.toBe(unitsFingerprint([{ ...a, weight: 3 }], [parent('A')]))
  })

  it.each([NaN, Infinity, -Infinity, 0.5, -0.5])('normalizes an invalid or fractional tag cursor: %s', (cursor) => {
    const tags = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, name: `tag-${i}` }))
    const picked = pickTagIdsForRound(tags, cursor)
    expect(picked.entries).toEqual(tags.slice(0, 10))
    expect(picked.nextCursor).toBe(10)
  })

  it('enforces total capacity even for stock without a current group', () => {
    const queue: RecItemTypeOrSeparator[] = [
      item('a-1'),
      item('a-2'),
      ...Array.from({ length: 20 }, (_, i) => item(`orphan-${i}`, 'missing')),
    ]
    const removed = trimTagRecStock(queue, [group('a', 'A')], 100, 6)
    expect(queue).toHaveLength(6)
    expect(removed).toHaveLength(16)
    expect(queue).toContainEqual(item('a-1'))
    expect(queue).toContainEqual(item('a-2'))
  })

  it('counts videos rather than separators against the video stock cap', () => {
    const separator = { api: EApiType.Separator as const, uniqId: 'separator', content: 'end' }
    const queue: RecItemTypeOrSeparator[] = [item('a-1'), separator, item('a-2')]
    expect(trimTagRecStock(queue, [group('a', 'A')], 10, 2)).toEqual([])
    expect(queue).toHaveLength(3)
    expect(queue[1]).toBe(separator)
  })

  it('does not deliver a post-validation item that has no eligible group', () => {
    const raw = item('a-1')
    const preview = previewTagRecFairSlice([raw], [group('a', 'A')], [parent('A')], new TagRecFairState(), 1)
    const checked = { ...raw, eligibleGroupKeys: [] }
    expect(rankTagRecFairSlice(preview.turns, [checked]).items).toEqual([])
  })

  it('normalizes invalid discovery settings without increasing request limits', () => {
    expect(
      tagRecDiscoveryPolicy({ mode: 'fixed', autoDigMax: Infinity, lowYield: NaN, emptyTtlMinutes: -10 }),
    ).toMatchObject({ mode: 'fixed', autoDigMax: 3, lowYield: 3, emptyTtlMinutes: 5 })
    expect(tagRecDiscoveryPolicy({ autoDigMax: 1e9, lowYieldStreakLimit: 1e9 })).toMatchObject({
      autoDigMax: 20,
      lowYieldStreakLimit: 20,
    })
  })
})
