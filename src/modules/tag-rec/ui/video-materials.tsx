import { Button, Checkbox, Collapse, Drawer, Dropdown, Input, Tabs, Tag, theme, Typography } from 'antd'
import { cloneDeep } from 'es-toolkit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'
import { VideoCardActionButton } from '$components/VideoCard/child-components/VideoCardActions'
import { IconForFav, IconForFaved } from '$modules/icon'
import { estimateTagRecConditionImpact } from '$modules/rec-services/service-map'
import toast from '$utility/toast'
import { fetchTagInfoById, fetchTagInfoByName, type TagInfo } from '../api/endpoints'
import { fetchTagRecVideoEvidence, getCachedTagRecVideoEvidence, mergeTagRecVideoEvidence } from '../api/video-evidence'
import { getPersistedVideoTags, type VideoTagEntry } from '../api/video-tags-store'
import {
  TAG_REC_CONDITION_FIELDS,
  tagRecCombinationOf,
  tagRecConditionAtom,
  tagRecConditionAtoms,
  tagRecConditionKey,
  tagRecConditionLabel,
  type TagRecConditionAtom,
  type TagRecConditionGroup,
} from '../model/combination'
import { findGroupsByTagIds } from '../model/favorites'
import { poolOfVia } from '../model/filter-engine'
import { tagRecMaterialSegments, tagRecMaterialWords } from '../model/material-words'
import { normalizeTagName } from '../model/tag-norm'
import { parseTagType } from '../model/tag-status'
import { favorites, favoritesStore } from '../store'
import { blockTagRecConditionGlobally, tagRecCombinationBlocks } from '../store/combination-blocks'
import {
  openTagRecVideoMaterials,
  stageTagRecMaterial,
  tagRecDiscoveryUi,
  tagRecMaterialKey,
  type TagRecMaterial,
} from '../store/discovery-ui'
import { commitTagRecMaterialDraft, selectTagRecMaterial } from '../store/material-draft'
import { tagRecCustomSession } from '../store/session'
import {
  excludeTagRecWorkingCondition,
  exploreTagRecMaterialOnly,
  removeTagRecWorkingCondition,
  tagRecWorkbench,
} from '../store/workbench'
import { TAG_REC_POOL_NAMES } from './discovery-pools'
import { tagRecFieldTones } from './field-tones'
import { IconForTagManage } from './icons'
import type { TagRecItemExtend } from '$define'
import type { TagGroup, TagIdEntry } from '../model/types'

export function TagRecDiscoveryCardActions({ item, visible }: { item: TagRecItemExtend; visible: boolean }) {
  return (
    <VideoCardActionButton
      visible={visible}
      inlinePosition='right'
      icon={<IconForTagManage className='size-16px' />}
      tooltip='选条件'
      role='button'
      aria-label='从视频选条件'
      tabIndex={visible ? 0 : -1}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          openTagRecVideoMaterials(item, tagRecWorkbench.activeId)
        }
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openTagRecVideoMaterials(item, tagRecWorkbench.activeId)
      }}
    />
  )
}

type VideoMaterialTab = 'tag' | 'up' | 'partition' | 'title' | 'desc'

