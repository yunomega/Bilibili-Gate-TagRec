import { appWarn } from '$common'
import {
  normalizeShareLikeActed, // [tag-rec] 票 19: 回赞记忆集
  upsertShareLikeActed, // [tag-rec] 票 19
  type ShareLikeActed, // [tag-rec] 票 19
  type ShareTokenMap,
  type ShareTokenRecord,
} from '../model/share'

/**
 * [tag-rec] 分享管理 token 账本 (tag-share-platform spec §5 / 票 16)
 * - 每个 shareId 使用独立 GM key，避免并发上传互相覆盖；旧整表只作兼容读取
 * - token 为上传响应明文下发一次的管理凭证 (服务端只存 sha256); 丢失不可找回 —— Modal 风险告知明示
 * - 读写失败 fail-open (记 warn 吞错): 上传已成功但记账失败时用户仍拿到 toast 里的链接;
 *   「我的分享」列表 (后续票) 与 PATCH/DELETE 走此账本
 * - 写入无需先读账本；删除写 null，覆盖旧整表中同 ID 的记录
 */
const SHARE_TOKENS_KEY = 'tag-rec:share-tokens'
const SHARE_TOKEN_PREFIX = 'tag-rec:share-token:'
const shareTokenKey = (id: string) => SHARE_TOKEN_PREFIX + encodeURIComponent(id)

