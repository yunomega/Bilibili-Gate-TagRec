import {
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState, type Key } from 'react'
import { useSnapshot } from 'valtio'
import IconLucideFolderOpen from '~icons/lucide/folder-open.jsx'
import IconLucideFolder from '~icons/lucide/folder.jsx'
import IconTablerBuildingStore from '~icons/tabler/building-store.jsx'
import { APP_NAME } from '$common'
import { HelpInfo } from '$components/_base/HelpInfo'
import { SettingsGroup, sharedClassNames } from '$components/ModalSettings/tab-panes/shared'
import { hideModalSettings } from '$components/RecHeader/modals'
import { videoSourceTabState } from '$components/RecHeader/tab'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import { ETab } from '$enums'
import { antModal } from '$modules/antd'
import { AntdTooltip } from '$modules/antd/custom'
import { IconForConfig } from '$modules/icon'
import { settings } from '$modules/settings'
import toast from '$utility/toast'
import { TAG_REC_SHARE_SITE_BASE } from '../api/share' // [tag-rec] 集市入口 = 分享平台同域
import { hasTagRecCombination, nameTagRecCombination } from '../model/combination'
import { buildTagRecCustomDeepLink, buildTagRecFavDeepLink } from '../model/deeplink'
import { groupNegativeTagIds, groupState, TagGroupStateLabel } from '../model/favorites'
import { computeTagRecFilterSignature, hasTagRecGroupConfig } from '../model/filter-engine'
import {
  mergeTagRecConfigExports,
  parseTagRecConfig,
  planTagRecImport,
  serializeTagRecConfig,
  stringifyTagRecConfig,
  type TagRecConfigExportV1,
  type TagRecImportPlan,
} from '../model/import-export'
import { normalizeTagName, resolveCandidateRows, type CandidateRow } from '../model/resolve'
import { expandShareSelection, extractShareImportFromText } from '../model/share' // [tag-rec] 票 16/18 (tag-share)
import { tagRecViewScopeLegacyActiveTheme, type TagRecViewScope } from '../model/view-scope'
import { unitsFingerprint, withTagRecGroupScope, withTagRecTempEnables } from '../service/deck'
import { requestShareImport, requestShareImportPkg } from '../service/share-import' // [tag-rec] 票 18/27 (tag-share)
import {
  blacklist,
  blacklistStore,
  favorites,
  favoritesL1,
  favoritesL1Store,
  favoritesStore,
  sediment,
  themes,
  themesStore,
  viewScope,
  viewScopeStore,
} from '../store'
import { applyTagRecImport } from '../store/apply-import' // [tag-rec] 票 18 (tag-share): 与分享导入共用的落表门面
import { tagRecCombinationBlocks } from '../store/combination-blocks'
import { tagRecSharedSession } from '../store/session' // [tag-rec] 票 18 (tag-share)
import { TagRecCandidatePickList } from './candidate-list'
import { CandidateResolvePicker } from './candidate-resolve-picker'
import { TagRecGroupConfigModal, type TagRecGroupConfigTarget } from './group-config-modal'
import { TagRecMySharesModal } from './my-shares-modal' // [tag-rec] 票 17 (tag-share)
import { TagRecRecoverySettings } from './recovery-actions'
import { TagRecShareImportModal } from './share-import-modal' // [tag-rec] 票 18 (tag-share)
import { TagRecShareModal } from './share-modal' // [tag-rec] 票 16 (tag-share)
import type { ColumnsType } from 'antd/es/table'
import type { TagGroup, TagL1Group, TagTheme } from '../model/types'

/**
 * [tag-rec] 「标签收藏」pane (spec §5.1) —— 本特性管理中枢
 * - 收藏表 = antd Table 分组行 (票 17): L1 标题行(折叠/改名/weight/enabled 批量入堆开关/麾下聚合小字)
 *   票 25: L1 行 tag_id 数/所属一级组两列语义不适用 => colSpan 并进组名列(长名不竖排), 行右端显「N 组 · M 个 id · K 负向」
 *   票 26: L1 行另有「所属主题」列 (主题 = L1 归属筛子, tab1 一键切换工作集; L2 行本列留空)
 *   + 其下 L2 组行原样: [勾选] 组名行内编辑 | tag_id 数徽标 | 所属一级组指认 | weight 0~5 步进 | enabled 开关 | 操作
 * - 三态呈现: enabled=false 整行置灰; weight=0 行尾「挂起」徽标; 正常无标; L1 停用 => 麾下子树一并灰化
 * - 展开行 = 组内 tag_id 芯片 (name 即深链跳 tab2, 不渲 #id/tag_type 徽标; 每 id「移到…」下拉)
 *   + 尾部「添加变体」(解析管线→候选清单勾进本组) /「重新挖掘变体」(disabled 占位·票 08)
 *   + 票 29「批量选择」开关: 开启后点 chip 切选中态, 选中>0 出「移到组…/复制到组…/删除」(Modal+Select 选目标 L2)
 * - 票 31: L1/L2 行统一复选 (L1 勾选 = 整棵子树, 麾下 L2 复选 disabled 灰显; 混选 = 并入/移动禁+提示)
 *   + 吸顶操作条 sticky 于面板滚动容器 (非全局 fixed): 「并入…」/「移到一级组…」/「启用/停用」/「删除」
 * - 集市入口常显；推荐记录可直接清空；JSON 备份折叠；危险区仅保留清空收藏表。
 * - JSON 导入 = 预览 Modal 先行: 冲突组 (共享正向 id / 组 id 撞车) 逐条交用户裁量
 *   (并入宿主/保留两份/跳过), filterConfig 覆盖改为勾选确认 (feat: 不再静默出双份)
 * - 面板路径与 tab2 同管线同写沉淀 (§3.5); 不变式皆在 store 门面层强制执行
 */
