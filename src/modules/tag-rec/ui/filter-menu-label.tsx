import { theme } from 'antd'
import { IconForTagAllow, IconForTagBlock } from './icons'

/** 菜单先说动作，再用次行说明范围；范围徽标保持在同一列。 */
export function TagRecFilterMenuLabel({
  title,
  description,
  scope,
  disabled,
}: {
  title: string
  description: string
  scope?: '临时' | '本组' | '全局'
  disabled?: boolean
}) {
  const { token } = theme.useToken()
  return (
    <span className='block py-2px' style={{ width: scope ? 248 : 190, maxWidth: 'calc(100vw - 96px)' }}>
      <span className='flex items-center justify-between gap-x-12px' style={{ lineHeight: '20px' }}>
        <span className='min-w-0 truncate font-medium'>{title}</span>
        {scope && (
          <span
            className='shrink-0 rounded-4px px-5px text-12px font-medium'
            style={{
              background: scope === '临时' && !disabled ? token.colorPrimaryBg : token.colorFillTertiary,
              color: disabled
                ? token.colorTextDisabled
                : scope === '临时'
                  ? token.colorPrimaryTextActive
                  : token.colorTextLabel,
              lineHeight: '18px',
            }}
          >
            {scope}
          </span>
        )}
      </span>
      <span
        className='mt-2px block truncate text-12px'
        title={description}
        style={{ color: disabled ? token.colorTextDisabled : token.colorTextLabel, lineHeight: '18px' }}
      >
        {description}
      </span>
    </span>
  )
}

export function TagRecFilterMenuSection({ mode }: { mode: 'block' | 'allow' }) {
  const { token } = theme.useToken()
  const Icon = mode === 'block' ? IconForTagBlock : IconForTagAllow
  return (
    <span
      className='flex items-center gap-x-6px text-12px font-medium'
      style={{ color: mode === 'block' ? token.colorErrorTextActive : token.colorPrimaryTextActive }}
    >
      <Icon className='size-12px' aria-hidden />
      {mode === 'block' ? '不想看 · 屏蔽匹配内容' : '只想看 · 保留匹配内容'}
    </span>
  )
}
