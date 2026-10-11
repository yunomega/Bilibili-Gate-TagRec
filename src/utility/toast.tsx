import clsx from 'clsx'
import { APP_CLS_ROOT, OPERATION_FAIL_MSG, REQUEST_FAIL_MSG } from '$common'
import { clsZToast } from '$components/fragments'

// [tag-rec] 整文件重写 (票 UX-01): toast 改队列栈 —— 底部居中/上限 3 条/TTL 内同文案去重
/**
 * toast = 底部居中瞬态反馈 (票 UX-01 改版):
 * - 容器 pointer-events:none —— 堆叠层不挡页面点击;若未来 item 内挂按钮,给该按钮单独补 pointer-events:auto
 * - 向上堆叠 (新条压底,旧条上挤), 最多 3 条;第 4 条淘汰最旧项
 * - 去重: 相同文案在 TTL 内重发 => 不新增条目,只刷新存活期 + 移回栈底
 *   (一次操作连发同文案的典型场景: 批量按钮连点/同一路径重复报错)
 */
const MAX_VISIBLE = 3
const containerClass = clsx(
  APP_CLS_ROOT,
  'pointer-events-none fixed bottom-40px left-50% flex flex-col items-center gap-8px',
  clsZToast,
)
const itemClass = clsx(
  'max-w-450px min-w-200px w-[max-content] whitespace-pre-wrap rounded-6px bg-gate-primary px-24px py-12px text-14px text-white',
)
const itemSingleLineClass = 'text-center'

let stackEl: HTMLElement | undefined
const live = new Map<string, { el: HTMLElement; timer: ReturnType<typeof setTimeout> }>()

function ensureStack(): HTMLElement {
  if (stackEl && stackEl.isConnected) return stackEl
  stackEl = document.createElement('div')
  stackEl.className = containerClass
  document.body.appendChild(stackEl)
  return stackEl
}

function dismiss(key: string) {
  const slot = live.get(key)
  if (!slot) return
  clearTimeout(slot.timer)
  slot.el.remove()
  live.delete(key)
}

export default function toast(msg: string, duration = 2000, _container?: HTMLElement) {
  const stack = ensureStack()

  // 去重: 同文案在场 => 刷新 TTL + 移回栈底 (不新增)
  const hit = live.get(msg)
  if (hit) {
    clearTimeout(hit.timer)
    hit.timer = setTimeout(() => dismiss(msg), duration)
    stack.appendChild(hit.el) // re-append => 视觉上回到最新位 (栈底)
    return
  }

  // 上限: 淘汰最旧项 (DOM 序最前 = 栈顶最旧)
  while (stack.children.length >= MAX_VISIBLE) {
    const oldest = stack.firstElementChild as HTMLElement | null
    if (!oldest) break
    for (const [k, v] of live) {
      if (v.el === oldest) {
        clearTimeout(v.timer)
        live.delete(k)
        break
      }
    }
    oldest.remove()
  }

  const div = document.createElement('div')
  div.textContent = msg
  const isSingleLine = !msg.includes('\n') && !msg.includes('<br')
  div.className = clsx(itemClass, isSingleLine && itemSingleLineClass)
  stack.appendChild(div)

  live.set(msg, { el: div, timer: setTimeout(() => dismiss(msg), duration) })
}

export function toastRequestFail() {
  return toast(REQUEST_FAIL_MSG)
}

export function toastOperationFail() {
  return toast(OPERATION_FAIL_MSG)
}
