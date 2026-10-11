import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initialSettings, loadSettingsFromGmStorage, runSettingsMigration, settings, updateSettings } from './index'

// 模块图 mock (同 tag-rec 各测试手法): 浏览器边界/跨 Tab 通道/备份链隔掉, 保留纯设置读写。
// settings/index.ts 顶层 `await loadAndSetup()` —— GM 桩须在模块求值前就位 => vi.hoisted
const gmKv = vi.hoisted(() => {
  const kv = new Map<string, unknown>()
  ;(globalThis as Record<string, unknown>).GM = {
    getValue: (key: string, def?: unknown) => Promise.resolve(kv.has(key) ? kv.get(key) : def),
    setValue: (key: string, val: unknown) => Promise.resolve(void kv.set(key, val)),
  }
  return kv
})

vi.mock('$common', () => ({
  appWarn: vi.fn(),
  appError: vi.fn(),
  baseDebug: { extend: () => vi.fn() },
  IN_BILIBILI_HOMEPAGE: false,
}))
vi.mock('../tag-rec/api/endpoints', () => ({ fetchTagTop: vi.fn(() => Promise.resolve([])) }))
vi.mock('$components/VideoCard/index.shared', () => ({ EVideoLinkOpenMode: { Normal: 'normal' } }))
vi.mock('$modules/gm', () => ({ reciveGmValueUpdatesFromOtherTab: vi.fn() }))
vi.mock('./cloud-backup', () => ({ saveToDraft: vi.fn() }))
vi.mock('$utility/toast', () => ({ default: vi.fn() }))

describe('首次安装的标签过滤配置', () => {
  beforeEach(() => gmKv.clear())

  it('保留原三档并默认淘沙，实际配置与内置预设各自独立', () => {
    const filter = initialSettings.tagRec.filter
    expect(filter.presets.map((p) => p.name)).toEqual(['全放', '淘沙', '只看高质量'])
    expect(filter.activePreset).toBe('淘沙')
    expect(filter.enabled).toBe(true)
    expect(filter.dims.likeRate).toEqual({ enabled: false, value: 0.02 })
    expect(
      Object.entries(filter.dims)
        .filter(([, d]) => d.enabled)
        .map(([k]) => k),
    ).toEqual([])
    expect(filter.dims).toEqual(filter.presets[1]!.config.dims)
    expect(filter.dims).not.toBe(filter.presets[1]!.config.dims)
    expect(settings.tagRec.filter.activePreset).toBe('淘沙')
    expect(settings.tagRec.filter.enabled).toBe(true)
  })

  it('已有选择、阈值和自定义预设读回后不被新默认覆盖', async () => {
    gmKv.set('settings', {
      tagRec: {
        filter: {
          enabled: true,
          activePreset: '我的档位',
          dims: { likeRate: { enabled: true, value: 0.08 } },
          presets: [
            { name: '我的档位', config: { enabled: true, dims: { likeRate: { enabled: true, value: 0.08 } } } },
          ],
        },
      },
    })
    const loaded = await loadSettingsFromGmStorage()
    updateSettings(loaded)
    expect(settings.tagRec.filter.enabled).toBe(true)
    expect(settings.tagRec.filter.activePreset).toBe('我的档位')
    expect(settings.tagRec.filter.dims.likeRate).toEqual({ enabled: true, value: 0.08 })
    expect(settings.tagRec.filter.presets.map((p) => p.name)).toEqual(['我的档位'])
    expect(settings.tagRec.filter.presets[0]!.config.dims.likeRate).toEqual({ enabled: true, value: 0.08 })
  })
})

