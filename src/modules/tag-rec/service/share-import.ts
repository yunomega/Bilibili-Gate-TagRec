import { ref } from 'valtio'
import toast from '$utility/toast'
import { getShareDetail, TAG_REC_SHARE_SITE_BASE } from '../api/share'
import { parseTagRecConfig } from '../model/import-export'
import {
  buildSharePageUrl,
  isShareFactoryFilterConfig,
  planShareImport,
  SHARE_ID_RE,
  type ShareImportDraft,
} from '../model/share'
import { decodeSharePkgCode } from '../model/share-pkg'
import { blacklist, favorites, favoritesL1Store, themesStore } from '../store'
import { tagRecSharedSession } from '../store/session'
import { rememberPendingShareLike } from '../store/share-tokens'

/**
 * [tag-rec] 分享导入编排 (tag-share-platform 票 18 / spec §6) —— 深链消费与粘贴导入共用管线:
 *   shareId(+可选 groups 子集) => GET /api/shares/:id => payload 过 parseTagRecConfig 归一 =>
 *   planShareImport 出预览计划 => 写 tagRecSharedSession.shareImport.draft (ref 脱壳) =>
 *   ui/share-import-modal 双挂载点 (tabbar-fav / pane) 按 origin 渲预览 Modal
 * - 票 27 试改版包同走此管线 (requestShareImportPkg): 导入码解出信封 => payload 进同一归一/计划/Modal
 * - 失败全走 toast 不崩 service 构造 (404 = 「分享不存在或已下架」固定文案, 余者兜底文案)
 * - seq 令牌: 后发的请求/关闭动作顶替前发 (防 pane 开着时旧请求落定抢弹)
 */

let shareImportSeq = 0
let shareImportController: AbortController | undefined

/**
 * 公共落定: 归一化后的包体 → 预览计划 → draft。远端详情与本地包解出后同走此径;
 * 失败 toast 已发; seq 已被顶替则落定丢弃。meta 见 ShareImportDraft 元信息位 (key/title/isPkg/sid…)。
 */
function settleImportDraft(
  seq: number,
  payload: unknown,
  groupIds: readonly string[] | undefined,
  meta: Omit<ShareImportDraft, 'plan' | 'missingGroupCount' | 'hasSubset' | 'filterConfig'>,
): void {
  if (seq !== shareImportSeq) return
  const parsed = parseTagRecConfig(JSON.stringify(payload))
  if (!parsed.ok) {
    toast(`分享内容无法解析: ${parsed.reason}`, 5000)
    return
  }
  const { plan, missingGroupCount } = planShareImport({
    payload: parsed.data,
    requestedGroupIds: groupIds,
    existing: {
      favorites: favorites.list,
      blacklist: blacklist.list,
      l1: favoritesL1Store.list,
      themes: themesStore.list,
    },
  })
  if (seq !== shareImportSeq) return
  // 票26: 包内携带真实私配 (非出厂占位) 才随 draft 带过滤配置, Modal 裁决区据此出「带入」勾选
  const fc = parsed.data.filterConfig
  tagRecSharedSession.shareImport.draft = ref<ShareImportDraft>({
    ...meta,
    plan,
    missingGroupCount,
    hasSubset: !!groupIds?.length,
    ...(fc && !isShareFactoryFilterConfig(fc) ? { filterConfig: fc } : {}),
  })
}

export async function requestShareImport(
  shareId: string,
  groupIds: readonly string[] | undefined,
  origin: 'deeplink' | 'paste',
): Promise<void> {
  const seq = ++shareImportSeq
  shareImportController?.abort()
  shareImportController = undefined
  const si = tagRecSharedSession.shareImport
  si.loading = true
  si.origin = origin
  si.draft = undefined
  try {
    const controller = new AbortController()
    shareImportController = controller
    const res = await getShareDetail(shareId, { signal: controller.signal })
    if (seq !== shareImportSeq) return // 被新请求/取消顶替 => 落定丢弃
    if (res.kind === 'not-found') {
      toast('分享不存在或已下架', 5000)
      return
    }
    if (res.kind === 'failed') {
      toast(`分享加载失败: ${res.message}`, 5000)
      return
    }
    const detail = res.detail
    settleImportDraft(seq, detail.payload, groupIds, {
      key: `${detail.id}:${seq}`,
      shareId: detail.id,
      title: detail.title,
      nickname: detail.nickname,
      mid: detail.mid,
      likesCount: detail.likesCount,
      ...(detail.description && { description: detail.description }),
      siteUrl: buildSharePageUrl(TAG_REC_SHARE_SITE_BASE, detail.id),
    })
  } catch {
    if (seq === shareImportSeq) toast('分享导入失败，请检查内容或稍后重试', 5000)
  } finally {
    if (seq === shareImportSeq) {
      si.loading = false
      shareImportController = undefined
    }
  }
}

