import { Alert, Button, Checkbox, Modal, Radio, Select, Spin, Switch, Tag, theme, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { modalSettingsStore, TabPaneKey } from '$components/ModalSettings/shared'
import { hideModalSettings, showModalSettings } from '$components/RecHeader/modals'
import { videoSourceTabState } from '$components/RecHeader/tab'
import { useRecSelfContext } from '$components/Recommends/rec.shared'
import { ETab } from '$enums'
import toast from '$utility/toast'
import { nameTagRecCombination } from '../model/combination'
import { resolveTagRecImportApply, type TagRecImportChoice } from '../model/import-export'
import { resolveShareImportL1Enabled, type ShareImportDraft } from '../model/share'
import { closeShareImportDraft, noteShareImportDone } from '../service/share-import'
import { favoritesL1, favoritesL1Store, themesStore } from '../store'
import { applyTagRecImport } from '../store/apply-import'
import { tagRecSharedSession } from '../store/session'
import { TagRecShareGroupContents } from './group-condition-tree'
import type { TagGroup } from '../model/types'

/**
 * [tag-rec] 分享导入预览 Modal (tag-share-platform 票 18 / spec §6) —— 深链与粘贴两条入口共用:
 * - 双挂载点: tabbar-fav (origin='deeplink' —— 深链回跳, 面板未开也能弹) +
 *   pane 工具区 (origin='paste' —— 粘贴导入); session.shareImport.origin 过滤防双开
 * - 卡头 = 分享元信息 (标题/分享者链空间/赞数/打开分享页); 清单默认全勾,
 *   深链 tag-rec-groups 圈过子集时清单本就只含这些组 (planShareImport 前置裁剪),
 *   指定 id 不在包内 => 「N 个组不在包内」警示
 * - 一级组默认全启用 (planShareImport 归一 true), 行/节/批量开关反向取消 => disabledL1Ids;
 *   勾选结果 = 最终启用集, 落表后逐条 updateL1 (resolveShareImportL1Enabled 裁决);
 *   导入后不切主题 (后导入横幅另给「只看这个包的主题」)
 * - 冲突裁量/落表与 JSON 导入同一套 (resolveTagRecImportApply → applyTagRecImport);
 *   黑名单默认并入可关; 票26: 包内非占位 filterConfig 时裁决区加「带入过滤配置」勾选
 *   (勾上 = 分享者私配整套覆写当前过滤配置), 出厂占位包不渲染该项 (无可带入内容)
 * - 确认后: 挂「待回赞」账 (票 19) + 武装一次性「勾选想看的主题/组」引导横幅
 */
export function TagRecShareImportModal({ origin }: { origin: 'deeplink' | 'paste' }) {
  const si = useSnapshot(tagRecSharedSession).shareImport
  if (si.origin !== origin) return null
  if (si.loading) {
    return (
      <Modal open title='导入分享' footer={null} maskClosable={false} onCancel={closeShareImportDraft} width={420}>
        <Spin size='small' />{' '}
        <Typography.Text type='secondary' className='ml-8px text-13px'>
          正在获取分享内容…
        </Typography.Text>
      </Modal>
    )
  }
  // draft 经 ref() 脱壳入 session (raw 对象), snapshot 类型映射的只读壳断言回可变 —— 落表直推 store
  const draft = si.draft as ShareImportDraft | undefined
  if (!draft) return null
  return <ShareImportInner key={draft.key} draft={draft} />
}

function ShareImportInner({ draft }: { draft: ShareImportDraft }) {
  const { recSharedEmitter } = useRecSelfContext()
  const { token } = theme.useToken() // UIUX-U2-3: 冲突警示橙走 token.colorWarning (暗色随档)
  const groups = draft.plan.favoritesToAdd // 子集圈定时已裁 (planShareImport), 清单=候选全集
  const conflictById = useMemo(() => new Map(draft.plan.conflicts.map((c) => [c.group.id, c])), [draft])

  /** 勾选集 (默认全勾 —— 深链子集/整包同此) */
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set(groups.map((g) => g.id)))
  /** 「包内声明」展开集 (wayfinding 005: 默认折叠, 行尾 ▸/▾ 逐组切换, 头行一键全展) */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  /** 冲突默认裁决 (与 JSON 导入同口径: 同源实体/被全覆盖 => 并入宿主, 部分重叠 => 保留两份) */
  const defaultChoiceOf = (c: (typeof draft.plan.conflicts)[number]): TagRecImportChoice => {
    const covered = c.group.tag_ids.every((e) => c.hits[0].shared.includes(e.id))
    return c.hits[0].sameEntity || covered ? 'merge' : 'keep'
  }
  const [choices, setChoices] = useState<Record<string, TagRecImportChoice>>(() =>
    Object.fromEntries(draft.plan.conflicts.map((c) => [c.group.id, defaultChoiceOf(c)])),
  )
  const [includeBlacklist, setIncludeBlacklist] = useState(true)
  /** 票26: 包内非占位 filterConfig 时可勾「带入」(覆盖当前整套);
   *  默认不勾 —— 覆写过滤私配是高权动作, 须明示动作 (票26「默认安全档」) */
  const [applyFilter, setApplyFilter] = useState(false)
  /** 一级组反向取消集: 默认全启用 (planShareImport 归一 true), 取消勾选的行/节/批量开关把 id 记入此集;
   *  空集 = 全启用; 落表裁决见 resolveShareImportL1Enabled (勾选结果 = 最终启用集) */
  const [disabledL1Ids, setDisabledL1Ids] = useState<ReadonlySet<string>>(new Set())
  /** 票27 落点裁决: 'feed'=回主题推荐看推荐 (默认) / 'panel'=开收藏表管理继续编辑 (试改版带走再改的场景) */
  const [landing, setLanding] = useState<'feed' | 'panel'>('feed')
  /** 冲突逐条裁决直接钉在清单行上 (原型B): choices 行内 select + bulkbar 全并入/全保留 兜底;
   *  初值 = 智能分配同口径 (同源撞车/被全覆盖→并入, 部分重叠→保留两份) */

  /** 勾选组归属 L1 名解析 (表内既有 + 本批新增双源) */
  const l1NameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of favoritesL1Store.list) m.set(l.id, l.name)
    for (const l of draft.plan.l1ToAdd) m.set(l.id, l.name)
    return m
  }, [draft])

  /** L1 → 主题 id 解析 (双源同名不同字段); 主题名解析给节头用 */
  const l1ThemeOf = useMemo(() => {
    const m = new Map<string, string | undefined>()
    for (const l of favoritesL1Store.list) m.set(l.id, l.themeId)
    for (const l of draft.plan.l1ToAdd) m.set(l.id, l.themeId)
    return m
  }, [draft])
  const themeNameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of themesStore.list) m.set(t.id, t.name)
    for (const t of draft.plan.themesToAdd) m.set(t.id, t.name)
    return m
  }, [draft])

  /** 主题分节 (录入序): 组经 l1Id→themeId 归节; 无 l1/未归属主题 → undefined 桶(显示「未归属」) */
  const sections = useMemo(() => {
    const order: (string | undefined)[] = []
    const map = new Map<string | undefined, TagGroup[]>()
    for (const g of groups) {
      const th = g.l1Id ? l1ThemeOf.get(g.l1Id) : undefined
      if (!map.has(th)) {
        map.set(th, [])
        order.push(th)
      }
      map.get(th)!.push(g)
    }
    return order.map((themeId) => ({ themeId, rows: map.get(themeId)! }))
  }, [groups, l1ThemeOf])

  /** 预览决议 (清单摘要与落表同一口径 —— resolveTagRecImportApply 纯逻辑可重算) */
  const applied = useMemo(
    () => resolveTagRecImportApply(draft.plan, { choices, onlyGroupIds: checkedIds }),
    [draft, choices, checkedIds],
  )
  const listedConflicts = draft.plan.conflicts.filter((c) => checkedIds.has(c.group.id))

  /** 全部行涉及的一级组 id (保序去重) —— 批量/节开关的作用域与「全部启用」勾选态判据 */
  const scopeL1Ids = useMemo(() => [...new Set(groups.map((g) => g.l1Id).filter((x): x is string => !!x))], [groups])

  /** 落表后 L1 启用裁决 (新增 ∪ 本批落表组归属既有; 默认全启用, 反向集落停用) —— onOk 与警示条同源 */
  const l1Decisions = useMemo(
    () =>
      resolveShareImportL1Enabled({
        groups: [...applied.groupsToAdd, ...applied.merges.map((m) => m.src)],
        l1ToAdd: applied.l1ToAdd,
        disabledL1Ids,
      }),
    [applied, disabledL1Ids],
  )
  /** 实际将落停用的 L1 数 (作用域外的反向集条目不计 —— 警示条文案位) */
  const disabledCount = l1Decisions.filter((d) => !d.enabled).length

  /** 反向集增删 (行/节/批量开关共用): disabled=true 记入停用, false 摘除启用 */
  const setL1Disabled = (ids: readonly string[], disabled: boolean) =>
    setDisabledL1Ids((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (disabled) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const toggle = (id: string, checked: boolean) =>
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })

  const onOk = () => {
    const res = applyTagRecImport({
      plan: draft.plan,
      choices,
      onlyGroupIds: checkedIds,
      includeBlacklist,
      applyFilterConfig: applyFilter,
      filterConfig: draft.filterConfig,
    })
    // 导入后裁决: 一级组默认全启用, 反向取消集内的落停用 (勾选结果 = 最终启用集);
    //   作用域 = 本批落表组归属 ∪ 新增 L1 —— 未涉改的 L1 不动
    for (const { id, enabled } of l1Decisions) favoritesL1.updateL1(id, { enabled })
    closeShareImportDraft()
    // 票27 落点: 看推荐 => 回 tab1 主题推荐位 (粘贴入口在设置弹层内 => 顺带收掉弹层);
    //   继续编辑 => 直开收藏表管理 pane (同 banner.tsx「去勾选」机制)
    if (landing === 'panel') {
      modalSettingsStore.tab = TabPaneKey.TagRecFavorites
      showModalSettings()
    } else {
      videoSourceTabState.value = ETab.TagRecFav
      hideModalSettings()
    }
    const landed = res.added + res.merged
    if (landed > 0) {
      // R7: 导入信息横幅携带包内 L1/主题 (文案分档 + [只看这个包的主题] = 查看范围 onlyThemes)
      const pkgL1Ids = l1Decisions.map((d) => d.id)
      const pkgThemeIds = [
        ...new Set(
          pkgL1Ids.map((id) => favoritesL1.list.find((l) => l.id === id)?.themeId).filter((x): x is string => !!x),
        ),
      ]
      void noteShareImportDone(draft.shareId, { l1Ids: pkgL1Ids, themeIds: pkgThemeIds }) // 回赞账 + 导入信息横幅武装
      recSharedEmitter.emit('refresh', 'refresh') // 资格集变 => 重建 service 重抽
    }
    const synthesized = draft.plan.synthesizedThemes ? `, 其中 ${draft.plan.synthesizedThemes} 个为悬挂引用合成` : ''
    const invalid = draft.plan.invalidGroups.length ? `; ${draft.plan.invalidGroups.length} 组无效未入` : ''
    toast(
      `已导入分享「${draft.title}」: ${res.themesAdded} 主题${synthesized} / ${res.l1Added} 一级组` +
        ` / ${res.added} 组新入${res.merged ? ` / ${res.merged} 组并入既有` : ''}` +
        `${res.skipped ? ` / ${res.skipped} 组跳过` : ''} / 黑名单 ${res.blacklistAdded} 项${res.filterApplied ? ' / 过滤配置已覆盖' : ''}${invalid}`,
      6000,
    )
  }

  return (
    <Modal
      title='导入分享'
      open
      onCancel={closeShareImportDraft}
      onOk={onOk}
      okText='导入'
      okButtonProps={{ disabled: !checkedIds.size }}
      width={660}
    >
      <div className='max-h-60vh overflow-y-auto'>
        {/* 分享卡头 (spec §6): 标题 / 分享者(链 bilibili 空间) / 赞数 / 打开分享页;
            票27 试改版 => 「试改版」徽标 + 元信息位按信封所载隐去 (无服务端 meta) */}
        <div className='b-1px b-gate-border rounded-6px b-solid px-10px py-8px'>
          <div className='flex items-baseline justify-between gap-x-8px'>
            <Typography.Text strong ellipsis={{ tooltip: draft.title }} className='text-14px'>
              {draft.title}
            </Typography.Text>
            <span className='flex shrink-0 items-center gap-x-8px'>
              {draft.isPkg && <Tag color='blue'>试改版</Tag>}
              {draft.siteUrl && (
                <Typography.Link href={draft.siteUrl} target='_blank'>
                  {draft.isPkg ? '打开原分享页' : '打开分享页'}
                </Typography.Link>
              )}
            </span>
          </div>
          <Typography.Text type='secondary' className='mt-2px block text-12px'>
            {draft.mid !== undefined ? (
              <>
                分享者:{' '}
                <Typography.Link href={`https://space.bilibili.com/${draft.mid}`} target='_blank'>
                  {draft.nickname}
                </Typography.Link>
                {` · ${draft.likesCount} 赞 · `}
              </>
            ) : (
              '本地试改版 · '
            )}
            {`${groups.length} 组 / ${groups.reduce((s, g) => s + g.tag_ids.length, 0)} 个 tag_id`}
            {draft.hasSubset ? ' · 链接已圈定组子集' : ''}
          </Typography.Text>
          {draft.description && (
            <Typography.Text type='secondary' className='mt-2px block text-12px'>
              {draft.description}
            </Typography.Text>
          )}
        </div>

        {draft.missingGroupCount > 0 && (
          <Alert
            type='warning'
            showIcon
            className='mt-8px'
            title={`链接指定的 ${draft.missingGroupCount} 个组不在分享包内, 已略过`}
          />
        )}

        {/* 组勾选清单(原型B 密排形态): 行 = 勾选 │ 组名·计数 │ 冲突就地裁量 select │ 一级组启用 switch;
            头部一行 bulkbar = 全选 + 全部启用 (反向全选) + 冲突批量兜底 */}
        {groups.length > 0 ? (
          <>
            <div className='mt-8px flex items-center gap-x-14px text-12px'>
              <Checkbox
                checked={checkedIds.size === groups.length}
                indeterminate={checkedIds.size > 0 && checkedIds.size < groups.length}
                onChange={(e) => setCheckedIds(e.target.checked ? new Set(groups.map((g) => g.id)) : new Set())}
              >
                <span className='text-12px'>全选</span>
              </Checkbox>
              <Checkbox
                checked={scopeL1Ids.every((id) => !disabledL1Ids.has(id))}
                onChange={(e) => setDisabledL1Ids(e.target.checked ? new Set() : new Set(scopeL1Ids))}
              >
                <span className='text-12px'>全部启用</span>
              </Checkbox>
              {listedConflicts.length > 0 && (
                <span style={{ color: token.colorWarning }}>
                  {listedConflicts.length} 组冲突
                  {/* UIUX-U1-5: 批量裁决是动作 => Button link */}
                  <Button
                    type='link'
                    size='small'
                    className='ml-6px h-auto px-0 text-12px'
                    onClick={() =>
                      setChoices((prev) => ({
                        ...prev,
                        ...Object.fromEntries(listedConflicts.map((c) => [c.group.id, 'merge' as const])),
                      }))
                    }
                  >
                    全并入
                  </Button>
                  {' · '}
                  <Button
                    type='link'
                    size='small'
                    className='h-auto px-0 text-12px'
                    onClick={() =>
                      setChoices((prev) => ({
                        ...prev,
                        ...Object.fromEntries(listedConflicts.map((c) => [c.group.id, 'keep' as const])),
                      }))
                    }
                  >
                    全保留
                  </Button>
                </span>
              )}
              {/* wayfinding 005: 包内声明展开 —— 条件树+overrides 摘要, 默认折叠防淹没 */}
              <Button
                type='link'
                size='small'
                className='ml-auto h-auto px-0 text-12px'
                onClick={() =>
                  setExpandedIds((prev) => (prev.size === groups.length ? new Set() : new Set(groups.map((g) => g.id))))
                }
              >
                {expandedIds.size === groups.length ? '全部收起' : '全部展开'}
              </Button>
            </div>
            {/* 主题分节: 节头 = 主题名 + 该主题麾下 L1 总开关 (反向取消); 行尾开关 = 单个 L1 启用 */}
            <div className='mt-4px max-h-280px overflow-y-auto'>
              {sections.map((sec) => {
                const secL1s = [...new Set(sec.rows.map((g) => g.l1Id).filter((x): x is string => !!x))]
                const secAll = secL1s.every((id) => !disabledL1Ids.has(id))
                return (
                  <div key={sec.themeId ?? '未归属'} className='mb-6px b-1px b-gate-border rounded-6px b-solid'>
                    {/* UIUX-U2-2: 节头底走 gate 二级底 token (原 #fafafa 死值); U2-1: 次级文走 Typography secondary */}
                    <div className='flex items-center gap-x-8px b-0 b-b-1px b-gate-border b-solid bg-gate-bg-lv2 px-10px py-4px'>
                      <span className='text-13px font-600'>
                        {sec.themeId ? (themeNameOf.get(sec.themeId) ?? '#未知主题') : '未归属'}
                      </span>
                      <Typography.Text type='secondary' className='text-12px'>
                        {sec.rows.length} 组
                      </Typography.Text>
                      <Switch
                        className='ml-auto'
                        size='small'
                        title='本主题一级组启用'
                        checked={secAll}
                        onChange={(v) => setL1Disabled(secL1s, !v)}
                      />
                    </div>
                    <div className='px-10px py-2px'>
                      {sec.rows.map((g: TagGroup) => {
                        const on = checkedIds.has(g.id)
                        const conf = conflictById.get(g.id)
                        return (
                          <div key={g.id} className={`py-3px ${on ? '' : 'opacity-45'}`}>
                            <div className='flex items-center gap-x-8px'>
                              <Button
                                size='small'
                                type='text'
                                className='h-auto w-16px shrink-0 px-0 text-11px opacity-70'
                                title='展开包内声明（条件树 / 覆盖 / 负向）'
                                onClick={() =>
                                  setExpandedIds((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(g.id)) next.delete(g.id)
                                    else next.add(g.id)
                                    return next
                                  })
                                }
                              >
                                {expandedIds.has(g.id) ? '▾' : '▸'}
                              </Button>
                              <Checkbox checked={on} onChange={(e) => toggle(g.id, e.target.checked)} />
                              <span className='min-w-0 flex-1'>
                                <Typography.Text ellipsis={{ tooltip: g.name }} className='text-13px'>
                                  {g.name}
                                </Typography.Text>
                                <Typography.Text type='secondary' className='ml-6px text-12px'>
                                  {g.tag_ids.length} 个 id
                                  {g.negative_tag_ids?.length ? ` · ${g.negative_tag_ids.length} 负向` : ''}
                                  {g.l1Id && l1NameOf.get(g.l1Id) && l1NameOf.get(g.l1Id) !== g.name
                                    ? ` · ${l1NameOf.get(g.l1Id)}`
                                    : ''}
                                </Typography.Text>
                                {g.combination && (
                                  <Typography.Text
                                    type='secondary'
                                    ellipsis={{ tooltip: nameTagRecCombination(g.combination) }}
                                    className='block text-12px'
                                  >
                                    条件: {nameTagRecCombination(g.combination)}
                                  </Typography.Text>
                                )}
                              </span>
                              {conf && (
                                <Select
                                  size='small'
                                  className='w-108px shrink-0'
                                  disabled={!on}
                                  value={choices[g.id] ?? 'keep'}
                                  onChange={(v) => setChoices((prev) => ({ ...prev, [g.id]: v as TagRecImportChoice }))}
                                  options={[
                                    { value: 'merge', label: '并入宿主' },
                                    { value: 'keep', label: '保留两份' },
                                    { value: 'skip', label: '跳过不入' },
                                  ]}
                                />
                              )}
                              {g.l1Id && (
                                <Switch
                                  size='small'
                                  disabled={!on}
                                  title='启用'
                                  checked={!disabledL1Ids.has(g.l1Id)}
                                  onChange={(v) => setL1Disabled([g.l1Id as string], !v)}
                                />
                              )}
                            </div>
                            {expandedIds.has(g.id) && <TagRecShareGroupContents group={g} />}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <Alert type='info' showIcon className='mt-8px' title='该分享没有可导入的标签组' />
        )}

        {draft.plan.blacklistToAdd.length > 0 && (
          <Checkbox
            className='mt-10px'
            checked={includeBlacklist}
            onChange={(e) => setIncludeBlacklist(e.target.checked)}
          >
            并入标签黑名单 ({draft.plan.blacklistToAdd.length} 项新增)
          </Checkbox>
        )}

        {/* 票26 裁决区: 包内真实私配才渲染 (出厂占位 = 无过滤配置可带入) */}
        {draft.filterConfig && (
          <Checkbox className='mt-10px' checked={applyFilter} onChange={(e) => setApplyFilter(e.target.checked)}>
            带入分享者的过滤配置 (覆盖当前整套: 维度阈值/屏蔽词/UP主名单/算分/预设)
          </Checkbox>
        )}

        {/* 票27 落点裁决: 导入完成后的去处 —— 看推荐(默认) / 进收藏表管理继续编辑 */}
        <div className='mt-10px flex items-center gap-x-10px'>
          <Typography.Text strong className='text-13px'>
            导入完成后
          </Typography.Text>
          <Radio.Group value={landing} onChange={(e) => setLanding(e.target.value as 'feed' | 'panel')}>
            <Radio value='feed'>去「主题推荐」看推荐</Radio>
            <Radio value='panel'>去管理面板继续编辑</Radio>
          </Radio.Group>
        </div>
        {landing === 'feed' && disabledCount > 0 && (
          <Typography.Text type='secondary' className='mt-2px block text-12px'>
            {disabledCount} 个一级组未启用 —— 不会出现在推荐里; 之后可在主题下拉里临时打开或到「标签收藏」启用
          </Typography.Text>
        )}

        <Typography.Text type='secondary' className='mt-8px block text-12px'>
          勾选 {checkedIds.size}/{groups.length} 组 · 将新增 {applied.themesToAdd.length} 主题 /{' '}
          {applied.l1ToAdd.length} 一级组 / {applied.groupsToAdd.length} 组
          {applied.merges.length ? ` / ${applied.merges.length} 组并入既有` : ''}
          {applied.skippedCount ? ` / ${applied.skippedCount} 组跳过` : ''}
          {draft.plan.synthesizedThemes ? ` (其中 ${draft.plan.synthesizedThemes} 主题为悬挂引用合成)` : ''}
          {draft.plan.invalidGroups.length ? `; ${draft.plan.invalidGroups.length} 组无效不入` : ''}
          {' · '}组默认启用 · 一级组默认全启用 (行尾开关可逐个取消)
          {draft.filterConfig ? (applyFilter ? ' · 过滤配置将覆盖当前' : ' · 过滤配置不带入') : ' · 过滤配置不覆盖'}
        </Typography.Text>
      </div>
    </Modal>
  )
}