export function TabPaneTagFavorites() {
  /** 导入预览草稿 (feat4): plan 算好后不直接落表, Modal 列冲突 + 裁量 + filterConfig 勾选;
      批量导入时 data = mergeTagRecConfigExports 合成件, fileCount/failed 供预览播报 */
  const [importDraft, setImportDraft] = useState<{
    data: TagRecConfigExportV1
    plan: TagRecImportPlan
    fileCount?: number
    failed?: string[]
  }>()
  /** 冲突逐条裁量: group.id => merge=并入 hits[0] / keep=保留两份 / skip=跳过 */
  const [importChoices, setImportChoices] = useState<Record<string, 'merge' | 'keep' | 'skip'>>({})
  const [importApplyFilter, setImportApplyFilter] = useState(true)

  /**
   * 票 43: 资格指纹比对法 refresh —— pane 随设置 modal 卸载时, 挂载期指纹 vs 卸载期指纹不同
   *   (主题归属/层级/三态/tag_ids/导入 任一变更) => emit refresh 一次性重抽 feed;
   *   比对法而非动作打点: 任何编辑入口自动覆盖, 名/负向等不入指纹的编辑不触发重抽
   *   (pane 在 RecHeader=>RecSelf 树内, emitter 与 RecGrid 监听同根)
   */
  const { recSharedEmitter } = useRecSelfContext()
  // [tag-rec] AUDIT-37: 指纹初值懒算 —— useRef(exp) 的参数每 render 都求值 (仅首 render 留存),
  //   unitsFingerprint 是 O(L1+L2×ids) 全表映射+排序; 改 useState 懒初值只算一次
  const effectiveFingerprint = () =>
    unitsFingerprint(
      withTagRecGroupScope(favorites.list, viewScope.viewedGroupIds(), tagRecSharedSession.tempEnabledGroupIds),
      withTagRecTempEnables(favoritesL1.list, tagRecSharedSession.tempEnabledL1Ids),
      viewScope.viewedL1Ids(),
    )
  const [fpOnMount] = useState(effectiveFingerprint)
  // AUDIT-A4-4: 过滤签名同款懒初值 —— 负向/strict/overrides/全局维编辑不入资格指纹,
  //   原卸载比对放走这类收紧变更 (存货不重滤); 双签名任一漂移即 emit
  const [fsOnMount] = useState(() =>
    computeTagRecFilterSignature({ core: settings.tagRec.filter, groups: favorites.list, l1s: favoritesL1.list }),
  )
  useEffect(
    () => () => {
      const fpNow = effectiveFingerprint()
      const fsNow = computeTagRecFilterSignature({
        core: settings.tagRec.filter,
        groups: favorites.list,
        l1s: favoritesL1.list,
      })
      if (fpNow !== fpOnMount || fsNow !== fsOnMount) recSharedEmitter.emit('refresh', 'refresh')
    },
    [recSharedEmitter, fpOnMount, fsOnMount],
  )

  /**
   * 「导入 JSON」: 解析+计划后不直接落表 —— 弹「导入预览」Modal (feat: 冲突交用户裁量);
   *   默认裁量: 同源实体 (组 id 撞车) 或正向 id 被宿主全覆盖 => 「并入宿主」, 部分重叠 => 「保留两份」;
   *   支持多选批量: 逐个解析 (坏件列名跳过不拦好件), 合成单件后走同一预览管线 (mergeTagRecConfigExports)
   */
  const onImportJson = async () => {
    const files = await chooseFiles('.json')
    if (!files.length) return
    const datas: TagRecConfigExportV1[] = []
    const failed: string[] = []
    for (const f of files) {
      const res = parseTagRecConfig(await f.text())
      if (res.ok) datas.push(res.data)
      else failed.push(`${f.name}: ${res.reason}`)
    }
    if (!datas.length) return toast(`导入失败: ${failed[0] ?? '未选择有效文件'}`, 5000)
    const data = mergeTagRecConfigExports(datas)
    const plan = planTagRecImport(data, {
      favorites: favorites.list,
      blacklist: blacklist.list,
      l1: favoritesL1Store.list,
      themes: themesStore.list,
    })
    const choices: Record<string, 'merge' | 'keep' | 'skip'> = {}
    for (const c of plan.conflicts) {
      const covered = c.group.tag_ids.every((e) => c.hits[0].shared.includes(e.id))
      choices[c.group.id] =
        c.group.combination || favorites.list.find((g) => g.id === c.hits[0].id)?.combination
          ? 'keep'
          : c.hits[0].sameEntity || covered
            ? 'merge'
            : 'keep'
    }
    setImportChoices(choices)
    setImportApplyFilter(true)
    setImportDraft({ data, plan, fileCount: files.length, failed })
  }

  /** 「导入预览」确认: 按逐条裁量落表 —— 写侧收口 store/apply-import.ts (票 18: 与分享导入共用) */
  const confirmImport = () => {
    const d = importDraft
    setImportDraft(undefined)
    if (!d) return
    const res = applyTagRecImport({
      plan: d.plan,
      filterConfig: d.data.filterConfig,
      choices: importChoices,
      applyFilterConfig: importApplyFilter, // 含 presets 整体覆盖 (勾选制, feat: 不静默)
    })
    const invalid = d.plan.invalidGroups.length ? `; ${d.plan.invalidGroups.length} 组无效未入` : ''
    const synthesized = d.plan.synthesizedThemes ? `, 其中 ${d.plan.synthesizedThemes} 个为悬挂引用合成` : ''
    toast(
      `已导入 ${res.themesAdded} 主题${synthesized} / ${res.l1Added} 一级组 / ${res.added} 组新入` +
        `${res.merged ? ` / ${res.merged} 组并入既有` : ''}${res.skipped ? ` / ${res.skipped} 组跳过` : ''}` +
        ` / 黑名单 ${res.blacklistAdded} 项${res.filterApplied ? ' / 过滤配置已覆盖' : ''}${invalid}`,
      5000,
    )
  }

  /**
   * 票 18/27 (tag-share)「粘贴分享链接/id/导入码」: 自由文本 extractShareImportFromText 判别 —
   *   share = shareId(+groups 子集) 走 requestShareImport; pkg = 试改版导入码走 requestShareImportPkg;
   *   同一管线汇流进预览 Modal (origin='paste' 挂载点)
   */
  const [shareLinkText, setShareLinkText] = useState('')
  const shareImportSi = useSnapshot(tagRecSharedSession).shareImport
  const onImportShareLink = () => {
    const found = extractShareImportFromText(shareLinkText)
    if (!found) return toast('未识别到分享链接、分享 ID 或导入码', 4000)
    setShareLinkText('')
    if (found.kind === 'pkg') void requestShareImportPkg(found.code, 'paste')
    else void requestShareImport(found.shareId, found.groupIds, 'paste')
  }

  // [tag-rec] 票 17 (tag-share): 「我的分享」本地记账管理 Modal (GM tag-rec:share-tokens 列表 + PATCH/DELETE)
  const [mySharesOpen, setMySharesOpen] = useState(false)
  // 票 31 (tag-share): dup-check「更新原分享」定位行 —— share-modal 经 FavoritesSection prop 链回调至此
  const [mySharesFocus, setMySharesFocus] = useState<string | undefined>(undefined)

  /** 「导出 JSON」: {version:1, themes, activeThemeId, l1, favorites, blacklist, filterConfig} 打包; seen/沉淀不进导出 (§6.1) */
  const onExportJson = () => {
    const data = serializeTagRecConfig({
      combinationExclusions: tagRecCombinationBlocks.list,
      themes: themesStore.list,
      activeThemeId: viewScope.legacyActiveThemeId(), // R7: 查看范围推导 (恰好只看单主题 => 该 id)
      l1: favoritesL1Store.list,
      favorites: favoritesStore.list,
      blacklist: blacklistStore.list,
      filterConfig: settings.tagRec.filter, // 快照含自定义 presets (serialize 内深拷贝脱 proxy)
    })
    downloadTextFile(
      `${APP_NAME}-tag-rec-config ${dayjs().format('YYYY-MM-DD HH-mm-ss')}.json`,
      stringifyTagRecConfig(data),
      'application/json',
    )
  }

  return (
    <div className={sharedClassNames.tabPane}>
      {/* 标签组集市置顶 (收藏多时底部工具区要滚到底才够得着): 逛站 → 复制链接/ID → 粘贴导入同管线 */}
      <SettingsGroup title='标签组集市'>
        <div className={sharedClassNames.settingsLine}>
          <AntdTooltip title='浏览/导入别人分享的标签组'>
            <Button type='primary' href={TAG_REC_SHARE_SITE_BASE} target='_blank'>
              <IconTablerBuildingStore />
              去逛集市
            </Button>
          </AntdTooltip>
          <Input
            className='max-w-320px'
            placeholder='粘贴分享链接、分享 ID 或试改版导入码'
            value={shareLinkText}
            allowClear
            onChange={(e) => setShareLinkText(e.target.value)}
            onPressEnter={onImportShareLink}
          />
          <Button onClick={onImportShareLink} loading={shareImportSi.loading && shareImportSi.origin === 'paste'}>
            导入分享
          </Button>
          {/* [tag-rec] 票 17 (tag-share): 「我的分享」— GM 记账列表 (打开分享页/改标题描述/删除) */}
          <Button onClick={() => setMySharesOpen(true)}>
            <IconTablerListDetails />
            我的分享
          </Button>
        </div>
        <Typography.Text type='secondary' className='text-12px'>
          「标签组集市」= 分享平台 (tagrec.cn), 挑中的分享复制链接/ID 回右侧粘贴即可; 收整段深链/分享页链接/裸分享 ID
          (动态里贴的链接也可), 含 tag-rec-groups 子集参时只列指定组
        </Typography.Text>
      </SettingsGroup>

      <SettingsGroup
        title={
          <>
            标签收藏表
            <HelpInfo>
              行=标签组: 一个收藏项可挂多个 tag_id 覆盖同义变体; 跨组 id 重复合法。
              <br />
              一级组启用后，按二级组各自的开关与权重参与推荐。一级组旁的「＋ 二级组」可先建空组，再添加标签。
              <br />
              主题与一级组归属可直接切换或新建；权重和简介在行内编辑。勾选后可移动、合并、分享和批量启停。
              <br />
              主题筛选只查找表格行；「用此筛选看推荐」才应用临时范围。临时选择不会改保存开关，显式保存开关优先。
              <br />
              展开行含「负向成员」位: 负向 tag 经池交集/名匹配过滤本组流, 严格校验开关另逐条核查 (默认关)。
              <br />
              三态: 正常(weight≥1 入抽) / 挂起(weight=0, 仅「标签发掘」手动可选) / 停用(enabled=false, 两 tab 皆不可用)
            </HelpInfo>
          </>
        }
      >
        <FavoritesSection
          onOpenMyShares={(shareId) => {
            // 票 31 (tag-share): share-modal dup-check 命中行「更新原分享」→ 开本 Modal 并定位该行
            setMySharesFocus(shareId)
            setMySharesOpen(true)
          }}
        />
      </SettingsGroup>

      <TagRecRecoverySettings />

      {/* 工具区 (spec §6): JSON 三件打包备份迁移; 导入经预览 Modal 冲突裁量 (feat: 不静默双份);
          票 18 (tag-share): 粘贴分享链接/id => 与深链同一预览管线 */}
      <details className='mt-16px b-1px b-gate-border rounded-8px b-solid p-12px'>
        <summary className='cursor-pointer text-13px'>备份与导入 · JSON</summary>
        <SettingsGroup title='工具'>
          <div className={sharedClassNames.settingsLine}>
            <Button onClick={onImportJson}>
              <IconTablerFileImport />
              导入 JSON
            </Button>
            <Button onClick={onExportJson}>
              <IconTablerFileExport />
              导出 JSON
            </Button>
          </div>
          <Typography.Text type='secondary' className='text-12px'>
            JSON = 收藏表+黑名单+过滤配置三件打包, 支持多选批量导入 (跨文件同组自动去重); 导入先出预览:
            冲突组可选并入宿主/保留两份/跳过, 过滤配置勾选覆盖 (多文件取最后一份)
          </Typography.Text>
        </SettingsGroup>
      </details>

      {/* 删除收藏需要确认，观察记录的清理入口常显在「推荐记录」。 */}
      <details className='mt-10px b-1px b-gate-border rounded-8px b-solid p-12px'>
        <summary className='cursor-pointer text-13px'>删除收藏数据</summary>
        <SettingsGroup title='危险区'>
          <DangerZoneSection />
        </SettingsGroup>
      </details>

      {/* feat4: 导入预览 —— 冲突组逐条裁量 (并入宿主/保留两份/跳过); filterConfig 覆盖勾选制 */}
      <Modal
        title='导入预览'
        open={!!importDraft}
        onCancel={() => setImportDraft(undefined)}
        onOk={confirmImport}
        okText='应用导入'
        width={560}
      >
        {importDraft && (
          <div className='max-h-60vh overflow-y-auto'>
            <Typography.Text className='text-12px'>
              {(importDraft.fileCount ?? 1) > 1 ? `已选 ${importDraft.fileCount} 个文件; ` : ''}
              将新增 {importDraft.plan.themesToAdd.length} 主题 / {importDraft.plan.l1ToAdd.length} 一级组 /{' '}
              {importDraft.plan.favoritesToAdd.length} 标签组 / 黑名单 {importDraft.plan.blacklistToAdd.length} 项
              {importDraft.plan.synthesizedThemes
                ? ` (其中 ${importDraft.plan.synthesizedThemes} 个主题为悬挂引用合成)`
                : ''}
              {importDraft.plan.invalidGroups.length ? `; ${importDraft.plan.invalidGroups.length} 组无效未入` : ''}
            </Typography.Text>
            {!!importDraft.failed?.length && (
              <Typography.Text type='warning' className='mt-6px block text-12px'>
                {importDraft.failed.length} 个文件解析失败已跳过: {importDraft.failed.join('；')}
              </Typography.Text>
            )}
            {importDraft.plan.conflicts.length > 0 && (
              <div className='mt-10px'>
                <div className='flex items-center gap-x-8px'>
                  <Typography.Text strong className='text-13px'>
                    {importDraft.plan.conflicts.length} 个组与既有收藏冲突
                  </Typography.Text>
                  <Select
                    size='small'
                    className='w-128px'
                    placeholder='批量设为…'
                    value={null}
                    onChange={(v: 'merge' | 'keep' | 'skip' | null) => {
                      if (!v) return
                      setImportChoices(Object.fromEntries(importDraft.plan.conflicts.map((c) => [c.group.id, v])))
                    }}
                    options={[
                      { value: 'merge', label: '全部并入宿主' },
                      { value: 'keep', label: '全部保留两份' },
                      { value: 'skip', label: '全部跳过' },
                    ]}
                  />
                </div>
                {importDraft.plan.conflicts.map((c) => (
                  <div key={c.group.id} className='mt-6px flex items-center gap-x-8px'>
                    <span className='min-w-0 flex-1'>
                      <Typography.Text ellipsis={{ tooltip: c.group.name }}>{c.group.name}</Typography.Text>
                      <Typography.Text type='secondary' className='block text-12px'>
                        {c.hits[0].sameEntity ? '组 id 同源撞车 · ' : ''}与「{c.hits[0].name}」共享{' '}
                        {c.hits[0].shared.length} 个 tag_id
                        {c.hits.length > 1 ? ` (另命中 ${c.hits.length - 1} 组)` : ''}
                      </Typography.Text>
                    </span>
                    <Select
                      size='small'
                      className='w-128px shrink-0'
                      value={importChoices[c.group.id] ?? 'keep'}
                      onChange={(v) =>
                        setImportChoices((prev) => ({ ...prev, [c.group.id]: v as 'merge' | 'keep' | 'skip' }))
                      }
                      options={[
                        { value: 'merge', label: '并入宿主' },
                        { value: 'keep', label: '保留两份' },
                        { value: 'skip', label: '跳过不入' },
                      ]}
                    />
                  </div>
                ))}
                <Typography.Text type='secondary' className='mt-6px block text-12px'>
                  并入宿主 = 正/负向成员与名单并入命中组 (宿主已有配置保留, 缺的槽位领养入档值); 保留两份 = 照常入表
                  (跨组共享 tag_id 本就合法); 跳过 = 该组不入
                </Typography.Text>
              </div>
            )}
            <Checkbox
              className='mt-10px'
              checked={importApplyFilter}
              onChange={(e) => setImportApplyFilter(e.target.checked)}
            >
              覆盖当前过滤配置 (文件含 filterConfig: 阈值/名单/预设整套; 多文件取末份)
            </Checkbox>
          </div>
        )}
      </Modal>

      {/* 票 18 (tag-share): 粘贴导入预览 Modal 挂载点 (origin='paste'; 深链档走 tabbar-fav 挂载点) */}
      <TagRecShareImportModal origin='paste' />

      {/* [tag-rec] 票 17 (tag-share): 「我的分享」记账管理 Modal;票 31: focusShareId 定位行 (关时清回) */}
      <TagRecMySharesModal
        open={mySharesOpen}
        focusShareId={mySharesFocus}
        onClose={() => {
          setMySharesOpen(false)
          setMySharesFocus(undefined)
        }}
      />
    </div>
  )
}

// #region 文件读写 (照 $modules/settings/file-backup.ts 形态; 本模块私有, 勿复用到他处)

/** 文件选择: input[type=file] 一次性 pick (file-backup.ts chooseFile 同形), multiple 支持批量导入 */
function chooseFiles(accept: string): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []))
    })
    // [tag-rec] AUDIT-38: 补 cancel 监听 —— 取消对话框时落定空表 (调用方 !length 早退),
    //   否则 promise 永不 resolve, onImportJson 悬挂 (cancel 事件现代浏览器均支持)
    input.addEventListener('cancel', () => {
      resolve([])
    })
    input.click()
  })
}

/**
 * 文本下载: Blob + a[download] —— 照 file-backup.ts usePlainLink;
 * GM_download 在 ViolentMonkey mv3 下有 bug 无响应, 不走 (裁量与仓内结论一致)
 */
function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
// #endregion

// #region 收藏表区

/**
 * 行模型 (票 17 分节): 单 Table 混排两种行 —— L1 标题行(分组行形态, kind='l1') + 其下 L2 组行(kind='l2');
 * L1 折叠走数据层 (折叠态 L1 不出子行), 不引入 antd 树形 children (与 expandedRowRender 语义打架);
 * l1 字段缺省 = 「未归属」伪节行 —— 防御渲染 (「无裸奔 L2」不变式由 store 收口, UI 兜底不丢行)
 */
type FavL1Row = {
  kind: 'l1'
  id: string
  l1?: TagL1Group
  title: string
  contextOnly?: boolean
  // 麾下子树聚合 (票 25): L1 行 tag_id 数/所属一级组列语义不适用 => colSpan 并进组名列, 行右端显小字合计
  childCount: number
  idCount: number
  negCount: number
}
type FavL2Row = {
  kind: 'l2'
  id: string
  group: TagGroup
  l1Enabled: boolean // 父 L1 停用 => 子树一并灰化 (入堆资格由 deck 判, UI 只管呈现)
}
type FavRow = FavL1Row | FavL2Row

const ORPHAN_L1_ROW_ID = '__orphan__' // 伪节行 id (与 uuid 命名空间不撞)
const NEW_L1_OPTION = '__new_l1__' // 「所属一级组」/「并入…」下拉新建入口值
const NEW_L2_OPTION = '__new_l2__' // 「并入…」L2 档「新建标签组」入口值 (feat4)
const NEW_THEME_OPTION = '__new_theme__' // 「所属主题」下拉新建入口值 (票 26)
const THEME_FILTER_UNASSIGNED = '__theme_unassigned__' // 「筛选主题」未归属档哨兵 (票 44; 复选集内伪键)
const L1_FILTER_ALL = '__l1_all__' // 「筛选一级组」全部档哨兵 (feat3)
const L1_FILTER_UNASSIGNED = '__l1_unassigned__' // 「筛选一级组」未归属档哨兵 (feat3: 只看裸奔组伪节)
const THEME_ASSIGN_CLEAR = '__theme_clear__' // 吸顶条「挂到主题…」清回未归属哨兵 (feat3+)

/** L1 下拉项 (停用/挂起带态后缀) —— 行内「所属一级组」/「并入…」/吸顶条「移到一级组…」三处同款 */
const l1Option = (l: TagL1Group) => {
  const state = groupState(l)
  return { value: l.id, label: state === 'normal' ? l.name : `${l.name} (${TagGroupStateLabel[state]})` }
}