export function TagRecVideoMaterials() {
  const ui = useSnapshot(tagRecDiscoveryUi)
  const memory = useSnapshot(tagRecWorkbench)
  const { activeId } = memory
  const { workingGroup } = useSnapshot(tagRecCustomSession)
  const workingCombination = workingGroup?.combination
  const globalBlocks = useSnapshot(tagRecCombinationBlocks)
  const favList = useSnapshot(favoritesStore).list
  const { token } = theme.useToken()
  const { excludeTone, materialTone } = tagRecFieldTones(token)
  const [item, setItem] = useState<TagRecItemExtend>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [tags, setTags] = useState<VideoTagEntry[]>([])
  const [infos, setInfos] = useState<Record<string, TagInfo>>({})
  const [phrase, setPhrase] = useState('')
  const [tab, setTab] = useState<VideoMaterialTab>('tag')
  const [committing, setCommitting] = useState(false)
  const [batch, setBatch] = useState(false)
  /** Q9: 点击加入后的一行非阻断成本提示 (关系/本地预计命中), 随视频切换清空。 */
  const [costHint, setCostHint] = useState('')
  const [details, setDetails] = useState(false)
  const [morePhrases, setMorePhrases] = useState(false)
  const request = useRef<AbortController | undefined>(undefined)
  /** 本 BV 详情证据已尝试补查的标记 —— 防「补后仍不完整」自触发循环; 换视频复位 */
  const evidenceTried = useRef<string | undefined>(undefined)
  const open = !!ui.video && ui.videoTrialId === activeId
  const load = async (video: TagRecItemExtend) => {
    if (!open || video.bvid !== ui.video?.bvid) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const trialId = ui.videoTrialId
    const isCurrent = () =>
      !controller.signal.aborted &&
      request.current === controller &&
      tagRecDiscoveryUi.video?.bvid === video.bvid &&
      tagRecDiscoveryUi.videoTrialId === trialId &&
      tagRecWorkbench.activeId === trialId
    setBusy(true)
    setError(false)
    try {
      const fields = await fetchTagRecVideoEvidence(video.bvid, controller.signal)
      const paired = await getPersistedVideoTags(video.bvid).catch(() => undefined)
      if (isCurrent()) {
        setItem(mergeTagRecVideoEvidence(video, fields))
        setTags(paired ?? [])
        setError(!fields)
      }
    } catch {
      if (isCurrent()) setError(true)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  useEffect(() => {
    request.current?.abort()
    setBusy(false)
    setError(false)
    setPhrase('')
    setTags([])
    setInfos({})
    setTab('tag')
    setDetails(false)
    setMorePhrases(false)
    evidenceTried.current = undefined
    if (!open || !ui.video) {
      setItem(undefined)
      return
    }
    const video = mergeTagRecVideoEvidence(
      cloneDeep(ui.video) as TagRecItemExtend,
      getCachedTagRecVideoEvidence(ui.video.bvid),
    )
    setItem(video)
    let active = true
    void getPersistedVideoTags(video.bvid)
      .then((paired) => {
        if (active) setTags(paired ?? [])
      })
      .catch(() => undefined)
    return () => {
      active = false
      request.current?.abort()
    }
  }, [ui.video, open])
  // 成本提示随视频/开关切换清空 (一次性反馈, 不跨语境滞留)
  useEffect(() => setCostHint(''), [ui.video, open])
  // 详情证据按需 (实修: 不为未点开的简介/名单预付一次 detail):
  //   缺自身标签名单 (标签页签本体内容) 或 切到「简介」页签正文不完整 => 补一次;
  //   tried 记本 BV 防「仍不完整」自触发循环, 手动「补齐」按钮不受此闸
  useEffect(() => {
    // 换视频的同一轮 effect 中 item 仍可能是上一条；等本条状态就位后才补查。
    if (!open || !item || item.bvid !== ui.video?.bvid || busy) return
    const needsTags = item.ownTagIds === undefined
    const needsDesc = tab === 'desc' && item.fieldEvidence?.desc !== 'complete'
    if ((!needsTags && !needsDesc) || evidenceTried.current === item.bvid) return
    evidenceTried.current = item.bvid
    void load(item)
  }, [item, tab, open, ui.video?.bvid, busy])
  // 行内使用数/缺 id 标签的实体: 「查看标签详情」展开才惰性补 tag/info (三级缓存, 首批 12 个);
  //   折叠态不预付 —— 名单本身来自本地持久化+自报, 解析动作另有 resolveTagEntry 兜底
  const ownTagNames = item?.ownTagNames
  useEffect(() => {
    if (!open || !details) return
    const names = [...new Set([...(ownTagNames ?? []), ...tags.flatMap((tag) => (tag.tag_name ? [tag.tag_name] : []))])]
    if (!names.length) return
    // 生命周期闸 (审计 §8-2): 收起详情/关抽屉/换视频 => signal 退出本批等待;
    //   无其他消费者等待的排队/在途解析随「最后等待者离开」取消, 不再做无人等候的取数
    const ctrl = new AbortController()
    void Promise.allSettled(
      names.slice(0, 12).map((name) => fetchTagInfoByName(name, ctrl.signal).then((info) => [name, info] as const)),
    ).then((results) => {
      if (ctrl.signal.aborted) return
      setInfos((previous) => {
        const next = { ...previous }
        for (const result of results)
          if (result.status === 'fulfilled' && result.value[1]) next[result.value[0]] = result.value[1]
        return next
      })
    })
    return () => ctrl.abort()
  }, [ownTagNames, tags, open, details])

  const staged = memory.trials.find((entry) => entry.id === activeId)?.pending ?? []
  const pick = (material: TagRecMaterial) => stageTagRecMaterial(activeId, material)
  const isStaged = (material: TagRecMaterial) =>
    staged.some((entry) => tagRecMaterialKey(entry as TagRecMaterial) === tagRecMaterialKey(material))
  /**
   * Q9: 点击即加入 (多选友好, 无弹窗) —— 成本已在取数链封顶 (本地先行零请求 / 文本词 ≤2 页 /
   * 长词不开流 / 零进展护栏), 预览改为面板内一行非阻断提示; 想先攒一批可勾「批量暂选」。
   */
  const addMaterial = (material: TagRecMaterial) => {
    const atom = material.atom
    if (atom) {
      const impact = estimateTagRecConditionImpact(atom)
      setCostHint(
        `已加入「${material.name}」· 关系「${impact.join === 'any' ? '或' : '且'}」· 加入前本地预计命中 ${impact.hits} 条 · 存量耗尽后自动检索`,
      )
    }
    void selectTagRecMaterial(material)
  }
  // 本抽屉里无 atom 的素材即未解析的视频标签名 (UP/分区/标题简介词均带 atom)
  const isTagMaterial = (material: TagRecMaterial) => (material.atom ? material.atom.field === 'tag' : true)

  // 组合/排除/全局命中 (本抽屉无 atom 的素材即未解析标签名, 按名归一匹配)
  const includeAtoms = workingCombination
    ? tagRecConditionAtoms(workingCombination.include as TagRecConditionGroup)
    : []
  const same = (atom: TagRecConditionAtom, material: TagRecMaterial) =>
    material.atom
      ? tagRecConditionKey(atom) === tagRecConditionKey(material.atom)
      : atom.field === 'tag' && normalizeTagName(atom.value.name) === normalizeTagName(material.name)
  const positive = (material: TagRecMaterial) => includeAtoms.find((atom) => same(atom, material))
  const negative = (material: TagRecMaterial) => workingCombination?.exclude.find((atom) => same(atom, material))
  const globalBlocked = (material: TagRecMaterial) => globalBlocks.list.find((atom) => same(atom, material))

  // 「已在 N 个收藏」: 收藏组正向标签按 id/名归一对号
  const favTagSets = useMemo(
    () =>
      favList.map((group) => {
        const names = new Set<string>()
        const ids = new Set<number>()
        for (const atom of tagRecConditionAtoms(tagRecCombinationOf(group as TagGroup).include))
          if (atom.field === 'tag') {
            names.add(normalizeTagName(atom.value.name))
            ids.add(atom.value.id)
          }
        return { names, ids }
      }),
    [favList],
  )
  const favCount = (name: string, id?: number) =>
    favTagSets.filter((entry) => (id !== undefined && entry.ids.has(id)) || entry.names.has(normalizeTagName(name)))
      .length

  const materialId = (material: TagRecMaterial) =>
    isTagMaterial(material)
      ? material.atom?.field === 'tag'
        ? material.atom.value.id
        : (material.tagId ?? infos[material.name]?.id)
      : undefined

  // 星标入表: 未解析标签点菜单时才惰性解析 (tag/info 三级缓存), 解出即回填 infos 供行内 #id/使用数
  const resolveTagEntry = async (material: TagRecMaterial): Promise<TagIdEntry | undefined> => {
    const known = materialId(material)
    const info =
      infos[material.name] ??
      (await (known !== undefined ? fetchTagInfoById(known) : fetchTagInfoByName(material.name)).catch(() => undefined))
    if (info && !infos[material.name]) setInfos((previous) => ({ ...previous, [material.name]: info }))
    const id = known ?? info?.id
    if (id === undefined) return undefined
    return { id, name: info?.name ?? material.name, ...(info?.tag_type ? { tag_type: info.tag_type } : {}) }
  }
  const favAct = async (material: TagRecMaterial, action: 'new' | { group: TagGroup; remove?: boolean }) => {
    const entry = await resolveTagEntry(material)
    if (!entry) {
      toast('这条标签还没解析到，稍后再试')
      return
    }
    if (action === 'new') {
      const res = favorites.addGroup({ name: entry.name, tag_ids: [entry] })
      if (res) toast(`已收藏到「${res.group.name}」`)
      return
    }
    if (action.remove) {
      if (favorites.removeTagIdFromGroup(action.group.id, entry.id)) toast(`已移出「${action.group.name}」`)
      return
    }
    const res = favorites.addTagIdsToGroup(action.group.id, [entry])
    toast(
      res.added || res.moved
        ? `已加入「${action.group.name}」`
        : res.skipped
          ? `「${action.group.name}」已有此标签`
          : '未加入',
    )
  }

  const row = (material: TagRecMaterial, meta: string[]) => {
    const pos = positive(material)
    const neg = negative(material)
    const glob = globalBlocked(material)
    const picked = isStaged(material)
    const info = isTagMaterial(material) ? infos[material.name] : undefined
    const id = materialId(material)
    // 仅看/排除类需要已解析 atom; 暂选保持原样 (提交时才惰性解析, 与 commit 同口径)
    const resolved: TagRecMaterial =
      material.atom || !id ? material : { ...material, atom: tagRecConditionAtom('tag', { id, name: material.name }) }
    const resolvedAtom = resolved.atom
    const favs = isTagMaterial(material) ? favCount(info?.name ?? material.name, id) : 0
    const metaParts = [
      ...meta,
      info?.use !== undefined ? `使用 ${info.use}` : '',
      !resolvedAtom ? '待解析' : '',
      favs ? `已在 ${favs} 个收藏` : '',
    ].filter(Boolean)
    const menuItems = [
      isTagMaterial(material)
        ? {
            key: 'only',
            label: '仅看这个标签 · 原组合记入最近尝试',
            onClick: () => void exploreTagRecMaterialOnly(resolved),
          }
        : undefined,
      { key: 'excludeStage', label: '暂选为「这个组合不看」', onClick: () => pick({ ...resolved, exclude: true }) },
      resolvedAtom
        ? {
            key: 'exclude',
            label: '本组合不看',
            onClick: () => excludeTagRecWorkingCondition(cloneDeep(resolvedAtom)),
          }
        : undefined,
      resolvedAtom
        ? {
            key: 'global',
            label: '以后都不看',
            onClick: () => blockTagRecConditionGlobally(cloneDeep(resolvedAtom)),
          }
        : undefined,
    ].filter((entry): entry is NonNullable<typeof entry> => !!entry)
    const [primaryLabel, primaryAction] = pos
      ? ['已选 · 移出', () => removeTagRecWorkingCondition(pos.id)]
      : neg
        ? ['已不看 · 恢复', () => removeTagRecWorkingCondition(neg.id)]
        : picked
          ? ['已暂选 · 取消', () => pick(material)]
          : [batch ? '暂选' : '选入', () => (batch ? pick(material) : addMaterial(resolved))]
    // 星标: 宿主按 id 对号 (未解析标签靠点击时惰性解析, 不列移出项)
    const favEntry: TagIdEntry | undefined =
      id !== undefined
        ? { id, name: info?.name ?? material.name, ...(info?.tag_type ? { tag_type: info.tag_type } : {}) }
        : undefined
    const favHosts = favEntry ? findGroupsByTagIds(favorites.list, [favEntry.id]) : []
    const favItems = [
      { key: 'fav-new', label: '新建收藏项', onClick: () => void favAct(material, 'new') },
      ...favorites.list
        .filter((group) => group.enabled && !favHosts.some((host) => host.id === group.id))
        .map((group) => ({
          key: `fav-${group.id}`,
          label: `加入「${group.name}」`,
          onClick: () => void favAct(material, { group }),
        })),
      ...favHosts.map((group) => ({
        key: `unfav-${group.id}`,
        label: `移出「${group.name}」`,
        danger: true,
        onClick: () => void favAct(material, { group, remove: true }),
      })),
    ]
    if (!details || !isTagMaterial(material)) {
      // 与工作台抽屉同一套字段色: 已选=实心字段色, 已暂选=虚线强调, 不看=红, 其余=字段色淡底
      const tone = neg || glob ? excludeTone : materialTone(material)
      const solid = !!pos
      const fg = solid ? '#fff' : tone.fg
      return (
        <div
          key={tagRecMaterialKey(material)}
          style={{
            display: 'inline-flex',
            maxWidth: '100%',
            border: `1px ${picked && !pos ? 'dashed' : 'solid'} ${pos || picked ? tone.fg : tone.bd}`,
            borderRadius: 8,
            overflow: 'hidden',
            background: solid ? tone.fg : tone.bg,
          }}
        >
          <Button
            type='text'
            disabled={!!glob}
            onClick={primaryAction}
            title={glob ? '已全局排除' : primaryLabel}
            aria-label={`${primaryLabel}：${material.name}`}
            style={{
              height: 'auto',
              minHeight: 34,
              padding: '5px 10px',
              whiteSpace: 'normal',
              textAlign: 'left',
              color: fg,
              fontWeight: pos || picked ? 600 : undefined,
            }}
          >
            {pos || picked ? '✓ ' : neg || glob ? '− ' : '+ '}
            {material.name}
          </Button>
          <Dropdown
            menu={{
              items: [
                ...menuItems,
                ...(isTagMaterial(material)
                  ? [{ key: 'favorites', label: favs ? `收藏管理 · 已在 ${favs} 个组` : '收藏到…', children: favItems }]
                  : []),
              ],
            }}
            trigger={['click', 'contextMenu']}
          >
            <Button
              type='text'
              aria-label={`${material.name} 的更多操作`}
              style={{
                height: 'auto',
                paddingInline: 6,
                color: fg,
                borderRadius: 0,
                borderLeft: `1px ${picked && !pos ? 'dashed' : 'solid'} ${solid ? 'rgba(255,255,255,.45)' : tone.bd}`,
              }}
            >
              ⋯
            </Button>
          </Dropdown>
        </div>
      )
    }
    return (
      <div
        key={tagRecMaterialKey(material)}
        className='flex items-center gap-8px'
        style={{ padding: '9px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className='flex flex-wrap items-center gap-6px'>
            <Typography.Text strong style={{ fontSize: 13 }}>
              {material.name}
            </Typography.Text>
            {id !== undefined && (
              <Button
                type='link'
                size='small'
                title='仅看这个标签，原组合记入最近尝试'
                onClick={() => void exploreTagRecMaterialOnly(resolved)}
                style={{ fontSize: 12, padding: 0 }}
              >
                #{id}
              </Button>
            )}
            {glob && <Tag color='error'>全局排除</Tag>}
            {!glob && neg && <Tag color='warning'>本组合不看</Tag>}
            {!glob && !neg && pos && <Tag color='success'>已生效</Tag>}
            {picked && <Tag color='purple'>已暂选</Tag>}
          </div>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {metaParts.join(' · ')}
          </Typography.Text>
        </div>
        <Button size='small' disabled={!!glob} onClick={primaryAction}>
          {primaryLabel}
        </Button>
        {isTagMaterial(material) && (
          <Dropdown menu={{ items: favItems }} trigger={['click']}>
            <Button
              size='small'
              type='text'
              aria-label={favs ? `已收藏于 ${favs} 个组，点开管理` : '收藏此标签'}
              title={favs ? `已收藏于 ${favs} 个组` : '收藏此标签'}
            >
              {favs ? <IconForFaved className='size-14px color-gate-primary' /> : <IconForFav className='size-14px' />}
            </Button>
          </Dropdown>
        )}
        <Dropdown menu={{ items: menuItems }} trigger={['click', 'contextMenu']}>
          <Button size='small' type='text' aria-label={`${material.name} 的更多操作`}>
            ⋯
          </Button>
        </Dropdown>
      </div>
    )
  }

  // 标签/简介任一未核实时的统一补齐入口 (两个页签复用)
  const retryEl = (
    <div className='flex items-center gap-8px' style={{ padding: '10px 0' }}>
      <Button
        size='small'
        loading={busy}
        onClick={() => {
          if (item) void load(item)
        }}
      >
        补齐这条视频的标签与简介
      </Button>
      {error && (
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          暂未取到，可以稍后重试。
        </Typography.Text>
      )}
    </div>
  )

  const textTab = (field: 'title' | 'desc', text: string, needsRetry: boolean) => (
    <section className='flex flex-col gap-10px'>
      <Typography.Text strong>从原文选一段</Typography.Text>
      <Typography.Text type='secondary' style={{ fontSize: 12 }}>
        点词段直接取词（先看成本预览），或拖选/输入完整词组；加入后按这段文字匹配。
      </Typography.Text>
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: token.colorFillQuaternary,
          whiteSpace: 'pre-wrap',
          userSelect: 'text',
          maxHeight: field === 'desc' ? 170 : 130,
          overflowY: 'auto',
          fontSize: 13,
        }}
        onMouseUp={() => {
          const selection = window.getSelection()
          if (selection?.toString().trim()) setPhrase(selection.toString().trim().slice(0, 200))
        }}
      >
        {text
          ? tagRecMaterialSegments(text).map((segment, index) =>
              segment.word ? (
                <span
                  key={index}
                  role='button'
                  title={`加入「${segment.text}」为${TAG_REC_CONDITION_FIELDS[field]}条件`}
                  style={{ cursor: 'pointer', borderBottom: '1px dashed currentColor' }}
                  onClick={() => {
                    // 拖选优先: 有活动选区时不误触加入
                    if (window.getSelection()?.toString().trim()) return
                    addMaterial({
                      atom: tagRecConditionAtom(field, segment.text),
                      name: segment.text,
                      source: '视频',
                    })
                  }}
                >
                  {segment.text}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )
          : '暂无可用文本'}
      </div>
      <div className='flex gap-6px'>
        <Input
          size='small'
          style={{ flex: '1 1 170px' }}
          value={phrase}
          maxLength={200}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder={`拖选${TAG_REC_CONDITION_FIELDS[field]}原文取词，或直接输入`}
        />
        <Button
          size='small'
          disabled={!phrase.trim()}
          onClick={() =>
            batch
              ? pick({ atom: tagRecConditionAtom(field, phrase.trim()), name: phrase.trim(), source: '视频' })
              : addMaterial({ atom: tagRecConditionAtom(field, phrase.trim()), name: phrase.trim(), source: '视频' })
          }
        >
          {batch ? '暂选这段' : '选入这段'}
        </Button>
      </div>
      <Typography.Text strong style={{ fontSize: 13 }}>
        短语建议
      </Typography.Text>
      <div className='flex flex-wrap gap-8px'>
        {tagRecMaterialWords(text)
          .slice(0, morePhrases ? 24 : 8)
          .map((word) =>
            row({ atom: tagRecConditionAtom(field, word), name: word, source: '视频' }, [
              '视频',
              TAG_REC_CONDITION_FIELDS[field],
            ]),
          )}
      </div>
      {tagRecMaterialWords(text).length > 8 && (
        <Button
          type='link'
          size='small'
          style={{ alignSelf: 'flex-start', padding: 0 }}
          onClick={() => setMorePhrases(!morePhrases)}
        >
          {morePhrases ? '收起短语' : `展开其余 ${tagRecMaterialWords(text).length - 8} 个短语`}
        </Button>
      )}
      {!tagRecMaterialWords(text).length && (
        <Typography.Text type='secondary'>没有合适的短语建议，可直接从原文拖选。</Typography.Text>
      )}
      {needsRetry && retryEl}
    </section>
  )

  // 标签素材 = 持久化完整名单 ∪ 自报名单 (名重按持久化带 id 版优先)
  const tagMaterials: TagRecMaterial[] = [
    ...tags
      .filter((tag): tag is VideoTagEntry & { tag_id: number; tag_name: string } => !!(tag.tag_id && tag.tag_name))
      .map((tag) => {
        const tag_type = parseTagType(tag.tag_type)
        return {
          atom: tagRecConditionAtom('tag', { id: tag.tag_id, name: tag.tag_name, ...(tag_type ? { tag_type } : {}) }),
          tagId: tag.tag_id,
          name: tag.tag_name,
          source: '视频' as const,
        }
      }),
    ...(ownTagNames ?? [])
      .filter((name) => !tags.some((tag) => normalizeTagName(tag.tag_name ?? '') === normalizeTagName(name)))
      .map((name) => {
        const id = infos[name]?.id
        return {
          ...(id ? { atom: tagRecConditionAtom('tag', { id, name }) } : {}),
          ...(id ? { tagId: id } : {}),
          name,
          source: '视频' as const,
        }
      }),
  ]

  const tabItems = [
    {
      key: 'tag' as const,
      label: `标签${tagMaterials.length ? ` ${tagMaterials.length}` : ''}`,
      children: (
        <section>
          {[
            {
              label: '可选标签',
              materials: tagMaterials.filter((m) => !positive(m) && !isStaged(m) && !negative(m) && !globalBlocked(m)),
            },
            {
              label: '已选条件 · 再点可移出',
              materials: tagMaterials.filter((m) => !negative(m) && !globalBlocked(m) && (positive(m) || isStaged(m))),
            },
            { label: '已设为不看', materials: tagMaterials.filter((m) => negative(m) || globalBlocked(m)) },
          ]
            .filter((group) => group.materials.length)
            .map((group) => (
              <section key={group.label} style={{ marginBlock: 16 }}>
                <Typography.Text type='secondary' style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
                  {group.label}
                </Typography.Text>
                <div className={details ? '' : 'flex flex-wrap gap-8px'}>
                  {group.materials.map((material) => row(material, []))}
                </div>
              </section>
            ))}
          {!!tagMaterials.length && (
            <Button type='link' size='small' style={{ padding: 0 }} onClick={() => setDetails(!details)}>
              {details ? '收起标签详情' : '查看标签编号、使用数与收藏'}
            </Button>
          )}
          {item?.ownTagIds === undefined && (
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              完整标签待核实，其他字段可以先取。
            </Typography.Text>
          )}
          {(error || item?.ownTagIds === undefined) && retryEl}
          {!tagMaterials.length && item?.ownTagIds !== undefined && (
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              这条视频没有公开标签。
            </Typography.Text>
          )}
        </section>
      ),
    },
    ...(item?.owner?.name
      ? [
          {
            key: 'up' as const,
            label: 'UP 主',
            children: (
              <section>
                {row(
                  {
                    atom: tagRecConditionAtom('up', { name: item.owner.name, mid: item.owner.mid }),
                    name: item.owner.name,
                    source: '视频',
                  },
                  ['视频', 'UP 主', ...(item.owner.mid ? [`UID ${item.owner.mid}`] : [])],
                )}
              </section>
            ),
          },
        ]
      : []),
    ...(item?.tidv2 || item?.tid
      ? [
          {
            key: 'partition' as const,
            label: '分区',
            children: (
              <section>
                {row(
                  {
                    atom: tagRecConditionAtom('partition', {
                      name: item.tnamev2 || `分区 ${item.tidv2 || item.tid}`,
                      ...(item.tidv2 ? { v2: item.tidv2 } : { v1: item.tid }),
                      level: 'leaf',
                    }),
                    name: item.tnamev2 || `分区 ${item.tidv2 || item.tid}`,
                    source: '视频',
                  },
                  ['视频', '子分区'],
                )}
              </section>
            ),
          },
        ]
      : []),
    { key: 'title' as const, label: '标题', children: textTab('title', item?.title ?? '', false) },
    {
      key: 'desc' as const,
      label: '简介',
      children: textTab('desc', item?.desc ?? '', error && item?.fieldEvidence?.desc !== 'complete'),
    },
  ]

  return (
    <Drawer
      title='选条件'
      open={open}
      onClose={() => {
        tagRecDiscoveryUi.video = undefined
      }}
      size={520}
      mask={{ closable: true }}
      styles={{ mask: { background: 'rgba(0,0,0,.12)' }, body: { padding: '0 20px 16px' } }}
    >
      {/* 吸顶: 视频名 + 说明 + 页签钉在抽屉顶, 行列表滚动时操作语境不丢 */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          background: token.colorBgElevated,
          paddingTop: 12,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Typography.Text type='secondary' ellipsis title={item?.title} style={{ fontSize: 12, display: 'block' }}>
          {item?.title}
        </Typography.Text>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          点击条件，立即加入当前组合。点 ⋯ 可仅看此标签、收藏或排除。
        </Typography.Text>
        {costHint && (
          <Typography.Text type='secondary' style={{ fontSize: 12, color: token.colorPrimary }}>
            {costHint}
          </Typography.Text>
        )}
        <div>
          <Checkbox checked={batch} onChange={(event) => setBatch(event.target.checked)}>
            批量暂选，最后一起加入
          </Checkbox>
        </div>
        {/* items 不带 children: 页签栏吸顶在头部, 行列表在下方独立滚动区渲染 */}
        <Tabs
          size='small'
          activeKey={tab}
          onChange={(key) => {
            setTab(key as VideoMaterialTab)
            setPhrase('')
            setMorePhrases(false)
          }}
          items={tabItems.map(({ key, label }) => ({ key, label }))}
        />
      </div>
      {tabItems.find((entry) => entry.key === tab)?.children}
      {item && (
        <Collapse
          ghost
          size='small'
          items={[
            {
              key: 'reason',
              label: '为什么出现这条视频',
              children: (
                <>
                  {[
                    ...new Set(
                      (item.activeSourceClaims ?? item.source.claims ?? [item.source]).map(
                        (claim) =>
                          `${TAG_REC_POOL_NAMES[poolOfVia(claim.via)]}${claim.queryKeyword ? ` · ${claim.queryKeyword}` : ''}`,
                      ),
                    ),
                  ].map((label) => (
                    <div key={label}>{label}</div>
                  ))}
                  <Typography.Text type='secondary'>
                    相关性优先，同档内容再参考质量。{item.relevance ? `已确认 ${item.relevance.hits} 个相关命中。` : ''}
                  </Typography.Text>
                </>
              ),
            },
          ]}
        />
      )}
      {/* 批量模式才显示提交区，直接选入无需二次确认。 */}
      {(batch || staged.length > 0) && (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            background: token.colorBgElevated,
            paddingTop: 10,
            marginTop: 12,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div className='flex items-center gap-8px'>
            <Typography.Text type='secondary' ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
              已暂选 {staged.length} 项
              {staged.length
                ? ` · ${staged.map((entry) => (entry.atom ? tagRecConditionLabel(entry.atom) : entry.name)).join('、')}`
                : ''}
            </Typography.Text>
            <Button
              size='small'
              type='primary'
              disabled={!staged.length}
              loading={committing}
              onClick={async () => {
                setCommitting(true)
                try {
                  await commitTagRecMaterialDraft()
                } finally {
                  setCommitting(false)
                }
              }}
            >
              加入当前组合
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  )
}
