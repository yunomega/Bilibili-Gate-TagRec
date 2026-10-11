/**
 * [tag-rec] perf 打点 (票 perf-01): 启动链分段测量
 * - mark 无条件记 (开销≈0, 生产可留); 字节数测量仅 `perfprobe=1` URL 参数时启用 (JSON.stringify 有成本)
 * - 读数: performance.getEntriesByType('mark') 过滤 'gate:' 前缀
 */
const probed = typeof location !== 'undefined' && location.href.includes('perfprobe=1') // vitest node 环境无 location => 关字节测量

export function perfMark(name: string, detail?: Record<string, number>) {
  try {
    performance.mark(`gate:${name}`, detail ? { detail } : undefined)
  } catch {
    /* detail 序列化失败不阻塞主流程 */
  }
}

export function perfMarkBytes(name: string, entries: () => Record<string, string>) {
  if (!probed) return
  const bytes: Record<string, number> = {}
  for (const [k, v] of Object.entries(entries())) bytes[k] = v.length
  perfMark(name, bytes)
}

// 模块体即打点: 作为 index.ts 首个 import, 本行=模块图求值最早可观测点
perfMark('eval-start')