function FavoritesSection({
  onOpenMyShares,
}: {
  /** 票 31 (tag-share): share-modal dup-check「更新原分享」出口 —— 父级开「我的分享」Modal 定位该 shareId */
  onOpenMyShares?: (shareId: string) => void
}) {
  const { recSharedEmitter } = useRecSelfContext()
  const { list } = useSnapshot(favoritesStore)
  const { list: l1List } = useSnapshot(favoritesL1Store)
  const { list: themeList } = useSnapshot(themesStore)
  const { scope: viewScopeSnap } = useSnapshot(viewScopeStore)
  // R7: 高亮 = 「恰好只看这一个主题」的单主题档 (旧 active 语义保续; 多主题/全看不逐个高亮)
  const soloViewedThemeId = tagRecViewScopeLegacyActiveTheme(
    viewScopeSnap as TagRecViewScope,
    (themeList as TagTheme[]).map((t) => t.id),
  )
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [newChild, setNewChild] = useState<{ l1Id: string; name: string }>()
  const [expandedGroups, setExpandedGroups] = useState<Key[]>([])
  const [collapsedL1, setCollapsedL1] = useState<ReadonlySet<string>>(new Set()) // 折叠态按 L1 id, 会话级
  // feat4: 统一「并入…」Modal —— 勾选集同类 ≥1 即可 (L1=麾下二级组过继源壳删 / L2=成员并入目标源组删);
  //   目标 = 同类实体 (含已选项自身 = 其余并入它) 或 NEW 哨兵 (新建组并并入, 弹窗取名)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<string | undefined>(undefined)
  // 票 31: 吸顶条「移到一级组…」Modal 态 (目标 = L1 id 或「新建一级组…」哨兵)
  const [moveL2Open, setMoveL2Open] = useState(false)
  const [moveL2Target, setMoveL2Target] = useState<string | undefined>(undefined)
  // 票 44→feat3+: 主题筛选改复选框集 —— 纯视图过滤 (不动 store); 空集=全部, 多选=并集展示,
  //   哨兵=未归属档; 勾选集同时是「并入…」素材 (清 0-L1 空壳主题主路径)
  const [themeFilterSet, setThemeFilterSet] = useState<ReadonlySet<string>>(new Set())
  const [themeMergeOpen, setThemeMergeOpen] = useState(false)
  const [themeMergeTarget, setThemeMergeTarget] = useState<string | undefined>(undefined)
  // feat3+: 吸顶条「挂到主题…」Modal 态 (L1 勾选专属; 目标 = 主题 / 新建 / 未归属清回)
  const [assignThemeOpen, setAssignThemeOpen] = useState(false)
  const [assignThemeTarget, setAssignThemeTarget] = useState<string | undefined>(undefined)
  // feat3: 一级组筛选 —— 同纯视图口径; undefined=全部 / L1 id=只展该节 / 哨兵=只展「未归属」伪节
  const [l1Filter, setL1Filter] = useState<string | undefined>(undefined)
  // filter-scope 票12: 组配置弹层目标 (L2/L1 共用 GroupConfigModal; 行 ⚙ 入口)
  const [configTarget, setConfigTarget] = useState<TagRecGroupConfigTarget | undefined>(undefined)

  // 分节行序列: L1/L2 皆按 addedAt 倒序 (最新在前); 悬挂/无归属组落尾部「未归属」伪节
  const groups = [...(list as TagGroup[])].sort((a, b) => b.addedAt - a.addedAt)
  const l1s = [...(l1List as TagL1Group[])].sort((a, b) => b.addedAt - a.addedAt)
  // 票 44: 筛选中的主题被删 (名册行删主题) => 视图回落「全部」档不卡死
  // 生效主题集: 剔除已删主题 id (防卡死); 「未归属」哨兵保留
  const themeIds = new Set((themeList as TagTheme[]).map((t) => t.id))
  const effThemeSet: ReadonlySet<string> = new Set(
    [...themeFilterSet].filter((k) => k === THEME_FILTER_UNASSIGNED || themeIds.has(k)),
  )
  // 勾选集里真实主题 id (剔「未归属」哨兵) —— 「并入…」素材
  const checkedThemeIds = [...effThemeSet].filter((k) => k !== THEME_FILTER_UNASSIGNED)
  const unassignedL1Count = l1s.filter((l) => !l.themeId).length
  // feat3+: 先主题后一级组 —— L1 筛选选项收窄到生效主题集; 「未归属」档只在裸奔组可见时有意义
  const orphansVisible = !effThemeSet.size || effThemeSet.has(THEME_FILTER_UNASSIGNED)
  const scopedL1s = effThemeSet.size
    ? l1s.filter((l) => (l.themeId ? effThemeSet.has(l.themeId) : effThemeSet.has(THEME_FILTER_UNASSIGNED)))
    : l1s
  const effL1Filter =
    l1Filter === L1_FILTER_UNASSIGNED
      ? orphansVisible
        ? L1_FILTER_UNASSIGNED
        : undefined
      : scopedL1s.some((l) => l.id === l1Filter)
        ? l1Filter
        : undefined
  const visibleL1s = scopedL1s.filter(
    (l) => effL1Filter === undefined || (effL1Filter !== L1_FILTER_UNASSIGNED && l.id === effL1Filter),
  )
  // 未归属伪节 (无 L1 的裸奔组): 主题集含「未归属」×一级组「全部/未归属」才可见; 筛到具体任一档时藏
  const showOrphans = orphansVisible && (effL1Filter === undefined || effL1Filter === L1_FILTER_UNASSIGNED)
  const l1Ids = new Set(l1s.map((l) => l.id))
  const childrenByL1 = new Map<string, TagGroup[]>()
  const orphans: TagGroup[] = []
  for (const g of groups) {
    if (g.l1Id && l1Ids.has(g.l1Id)) {
      const arr = childrenByL1.get(g.l1Id) ?? []
      arr.push(g)
      childrenByL1.set(g.l1Id, arr)
    } else {
      orphans.push(g)
    }
  }
  const rows: FavRow[] = []
  /** 麾下子树合计 (票 25): 渲染期内存算零请求, L1 永不自持 tag_ids/负向故直求和即可 */
  const l1Agg = (kids: TagGroup[]) => ({
    childCount: kids.length,
    idCount: kids.reduce((s, g) => s + g.tag_ids.length, 0),
    negCount: kids.reduce((s, g) => s + groupNegativeTagIds(g).length, 0),
  })
  for (const l1 of visibleL1s) {
    const children = childrenByL1.get(l1.id) ?? []
    const q = search.trim().toLowerCase()
    const ancestorMatch =
      !q ||
      l1.name.toLowerCase().includes(q) ||
      (themeList.find((t) => t.id === l1.themeId)?.name ?? '未归属').toLowerCase().includes(q)
    const matches = ancestorMatch
      ? children
      : children.filter(
          (g) => g.name.toLowerCase().includes(q) || g.tag_ids.some((t) => t.name.toLowerCase().includes(q)),
        )
    if (!ancestorMatch && !matches.length) continue
    rows.push({ kind: 'l1', id: l1.id, l1, title: l1.name, contextOnly: !ancestorMatch, ...l1Agg(children) })
    if (q || !collapsedL1.has(l1.id)) {
      for (const g of matches) rows.push({ kind: 'l2', id: g.id, group: g, l1Enabled: l1.enabled })
    }
  }
  const visibleOrphans = search.trim()
    ? orphans.filter(
        (g) =>
          g.name.toLowerCase().includes(search.trim().toLowerCase()) ||
          g.tag_ids.some((t) => t.name.toLowerCase().includes(search.trim().toLowerCase())),
      )
    : orphans
  if (showOrphans && visibleOrphans.length) {
    rows.push({ kind: 'l1', id: ORPHAN_L1_ROW_ID, title: '未归属 (缺一级组)', ...l1Agg(orphans) })
    if (search.trim() || !collapsedL1.has(ORPHAN_L1_ROW_ID)) {
      for (const g of visibleOrphans) rows.push({ kind: 'l2', id: g.id, group: g, l1Enabled: true })
    }
  }
  const l2Ids = new Set(groups.map((g) => g.id)) // 勾选键域 (票 31: L1/L2 同域复选)
  const l1IdOfGroup = new Map(groups.map((g) => [g.id, g.l1Id])) // L2 -> 父 L1 (勾选联动用)

  // [tag-rec] AUDIT-36: 行级删/并入/级联 removeL1Tree/危险区清空等旁路删不经过 rowSelection.onChange,
  //   selectedKeys 会残留死 id (撑起空「已选」吸顶条 + 「已删除 0 项」toast) —— 渲染期与现存 id 集求交剪枝,
  //   作为所有删除出口的统一收口 (onChange 回写时顺带自清)
  const selKeys = selectedKeys.map(String).filter((k) => l1Ids.has(k) || l2Ids.has(k))
  // 票 31 选中分集: L1 勾选 = 整棵子树语义; L1+L2 混选 = 无合法操作 => 吸顶条全禁 + 提示
  const selL1Ids = selKeys.filter((k) => l1Ids.has(k))
  const selL2Ids = selKeys.filter((k) => l2Ids.has(k))
  const selL1Set = new Set(selL1Ids)
  const mixedPick = selL1Ids.length > 0 && selL2Ids.length > 0
  // feat4: 统一「并入…」门槛 = 勾选同类 ≥1 (允许只勾 1 个 —— 并入别组或新建组); 混选禁
  const mergeKind: 'l1' | 'l2' | undefined = mixedPick
    ? undefined
    : selL1Ids.length > 0
      ? 'l1'
      : selL2Ids.length > 0
        ? 'l2'
        : undefined
  const canMerge = mergeKind !== undefined
  const canMoveL2 = !mixedPick && selL1Ids.length === 0 && selL2Ids.length >= 1
  // feat3+: 「挂到主题…」= L1 勾选专属 (改挂 themeId 归属; L2 不具该键, 混选禁)
  const canAssignTheme = !mixedPick && selL1Ids.length >= 1
  // 票 44 吸顶条「删除」: L1 勾选 = 整棵子树级联删 (麾下 L2 一并删, 用户裁);
  // 混选下删除仍可用 (并入/合并/移动维持禁) —— 逐类独立操作无歧义
  const selL1ChildCount = selL1Ids.reduce((s, id) => s + (childrenByL1.get(id)?.length ?? 0), 0)

  // [tag-rec] 票 16 (tag-share): 分享勾选集 = 勾中 L2 ∪ 勾中 L1 麾下全部 L2
  //   (「L1 勾选 = 整棵子树」语义沿用); 混选同样可用 (分享无目标歧义)
  const shareSelection = expandShareSelection({ l1Ids: selL1Ids, groupIds: selL2Ids }, groups)
  // 内容判据同模型侧 hasTagRecCombination: 纯条件组 (无 tag 原子) tag_ids 为空但可分享
  const shareGroups = shareSelection.filter((g) => g.tag_ids.length > 0 || hasTagRecCombination(g.combination))
  const emptyShareCount = shareSelection.length - shareGroups.length
  const [shareOpen, setShareOpen] = useState(false)

  const deleteSelected = () => {
    const removedL2 = favorites.removeGroups(selL2Ids)
    let removedL1 = 0
    for (const id of selL1Ids) if (favoritesL1.removeL1Tree(id)) removedL1++
    setSelectedKeys([])
    toast(
      `已删除 ${
        [
          removedL1 ? `${removedL1} 个一级组${selL1ChildCount ? ` (连麾下 ${selL1ChildCount} 个标签组)` : ''}` : '',
          removedL2 ? `${removedL2} 个标签组` : '',
        ]
          .filter(Boolean)
          .join(' + ') || '0 项'
      }`,
    )
  }

  const toggleL1Collapse = (id: string) =>
    setCollapsedL1((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleThemeFilter = (key: string, checked: boolean) =>
    setThemeFilterSet((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })

  /**
   * 主题「并入…」确认 (feat: 复选驱动): 勾选主题麾下 L1 全改挂 target, 源主题删;
   *   目标含已选主题自身 (并入它=其余并入它) 或「新建主题…」弹窗取名;
   *   确认后把已删源 id 剔出筛选集 (目标留在集内继续筛)
   */
  const confirmThemeMerge = async () => {
    const target = themeMergeTarget
    setThemeMergeOpen(false)
    setThemeMergeTarget(undefined)
    if (!target) return
    let targetId = target
    if (target === NEW_THEME_OPTION) {
      const draft = await promptText('新建主题并并入', '')
      if (draft === undefined) return
      const t = themes.addTheme({ name: draft })
      if (!t) return
      targetId = t.id
    }
    if (checkedThemeIds.length === 1 && checkedThemeIds[0] === targetId)
      return toast('目标就是勾选的唯一主题, 无需并入')
    const n = themes.mergeThemesInto(checkedThemeIds, targetId)
    if (n === undefined) return
    setThemeFilterSet((prev) => {
      const next = new Set(prev)
      for (const id of checkedThemeIds) if (id !== targetId) next.delete(id)
      return next
    })
    toast(`已把 ${n} 个主题并入「${themes.list.find((t) => t.id === targetId)?.name ?? targetId}」`)
  }

  /** 批量启/停 (feat4): 逐类门面 update —— L1 勾选连带语义只管呈现, 此处按显式勾选项写; 混选同样可用 */
  const setSelectedEnabled = (enabled: boolean) => {
    let n = 0
    for (const id of selL1Ids) if (favoritesL1.updateL1(id, { enabled })) n++
    for (const id of selL2Ids) if (favorites.updateGroup(id, { enabled })) n++
    toast(`已${enabled ? '启用' : '停用'} ${n} 项`)
  }

  /**
   * 统一「并入…」确认 (feat4): kind 由勾选集定 (混选禁入)
   *   L1 档 —— 目标 = 既有 L1 (含已选自身 = 其余并入它): 逐源 mergeL1IntoL1, 源壳删;
   *             目标 = 新建: 弹窗取名 addL1 后同路径
   *   L2 档 —— 目标 = 既有组 (含已选): mergeGroupsInto 统一归并成员与规则;
   *             目标 = 新建: 最早组为基准，mergeGroupsToNew 校验创建后删除源组
   */
  const confirmMerge = async () => {
    const target = mergeTarget
    const kind = mergeKind
    setMergeOpen(false)
    setMergeTarget(undefined)
    if (!kind || !target) return
    if (kind === 'l1') {
      let targetId = target
      if (target === NEW_L1_OPTION) {
        const draft = await promptText('新建一级组并并入', l1s.find((l) => l.id === selL1Ids[0])?.name ?? '')
        if (draft === undefined) return
        const l1 = favoritesL1.addL1({ name: draft })
        if (!l1) return
        targetId = l1.id
      }
      // 目标确认瞬间失效 (跨 tab 删组) => 整体拒
      if (!favoritesL1.list.some((l) => l.id === targetId)) return toast('目标一级组不存在')
      if (selL1Ids.length === 1 && selL1Ids[0] === targetId) return toast('目标就是勾选的唯一组, 无需并入')
      for (const sid of selL1Ids) if (sid !== targetId) favoritesL1.mergeL1IntoL1(sid, targetId)
      setSelectedKeys([])
      return
    }
    if (target === NEW_L2_OPTION) {
      const draft = await promptText('新建标签组并并入', groups.find((g) => g.id === selL2Ids[0])?.name ?? '')
      if (draft === undefined) return
      const created = favorites.mergeGroupsToNew(selL2Ids, draft)
      if (!created) return
      toast(`已建标签组「${created.name}」并并入 ${selL2Ids.length} 个组`)
      setSelectedKeys([])
      return
    }
    if (selL2Ids.length === 1 && selL2Ids[0] === target) return toast('目标就是勾选的唯一组, 无需并入')
    const merged = favorites.mergeGroupsInto(selL2Ids, target)
    if (merged !== undefined) {
      toast(`已把 ${merged} 个标签组并入「${groups.find((g) => g.id === target)?.name ?? target}」`)
      setSelectedKeys([])
    }
  }

  /** 吸顶条「挂到主题…」确认 (feat3+): 逐 L1 指认 themeId (批量 assignL1ToTheme);
      目标 = 既有主题 / 「新建主题…」弹窗取名 / 「未归属」清回 */
  const confirmAssignTheme = async () => {
    const target = assignThemeTarget
    setAssignThemeOpen(false)
    setAssignThemeTarget(undefined)
    if (!target) return
    let themeId: string | undefined
    if (target === NEW_THEME_OPTION) {
      const draft = await promptText('新建主题, 并把勾选的一级组归入', '')
      if (draft === undefined) return
      const t = themes.addTheme({ name: draft })
      if (!t) return
      themeId = t.id
    } else if (target !== THEME_ASSIGN_CLEAR) {
      themeId = target
    }
    let n = 0
    for (const id of selL1Ids) if (themes.assignL1ToTheme(id, themeId)) n++
    toast(
      `已把 ${n} 个一级组归入${themeId ? `「${themes.list.find((t) => t.id === themeId)?.name ?? themeId}」` : '「未归属」'}`,
    )
    setSelectedKeys([])
  }

  /** 新建目标先取名并确认；与选择既有目标一样，经批量移动门面归入并清理移空的源组。 */
  const confirmMoveL2 = async () => {
    const target = moveL2Target
    setMoveL2Open(false)
    if (!target || !selL2Ids.length) return
    const res =
      target === NEW_L1_OPTION ? await createL1AndMoveGroups(selL2Ids) : favoritesL1.moveGroupsToL1(selL2Ids, target)
    if (!res) return
    const shells = res.removedShells.length ? `; 源空壳一级组已删: ${res.removedShells.join('、')}` : ''
    toast(
      target === NEW_L1_OPTION
        ? `已建一级组「${res.l1.name}」并把 ${res.moved} 组归入 (默认停用)${shells}`
        : `已将 ${res.moved} 个标签组移到「${res.l1.name}」${shells}`,
    )
    setSelectedKeys([])
  }

  /** 「+ 一级组」: 默认停用 (spec 重新开张语义) —— L1 行 enabled 开关是「逐个挑谁上岗」主路径 */
  const addL1 = async () => {
    const name = await promptText('新建一级组')
    if (name === undefined) return
    const l1 = favoritesL1.addL1({ name })
    if (l1) toast(`已新建一级组「${l1.name}」(默认停用, 行内启用后麾下组才入抽)`)
  }

  // 沿用早期行内编辑：点击简介即输入，空值只显示入口；长文截断，不占满列表。
  const noteEditor = (entity: TagGroup | TagL1Group, onChange: (v: string) => void) => (
    <Typography.Paragraph
      type={entity.note?.trim() ? undefined : 'secondary'}
      className='mt-3px text-12px mb-0!'
      aria-label={`简介：${entity.name}`}
      ellipsis={{ rows: 1, tooltip: entity.note }}
      editable={{
        text: entity.note ?? '',
        tooltip: '编辑简介',
        triggerType: ['text'],
        autoSize: { minRows: 1, maxRows: 3 },
        onChange,
      }}
    >
      {entity.note?.trim() ? entity.note : '+ 简介'}
    </Typography.Paragraph>
  )

  const toggleGroupDetails = (id: string) =>
    setExpandedGroups((prev) => (prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]))
  const startNewChild = (l1Id: string) => {
    setNewChild({ l1Id, name: '' })
    setCollapsedL1((prev) => new Set([...prev].filter((id) => id !== l1Id)))
  }
  const createChild = () => {
    if (!newChild?.name.trim()) return
    if (!favoritesL1.list.some((l) => l.id === newChild.l1Id)) return toast('一级组已不存在')
    const created = favorites.addGroup({ name: newChild.name, l1Id: newChild.l1Id, tag_ids: [] })
    if (!created) return
    setExpandedGroups((prev) => [...prev, created.group.id])
    setSearch('')
    setNewChild(undefined)
    toast('已建空二级组，可在下方添加标签')
  }
  const columns: ColumnsType<FavRow> = [
    {
      key: 'name',
      title: '组名与简介',
      render: (_, r) =>
        r.kind === 'l1' ? (
          <div className='min-w-0'>
            <div className='min-h-24px flex flex-wrap items-center gap-x-7px gap-y-3px'>
              <Typography.Text
                strong
                className='break-words text-14px'
                editable={
                  r.l1 && !r.contextOnly
                    ? {
                        tooltip: '编辑一级组名',
                        triggerType: ['text', 'icon'],
                        onChange: (v) => favoritesL1.updateL1(r.id, { name: v }),
                      }
                    : undefined
                }
              >
                {r.title}
              </Typography.Text>
              {r.l1 && !r.contextOnly && (
                <Typography.Link
                  className='text-12px'
                  href={buildTagRecFavDeepLink(location.origin)}
                  target='_blank'
                  title='打开主题推荐'
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗
                </Typography.Link>
              )}
              {r.l1 && !r.contextOnly && (
                <Button size='small' type='link' className='h-auto px-4px' onClick={() => startNewChild(r.id)}>
                  ＋ 二级组
                </Button>
              )}
              {r.contextOnly && <span className='text-10px opacity-50'>路径 · 仅下方二级组匹配</span>}
              <span className='text-11px opacity-60'>
                {r.childCount} 组 · {r.idCount} 个标签{r.negCount ? ` · ${r.negCount} 个负向` : ''}
              </span>
            </div>
            {r.l1 && !r.contextOnly && noteEditor(r.l1, (v) => favoritesL1.updateL1(r.id, { note: v }))}
          </div>
        ) : (
          <div className='min-w-0 pl-18px'>
            <div className='min-h-24px flex flex-wrap items-center gap-x-7px gap-y-3px'>
              <Typography.Text
                className='break-words'
                editable={{
                  tooltip: '编辑二级组名',
                  triggerType: ['text', 'icon'],
                  onChange: (v) => favorites.updateGroup(r.id, { name: v }),
                }}
              >
                {r.group.name}
              </Typography.Text>
              {hasTagRecCombination(r.group.combination) ? (
                <>
                  {/* 组合组: 结构编辑只在工作台条件编辑器, 行内给语义句 + 显式入口 (↗ 打开即装入「试改自收藏」) */}
                  <Tag className='mr-0 text-10px' title={nameTagRecCombination(r.group.combination!)}>
                    组合
                  </Tag>
                  <Typography.Link
                    className='text-12px'
                    href={buildTagRecCustomDeepLink(location.origin, { group: r.id })}
                    target='_blank'
                    title='在「标签发掘」中编辑子组 / 全部命中·任一命中 / 标签·标题·简介等条件'
                    onClick={(e) => e.stopPropagation()}
                  >
                    编辑条件 ↗
                  </Typography.Link>
                </>
              ) : (
                <Typography.Link
                  className='text-12px'
                  href={buildTagRecCustomDeepLink(location.origin, { group: r.id })}
                  target='_blank'
                  title='打开标签发掘'
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗
                </Typography.Link>
              )}
              {!r.group.tag_ids.length && !hasTagRecCombination(r.group.combination) && (
                <Tag className='mr-0 text-10px'>待添加标签</Tag>
              )}
              <Button
                size='small'
                type='text'
                className='h-auto px-4px text-11px color-gate-primary'
                onClick={() => toggleGroupDetails(r.id)}
              >
                {!r.group.tag_ids.length
                  ? hasTagRecCombination(r.group.combination)
                    ? expandedGroups.includes(r.id)
                      ? '收起条件'
                      : '条件组'
                    : '添加标签'
                  : expandedGroups.includes(r.id)
                    ? '收起标签'
                    : `${r.group.tag_ids.length} 个标签`}
              </Button>
            </div>
            {noteEditor(r.group, (v) => favorites.updateGroup(r.id, { note: v }))}
          </div>
        ),
    },
    {
      key: 'assignment',
      title: '所属主题 / 一级组',
      width: 185,
      render: (_, r) => {
        if (r.kind === 'l1') {
          if (!r.l1) return null
          if (r.contextOnly) return <Tag>{themeList.find((t) => t.id === r.l1?.themeId)?.name ?? '未归属主题'}</Tag>
          return <ThemeAssignSelect l1={r.l1} />
        }
        return <L1AssignSelect group={r.group} />
      },
    },
    {
      key: 'weight',
      title: '抽取权重',
      width: 90,
      render: (_, r) => {
        if (r.kind === 'l1' && r.contextOnly) return null
        const entity = r.kind === 'l1' ? r.l1 : r.group
        if (!entity) return null
        return (
          <AntdTooltip title='0 挂起，不参与自动推荐；1–5 越大越常抽到'>
            <InputNumber
              size='small'
              className='w-72px'
              styles={{ actions: { opacity: 1, width: 22 } }}
              aria-label={`抽取权重：${entity.name}`}
              min={0}
              max={5}
              precision={0}
              value={entity.weight}
              onChange={(v) => {
                if (v === null) return
                if (r.kind === 'l1') favoritesL1.updateL1(r.id, { weight: v })
                else favorites.updateGroup(r.id, { weight: v })
              }}
            />
          </AntdTooltip>
        )
      },
    },
    {
      key: 'enabled',
      title: '保存开关',
      width: 100,
      align: 'center',
      render: (_, r) => {
        if (r.kind === 'l1' && r.contextOnly) return null
        const entity = r.kind === 'l1' ? r.l1 : r.group
        if (!entity) return null
        const empty = r.kind === 'l2' && !r.group.tag_ids.length && !hasTagRecCombination(r.group.combination)
        const label = empty
          ? '待添加'
          : entity.weight === 0
            ? '挂起'
            : !entity.enabled
              ? '已关闭'
              : r.kind === 'l2' && !r.l1Enabled
                ? '父组关闭'
                : '已启用'
        return (
          <AntdTooltip
            title={
              empty
                ? '先添加标签，再启用二级组'
                : r.kind === 'l1'
                  ? '保存开关优先于临时范围；打开后按各二级组自己的开关参与推荐'
                  : !r.l1Enabled
                    ? '二级组开关独立保存；一级组打开后才参与推荐'
                    : '保存开关优先于该二级组的临时选择'
            }
          >
            <span className='min-h-24px inline-flex items-center justify-center gap-4px'>
              <Switch
                size='small'
                aria-label={(r.kind === 'l1' ? '启用一级组：' : '启用二级组：') + entity.name}
                checked={entity.enabled}
                disabled={empty}
                onChange={(v) =>
                  r.kind === 'l1'
                    ? favoritesL1.updateL1(r.id, { enabled: v })
                    : favorites.updateGroup(r.id, { enabled: v })
                }
              />
              <span className='text-10px opacity-55'>{label}</span>
            </span>
          </AntdTooltip>
        )
      },
    },
    {
      key: 'actions',
      title: '操作',
      width: 100,
      align: 'right',
      render: (_, r) => {
        if (r.kind === 'l1' && r.contextOnly) return null
        const entity = r.kind === 'l1' ? r.l1 : r.group
        if (!entity) return null
        return (
          <div className='min-h-24px inline-flex items-center gap-8px'>
            <AntdTooltip title={r.kind === 'l1' ? '过滤与算分配置' : '组现状与配置'}>
              <Badge dot={hasTagRecGroupConfig(entity.overrides)} size='small'>
                <Button
                  size='small'
                  type='link'
                  className='px-0'
                  aria-label={`${r.kind === 'l1' ? '过滤与算分配置' : '组现状与配置'}：${entity.name}`}
                  icon={<IconForConfig className='size-14px' />}
                  onClick={() =>
                    setConfigTarget(r.kind === 'l1' ? { kind: 'l1', l1Id: r.id } : { kind: 'l2', groupId: r.id })
                  }
                />
              </Badge>
            </AntdTooltip>
            <Popconfirm
              title={'删除' + (r.kind === 'l1' ? '一级组' : '二级组')}
              description={
                r.kind === 'l1' ? `删除「${entity.name}」及其 ${r.childCount} 个二级组？` : `删除「${entity.name}」？`
              }
              okText='删除'
              okButtonProps={{ danger: true }}
              onConfirm={() => (r.kind === 'l1' ? favoritesL1.removeL1Tree(r.id) : favorites.removeGroup(r.id))}
            >
              <Button size='small' type='link' danger className='px-0' aria-label={`删除：${entity.name}`}>
                删除
              </Button>
            </Popconfirm>
          </div>
        )
      },
    },
  ]

  return (
    <>
      <div className='mb-12px flex flex-wrap items-center gap-8px'>
        <Button size='small' type='primary' onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '新建标签组'}
        </Button>
        <Button size='small' onClick={addL1}>
          <IconTablerPlus />
          一级组
        </Button>
        <Typography.Text type='secondary' className='text-12px'>
          共 {l1s.length} 个一级组 · {list.length} 组
        </Typography.Text>
      </div>
      <Input
        size='small'
        className='mb-10px max-w-400px'
        allowClear
        value={search}
        placeholder='搜一级组、二级组或标签'
        aria-label='搜索收藏表'
        onChange={(e) => {
          setSearch(e.target.value)
          setSelectedKeys([])
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && search) {
            e.stopPropagation()
            setSearch('')
          }
        }}
      />

      {/* feat3+: 主题名册 = 复选框行 (chip 撤) —— 勾选=下方只展这些主题的一级组 (多选并集, 空集=全部);
          勾选集动作: 「并入…」麾下 L1 改挂目标删源壳 / 「删除」批删 (麾下 L1 落回未归属, 空壳直清);
          右键 checkbox 出改名/删除; 「未归属」同档复选; 勾选切换即清行复选 (筛走的行不残留选中态) */}
      {(themeList as TagTheme[]).length > 0 || unassignedL1Count > 0 ? (
        <div className='mb-10px'>
          <div className='flex flex-wrap items-center gap-x-8px gap-y-6px'>
            <Button
              size='small'
              type={!effThemeSet.size ? 'primary' : 'default'}
              onClick={() => {
                setThemeFilterSet(new Set())
                setSelectedKeys([])
              }}
            >
              全部主题
            </Button>
            <Typography.Text type='secondary' className='text-12px'>
              主题:
            </Typography.Text>
            {/* feat3+: 「未归属」提首位——它是「待处理」档: 有裸奔 L1 时品牌色加粗高亮指引归置, 清零后回落淡色 */}
            <AntdTooltip title='没有归属主题的一级组 (可经行内「所属主题」列或吸顶「挂到主题…」归置)'>
              <Checkbox
                checked={effThemeSet.has(THEME_FILTER_UNASSIGNED)}
                onChange={(e) => {
                  toggleThemeFilter(THEME_FILTER_UNASSIGNED, e.target.checked)
                  setSelectedKeys([])
                }}
              >
                <span className={`text-13px ${unassignedL1Count ? 'color-gate-primary font-600' : 'opacity-60'}`}>
                  未归属{unassignedL1Count ? ` ⚠${unassignedL1Count}` : ' · 0'}
                </span>
              </Checkbox>
            </AntdTooltip>
            {(themeList as TagTheme[]).map((t) => (
              <ThemeFilterCheck
                key={t.id}
                theme={t}
                l1Count={l1s.filter((l) => l.themeId === t.id).length}
                active={soloViewedThemeId === t.id}
                checked={effThemeSet.has(t.id)}
                onCheck={(v) => {
                  toggleThemeFilter(t.id, v)
                  setSelectedKeys([])
                }}
              />
            ))}
            {/* 面板筛选只找行; 显式应用后替换会话范围，并临时开启所选主题的停用一级组。 */}
            <AntdTooltip title='只看勾选主题，停用的一级组本次临时开启；刷新网页还原，收藏表启用状态不变。未勾选则恢复当前启用范围'>
              <Button
                size='small'
                onClick={() => {
                  viewScope.previewThemes(effThemeSet)
                  videoSourceTabState.value = ETab.TagRecFav
                  hideModalSettings()
                  recSharedEmitter.emit('refresh', 'refresh')
                }}
              >
                用此筛选看推荐
              </Button>
            </AntdTooltip>
            {checkedThemeIds.length > 0 && (
              <>
                <Typography.Text type='secondary' className='text-12px'>
                  已勾 {checkedThemeIds.length} 个
                </Typography.Text>
                <AntdTooltip title='勾选主题麾下的一级组全部改挂到目标主题, 源主题删除; 目标可选已勾主题自身或新建'>
                  <Button
                    size='small'
                    onClick={() => {
                      setThemeMergeTarget(undefined)
                      setThemeMergeOpen(true)
                    }}
                  >
                    并入…
                  </Button>
                </AntdTooltip>
                {/* 勾选主题批删 (实机新增): 麾下 L1 落回「未归属」 (组/启用不动) —— 右键删的批量版,
                  删空壳主题不再需要绕道并入 */}
                <AntdTooltip title='删除勾选主题; 其麾下一级组落回「未归属」(组与启用状态不动)'>
                  <Button
                    size='small'
                    danger
                    onClick={async () => {
                      const orphanN = l1s.filter((l) => l.themeId && checkedThemeIds.includes(l.themeId)).length
                      const ok = await antModal.confirm({
                        centered: true,
                        title: `删除 ${checkedThemeIds.length} 个主题?`,
                        content: orphanN
                          ? `其麾下 ${orphanN} 个一级组将落回「未归属」(组与启用状态不动)`
                          : '勾选的主题下没有归属的一级组',
                        okText: '删除',
                        okButtonProps: { danger: true },
                      })
                      if (!ok) return
                      const n = themes.removeThemes(checkedThemeIds)
                      toast(`已删除 ${n} 个主题`)
                    }}
                  >
                    删除
                  </Button>
                </AntdTooltip>
              </>
            )}
          </div>
        </div>
      ) : null}
      {(l1s.length > 0 || (themeList as TagTheme[]).length > 0) && (
        <div className='mb-6px flex items-center gap-x-8px'>
          <AntdTooltip
            title={
              effThemeSet.size
                ? '按一级组筛选表格行 (纯视图); 选项已收窄到勾选主题麾下'
                : '按一级组筛选表格行 (纯视图, 不动归属); 「未归属」= 无一级组的裸奔组伪节'
            }
          >
            <Select
              size='small'
              className='w-200px'
              showSearch
              optionFilterProp='label'
              value={effL1Filter ?? L1_FILTER_ALL}
              options={[
                { value: L1_FILTER_ALL, label: effThemeSet.size ? '勾选主题内全部一级组' : '全部一级组' },
                ...(orphansVisible ? [{ value: L1_FILTER_UNASSIGNED, label: '未归属' }] : []),
                ...scopedL1s.map((l) => ({ value: l.id, label: `仅「${l.name}」` })),
              ]}
              onChange={(v) => {
                setL1Filter(v === L1_FILTER_ALL ? undefined : v)
                setSelectedKeys([])
              }}
            />
          </AntdTooltip>
        </div>
      )}

      {creating && (
        <CandidateResolvePicker
          confirmLabel='存为一项'
          onConfirm={(entries) => {
            const g = favorites.addGroup({ name: entries[0]?.name, tag_ids: entries })?.group
            if (g) {
              toast(`已存为标签组「${g.name}」`)
              setCreating(false)
            }
          }}
        />
      )}

      {/* 票 31 + feat4: 吸顶操作条 —— sticky 于面板滚动容器, 随表格滚始终可及;
          操作按选中集构型: 「并入…」= 同类勾选 ≥1 (L1 过继麾下并删壳 / L2 成员并入目标删源, 目标含已选项与「新建」);
          「移到一级组…」= 仅 L2; 「启用/停用」= 批量开关 (混选可用); 混选下并入/移动禁 + 提示 */}
      {selKeys.length > 0 && (
        <div className='sticky top-0 z-10 mb-6px flex flex-wrap items-center gap-8px b-b-1px b-gate-border b-solid bg-gate-bg py-6px'>
          <Typography.Text type='secondary' className='text-12px'>
            已选{' '}
            {[
              selL1Ids.length ? `${selL1Ids.length} 个一级组` : '',
              selL2Ids.length ? `${selL2Ids.length} 个标签组` : '',
            ]
              .filter(Boolean)
              .join(' + ')}
          </Typography.Text>
          <AntdTooltip title='把勾选项并入一个目标 (可选已选项自身 = 其余并入它, 或新建组); 一级组=麾下二级组过继后源壳删, 标签组=成员并入后源组删'>
            <span>
              <Button
                size='small'
                disabled={!canMerge}
                onClick={() => {
                  setMergeTarget(undefined)
                  setMergeOpen(true)
                }}
              >
                并入…
              </Button>
            </span>
          </AntdTooltip>
          <AntdTooltip title='勾选的标签组改挂到另一级组 (可新建); 源一级组变空壳将自动删除'>
            <span>
              <Button
                size='small'
                disabled={!canMoveL2}
                onClick={() => {
                  setMoveL2Target(undefined)
                  setMoveL2Open(true)
                }}
              >
                移到一级组…
              </Button>
            </span>
          </AntdTooltip>
          {/* feat3+: L1 勾选专属「挂到主题…」—— 批量改挂 themeId (目标 = 既有主题/新建/未归属清回) */}
          <AntdTooltip title='勾选的一级组改挂到目标主题 (可新建, 或「未归属」清回)'>
            <span>
              <Button
                size='small'
                disabled={!canAssignTheme}
                onClick={() => {
                  setAssignThemeTarget(undefined)
                  setAssignThemeOpen(true)
                }}
              >
                挂到主题…
              </Button>
            </span>
          </AntdTooltip>
          {/* feat4: 批量启/停 —— 一级组勾选 = 批量入堆开关主诉求; 混选下同样可用 */}
          <Button size='small' onClick={() => setSelectedEnabled(true)}>
            启用
          </Button>
          <Button size='small' onClick={() => setSelectedEnabled(false)}>
            停用
          </Button>
          {/* 票 44: 批量删除 —— antModal.confirm 祈使式 (同主题右键删);
              L1 勾选 = 整棵子树级联删 (麾下 L2 一并删, confirm 明示计数); 混选可用 */}
          <AntdTooltip title='删除勾选项; 一级组连麾下标签组一并删除'>
            <span>
              <Button
                size='small'
                danger
                onClick={async () => {
                  const ok = await antModal.confirm({
                    centered: true,
                    title: '删除勾选项',
                    content: `将删除 ${[
                      selL1Ids.length
                        ? `${selL1Ids.length} 个一级组${selL1ChildCount ? ` (连麾下 ${selL1ChildCount} 个标签组)` : ''}`
                        : '',
                      selL2Ids.length ? `${selL2Ids.length} 个标签组` : '',
                    ]
                      .filter(Boolean)
                      .join(' + ')}`,
                    okText: '删除',
                    okButtonProps: { danger: true },
                  })
                  if (ok) deleteSelected()
                }}
              >
                删除
              </Button>
            </span>
          </AntdTooltip>
          {/* [tag-rec] 票 16 (tag-share): 「分享选中(N)」—— N = 展开后实际组数; 混选可用 (与删除同理无歧义) */}
          <AntdTooltip title='把勾选的标签组上传到分享平台; 勾选一级组 = 麾下整棵子树'>
            <span>
              <Button size='small' disabled={!shareGroups.length} onClick={() => setShareOpen(true)}>
                分享选中 ({shareGroups.length})
              </Button>
              {!!emptyShareCount && (
                <span className='ml-4px text-11px opacity-60'>{emptyShareCount} 个空组暂不分享，可导出备份</span>
              )}
            </span>
          </AntdTooltip>
          {mixedPick && (
            <Typography.Text type='warning' className='text-12px'>
              并入/移动不支持混选 (启用/停用/删除可用)
            </Typography.Text>
          )}
          <Button size='small' type='link' className='ml-auto px-0' onClick={() => setSelectedKeys([])}>
            取消选择
          </Button>
        </div>
      )}

      <Table<FavRow>
        size='small'
        rowKey='id'
        // 所有操作与组名第一行对齐，不随简介行数上下浮动。
        columns={columns.map((column) => ({ ...column, onCell: () => ({ style: { verticalAlign: 'top' } }) }))}
        dataSource={rows}
        pagination={false}
        tableLayout='fixed'
        // [tag-rec] perf: 535+ 组规模无分页全渲 ~10-20k DOM/次状态变更 => 虚拟滚动只渲可视窗
        virtual
        scroll={{ x: 820, y: 480 }}
        onRow={(r) =>
          r.kind === 'l1'
            ? {
                // L1 分节底色 = 主题色 8% 染色 (color-mix; 亮/暗主题自适应, 比灰底轻快且点出「节」层级)
                style: {
                  background: 'color-mix(in oklab, var(--bilibili-gate--primary-color) 8%, transparent)',
                },
              }
            : {}
        }
        rowSelection={{
          // [tag-rec] perf-virtual: fixed+virtual 下未声明 width 的列等分余量 —— 自动生成列钉窄宽, 余量归 name 列
          columnWidth: 44,
          selectedRowKeys: [
            ...selKeys,
            ...rows.filter((r) => r.kind === 'l2' && !!r.group.l1Id && selL1Set.has(r.group.l1Id)).map((r) => r.id),
          ],
          renderCell: (_checked, r, _index, node) =>
            r.kind === 'l1' && r.contextOnly ? <span className='text-11px opacity-40'>›</span> : node,
          // 票 31: L1/L2 统一复选 —— L1 勾选即代表整棵子树, 其麾下 L2 复选 disabled 灰显;
          // 「未归属」伪节行非真实 L1 不可选 (无并入/改挂语义)
          getCheckboxProps: (r) => ({
            disabled: r.kind === 'l1' ? !r.l1 || r.contextOnly : !!r.group.l1Id && selL1Set.has(r.group.l1Id),
          }),
          onSelect: (r, on) => {
            const next = new Set(selKeys)
            if (on) next.add(r.id)
            else next.delete(r.id)
            if (r.kind === 'l1') for (const g of childrenByL1.get(r.id) ?? []) next.delete(g.id)
            setSelectedKeys([...next])
          },
          onSelectAll: (on, _selected, changed) => {
            const next = new Set(selKeys)
            for (const r of changed) {
              if (r.kind === 'l1' && (!r.l1 || r.contextOnly)) continue
              if (on) next.add(r.id)
              else next.delete(r.id)
            }
            const parentKeys = new Set([...next].filter((id) => l1Ids.has(id)))
            setSelectedKeys([...next].filter((id) => !l2Ids.has(id) || !parentKeys.has(l1IdOfGroup.get(id) ?? '')))
          },
        }}
        expandable={{
          columnWidth: 44, // 同 rowSelection.columnWidth —— 防 fixed+virtual 等分余量撑宽自动列
          expandedRowKeys: expandedGroups,
          onExpandedRowsChange: (keys) => setExpandedGroups([...keys]),
          // feat3+: expand 列对 L1/L2 统一占格 —— L1 = 折叠钮兼组标 (文件夹双态, 与 L2 antd 展开钮同列对位);
          //   L1 折叠走数据层 collapsedL1 (子行直接不出), 不调 antd onExpand => L1 永不进 expandedRowKeys, 无空展开行
          rowExpandable: () => true,
          expandedRowRender: (r) =>
            r.kind === 'l2' ? (
              <GroupExpandedArea
                group={r.group}
                onOpenStatus={() => setConfigTarget({ kind: 'l2', groupId: r.group.id })}
              />
            ) : null,
          expandIcon: ({ record: r, expanded, onExpand }) =>
            r.kind === 'l1' ? (
              <Button
                size='small'
                type='text'
                className='h-22px w-22px shrink-0 px-0'
                title={collapsedL1.has(r.id) ? '展开' : '折叠'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleL1Collapse(r.id)
                }}
              >
                {collapsedL1.has(r.id) ? (
                  <IconLucideFolder className='text-15px' />
                ) : (
                  <IconLucideFolderOpen className='text-15px' />
                )}
              </Button>
            ) : (
              <button
                type='button'
                className={`ant-table-row-expand-icon ${expanded ? 'ant-table-row-expand-icon-expanded' : 'ant-table-row-expand-icon-collapsed'}`}
                aria-label={expanded ? '收起' : '展开'}
                onClick={(e) => onExpand(r, e)}
              />
            ),
        }}
        locale={{
          emptyText: search.trim() ? '没有匹配的组或标签' : '新建一级组后，点击「＋ 二级组」创建空组；也可从标签新建',
        }}
      />

      <Modal
        title='新建二级组'
        open={!!newChild}
        onCancel={() => setNewChild(undefined)}
        onOk={createChild}
        okText='创建空组'
        okButtonProps={{ disabled: !newChild?.name.trim() }}
        width={360}
      >
        <div className='mb-10px text-12px opacity-65'>
          {themeList.find((t) => t.id === l1s.find((l) => l.id === newChild?.l1Id)?.themeId)?.name ?? '未归属'} ›{' '}
          {l1s.find((l) => l.id === newChild?.l1Id)?.name} › 新二级组
        </div>
        <Input
          autoFocus
          maxLength={120}
          placeholder='输入二级组名'
          aria-label='二级组名'
          value={newChild?.name ?? ''}
          onChange={(e) => setNewChild((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
          onPressEnter={createChild}
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          先建组，再添加标签。空组保留名称和配置，暂不参与推荐。
        </Typography.Text>
      </Modal>

      {/* feat4: 统一「并入…」Modal —— 「新建组」入口排第一位; 目标列表含已选项自身 (并入它=其余源并入);
          L1 档: 麾下二级组过继目标 + 源壳删; L2 档: 正/负向成员并入目标 + 源组删 */}
      <Modal
        title={mergeKind === 'l1' ? `并入 ${selL1Ids.length} 个一级组` : `并入 ${selL2Ids.length} 个标签组`}
        open={mergeOpen}
        onCancel={() => setMergeOpen(false)}
        onOk={() => void confirmMerge()}
        okText='并入'
        okButtonProps={{ disabled: !mergeTarget }}
        width={400}
      >
        <Select
          showSearch
          optionFilterProp='label'
          className='mt-12px w-full'
          placeholder={mergeKind === 'l1' ? '选择目标一级组' : '选择目标标签组'}
          value={mergeTarget}
          onChange={setMergeTarget}
          options={
            mergeKind === 'l1'
              ? [
                  { value: NEW_L1_OPTION, label: '＋ 新建一级组并并入…' },
                  ...l1s.map((l) => ({
                    ...l1Option(l),
                    label: `${l1Option(l).label}${selL1Set.has(l.id) ? ' (已选)' : ''}`,
                  })),
                ]
              : [
                  { value: NEW_L2_OPTION, label: '＋ 新建标签组并并入…' },
                  ...(groups as TagGroup[]).map((g) => ({
                    value: g.id,
                    label: `${g.name} (${g.tag_ids.length} 个 id)${selL2Ids.includes(g.id) ? ' (已选)' : ''}`,
                  })),
                ]
          }
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          {mergeKind === 'l1'
            ? `勾选的一级组麾下标签组全部过继到目标, 源一级组删除${mergeTarget === NEW_L1_OPTION ? '; 目标=新建: 确认后弹窗取名' : ''}`
            : `成员与屏蔽名单合并; 其他设置冲突保留目标、缺项补齐, 合并后沿用目标组的设置与归属。源组删除${mergeTarget === NEW_L2_OPTION ? '; 新组以最早组为基准, 确认后取名' : ''}`}
        </Typography.Text>
      </Modal>

      {/* feat3+: 主题「并入…」Modal —— 「新建主题…」排首位; 已勾主题紧随置顶 (并入自己=其余并入它);
          同名主题 (实机可有同名双胞胎) 附 #短id 消歧; 源主题麾下 L1 改挂目标后源壳删 (清 0-L1 空壳主路径) */}
      <Modal
        title={`并入 ${checkedThemeIds.length} 个主题`}
        open={themeMergeOpen}
        onCancel={() => setThemeMergeOpen(false)}
        onOk={() => void confirmThemeMerge()}
        okText='并入'
        okButtonProps={{ disabled: !themeMergeTarget }}
        width={400}
      >
        <Select
          showSearch
          optionFilterProp='label'
          className='mt-12px w-full'
          placeholder='选择目标主题'
          value={themeMergeTarget}
          onChange={setThemeMergeTarget}
          options={[
            { value: NEW_THEME_OPTION, label: '＋ 新建主题并并入…' },
            ...(themeList as TagTheme[])
              .slice()
              .sort((a, b) => Number(checkedThemeIds.includes(b.id)) - Number(checkedThemeIds.includes(a.id)))
              .map((t) => {
                const dup = themeList.filter((x) => x.name === t.name).length > 1
                const check = checkedThemeIds.includes(t.id) ? ' (已勾)' : ''
                return {
                  value: t.id,
                  label: `${t.name}${dup ? `·#${t.id.slice(0, 4)}` : ''} (${l1s.filter((l) => l.themeId === t.id).length} 个一级组)${check}`,
                }
              }),
          ]}
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          勾选主题麾下的一级组全部改挂到目标主题, 源主题删除
          {themeMergeTarget === NEW_THEME_OPTION ? '; 目标=新建: 确认后弹窗取名' : ''}
        </Typography.Text>
      </Modal>

      {/* feat3+: 吸顶条「挂到主题…」Modal —— 新建排首位; 「未归属」= 清回 (L1 落「全部」档) */}
      <Modal
        title={`把 ${selL1Ids.length} 个一级组挂到主题`}
        open={assignThemeOpen}
        onCancel={() => setAssignThemeOpen(false)}
        onOk={() => void confirmAssignTheme()}
        okText='归入'
        okButtonProps={{ disabled: !assignThemeTarget }}
        width={400}
      >
        <Select
          showSearch
          optionFilterProp='label'
          className='mt-12px w-full'
          placeholder='选择目标主题'
          value={assignThemeTarget}
          onChange={setAssignThemeTarget}
          options={[
            { value: NEW_THEME_OPTION, label: '＋ 新建主题…' },
            { value: THEME_ASSIGN_CLEAR, label: '未归属 (清回)' },
            ...(themeList as TagTheme[]).map((t) => ({
              value: t.id,
              label: `${t.name} (${l1s.filter((l) => l.themeId === t.id).length} 个一级组)`,
            })),
          ]}
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          主题是筛子不是容器: 改挂不动 enabled/weight, 只在 tab1 主题档参与过滤
        </Typography.Text>
      </Modal>

      {/* 票 31: 吸顶条「移到一级组…」Modal —— Select 列全部 L1 +「新建一级组…」入口 (与行内「所属一级组」同款);
          改挂后源一级组空壳由 moveGroupsToL1 汇总删除 (删空壳非数据, 不二次确认) */}
      <Modal
        title={`移动 ${selL2Ids.length} 个标签组到一级组`}
        open={moveL2Open}
        onCancel={() => setMoveL2Open(false)}
        onOk={confirmMoveL2}
        okText='移动'
        okButtonProps={{ disabled: !moveL2Target }}
        width={400}
      >
        <Select
          showSearch
          optionFilterProp='label'
          className='mt-12px w-full'
          placeholder='选择目标一级组'
          value={moveL2Target}
          onChange={setMoveL2Target}
          options={[{ value: NEW_L1_OPTION, label: '＋ 新建一级组…' }, ...l1s.map(l1Option)]}
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          改挂后源一级组若变空壳将提示并自动删除
        </Typography.Text>
      </Modal>

      {/* [tag-rec] 票 16 (tag-share): 分享上传 Modal —— 清单确认 + 风险告知 + token 落 GM;
          票 31: dup-check 软提醒「更新原分享」经 onOpenMyShares 回调父级开「我的分享」定位行 */}
      <TagRecShareModal
        open={shareOpen}
        groups={shareGroups}
        onClose={() => setShareOpen(false)}
        onOpenMyShares={onOpenMyShares}
      />

      {/* 旧全局黑名单迁移入口 (票 14): store 休眠后存量一键导入为选中组负向 */}
      <LegacyBlacklistImportRow />

      {/* 票12: 组配置弹层 (行 ⚙ 入口; L2/L1 共用) */}
      <TagRecGroupConfigModal open={!!configTarget} target={configTarget} onClose={() => setConfigTarget(undefined)} />
    </>
  )
}

/**
 * L2 行「所属一级组」指认 (票 17): 下拉列全部 L1 (停用/挂起带态后缀, 指入停用 L1 合法但暂不入抽)
 * +「新建一级组…」入口 —— 先取名，确认后才创建和归入；取消保持原归属。
 */
function L1AssignSelect({ group }: { group: TagGroup }) {
  const { list: l1List } = useSnapshot(favoritesL1Store)
  const l1s = l1List as TagL1Group[]
  // 悬挂 l1Id (防御态) 不落回显裸值, 回 placeholder 引导重指认
  const value = group.l1Id && l1s.some((l) => l.id === group.l1Id) ? group.l1Id : undefined
  return (
    <Select
      size='small'
      className='w-full'
      aria-label={`所属一级组：${group.name}`}
      placeholder='未归属'
      showSearch
      optionFilterProp='label'
      getPopupContainer={(trigger) => trigger.parentElement!}
      value={value ?? null}
      options={[{ value: NEW_L1_OPTION, label: '＋ 新建一级组…' }, ...l1s.map(l1Option)]}
      onChange={(v) => {
        if (v === NEW_L1_OPTION) {
          void createL1AndMoveGroups([group.id]).then((res) => {
            if (res) toast(`已建一级组「${res.l1.name}」并归入 (默认停用)`)
          })
        } else {
          favoritesL1.assignGroupToL1(group.id, v)
        }
      }}
    />
  )
}

/**
 * L1 行「所属主题」指认 (票 26): 下拉列全部主题 + allowClear(清空=未归属, 落「全部」档)
 * +「新建主题…」入口 —— 弹窗取名 => addTheme + 自动指认本 L1;
 * 主题是筛子不是容器: 指认不改 enabled/weight, 只在 tab1 主题档参与过滤
 */
function ThemeAssignSelect({ l1 }: { l1: TagL1Group }) {
  const { list: themeList } = useSnapshot(themesStore)
  // 悬挂 themeId (防御态: 主题已删残留) 不落回显裸值, 回 placeholder 引导重指认
  const value = l1.themeId && themeList.some((t) => t.id === l1.themeId) ? l1.themeId : undefined
  return (
    <Select
      size='small'
      className='w-full font-bold'
      styles={{ root: { borderColor: 'var(--bilibili-gate--primary-color)' } }}
      aria-label={`所属主题：${l1.name}`}
      placeholder='选择或新建主题'
      allowClear
      showSearch
      optionFilterProp='label'
      getPopupContainer={(trigger) => trigger.parentElement!}
      // undefined 会让 Select 保留内部选择，取消后「新建」被当作当前值，无法再次触发。
      value={value ?? null}
      options={[
        { value: NEW_THEME_OPTION, label: '＋ 新建主题…' },
        ...(themeList as TagTheme[]).map((t) => ({ value: t.id, label: t.name })),
      ]}
      onChange={(v) => {
        if (v === NEW_THEME_OPTION) {
          void createThemeAndAssign(l1)
        } else {
          themes.assignL1ToTheme(l1.id, v) // undefined (allowClear 清空) => 落回未归属
        }
      }}
    />
  )
}

/**
 * feat3+: 主题复选框 (chip 撤) —— 勾选 = 表格只展该主题麾下 (多选并集, 空集=全部);
 * 右键出菜单 [改名…/删除]; 当前生效主题名高亮 (active=主题推荐正在抽的主题);
 * 0-L1 空壳主题灰显 (并入素材一目了然)
 */
function ThemeFilterCheck({
  theme,
  l1Count,
  active,
  checked,
  onCheck,
}: {
  theme: TagTheme
  l1Count: number
  active: boolean
  checked: boolean
  onCheck: (v: boolean) => void
}) {
  const rename = async () => {
    let draft = theme.name
    const ok = await antModal.confirm({
      centered: true,
      title: '主题改名',
      content: <Input autoFocus defaultValue={theme.name} onChange={(e) => (draft = e.target.value)} />,
      okText: '改名',
    })
    if (!ok || draft.trim() === theme.name) return
    themes.updateTheme(theme.id, { name: draft }) // 空名门面自拒+toast
  }
  const remove = async () => {
    const ok = await antModal.confirm({
      centered: true,
      title: `删除主题「${theme.name}」?`,
      content: l1Count ? `麾下 ${l1Count} 个一级组将落回「未归属」(组与启用状态不动)` : '该主题下没有归属的一级组',
      okText: '删除',
      okButtonProps: { danger: true },
    })
    if (!ok) return
    themes.removeTheme(theme.id)
  }
  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [
          { key: 'rename', label: '改名…' },
          { key: 'remove', label: '删除', danger: true },
        ],
        onClick: ({ key }) => (key === 'rename' ? void rename() : void remove()),
      }}
    >
      <span>
        <AntdTooltip title='勾选筛选本主题的一级组 · 右键改名/删除 · ↗ 以本主题打开「主题推荐」'>
          <span className='inline-flex items-center'>
            <Checkbox checked={checked} onChange={(e) => onCheck(e.target.checked)}>
              <span className={`text-12px ${active ? 'color-gate-primary font-600' : l1Count ? '' : 'opacity-50'}`}>
                {theme.name} · {l1Count}
              </span>
            </Checkbox>
            {/* feat3+: 主题深链 —— 独立 ↗ 小图标 (不吞 checkbox 勾选, 防误触);
                持久语义: 先落 active 再开 tab1 新标签页, 新 tab 读到的即是本主题。
                UIUX-U1-5: 真链接化 (href+target) —— 主键点击 onClick 仍先落 active 再走原生导航,
                中键/复制链拿到的也是同一深链 (非破坏打开不设 active, 语义更稳) */}
            <Typography.Link
              className='ml-3px text-12px'
              title={`以主题「${theme.name}」打开「主题推荐」`}
              href={buildTagRecFavDeepLink(location.origin)}
              target='_blank'
              onClick={(ev) => {
                ev.stopPropagation()
                themes.setActive(theme.id)
              }}
            >
              ↗
            </Typography.Link>
          </span>
        </AntdTooltip>
      </span>
    </Dropdown>
  )
}

