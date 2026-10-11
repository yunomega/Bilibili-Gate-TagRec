export enum ScriptManager {
  Userscripts = 'Userscripts',
  Violentmonkey = 'Violentmonkey',
}

export const RUNNING_IN_USERSCRIPTS =
  typeof GM_info !== 'undefined' && GM_info.scriptHandler === ScriptManager.Userscripts
export const RUNNING_IN_VIOLENTMONKEY =
  typeof GM_info !== 'undefined' && GM_info.scriptHandler === ScriptManager.Violentmonkey

export function openNewTab(url: string, active = true) {
  if (url.startsWith('/')) url = location.origin + url // safari Userscripts will complain with pathname only

  if (RUNNING_IN_USERSCRIPTS) {
    // https://github.com/quoid/userscripts?tab=readme-ov-file#api
    GM.openInTab(url, !active)
    return
  }

  GM.openInTab(url, {
    active,
    insert: true,
    setParent: true,
  })
}

/**
 * [tag-rec] perf 票 10: 远端回放接收端 —— 冷启窗口隔离 + 连击 drain-to-latest
 * (票 07 实测裁决落码: N=3 双写源时回放回声令新 tab 首卡 +1.1s/+33%, LoAF blocking 翻倍)
 * - 回放语义本就是全量 replaceAllWith, 中间快照无价值 => 待应用槽位只留最新一份
 * - 冷启窗 (`gate:mounted` mark 打出前, 点位见 main/homepage/index.tsx) 只攒不放,
 *   mount 后一次应用 —— 回放不与水合/模块求值抢主线程;
 *   video/space/search/浮钮态主页等无 `gate:mounted` 的页面由 MAX 兜底, 窗口必然结束
 */
const GM_REPLAY_MERGE_MS = 100 // 常态连击合并窗口: 窗口内到达的同键回放合并为最新一笔
const GM_REPLAY_COLD_START_POLL_MS = 200 // 冷启窗内 mounted mark 探测周期
const GM_REPLAY_COLD_START_MAX_MS = 15_000 // 无 `gate:mounted` 页面的冷启兜底上限

function inGmReplayColdStartWindow() {
  try {
    return performance.getEntriesByName('gate:mounted').length === 0 && performance.now() < GM_REPLAY_COLD_START_MAX_MS
  } catch {
    return false // 无 performance/mark 能力的环境 => 不隔离, 维持原行为
  }
}

export function reciveGmValueUpdatesFromOtherTab<T>({
  storageKey,
  onUpdate,
  setPersist,
}: {
  storageKey: string
  onUpdate: (newValue: T) => void
  setPersist: (val: boolean) => void
}) {
  // check if script manager support this API
  // safari Userscripts has only `GM.` API, this API is only available on `GM_`
  if (typeof GM_addValueChangeListener === 'undefined') return

  // [tag-rec] 票 perf-10: drain-to-latest —— pendingValue 为待应用槽位, 永远只放最新快照;
  // 单 timer 调度: 冷启窗内按 POLL 续约等 mounted, 常态按 MERGE 窗口收拢连击后一次应用
  let pendingValue: T | undefined
  let timer: ReturnType<typeof setTimeout> | null = null

  const applyPending = () => {
    if (pendingValue === undefined) return
    const newValue = pendingValue
    pendingValue = undefined
    setPersist(false)
    try {
      onUpdate(newValue)
    } finally {
      // https://github.com/pmndrs/valtio/blob/v2.1.2/src/vanilla.ts#L294
      // subscribe() is using microtask to call it's callback
      // so we also use a microtask to set `persist = true` is safe
      void Promise.resolve().then(() => {
        setPersist(true)
      })
    }
  }

  const scheduleFlush = () => {
    if (timer !== null) return
    timer = setTimeout(
      () => {
        timer = null
        if (inGmReplayColdStartWindow()) {
          if (pendingValue !== undefined) scheduleFlush() // 冷启未完: 续约, 快照槽继续只留最新
          return
        }
        applyPending()
      },
      inGmReplayColdStartWindow() ? GM_REPLAY_COLD_START_POLL_MS : GM_REPLAY_MERGE_MS,
    )
  }

  GM_addValueChangeListener<T>(storageKey, (name, oldValue, newValue, remote) => {
    if (!remote) return
    if (!newValue) return
    pendingValue = newValue
    scheduleFlush()
  })
}
