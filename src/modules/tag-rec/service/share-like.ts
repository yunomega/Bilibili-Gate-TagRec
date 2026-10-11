import { EApiType } from '$enums'
import toast from '$utility/toast'
import { fetchShareUploader, likeShare } from '../api/share'
import { resolveShareLikePrompt, SHARE_LIKE_MIN_RENDERED } from '../model/share'
import { tagRecSharedSession } from '../store/session'
import {
  clearPendingShareLike,
  markShareLiked,
  markShareLikeDismissed,
  readPendingShareLike,
  readShareLikeActed,
} from '../store/share-tokens'
import type { RecItemTypeOrSeparator } from '$define'

/**
 * [tag-rec] 回赞闭环编排 (tag-share-platform 票 19 / spec §6):
 * - 上屏观测: tab1 (TagRecFav) service.loadMore 实际返回切片累计非分隔符条数 =>
 *   达 SHARE_LIKE_MIN_RENDERED (=PAGE_SIZE 20) 评估一次回赞武装 —— 「实际渲染」口径即
 *   「经 qs 队列切片交付给 grid 的条目数」, 与 fetchMinCount/concat 消费同位, 不另立统计
 * - 触发 (一次性): pendingShareId 在 ∧ 未赞未拒 ∧ 条数够 => 武装 tagRecSharedSession.shareLike
 *   + 清 pendingShareId; 已赞/已拒命中 => 只清 pending (GM 记忆集永挡, 不再读账)
 * - 武装后横幅槽位消费 (ui/banner.tsx): 仅 state==='none' 且引导横幅不在时出 —— 与见底/
 *   池浅/引导横幅同槽互斥; 武装位留在会话态 (刷新丢, pending 已清 => 一次性语义成立)
 * - 模块级计数 (deliveredCount): 与 sharedSeenBvids/sharedBufferQueue 同层 —— service 重建
 *   (refresh/主题切换) 不丢, 「体验够 20 条」按会话累计而非单实例
 */

let deliveredCount = 0
let evalInFlight = false

/** tab1 loadMore 上屏观测点: 每条 fetch 落定调用 (空切片/undefined 不计); 分隔符不算「条」 */
export function noteShareLikeDelivered(items: RecItemTypeOrSeparator[] | undefined): void {
  if (items?.length) {
    for (const x of items) if (x.api !== EApiType.Separator) deliveredCount++
  }
  void evaluateShareLikeArm()
}

/**
 * 补评估入口 —— noteShareImportDone (pending 挂账) 后调:
 * 「先渲染满 20 条再导入」场景等不到下次 loadMore, 这里立即补一刀
 */
export function reevaluateShareLike(): void {
  void evaluateShareLikeArm()
}

/** 触发判定: 条数够 + pending 在 => 读记忆集归一 => 武装 or 命中清账; GM 读错峰闸防叠罗汉 */
async function evaluateShareLikeArm(): Promise<void> {
  if (evalInFlight) return
  if (deliveredCount < SHARE_LIKE_MIN_RENDERED) return
  if (tagRecSharedSession.shareLike) return // 已武装 (待显/在显)
  evalInFlight = true
  try {
    const pending = await readPendingShareLike()
    if (!pending) return
    const acted = await readShareLikeActed()
    const shareId = resolveShareLikePrompt({ pendingShareId: pending, renderedCount: deliveredCount, acted })
    if (shareId) {
      // R7 时序修复: 武装只置会话位, **不消费 pending** —— 显示后才由 act/dismiss 消费。
      //   旧实现武装即清账: 引导横幅占槽/会话丢失时回赞提示永久丢 (分享者白拿不到赞)
      tagRecSharedSession.shareLike = { shareId, busy: false }
      return
    }
    // 未武装 = 已赞/已拒命中 (记忆集永挡) => 清 pending (一次性语义只在此处成立)
    void clearPendingShareLike()
  } finally {
    evalInFlight = false
  }
}

/**
 * 横幅 [赞一个]: 登录态 mid (fetchShareUploader, 未登录 => toast 引导, 横幅留可重试)
 * => POST like => ok/already 皆算成功入已赞集 + toast;
 *   403(pending/removed)/404/429/网络错 => 安静收下 (轻 toast) 入已拒集防纠缠
 */
export async function actShareLike(): Promise<void> {
  const slot = tagRecSharedSession.shareLike
  if (!slot || slot.busy) return
  slot.busy = true
  try {
    const upRes = await fetchShareUploader()
    if (upRes.kind !== 'user') {
      // [tag-rec] UIUX-U1-8: 三态分流 —— 确认未登录出引导文案; 拉取失败出可重试文案 (横幅留可再点)
      toast(
        upRes.kind === 'not-logged-in' ? '未登录 B 站账号 —— 登录后才能给分享点赞' : '登录态读取失败, 请稍后重试',
        5000,
      )
      return // 横幅留: 登录后可重试, 或「不了」
    }
    const uploader = upRes.user
    const shareId = slot.shareId
    const res = await likeShare(shareId, uploader.mid)
    // 在途间用户点了「不了」(横幅已消) => 尊重裁量, 不覆写记忆集
    const still = tagRecSharedSession.shareLike === slot
    if (still) tagRecSharedSession.shareLike = undefined
    // R7: act 才消费 pending (武装不清账; 显示/操作后一次性收口)
    void clearPendingShareLike()
    if (res.kind === 'ok') {
      if (still) void markShareLiked(shareId)
      toast(res.already ? '之前已赞过 · 感谢支持' : '已赞, 感谢支持')
    } else {
      if (still) void markShareLikeDismissed(shareId)
      toast('点赞未成功 · 不再打扰', 3000)
    }
  } finally {
    slot.busy = false // slot 可能已摘出 session —— 写回仅防止复用残留, 无副作用
  }
}

/** 横幅 [不了]: share_id 入已拒集, 横幅消 (一次性, 永不再出); R7: 一并消费 pending */
export function dismissShareLike(): void {
  const shareId = tagRecSharedSession.shareLike?.shareId
  tagRecSharedSession.shareLike = undefined
  if (shareId) void markShareLikeDismissed(shareId)
  void clearPendingShareLike()
}

/** 测试用: 清模块级上屏计数/在飞闸 (等价整页重载) */
export function resetTagRecShareLikeState(): void {
  deliveredCount = 0
  evalInFlight = false
}
