/**
 * [tag-rec] 采样视角: 'public'(默认)=anonymous+buvid 指纹公共池; 'account'=用户 cookie jar 画像视角。
 * api 层不 import $modules/settings (防模块环+测试环境 settings 需 DOM):
 * 由 store/index.ts 启动时同步初值并 subscribe 变更, 本文件只存内存态。
 */
export type TagRecSamplingView = 'public' | 'account'

let view: TagRecSamplingView = 'public'

export function getTagRecSamplingView(): TagRecSamplingView {
  return view
}

/** 归一入口: 任何非 'account' 值回落 'public', 旧持久化缺字段天然兼容 */
export function setTagRecSamplingView(v: unknown): void {
  view = v === 'account' ? 'account' : 'public'
}
