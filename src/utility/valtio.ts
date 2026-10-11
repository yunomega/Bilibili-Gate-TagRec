// [tag-rec] GM 水合/回放重构 (proxyWithGmStorageLazy/proxyMapWithGmStorageLazy 等自有件全在本文件)
import { Result } from 'better-result'
import { isEqual, isNil, pick, throttle } from 'es-toolkit'
import { proxy, ref, snapshot, subscribe, useSnapshot } from 'valtio'
import { proxyMap, proxySet } from 'valtio/utils'
import { APP_NAME, APP_NAMESPACE, appWarn } from '$common'
import { reciveGmValueUpdatesFromOtherTab } from '$modules/gm'
import type { ReactNode } from 'react'

export function valtioFactory<T>(computeValue: () => T, { equals }: { equals?: (prev: T, next: T) => boolean } = {}) {
  const state = proxy({ value: computeValue() })

  function use() {
    return useSnapshot(state).value
  }

  function get() {
    return state.value
  }

  function update() {
    const next = computeValue()
    if (equals?.(state.value, next)) return state.value
    return (state.value = next)
  }

  const updateThrottled = throttle(update, 100, { edges: ['leading', 'trailing'] })

  return { state, use, get, update, updateThrottled }
}

export function subscribeOnKeys<T extends object>(state: T, keys: (keyof T)[], callback: (newState: T) => void) {
  let prevVal = pick(snapshot(state) as T, keys)

  subscribe(state, () => {
    const snap = snapshot(state)
    const val = pick(snap as T, keys)
    if (!isEqual(prevVal, val)) {
      callback(snap as T)
    }
    prevVal = val
  })
}

export function proxyWithLocalStorage<T extends object>(initialVaue: T, storageKey: string) {
  if (!storageKey.startsWith(APP_NAME)) storageKey = `${APP_NAMESPACE}:${storageKey}`

  const allowedKeys = Object.keys(initialVaue)
  const loadResult = Result.try(() => {
    const str = localStorage.getItem(storageKey)
    if (!str) return
    const obj = JSON.parse(str) as any
    return pick(obj, allowedKeys)
  })
  let savedValue = undefined
  if (loadResult.isErr()) {
    appWarn('failed to load from localStorage key=', storageKey, 'error=', loadResult.error.cause)
  } else {
    savedValue = loadResult.value
  }

  const p = proxy<T>({ ...initialVaue, ...savedValue })

  // start subscribe in nextTick, so value can be changed synchronously without persist
  setTimeout(() => {
    subscribe(p, () => {
      const val = snapshot(p)
      localStorage.setItem(storageKey, JSON.stringify(val))
    })
  })

  return p
}

/**
 * GM 落盘合并器 (深挖期写风暴泛化修复 —— video-tags-store 的裸 Map+防抖已证同型问题):
 * 每次 mutation 各写一笔 => 全量 snapshot+GM.setValue 成本 × mutation 数, 沉淀池/已看集这类
 * 批量写入 (一轮数百上千次) 会把主线程+IPC 打满。改为: 首变立即写 (leading, 离散动作零延迟),
 * 窗口内后续变更合并, 两笔写间保底 MIN_INTERVAL (trailing 收束, 写时读最新 snapshot 天然并批)。
 */
const GM_FLUSH_MIN_INTERVAL_MS = 500