/** 弹窗取名 (feat4「并入…」新建档): 确认 => 输入串 (空串门面自拒), 取消 => undefined */
async function promptText(title: string, defaultValue = ''): Promise<string | undefined> {
  let draft = defaultValue
  const ok = await antModal.confirm({
    centered: true,
    title,
    content: (
      <Input
        autoFocus
        aria-label='名称'
        placeholder='输入名称'
        defaultValue={defaultValue}
        onChange={(e) => (draft = e.target.value)}
      />
    ),
    okText: '确定',
  })
  return ok ? draft : undefined
}

/** 行内与批量「新建一级组」共用：取消/空名/源组失效均不迁移，失败时不留下新空壳。 */
async function createL1AndMoveGroups(groupIds: string[]) {
  const name = await promptText('新建一级组并归入')
  if (name === undefined) return
  if (!groupIds.length || groupIds.some((id) => !favorites.list.some((g) => g.id === id))) {
    toast('标签组已不存在')
    return
  }
  const l1 = favoritesL1.addL1({ name })
  if (!l1) return
  const res = favoritesL1.moveGroupsToL1(groupIds, l1.id)
  if (!res) favoritesL1.removeL1(l1.id)
  return res
}

/** 「新建主题…」(票 26): 弹窗取名 => addTheme (空名门面自拒) => 自动指认当前 L1 */
async function createThemeAndAssign(l1: TagL1Group) {
  let draft = ''
  const ok = await antModal.confirm({
    centered: true,
    title: `新建主题, 并把一级组「${l1.name}」归入`,
    content: <Input autoFocus placeholder='主题名 (如: 游戏)' onChange={(e) => (draft = e.target.value)} />,
    okText: '新建并归入',
  })
  if (!ok) return
  const t = themes.addTheme({ name: draft })
  if (!t) return // 空名: 门面已 toast
  themes.assignL1ToTheme(l1.id, t.id)
  toast(`已建主题「${t.name}」并把「${l1.name}」归入`)
}

