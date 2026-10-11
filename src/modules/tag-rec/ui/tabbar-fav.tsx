import { Button, Checkbox, Popover, Typography } from 'antd'
import { useCallback, useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { modalSettingsStore, TabPaneKey } from '$components/ModalSettings/shared' // [tag-rec] 票 perf-08: 轻模块, 不拉 ModalSettings 图
import { showModalSettings } from '$components/RecHeader/modals'
import { useOnRefresh, useRecSelfContext } from '$components/Recommends/rec.shared'
import { AntdTooltip } from '$modules/antd/custom'
import { usePopupContainer } from '$modules/rec-services/_base'
import { useSettingsSnapshot } from '$modules/settings'
import { tagRecViewedGroupIds } from '../model/theme-scope-draft'
import { tagRecViewScopeViewedIds } from '../model/view-scope'
import { clampTagRecK } from '../service/_pipeline'
import { isDeckDrawable, isL1Drawable, withTagRecGroupScope } from '../service/deck'
import { favoritesL1Store, favoritesStore, themesStore, viewScopeStore } from '../store'
import { tagRecFavSession, tagRecSharedSession } from '../store/session'
import { TagRecBanner } from './banner' // [tag-rec]
import { FilterPopover } from './filter-popover'
import { TagRecRecheckButton } from './recheck-button'
import { TagRecShareImportModal } from './share-import-modal' // [tag-rec] 票 18 (tag-share)
import { TagRecThemeScopePicker } from './theme-scope-picker' // [tag-rec] R7
import type { TagGroup, TagL1Group, TagTheme } from '../model/types'
import type { TagRecFavService } from '../service/tag-rec-fav'

/**
 * [tag-rec] 「主题推荐」tabbarView (spec §5.2; R7 改名+主题下拉升级)
 * 主题下拉 (R7): 双列复选树 (TagRecThemeScopePicker) —— 查看范围零写入 + 临时打开 (会话级);
 *   默认勾选 = 启用集; 面板草稿在离开后统一提交并刷新; 持久化显式同步一级组 enabled
 * 本查看范围临时过滤与标签发掘共用弹层；全局默认预设入口另列。
 */
export function TagRecFavTabbarView({ service }: { service: TagRecFavService }) {
  const onRefresh = useOnRefresh()
  const onScopeChanged = useCallback(() => {
    void onRefresh('refresh')
  }, [onRefresh])
  const [groupsOpen, setGroupsOpen] = useState(false)
  const { recSharedEmitter } = useRecSelfContext()
  const { ref, getPopupContainer } = usePopupContainer()
  const { list } = useSnapshot(favoritesStore)
  const { list: l1List } = useSnapshot(favoritesL1Store)
  const { list: themeList } = useSnapshot(themesStore)
  const { scope, groupScope } = useSnapshot(viewScopeStore)
  const { tempEnabledL1Ids, tempEnabledGroupIds } = useSnapshot(tagRecSharedSession)
  const { tagRec } = useSettingsSnapshot()
  const { drawnGroupNames, softBottom, bypassSeen } = useSnapshot(tagRecFavSession)

  const activePreset = tagRec.filter.activePreset
  // spec §5.2: chip 点击 => 打开设置 modal 并定位「标签过滤」pane
  const jumpToFilterPane = () => {
    modalSettingsStore.tab = TabPaneKey.TagRecFilter
    showModalSettings()
  }

  // R7: 可抽 L2 数 = 资格 L2 ∧ 其 L1 有效 (启用或临时打开) ∧ 在查看范围内
  //   [tag-rec] perf: 535 组规模 O(l1×groups) —— tagRecFavSession 每轮写字段都会带起本组件重渲,
  //   快照输入 (valtio 不可变) 未变时整块复用
  const { drawable, parents, parentRows } = useMemo(() => {
    const themeIds = new Set((themeList as TagTheme[]).map((t) => t.id))
    const viewedIds = tagRecViewScopeViewedIds(scope, l1List as TagL1Group[], themeIds)
    const tempSet = new Set(tempEnabledL1Ids)
    const l1ById = new Map((l1List as TagL1Group[]).map((l) => [l.id, l]))
    const participating = withTagRecGroupScope(
      list as TagGroup[],
      tagRecViewedGroupIds(list as TagGroup[], groupScope),
      tempEnabledGroupIds,
    ).filter((g) => {
      if (!isDeckDrawable(g)) return false
      const l1 = g.l1Id ? l1ById.get(g.l1Id) : undefined
      return (
        !!l1 && isL1Drawable({ id: l1.id, enabled: l1.enabled || tempSet.has(l1.id), weight: l1.weight }, viewedIds)
      )
    })
    const parentIds = new Set(participating.map((g) => g.l1Id))
    const parents = (l1List as TagL1Group[]).filter((l) => parentIds.has(l.id))
    const themeNames = new Map(themeList.map((t) => [t.id, t.name]))
    const namesByParent = new Map<string, string[]>()
    for (const g of participating) {
      const names = namesByParent.get(g.l1Id!) ?? []
      names.push(g.name)
      namesByParent.set(g.l1Id!, names)
    }
    const parentRows = parents.map((l) => ({
      id: l.id,
      name: l.name,
      theme: themeNames.get(l.themeId ?? '') ?? '未归属',
      groups: namesByParent.get(l.id)!.join('、'),
    }))
    return { drawable: participating.length, parents, parentRows }
  }, [list, l1List, themeList, scope, groupScope, tempEnabledL1Ids, tempEnabledGroupIds])
  const tempCount = tempEnabledL1Ids.length

  return (
    <div ref={ref} className='flex flex-wrap items-center gap-x-10px gap-y-6px'>
      {/* R7: 主题下拉 (大而醒目, 双列复选树; 查看范围零写入 + 临时打开) */}
      <TagRecThemeScopePicker onChanged={onScopeChanged} getPopupContainer={getPopupContainer} />
      <FilterPopover scope='fav' getPopupContainer={getPopupContainer} />
      <AntdTooltip title='全局默认过滤预设；点击前往「标签过滤」设置，长期生效'>
        {/* UIUX-U2-8: 可点 chip => Button small (Tag+onClick 是伪按钮, 无焦点/键可达性) */}
        <Button size='small' onClick={jumpToFilterPane}>
          默认预设: {activePreset || '自定义'}
        </Button>
      </AntdTooltip>
      <AntdTooltip title='浏览过的卡片不再滤除；主题推荐默认关闭，标签发掘默认开启'>
        <Checkbox
          checked={bypassSeen}
          onChange={(event) => {
            tagRecFavSession.bypassSeen = event.target.checked
            onScopeChanged()
          }}
        >
          显示已看
        </Checkbox>
      </AntdTooltip>
      <Popover
        open={groupsOpen}
        onOpenChange={setGroupsOpen}
        destroyOnHidden
        fresh
        trigger='click'
        getPopupContainer={getPopupContainer}
        content={
          groupsOpen ? (
            <div style={{ width: 320, maxWidth: 'calc(100vw - 48px)' }}>
              <strong className='text-13px'>参与推荐的组</strong>
              <div className='mt-3px text-11px opacity-60'>
                {parents.length} 个一级组 / {drawable} 个二级组
              </div>
              <div className='my-10px max-h-260px overflow-y-auto'>
                {parentRows.map((l) => (
                  <div key={l.id} className='mb-10px'>
                    <div className='flex items-center gap-8px text-12px'>
                      <strong>{l.name}</strong>
                      <span className='text-11px opacity-55'>{l.theme}</span>
                    </div>
                    <div className='mt-3px break-words text-12px opacity-70'>{l.groups}</div>
                  </div>
                ))}
                {!parents.length && <span className='text-12px opacity-60'>暂无可参与抽取的组</span>}
              </div>
              <Typography.Text type='secondary' className='block text-11px'>
                按一级组、二级组权重混着推荐，标签多不会独占推荐。单条视频的来源看归因徽章。
              </Typography.Text>
              <div className='mt-8px b-t-1px b-gate-border b-t-solid pt-8px text-11px opacity-65'>
                每次预取至多 {clampTagRecK(tagRec.k)} 个一级组 / {drawable} 个二级组参与轮换
                {tempCount > 0 && <> · 含 {tempCount} 个临时一级组</>}
                {!!tempEnabledGroupIds.length && <> · 含 {tempEnabledGroupIds.length} 个临时二级组</>}
                {drawnGroupNames.length > 0 && <div className='mt-4px'>本批来源：{drawnGroupNames.join('、')}</div>}
              </div>
            </div>
          ) : (
            <span />
          )
        }
      >
        <Button size='small' type='text' className='max-w-80vw text-12px' aria-label='查看参与推荐的组'>
          <strong>推荐中</strong>
          <span className='mx-6px opacity-40'>·</span>
          <span className='truncate opacity-70'>
            {parents.length
              ? parents
                  .slice(0, 2)
                  .map((l) => l.name)
                  .join('、')
              : '暂无参与组'}
            {parents.length > 2 ? ` +${parents.length - 2} 个一级组` : ''}
          </span>
        </Button>
      </Popover>
      {softBottom && (
        <Typography.Text type='warning' className='text-11px'>
          池将见底
        </Typography.Text>
      )}
      {/* [tag-rec] 横幅槽位 (spec §5.4 统一提示区, 票 09; 票 13 深挖待决: 挖完 emit 'load-more' 再武装 grid hasMore) */}
      <TagRecRecheckButton service={service} onDone={() => void recSharedEmitter.emit('load-more')} />
      <TagRecBanner
        session={tagRecFavSession}
        onRedig={() => {
          void service.redigQuery().then(() => recSharedEmitter.emit('load-more'))
        }}
        onPartitionRetry={() => {
          service.retryPartitions()
          void recSharedEmitter.emit('load-more')
        }}
        onDigMore={() => void service.digMore().then(() => recSharedEmitter.emit('load-more'))}
      />
      {/* 票 18 (tag-share): 深链导入预览 Modal 挂载点 (origin='deeplink' —— 面板未开也能弹;
          粘贴导入经 pane 挂载点, origin 分流防双开) */}
      <TagRecShareImportModal origin='deeplink' />
    </div>
  )
}
