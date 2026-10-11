import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagGroup } from '../model/types'

// temp-writes -> store/session -> api/backoff; model/block-write 纯; $modules/settings 以出厂 core mock
// (同 tag-rec-custom.dry.test.ts 手法)
vi.mock('$common', () => ({ appWarn: vi.fn() }))
vi.mock('../api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))
vi.mock('$modules/bilibili/user/nickname', () => ({ setNicknameCache: vi.fn() }))
vi.mock('$modules/settings', async () => {
  const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
  return {
    settings: {
      tagRec: { filter: createTagRecFactoryFilterCore() },
      filter: { byAuthor: { enabled: false, keywords: [] }, byTitle: { enabled: false, keywords: [] } },
    },
    updateSettings: vi.fn(),
    updateSettingsInnerArray: vi.fn(),
    getNewestValueOfSettingsInnerArray: vi.fn(() => Promise.resolve([])),
  }
})

const gmKv = new Map<string, unknown>()
vi.stubGlobal('GM', {
  getValue: vi.fn((key: string, dflt?: unknown) => Promise.resolve(gmKv.has(key) ? gmKv.get(key) : dflt)),
  setValue: vi.fn((key: string, val: unknown) => Promise.resolve(void gmKv.set(key, val))),
  deleteValue: vi.fn((key: string) => Promise.resolve(void gmKv.delete(key))),
  xmlHttpRequest: vi.fn(),
})

const toast = (await import('$utility/toast')).default
const { settings, getNewestValueOfSettingsInnerArray } = await import('$modules/settings')
const { favorites } = await import('../store')
const { tagRecCustomSession, tagRecFavSession } = await import('../store/session')
const { createTagRecFactoryFilterCore } = await import('../model/filter-engine')
const {
  canKeepTempEntryToGlobal,
  clearTagRecTempWrites,
  keepTagRecTempEntryToGlobal,
  keepTagRecTempEntryToGroup,
  removeTagRecTempWriteAt,
  writeTagRecTempEntry,
} = await import('./temp-writes')

const makeGroup = (id: string, name = id): TagGroup => ({
  id,
  name,
  tag_ids: [{ id: 1, name: 'x' }],
  weight: 1,
  enabled: true,
  addedAt: 0,
})

beforeEach(() => {
  Object.assign(settings.tagRec.filter, createTagRecFactoryFilterCore())
  tagRecCustomSession.filterOverride = undefined
  tagRecCustomSession.tempWriteLog.length = 0
  tagRecFavSession.filterOverride = undefined
  tagRecFavSession.tempWriteLog.length = 0
  favorites.list.splice(0)
  vi.clearAllMocks()
})

describe('R8 临时写位 (writeTagRecTempEntry)', () => {
  it('主题推荐和标签发掘的右键临时名单、清空与固化互不影响', () => {
    favorites.list.push(makeGroup('G'))
    writeTagRecTempEntry({ scope: 'fav', kind: 'titleBlock', value: '主题广告', label: 'fav', owningGroupNames: ['G'] })
    writeTagRecTempEntry({ kind: 'titleAllow', value: '发掘关键词', label: 'custom', owningGroupNames: [] })
    expect(tagRecFavSession.filterOverride?.dims.titleKeywords?.list).toEqual(['主题广告'])
    expect(tagRecCustomSession.filterOverride?.dims.titleAllow?.list).toEqual(['发掘关键词'])
    keepTagRecTempEntryToGroup(0, 'fav')
    expect(favorites.list[0].overrides?.negative?.title).toEqual(['主题广告'])
    expect(tagRecFavSession.filterOverride).toBeUndefined()
    expect(tagRecFavSession.tempWriteLog).toEqual([])
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    clearTagRecTempWrites()
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
  })

  it('新临时仅看不携带全局仅看；移除最后一条恢复继承', () => {
    settings.tagRec.filter.dims.titleAllow = { enabled: true, list: ['全局仅看'] }
    writeTagRecTempEntry({ scope: 'fav', kind: 'titleAllow', value: '临时仅看', label: 'l', owningGroupNames: [] })
    expect(tagRecFavSession.filterOverride?.dims.titleAllow?.list).toEqual(['临时仅看'])
    removeTagRecTempWriteAt(0, 'fav')
    expect(tagRecFavSession.filterOverride).toBeUndefined()
    expect(settings.tagRec.filter.dims.titleAllow.list).toEqual(['全局仅看'])
  })

  it('屏蔽追加保留已启用的全局名单，关闭的旧名单不复活；重复不创建覆盖', () => {
    settings.tagRec.filter.dims.titleKeywords = { enabled: true, list: ['已有广告'] }
    expect(writeTagRecTempEntry({ kind: 'titleBlock', value: '已有广告', label: 'l', owningGroupNames: [] })).toBe(
      'dup',
    )
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    writeTagRecTempEntry({ kind: 'titleBlock', value: '新广告', label: 'l', owningGroupNames: [] })
    expect(tagRecCustomSession.filterOverride?.dims.titleKeywords?.list).toEqual(['已有广告', '新广告'])
    clearTagRecTempWrites()
    expect(tagRecCustomSession.filterOverride).toBeUndefined()
    settings.tagRec.filter.dims.titleKeywords.enabled = false
    writeTagRecTempEntry({ kind: 'titleBlock', value: '临时广告', label: 'l', owningGroupNames: [] })
    expect(tagRecCustomSession.filterOverride?.dims.titleKeywords?.list).toEqual(['临时广告'])
  })

  it('只创建当前修改的维度，不复制全局；写 dims + 开闸 + 记账；重复不重复记账', () => {
    const r1 = writeTagRecTempEntry({
      kind: 'upBlock',
      value: { name: 'UP甲' },
      label: '屏蔽 UP: UP甲',
      owningGroupNames: ['G'],
    })
    expect(r1).toBe('ok')
    const ov = tagRecCustomSession.filterOverride!
    expect(Object.keys(ov)).toEqual(['dims'])
    expect(Object.keys(ov.dims)).toEqual(['upBlacklist'])
    expect(ov.dims.upBlacklist!.list).toEqual([{ name: 'UP甲' }])
    expect(ov.dims.upBlacklist!.enabled).toBe(true)
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    expect(tagRecCustomSession.tempWriteLog[0].owningGroupNames).toEqual(['G'])
    expect(writeTagRecTempEntry({ kind: 'upBlock', value: { name: 'UP甲' }, label: 'x', owningGroupNames: [] })).toBe(
      'dup',
    )
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    expect(settings.tagRec.filter.dims.upBlacklist.list).toEqual([]) // 全局零污染
  })

  it('仅看家族 write: upAllow/titleAllow/descAllow ({enabled,list} 形 + 词表)', () => {
    writeTagRecTempEntry({ kind: 'upAllow', value: { name: 'UP乙', mid: 7 }, label: 'l', owningGroupNames: [] })
    writeTagRecTempEntry({ kind: 'titleAllow', value: '实况', label: 'l', owningGroupNames: [] })
    writeTagRecTempEntry({ kind: 'descAllow', value: '预约', label: 'l', owningGroupNames: [] })
    const ov = tagRecCustomSession.filterOverride!
    expect(ov.dims.upAllow).toEqual({ enabled: true, list: [{ name: 'UP乙', mid: 7 }] })
    expect(ov.dims.titleAllow).toEqual({ enabled: true, list: ['实况'] })
    expect(ov.dims.descAllow).toEqual({ enabled: true, list: ['预约'] })
  })

  it('分区双池 write: partitionBlock 裸数组池 / partitionAllow {enabled,list} 入池即开', () => {
    writeTagRecTempEntry({ kind: 'partitionBlock', value: { name: '手游', v2: 4 }, label: 'l', owningGroupNames: [] })
    writeTagRecTempEntry({ kind: 'partitionAllow', value: { name: '单机', v2: 17 }, label: 'l', owningGroupNames: [] })
    const ov = tagRecCustomSession.filterOverride!
    expect(ov.dims.partitionBlock!.list).toEqual([{ name: '手游', v2: 4 }])
    expect(ov.dims.partitionBlock!.enabled).toBe(true)
    expect(ov.dims.partitionAllow).toEqual({ enabled: true, list: [{ name: '单机', v2: 17 }] })
  })

  it('移除/清空按账操作: 弹层手改不入账也不被误清', () => {
    writeTagRecTempEntry({ kind: 'upBlock', value: { name: 'UP甲' }, label: 'l', owningGroupNames: [] })
    const ov = tagRecCustomSession.filterOverride!
    ov.dims.upBlacklist!.list.push({ name: '手动UP' }) // 弹层手改 (不入账)
    removeTagRecTempWriteAt(0)
    expect(ov.dims.upBlacklist!.list).toEqual([{ name: '手动UP' }]) // 手改保留
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(0)
    writeTagRecTempEntry({ kind: 'titleBlock', value: '广告', label: 'l', owningGroupNames: [] })
    clearTagRecTempWrites()
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(0)
    expect(ov.dims.titleKeywords).toBeUndefined() // 清空恢复继承
    expect(ov.dims.upBlacklist!.list).toEqual([{ name: '手动UP' }])
  })
})

describe('R8 固化 (keep)', () => {
  it('固化以记录的组 ID 为准，改名和同名组不会改变写入落点', () => {
    favorites.list.push(makeGroup('first', '相同'), makeGroup('second', '相同'))
    writeTagRecTempEntry({
      kind: 'descBlock',
      value: '广告',
      label: 'l',
      owningGroupNames: ['相同'],
      owningGroupIds: ['second'],
    })
    favorites.list[1].name = '已改名'
    keepTagRecTempEntryToGroup(0)
    expect(favorites.list[0].overrides?.negative?.desc).toBeUndefined()
    expect(favorites.list[1].overrides?.negative?.desc).toEqual(['广告'])
    expect(tagRecCustomSession.tempWriteLog).toEqual([])
  })

  it('已删除的组 ID 不会重定向到同名新组，临时规则仍可保留', () => {
    favorites.list.push(makeGroup('new', '相同'))
    writeTagRecTempEntry({
      kind: 'descBlock',
      value: '广告',
      label: 'l',
      owningGroupNames: ['相同'],
      owningGroupIds: ['deleted'],
    })
    keepTagRecTempEntryToGroup(0)
    expect(favorites.list[0].overrides).toBeUndefined()
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
  })

  it('旧的全局固化在等待结束后不会删除后来加入的临时条目', async () => {
    const deferred = Promise.withResolvers<string[]>()
    vi.mocked(getNewestValueOfSettingsInnerArray).mockReturnValueOnce(deferred.promise)
    writeTagRecTempEntry({ kind: 'titleBlock', value: '旧广告', label: 'old', owningGroupNames: [] })
    const pending = keepTagRecTempEntryToGlobal(0)
    clearTagRecTempWrites()
    writeTagRecTempEntry({ kind: 'titleBlock', value: '新广告', label: 'new', owningGroupNames: [] })
    deferred.resolve([])
    await pending
    expect(tagRecCustomSession.tempWriteLog.map((e) => e.value)).toEqual(['新广告'])
    expect(tagRecCustomSession.filterOverride?.dims.titleKeywords?.list).toEqual(['新广告'])
  })

  it('固化到本组: 逐认领组写 negative; 已删组跳过计数; 有一条写成即消费', () => {
    favorites.list.push(makeGroup('G1'))
    writeTagRecTempEntry({
      kind: 'upBlock',
      value: { name: 'UP甲' },
      label: 'l',
      owningGroupNames: ['G1', '已删组'],
    })
    keepTagRecTempEntryToGroup(0)
    expect(favorites.list[0].overrides?.negative?.up).toEqual([{ name: 'UP甲' }])
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(0)
    expect(String(vi.mocked(toast).mock.calls.at(-1)?.[0])).toContain('跳过 1 个')
  })

  it('固化到本组全跳 (组已删): 保留临时条不消费 (防丢写)', () => {
    writeTagRecTempEntry({ kind: 'upBlock', value: { name: 'UP乙' }, label: 'l', owningGroupNames: ['不存在'] })
    keepTagRecTempEntryToGroup(0)
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1)
    expect(String(vi.mocked(toast).mock.calls.at(-1)?.[0])).toContain('固化未生效')
  })

  it('固化到本组: 值已存在 => 跳过 (不重复写)', () => {
    favorites.list.push(makeGroup('G1'))
    writeTagRecTempEntry({ kind: 'upBlock', value: { name: 'UP甲' }, label: 'l', owningGroupNames: ['G1'] })
    keepTagRecTempEntryToGroup(0) // 首次写入
    writeTagRecTempEntry({ kind: 'upBlock', value: { name: 'UP甲' }, label: 'l', owningGroupNames: ['G1'] }) // 临时再入 (覆盖已摘, 不 dup)
    keepTagRecTempEntryToGroup(0)
    expect(favorites.list[0].overrides?.negative?.up).toEqual([{ name: 'UP甲' }]) // 不重复
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(1) // 全跳 => 不消费
  })

  it('固化到「标签过滤」: 仅看家族除分区外禁用; partitionAllow 写全局开闸并消费', async () => {
    expect(canKeepTempEntryToGlobal('upAllow')).toBe(false)
    expect(canKeepTempEntryToGlobal('titleAllow')).toBe(false)
    expect(canKeepTempEntryToGlobal('descAllow')).toBe(false)
    expect(canKeepTempEntryToGlobal('partitionAllow')).toBe(true)
    expect(canKeepTempEntryToGlobal('upBlock')).toBe(true)
    writeTagRecTempEntry({
      kind: 'partitionAllow',
      value: { name: '单机', v2: 17 },
      label: 'l',
      owningGroupNames: [],
    })
    await keepTagRecTempEntryToGlobal(0)
    expect(settings.tagRec.filter.dims.partitionAllow.list).toEqual([{ name: '单机', v2: 17 }])
    expect(settings.tagRec.filter.dims.partitionAllow.enabled).toBe(true)
    expect(tagRecCustomSession.tempWriteLog).toHaveLength(0)
  })
})
