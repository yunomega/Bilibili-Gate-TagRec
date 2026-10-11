import { ETab } from '$enums'

/**
 * [tag-rec] tab2「标签发掘」深链二级参数 (票 24; 纯逻辑叶子模块 —— 不 import $routes:
 * 其模块级 `new URL(location.href)` 快照会把浏览器 location 传递依赖进 node 测试)
 * - `?gate-tab=tag-rec-custom` 一级激活是 Gate 既有机制 (routes.tsx GateQueryKey.Tab →
 *   getEntryTab: tagrec 族只激活不收栏,tab 栏全量可见;非 tagrec 值仍走 getOnlyTab 单栏),
 *   参数名字面值在此镜像), 本文件补两个二级参数, 由 TagRecCustomService 构造函数消费后清参
 *   (实机修复: 曾挂 tabbar useMount+emit refresh, 撞 mount 'reuse' 在途的「同 tab 刷新中」守卫被丢)
 * - `tag-rec-input=<tag_name>` (收藏表点名等入口): 新 tab 以标签名直输查询 —— 走文本解析全管线
 *   (锚点+Phase2 候选+变体俱全; 实机裁决: 传名不传 id —— 数字 id 逃生口零解析但也跳过 Phase 2,
 *   新 tab 会是"退化"体验; 同名解析到不同 id 的碎片化边角按规范名语义接受)
 * - `tag-rec-new=<tag_name>&tag-rec-id=<id>` (弹层点 `#id`): 新 tab 落成「含该标签条件的新试验组合」
 *   —— 弹层已知 (id,name) 无需解析, 绕开输入管线直接成条件; id 缺/坏时回落 input 语义
 * - `tag-rec-group=<L2组id>` (★「新建收藏项」toast 动作, 票 20「选中并重开」改道): 新 tab 选定组语境
 * - 两参同现 => group 优先 (id 已在表内, 确定性强); 空值视同无参
 */

/** Gate 一级深链参数名 —— 同 routes.tsx GateQueryKey.Tab 字面值 (镜像, 见头注) */
const GATE_TAB_PARAM = 'gate-tab'

export enum TagRecDeepLinkParam {
  /** 预填临时输入 (tag_name 直输 —— 走文本解析全管线) */
  Input = 'tag-rec-input',
  /** 选定组语境 (L2 组 id) */
  Group = 'tag-rec-group',
  /** 新组合种子 (tag_name —— 试验显示名 + 条件显示名): 新 tab 落成含该标签的试验, 不走输入解析管线 */
  New = 'tag-rec-new',
  /** New 配套 tag_id —— 已知 id 零解析直接成条件原子; 缺/坏 => 回落 input 语义 */
  NewId = 'tag-rec-id',
  /** [tag-rec] 票 18 (tag-share): 分享导入 —— `?gate-tab=tag-rec-fav&tag-rec-share=<shareId>` (tab1 语境) */
  Share = 'tag-rec-share',
  /** 分享组子集: 逗号分隔 L2 组 id; 缺省 = 整包 (spec §6: >40 组网站侧不传此参) */
  Groups = 'tag-rec-groups',
  /** [tag-rec] 票 27 (tag-share): 试改版包 —— 走 `#tag-rec-pkg=<导入码>` fragment (不进 B 站服务端);
   *  编解码见 model/share-pkg.ts; 消费与清 hash 在 tag-rec-fav service 构造期 */
  Pkg = 'tag-rec-pkg',
}

/** `${origin}/?gate-tab=tag-rec-custom&…` 构造 (input 数/字符串皆可; group = L2 组 id) */
export function buildTagRecCustomDeepLink(
  origin: string,
  params: { input?: number | string; group?: string; seed?: { id: number; name: string } },
): string {
  const u = new URL('/', origin)
  u.searchParams.set(GATE_TAB_PARAM, ETab.TagRecCustom)
  if (params.input !== undefined && `${params.input}`.trim()) {
    u.searchParams.set(TagRecDeepLinkParam.Input, `${params.input}`)
  }
  if (params.group?.trim()) u.searchParams.set(TagRecDeepLinkParam.Group, params.group)
  if (params.seed && params.seed.name.trim() && Number.isFinite(params.seed.id)) {
    u.searchParams.set(TagRecDeepLinkParam.New, params.seed.name.trim())
    u.searchParams.set(TagRecDeepLinkParam.NewId, `${params.seed.id}`)
  }
  return u.href
}

/** `${origin}/?gate-tab=tag-rec-fav` —— tab1「主题推荐」深链 (主题跳转: 调用侧先 themes.setActive 再开新 tab) */
export function buildTagRecFavDeepLink(origin: string): string {
  const u = new URL('/', origin)
  u.searchParams.set(GATE_TAB_PARAM, ETab.TagRecFav)
  return u.href
}

export type TagRecDeepLinkTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'input'; input: string }
  | { kind: 'new'; id: number; name: string }

/**
 * 解析 location.search => 消费意图 + 待清参数名:
 * 任一二级参存在 => 四参都进 paramsToClear (残留参数一并清, 防刷新重放歧义);
 * 皆无 => target=undefined 且 paramsToClear=[]; 空值视同无参 (仍算「存在」进清参列表);
 * 优先级 group > new > input; new 缺/坏 id => 回落 input 语义 (名仍走解析管线)
 */
