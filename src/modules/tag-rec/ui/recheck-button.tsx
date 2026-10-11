import { Button, Modal, Select, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import toast from '$utility/toast'
import type { TagRecRecheckOption, TagRecRecheckResult, TagRecRecheckSelection } from '../service/recheck'

export function TagRecRecheckButton({
  service,
  onDone,
}: {
  service: {
    getRecheckOptions: () => TagRecRecheckOption[]
    recheck: (selection: TagRecRecheckSelection, signal?: AbortSignal) => Promise<TagRecRecheckResult>
  }
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<string>()
  const [running, setRunning] = useState(false)
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [service])
  const options = open ? service.getRecheckOptions() : []
  const selected = options.find((option) => option.value === value)
  return (
    <>
      <Button
        size='small'
        onClick={() => {
          setValue(undefined)
          setOpen(true)
        }}
      >
        定向重查
      </Button>
      <Modal
        title='选择重查范围'
        open={open}
        confirmLoading={running}
        okButtonProps={{ disabled: !selected }}
        onCancel={() => {
          controller.current?.abort()
          setOpen(false)
        }}
        okText='重查首屏'
        onOk={async () => {
          if (!selected || running) return
          setRunning(true)
          controller.current = new AbortController()
          try {
            const result = await service.recheck(selected, controller.current.signal)
            toast(
              result.stale
                ? '范围已改变或正在退避，本次结果未写入'
                : !result.requests
                  ? '此范围暂无可执行路径；推荐相关需要已有种子'
                  : `重查完成：${result.requests} 个请求，新增 ${result.added} 条${result.failed ? '，部分请求失败' : ''}`,
            )
            setOpen(false)
            if (!result.stale) onDone()
          } finally {
            controller.current = undefined
            setRunning(false)
          }
        }}
      >
        <Select
          className='w-full'
          disabled={running}
          showSearch
          options={options}
          value={value}
          onChange={setValue}
          optionFilterProp='label'
          placeholder='选择组、来源和检索词'
        />
        <Typography.Paragraph type='secondary' className='mt-12px'>
          每词只探测第一页，每次最多 4 个请求。保留已看、已交付、其他组库存和正常分页进度。
        </Typography.Paragraph>
      </Modal>
    </>
  )
}