/** 展开行 = 组内 tag_id 芯片列表 + 负向成员位 (票 14) + 尾部「添加变体」/「重新挖掘变体」 + chip 批量移/复 (票 29) */
function GroupExpandedArea({ group, onOpenStatus }: { group: TagGroup; onOpenStatus: () => void }) {
  const { list: allGroups } = useSnapshot(favoritesStore)
  const [addingVariant, setAddingVariant] = useState(!group.tag_ids.length)
  const [enableAfterAdding, setEnableAfterAdding] = useState(true)
  const [addingNegative, setAddingNegative] = useState(false)
  // 票 29: tag chip 批量模式 —— 「批量选择」开关 => 点 chip 切选中态 (不打拖框); 选中>0 出「移到组…/复制到组…」
  const [batchPick, setBatchPick] = useState(false)
  const [pickedIds, setPickedIds] = useState<ReadonlySet<number>>(new Set())
  const [batchOp, setBatchOp] = useState<'move' | 'copy' | undefined>(undefined)
  const [batchTargetId, setBatchTargetId] = useState<string | undefined>(undefined)
  const [opIds, setOpIds] = useState<number[]>([]) // feat4: 本次移/复作用的 id 集 (批选或单条)
  // feat3+: 「共现变体表」—— 沉淀池汇总本组各成员 norm 的共现边 (离线零请求建表);
  //   行=候选 (name-only, badge=共现), 勾选后经 resolveCandidateRows 现场解析入组 (票 18 惰性语义同款)
  const [cooccurOpen, setCooccurOpen] = useState(false)
  const [cooccurRows, setCooccurRows] = useState<CandidateRow[]>([])
  const [cooccurBusy, setCooccurBusy] = useState(false)
  const negatives = groupNegativeTagIds(group)

  const togglePick = (id: number) =>
    setPickedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // feat4: 批选删除 —— 逐 id removeTagIdFromGroup (末位保底拒移由门面自 toast)
  const deletePicked = () => {
    let removed = 0
    for (const id of pickedIds) if (favorites.removeTagIdFromGroup(group.id, id)) removed++
    if (removed) toast(`已从本组移出 ${removed} 个标签`)
    setPickedIds(new Set())
  }

  /**
   * 批量确认 (票 29): 移 = addTagIdsToGroup(目标) + 逐 id removeTagIdFromGroup(本组);
   * 复 = 仅 addTagIdsToGroup (tag 多宿主本就支持, 票 12); 去重/skipped/负向撞车转正走门面内建汇报;
   * 末位保底拒移 (组恒 ≥1 正向) 由 removeTagIdFromGroup 自 toast; 负向成员不在本批量范围
   */
  const confirmBatchOp = () => {
    const op = batchOp
    const targetId = batchTargetId
    const ids = new Set(opIds) // feat4: 批选=全部勾选项 / 单条 chip「移到…」= 该 id
    setBatchOp(undefined)
    if (!op || !targetId) return
    // 目标组确认瞬间失效 (跨 tab 删组) => 拒: addTagIdsToGroup 目标缺失静默空返, 继续移出会丢 id
    if (!favorites.list.some((g) => g.id === targetId)) {
      toast('目标标签组不存在')
      return
    }
    const entries = group.tag_ids.filter((e) => ids.has(e.id)).map((e) => ({ ...e }))
    if (!entries.length) return
    favorites.addTagIdsToGroup(targetId, entries)
    if (op === 'move') {
      let removed = 0
      for (const e of entries) {
        if (favorites.removeTagIdFromGroup(group.id, e.id)) removed++
      }
      toast(`已从本组移出 ${removed} 个标签`)
    }
    setPickedIds(new Set())
  }

  /** 「共现变体表」开合: 开=从沉淀池聚合本组各成员的共现邻域 (剔除已在组内正/负向), 频次跨成员累加 */
  const toggleCooccur = () => {
    if (cooccurOpen) {
      setCooccurOpen(false)
      return
    }
    const memberNorms = new Set(group.tag_ids.map((e) => normalizeTagName(e.name)))
    const negNorms = new Set(negatives.map((e) => normalizeTagName(e.name)))
    const acc = new Map<string, { name: string; count: number }>()
    for (const norm of memberNorms) {
      const node = sediment.map.get(norm)
      if (!node) continue
      for (const [other, edge] of Object.entries(node.cooccur)) {
        if (memberNorms.has(other) || negNorms.has(other)) continue
        const cur = acc.get(other)
        if (cur) cur.count += edge.count
        else acc.set(other, { name: sediment.map.get(other)?.variants[0] ?? other, count: edge.count })
      }
    }
    setCooccurRows(
      [...acc]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 50)
        .map(([norm, x]) => ({
          key: `n:${norm}`,
          tag_name: x.name,
          cooccur: x.count,
          badge: 'cooccur' as const,
          checked: false,
        })),
    )
    setCooccurOpen(true)
  }

  /** 「共现变体表」确认: 勾选行现场 tag/info 解析 (票 18 惰性) => 正向入本组; 解析失败的留表可重勾重试 */
  const confirmCooccur = async (checked: readonly CandidateRow[]) => {
    setCooccurBusy(true)
    try {
      const resolved = await resolveCandidateRows(checked)
      const entries = resolved.filter((r) => r.tag_id !== undefined).map((r) => ({ id: r.tag_id!, name: r.tag_name }))
      const failed = resolved.length - entries.length
      if (entries.length) {
        favorites.addTagIdsToGroup(group.id, entries) // 门面自报 added/skipped/alsoIn
        setCooccurOpen(false)
      }
      if (failed) toast(`${failed} 个候选解析失败, 可重试`)
    } finally {
      setCooccurBusy(false)
    }
  }

  return (
    <div>
      {/* 展开区顶行: 组合组先给条件句 + 工作台深链; 「查看现状」= ⚙ 弹窗的第二入口 (wayfinding 001) */}
      <div className='mb-6px flex flex-wrap items-center gap-x-7px gap-y-3px text-11px'>
        {hasTagRecCombination(group.combination) && (
          <>
            <span className='break-words opacity-75'>条件: {nameTagRecCombination(group.combination!)}</span>
            <Typography.Link
              href={buildTagRecCustomDeepLink(location.origin, { group: group.id })}
              target='_blank'
              title='在「标签发掘」中编辑子组 / 全部命中·任一命中 / 标签·标题·简介等条件'
              onClick={(e) => e.stopPropagation()}
            >
              编辑条件 ↗
            </Typography.Link>
          </>
        )}
        <Typography.Link
          title='条件树 / 生效值与来源 / 抽牌状态'
          onClick={(e) => {
            e.stopPropagation()
            onOpenStatus()
          }}
        >
          查看现状
        </Typography.Link>
      </div>
      <div className='flex flex-wrap items-center gap-6px'>
        {/* feat4: 「批量选择」前置 —— 放第一个子标签前, 否则长尾时不可见 */}
        <Button
          size='small'
          type={batchPick ? 'primary' : 'default'}
          onClick={() => {
            setBatchPick((v) => !v)
            setPickedIds(new Set())
          }}
        >
          {batchPick ? `退出批量 (${pickedIds.size})` : '批量选择'}
        </Button>
        {group.tag_ids.map((e) => {
          const picked = pickedIds.has(e.id)
          return (
            <span
              key={e.id}
              className={`inline-flex items-center gap-x-4px b-1px rounded-6px b-solid px-6px py-2px ${
                batchPick
                  ? `cursor-pointer select-none ${picked ? 'b-gate-primary color-gate-primary' : 'b-gate-border'}`
                  : 'b-gate-border'
              }`}
              // 票 31: 选中态浅粉底 —— gate-primary 是 CSS 变量色, UnoCSS 算不出 /10% 透明度 (产出实心粉底粉字不可读),
              // 浅底走 inline color-mix (双色 scheme 自适应: 深 theme 下 primary 变量本身已适配)
              style={
                batchPick && picked
                  ? { backgroundColor: 'color-mix(in srgb, var(--bilibili-gate--primary-color) 12%, transparent)' }
                  : undefined
              }
              onClick={batchPick ? () => togglePick(e.id) : undefined}
            >
              {batchPick && picked && <span className='text-12px color-gate-primary'>✓</span>}
              {/* feat3: #id 文本撤 —— 名本身即深链跳 tab2 解析 (同卡片弹层 #id 语义);
                  批选态降级纯文本防误跳; tag_type 徽标同 popover 判例不渲 (old_channel 噪音) */}
              {batchPick ? (
                <span>{e.name}</span>
              ) : (
                <Typography.Link
                  href={buildTagRecCustomDeepLink(location.origin, { input: e.name })}
                  target='_blank'
                  title={`在「标签发掘」页解析「${e.name}」(#${e.id})`}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  {e.name}
                </Typography.Link>
              )}
              {e.tag_type && e.tag_type !== 'old_channel' && <Tag className='mr-0'>{e.tag_type}</Tag>}
              {/* feat4: 单 chip 动作收成「移到…」一项 —— 移到组…(复用批量弹层) / 移到垃圾桶(移出本组);
                  「拆为新项」撤 (实用性低); 批量态隐去 (点 chip = 切选中, 防误触) */}
              {!batchPick && (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'move', label: '移到组…' },
                      { key: 'trash', label: '移到垃圾桶 (移出本组)', danger: true },
                    ],
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation()
                      if (key === 'trash') {
                        favorites.removeTagIdFromGroup(group.id, e.id)
                      } else {
                        setOpIds([e.id])
                        setBatchTargetId(undefined)
                        setBatchOp('move')
                      }
                    },
                  }}
                >
                  <Button
                    size='small'
                    type='link'
                    className='h-auto px-2px text-12px'
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    移到…
                  </Button>
                </Dropdown>
              )}
            </span>
          )
        })}
      </div>

      {/* 批量动作区: 选中数>0 时浮出 (票 29) —— 移/复弹 Modal+showSearch Select 选目标 L2 (排除本组);
          feat4: 批选态补「删除」键 */}
      {batchPick && pickedIds.size > 0 && (
        <div className='mt-6px flex items-center gap-x-8px'>
          <Typography.Text type='secondary' className='text-12px'>
            已选 {pickedIds.size} 个标签
          </Typography.Text>
          <Button
            size='small'
            onClick={() => {
              setOpIds([...pickedIds])
              setBatchTargetId(undefined)
              setBatchOp('move')
            }}
          >
            移到组…
          </Button>
          <Button
            size='small'
            onClick={() => {
              setOpIds([...pickedIds])
              setBatchTargetId(undefined)
              setBatchOp('copy')
            }}
          >
            复制到组…
          </Button>
          <Popconfirm title='确定' description={`把勾选的 ${pickedIds.size} 个标签移出本组?`} onConfirm={deletePicked}>
            <Button size='small' danger>
              删除
            </Button>
          </Popconfirm>
        </div>
      )}

      {/* 负向成员位 (票 14): 负向 tag 经池交集/名匹配过滤本组流; 同组正负互斥由门面层守 */}
      <div className='mt-10px'>
        <Typography.Text type='secondary' className='mb-4px block text-12px'>
          负向成员 (本组流内剔除; all/v2 名匹配 + 负向池交集近似, 严检见右)
        </Typography.Text>
        <div className='flex flex-wrap items-center gap-6px'>
          {negatives.map((e) => (
            <Tag
              key={e.id}
              color='red'
              closable
              onClose={(ev) => {
                ev.preventDefault() // 防 antd 默认隐藏动画与 valtio 删行打架
                favorites.removeNegativeFromGroup(group.id, e.id)
              }}
            >
              ⛔ {e.name}
            </Tag>
          ))}
          {!negatives.length && (
            <Typography.Text type='secondary' className='text-12px'>
              无负向成员
            </Typography.Text>
          )}
          <Button size='small' onClick={() => setAddingNegative((v) => !v)}>
            {addingNegative ? '收起' : '添加负向'}
          </Button>
          <AntdTooltip title='严格校验: 出队切片对本组来源逐条拉取视频标签核查负向命中 (每上屏视频至多 1 次请求; 风控可疑期自动停扣)'>
            <span className='inline-flex items-center gap-x-4px text-12px'>
              严格校验
              <Switch
                size='small'
                checked={group.negative_strict ?? false}
                onChange={(v) => favorites.updateGroup(group.id, { negative_strict: v })}
              />
            </span>
          </AntdTooltip>
        </div>
        {addingNegative && (
          <CandidateResolvePicker
            confirmLabel='加入本组负向'
            onConfirm={(entries) => {
              const res = favorites.addNegativeToGroup(group.id, entries)
              if (res.added || res.moved) setAddingNegative(false)
              if (res.refusedSole.length)
                toast(`「${res.refusedSole[0].name}」是组内唯一正向, 未转负向 (组至少留 1 个正向)`)
            }}
          />
        )}
      </div>

      <div className='mt-8px flex items-center gap-x-8px'>
        <Button size='small' onClick={() => setAddingVariant((v) => !v)}>
          {addingVariant ? '收起' : '添加变体'}
        </Button>
        {/* feat3+: 「重新挖掘变体」实装 = 共现变体表 —— 沉淀池里本组各成员的共现邻域汇总
            (离线零请求, 展示历史挖掘存量; 勾选确认时才 tag/info 现场解析) */}
        <AntdTooltip title='沉淀池汇总本组各成员标签的共现邻域 (离线读存量, 零请求); 勾选后经 tag/info 解析入组'>
          <Button size='small' type={cooccurOpen ? 'primary' : 'default'} onClick={toggleCooccur}>
            {cooccurOpen ? '收起' : '共现变体表'}
          </Button>
        </AntdTooltip>
      </div>

      {addingVariant && (
        <>
          {!group.tag_ids.length && (
            <div className='my-8px text-12px'>
              <Checkbox checked={enableAfterAdding} onChange={(e) => setEnableAfterAdding(e.target.checked)}>
                添加后启用二级组
              </Checkbox>
              <Typography.Text type='secondary' className='mt-4px block text-11px'>
                一级组开关保持不变；一级组关闭时，这个组仍不会参与推荐。
              </Typography.Text>
            </div>
          )}
          <CandidateResolvePicker
            confirmLabel='加入本组'
            onConfirm={(entries) => {
              const wasEmpty = !group.tag_ids.length
              const res = favorites.addTagIdsToGroup(group.id, entries)
              if (res.added) {
                if (wasEmpty && enableAfterAdding) favorites.updateGroup(group.id, { enabled: true })
                setAddingVariant(false)
              }
            }}
          />
        </>
      )}

      {cooccurOpen && (
        <TagRecCandidatePickList
          rows={cooccurRows}
          onToggleRow={(key, checked) =>
            setCooccurRows((prev) => prev.map((r) => (r.key === key ? { ...r, checked } : r)))
          }
          confirmLabel='加入本组'
          statusText={
            cooccurRows.length
              ? `沉淀池共现 ${cooccurRows.length} 条 (本组各成员邻域并集, 频次跨成员累加)`
              : '沉淀池暂无本组共现记录 (先跑几轮解析/推荐积累语料)'
          }
          busy={cooccurBusy}
          onConfirm={(checked) => void confirmCooccur(checked)}
        />
      )}

      {/* 批量移/复目标选择器 (票 29): 单选目标 L2 (排除本组, showSearch), 同弹层入组 Modal 范式 */}
      <Modal
        title={batchOp === 'move' ? `移动 ${opIds.length} 个标签到组` : `复制 ${opIds.length} 个标签到组`}
        open={batchOp !== undefined}
        onCancel={() => setBatchOp(undefined)}
        onOk={confirmBatchOp}
        okText={batchOp === 'move' ? '移动' : '复制'}
        okButtonProps={{ disabled: !batchTargetId }}
        width={360}
      >
        <Select
          showSearch
          optionFilterProp='label'
          className='mt-12px w-full'
          placeholder='选择目标标签组'
          value={batchTargetId}
          onChange={setBatchTargetId}
          options={(allGroups as TagGroup[])
            .filter((g) => g.id !== group.id)
            .map((g) => ({ value: g.id, label: `${g.name} (${g.tag_ids.length} 个 id)` }))}
        />
        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          {batchOp === 'move'
            ? '移动 = 加入目标组并从本组移出；移出最后一个标签后保留空组和配置，并关闭该组'
            : '复制 = 仅加入目标组, 本组保留 (tag 多宿主本就支持)'}
        </Typography.Text>
      </Modal>
    </div>
  )
}
// #endregion

