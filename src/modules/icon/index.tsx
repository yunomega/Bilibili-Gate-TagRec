import clsx from 'clsx'
import IconCuidaShuffleOutline from '~icons/cuida/shuffle-outline' // 这个不能自动 import 不知为何
import type { ComponentProps, ComponentType } from 'react'

export type IconComponent = ComponentType<ComponentProps<'svg'>>
export { IconAnimatedChecked } from './animated-checked'

// Tabs
export const IconForPhone = IconParkOutlineIphone
export const IconForPc = IconParkOutlineComputer
export const IconForFollowedOnly = IconParkOutlineConcern
export const IconForDynamicFeed = IconMdiPinwheelOutline
export const IconForFav = IconCarbonStar
export const IconForFaved = IconCarbonStarFilled // faved variant
export const IconForHot = IconParkOutlineFire
export const IconForSpaceUpload = IconLineMdUploadingLoop
export const IconForHistory = IconLucideClock

// nouns
export const IconForPlayer = IconParkOutlinePlayTwo
export const IconForCloudStorage = IconIcOutlineCloud
export const IconForAccessKey = IconMingcuteKey1Line
export const IconForInfo = IconParkOutlineInfo
export const IconForHelp = IconParkOutlineHelp
export const IconForBlacklist = IconParkOutlinePeopleDelete

// verbs
export const IconForLike = IconPhThumbsUpDuotone
export const IconForDislike = IconPhThumbsDownDuotone
export const IconForConfig = IconParkOutlineConfig
export const IconForOpenExternalLink = IconMaterialSymbolsLightOpenInNew
export const IconForReset = IconParkOutlineReturn
export const IconForCopy = IconParkOutlineCopy
export const IconForLoading = IconSvgSpinnersBarsRotateFade
export const IconForDelete = IconMaterialSymbolsDeleteOutlineRounded
export const IconForMove = IconParkOutlineTransferData
export const IconForEdit = IconParkOutlineWrite
export const IconForComment = IconTablerMessageCircle // dynamic-feed 评论
export const IconForForward = IconTablerArrowForwardUp // dynamic-feed 转发
export const IconForReload = IconTablerReload

// #region orders ↑↓
export const IconForTimeAsc = IconMdiSortClockDescending
export const IconForTimeDesc = IconMdiSortClockAscending

// https://github.com/tabler/tabler-icons/issues/1457
// export const IconForAsc = IconOcticonSortAsc16
// export const IconForDesc = IconOcticonSortDesc16
// export const IconForAsc = IconTablerSortAscending2
// export const IconForDesc = IconTablerSortDescending2
export const IconForAsc = IconTablerSortAscending
export const IconForDesc = IconTablerSortDescending

export const IconForSortSwitchAsc = IconCuidaSortAscendingDuotone
export const IconForSortSwitchDesc = IconCuidaSortDescendingDuotone

// 同类
// export const IconForSortAToZ = IconPrimeSortAlphaDown
// export const IconForSortZToA = IconPrimeSortAlphaAltDown
// export const IconForSortAToZ = IconMdiSortAlphabeticalAscending
// export const IconForSortZToA = IconMdiSortAlphabeticalDescending
// export const IconForSortAToZ = IconMdiSortAlphabeticalAscendingVariant
// export const IconForSortZToA = IconMdiSortAlphabeticalDescendingVariant
export const IconForSortAToZ = IconFluentTextSortAscending20Filled
export const IconForSortZToA = IconFluentTextSortDescending20Filled

export const IconForDefaultOrder = IconMdiShuffleDisabled
export const IconForShuffle = IconCuidaShuffleOutline
export const IconForTimestamp = IconParkOutlineTime
// #endregion

export function IconForLive({
  active = false,
  ...props
}: {
  active?: boolean
  width?: string | number
  height?: string | number
  className?: string
}) {
  if (active) {
    return <IconSvgSpinnersBarsScaleMiddle {...props} />
  } else {
    return <IconMaterialSymbolsBarChart {...props} />
  }
}

export const IconForWatchlater = IconTablerClockPlay
export const IconForRoll = IconParkOutlineRotationHorizontal

export const clsIconTextWrapper = 'inline-flex items-center justify-center line-height-[0]'

export function withDescIcon(label: string) {
  return (
    <span className={clsx(clsIconTextWrapper, 'gap-1px')}>
      {label}
      <IconForDesc className='size-16px' />
    </span>
  )
}

export function withAscIcon(label: string) {
  return (
    <span className={clsx(clsIconTextWrapper, 'gap-1px')}>
      {label}
      <IconForAsc className='size-16px' />
    </span>
  )
}