function createGmWriteCoalescer(write: () => void | Promise<unknown>) {
  let pending = false
  let writing = false
  let lastWriteAt = 0
  // [tag-rec] AUDIT-24: epoch 随远端回放推进 —— flush 等窗口期间若回放接管内存基线, armed 批在写点作废
  let epoch = 0
  const flush = async () => {
    if (writing) return
    writing = true
    let retried = false // AUDIT-23: 每轮 flush 至多自动重试一次, GM 持续故障不空转死循环
    try {
      while (pending) {
        pending = false
        const myEpoch = epoch
        const wait = GM_FLUSH_MIN_INTERVAL_MS - (Date.now() - lastWriteAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        if (epoch !== myEpoch) continue // 等待窗内远端已应用 => 本批基于旧快照, 跳过 (新 mutation 会另 arm)
        lastWriteAt = Date.now()
        try {
          await write()
        } catch (e) {
          // [tag-rec] AUDIT-23: 写失败重武装 pending —— 全量覆写语义下, 下轮/下次 mutation 的快照自带本批重发
          pending = true
          if (retried) break
          retried = true
          appWarn('GM write failed, batch kept pending for retry:', e)
        }
      }
    } finally {
      writing = false
    }
  }
  return {
    markDirty: () => {
      pending = true
      void flush()
    },
    // [tag-rec] AUDIT-24: 远端回放是整图 replace —— 应用后 armed 批只剩「把远端态写回远端」的纯回声,
    // 作废不丢数据 (本地增量本就被 replaceAllWith 抹平, 属 LWW 语义内取舍)
    disarmPending: () => {
      pending = false
      epoch++
    },
  }
}

/**
 * GM 可用性闸: 测试/异常环境无 GM => fail-open (空水合/不落盘), 不产未处理拒绝。
 * 读失败 (GM 存在但 getValue reject) 降级空水合并 appWarn —— 与集群内各 store 的
 * fail-open 纪律一致; 写路径的拒绝不回吞 —— coalescer 靠 rejection 重武装 (AUDIT-23)。
 */
function gmGet(key: string): Promise<unknown> {
  try {
    if (typeof GM === 'undefined' || !GM.getValue) return Promise.resolve(undefined)
    return Promise.resolve(GM.getValue(key)).catch((e) => {
      appWarn(`${APP_NAMESPACE} gm getValue failed (${key}): %o`, e)
      return undefined
    })
  } catch {
    return Promise.resolve(undefined)
  }
}
function gmSet(key: string, value: unknown): Promise<void> {
  if (typeof GM === 'undefined' || !GM.setValue) return Promise.resolve()
  return GM.setValue(key, value)
}

/**
 * [tag-rec] perf 票 03: 同步骨架 + 后台水合变体 —— GM.getValue 退出模块顶层 await
 * - 返回骨架 proxy 立即可用, `hydrated` = 装载完成信号; 消费方靠 valtio 响应式接住回填,
 *   必须读到真值的链路 (如 service 构造期深链消费/语境签名) await `hydrated`
 * - 回填用 persist 门抑制落盘回声: subscribe 若已挂载, 水合引发的变更不写回 GM
 */
export function proxyWithGmStorageLazy<T extends object>(initialVaue: T, storageKey: string) {
  async function load() {
    const allowedKeys = Object.keys(initialVaue)
    return pick(((await gmGet(storageKey)) || {}) as any, allowedKeys)
  }
  const p = proxy<T>({ ...initialVaue })
  let persist = true

  // A4-8: 远端回放按「顶层键 LWW」应用 —— 与写侧 `{...existing, ...snapshot}` 顶层键覆盖语义对齐;
  //   远端缺键不动本地 (分不出「未写」与「删除」), 恒等键跳过收敛跨 tab 回声链
  const replaceRemoteKeys = (remote: Record<string, unknown>) => {
    const prec = p as Record<string, unknown>
    for (const k of Object.keys(initialVaue)) {
      if (!(k in remote)) continue
      if (!isEqual(prec[k], remote[k])) prec[k] = remote[k]
    }
  }

  const { markDirty, disarmPending } = createGmWriteCoalescer(async () => {
    const existing = await load()
    // AUDIT-01: 顶层浅合并替代 toMerged —— toMerged 对数组按下标深合并 + target 尾部保留 +
    // undefined 不覆盖: 删除/清空/重排永不落盘, 中段删错位合并造同 id 畸形条目, delete 键回魂。
    // 浅合并顶层键整体覆盖 (数组整列替换); existing 仅兜底其它写入方留下的顶层键
    // (load 已 pick allowedKeys; A4-8 远端回放为顶层键 LWW 同口径)
    // AUDIT-23: 不 void —— 拒绝须回传给 coalescer 重武装重试 (无 GM 时 gmSet 静默成功: 无可落)
    await gmSet(storageKey, { ...existing, ...(snapshot(p) as T) })
  })

  // AUDIT-07(c) 脏比对基线: 必须深快照 —— p 由 {...initialVaue} 浅拷贝而来,
  // 数组/对象值与 initialVaue 共享同一份基对象, 直比 initialVaue 会把本地写判成「未脏」
  const initialSnapshot = structuredClone(initialVaue) as Record<string, unknown>

  // AUDIT-07(b): 回放先于水合落定 => 已应用的远端快照更新, 陈旧水合行须整个丢弃
  let remoteApplied = false

  // A4-8: 远端监听构造期同步注册 (AUDIT-07(a) 同型) —— favorites/l1/themes/settings 等对象型
  //   store 原本无回放, 双窗并发编辑 markDirty 整键 LWW 互覆静默丢编辑
  reciveGmValueUpdatesFromOtherTab<Record<string, unknown>>({
    storageKey,
    setPersist: (val) => (persist = val),
    onUpdate: (remote) => {
      remoteApplied = true
      disarmPending() // AUDIT-24: 远端接管基线 => armed 批作废, 防把远端态回声写回
      replaceRemoteKeys(remote ?? {})
    },
  })

  const hydrated = load().then((loaded) => {
    if (remoteApplied) return // AUDIT-07(b): 回放已就位 => 丢弃较旧水合快照
    // AUDIT-07(c): 水合窗口内本地写按脏键回放 —— 与初值快照逐键比对记脏, loaded 铺底后
    // 脏键覆盖回去: 数组脏键做「远端铺底 + 本地独有追加」深等并集 (两端的行都不丢), 标量脏键本地优先。
    // (直接 p 读回的值是 proxy/冻结 snapshot, 塞回语义不干净 —— 先 snapshot 再 structuredClone
    //  得普通可变克隆, 与 GM 往返序列化同口径)
    const cur = structuredClone(snapshot(p)) as Record<string, unknown>
    const loadedRec = loaded as Record<string, unknown>
    const overlay: Record<string, unknown> = {}
    for (const [k, initVal] of Object.entries(initialSnapshot)) {
      const local = cur[k]
      if (isEqual(local, initVal)) continue // 未脏
      const remote = loadedRec[k]
      overlay[k] =
        Array.isArray(local) && Array.isArray(remote)
          ? [...remote, ...local.filter((x) => !remote.some((y) => isEqual(y, x)))]
          : local
    }
    const dirty = Object.keys(overlay).length > 0
    persist = false
    try {
      Object.assign(p, loaded, overlay)
    } finally {
      // AUDIT-02: subscribe 回调是微任务派发 (gm/index.ts applyPending 同范式) ——
      // persist 复位也走微任务排在 valtio flush 之后, 同步复位会让回填 mutation
      // 被 listener 看到 persist=true → 每 store 回声写一笔全量 + 跨 tab 广播
      void Promise.resolve().then(() => {
        persist = true
        if (dirty) markDirty() // 重放进内存的本地写补一笔落盘 (水合回填自身仍由 persist 门挡回声)
      })
    }
  })

  // start subscribe in nextTick, so value can be changed synchronously without persist
  setTimeout(() => {
    subscribe(p, () => {
      if (!persist) return
      markDirty()
    })
  })

  return { proxy: p, hydrated }
}

export async function proxyWithGmStorage<T extends object>(initialVaue: T, storageKey: string) {
  const { proxy: p, hydrated } = proxyWithGmStorageLazy(initialVaue, storageKey)
  await hydrated
  return p
}

export function proxySetWithGmStorageLazy<T>(storageKey: string) {
  const load = async (): Promise<T[]> => ((await gmGet(storageKey)) as T[] | undefined) || []
  const p = proxySet<T>()
  const replaceAllWith = (newVal: Iterable<T>) => {
    const newSet = new Set(newVal)
    for (const x of [...p, ...newSet]) {
      if (!newSet.has(x)) {
        if (p.has(x)) p.delete(x)
      } else if (!p.has(x)) {
        p.add(x)
      } // 恒等条目跳过 —— 远端无变化应用不产生 mutation, 跨 tab 回声链收敛
    }
  }

  let persist = true
  // AUDIT-07(b): 回放先于水合落定 => 已应用的远端快照更新, 陈旧水合行须整个丢弃
  let remoteApplied = false
  const { markDirty, disarmPending } = createGmWriteCoalescer(() =>
    // AUDIT-23: 返回 setValue promise —— 拒绝回传 coalescer 重武装重试 (void 会变 unhandled rejection)
    gmSet(storageKey, Array.from(snapshot(p))),
  )

  // AUDIT-07(a): 远端监听在构造期同步注册 (不再随 setTimeout 延迟) ——
  // 关掉「getValue 发出 → 监听器就位」间隙的远端写静默丢窗口
  reciveGmValueUpdatesFromOtherTab<T[]>({
    storageKey,
    setPersist: (val) => (persist = val),
    onUpdate: (rows) => {
      remoteApplied = true
      disarmPending() // AUDIT-24: 远端接管基线 => armed 批作废, 防把远端态回声写回
      replaceAllWith(rows)
    },
  })

  const hydrated = load().then((rows) => {
    if (remoteApplied) return // AUDIT-07(b): 回放已就位 => 丢弃较旧水合快照
    // AUDIT-07(c): 骨架为空, 水合前 p 内条目均为窗口内本地写 —— loaded 铺底后逐条补回并补落盘
    const localItems = [...p]
    let replayed = false
    persist = false // 水合回填不触发落盘回声
    try {
      replaceAllWith(rows)
      for (const x of localItems) {
        if (!p.has(x)) {
          p.add(x)
          replayed = true
        }
      }
    } finally {
      // AUDIT-02: subscribe 回调微任务派发, persist 复位须排在 valtio flush 之后 (gm applyPending 同范式)
      void Promise.resolve().then(() => {
        persist = true
        if (replayed) markDirty()
      })
    }
  })

  // start subscribe in nextTick, so value can be changed synchronously without persist
  setTimeout(() => {
    subscribe(p, () => {
      if (!persist) return
      markDirty()
    })
  })

  // p is sealed, can't be modified
  return {
    set: p,
    replaceAllWith,
    hydrated,
  }
}

export async function proxySetWithGmStorage<T>(storageKey: string) {
  const { hydrated, ...rest } = proxySetWithGmStorageLazy<T>(storageKey)
  await hydrated
  return rest
}

export function proxyMapWithGmStorageLazy<K, V>(
  storageKey: string,
  {
    beforeLoad,
    beforeSave,
  }: {
    beforeLoad?: (loaded: [K, V][]) => [K, V][] // loaded from storage
    beforeSave?: (vals: [K, V][]) => [K, V][] // save to storage
  } = {},
) {
  const load = async (): Promise<[K, V][]> => ((await gmGet(storageKey)) as [K, V][] | undefined) || []
  const p = proxyMap<K, V>()
  const replaceAllWith = (newVal: Iterable<[K, V]>) => {
    const newMap = new Map(newVal)
    for (const [k, v] of [...p, ...newMap]) {
      if (!newMap.has(k)) {
        if (p.has(k)) p.delete(k)
      } else if (!isEqual(p.get(k), v)) {
        p.set(k, v)
      } // 恒等条目跳过 —— 远端无变化应用不产生 mutation, 跨 tab 回声链收敛
    }
  }

  let persist = true
  // AUDIT-07(b): 回放先于水合落定 => 已应用的远端快照更新, 陈旧水合行须整个丢弃
  let remoteApplied = false
  const { markDirty, disarmPending } = createGmWriteCoalescer(() => {
    let val = Array.from(snapshot(p))
    if (beforeSave) val = beforeSave(val)
    // AUDIT-23: 返回 setValue promise —— 拒绝回传 coalescer 重武装重试 (void 会变 unhandled rejection)
    return gmSet(storageKey, val)
  })

  // reload when other tab change storage value
  // AUDIT-07(a): 远端监听在构造期同步注册 (不再随 setTimeout 延迟) ——
  // 关掉「getValue 发出 → 监听器就位」间隙的远端写静默丢窗口
  reciveGmValueUpdatesFromOtherTab<[K, V][]>({
    storageKey,
    setPersist: (val) => (persist = val),
    onUpdate: (rows) => {
      remoteApplied = true
      disarmPending() // AUDIT-24: 远端接管基线 => armed 批作废, 防把远端态回声写回
      replaceAllWith(rows)
    },
  })

  const hydrated = load()
    .then((rawLoaded) => (beforeLoad ? beforeLoad(rawLoaded) : rawLoaded))
    .then((rows) => {
      if (remoteApplied) return // AUDIT-07(b): 回放已就位 => 丢弃较旧水合快照
      // AUDIT-07(c): 骨架为空, 水合前 p 内条目均为窗口内本地写 —— loaded 铺底后逐键补回并补落盘
      const localEntries = [...p]
      let replayed = false
      persist = false // 水合回填不触发落盘回声
      try {
        replaceAllWith(rows)
        for (const [k, v] of localEntries) {
          if (!isEqual(p.get(k), v)) {
            p.set(k, v)
            replayed = true
          }
        }
      } finally {
        // AUDIT-02: subscribe 回调微任务派发, persist 复位须排在 valtio flush 之后 (gm applyPending 同范式)
        void Promise.resolve().then(() => {
          persist = true
          if (replayed) markDirty()
        })
      }
    })

  // start subscribe in nextTick, so value can be changed synchronously without persist
  setTimeout(() => {
    subscribe(p, () => {
      if (!persist) return
      markDirty()
    })
  })

  return {
    map: p,
    replaceAllWith,
    hydrated,
  }
}

export async function proxyMapWithGmStorage<K, V>(
  storageKey: string,
  options: {
    beforeLoad?: (loaded: [K, V][]) => [K, V][] // loaded from storage
    beforeSave?: (vals: [K, V][]) => [K, V][] // save to storage
  } = {},
) {
  const { hydrated, ...rest } = proxyMapWithGmStorageLazy<K, V>(storageKey, options)
  await hydrated
  return rest
}

export function refReactNode(node: ReactNode) {
  if (isNil(node)) return node
  if (typeof node !== 'object') return node
  return ref(node)
}
