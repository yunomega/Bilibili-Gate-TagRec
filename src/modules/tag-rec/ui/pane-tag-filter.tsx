import { InputNumber } from 'antd'
import { useEffect, useState } from 'react'
import { HelpInfo } from '$components/_base/HelpInfo'
import { SwitchSettingItem } from '$components/ModalSettings/setting-item'
import { SettingsGroup, sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import { settings, useSettingsSnapshot } from '$modules/settings'
import { computeTagRecFilterSignature } from '../model/filter-engine'
import { clampSeenCap, SEEN_CAP_MAX, SEEN_CAP_MIN } from '../model/seen'
import { favorites, favoritesL1 } from '../store/index'
import { TagRecDiscoverySettings } from './discovery-settings'
import { TagRecFilterForm } from './filter-form'
import { TagRecRecoverySettings } from './recovery-actions'

/**
 * [tag-rec] 「标签过滤」pane (spec §5.1) —— FilterForm 绑全局 tagRec.filter configPath 段
 * - 预设/总开关/维度/高级区/K 旋钮全部在 FilterForm (scope='global') 内, 持久化+迁移白拿
 * - 「恢复出厂」/自定义预设增删改名走预设引擎 (model/filter-engine.ts)
 * - 附加行为参数 (归因徽章/多样性护栏/已看容量) 走声明式 configPath 绑定
 */
export function TabPaneTagFilter() {
  const { seenCap, diversityGuard } = useSettingsSnapshot().tagRec
  // [tag-rec] R5-P1-13: 本 pane 直改全局过滤核心/护栏 —— 卸载比对 (与 pane-tag-favorites 同款),
  //   否则从这里收紧过滤后回推荐页不重滤存货; diversityGuard 影响算分一并入比对串
  const { recSharedEmitter } = useRecSelfContext()
  const [fsOnMount] = useState(
    () =>
      computeTagRecFilterSignature({
        core: settings.tagRec.filter,
        groups: favorites.list,
        l1s: favoritesL1.list,
      }) + `|dg:${JSON.stringify(settings.tagRec.diversityGuard)}|ladder:${JSON.stringify(settings.tagRec.ladder)}`,
  )
  useEffect(
    () => () => {
      const fsNow =
        computeTagRecFilterSignature({
          core: settings.tagRec.filter,
          groups: favorites.list,
          l1s: favoritesL1.list,
        }) + `|dg:${JSON.stringify(settings.tagRec.diversityGuard)}|ladder:${JSON.stringify(settings.tagRec.ladder)}`
      if (fsNow !== fsOnMount) recSharedEmitter.emit('refresh', 'refresh')
    },
    [recSharedEmitter, fsOnMount],
  )
  return (
    <div className={sharedClassNames.tabPane}>
      <SettingsGroup
        title={
          <>
            标签过滤
            <HelpInfo>
              作用于「收藏推荐」「指定标签」两 tab;
              <br />
              「指定标签」tabbar 的「过滤」按钮可在会话内临时覆盖 (刷新即丢)
            </HelpInfo>
          </>
        }
      >
        <TagRecFilterForm core={settings.tagRec.filter} scope='global' />
      </SettingsGroup>

      <TagRecRecoverySettings />
      <TagRecDiscoverySettings />

      <SettingsGroup
        title={
          <>
            其它参数
            <HelpInfo>「收藏推荐」展示与抽样行为 (spec §3.3)</HelpInfo>
          </>
        }
      >
        <div className={sharedClassNames.settingsLine}>
          <span>已看记录容量</span>
          <InputNumber
            size='small'
            className='w-100px'
            min={SEEN_CAP_MIN}
            max={SEEN_CAP_MAX}
            step={100}
            value={seenCap}
            onChange={(v) => {
              if (typeof v === 'number' && Number.isFinite(v)) settings.tagRec.seenCap = clampSeenCap(v)
            }}
          />
          <HelpInfo>
            卡片一半进入屏幕就记录为已看，用于避免重复推荐。两种标签推荐共享记录，超过容量后移除最旧记录。 上限{' '}
            {SEEN_CAP_MAX} 条。
          </HelpInfo>
        </div>
        <div className={sharedClassNames.settingsLine}>
          <span>归因徽章</span>
          <SwitchSettingItem configPath='tagRec.showAttributionBadge' />
          <HelpInfo>开 = 卡片展示来源组名 (recommendReason 槽位)</HelpInfo>
        </div>
        <div className={sharedClassNames.settingsLine}>
          <span>护栏·单组占比</span>
          <SwitchSettingItem configPath='tagRec.diversityGuard.group.enabled' />
          <InputNumber
            size='small'
            className='w-80px'
            min={10}
            max={100}
            step={5}
            disabled={!diversityGuard.group.enabled}
            value={Math.round(diversityGuard.group.maxShare * 100)}
            onChange={(v) => {
              if (typeof v === 'number' && Number.isFinite(v))
                settings.tagRec.diversityGuard.group.maxShare = Math.min(1, Math.max(0.1, v / 100))
            }}
          />
          {/* UIUX-U2-10: text-xs + &nbsp; 撑距 => text-12px + ml-* */}
          <span className='ml-4px text-12px'>%/屏</span>
          <HelpInfo>默认开启，单组每批推荐最多占 N%；超出部分顺延到后续推荐。</HelpInfo>
        </div>
        <div className={sharedClassNames.settingsLine}>
          <span>护栏·单 UP</span>
          <SwitchSettingItem configPath='tagRec.diversityGuard.up.enabled' />
          <InputNumber
            size='small'
            className='w-80px'
            min={1}
            max={10}
            disabled={!diversityGuard.up.enabled}
            value={diversityGuard.up.max}
            onChange={(v) => {
              if (typeof v === 'number' && Number.isFinite(v))
                settings.tagRec.diversityGuard.up.max = Math.min(10, Math.max(1, Math.round(v)))
            }}
          />
          <span className='ml-4px text-12px'>条/屏</span>
          <HelpInfo>开 = 同一 UP 每切片 ≤N 条, 超额顺延 (票09: owner.mid 计数, 缺 mid 豁免; 默认 4)</HelpInfo>
        </div>
      </SettingsGroup>
    </div>
  )
}
