import { TagRecWorkbenchView } from './workbench'
import type { TagRecCustomService } from '../service/tag-rec-custom'

export { FilterPopover } from './filter-popover'

/** Every discovery entry edits a working copy; material searches never discard that copy. */
export function TagRecCustomTabbarView({ service }: { service: TagRecCustomService }) {
  return <TagRecWorkbenchView service={service} />
}