export function parseTagRecDeepLink(search: string): {
  target: TagRecDeepLinkTarget | undefined
  paramsToClear: TagRecDeepLinkParam[]
} {
  const sp = new URLSearchParams(search)
  const hasGroup = sp.has(TagRecDeepLinkParam.Group)
  const hasInput = sp.has(TagRecDeepLinkParam.Input)
  const hasNew = sp.has(TagRecDeepLinkParam.New)
  if (!hasGroup && !hasInput && !hasNew) return { target: undefined, paramsToClear: [] }
  const groupId = sp.get(TagRecDeepLinkParam.Group)?.trim()
  const input = sp.get(TagRecDeepLinkParam.Input)?.trim()
  const newName = sp.get(TagRecDeepLinkParam.New)?.trim()
  const newId = Number(sp.get(TagRecDeepLinkParam.NewId))
  const target: TagRecDeepLinkTarget | undefined = groupId
    ? { kind: 'group', groupId }
    : newName && Number.isInteger(newId) && newId > 0
      ? { kind: 'new', id: newId, name: newName }
      : (newName ?? input)
        ? { kind: 'input', input: (newName ?? input)! }
        : undefined
  return {
    target,
    paramsToClear: [
      TagRecDeepLinkParam.Group,
      TagRecDeepLinkParam.Input,
      TagRecDeepLinkParam.New,
      TagRecDeepLinkParam.NewId,
    ],
  }
}

// ———— 票 18 (tag-share): 分享导入深链二级参数 —— tab1 语境, 与上方 input/group 的 tab2 语义独立不混 ————

/**
 * `${origin}/?gate-tab=tag-rec-fav&tag-rec-share=<id>[&tag-rec-groups=<g1,g2,…>]` 构造
 * (网站「导入选中组」CTA 的目标形态, spec §6): shareId 空值不挂参 (防御); groups 经归一
 * (去空白/去重/丢空 token) 后逗号连, 空集不挂参 (缺省=整包)
 */
export function buildShareImportDeepLink(
  origin: string,
  params: { shareId: string; groups?: readonly string[] },
): string {
  const u = new URL('/', origin)
  u.searchParams.set(GATE_TAB_PARAM, ETab.TagRecFav)
  if (params.shareId.trim()) u.searchParams.set(TagRecDeepLinkParam.Share, params.shareId.trim())
  const groupIds = parseTagRecGroupIds(params.groups?.join(','))
  if (groupIds?.length) u.searchParams.set(TagRecDeepLinkParam.Groups, groupIds.join(','))
  return u.href
}

/** groups 参逗号串解析: 去空白/丢空 token/保序去重; 缺席或全空 => undefined (整包语义) */
export function parseTagRecGroupIds(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of raw.split(',')) {
    const id = token.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length ? out : undefined
}

/**
 * tab1 分享参解析 (与 parseTagRecDeepLink 的 tab2 语境独立 —— 各清各家参数):
 * - share/groups 任一存在 => 两参一并进 paramsToClear (残留一并清, 防刷新重放歧义)
 * - 空值视同无参但仍算「存在」进清参列表; shareId 空 => undefined (孤 groups 不触发导入)
 */
export function parseTagRecShareDeepLink(search: string): {
  shareId: string | undefined
  groupIds: string[] | undefined
  paramsToClear: TagRecDeepLinkParam[]
} {
  const sp = new URLSearchParams(search)
  const hasShare = sp.has(TagRecDeepLinkParam.Share)
  const hasGroups = sp.has(TagRecDeepLinkParam.Groups)
  if (!hasShare && !hasGroups) return { shareId: undefined, groupIds: undefined, paramsToClear: [] }
  // W6-10: shareId 形态白名单 = nanoid(10) (同 model/share.ts SHARE_ID_RE; 本文件刻意零依赖不引)
  const rawShareId = sp.get(TagRecDeepLinkParam.Share)?.trim()
  const shareId = rawShareId && /^[\w-]{10}$/.test(rawShareId) ? rawShareId : undefined
  return {
    shareId,
    groupIds: parseTagRecGroupIds(sp.get(TagRecDeepLinkParam.Groups)),
    paramsToClear: [TagRecDeepLinkParam.Share, TagRecDeepLinkParam.Groups],
  }
}

/**
 * 票 27 (tag-share): location.hash 里的试改版导入码 (`#tag-rec-pkg=<code>`)。
 * hash 与上方 query 参独立各清各家 —— 网站 fork 链 = `?gate-tab=tag-rec-fav#tag-rec-pkg=<code>`;
 * 返回原始码串 (百分号转义还原; 解码/校验在 model/share-pkg.ts 与 service 层)。
 */
export function parseTagRecPkgHash(hash: string): { code: string | undefined; hasPkg: boolean } {
  const m = new RegExp(`(?:^|#|&)${TagRecDeepLinkParam.Pkg}=([^\\s&#]*)`).exec(hash)
  if (!m) return { code: undefined, hasPkg: false }
  let code = m[1]
  try {
    code = decodeURIComponent(code)
  } catch {
    /* 保留原串, 解码层判畸形 */
  }
  return { code: code || undefined, hasPkg: true }
}