/**
 * 票 27 (tag-share) 试改版包导入 —— 与上方同管线, 差异只在包体来源:
 *   导入码(decodeSharePkgCode 出信封 {v:1,sid?,title?,desc?,payload}) => 同归一/计划/Modal;
 *   无服务端拉取 => 无昵称/mid/赞数; 信封带 sid 时照常挂「待回赞」账与「打开原分享页」链
 */
export async function requestShareImportPkg(code: string, origin: 'deeplink' | 'paste'): Promise<void> {
  const seq = ++shareImportSeq
  shareImportController?.abort()
  shareImportController = undefined
  const si = tagRecSharedSession.shareImport
  si.loading = true
  si.origin = origin
  si.draft = undefined
  try {
    const env = await decodeSharePkgCode(code)
    if (seq !== shareImportSeq) return
    if (!env) {
      toast('导入码无法识别或已损坏', 5000)
      return
    }
    settleImportDraft(seq, env.payload, undefined, {
      key: `pkg:${seq}`,
      isPkg: true,
      title: env.title || '我的试改版',
      // W6-2: 信封 sid 零信任 —— 非 nanoid(10) 形态即弃 (恶意包可替任意分享挂回赞账/造死链)
      ...(env.sid &&
        SHARE_ID_RE.test(env.sid) && {
          shareId: env.sid,
          siteUrl: buildSharePageUrl(TAG_REC_SHARE_SITE_BASE, env.sid),
        }),
      ...(env.desc && { description: env.desc }),
    })
  } catch {
    if (seq === shareImportSeq) toast('分享导入失败，请检查内容或稍后重试', 5000)
  } finally {
    if (seq === shareImportSeq) {
      si.loading = false
      shareImportController = undefined
    }
  }
}

/** Modal 关闭/新请求顶替: 清草稿+loading; seq++ 使在途请求落定丢弃 (防旧包落定抢弹) */
export function closeShareImportDraft(): void {
  shareImportSeq++
  shareImportController?.abort()
  shareImportController = undefined
  const si = tagRecSharedSession.shareImport
  si.loading = false
  si.draft = undefined
  si.origin = undefined
}

/**
 * 导入成功收尾 (Modal 确认后调):
 * - 挂「待回赞」账 (票 19 横幅消费位 —— 深链来的人点过赞后引导其回赞)
 * - 武装导入信息横幅 (R7: 每次导入出, 会话级; 携带包内 L1/主题供文案与 [只看这个包的主题]);
 *   不传 pkg = 不武装 (旧调用/测试兼容)
 */
export function noteShareImportDone(
  shareId: string | undefined,
  pkg?: { l1Ids: readonly string[]; themeIds: readonly string[] },
): void {
  if (shareId) void rememberPendingShareLike(shareId) // 票27: 试改版信封无 sid 时不挂回赞账
  if (pkg) tagRecSharedSession.shareGuide = { l1Ids: [...pkg.l1Ids], themeIds: [...pkg.themeIds] }
  // 票 19 (tag-share): 「先渲染满 20 条再导入」场景等不到下次 loadMore —— 补评估一刀 (懒载同簇)
  void import('./share-like').then((m) => m.reevaluateShareLike()).catch(() => undefined)
}

/** 导入信息横幅确认/关闭: 清会话位 (R7: 会话级一次性 —— 不再写 GM 已阅, 每次导入都出信息型) */
export function dismissShareImportGuide(): void {
  tagRecSharedSession.shareGuide = undefined
}
