import {
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Select,
  theme,
  Tooltip,
  Typography,
} from 'antd'
import { cloneDeep } from 'es-toolkit'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { subscribe, useSnapshot } from 'valtio'
import { showModalSettings } from '$components/RecHeader/modals'
import { useOnRefresh, useRecSelfContext } from '$components/Recommends/rec.shared'
import { usePopupContainer } from '$modules/rec-services/_base'
import toast from '$utility/toast'
import { ALLV2_PAGE_CAP, fetchAllV2Search, fetchSuggest, fetchTagInfoById, fetchTagInfoByName } from '../api/endpoints'
import {
  describeTagRecCondition,
  findTagRecCondition,
  hasTagRecCombination,
  isTagRecCombinationIntersection,
  nameTagRecCombination,
  TAG_REC_CONDITION_FIELDS,
  tagRecCombinationOf,
  tagRecCombinationTagIds,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  tagRecConditionLabel,
  validateTagRecCombination,
  type TagRecCombination,
  type TagRecConditionAtom,
  type TagRecConditionField,
  type TagRecConditionGroup,
} from '../model/combination'
import { tagRecMaterialWords } from '../model/material-words'
import { normalizeAllV2Item } from '../model/normalize-item'
import { PARTITION_NAME_TO_PARENT } from '../model/partition-table'
import { analyzeAllV2Videos, mergeTagRecCooccurAliases, normalizeTagName, parseTagInput } from '../model/resolve'
import { aggregateTagRecCooccur } from '../model/sediment'
import { favoritesL1Store, favoritesStore, sediment, tagRecStoresHydrated, themesStore } from '../store'
import {
  blockTagRecConditionGlobally,
  tagRecCombinationBlocks,
  unblockTagRecConditionGlobally,
} from '../store/combination-blocks'
import {
  requestTagRecMaterialSearch,
  stageTagRecMaterial,
  tagRecDiscoveryPreferences,
  tagRecDiscoveryUi,
  tagRecMaterialKey,
  type TagRecMaterial,
} from '../store/discovery-ui'
import {
  commitTagRecMaterialDraft,
  importTagRecFavoriteCombinations,
  selectTagRecMaterial,
} from '../store/material-draft'
import { tagRecCustomSession, tagRecSharedSession } from '../store/session'
import {
  activateTagRecWorkbench,
  addTagRecWorkingCondition,
  closeTagRecTrial,
  currentTagRecTrial,
  editTagRecWorkingGroup,
  excludeTagRecWorkingCondition,
  exploreTagRecMaterialOnly,
  exploreTagRecTagOnly,
  moveTagRecWorkingCondition,
  newTagRecTrial,
  openTagRecFavorite,
  openTagRecRecent,
  removeTagRecWorkingCondition,
  saveTagRecWorkingGroup,
  switchTagRecTrial,
  tagRecWorkbench,
  undoTagRecWorkingGroup,
  type TagRecTrial,
} from '../store/workbench'
import { TagRecBanner } from './banner'
import { tagRecHoldReasonText } from './banner-helpers'
import { removeTagRecCombinationFilterChoice, tagRecCombinationFilterChoices } from './combination-filter-choices'
import { tagRecCombinationPills, type TagRecCombinationPillItem } from './combination-pills'
import {
  useTagRecDiscoveryHeader,
  useTagRecDiscoveryMeta,
  useTagRecDiscoveryShelf,
  useTagRecDiscoveryToolbar,
} from './discovery-layout'
import { TagRecDiscoveryPools } from './discovery-pools'
import { tagRecFieldTones } from './field-tones'
import { FilterPopover } from './filter-popover'
import { TagRecVideoMaterials } from './video-materials'

import type { TagGroup, TagL1Group } from '../model/types'
import type { TagRecCustomService } from '../service/tag-rec-custom'

type Material = TagRecMaterial

/** Q9: 「继续挖共现」翻页游标 (按归一化输入词) —— 每点一次拉下一页, 共现词累加并入; 面板关闭不丢。 */
const cooccurDigCursor = new Map<string, number>()
/** 已计入共现统计的 bvid (按归一化输入词) —— 重复拉同页/翻页重叠不再重复累计共现频次 */
const cooccurSeenBvids = new Map<string, ReadonlySet<string>>()
const COOCCUR_KEY_CAP = 32

/** 共现账本 keyed map 写入: 同 key 覆盖移到最新位 + 上限 LRU, 防查询词无界增长 */
function cooccurLedgerSet<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  while (map.size > COOCCUR_KEY_CAP) map.delete(map.keys().next().value!)
}

function groupsOf(node: TagRecConditionGroup): TagRecConditionGroup[] {
  return [node, ...node.children.flatMap((child) => (child.kind === 'group' ? groupsOf(child) : []))]
}

/** 组显示名: 自动字段组 -> 字段中文名; 用户建的组 -> 自定义名; 根 -> 整体条件 */
function groupLabel(group: TagRecConditionGroup): string {
  return group.name ? TAG_REC_CONDITION_FIELDS[group.name as TagRecConditionField] || group.name : '整体条件'
}