describe('$modules/settings — tagRec.filter.pools 持久化 (R3-02) + 分区 number 迁移 (R3-05)', () => {
  beforeEach(() => gmKv.clear())

  it('loadSettingsFromGmStorage: 非出厂 pools 槽读回存活 (写 GM 整快照无损, 丢点在读回叶白名单)', async () => {
    gmKv.set('settings', {
      tagRec: {
        filter: {
          pools: {
            tagTop: { dims: { viewMin: { enabled: true, value: 1 } }, smallPoolThreshold: 9 },
            archiveRelated: { smallPoolThreshold: 7 },
            allV2: { dims: { likeMin: { enabled: true, value: 3 } } }, // 出厂槽的非出厂键 (dims) 同样存活
            bogus: { smallPoolThreshold: 1 }, // 非池键 => 归一弃
          },
        },
      },
    })
    const val = await loadSettingsFromGmStorage()
    expect(val.tagRec?.filter?.pools).toEqual({
      tagTop: { dims: { viewMin: { enabled: true, value: 1 } }, smallPoolThreshold: 9 },
      archiveRelated: { smallPoolThreshold: 7 },
      allV2: { dims: { likeMin: { enabled: true, value: 3 } } },
    })
  })

  it('loadSettingsFromGmStorage: saved 无 pools 键 => 不 graft (旧快照回落出厂 pools)', async () => {
    gmKv.set('settings', { tagRec: { filter: { enabled: true } } })
    const val = await loadSettingsFromGmStorage()
    expect(val.tagRec?.filter?.pools).toBeUndefined()
    // 槽内畸形值经归一消毒, 不穿透进 picked
    gmKv.set('settings', {
      tagRec: { filter: { pools: { tagTop: { dims: { viewMin: { enabled: true, value: 'x' } } } } } },
    })
    const bad = await loadSettingsFromGmStorage()
    expect(bad.tagRec?.filter?.pools).toBeUndefined()
  })

  it('updateSettings: 跨 Tab 整快照同步 pools 同补接 (归一后整子树替换)', () => {
    const payload = {
      tagRec: {
        filter: {
          pools: {
            tagTop: { smallPoolThreshold: 5, dims: { viewMin: { enabled: true, value: 'x' } } },
          },
        },
      },
    } as unknown as Parameters<typeof updateSettings>[0]
    updateSettings(payload)
    expect(settings.tagRec.filter.pools).toEqual({ tagTop: { smallPoolThreshold: 5 } }) // 畸形 dims 键弃
  })

  it('runSettingsMigration 分区 number 迁移 (R3-05): v2 一级分区段只发 v1 键保死值; 余者双键等值', () => {
    const saved: Record<string, any> = {
      tagRec: {
        filter: {
          dims: {
            partition: { enabled: true, mode: 'block', list: [1010, 4] }, // 旧形单列表
            partitionAllow: { enabled: true, list: [2079] }, // 新键 list 内 number 同款迁移
          },
          presets: [{ name: 'p', config: { dims: { partition: { enabled: false, mode: 'allow', list: [1032] } } } }],
        },
      },
    }
    runSettingsMigration(saved)
    const dims = saved.tagRec.filter.dims
    expect(dims.partition).toBeUndefined()
    expect(dims.partitionBlock).toEqual({
      enabled: true,
      list: [
        { name: '#1010', v1: 1010 }, // pid 段死值保死 (无 v2 键)
        { name: '#4', v1: 4, v2: 4 }, // v1 段双键
      ],
    })
    expect(dims.partitionAllow).toEqual({ enabled: true, list: [{ name: '#2079', v1: 2079, v2: 2079 }] })
    // presets 内 dims 同款迁移
    expect(saved.tagRec.filter.presets[0].config.dims.partitionAllow).toEqual({
      enabled: false,
      list: [{ name: '#1032', v1: 1032 }],
    })
  })
})

describe('$modules/settings — tagRec.customTabSeen (「指定标签」红点一次性置位)', () => {
  beforeEach(() => gmKv.clear())

  it('出厂 false; updateSettings 置位; GM 读回存活 (新出厂叶自动进 leaf 白名单)', async () => {
    updateSettings({ tagRec: { customTabSeen: false } }) // 防前序用例串态
    expect(settings.tagRec.customTabSeen).toBe(false) // 出厂值
    // 置位路径 = tab 激活后同套 settings 持久化 (subscribe => GM 整快照)
    updateSettings({ tagRec: { customTabSeen: true } })
    expect(settings.tagRec.customTabSeen).toBe(true)
    // GM 读回: allowedLeafSettingsPaths 自动收录, 跨会话/跨 Tab 存活
    gmKv.set('settings', { tagRec: { customTabSeen: true } })
    const val = await loadSettingsFromGmStorage()
    expect(val.tagRec?.customTabSeen).toBe(true)
  })
})

describe('标签推荐多样性默认值', () => {
  it('单组占比默认开启 60%，手动关闭的选择仍可保存并读回', async () => {
    expect(initialSettings.tagRec.diversityGuard.group).toEqual({ enabled: true, maxShare: 0.6 })
    gmKv.set('settings', { tagRec: { diversityGuard: { group: { enabled: false, maxShare: 0.7 } } } })
    const loaded = await loadSettingsFromGmStorage()
    expect(loaded.tagRec?.diversityGuard?.group).toEqual({ enabled: false, maxShare: 0.7 })
  })
})
