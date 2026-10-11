import { useMemo } from 'react'
import { snapshot, useSnapshot } from 'valtio'
import { settings } from '$modules/settings'
import { getSnapshotAuthorFilter } from './parse'

export function useInFilterByAuthorList(authorMid: string | undefined) {
  const { enabled, keywords } = useSnapshot(settings.filter.byAuthor)
  const blockUpMids = useMemo(
    () =>
      enabled && authorMid
        ? getSnapshotAuthorFilter(snapshot(settings.filter.byAuthor).keywords).blockUpMids
        : undefined,
    [keywords, enabled, authorMid],
  )
  if (!authorMid) return false
  return blockUpMids?.has(authorMid) ?? false
}