export function TagRecWorkbenchView({ service }: { service: TagRecCustomService }) {
  const onRefresh = useOnRefresh()
  const { recSharedEmitter } = useRecSelfContext()
  const [continuing, setContinuing] = useState(false)
  const continueDiscovery = async () => {
    setContinuing(true)
    try {
      await recSharedEmitter.emit('tag-rec:continue')
    } finally {
      setContinuing(false)
    }
  }
  const { ref, getPopupContainer } = usePopupContainer()
  const { token } = theme.useToken()
  const session = useSnapshot(tagRecCustomSession)
  const memory = useSnapshot(tagRecWorkbench)
  const globalBlocks = useSnapshot(tagRecCombinationBlocks)
  const library = useSnapshot(favoritesStore)
  const parents = useSnapshot(favoritesL1Store)
  const themesSnap = useSnapshot(themesStore)
  const { bypassSeen } = session // tab2「显示已看」本会话 flag (tagRecCustomSession.bypassSeen)
  const compatible = memory.version === 1 && Array.isArray(memory.trials) && Array.isArray(memory.recent)
  const trials = compatible
    ? memory.trials.filter(
        (entry) =>
          typeof entry?.id === 'string' &&
          typeof entry.name === 'string' &&
          validateTagRecCombination(entry.group?.combination),
      )
    : []
  const trial = trials.find((entry) => entry.id === memory.activeId)
  const combination = session.workingGroup?.combination
  const [query, setQuery] = useState('')
  const [field, setField] = useState<TagRecConditionField | 'all'>('tag')
  const [source, setSource] = useState('全部')
  const [materialLimit, setMaterialLimit] = useState(50)
  const [materials, setMaterials] = useState<Material[]>([])
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [target, setTarget] = useState<string>()
  // 落点组: 行尾「＋」/「＋子组」置位, 抽屉里显示并允许「改回自动」
  const targetGroup =
    target && combination
      ? groupsOf(combination.include as TagRecConditionGroup).find((group) => group.id === target)
      : undefined
  const [saveName, setSaveName] = useState('')
  const [borrow, setBorrow] = useState<TagGroup>()
  const [shelfQuery, setShelfQuery] = useState('')
  const [shelfSections, setShelfSections] = useState({ trials: true, favorites: true, recent: false })
  const shelfId = useId()
  const shelfSearching = !!shelfQuery.trim()
  const [materialOpen, setMaterialOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [batch, setBatch] = useState(false)
  const [recentLimit, setRecentLimit] = useState(8)
  const display = useSnapshot(tagRecDiscoveryPreferences)
  const discoveryUi = useSnapshot(tagRecDiscoveryUi)
  // Q9: 共现语料行数据源 —— 沉淀池快照, 深挖累积写入即触发重算 (零请求)
  const sedimentMap = useSnapshot(sediment.map)
  const { riskControl } = useSnapshot(tagRecSharedSession)
  // 票 006: 停牌原因 (退避/「先看缓存」/额度用尽/放弃计数) —— 待核实行旁直说卡在哪、该点哪里
  const holdReason = tagRecHoldReasonText(session, riskControl)
  const picks = trial?.pending ?? []
  const shelfTarget = useTagRecDiscoveryShelf()
  const searchRef = useRef<AbortController | undefined>(undefined)
  const searchRevision = useRef(0)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const toolbarTarget = useTagRecDiscoveryToolbar()
  const headerTarget = useTagRecDiscoveryHeader()
  const metaTarget = useTagRecDiscoveryMeta()
  useEffect(() => {
    if (shelfSearching) setShelfSections({ trials: true, favorites: true, recent: true })
  }, [shelfSearching])

  useEffect(() => {
    let active = true
    const input = tagRecCustomSession.inputText
    const selected = tagRecCustomSession.selectedGroupIds[0]
    void activateTagRecWorkbench()
      .then(() => {
        if (!active) return
        if (selected) {
          const favorite = favoritesStore.list.find((g) => g.id === selected)
          if (favorite && (!tagRecCustomSession.workingGroup || currentTagRecTrial()?.originId !== selected))
            openTagRecFavorite(favorite)
        }
        if (input) {
          if (hasTagRecCombination(tagRecCustomSession.workingGroup?.combination)) newTagRecTrial()
          requestTagRecMaterialSearch(input)
          const parsed = parseTagInput(input)
          const id = currentTagRecTrial()?.id
          const revision = tagRecCustomSession.queryRevision
          const lookup = parsed?.kind === 'id' ? fetchTagInfoById(parsed.id) : fetchTagInfoByName(input)
          void lookup
            .then((info) => {
              if (active && info && currentTagRecTrial()?.id === id && tagRecCustomSession.queryRevision === revision)
                addTagRecWorkingCondition(
                  tagRecConditionAtom('tag', { id: info.id, name: info.name, tag_type: info.tag_type }),
                )
            })
            .catch(() => undefined)
        }
        onRefreshRef.current('refresh')
      })
      .catch(() => {
        toast('读取本地试验失败，原数据未覆盖，请刷新重试')
      })
    return () => {
      active = false
      searchRef.current?.abort()
    }
  }, [])
  // Merge committed condition edits into one refresh. Typing in the material input never reaches this subscription.
  useEffect(() => {
    let previous = JSON.stringify([
      tagRecCustomSession.workingGroup,
      tagRecCustomSession.allowUnverified,
      tagRecCombinationBlocks.list,
      tagRecCombinationBlocks.invalid,
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      const next = JSON.stringify([
        tagRecCustomSession.workingGroup,
        tagRecCustomSession.allowUnverified,
        tagRecCombinationBlocks.list,
        tagRecCombinationBlocks.invalid,
      ])
      if (next === previous) return
      previous = next
      clearTimeout(timer)
      timer = setTimeout(() => onRefreshRef.current('refresh'), 250)
    }
    const stops = [subscribe(tagRecCustomSession, changed), subscribe(tagRecCombinationBlocks, changed)]
    return () => {
      clearTimeout(timer)
      stops.forEach((stop) => stop())
    }
  }, [])
  useEffect(() => {
    setTarget(undefined)
    setSaveName('')
    setBorrow(undefined)
    searchRef.current?.abort()
    setBusy(false)
    setMaterialOpen(false)
    setSaving(false)
    setQuery('')
    setMaterials([])
    searchRevision.current++
  }, [memory.activeId])
  // 「仅看这个标签」/深链输入的一次性素材解析请求 —— 须排在上面 activeId 重置之后,
  //   仅看换试验时清面板状态与打开素材抽屉的次序才确定
  useEffect(() => {
    const pending = tagRecDiscoveryUi.materialQuery
    if (!pending) return
    tagRecDiscoveryUi.materialQuery = undefined
    setField(pending.field)
    setQuery(pending.text)
    void findMaterials(pending.text, pending.field)
  }, [discoveryUi.materialQuery])

  const select = async (material: Material, asExclude: boolean | 'global' = material.exclude ?? false) => {
    const trialId = tagRecWorkbench.activeId
    const queryRevision = tagRecCustomSession.queryRevision
    let atom = material.atom && cloneDeep(material.atom)
    if (!atom) {
      const info = material.tagId
        ? await fetchTagInfoById(material.tagId).catch(() => undefined)
        : await fetchTagInfoByName(material.name).catch(() => undefined)
      if (!info) {
        toast('暂时未解析到这个标签，可稍后重试或作为标题/简介词选入')
        return
      }
      atom = tagRecConditionAtom('tag', { id: info.id, name: info.name, tag_type: info.tag_type })
    }
    if (trialId !== tagRecWorkbench.activeId || queryRevision !== tagRecCustomSession.queryRevision) return
    if (target && !findTagRecCondition(tagRecCustomSession.workingGroup!.combination!.include, target)) {
      toast('目标条件组已移出，请重新选择')
      return
    }
    if (asExclude === 'global') {
      blockTagRecConditionGlobally(atom)
      toast('已加入全局排除，可在此工作台直接移除')
    } else if (asExclude) excludeTagRecWorkingCondition(atom)
    else addTagRecWorkingCondition(atom, target)
  }
  const findMaterials = async (raw = query, fieldSel = field) => {
    const input = raw.trim()
    if (!input) return
    setMaterialOpen(true)
    searchRef.current?.abort()
    const controller = new AbortController()
    searchRef.current = controller
    const revision = ++searchRevision.current
    setBusy(true)
    const literal: Material[] = []
    if ((fieldSel === 'title' || fieldSel === 'desc' || fieldSel === 'all') && normalizeTagName(input).length >= 2)
      for (const kind of (fieldSel === 'all' ? ['title', 'desc'] : [fieldSel]) as ('title' | 'desc')[])
        literal.push({ atom: tagRecConditionAtom(kind, input), name: input, source: '输入' })
    if (fieldSel === 'up') {
      const mid = /^\d+$/.test(input) ? Number(input) : undefined
      literal.push({
        atom: tagRecConditionAtom('up', { name: mid ? `UID ${mid}` : input, ...(mid && { mid }) }),
        name: input,
        source: '输入',
      })
    }
    if (fieldSel === 'partition') {
      const part = PARTITION_NAME_TO_PARENT[input]
      if (part)
        literal.push({
          atom: tagRecConditionAtom('partition', { name: input, ...part, level: 'parent' }),
          name: input,
          source: '输入',
        })
      else toast('请选择已知分区；视频字段中也可直接选子分区')
    }
    if (fieldSel !== 'tag' && fieldSel !== 'all') {
      setMaterials(literal)
      setSource('全部')
      setBusy(false)
      return
    }
    const parsed = parseTagInput(input)
    const results = await Promise.allSettled([
      parsed?.kind === 'id'
        ? fetchTagInfoById(parsed.id, controller.signal)
        : fetchTagInfoByName(input, controller.signal),
      fetchAllV2Search(input, { page: 1, signal: controller.signal }),
      fetchSuggest(input, controller.signal),
    ])
    if (controller.signal.aborted || revision !== searchRevision.current) return
    const found: Material[] = [...literal]
    const info = results[0].status === 'fulfilled' ? results[0].value : undefined
    if (info)
      found.unshift({
        atom: tagRecConditionAtom('tag', { id: info.id, name: info.name, tag_type: info.tag_type }),
        name: info.name,
        source: '解析',
      })
    if (results[1].status === 'fulfilled') {
      const videos = results[1].value
      // Q9: 首查拉的是第 1 页 —— 记下游标, 后续「继续挖共现」从第 2 页续挖;
      //   首页已计入的 bvid 同步入 seen 集 (翻页重叠/末页重拉不重复累计共现频次)
      cooccurLedgerSet(cooccurDigCursor, normalizeTagName(input), 1)
      cooccurLedgerSet(
        cooccurSeenBvids,
        normalizeTagName(input),
        new Set(videos.map((v) => v.bvid).filter((b): b is string => !!b)),
      )
      const analysis = analyzeAllV2Videos(videos, normalizeTagName(input))
      for (const alias of analysis.cooccurAliases.slice(0, 24))
        found.push({ name: alias.name, source: '共现', count: alias.count })
      // 视频字段素材 (UP/标题词/简介词/分区) 不限字段选择, 让「视频字段」源总是有内容
      for (const raw of videos.slice(0, 8)) {
        const item = normalizeAllV2Item(raw, { via: 'all-v2-exact', groupNames: [], srcRank: 0 })
        if (item.owner?.name)
          found.push({
            atom: tagRecConditionAtom('up', { name: item.owner.name, mid: item.owner.mid }),
            name: item.owner.name,
            source: '视频',
          })
        for (const word of tagRecMaterialWords(item.title).slice(0, 16))
          if (normalizeTagName(word).length >= 2)
            found.push({ atom: tagRecConditionAtom('title', word), name: word, source: '视频' })
        for (const word of tagRecMaterialWords(item.desc ?? '').slice(0, 16))
          if (normalizeTagName(word).length >= 2)
            found.push({ atom: tagRecConditionAtom('desc', word), name: word, source: '视频' })
        if (item.tid)
          found.push({
            atom: tagRecConditionAtom('partition', {
              name: raw.typename || `分区 ${item.tid}`,
              v1: item.tid,
              level: 'leaf',
            }),
            name: raw.typename || `分区 ${item.tid}`,
            source: '视频',
          })
      }
    }
    if (results[2].status === 'fulfilled')
      for (const name of results[2].value.slice(0, 10)) found.push({ name, source: '解析' })
    // 「输入」源兜底: 原词作为未解析标签可选; 已解析时 merge 会把它并进「解析」条目 (后到者让位于先到者的 source)
    if (fieldSel === 'tag' || fieldSel === 'all') found.push({ name: input, source: '输入' })
    // Suggestions and co-occurrence often name the same tag. Keep the parsed identity
    // and its counts instead of showing two independently selectable copies.
    const parsedTags = new Map(
      found.flatMap((material) =>
        material.atom?.field === 'tag' ? [[normalizeTagName(material.name), material.atom] as const] : [],
      ),
    )
    const uniqueMap = new Map<string, Material>()
    for (const material of found) {
      const atom = material.atom ?? parsedTags.get(normalizeTagName(material.name))
      const key = atom ? tagRecConditionKey(atom) : `tag:name:${normalizeTagName(material.name)}`
      const previous = uniqueMap.get(key)
      uniqueMap.set(key, { ...material, ...previous, atom, count: previous?.count ?? material.count })
    }
    const unique = [...uniqueMap.values()]
    setMaterials(unique)
    setSource('全部')
    setBusy(false)
    // Finding material never changes the effective combination; selection is explicit.
    if (!unique.length) toast('暂未找到素材，可直接选标题词、简介词或 UP UID')
  }
  /** Q9: 「继续挖共现」—— 锚点 = 当前组合的 tag 条件全集 (以用户已选为准); 每点一次给
   *   「挖得最少」的锚点拉下一页搜索结果, 共现词累加并入快照行 (新词追加/同词计数相加);
   *   语料行不受影响。无 tag 条件时退回输入词 (旧行为)。
   *   生命周期与首查同轨 (searchRef/searchRevision): 换词/换试验/重查后在途结果落定即弃;
   *   失败页不推进游标 (下点重试同页); 全部锚点挖到 ALLV2_PAGE_CAP 即终态不再发请求;
   *   共现统计按锚点内 bvid 去重 —— 同页重拉或翻页重叠不再反复累计。 */
  const digCooccurMore = async () => {
    const alive = cooccurAnchors.filter((a) => (cooccurDigCursor.get(a.norm) ?? 0) < ALLV2_PAGE_CAP)
    if (!alive.length) {
      toast(`已挖到搜索末页（每词共 ${ALLV2_PAGE_CAP} 页），可换词重查`)
      return
    }
    const target = alive.reduce((a, b) =>
      (cooccurDigCursor.get(a.norm) ?? 0) <= (cooccurDigCursor.get(b.norm) ?? 0) ? a : b,
    )
    const key = target.norm
    const cursor = cooccurDigCursor.get(key) ?? 0
    searchRef.current?.abort()
    const controller = new AbortController()
    searchRef.current = controller
    const revision = ++searchRevision.current
    setBusy(true)
    try {
      const page = cursor + 1
      const res = await fetchAllV2Search(target.name, { page, signal: controller.signal }).then(
        (v) => ({ v }),
        () => undefined,
      )
      if (controller.signal.aborted || revision !== searchRevision.current) return
      if (!res) {
        toast(`「${target.name}」第 ${page} 页拉取失败，请重试`)
        return
      }
      cooccurLedgerSet(cooccurDigCursor, key, page)
      const videos = res.v
      const seen = new Set(cooccurSeenBvids.get(key))
      const fresh = videos.filter((v) => !v.bvid || !seen.has(v.bvid))
      for (const v of fresh) if (v.bvid) seen.add(v.bvid)
      cooccurLedgerSet(cooccurSeenBvids, key, seen)
      const analysis = analyzeAllV2Videos(fresh, key)
      setMaterials((prev) => [
        ...prev.filter((material) => material.source !== '共现'),
        ...mergeTagRecCooccurAliases(
          prev.filter((material) => material.source === '共现'),
          analysis.cooccurAliases.slice(0, 24),
        )
          .sort((a, b) => b.count - a.count)
          .map((alias): Material => ({ name: alias.name, source: '共现', count: alias.count })),
      ])
      toast(
        videos.length
          ? `已拉「${target.name}」第 ${page} 页 · 共现词已累加并入`
          : `「${target.name}」第 ${page} 页无结果，可稍后再试`,
      )
    } finally {
      setBusy(false)
    }
  }
  const { fieldTones, excludeTone, neutralTone, materialTone } = tagRecFieldTones(token)
  const chip = (atom: TagRecConditionAtom, danger = false) => {
    const tone = danger ? excludeTone : (fieldTones[atom.field] ?? neutralTone)
    // 当前所在组 (移到… 里标记并禁用)
    const parentId =
      !danger && combination
        ? groupsOf(combination.include as TagRecConditionGroup).find((group) =>
            group.children.some((child) => child.id === atom.id),
          )?.id
        : undefined
    // 一体药丸: 彩底彩边 + 字段词 + 内嵌 × (点开是条件菜单, 右键同菜单)
    return (
      <span
        key={atom.id}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: `1px solid ${tone.bd}`,
          background: tone.bg,
          borderRadius: 6,
          maxWidth: 300,
          color: tone.fg,
        }}
      >
        <Dropdown
          trigger={['click', 'contextMenu']}
          menu={{
            items: [
              ...(atom.field === 'tag'
                ? [{ key: 'only', label: '仅看这个标签', onClick: () => exploreTagRecTagOnly(cloneDeep(atom.value)) }]
                : []),
              { key: 'exclude', label: '这个组合不看', onClick: () => excludeTagRecWorkingCondition(cloneDeep(atom)) },
              { key: 'global', label: '以后都不看', onClick: () => blockTagRecConditionGlobally(cloneDeep(atom)) },
              ...(combination && !danger
                ? [
                    {
                      key: 'move',
                      label: '移到…',
                      children: [
                        ...groupsOf(combination.include as TagRecConditionGroup).map((group) => ({
                          key: `to:${group.id}`,
                          label: group.id === parentId ? `${groupLabel(group)} (当前)` : groupLabel(group),
                          disabled: group.id === parentId,
                          onClick: () => moveTagRecWorkingCondition(atom.id, group.id),
                        })),
                        { type: 'divider' as const },
                        {
                          key: 'to:new',
                          label: '＋新建子组',
                          onClick: () => moveTagRecWorkingCondition(atom.id, 'new'),
                        },
                      ],
                    },
                  ]
                : []),
              { key: 'remove', label: '移出条件', onClick: () => removeTagRecWorkingCondition(atom.id) },
            ],
          }}
          getPopupContainer={getPopupContainer}
        >
          <Button
            size='small'
            type='text'
            style={{
              height: 24,
              padding: '0 2px 0 8px',
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: tone.fg,
              fontSize: 12,
            }}
            title={`${TAG_REC_CONDITION_FIELDS[atom.field]} · ${tagRecConditionLabel(atom)} · 点开管理`}
          >
            {TAG_REC_CONDITION_FIELDS[atom.field]} · {tagRecConditionLabel(atom)}
          </Button>
        </Dropdown>
        <Button
          size='small'
          type='text'
          aria-label={`移出${TAG_REC_CONDITION_FIELDS[atom.field]}${tagRecConditionLabel(atom)}`}
          style={{ height: 24, minWidth: 22, padding: '0 5px', color: tone.fg, opacity: 0.65 }}
          onClick={() => removeTagRecWorkingCondition(atom.id)}
        >
          ×
        </Button>
      </span>
    )
  }
  const renderGroup = (node: TagRecConditionGroup, root = false) => {
    // 简化态下空组没有可操作面, 整条隐藏; 展开「关系」后露出「＋ 加条件」落点
    if (!root && !advanced && !node.children.length) return null
    const groupTone = node.name ? fieldTones[node.name as TagRecConditionField] : undefined
    const setMode = (mode: 'any' | 'all') =>
      editTagRecWorkingGroup((group) => {
        const target = findTagRecCondition(group.combination!.include, node.id)
        if (target?.kind === 'group') target.mode = mode
      })
    // 行尾「＋」落点芯片: 点哪行加哪行 —— 置目标组并开素材抽屉, 抽屉顶条显示落点
    const addHere = !root && (
      <Button
        size='small'
        type='dashed'
        aria-label={`往${groupLabel(node)}加条件`}
        title={`往「${groupLabel(node)}」加条件`}
        style={{ height: 24, padding: '0 8px', fontSize: 12, color: token.colorTextTertiary }}
        onClick={() => {
          setTarget(node.id)
          setMaterialOpen(true)
        }}
      >
        {node.children.length ? '＋' : '＋ 加条件'}
      </Button>
    )
    return (
      <div
        key={node.id}
        style={{
          marginTop: root ? 0 : 8,
          paddingLeft: root ? 0 : 10,
          borderLeft: root ? undefined : `2px solid ${groupTone?.bd ?? token.colorBorderSecondary}`,
        }}
      >
        <div className='flex flex-wrap items-center gap-6px'>
          {advanced ? (
            <>
              <Typography.Text
                type='secondary'
                style={{ fontSize: 12, ...(!root && groupTone ? { color: groupTone.fg } : undefined) }}
              >
                {root
                  ? '组合方式'
                  : TAG_REC_CONDITION_FIELDS[node.name as TagRecConditionField] || node.name || '条件组'}
              </Typography.Text>
              <Select
                size='small'
                aria-label='条件匹配方式'
                value={node.mode}
                style={{ width: 104 }}
                getPopupContainer={getPopupContainer}
                options={[
                  { value: 'any', label: '任一命中' },
                  { value: 'all', label: '全部命中' },
                ]}
                onChange={setMode}
              />
            </>
          ) : (
            node.mode === 'any' && (
              <Dropdown
                menu={{ items: [{ key: 'all', label: '改为全部命中' }], onClick: () => setMode('all') }}
                trigger={['click']}
                getPopupContainer={getPopupContainer}
              >
                <span
                  title={`${root ? '整个组合' : '本组'}按任一命中取视频，点击可改回全部命中`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 4,
                    fontSize: 11,
                    color: token.colorPrimary,
                    border: `1px solid ${token.colorPrimaryBorder}`,
                    background: token.colorPrimaryBg,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  任一命中
                </span>
              </Dropdown>
            )
          )}
          {node.children.filter((child): child is TagRecConditionAtom => child.kind === 'atom').map((a) => chip(a))}
          {addHere}
          {advanced && (
            <>
              <Button
                size='small'
                type='text'
                onClick={() => {
                  const id = crypto.randomUUID()
                  // 建行即成落点 + 开素材抽屉 —— 不再停在空壳态等用户悟「先切目标再点素材」
                  const ok = editTagRecWorkingGroup((group) => {
                    const target = findTagRecCondition(group.combination!.include, node.id)
                    if (target?.kind === 'group')
                      target.children.push({
                        kind: 'group',
                        id,
                        mode: 'any',
                        name: '条件组',
                        children: [],
                      })
                  })
                  if (!ok) return
                  setTarget(id)
                  setMaterialOpen(true)
                  toast('已建条件组 · 点选的素材会落进它')
                }}
              >
                ＋子组
              </Button>
              {!root && (
                <Button size='small' type='text' onClick={() => removeTagRecWorkingCondition(node.id)}>
                  移出整组
                </Button>
              )}
            </>
          )}
        </div>
        {node.children
          .filter((child): child is TagRecConditionGroup => child.kind === 'group')
          .map((child) => renderGroup(child))}
      </div>
    )
  }
  const saved = borrow?.combination ? tagRecCombinationOf(borrow) : borrow ? tagRecCombinationOf(borrow) : undefined
  // 共现锚点集 = 当前组合的全部 tag 条件 ∪ 输入词 (已选为准 + 探索词同权, 归一去重) ——
  //   「继续挖共现」的翻页对象, 与 corpusRows 的「查询锚点 ∪ 组合标签」语料口径同族
  const cooccurAnchors = useMemo(() => {
    const list: { norm: string; name: string }[] = []
    const seen = new Set<string>()
    const push = (name: string) => {
      const norm = normalizeTagName(name)
      if (norm && !seen.has(norm)) {
        seen.add(norm)
        list.push({ norm, name })
      }
    }
    for (const atom of combination ? tagRecConditionAtoms(combination.include) : []) {
      if (atom.field !== 'tag') continue
      push(typeof atom.value === 'string' ? atom.value : atom.value.name)
    }
    if (query.trim()) push(query.trim())
    return list
  }, [combination, query])
  // Q9: 锚点集已挖页数合计 (模块级游标, 非响应式, 随 busy/query 重渲染刷新)
  const cooccurPage = cooccurAnchors.reduce((sum, a) => sum + (cooccurDigCursor.get(a.norm) ?? 0), 0)
  const cooccurExhausted =
    !cooccurAnchors.length || cooccurAnchors.every((a) => (cooccurDigCursor.get(a.norm) ?? 0) >= ALLV2_PAGE_CAP)
  // 共现双源 (Q9): 语料行 = 累积沉淀池对「查询锚点 ∪ 组合标签」的共现邻域, 零请求、随深挖自动长;
  //   与本次搜索快照行并列展示 —— 剔除已在组合/排除/全局排除的词, 以及与快照行重名的词。
  const corpusRows = useMemo(() => {
    const norms = new Set<string>()
    const queryNorm = normalizeTagName(query)
    if (queryNorm) norms.add(queryNorm)
    if (combination) for (const tag of tagRecCombinationTagIds(combination)) norms.add(normalizeTagName(tag.name))
    if (!norms.size) return []
    const exclude = new Set<string>(norms)
    for (const atom of combination ? [...tagRecConditionAtoms(combination.include), ...combination.exclude] : [])
      if (atom.field === 'tag' && typeof atom.value !== 'string') exclude.add(normalizeTagName(atom.value.name))
    for (const atom of tagRecCombinationBlocks.list)
      if (atom.field === 'tag' && typeof atom.value !== 'string') exclude.add(normalizeTagName(atom.value.name))
    return aggregateTagRecCooccur(sedimentMap, [...norms], exclude, 30)
  }, [sedimentMap, query, combination])
  const corpusMaterials: Material[] = useMemo(
    () =>
      corpusRows
        .filter(
          (row) =>
            !materials.some((material) => material.source === '共现' && normalizeTagName(material.name) === row.norm),
        )
        .map((row) => ({ name: row.name, source: '共现' as const, count: row.count, corpus: true })),
    [corpusRows, materials],
  )
  // 「收藏素材」源: 借了组才摊平那组的条件 (层级树模式不消费平铺列表, 跳过死计算)
  const savedMaterials = useMemo(() => {
    if (!borrow) return []
    const comb = tagRecCombinationOf(borrow)
    const seen = new Set<string>()
    const out: Material[] = []
    for (const [atoms, ex] of [
      [tagRecConditionAtoms(comb.include as TagRecConditionGroup), false],
      [comb.exclude, true],
    ] as const)
      for (const atom of atoms) {
        const key = `${tagRecConditionKey(atom)}:${ex}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ atom, name: tagRecConditionLabel(atom), source: '收藏', ...(ex ? { exclude: true } : {}) })
      }
    return out
  }, [borrow])
  const [savedQuery, setSavedQuery] = useState('')
  // 收藏 store 异步水合: 未就绪时主题/一级组归属不全, 先把树挡在「读取中」防全量闪进「未分组」
  const [storesReady, setStoresReady] = useState(false)
  useEffect(() => {
    let alive = true
    void tagRecStoresHydrated.then(() => alive && setStoresReady(true))
    return () => {
      alive = false
    }
  }, [])
  /** 单组摊平出的可选素材 (层级视图 L2 行内细选 / 过滤词命中用) */
  const savedMaterialsOfComb = (comb: TagRecCombination): Material[] => {
    return [
      ...tagRecConditionAtoms(comb.include as TagRecConditionGroup).map((atom): Material => ({
        atom,
        name: tagRecConditionLabel(atom),
        source: '收藏' as const,
      })),
      ...comb.exclude.map((atom): Material => ({
        atom,
        name: tagRecConditionLabel(atom),
        source: '收藏' as const,
        exclude: true,
      })),
    ]
  }
  type SavedL2Node = { group: TagGroup; materials: Material[]; importable: boolean }
  type SavedL1Node = { l1: TagL1Group; groups: SavedL2Node[] }
  // 「收藏素材」层级视图: 主题 → 一级组 → 二级组 (未归属 L1 直接列组, 未归属 L2 单列兜底段);
  //   过滤词命中组名/所属一级组名/所属主题名/任一条件词即保留该组;
  //   每组 comb/materials/importable 随 memo 一次算好 —— 行渲染不再逐次 cloneDeep
  const savedTree = useMemo(() => {
    const q = normalizeTagName(savedQuery)
    const l1ById = new Map(parents.list.map((l1) => [l1.id, l1]))
    const themeById = new Map(themesSnap.list.map((theme) => [theme.id, theme]))
    const nodes: SavedL2Node[] = []
    for (const group of library.list) {
      if (!group.enabled) continue
      const comb = tagRecCombinationOf(group)
      const materials = savedMaterialsOfComb(comb)
      if (q) {
        const l1 = group.l1Id ? l1ById.get(group.l1Id) : undefined
        const theme = l1?.themeId ? themeById.get(l1.themeId) : undefined
        const hit =
          normalizeTagName(group.name).includes(q) ||
          (l1 && normalizeTagName(l1.name).includes(q)) ||
          (theme && normalizeTagName(theme.name).includes(q)) ||
          materials.some((material) => normalizeTagName(material.name).includes(q))
        if (!hit) continue
      }
      nodes.push({ group, materials, importable: materials.length > 0 || !!comb.filters })
    }
    const l1Ids = new Set(parents.list.map((l1) => l1.id))
    const themeIds = new Set(themesSnap.list.map((theme) => theme.id))
    const byL1 = new Map<string | undefined, SavedL2Node[]>()
    for (const node of nodes) {
      const parent = node.group.l1Id && l1Ids.has(node.group.l1Id) ? node.group.l1Id : undefined
      const list = byL1.get(parent) ?? []
      list.push(node)
      byL1.set(parent, list)
    }
    const byTheme = new Map<string | undefined, SavedL1Node[]>()
    for (const l1 of parents.list) {
      const l1Nodes = byL1.get(l1.id)
      if (!l1Nodes?.length) continue
      const themeId = l1.themeId && themeIds.has(l1.themeId) ? l1.themeId : undefined
      const list = byTheme.get(themeId) ?? []
      list.push({ l1, groups: l1Nodes })
      byTheme.set(themeId, list)
    }
    const themes = themesSnap.list
      .filter((theme) => byTheme.has(theme.id))
      .map((theme) => ({ theme, l1s: byTheme.get(theme.id)! }))
    return { themes, looseL1s: byTheme.get(undefined) ?? [], orphanGroups: byL1.get(undefined) ?? [] }
  }, [library, parents, themesSnap, savedQuery])
  /** 整组/整节导入: 每个 L2 的 include 整棵嫁接为子组 (保留原结构), exclude+filters 并入 */
  const importSavedGroups = (groups: TagGroup[], label: string) => {
    setCommitting(true)
    try {
      const count = importTagRecFavoriteCombinations(
        groups.map((group) => {
          const comb = tagRecCombinationOf(group)
          // 嫁接子树带上组名: 落进工作组合后能认出「这是哪个收藏组」
          comb.include.name ||= group.name.slice(0, 200)
          return comb
        }),
        target,
      )
      const skipped = groups.length - count
      toast(
        count
          ? `已并入「${label}」的 ${count} 个组合条件${targetGroup ? `（落到「${groupLabel(targetGroup)}」）` : ''}${skipped ? `，${skipped} 个组未并入（超限或无可并入内容）` : ''}`
          : '未加入：超出条件上限、目标不可用或没有可导入条件',
      )
    } finally {
      setCommitting(false)
    }
  }
  /** 收藏层级视图: 单个 L2 行 —— 组名 + 整组导入 + 原子细选 chips; 空组不出导入入口 */
  const savedL2Row = (node: SavedL2Node) => (
    <div key={node.group.id} className='flex flex-col gap-4px'>
      <div className='flex items-center gap-8px'>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          {node.group.name}
        </Typography.Text>
        {node.importable && (
          <Button
            size='small'
            type='link'
            style={{ padding: 0, height: 'auto' }}
            disabled={committing}
            onClick={() => void importSavedGroups([node.group], node.group.name)}
          >
            导入整组
          </Button>
        )}
      </div>
      <div className='flex flex-wrap gap-6px'>{node.materials.map(materialButton)}</div>
    </div>
  )
  /** 收藏层级视图: L1 块 —— L1 名 + 整组导入(可并入 L2) + L2 行 */
  const savedL1Block = (node: SavedL1Node) => {
    const importable = node.groups.filter((g) => g.importable).map((g) => g.group)
    return (
      <div key={node.l1.id} className='flex flex-col gap-6px'>
        <div className='flex items-center gap-8px'>
          <Typography.Text strong style={{ fontSize: 12 }}>
            {node.l1.name}
          </Typography.Text>
          {importable.length > 0 && (
            <Button
              size='small'
              type='link'
              style={{ padding: 0, height: 'auto' }}
              disabled={committing}
              onClick={() => void importSavedGroups(importable, node.l1.name)}
            >
              整组导入 {importable.length} 组
            </Button>
          )}
        </div>
        <div className='flex flex-col gap-8px' style={{ paddingLeft: 12 }}>
          {node.groups.map(savedL2Row)}
        </div>
      </div>
    )
  }
  // 「输入」源保底: 原词直接当条件用 —— 已解析则复用解析条目 (key 一致, 选中/暂选态同步), 未解析按标签名走
  const inputVerbatim = (() => {
    const raw = query.trim()
    if (!raw || (field !== 'tag' && field !== 'all')) return undefined
    return (
      materials.find((material) => normalizeTagName(material.name) === normalizeTagName(raw)) ?? {
        name: raw,
        source: '输入' as const,
      }
    )
  })()
  const displayed =
    source === '收藏'
      ? savedMaterials
      : source === '输入'
        ? [
            ...(inputVerbatim ? [inputVerbatim] : []),
            ...[...materials, ...corpusMaterials].filter(
              (material) => material.source === '输入' && normalizeTagName(material.name) !== normalizeTagName(query),
            ),
          ]
        : [...materials, ...corpusMaterials].filter((material) => source === '全部' || source === material.source)
  const filterChoices = tagRecCombinationFilterChoices(combination?.filters)
  const borrowedFilters = tagRecCombinationFilterChoices(saved?.filters)
  const semantic = combination ? describeTagRecCondition(combination.include as TagRecConditionGroup) : ''

  const stage = (material: Material, exclude = material.exclude ?? false) =>
    stageTagRecMaterial(memory.activeId, { ...cloneDeep(material), exclude })
  const materialButton = (material: Material, index: number) => {
    const key = material.atom && tagRecConditionKey(material.atom)
    const selected =
      combination &&
      (material.exclude ? combination.exclude : tagRecConditionAtoms(combination.include as TagRecConditionGroup)).find(
        (atom) =>
          key
            ? tagRecConditionKey(atom) === key
            : !material.filter &&
              atom.field === 'tag' &&
              normalizeTagName(atom.value.name) === normalizeTagName(material.name),
      )
    const pending = picks.some((entry) => tagRecMaterialKey(entry as Material) === tagRecMaterialKey(material))
    const tone = materialTone(material)
    return (
      <Dropdown
        key={`${tagRecMaterialKey(material)}:${index}`}
        trigger={['contextMenu']}
        getPopupContainer={getPopupContainer}
        menu={{
          items: [
            // 无 atom 的素材在本抽屉里即未解析标签名 (收藏素材带 filter 补丁除外)
            ...((material.atom ? material.atom.field === 'tag' : !material.filter)
              ? [
                  {
                    key: 'only',
                    label: '仅看这个标签',
                    onClick: () => void exploreTagRecMaterialOnly(material),
                  },
                ]
              : []),
            {
              key: 'include',
              label: '选入当前组合',
              onClick: () => void selectTagRecMaterial({ ...material, exclude: false }, target),
            },
            { key: 'stage', label: '暂选，稍后一起加入', onClick: () => stage(material, false) },
            { key: 'exclude', label: '暂选为「这个组合不看」', onClick: () => stage(material, true) },
            {
              key: 'global',
              label: '以后都不看',
              onClick: () => {
                void select(material, 'global')
              },
            },
          ],
        }}
      >
        <Button
          size='small'
          title={`${material.atom ? TAG_REC_CONDITION_FIELDS[material.atom.field] : material.filter ? '过滤' : '标签'} · ${material.name}${material.exclude ? '（不看）' : ''}${material.count ? ` · ${material.corpus ? '语料' : '共现'} ${material.count}` : ''}`}
          style={{
            maxWidth: '100%',
            height: 'auto',
            whiteSpace: 'normal',
            textAlign: 'left',
            // 字段染色: 已选=实心字段色, 已暂选=虚线强调, 其余=字段色淡底 —— 标签项省略「标签 ·」前缀, 颜色即字段
            background: selected && !batch ? tone.fg : tone.bg,
            borderColor: selected || pending ? tone.fg : tone.bd,
            borderStyle: pending && !selected ? 'dashed' : 'solid',
            color: selected && !batch ? '#fff' : tone.fg,
            fontWeight: selected || pending ? 600 : undefined,
          }}
          onClick={() => {
            if (batch) stage(material)
            else if (selected) removeTagRecWorkingCondition(selected.id)
            else void selectTagRecMaterial(material, target)
          }}
        >
          {material.atom && material.atom.field !== 'tag' ? `${TAG_REC_CONDITION_FIELDS[material.atom.field]} · ` : ''}
          {material.filter ? '过滤 · ' : ''}
          {material.name}
          {material.exclude ? '（不看）' : ''}
          {material.count ? ` · ${material.corpus ? '语料' : '共现'} ${material.count}` : ''}
          {selected ? ' ✓' : pending ? ' · 已暂选' : ''}
        </Button>
      </Dropdown>
    )
  }
  // 名称与操作各占自己的位置；长名称最多两行，完整条件保留在 title 中。
  const shelfRowCss = {
    'display': 'grid',
    'gridTemplateColumns': 'minmax(0, 1fr) 28px',
    'gap': 2,
    'alignItems': 'start',
    'borderRadius': 8,
    'borderLeft': '3px solid transparent',
    '&:hover': { background: token.colorFillTertiary },
    '& .shelf-entry': { gridColumn: '1 / -1', gridRow: 1 },
    '& .shelf-action': { gridColumn: 2, gridRow: 1, marginTop: 4, paddingInline: 4, opacity: 0.65, zIndex: 1 },
    '&:hover .shelf-action, &:focus-within .shelf-action': { opacity: 1 },
  } as const
  const shelfRowActiveCss = {
    'background': token.colorPrimaryBg,
    'borderLeftColor': token.colorPrimary,
    '&:hover': { background: token.colorPrimaryBg },
  }
  const shelfLine = {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
    fontSize: 13,
    fontWeight: 500,
  } as const
  const shelfButtonStyle = {
    display: 'block',
    width: '100%',
    minWidth: 0,
    height: 'auto',
    textAlign: 'left',
    whiteSpace: 'normal',
    padding: '6px',
  } as const
  const shelfTitle = (combination?: TagRecCombination) =>
    combination ? nameTagRecCombination(combination as TagRecCombination) : ''
  const shelfPendingText = (count?: number) => (count ? ` · 暂选 ${count}` : '')
  const shelfMatch = (name: string, combination?: TagRecCombination) =>
    !shelfSearching || `${name} ${shelfTitle(combination)}`.toLowerCase().includes(shelfQuery.trim().toLowerCase())
  const shelfName = (name: string, combination?: TagRecCombination) => {
    if (!name || name === '新试验' || name === shelfTitle(combination)) return undefined
    const atoms = combination ? tagRecConditionAtoms(combination.include as TagRecConditionGroup) : []
    const formulaName = name.replace(/^（+/, '')
    if (
      atoms.some((atom) => name === tagRecConditionLabel(atom)) ||
      Object.values(TAG_REC_CONDITION_FIELDS).some((field) => formulaName.startsWith(`${field}「`))
    )
      return undefined
    return name
  }
  const shelfTrials = trials.filter((entry) => shelfMatch(entry.name, entry.group.combination))
  const shelfFavorites = library.list.filter((group) => shelfMatch(group.name, tagRecCombinationOf(group as TagGroup)))
  const shelfRecent = (compatible ? memory.recent : []).filter(
    (entry) =>
      (hasTagRecCombination(entry?.group?.combination) || !!entry.pending?.length) &&
      shelfMatch(entry.name, entry.group.combination),
  )
  const shelfSection = (key: keyof typeof shelfSections, label: string, count: number) => (
    <Button
      size='small'
      type='text'
      aria-label={`${shelfSections[key] ? '收起' : '展开'}${label}`}
      aria-expanded={shelfSections[key]}
      aria-controls={`${shelfId}-${key}`}
      onClick={() => setShelfSections((previous) => ({ ...previous, [key]: !previous[key] }))}
      style={{ display: 'flex', width: '100%', paddingInline: 4, gap: 6, color: token.colorTextSecondary }}
    >
      <span aria-hidden style={{ width: 12, transform: shelfSections[key] ? 'rotate(90deg)' : undefined }}>
        ›
      </span>
      <span style={{ flex: 1, textAlign: 'left', fontSize: 12, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 11, color: token.colorTextTertiary }}>{count}</span>
    </Button>
  )
  const pillToneOf = (item: Exclude<TagRecCombinationPillItem, { kind: 'join' }>) =>
    item.kind === 'exclude' ? excludeTone : item.kind === 'more' ? neutralTone : (fieldTones[item.field] ?? neutralTone)
  const shelfPillStyle = (tone: { fg: string; bg: string; bd: string }) =>
    ({
      display: 'inline-block',
      minHeight: 20,
      padding: '0 5px',
      borderRadius: 4,
      border: `1px solid ${tone.bd}`,
      background: tone.bg,
      color: tone.fg,
      fontSize: 11,
      lineHeight: '18px',
      minWidth: 0,
      maxWidth: '100%',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
    }) as const
  const renderPills = (combination?: TagRecCombination, part: 'all' | 'lead' | 'rest' = 'all') => {
    const allItems = combination ? tagRecCombinationPills(combination, { limit: Infinity, excludeLimit: Infinity }) : []
    let split = allItems.length
    let conditions = 0
    for (const [index, item] of allItems.entries()) {
      if (item.kind !== 'pill' && item.kind !== 'exclude') continue
      if (conditions === 2) {
        split = allItems[index - 1]?.kind === 'join' ? index - 1 : index
        break
      }
      conditions++
    }
    const items = part === 'lead' ? allItems.slice(0, split) : part === 'rest' ? allItems.slice(split) : allItems
    if (!items.length && part === 'rest') return null
    if (!items.length)
      return (
        <span className='shelf-join' style={{ fontSize: 12, color: token.colorTextSecondary }}>
          未选条件
        </span>
      )
    // 连接词跟着它后面的药丸成组 (nowrap) —— 换行只会发生在组与组之间, 不会掉一个孤零零的「或」在行尾
    const groups: { key: string; join?: string; pills: Exclude<TagRecCombinationPillItem, { kind: 'join' }>[] }[] = []
    let pendingJoin: string | undefined
    for (const item of items) {
      if (item.kind === 'join') {
        pendingJoin = item.label
        continue
      }
      const last = groups.at(-1)
      if (pendingJoin) groups.push({ key: item.key, join: pendingJoin, pills: [item] })
      else if (last) last.pills.push(item)
      else groups.push({ key: item.key, pills: [item] })
      pendingJoin = undefined
    }
    return (
      <span className='flex flex-wrap items-center gap-3px'>
        {groups.map((group) => (
          <span key={group.key} className='inline-flex items-center gap-3px' style={{ maxWidth: '100%', minWidth: 0 }}>
            {!!group.join && group.join !== '或' && (
              <span className='shelf-join' style={{ fontSize: 10, color: token.colorTextTertiary }}>
                {group.join === '且' ? '·' : group.join}
              </span>
            )}
            {group.pills.map((pill) => (
              <span key={pill.key} className='shelf-pill' style={shelfPillStyle(pillToneOf(pill))}>
                {pill.label}
              </span>
            ))}
          </span>
        ))}
      </span>
    )
  }
  const renderShelfEntry = (
    name: string,
    combination: TagRecCombination | undefined,
    { actionWidth = 0, active = false, pending }: { actionWidth?: number; active?: boolean; pending?: number } = {},
  ) => {
    const label = shelfName(name, combination)
    const current = active ? (
      <span style={{ flexShrink: 0, fontSize: 10, lineHeight: '20px', color: token.colorPrimary }}>当前</span>
    ) : null
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, textAlign: 'left' }}>
        {label ? (
          <>
            <span style={{ display: 'flex', alignItems: 'start', gap: 4, minWidth: 0, paddingRight: actionWidth }}>
              <span style={{ ...shelfLine, flex: 1, minWidth: 0, color: active ? token.colorPrimary : undefined }}>
                {label}
              </span>
              {current}
            </span>
            {renderPills(combination)}
          </>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, paddingRight: actionWidth }}>
            <span style={{ flex: 1, minWidth: 0 }}>{renderPills(combination, 'lead')}</span>
            {current}
          </span>
        )}
        {!label && renderPills(combination, 'rest')}
        {!!pending && <span style={{ fontSize: 11, color: token.colorTextSecondary }}>暂选 {pending} 项</span>}
      </span>
    )
  }
  const shelf = (
    <div
      data-discovery-shelf-content
      css={{
        'display': 'flex',
        'flexDirection': 'column',
        'gap': 8,
        'width': '100%',
        'minHeight': 0,
        'maxHeight': 'inherit',
        'boxSizing': 'border-box',
        'padding': display.collapsed ? 7 : 10,
        '@media (max-width: 1100px)': display.collapsed ? { flexDirection: 'row', alignItems: 'center' } : {},
      }}
    >
      <div className='flex items-center justify-between gap-4px'>
        {!display.collapsed && (
          <Typography.Text strong style={{ fontSize: 14 }}>
            我的组合
          </Typography.Text>
        )}
        <Button
          size='small'
          type='text'
          aria-label={display.collapsed ? '展开组合书架' : '收起组合书架'}
          aria-expanded={!display.collapsed}
          aria-controls={shelfId}
          title={display.collapsed ? '展开我的组合' : '收起我的组合'}
          css={{
            'display': 'flex',
            'flexDirection': display.collapsed ? 'column' : 'row',
            'height': 'auto',
            'padding': display.collapsed ? '8px 2px' : '2px 6px',
            'gap': 6,
            '& .shelf-rail-label': { writingMode: 'vertical-rl', letterSpacing: 2, fontSize: 12 },
            '@media (max-width: 1100px)': {
              'flexDirection': 'row',
              'padding': '2px 6px',
              '& .shelf-rail-label': { writingMode: 'horizontal-tb', letterSpacing: 0 },
            },
          }}
          onClick={() => {
            tagRecDiscoveryPreferences.collapsed = !display.collapsed
          }}
        >
          <span aria-hidden>{display.collapsed ? '›' : '‹'}</span>
          {display.collapsed ? <span className='shelf-rail-label'>我的组合</span> : '收起'}
        </Button>
      </div>
      <Button
        size='small'
        block={!display.collapsed}
        aria-label='创建新组合'
        title='创建新组合'
        style={{ flexShrink: 0, paddingInline: display.collapsed ? 5 : undefined }}
        onClick={() => newTagRecTrial()}
      >
        {display.collapsed ? '＋' : '＋ 新组合'}
      </Button>
      {!display.collapsed && (
        <div id={shelfId} style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <Input.Search
            size='small'
            value={shelfQuery}
            onChange={(event) => setShelfQuery(event.target.value)}
            allowClear
            aria-label='查找我的组合'
            placeholder='搜索名称或条件'
          />
          <div
            data-discovery-shelf-scroll
            style={{
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              paddingRight: 3,
            }}
          >
            {shelfSection('trials', '正在试', shelfTrials.length)}
            <div id={`${shelfId}-trials`} hidden={!shelfSections.trials}>
              {shelfTrials.map((entry) => {
                const active = entry.id === memory.activeId
                return (
                  <div key={entry.id} css={{ ...shelfRowCss, ...(active ? shelfRowActiveCss : {}) }}>
                    <Button
                      className='shelf-entry'
                      size='small'
                      type='text'
                      style={shelfButtonStyle}
                      aria-current={active ? 'true' : undefined}
                      title={`${entry.name} · ${shelfTitle(entry.group.combination)}${shelfPendingText(entry.pending?.length)}`}
                      onClick={() => switchTagRecTrial(entry.id)}
                    >
                      {renderShelfEntry(entry.name, entry.group.combination, {
                        actionWidth: 28,
                        active,
                        pending: entry.pending?.length,
                      })}
                    </Button>
                    <Button
                      className='shelf-action'
                      size='small'
                      type='text'
                      aria-label={`关闭试验${entry.name}`}
                      title='关闭这个试验'
                      onClick={() => closeTagRecTrial(entry.id)}
                    >
                      ×
                    </Button>
                  </div>
                )
              })}
            </div>
            {shelfSection('favorites', '二级组收藏', shelfFavorites.length)}
            <div id={`${shelfId}-favorites`} hidden={!shelfSections.favorites}>
              {shelfFavorites.map((group) => {
                const savedCombination = tagRecCombinationOf(group as TagGroup)
                return (
                  <div key={group.id} css={{ ...shelfRowCss, gridTemplateColumns: 'minmax(0, 1fr) 48px' }}>
                    <Button
                      className='shelf-entry'
                      size='small'
                      type='text'
                      style={shelfButtonStyle}
                      title={`${group.name} · ${shelfTitle(savedCombination)}`}
                      onClick={() => openTagRecFavorite(group as TagGroup)}
                    >
                      {renderShelfEntry(group.name, savedCombination, { actionWidth: 48 })}
                    </Button>
                    <Button
                      className='shelf-action'
                      size='small'
                      type='text'
                      style={{ fontSize: 12 }}
                      aria-label={`从${group.name}取几项`}
                      title='从这个收藏组合取几项条件'
                      onClick={() => {
                        setBorrow(group as TagGroup)
                        setSource('收藏')
                        setMaterialOpen(true)
                      }}
                    >
                      取几项
                    </Button>
                  </div>
                )
              })}
              {!library.list.length && (
                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                  试好的组合存到这里。
                </Typography.Text>
              )}
            </div>
            {shelfSection('recent', '最近尝试', shelfRecent.length)}
            <div id={`${shelfId}-recent`} hidden={!shelfSections.recent}>
              {shelfRecent.slice(0, recentLimit).map((entry) => (
                <div key={entry.id} css={{ ...shelfRowCss, gridTemplateColumns: 'minmax(0, 1fr)' }}>
                  <Button
                    className='shelf-entry'
                    size='small'
                    type='text'
                    style={shelfButtonStyle}
                    title={`${shelfTitle(entry.group.combination)}${shelfPendingText(entry.pending?.length)}`}
                    onClick={() => openTagRecRecent(entry as TagRecTrial)}
                  >
                    {renderShelfEntry(entry.name, entry.group.combination, { pending: entry.pending?.length })}
                  </Button>
                </div>
              ))}
              {shelfRecent.length > recentLimit && (
                <Button size='small' type='text' onClick={() => setRecentLimit((limit) => limit + 20)}>
                  查看更早的尝试
                </Button>
              )}
            </div>
            {shelfSearching && !shelfTrials.length && !shelfFavorites.length && !shelfRecent.length && (
              <Typography.Text type='secondary' style={{ display: 'block', padding: 8, fontSize: 12 }}>
                没有匹配的组合，试试名称或条件词。
              </Typography.Text>
            )}
          </div>
          <Button
            size='small'
            type='text'
            style={{ flexShrink: 0, borderTop: `1px solid ${token.colorBorderSecondary}`, borderRadius: 0 }}
            onClick={showModalSettings}
          >
            收藏管理与备份
          </Button>
        </div>
      )}
    </div>
  )
  const saveFields = (
    <div className='flex flex-col gap-12px'>
      <Typography.Text type='secondary'>保存标签、排除、匹配方式和明确改过的过滤与来源；其余继续继承。</Typography.Text>
      <Input
        aria-label='二级组名称'
        placeholder='留空按条件命名'
        value={saveName}
        maxLength={200}
        onChange={(event) => setSaveName(event.target.value)}
      />
      <Select
        aria-label='归属一级组'
        value={session.workingGroup?.l1Id || 'auto'}
        getPopupContainer={getPopupContainer}
        options={[
          { value: 'auto', label: '自动建立同名一级组' },
          ...parents.list.map((parent) => ({ value: parent.id, label: parent.name })),
        ]}
        onChange={(id) =>
          editTagRecWorkingGroup((group) => {
            group.l1Id = id === 'auto' ? undefined : id
          })
        }
      />
      {trial?.originId && (
        <Typography.Text type='secondary'>
          来自收藏「{library.list.find((group) => group.id === trial.originId)?.name ?? trial.name}
          」。另存后原组仍保留。
        </Typography.Text>
      )}
    </div>
  )
  const more = (
    <div className='flex flex-col gap-10px' style={{ maxWidth: 400 }}>
      <Button size='small' onClick={() => setAdvanced(!advanced)}>
        {advanced ? '收起完整条件' : '完整条件与组合关系'}
      </Button>
      <Button
        size='small'
        onClick={() => {
          const current = currentTagRecTrial()
          if (current) newTagRecTrial(current.group, current.originId, `${current.name} · 分支`)
        }}
      >
        分支试验
      </Button>
      {trial?.originId && (
        <>
          <Button
            size='small'
            onClick={() => {
              const original = library.list.find((group) => group.id === trial.originId)
              if (original) openTagRecFavorite(original as TagGroup)
            }}
          >
            回到原组合
          </Button>
          <Popconfirm
            title='用当前完整条件更新原二级组？'
            description='其他试验保留，原收藏会被这份条件更新。'
            onConfirm={() => saveTagRecWorkingGroup(saveName, true)}
          >
            <Button size='small'>更新原二级组</Button>
          </Popconfirm>
        </>
      )}
      <Checkbox
        checked={bypassSeen}
        onChange={(event) => {
          tagRecCustomSession.bypassSeen = event.target.checked
          onRefresh('refresh')
        }}
      >
        显示已看（临时）
      </Checkbox>
      <Button size='small' onClick={showModalSettings}>
        过滤预设、发现策略与收藏管理
      </Button>
      {globalBlocks.list.length > 0 && (
        <div>
          <Typography.Text type='danger'>以后都不看</Typography.Text>
          <div className='flex flex-wrap gap-6px'>
            {globalBlocks.list.map((atom) => (
              <Button key={atom.id} size='small' danger onClick={() => unblockTagRecConditionGlobally(atom.id)}>
                {tagRecConditionLabel(atom as TagRecConditionAtom)} ×
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
  const toolbar = (
    <div
      className='flex flex-wrap items-center gap-x-10px gap-y-6px bg-gate-bg'
      style={{
        paddingBlock: 4,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        transition: 'border-color .15s ease',
      }}
    >
      {/* 身份: 有名字显示名字, 否则只留「未保存」小徽标 (原型 v3: 「当前组合」四字没信息量) */}
      <div className='min-w-0 flex items-center gap-6px'>
        {trial && trial.name !== '新试验' ? (
          <Typography.Text
            strong
            ellipsis
            style={{ fontSize: 14, maxWidth: 220 }}
            title={
              trial.originId ? `试改自「${library.list.find((g) => g.id === trial.originId)?.name ?? ''}」` : undefined
            }
          >
            {trial.name}
          </Typography.Text>
        ) : (
          <span
            style={{
              flex: 'none',
              fontSize: 11,
              color: token.colorTextTertiary,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: 4,
              padding: '0 5px',
              whiteSpace: 'nowrap',
            }}
            title={trial?.originId ? '试改自收藏的二级组，尚未另存' : '尚未保存为二级组'}
          >
            未保存
          </span>
        )}
      </div>
      {combination && isTagRecCombinationIntersection(combination) && (
        <Typography.Text
          type='secondary'
          style={{ fontSize: 11, flex: 'none', whiteSpace: 'nowrap' }}
          title='交集收窄：tag/top 与相关池默认收窄，火力集中在精准搜索；可在「过滤 → 内容来源」开回'
        >
          交集 · 收窄
        </Typography.Text>
      )}
      <div className='flex items-center gap-6px' style={{ flex: '0 1 auto', minWidth: 0 }}>
        <Select
          size='small'
          aria-label='素材字段'
          value={field}
          style={{ width: 92, flex: 'none' }}
          getPopupContainer={getPopupContainer}
          options={[
            { value: 'all', label: '全部字段' },
            ...Object.entries(TAG_REC_CONDITION_FIELDS).map(([value, label]) => ({ value, label })),
          ]}
          onChange={setField}
        />
        <Input.Search
          size='small'
          style={{ flex: '0 1 240px', minWidth: 140 }}
          aria-label='查找可选条件'
          placeholder={
            field === 'up'
              ? 'UP 名称或 UID'
              : field === 'partition'
                ? '分区名，如 科学科普'
                : field === 'tag'
                  ? '标签名或标签 ID，如 三体'
                  : '输入要查找的条件'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={() => void findMaterials()}
          enterButton='查找'
          loading={busy}
        />
        {/* 收起/展开只作用于下面的条件卡, 搜索行不动, 按钮始终在同一位置 */}
        <Button
          size='small'
          type='text'
          style={{ flex: 'none' }}
          aria-label={display.topCollapsed ? '展开组合条件卡' : '收起组合条件卡'}
          onClick={() => {
            tagRecDiscoveryPreferences.topCollapsed = !display.topCollapsed
          }}
        >
          {display.topCollapsed ? '展开' : '收起'}
        </Button>
      </div>
      {/* 操作: 常用项留在栏里 (可选条件/加载更多/撤销/过滤), 主操作固定最右, 低频项进 ⋯ */}
      <div className='flex items-center gap-6px' style={{ marginLeft: 'auto' }}>
        <Button size='small' style={{ flex: 'none' }} onClick={() => setMaterialOpen(true)}>
          可选条件{picks.length ? ` · 暂选 ${picks.length}` : ''}
        </Button>
        <Button size='small' loading={continuing} onClick={() => void continueDiscovery()}>
          加载更多
        </Button>
        <Button
          size='small'
          type='text'
          onClick={() => {
            if (!undoTagRecWorkingGroup()) toast('没有可撤销的条件改动')
          }}
        >
          撤销
        </Button>
        <FilterPopover getPopupContainer={getPopupContainer} />
        <Button size='small' type='primary' onClick={() => setSaving(true)}>
          存为二级组
        </Button>
        <Popover trigger='click' placement='bottomRight' content={more}>
          <Button size='small' type='text' aria-label='更多操作'>
            ⋯
          </Button>
        </Popover>
      </div>
    </div>
  )
  // 当前组合卡: 浅底 + 细边, 条件药丸内嵌, 「关系」右端按需提供完整条件组;
  //   挂在吸顶栈的 header 槽位里 —— 展开时随页面滚动一起吸住 (收起时整卡不渲染)
  const combinationCard = (
    <div
      className='flex flex-wrap items-center gap-x-8px gap-y-5px'
      style={{
        padding: '6px 12px',
        borderRadius: 10,
        background: token.colorBgContainer,
        backgroundImage: `linear-gradient(${token.colorFillQuaternary}, ${token.colorFillQuaternary})`,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {combination && renderGroup(combination.include as TagRecConditionGroup, true)}
      {!!combination?.exclude.length && (
        <span className='flex flex-wrap items-center gap-4px'>
          <Typography.Text type='danger' style={{ fontSize: 12 }}>
            不看
          </Typography.Text>
          {combination.exclude.map((atom) => chip(atom as TagRecConditionAtom, true))}
        </span>
      )}
      {filterChoices
        .filter((choice) => !choice.key.startsWith('poolsEnabled.'))
        .map((choice) => (
          <Button
            key={choice.key}
            size='small'
            type='text'
            aria-label={`恢复继承${choice.label}`}
            style={{ color: token.colorTextTertiary, paddingInline: 4, fontSize: 12 }}
            onClick={() =>
              editTagRecWorkingGroup((group) => {
                removeTagRecCombinationFilterChoice(group.combination!.filters!, choice.key)
              })
            }
          >
            {choice.label} ×
          </Button>
        ))}
      {!semantic && (
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          选条件开始试看：标签 / UP / 标题 / 简介 / 分区
        </Typography.Text>
      )}
      <span style={{ flex: 1 }} />
      {advanced && (
        <Select
          size='small'
          aria-label='新条件落点组'
          value={target || 'auto'}
          style={{ minWidth: 150, flex: 'none' }}
          getPopupContainer={getPopupContainer}
          options={[
            { value: 'auto', label: '自动按字段组织' },
            ...(combination
              ? groupsOf(combination.include as TagRecConditionGroup).map((group) => ({
                  value: group.id,
                  label: groupLabel(group),
                }))
              : []),
          ]}
          onChange={(id) => setTarget(id === 'auto' ? undefined : id)}
        />
      )}
      {/* 关系全文不占行: 悬停「关系」按钮即见 (药丸行与标题已是双重视觉呈现, 嵌套复杂时才需要文字版) */}
      <Tooltip title={semantic || undefined} placement='bottomRight' overlayStyle={{ maxWidth: 480 }}>
        <Button size='small' type='text' onClick={() => setAdvanced(!advanced)}>
          {advanced ? '收起关系' : '关系'}
        </Button>
      </Tooltip>
    </div>
  )
  const metaRow = (
    <div className='flex flex-wrap items-center gap-x-10px gap-y-2px' style={{ fontSize: 11 }}>
      <TagRecDiscoveryPools
        service={service}
        onRefresh={() => {
          onRefresh('refresh')
        }}
      />
      {session.replayDelivered > 0 && (
        <Typography.Text type='secondary' style={{ fontSize: 12 }} title='该条件此前交付过的内容，本地零请求复用'>
          回放 {session.replayDelivered} 条
        </Typography.Text>
      )}
      {(session.partitionPending > 0 || session.allowUnverified || holdReason) && (
        <span className='flex flex-wrap items-center gap-6px'>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {session.partitionPending > 0
              ? `待核实 ${session.partitionPending} 条${holdReason ? ` · ${holdReason}` : ''}`
              : (holdReason ?? '已放出未核实内容（未证明满足当前组合）')}
          </Typography.Text>
          <Button
            size='small'
            type='text'
            onClick={() => {
              tagRecCustomSession.allowUnverified = !tagRecCustomSession.allowUnverified
              service.retryPartitions()
            }}
          >
            {session.allowUnverified ? '恢复暂存' : '暂时查看未核实内容'}
          </Button>
          <Button
            size='small'
            type='text'
            onClick={() => {
              void continueDiscovery()
            }}
          >
            重试核实
          </Button>
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span className='flex items-center gap-4px'>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          视频大小
        </Typography.Text>
        <Segmented
          size='small'
          value={display.size}
          options={[
            { value: 'small', label: '小' },
            { value: 'medium', label: '中' },
            { value: 'large', label: '大' },
          ]}
          onChange={(size) => {
            tagRecDiscoveryPreferences.size = size as typeof display.size
          }}
        />
      </span>
    </div>
  )
  if (!compatible)
    return <Typography.Text type='danger'>本地试验格式不兼容，原数据已保留，请升级插件后继续。</Typography.Text>
  return (
    <div ref={ref} className='w-full flex flex-col gap-8px' style={{ marginBottom: 8 }} data-tag-rec-workbench>
      {shelfTarget ? createPortal(shelf, shelfTarget) : <aside style={{ maxWidth: 230 }}>{shelf}</aside>}
      {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
      {!display.topCollapsed && (headerTarget ? createPortal(combinationCard, headerTarget) : combinationCard)}
      {!!picks.length && (
        <div
          className='flex flex-wrap items-center gap-6px'
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            background: token.colorFillQuaternary,
            borderLeft: `3px solid ${token.colorWarning}`,
          }}
        >
          <Typography.Text style={{ fontSize: 12 }}>暂选 {picks.length} 项</Typography.Text>
          <Button size='small' type='text' onClick={() => setMaterialOpen(true)}>
            查看
          </Button>
          <Button
            size='small'
            type='text'
            onClick={() => {
              const current = currentTagRecTrial()
              if (current) current.pending = []
            }}
          >
            清空
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            size='small'
            type='primary'
            loading={committing}
            onClick={async () => {
              setCommitting(true)
              try {
                await commitTagRecMaterialDraft(target)
              } finally {
                setCommitting(false)
              }
            }}
          >
            加入当前组合
          </Button>
        </div>
      )}
      {/* 来源 / 待核实 / 大小: 一条元信息行, 统一小号次级样式, 压成细条不占行高;
          展开时 portal 进吸顶栈底 (组合卡之下) 一起吸住, 收起时留在正文流随内容滚走 */}
      {metaTarget && !display.topCollapsed ? createPortal(metaRow, metaTarget) : metaRow}
      {globalBlocks.invalid && (
        <Typography.Text type='danger'>全局排除条件不兼容，原数据已保留，请升级插件后继续。</Typography.Text>
      )}
      <TagRecBanner
        hideIdleDropText
        hidePartitionPending
        onDigMore={() => {
          void continueDiscovery()
        }}
        onRedig={() => {
          void service.redigQuery().then(() => recSharedEmitter.emit('load-more'))
        }}
        session={tagRecCustomSession}
        onPartitionRetry={() => {
          void continueDiscovery()
        }}
      />
      <Modal
        title='存为新二级组'
        open={saving}
        onCancel={() => setSaving(false)}
        okText='保存新组'
        onOk={() => {
          if (saveTagRecWorkingGroup(saveName)) setSaving(false)
        }}
      >
        {saveFields}
      </Modal>
      <Drawer
        title={
          source === '收藏'
            ? borrow
              ? `从「${borrow.name}」取几项`
              : '收藏素材'
            : query
              ? `「${query}」的可选条件`
              : '可选条件'
        }
        open={materialOpen}
        onClose={() => setMaterialOpen(false)}
        size={520}
        mask={{ closable: true }}
        footer={
          picks.length ? (
            <Button
              block
              type='primary'
              loading={committing}
              onClick={async () => {
                setCommitting(true)
                try {
                  await commitTagRecMaterialDraft(target)
                } finally {
                  setCommitting(false)
                }
              }}
            >
              加入暂选的 {picks.length} 项
            </Button>
          ) : undefined
        }
      >
        <div className='flex flex-col gap-14px'>
          <Input.Search
            aria-label='在可选条件中继续查找'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void findMaterials()}
            loading={busy}
            enterButton='查找'
            placeholder='换个词继续找，不改变已选条件'
          />
          {targetGroup && (
            <div className='flex items-center gap-6px'>
              <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                选中的条件落到「{groupLabel(targetGroup)}」
              </Typography.Text>
              <Button
                type='link'
                size='small'
                style={{ padding: 0, height: 'auto' }}
                onClick={() => setTarget(undefined)}
              >
                改回自动
              </Button>
            </div>
          )}
          <div className='flex flex-wrap items-center justify-between gap-x-12px gap-y-4px'>
            <Checkbox checked={batch} onChange={(event) => setBatch(event.target.checked)}>
              批量暂选，最后一起加入
            </Checkbox>
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              {batch ? '暂选随当前试验保存，换视频或刷新后可继续' : '点击加入组合，右键可仅看、不看或暂选'}
            </Typography.Text>
          </div>
          <div className='flex flex-wrap items-center gap-6px'>
            <Segmented
              size='small'
              value={source}
              options={[
                { value: '全部', label: '全部' },
                { value: '解析', label: '解析新词' },
                { value: '共现', label: '共现新词' },
                { value: '视频', label: '视频字段' },
                { value: '收藏', label: '收藏素材' },
                { value: '输入', label: '输入' },
              ]}
              onChange={(value) => setSource(String(value))}
            />
            {source === '共现' && (
              <Button
                size='small'
                type='link'
                style={{ padding: '0 4px' }}
                loading={busy}
                disabled={cooccurExhausted}
                title='按当前组合的标签轮流拉下一页搜索结果并累加共现词（无标签条件时按输入词）；语料行随深挖自动更新'
                onClick={() => void digCooccurMore()}
              >
                继续挖共现{cooccurPage > 1 ? ` · 已挖 ${cooccurPage} 页` : ''}
              </Button>
            )}
          </div>
          {source === '收藏' && !borrow ? (
            <div className='flex flex-col gap-10px'>
              <Input
                size='small'
                allowClear
                placeholder='过滤主题 / 一级组 / 组名 / 条件词'
                value={savedQuery}
                onChange={(event) => setSavedQuery(event.target.value)}
              />
              {!storesReady ? (
                <Typography.Text type='secondary'>正在读取收藏素材…</Typography.Text>
              ) : (
                <>
                  {savedTree.themes.length + savedTree.looseL1s.length + savedTree.orphanGroups.length === 0 && (
                    <Typography.Text type='secondary'>
                      {savedQuery ? '没有匹配的收藏组或条件' : '还没有启用的收藏组'}
                    </Typography.Text>
                  )}
                  {savedTree.themes.map((node) => {
                    const importable = node.l1s
                      .flatMap((l1) => l1.groups)
                      .filter((g) => g.importable)
                      .map((g) => g.group)
                    return (
                      <div key={node.theme.id} className='flex flex-col gap-6px'>
                        <div className='flex items-center gap-8px'>
                          <Typography.Text strong style={{ fontSize: 13 }}>
                            主题 · {node.theme.name}
                          </Typography.Text>
                          {importable.length > 0 && (
                            <Button
                              size='small'
                              type='link'
                              style={{ padding: 0, height: 'auto' }}
                              disabled={committing}
                              onClick={() => void importSavedGroups(importable, node.theme.name)}
                            >
                              整组导入 {importable.length} 组
                            </Button>
                          )}
                        </div>
                        <div className='flex flex-col gap-8px' style={{ paddingLeft: 12 }}>
                          {node.l1s.map(savedL1Block)}
                        </div>
                      </div>
                    )
                  })}
                  {savedTree.looseL1s.map(savedL1Block)}
                  {savedTree.orphanGroups.length > 0 && (
                    <div className='flex flex-col gap-8px'>
                      {(savedTree.themes.length > 0 || savedTree.looseL1s.length > 0) && (
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          未分组
                        </Typography.Text>
                      )}
                      {savedTree.orphanGroups.map(savedL2Row)}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className='flex flex-col gap-8px'>
              {source === '收藏' && borrow && (
                <Button
                  size='small'
                  style={{ alignSelf: 'flex-start' }}
                  disabled={committing}
                  onClick={() => void importSavedGroups([borrow], borrow.name)}
                >
                  导入整组「{borrow.name}」（保留结构）
                </Button>
              )}
              <div className='flex flex-wrap gap-8px'>{displayed.slice(0, materialLimit).map(materialButton)}</div>
            </div>
          )}
          {!busy && !displayed.length && source !== '收藏' && (
            <Typography.Text type='secondary'>
              暂无可选条件。输入标签名查找，或从视频的「选条件」中挑选。
            </Typography.Text>
          )}
          {busy && <Typography.Text type='secondary'>正在查找…</Typography.Text>}
          {!(source === '收藏' && !borrow) && displayed.length > materialLimit && (
            <Button size='small' onClick={() => setMaterialLimit((value) => value + 50)}>
              更多素材（还有 {displayed.length - materialLimit} 项）
            </Button>
          )}
          {source === '收藏' && borrowedFilters.length > 0 && (
            <>
              <Typography.Text strong>这份组合的明确过滤条件</Typography.Text>
              <div className='flex flex-wrap gap-6px'>
                {borrowedFilters.map((choice, i) =>
                  materialButton({ name: choice.label, source: '收藏', filter: choice.patch }, i),
                )}
              </div>
            </>
          )}
          {!!picks.length && (
            <>
              <Typography.Text strong>已暂选 {picks.length} 项</Typography.Text>
              <div className='flex flex-wrap gap-6px'>
                {picks.map((material) => {
                  const ptone = materialTone(material as Material)
                  return (
                    <Button
                      key={material.pickId}
                      size='small'
                      title={`点按移出暂选`}
                      style={{ background: ptone.bg, borderColor: ptone.bd, color: ptone.fg }}
                      onClick={() => stage(material as Material)}
                    >
                      {material.name} ×
                    </Button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </Drawer>
      <TagRecVideoMaterials />
    </div>
  )
}
