/*
 * 佛曰:
 *     写字楼里写字间，写字间里程序员；
 *     程序人员写程序，又拿程序换酒钱。
 *     酒醒只在网上坐，酒醉还来网下眠；
 *     酒醉酒醒日复日，网上网下年复年。
 *     但愿老死电脑间，不愿鞠躬老板前；
 *     奔驰宝马贵者趣，公交自行程序员。
 *     别人笑我忒疯癫，我笑自己命太贱；
 *     不见满街漂亮妹，哪个归得程序员？
 */

import '$common/global.scss' // styles
import '$components/shared.module.scss'
import '$components/RecGrid/video-grid.module.scss' // css modules 与 emtion 混用, 先 import 作为 base 的 css modules
import 'virtual:uno.css'
import '$modules/settings' // load config first
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'
import { IN_BILIBILI_HOMEPAGE, IN_BILIBILI_SEARCH_PAGE, IN_BILIBILI_SPACE_PAGE } from '$common'
import { initHomepage } from '$main/homepage'
import { IN_BILIBILI_VIDEO_PLAY_PAGE } from '$main/video-play-page/util'
import { perfMark } from '$utility/perf-mark' // [tag-rec] perf 打点, 须为首个 import (票 perf-01)

dayjs.extend(duration)

void (function main() {
  // [tag-rec] install-funnel 批2: tagrec.cn 全站握手
  //   脚本被注入任一 tagrec.cn 页面 = 已安装 —— 写 dataset 标记供页面轮询,随即早退,
  //   不跑任何 B 站初始化逻辑(@match 由构建配置侧提供;集市页靠此标记做「未装 → 回退安装向导」)
  if (location.hostname === 'www.tagrec.cn') {
    document.documentElement.dataset.tagrecInstalled = '1'
    window.dispatchEvent(new CustomEvent('tagrec-installed'))
    return
  }
  perfMark('main-enter') // [tag-rec] 模块图(含 TLA)求值完成点
  if (IN_BILIBILI_HOMEPAGE) return initHomepage()
  // [tag-rec] 票 perf-08: 非首页模块图惰性求值 —— SystemJS 单文件内 module.import 边界,
  // video/search/space 页面不再为首页图(RecHeader/RecGrid/services)付求值成本
  if (IN_BILIBILI_VIDEO_PLAY_PAGE) return import('$main/video-play-page').then((m) => m.initVideoPlayPage())
  if (IN_BILIBILI_SPACE_PAGE) return import('$main/space-page').then((m) => m.initSpacePage())
  if (IN_BILIBILI_SEARCH_PAGE) return import('$main/search-page').then((m) => m.initSearchPage())
})()
