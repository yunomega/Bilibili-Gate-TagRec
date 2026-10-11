import { defaultSvgFillProps, defaultSvgProps } from '$modules/icon/util'
import type { ComponentProps } from 'react'

/**
 * [tag-rec] tab 图标 (~16-18px, 随 className 控制尺寸)
 * 基形 = 标签 (Material sell 轮廓, evenodd 打孔)
 */

// 标签基形: 圆角菱形 + 左上角孔
const tagBasePath =
  'M21.41 11.58l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .59 1.42l9 9a2 2 0 0 0 2.83 0l7-7a2 2 0 0 0 0-2.83z' +
  'M5.5 7A1.5 1.5 0 1 0 7 5.5 1.5 1.5 0 0 0 5.5 7z'

// 五角星, 中心 ~(17.5,17.5) 半径 ~4.5, 位于标签右下角
const starBadgePath = 'M17.5 13l1.12 2.96 3.16.15-2.47 1.98.74 3.11-2.55-1.71-2.55 1.71.74-3.11-2.47-1.98 3.16-.15z'

/** 「主题推荐」: 标签 + 星 */
export function IconForTagRecFav(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' {...defaultSvgProps} {...defaultSvgFillProps} fillRule='evenodd' {...props}>
      <path d={tagBasePath} />
      <path d={starBadgePath} />
    </svg>
  )
}

/** 🏷 标签弹层入口: 纯标签 (卡片按钮 + 右键菜单共用) */
export function IconForTagManage(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' {...defaultSvgProps} {...defaultSvgFillProps} fillRule='evenodd' {...props}>
      <path d={tagBasePath} />
    </svg>
  )
}

/** ⛔ 拉黑/已黑: 禁止圈 (弹层行动作列) */
export function IconForTagBlock(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' {...defaultSvgProps} {...defaultSvgFillProps} {...props}>
      <path d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 6.32 12.9L7.1 5.68A7.96 7.96 0 0 1 12 4zm-6.32 3.1L16.9 18.32A7.96 7.96 0 0 1 12 20a8 8 0 0 1-6.32-12.9z' />
    </svg>
  )
}

/** 筛选入口用对象图标，避免标题/简介/分区都显示禁止圈。 */
export function IconForFilterAuthor(props: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox='0 0 24 24'
      {...defaultSvgProps}
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      {...props}
    >
      <circle cx='12' cy='7' r='4' />
      <path d='M4 21v-2a8 8 0 0 1 16 0v2' />
    </svg>
  )
}

export function IconForFilterTitle(props: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox='0 0 24 24'
      {...defaultSvgProps}
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      {...props}
    >
      <path d='M4 6V3h16v3M12 3v18M8 21h8' />
    </svg>
  )
}

export function IconForFilterDescription(props: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox='0 0 24 24'
      {...defaultSvgProps}
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeLinejoin='round'
      {...props}
    >
      <rect x='4' y='2' width='16' height='20' rx='2' />
      <path d='M8 7h8M8 12h8M8 17h5' />
    </svg>
  )
}

export function IconForFilterPartition(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' {...defaultSvgProps} fill='none' stroke='currentColor' strokeWidth='1.8' {...props}>
      <rect x='3' y='3' width='7' height='7' rx='1.5' />
      <rect x='14' y='3' width='7' height='7' rx='1.5' />
      <rect x='3' y='14' width='7' height='7' rx='1.5' />
      <rect x='14' y='14' width='7' height='7' rx='1.5' />
    </svg>
  )
}

export function IconForTagAllow(props: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox='0 0 24 24'
      {...defaultSvgProps}
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinejoin='round'
      {...props}
    >
      <path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' />
      <circle cx='12' cy='12' r='3' />
    </svg>
  )
}

/** 「标签发掘」: 标签 + 放大镜 */
export function IconForTagRecCustom(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox='0 0 24 24' {...defaultSvgProps} {...defaultSvgFillProps} fillRule='evenodd' {...props}>
      <path d={tagBasePath} />
      <circle cx='16.6' cy='16.6' r='3.6' fill='none' stroke='currentColor' strokeWidth='1.8' />
      <path d='M19.5 19.5 22.3 22.3' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' />
    </svg>
  )
}