// #region 旧黑名单迁移入口 (票 14: 全局黑名单休眠, 存量可导入为组负向)
function LegacyBlacklistImportRow() {
  const { list: groups } = useSnapshot(favoritesStore)
  const { list: oldBlacklist } = useSnapshot(blacklistStore)
  const [targetId, setTargetId] = useState<string | undefined>(undefined)
  if (!oldBlacklist.length) return null
  return (
    <div className='mt-8px flex items-center gap-x-8px'>
      <Typography.Text type='secondary' className='text-12px'>
        旧全局黑名单 {oldBlacklist.length} 项 (已休眠, 不参与过滤)
      </Typography.Text>
      <Select
        size='small'
        className='min-w-160px'
        placeholder='导入为哪组的负向'
        value={targetId}
        onChange={setTargetId}
        options={(groups as TagGroup[]).map((g) => ({ value: g.id, label: g.name }))}
      />
      <Button
        size='small'
        disabled={!targetId}
        onClick={() => {
          if (!targetId) return
          const res = favorites.addNegativeToGroup(
            targetId,
            oldBlacklist.map((e) => ({ id: e.id, name: e.name })),
          )
          toast(`已导入负向 ${res.added + res.moved} 项${res.skipped ? ` (${res.skipped} 项已在负向跳过)` : ''}`)
        }}
      >
        导入为负向
      </Button>
    </div>
  )
}
// #endregion

// #region 危险区 —— 仅保留会删除用户收藏的操作
function DangerZoneSection() {
  return (
    <div>
      <div className='flex items-center gap-x-8px'>
        <Popconfirm
          title='清空收藏表'
          description='全部标签组/一级组/主题名册将整体删除 (黑名单/沉淀/已看不动)。确定?'
          okText='清空'
          okButtonProps={{ danger: true }}
          onConfirm={() => {
            const g = favorites.clearAll()
            const l = favoritesL1.clearAll()
            const t = themes.clearAll() // 实机修复: 空壳主题名册随收藏表同清 (原残留 0-L1 主题)
            toast(`已清空收藏表 (${l} 个一级组 / ${g} 个标签组${t ? ` / ${t} 个主题` : ''})`)
          }}
        >
          <Button size='small' danger>
            清空收藏表
          </Button>
        </Popconfirm>
      </div>
    </div>
  )
}
// #endregion
