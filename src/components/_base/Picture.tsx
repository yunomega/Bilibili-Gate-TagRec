import { useUnoMerge } from 'unocss-merge/react'
import { isSafari } from '$ua'
import type { ComponentProps } from 'react'

type IProps = {
  src: string
  avif?: boolean
  webp?: boolean
  imgProps?: ComponentProps<'img'>
  // [tag-rec] 票 perf-05 首屏白封面: 视口内首批封面 eager,
  // 跳过 Chromium lazy 的布局后 IntersectionObserver 门控 (官方首页同款结构一律 eager)
  eager?: boolean
} & ComponentProps<'picture'>

export function Picture({ src, avif, webp, imgProps, className, eager, ...props }: IProps) {
  // safari avif 花屏
  avif ??= !isSafari
  webp ??= true
  return (
    <picture className={useUnoMerge('h-full w-full object-cover', className)} {...props}>
      {avif && <source srcSet={`${src}.avif`} type='image/avif' />}
      {webp && <source srcSet={`${src}.webp`} type='image/webp' />}
      <img src={src} loading={eager ? 'eager' : 'lazy'} className='block h-full w-full' {...imgProps} />{' '}
      {/* [tag-rec] eager prop */}
    </picture>
  )
}
