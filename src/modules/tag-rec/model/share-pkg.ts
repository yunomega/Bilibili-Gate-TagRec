/**
 * [tag-rec] 试改版导入码 (票27: 网站「试改这份配置」→「导入我的修改版」的包移交格式)
 * —— 纯逻辑叶子模块 (编解码为纯计算, CompressionStream/DecompressionStream 浏览器与 node18+ 均原生)
 *
 * 导线格式 = `<mode>.<base64url>`:
 *   z = deflate-raw 压缩 JSON (首选); r = 未压缩 JSON (无 CompressionStream 环境的兜底, 解码两模都认)
 * 信封 = { v:1, sid?, title?, desc?, payload }:
 *   sid = 源分享 id (插件据此挂「待回赞」账 + 「打开原分享页」链; 不带则不挂)
 *   payload = 完整导出格式 v2 —— 语义终审在 parseTagRecConfig/planShareImport, 本层只管壳
 * 递送 = bilibili.com#tag-rec-pkg=<code> (URL fragment 不进 B 站服务端) ∪ 粘贴框手贴
 *
 * 与网站 tag-share-platform/site/edit.js 同格式双边维护 —— 改一处要同步另一处。
 */

export type SharePkgEnvelope = {
  v: 1
  /** 源分享 id (试改模板来源; 缺省 = 无出处可挂) */
  sid?: string
  title?: string
  desc?: string
  payload: unknown
}

const b64url = (u8: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCodePoint.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[])
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const unb64url = (s: string): Uint8Array | undefined => {
  try {
    const t = s.replaceAll('-', '+').replaceAll('_', '/')
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.codePointAt(i) ?? 0
    return u8
  } catch {
    return undefined
  }
}

const streamThrough = async (bytes: Uint8Array, ctor: 'deflate-raw', decompress: boolean): Promise<Uint8Array> => {
  const src = new Response(bytes.slice()).body! // slice(): Uint8Array<ArrayBuffer> —— BodyInit 只收 ArrayBuffer 档
  const out = decompress ? src.pipeThrough(new DecompressionStream(ctor)) : src.pipeThrough(new CompressionStream(ctor))
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/**
 * W4-5: 深链导入码解压界 —— `#tag-rec-pkg=` 由构造期自动消费, 恶意链接可远程触发:
 *   码长上限 ~512KB base64url (≈384KB 压缩体); 解压逐 chunk 计数, >8MB cancel
 *   (z 炸弹不复读全量驻内存)。r 档未压缩, 码长界已天然约束体积。
 */
const SHARE_PKG_CODE_MAX_LEN = 512 * 1024
const SHARE_PKG_JSON_MAX_BYTES = 8 * 1024 * 1024

/** 流式读尽 + 体积闸: 超限 cancel 返 undefined (替代 arrayBuffer() 的无界驻留) */
const readAllBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength ?? 0
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      if (value) chunks.push(value)
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return out
  } finally {
    reader.releaseLock()
  }
}

/** 信封 → 导入码 (z 档优先; CompressionStream 缺席退 r 档) */
export async function encodeSharePkgCode(env: SharePkgEnvelope): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(env))
  if (typeof CompressionStream === 'function') {
    try {
      return 'z.' + b64url(await streamThrough(bytes, 'deflate-raw', false))
    } catch {
      // Some implementations expose the API but do not support this format.
    }
  }
  return 'r.' + b64url(bytes)
}

/** 导入码 → 信封 (畸形/解码失败/超限/壳不合法 => undefined; payload 语义不在此层审) */
export async function decodeSharePkgCode(code: string): Promise<SharePkgEnvelope | undefined> {
  const text = String(code ?? '').trim()
  if (text.length > SHARE_PKG_CODE_MAX_LEN + 2) return undefined
  const m = /^([zr])\.([\w-]+)$/.exec(text)
  if (!m || m[2].length > SHARE_PKG_CODE_MAX_LEN) return undefined
  const bytes = unb64url(m[2])
  if (!bytes) return undefined
  try {
    const raw =
      m[1] === 'z'
        ? await readAllBounded(
            new Response(bytes.slice()).body!.pipeThrough(new DecompressionStream('deflate-raw')),
            SHARE_PKG_JSON_MAX_BYTES,
          )
        : bytes
    if (!raw) return undefined
    const env = JSON.parse(new TextDecoder().decode(raw)) as SharePkgEnvelope
    if (
      !env ||
      typeof env !== 'object' ||
      Array.isArray(env) ||
      env.v !== 1 ||
      !env.payload ||
      typeof env.payload !== 'object' ||
      Array.isArray(env.payload)
    )
      return undefined
    // Envelope metadata is untrusted: an object must never become a React child.
    return {
      v: 1,
      payload: env.payload,
      ...(typeof env.sid === 'string' && { sid: env.sid }),
      ...(typeof env.title === 'string' && { title: env.title }),
      ...(typeof env.desc === 'string' && { desc: env.desc }),
    }
  } catch {
    return undefined
  }
}

/**
 * 自由文本里的导入码探测 (粘贴框用): `tag-rec-pkg=<code>` 片段 (深链 hash 或裸参数) ∪ 裸码
 * (`z.|r.` 前缀 + ≥10 位 base64url —— 与 10 位分享 id 无交: id 不含 '.')。空手而归 => undefined
 */
export function extractSharePkgCode(text: string): string | undefined {
  const t = String(text ?? '').trim()
  if (!t) return undefined
  const param = t.match(/(?:^|[^\w-])tag-rec-pkg=([^\s&#]+)/)?.[1]
  if (param) {
    try {
      return decodeURIComponent(param)
    } catch {
      return param
    }
  }
  return /^[zr]\.[\w-]{10,}$/.test(t) ? t : undefined
}
