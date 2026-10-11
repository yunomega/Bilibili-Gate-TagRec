import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addTagRecCondition,
  excludeTagRecCondition,
  newTagRecCombination,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  type TagRecCombination,
} from './combination'
import { buildSharePkgPayload, describeShareCategory, describeShareField, parseSharePkgForEdit } from './share'
import { decodeSharePkgCode, encodeSharePkgCode, type SharePkgEnvelope } from './share-pkg'

vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))

const rawCode = (env: unknown) =>
  'r.' + btoa(JSON.stringify(env)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
afterEach(() => vi.unstubAllGlobals())

describe('share package input and editing boundaries', () => {
  it('strips malformed optional envelope metadata before it reaches React', async () => {
    const decoded = await decodeSharePkgCode(
      rawCode({
        v: 1,
        sid: 1234567890,
        title: { text: 'bad React child' },
        desc: ['bad'],
        payload: { version: 2, favorites: [] },
      }),
    )
    expect(decoded).toEqual({ v: 1, payload: { version: 2, favorites: [] } })
  })

  it('does not accept an array as a configuration payload', async () => {
    expect(await decodeSharePkgCode(rawCode({ v: 1, payload: [] }))).toBeUndefined()
  })

  it('falls back to raw encoding when CompressionStream exists but rejects deflate-raw', async () => {
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new TypeError('unsupported format')
        }
      },
    )
    const env: SharePkgEnvelope = { v: 1, title: 'safe', payload: { version: 2, favorites: [] } }
    const code = await encodeSharePkgCode(env)
    expect(code.startsWith('r.')).toBe(true)
    expect(await decodeSharePkgCode(code)).toEqual(env)
  })

  it('preserves a group that has content conditions but no tag IDs when editing a share', () => {
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('up', { mid: 7, name: 'UP' }))
    const payload = {
      version: 2,
      favorites: [{ id: 'g', name: 'UP only', tag_ids: [], combination, l1Id: 'p' }],
      l1: [{ id: 'p', name: 'parent', themeId: 't' }],
      themes: [{ id: 't', name: 'theme' }],
      blacklist: [],
    }
    const edit = parseSharePkgForEdit(payload)!
    const result = buildSharePkgPayload(edit)
    expect(result.favorites).toHaveLength(1)
    expect(result.l1).toHaveLength(1)
    expect(result.themes).toHaveLength(1)
    expect((result.favorites as { combination: TagRecCombination }[])[0].combination).toEqual(combination)
  })

  it('reads positive and negative tag mirrors from the authoritative combination', () => {
    const combination = newTagRecCombination()
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 2, name: 'current' }))
    excludeTagRecCondition(combination, tagRecConditionAtom('tag', { id: 9, name: 'blocked' }))
    const edit = parseSharePkgForEdit({ favorites: [{ id: 'g', tag_ids: [{ id: 1, name: 'stale' }], combination }] })!
    expect(edit.groups[0].tagIds).toEqual([{ id: 2, name: 'current' }])
    expect(edit.groups[0].negIds).toEqual([{ id: 9, name: 'blocked' }])
  })

  it('updates tag edits in a copied condition tree without flattening matching modes or non-tag rules', () => {
    const combination = newTagRecCombination()
    combination.include.mode = 'any'
    combination.include.children.push({
      kind: 'group',
      id: 'nested',
      mode: 'all',
      children: [tagRecConditionAtom('tag', { id: 1, name: 'old' }), tagRecConditionAtom('title', 'title rule')],
    })
    addTagRecCondition(combination, tagRecConditionAtom('tag', { id: 2, name: 'kept' }))
    excludeTagRecCondition(combination, tagRecConditionAtom('tag', { id: 9, name: 'old block' }))
    excludeTagRecCondition(combination, tagRecConditionAtom('desc', 'blocked description'))
    const before = JSON.stringify(combination)
    const edit = parseSharePkgForEdit({
      version: 2,
      favorites: [
        {
          id: 'g',
          name: 'group',
          tag_ids: [
            { id: 1, name: 'old' },
            { id: 2, name: 'kept' },
          ],
          combination,
        },
      ],
    })!
    edit.groups[0].tagIds = [
      { id: 2, name: 'renamed' },
      { id: 3, name: 'new' },
    ]
    edit.groups[0].negIds = []
    const result = buildSharePkgPayload(edit)
    const updated = (result.favorites as { combination: TagRecCombination }[])[0].combination
    expect(
      tagRecConditionAtoms(updated.include)
        .filter((a) => a.field === 'tag')
        .map((a) => a.value),
    ).toEqual([
      { id: 2, name: 'renamed' },
      { id: 3, name: 'new' },
    ])
    expect(updated.include.mode).toBe('any')
    expect(updated.include.children.at(0)).toMatchObject({ kind: 'group', mode: 'all', children: [{ field: 'title' }] })
    expect(updated.exclude.map((a) => a.field)).toEqual(['desc'])
    expect(JSON.stringify(combination)).toBe(before)
  })

  it.each(['constructor', '__proto__', 'toString'])('does not render inherited lookup properties: %s', (key) => {
    expect(describeShareCategory(key)).toBe(key)
    expect(describeShareField(key, undefined)).toBe(key)
  })
})

it('saving a share without changing its conditions preserves all condition identities', () => {
  const combination = newTagRecCombination()
  addTagRecCondition(combination, tagRecConditionAtom('title', 'keep'))
  excludeTagRecCondition(combination, tagRecConditionAtom('tag', { id: 9, name: 'blocked' }))
  const edit = parseSharePkgForEdit({
    version: 2,
    favorites: [{ id: 'g', name: 'only title', tag_ids: [], combination }],
  })!
  edit.groups[0].name = 'renamed'
  const out = buildSharePkgPayload(edit)
  expect((out.favorites as { combination: TagRecCombination }[])[0].combination).toEqual(combination)
})
