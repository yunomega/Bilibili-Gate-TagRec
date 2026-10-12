import { InputNumber, Select, Typography } from 'antd'
import { SettingsGroup, sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import { settings, useSettingsSnapshot } from '$modules/settings'
import { tagRecDiscoveryPolicy } from '../service/discovery-policy'
import type { TagRecLadderSettings } from '../model/filter-engine'

export function TagRecDiscoverySettings() {
  const snap = useSettingsSnapshot()
  const ladder = snap.tagRec.ladder
  const samplingView = snap.tagRec.samplingView ?? 'public'
  const policy = tagRecDiscoveryPolicy(ladder)
  const fields: {
    key: Exclude<keyof TagRecLadderSettings, 'mode'>
    label: string
    fallback: number
    min: number
    max: number
  }[] = [
    { key: 'triggerYield', label: '预挖触发线（条/轮）', fallback: 30, min: 1, max: 50 },
    ...(policy.mode === 'fixed'
      ? [{ key: 'autoDigMax' as const, label: '累计自动轮次上限', fallback: 20, min: 1, max: 20 }]
      : [
          { key: 'lowYield' as const, label: '低产线（条/轮）', fallback: 3, min: 1, max: 50 },
          { key: 'lowYieldStreakLimit' as const, label: '连续低产停止轮数', fallback: 2, min: 1, max: 20 },
        ]),
    { key: 'digStreamWindow', label: '每轮搜索词窗口', fallback: 4, min: 1, max: 8 },
    { key: 'emptyTtlMinutes', label: '空搜索复探冷却（分钟）', fallback: 5, min: 5, max: 1440 },
    { key: 'seedPoolMax', label: '推荐相关选种扫描窗口', fallback: 100, min: 10, max: 200 },
    { key: 'seedCount', label: '每轮推荐相关种子数', fallback: 10, min: 1, max: 10 },
    { key: 'seedMinScore', label: '种子质量门槛（0 为不开）', fallback: 0, min: 0, max: 100 },
    { key: 'fallbackPage', label: '相关库存放行页长', fallback: 50, min: 5, max: 50 },
    { key: 'verifyRequests', label: '每轮核验请求上限', fallback: 40, min: 0, max: 200 },
    { key: 'verifyCandidates', label: '每轮核验候选上限', fallback: 80, min: 10, max: 300 },
    { key: 'verifyMs', label: '每轮核验时间盒（毫秒）', fallback: 5000, min: 500, max: 60000 },
    { key: 'heldRetryQuota', label: '停牌每轮补位名额', fallback: 8, min: 0, max: 20 },
    { key: 'heldMaxAttempts', label: '停牌自动重试上限', fallback: 5, min: 1, max: 10 },
  ]
  return (
    <SettingsGroup title='发现策略（全局高级参数）'>
      <div className={sharedClassNames.settingsLine}>
        <span>自动搜索策略</span>
        <Select
          size='small'
          value={policy.mode}
          options={[
            { value: 'adaptive', label: '自适应：按低产停止' },
            { value: 'fixed', label: '固定：按累计轮数停止' },
          ]}
          onChange={(mode) => {
            settings.tagRec.ladder.mode = mode
          }}
        />
      </div>
      <div className={sharedClassNames.settingsLine}>
        <span>采样视角</span>
        <Select
          size='small'
          value={samplingView}
          options={[
            { value: 'public', label: '公共池：匿名采样，不受账号画像影响' },
            { value: 'account', label: '我的账号：个性化结果，消耗自身配额' },
          ]}
          onChange={(value) => {
            settings.tagRec.samplingView = value
          }}
        />
      </div>
      {fields.map((field) => (
        <div key={field.key} className={sharedClassNames.settingsLine}>
          <span>{field.label}</span>
          <InputNumber
            size='small'
            min={field.min}
            max={field.max}
            value={ladder[field.key] ?? field.fallback}
            onChange={(value) => {
              if (typeof value === 'number' && Number.isFinite(value))
                settings.tagRec.ladder[field.key] = Math.min(field.max, Math.max(field.min, Math.round(value)))
            }}
          />
        </div>
      ))}
      <Typography.Paragraph type='secondary' className='mt-8px text-12px'>
        下一次调度生效，保留已付轮次与分页。空搜索冷却到期后，仅缺库存且来源允许时探测第一页；页上限、失败、暂停和缺种子分别处理。定向重查入口在推荐页。
      </Typography.Paragraph>
    </SettingsGroup>
  )
}
