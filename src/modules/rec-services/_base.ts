import { useCallback, useRef, type ReactNode } from 'react'
import { APP_CLS_TAB_BAR } from '$common'
import type { RecItemTypeOrSeparator } from '$define'

export type IService<T = RecItemTypeOrSeparator> = {
  hasMore: boolean
  autoLoadPaused?: boolean
  beginLoadOperation?: (signal: AbortSignal) => void
  endLoadOperation?: () => void
  loadMore: (abortSignal: AbortSignal) => Promise<T[] | undefined>
  tabbarView?: ReactNode
  sidebarView?: ReactNode // optional
}

export type ITabService = IService & {
  restore: () => void
  tabbarView: ReactNode // required, empty can be represented by `undefined`
}

export abstract class BaseTabService<T extends RecItemTypeOrSeparator = RecItemTypeOrSeparator> implements ITabService {
  abstract tabbarView: ReactNode
  abstract sidebarView?: ReactNode
  abstract hasMoreExceptQueue: boolean
  abstract fetchMore(abortSignal: AbortSignal): Promise<T[] | undefined>

  qs: QueueStrategy<T>
  constructor(qsPageSize: number) {
    this.qs = new QueueStrategy(qsPageSize)
  }

  get hasMore() {
    return !!this.qs.bufferQueue.length || this.hasMoreExceptQueue
  }

  restore(): void | Promise<void> {
    this.qs.restore()
  }

  async loadMore(abortSignal: AbortSignal): Promise<T[] | undefined> {
    if (!this.hasMore) return
    if (this.qs.bufferQueue.length) return this.qs.sliceFromQueue()

    // fill queue
    const more = await this.fetchMore(abortSignal)
    if (more?.length) this.qs.bufferQueue.push(...more)

    // slice from queue
    return this.qs.sliceFromQueue()
  }
}

export class QueueStrategy<T = RecItemTypeOrSeparator> {
  // full-list = returnQueue + bufferQueue + more
  private returnQueue: T[] = []
  bufferQueue: T[] = []

  get hasCache() {
    return !!this.returnQueue.length
  }

  ps: number
  constructor(ps = 20) {
    this.ps = ps
  }

  sliceCountFromQueue(count: number) {
    if (this.bufferQueue.length) {
      // [tag-rec] AUDIT-03: 原地 splice 而非 slice 重建 —— bufferQueue 可能是共享数组别名
      //   (tag-rec 票 37 跨刷新存货盒: `qs.bufferQueue = sharedBufferQueue`); 不可变切片会换新数组
      //   脱钩共享盒 → 共享盒冻结为「首轮全量快照」每次刷新原样端回旧货, 后续落货进死数组静默丢;
      //   原地移除对独占 qs 的 service 语义不变
      const sliced = this.bufferQueue.splice(0, count) // sliced
      return this.doReturnItems(sliced) ?? []
    } else {
      return []
    }
  }

  sliceFromQueue(page = 1) {
    return this.sliceCountFromQueue(this.ps * page)
  }

  // add to returnQueue
  doReturnItems(items: T[] | undefined) {
    this.returnQueue = [...this.returnQueue, ...(items ?? [])]
    return items
  }

  // restore from returnQueue
  restore() {
    // [tag-rec] AUDIT-03: 同型原地修复 —— unshift 回插而非整体重建, 共享别名不脱钩;
    //   分块倒序 unshift 防超大 returnQueue 摊平 spread 触参数上限, 且保持条序
    for (let i = this.returnQueue.length; i > 0; i -= 10_000) {
      this.bufferQueue.unshift(...this.returnQueue.slice(Math.max(0, i - 10_000), i))
    }
    this.returnQueue = []
  }

  get fetchedCount() {
    return this.returnQueue.length + this.bufferQueue.length
  }
}

export function usePopupContainer<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const getPopupContainer = useCallback(() => {
    return ref.current?.closest<T>(`.${APP_CLS_TAB_BAR}`)?.parentElement || document.body
  }, [])
  return { ref, getPopupContainer }
}
