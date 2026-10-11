import { describe, expect, it, vi } from 'vitest'

import { loadAndSetup, loadSettingsFromGmStorage, settings, updateSettings } from '$modules/settings'
import {
  applyTagRecPreset,
  createTagRecBuiltinPresets,
  createTagRecFactoryFilterCore,
  resolveTagRecEffective,
} from '$modules/tag-rec/model/filter-engine'

// 回归：保留实际设置读写边界，只隔离浏览器与 GM。
const kv = vi.hoisted(() => {
  const kv = new Map<string, unknown>()
  ;(globalThis as any).GM = {
    getValue: (key: string, def?: unknown) => Promise.resolve(kv.has(key) ? kv.get(key) : def),
    setValue: (key: string, value: unknown) => Promise.resolve(void kv.set(key, value)),
  }
  return kv
})
vi.mock('$common', () => ({
  appWarn: vi.fn(),
  appError: vi.fn(),
  baseDebug: { extend: () => vi.fn() },
  IN_BILIBILI_HOMEPAGE: false,
}))
vi.mock('$modules/tag-rec/api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$components/VideoCard/index.shared', () => ({ EVideoLinkOpenMode: { Normal: 'normal' } }))
const gmUpdates = vi.hoisted(() => ({ onUpdate: undefined as ((value: any) => void) | undefined }))
vi.mock('$modules/gm', () => ({
  reciveGmValueUpdatesFromOtherTab: vi.fn((options) => {
    gmUpdates.onUpdate = options.onUpdate
  }),
}))
vi.mock('$modules/settings/cloud-backup', () => ({ saveToDraft: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))

describe('audit: settings persistence boundary', () => {
  it('旧出厂淘沙与默认选种门槛只迁移一次，定制的质量条件保持有效', async () => {
    const presets = createTagRecBuiltinPresets()
    const old = createTagRecFactoryFilterCore()
    old.dims.likeRate.enabled = true
    presets.find((p) => p.name === '淘沙')!.config.dims.likeRate.enabled = true
    const ladder = {
      triggerYield: 10,
      autoDigMax: 3,
      digStreamWindow: 4,
      seedPoolMax: 12,
      seedCount: 3,
      seedMinScore: 30,
      fallbackPage: 20,
    }
    const saved = { tagRec: { filter: { ...old, activePreset: '淘沙', presets }, ladder } }
    kv.set('settings', saved)
    const loaded = await loadSettingsFromGmStorage()
    expect(loaded.tagRec?.filter?.dims?.likeRate?.enabled).toBe(false)
    expect(loaded.tagRec?.filter?.presets?.find((p) => p?.name === '淘沙')?.config?.dims?.likeRate?.enabled).toBe(false)
    expect(loaded.tagRec?.filter?.presets?.find((p) => p?.name === '只看高质量')?.config?.dims?.minScore?.enabled).toBe(
      true,
    )
    expect(loaded.tagRec?.ladder?.seedMinScore).toBe(0)
    expect(loaded.tagRec?.defaultsVersion).toBe(2)
    // 已升级后重新手动设置的同值阈值也不能再次被迁移。
    saved.tagRec.filter.dims.likeRate.enabled = true
    const reloaded = await loadSettingsFromGmStorage()
    expect(reloaded.tagRec?.filter?.dims?.likeRate?.enabled).toBe(true)
    const customized = createTagRecFactoryFilterCore()
    customized.dims.likeRate = { enabled: true, value: 0.09 }
    kv.set('settings', { tagRec: { filter: { ...customized, activePreset: '淘沙', presets } } })
    expect((await loadSettingsFromGmStorage()).tagRec?.filter?.dims?.likeRate?.value).toBe(0.09)
  })

  it.each([30, 15])('旧选种门槛 %s 按字段迁移，其他预算调整保留', async (minScore) => {
    kv.set('settings', { tagRec: { ladder: { seedMinScore: minScore, autoDigMax: 7 } } })
    const loaded = await loadSettingsFromGmStorage()
    expect(loaded.tagRec?.ladder?.seedMinScore).toBe(minScore === 30 ? 0 : 15)
    expect(loaded.tagRec?.ladder?.autoDigMax).toBe(7)
  })

  it('旧高质量预设加载后补齐新增维度，可以反复切换并在刷新后求解', async () => {
    const old = createTagRecFactoryFilterCore()
    delete (old.dims as Partial<typeof old.dims>).upAllow
    delete (old.dims as Partial<typeof old.dims>).titleAllow
    kv.set('settings', { tagRec: { filter: { presets: [{ name: '旧高质量', config: old }] } } })
    const loaded = await loadSettingsFromGmStorage()
    updateSettings(loaded)
    for (let i = 0; i < 3; i++) {
      expect(applyTagRecPreset(settings.tagRec.filter, '旧高质量')).toBe(true)
      expect(() => resolveTagRecEffective(settings.tagRec.filter, 'tagTop')).not.toThrow()
    }
    expect(settings.tagRec.filter.dims.upAllow).toEqual({ enabled: false, list: [] })
  })
  it('preserves global date-window fields and pool selection on reload', async () => {
    kv.set('settings', {
      tagRec: {
        filter: {
          dims: { pubdate: { enabled: true, win: 'd7', from: 1788192000, to: 1790697600 } },
          poolsEnabled: { allV2Related: false, archiveRelated: false },
        },
      },
    })
    const loaded = await loadSettingsFromGmStorage()
    expect(loaded.tagRec?.filter?.dims?.pubdate).toEqual({ enabled: true, win: 'd7', from: 1788192000, to: 1790697600 })
    expect(loaded.tagRec?.filter?.poolsEnabled).toEqual({ allV2Related: false, archiveRelated: false })
  })

  it('preserves optional fields on cross-tab updates', () => {
    settings.tagRec.filter.dims.pubdate = { enabled: false }
    settings.tagRec.filter.poolsEnabled = undefined
    updateSettings({
      tagRec: {
        filter: {
          dims: { pubdate: { enabled: true, win: 'd7' } },
          poolsEnabled: { archiveRelated: false },
        },
      },
    } as any)
    expect(settings.tagRec.filter.dims.pubdate).toEqual({ enabled: true, win: 'd7' })
    expect(settings.tagRec.filter.poolsEnabled).toEqual({ archiveRelated: false })
  })

  it('clears optional pool and date fields when another tab restores a full default snapshot', async () => {
    await loadAndSetup()
    settings.tagRec.filter.poolsEnabled = { archiveRelated: false }
    settings.tagRec.filter.dims.pubdate = { enabled: true, win: 'd7', from: 100 }
    gmUpdates.onUpdate!({ tagRec: { filter: createTagRecFactoryFilterCore() } })
    expect(settings.tagRec.filter.poolsEnabled).toBeUndefined()
    expect(settings.tagRec.filter.dims.pubdate).toEqual({ enabled: false })
  })

  it('preserves date conditions when a local partial update only toggles enabled', () => {
    settings.tagRec.filter.dims.pubdate = { enabled: true, win: 'd7', from: 100 }
    updateSettings({ tagRec: { filter: { dims: { pubdate: { enabled: false } } } } })
    expect(settings.tagRec.filter.dims.pubdate).toEqual({ enabled: false, win: 'd7', from: 100 })
  })
})
