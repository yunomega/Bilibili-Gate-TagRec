import { Button, Typography } from 'antd'
import { useSnapshot } from 'valtio'
import { SettingsGroup, sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import toast from '$utility/toast'
import { clearTagRecSedimentRecords, clearTagRecSeenRecords } from '../service/recovery'
import { sediment, seen } from '../store'

/** 可重建的推荐记录，与删除收藏的危险操作分开。 */
export function TagRecRecoverySettings() {
  const { recSharedEmitter } = useRecSelfContext()
  const seenCount = useSnapshot(seen.set).size
  const sedimentCount = useSnapshot(sediment.map).size
  return (
    <SettingsGroup title='推荐记录'>
      <div className={sharedClassNames.settingsLine}>
        <Button
          size='small'
          onClick={() => {
            clearTagRecSeenRecords()
            recSharedEmitter.emit('refresh', 'refresh')
            toast('已清空已看记录，可以重新推荐浏览过的内容')
          }}
        >
          清空已看
        </Button>
        <Button
          size='small'
          onClick={() => {
            clearTagRecSedimentRecords()
            recSharedEmitter.emit('refresh', 'refresh')
            toast('已清空沉淀，标签关系与发掘进度将重新建立')
          }}
        >
          清空沉淀
        </Button>
        <Typography.Text type='secondary' className='text-12px'>
          已看 {seenCount} 条 · 沉淀 {sedimentCount} 个标签
        </Typography.Text>
      </div>
      <Typography.Text type='secondary' className='mt-6px block text-12px'>
        已看按卡片浏览记录：一半进入屏幕就记入，未必打开或播放过。清空后可重新推荐这些内容。
        <br />
        沉淀保存标签关系与发掘进度；清空后会重新建立。收藏组、负向标签和过滤设置均保留。
      </Typography.Text>
    </SettingsGroup>
  )
}
