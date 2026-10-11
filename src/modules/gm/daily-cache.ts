import dayjs from 'dayjs'
import { appWarn } from '$common'

const genDate = () => dayjs().format('YYYY-MM-DD')

export function dailyCache<T>(namespace: string) {
  async function cleanUp() {
    // [tag-rec] AUDIT-30: 整体 try/catch + 逐键 deleteValue catch —— 原 fire-and-forget 下
    // listValues 异常成 unhandled rejection; 日界在 listValues 落定后取 + 只删严格更旧键,
    // 跨零点子秒窗不误删刚写入的新日键
    try {
      const keys = await GM.listValues()
      const today = genDate()
      const prefix = `${namespace}:`
      for (const k of keys) {
        if (k.startsWith(prefix) && k.slice(prefix.length) < today) {
          void Promise.resolve(GM.deleteValue(k)).catch(() => undefined)
        }
      }
    } catch (e) {
      appWarn('dailyCache cleanUp failed:', namespace, e)
    }
  }

  // cleanup for first time
  void cleanUp()

  return {
    async set(val: T) {
      void cleanUp()
      await GM.setValue(`${namespace}:${genDate()}`, val)
    },
    get(): Promise<T | undefined> {
      void cleanUp()
      return GM.getValue(`${namespace}:${genDate()}`)
    },
  }
}