/** 兼容旧整表：读失败不妨碍新独立记录的读取和写入。 */
async function loadMap(): Promise<ShareTokenMap | undefined> {
  try {
    const v = await GM.getValue<ShareTokenMap>(SHARE_TOKENS_KEY, {})
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (e) {
    appWarn('[tag-rec] share-tokens read failed:', e)
    return undefined
  }
}

export async function readShareTokens(): Promise<ShareTokenMap> {
  // 兼容旧整表；独立记录覆盖旧条目，null 墓碑防止已删除的旧记录复活。
  const map = (await loadMap()) ?? {}
  const out: ShareTokenMap = { ...map }
  try {
    const keys = (await GM.listValues()).filter((key) => key.startsWith(SHARE_TOKEN_PREFIX))
    await Promise.all(
      keys.map(async (key) => {
        try {
          const id = decodeURIComponent(key.slice(SHARE_TOKEN_PREFIX.length))
          const rec = await GM.getValue<ShareTokenRecord | null>(key)
          if (rec === null) delete out[id]
          else if (
            rec &&
            typeof rec.token === 'string' &&
            typeof rec.title === 'string' &&
            Number.isFinite(rec.createdAt)
          ) {
            Object.defineProperty(out, id, { value: rec, enumerable: true, configurable: true, writable: true })
          }
        } catch (e) {
          appWarn('[tag-rec] share-token record read failed:', e)
        }
      }),
    )
  } catch (e) {
    appWarn('[tag-rec] share-token records read failed:', e)
  }
  return out
}

/** 上传成功后独立记账；写失败沿用现有静默降级。 */
export async function rememberShareToken(shareId: string, rec: ShareTokenRecord): Promise<void> {
  try {
    await GM.setValue(shareTokenKey(shareId), { ...rec })
  } catch (e) {
    appWarn('[tag-rec] share-tokens write failed:', e)
  }
}

/** 「我的分享」删除后摘账 (票 13 PATCH/DELETE 链路预留) */
export async function forgetShareToken(shareId: string): Promise<void> {
  try {
    await GM.setValue(shareTokenKey(shareId), null)
  } catch (e) {
    appWarn('[tag-rec] share-tokens write failed:', e)
  }
}

// #region 票 18: 回赞占位 + 导入引导已阅 (spec §6)
/**
 * `tag-rec:share-pending-like` —— 深链/粘贴导入成功后挂账的「待回赞」shareId;
 * 票 19 横幅消费 (打开分享页点过赞 => 清账)。GM 单值, 写失败静默 (同账本 fail-open)
 */
const PENDING_LIKE_KEY = 'tag-rec:share-pending-like'

export async function rememberPendingShareLike(shareId: string): Promise<void> {
  try {
    await GM.setValue(PENDING_LIKE_KEY, shareId)
  } catch (e) {
    appWarn('[tag-rec] share-pending-like write failed:', e)
  }
}

export async function readPendingShareLike(): Promise<string | undefined> {
  try {
    const v = await GM.getValue<unknown>(PENDING_LIKE_KEY)
    return typeof v === 'string' && v ? v : undefined
  } catch (e) {
    appWarn('[tag-rec] share-pending-like read failed:', e)
    return undefined
  }
}

export async function clearPendingShareLike(): Promise<void> {
  try {
    await GM.deleteValue(PENDING_LIKE_KEY)
  } catch (e) {
    appWarn('[tag-rec] share-pending-like clear failed:', e)
  }
}

/**
 * `tag-rec:share-guide-seen` —— 「勾选想看的主题/组」引导横幅已阅标记;
 * 一次性语义: 导入成功 => 置会话 flag (已阅则不出), 确认/关闭 => 写已阅 + 清 flag
 */
const SHARE_GUIDE_KEY = 'tag-rec:share-guide-seen'

export async function isShareGuideSeen(): Promise<boolean> {
  try {
    return (await GM.getValue<unknown>(SHARE_GUIDE_KEY)) === true
  } catch (e) {
    appWarn('[tag-rec] share-guide-seen read failed:', e)
    return true // 读失败 => 当已阅 (防每次重启冒引导)
  }
}

export async function markShareGuideSeen(): Promise<void> {
  try {
    await GM.setValue(SHARE_GUIDE_KEY, true)
  } catch (e) {
    appWarn('[tag-rec] share-guide-seen write failed:', e)
  }
}
// #endregion

// #region 票 19: 回赞已赞/已拒记忆集 (spec §6「两集命中都不再打扰 会话内+跨会话」)
/**
 * `tag-rec:share-like-acted` —— {liked:string[], dismissed:string[]}
 * - liked: 「赞一个」成功 (服务端幂等 ok/already 皆算); dismissed: 「不了」或点赞失败安静收下
 * - 两集命中任一 => 回赞横幅永不再出; GM 清空 => 可再出 (可接受, 同账本清空语义)
 * - 读写失败 fail-open (同账本口径): 读败 => 空集 (多冒一次横幅, 不误锁), 写败静默
 */
const SHARE_LIKE_ACTED_KEY = 'tag-rec:share-like-acted'

/** 内部读: 读失败 => undefined (同 loadMap 口径 —— 写路径据此拒写防空覆写); 存值畸形 => 归一空集 */
async function loadShareLikeActed(): Promise<ShareLikeActed | undefined> {
  try {
    const v = await GM.getValue<unknown>(SHARE_LIKE_ACTED_KEY)
    return normalizeShareLikeActed(v)
  } catch (e) {
    appWarn('[tag-rec] share-like-acted read failed:', e)
    return undefined
  }
}

export async function readShareLikeActed(): Promise<ShareLikeActed> {
  return (await loadShareLikeActed()) ?? { liked: [], dismissed: [] }
}

/** 入集 (后动作者赢: 对侧集摘除 —— upsertShareLikeActed 纯变换); 读/写失败静默 */
async function actShareLikeId(shareId: string, set: 'liked' | 'dismissed'): Promise<void> {
  try {
    const acted = await loadShareLikeActed()
    if (acted === undefined) return
    await GM.setValue(SHARE_LIKE_ACTED_KEY, upsertShareLikeActed(acted, shareId, set))
  } catch (e) {
    appWarn('[tag-rec] share-like-acted write failed:', e)
  }
}

/** 「赞一个」成功 => 入已赞集 (服务端幂等: ok/already 皆算成功) */
export async function markShareLiked(shareId: string): Promise<void> {
  await actShareLikeId(shareId, 'liked')
}

/** 「不了」/ 点赞失败安静收下 => 入已拒集 (防纠缠永不再出) */
export async function markShareLikeDismissed(shareId: string): Promise<void> {
  await actShareLikeId(shareId, 'dismissed')
}
// #endregion
