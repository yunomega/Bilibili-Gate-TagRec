import { Button, Popover, Typography } from 'antd'
import { useState } from 'react'
import { useSnapshot } from 'valtio'
import { usePopoverBorderColor } from '$common/emotion-css'
import { useOnRefresh } from '$components/Recommends/rec.shared'
import { pickTagGroupsByIds } from '../model/favorites'
import { favoritesStore } from '../store'
import { tagRecCustomSession } from '../store/session'
import { CandidateResolvePicker } from './candidate-resolve-picker'
import type { TagGroup } from '../model/types'
import type { TagRecCustomService } from '../service/tag-rec-custom'

/** 候选在弹层本地解析，确认后与视频标签、主搜索共现词共用扩选暂存。 */
export function TagRecExpandPicker({
  service,
  queryRevision,
  getPopupContainer,
}: {
  service: TagRecCustomService
  queryRevision: number
  getPopupContainer: () => HTMLElement
}) {
  const snap = useSnapshot(tagRecCustomSession)
  const list = useSnapshot(favoritesStore).list as TagGroup[]
  const selected = pickTagGroupsByIds(list, [...snap.selectedGroupIds])[0]
  const saved = snap.draftGroup?.savedGroupId ? list.find((g) => g.id === snap.draftGroup!.savedGroupId) : undefined
  const ready = snap.inputText ? !!snap.anchor : !!selected
  const contextName = snap.inputText ? (snap.draftGroup?.name ?? snap.anchor?.name) : selected?.name
  const existingTagIds = [
    ...(snap.anchor ? [snap.anchor.id] : []),
    ...((selected ?? saved)?.tag_ids.map((entry) => entry.id) ?? []),
    ...snap.expandedIds.map((entry) => entry.id),
  ]
  const [open, setOpen] = useState(false)
  const onRefresh = useOnRefresh()
  const borderColor = usePopoverBorderColor()

  return (
    <Popover
      trigger='click'
      placement='bottomLeft'
      open={open}
      onOpenChange={setOpen}
      getPopupContainer={getPopupContainer}
      destroyOnHidden
      styles={{ container: { border: `1px solid ${borderColor}` } }}
      content={
        !ready ? (
          <Typography.Text type='secondary'>先解析一个标签或选择标签组，再来扩选。</Typography.Text>
        ) : (
          <div className='max-w-[calc(100vw-48px)] w-560px'>
            <div className='mb-8px flex items-center justify-between gap-x-8px'>
              <Typography.Text strong>为「{contextName}」扩选标签</Typography.Text>
              <Button size='small' type='text' onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>
            <Typography.Text type='secondary' className='mb-8px block text-12px'>
              输入另一个标签，勾选它或共现词，加入后更新视频。已扩选标签可取消；存成项或并入组后保存。
            </Typography.Text>
            <CandidateResolvePicker
              confirmLabel='扩进本次查询'
              confirmIdInput={false}
              mineIdInput
              existingTagIds={existingTagIds}
              existingLabel='本次已有'
              onConfirm={(entries) => {
                const added = service.expandResolvedTags(entries, queryRevision)
                if (added.length) {
                  setOpen(false)
                  onRefresh('refresh')
                }
              }}
            />
          </div>
        )
      }
    >
      {/* Popover 直挂 Button —— 中间套 Tooltip 会吞掉 trigger 注入的点击事件 */}
      <Button>+ 扩选标签</Button>
    </Popover>
  )
}
