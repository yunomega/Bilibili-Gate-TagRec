import { Button, Input, Modal, Tag, Typography } from 'antd'
import Emittery from 'emittery'
import { useEffect, useState } from 'react'
import { antMessage } from '$modules/antd'
import { favStore } from '$modules/rec-services/fav/store'
import { wrapComponent } from '$utility/global-component'
import { tagRecFavThemeFolderCreatedTodayCount } from '../api/fav-theme-folder-store'
import {
  alignThemeFolderName,
  createThemeFolderAndFav,
  favToThemeFolder,
  legacyThemeNameOf,
  matchThemeFolders,
  TAG_REC_FAV_THEME_FOLDER_DAILY_HINT,
} from '../service/fav-theme-folder'
import type { FavThemeFolderMatch } from '$modules/rec-services/fav/fav-theme-match'

/**
 * [tag-rec] R9 「收藏到主题夹」小弹层 (V3 混合的弹层兜底; 原型 fav-to-folder.html 定案)
 * - 匹配区 (主题名子串, 精确 > 前缀 > 包含; 旧名夹对齐行) / 新建区 (命名 chips + 计数 + 隐私 + 配额) / 全部夹
 * - 风控: 收藏面 = 登录态通道 (账号维度) —— 只在显式点击时发; 夹列表复用 favStore 缓存
 */
type Props = { show: boolean; avid: string; themeName: string; onClose: () => void }

const NAME_LIMIT = 20
const nameOf = (themeName: string, prefixed: boolean) =>
  (prefixed ? `tag-rec·${themeName}` : themeName).slice(0, NAME_LIMIT)

function FavThemeFolderModal({ show, avid, themeName, onClose }: Props) {
  const [matches, setMatches] = useState<FavThemeFolderMatch[]>([])
  const [legacyOf, setLegacyOf] = useState<Record<number, string>>({})
  const [prefixed, setPrefixed] = useState(false)
  const [name, setName] = useState('')
  const [privacy, setPrivacy] = useState<0 | 1>(0)
  const [todayCount, setTodayCount] = useState(0)
  const [busy, setBusy] = useState(false)

  const capReached = todayCount >= TAG_REC_FAV_THEME_FOLDER_DAILY_HINT
  const exactMatch = matches.find((m) => m.kind === 'exact')
  const dupName = matches.some((m) => m.folder.title === name.trim())

  useEffect(() => {
    if (!show) return
    setPrefixed(false)
    setName(nameOf(themeName, false))
    setPrivacy(0)
    setMatches([])
    setLegacyOf({})
    let alive = true
    void (async () => {
      const [ms, count] = await Promise.all([matchThemeFolders(themeName), tagRecFavThemeFolderCreatedTodayCount()])
      if (!alive) return
      setMatches(ms)
      setTodayCount(count)
      const legacy: Record<number, string> = {}
      for (const m of ms) {
        const old = await legacyThemeNameOf(m.folder.id, themeName)
        if (old) legacy[m.folder.id] = old
      }
      if (alive) setLegacyOf(legacy)
    })()
    return () => {
      alive = false
    }
  }, [show, themeName])

  const doFav = async (folderId: number, folderTitle: string) => {
    setBusy(true)
    const r = await favToThemeFolder(avid, folderId, folderTitle)
    setBusy(false)
    if (r.ok) {
      antMessage.success(r.message)
      onClose()
    } else {
      antMessage.error(r.message)
    }
  }

  const doCreate = async () => {
    const title = name.trim().slice(0, NAME_LIMIT)
    if (!title) return antMessage.warning('请填写收藏夹名称')
    setBusy(true)
    const r = await createThemeFolderAndFav(avid, themeName, { title, privacy })
    setBusy(false)
    if (r.ok) {
      antMessage.success(r.message)
      onClose()
    } else {
      antMessage.error(r.message)
    }
  }

  const doAlign = async (m: FavThemeFolderMatch) => {
    const r = await alignThemeFolderName(m.folder.id, themeName)
    if (!r.ok) return antMessage.error(r.message)
    antMessage.success(r.message)
    setLegacyOf((x) => {
      const next = { ...x }
      delete next[m.folder.id]
      return next
    })
    setMatches((ms) =>
      ms.map((x) => (x.folder.id === m.folder.id ? { ...x, folder: { ...x.folder, title: themeName } } : x)),
    )
  }

  const others = favStore.folders.filter((f) => !matches.some((m) => m.folder.id === f.id))

  return (
    <Modal title='收藏到主题夹' open={show} onCancel={onClose} footer={null} width={540}>
      <div className='flex flex-col gap-y-8px'>
        <div className='text-13px'>
          本视频主题: <b>{themeName}</b>
        </div>

        {/* 匹配区 */}
        <div className='flex flex-wrap items-center gap-x-6px'>
          <span className='w-96px text-12px font-bold'>匹配到的收藏夹</span>
          {matches.length ? (
            matches.map((m) => (
              <span key={m.folder.id} className='inline-flex items-center gap-x-4px'>
                <Button size='small' disabled={busy} onClick={() => doFav(m.folder.id, m.folder.title)}>
                  📁 {m.folder.title} ({m.folder.media_count})
                </Button>
                {legacyOf[m.folder.id] && (
                  <>
                    <Tag className='mr-0' color='orange'>
                      旧名「{legacyOf[m.folder.id]}」
                    </Tag>
                    <Button size='small' disabled={busy} onClick={() => doAlign(m)}>
                      改名为「{themeName}」
                    </Button>
                  </>
                )}
              </span>
            ))
          ) : (
            <Typography.Text type='warning' className='text-12px'>
              没有匹配到「{themeName}」相关的收藏夹 → 建议新建
            </Typography.Text>
          )}
        </div>

        {/* 新建区 */}
        <div className='flex flex-wrap items-center gap-x-6px'>
          <span className='w-96px text-12px font-bold'>新建收藏夹</span>
          <Input
            size='small'
            style={{ width: 200 }}
            value={name}
            maxLength={NAME_LIMIT}
            onChange={(e) => setName(e.target.value)}
          />
          <Typography.Text type={name.length >= NAME_LIMIT ? 'warning' : 'secondary'} className='text-11px'>
            {name.length}/{NAME_LIMIT}
          </Typography.Text>
          {dupName && (
            <Typography.Text type='warning' className='text-11px'>
              已存在同名夹 → 点匹配项直接收藏
            </Typography.Text>
          )}
        </div>

        <div className='flex flex-wrap items-center gap-x-6px'>
          <span className='w-96px text-12px font-bold'>命名</span>
          {[
            ['bare', '主题名（推荐 · 干净）'],
            ['prefixed', 'tag-rec·主题名（可选 · 便于区分）'],
          ].map(([k, label]) => (
            <Button
              key={k}
              size='small'
              type={(!prefixed && k === 'bare') || (prefixed && k === 'prefixed') ? 'primary' : 'default'}
              onClick={() => {
                const next = k === 'prefixed'
                setPrefixed(next)
                setName(nameOf(themeName, next))
              }}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className='flex flex-wrap items-center gap-x-6px'>
          <span className='w-96px text-12px font-bold'>隐私</span>
          <Button size='small' type={privacy === 0 ? 'primary' : 'default'} onClick={() => setPrivacy(0)}>
            公开（B站默认）
          </Button>
          <Button size='small' type={privacy === 1 ? 'primary' : 'default'} onClick={() => setPrivacy(1)}>
            私密
          </Button>
        </div>

        <div className='flex flex-wrap items-center gap-x-6px'>
          <span className='w-96px text-12px font-bold'>今日配额</span>
          {capReached ? (
            <Typography.Text type='warning' className='text-11px'>
              ⚠ 今日建夹已达上限（B站约 {TAG_REC_FAV_THEME_FOLDER_DAILY_HINT} 个/日）→ 建议选匹配夹，或明天再来
            </Typography.Text>
          ) : (
            <Typography.Text type='secondary' className='text-11px'>
              本脚本今日已建 {todayCount}/{TAG_REC_FAV_THEME_FOLDER_DAILY_HINT}（B站每日上限约{' '}
              {TAG_REC_FAV_THEME_FOLDER_DAILY_HINT} 个，含手动建夹也计数）
            </Typography.Text>
          )}
        </div>

        <div className='flex items-center gap-x-8px'>
          <Button type='primary' loading={busy} onClick={doCreate}>
            ✨ 创建并收藏
          </Button>
          <Typography.Text type='secondary' className='text-11px'>
            来源标记进简介（intro 写「tag-rec · 主题「{themeName}」」，不占标题）
          </Typography.Text>
        </div>

        {!!others.length && (
          <div className='flex flex-wrap items-center gap-x-6px'>
            <span className='w-96px text-12px font-bold'>全部收藏夹</span>
            {others.slice(0, 8).map((f) => (
              <Button key={f.id} size='small' disabled={busy} onClick={() => doFav(f.id, f.title)}>
                {f.title} ({f.media_count})
              </Button>
            ))}
          </div>
        )}

        <Typography.Text type='secondary' className='text-11px'>
          夹 ↔ 主题不做持续同步：命名即映射（默认主题名，前缀可选）；只在动作时一次性对齐；删主题不删夹
        </Typography.Text>
        <Typography.Text type='secondary' className='text-11px'>
          建夹/收藏走登录态通道（账号维度）：只在点击时发，不自动/不预取/不批量；夹列表复用缓存
        </Typography.Text>
      </div>
    </Modal>
  )
}

const defaultProps: Props = { show: false, avid: '', themeName: '', onClose }
const { proxyProps: _proxyProps, updateProps } = wrapComponent<Props>({
  Component: FavThemeFolderModal,
  defaultProps,
  containerClassName: 'FavThemeFolderModal',
})

const emitter = new Emittery<{ 'modal-close': undefined }>()
function onClose() {
  updateProps({ show: false })
  emitter.emit('modal-close')
}

/** 打开「收藏到主题夹」弹层 (等关闭) */
export async function startFavThemeFolderModal({ avid, themeName }: { avid: string; themeName: string }) {
  updateProps({ show: true, avid, themeName })
  await emitter.once('modal-close')
}

/** 子菜单「新建「X」」直通: 用默认名 (裸主题名) 创建并收藏 */
export async function createFavThemeFolderQuick({ avid, themeName }: { avid: string; themeName: string }) {
  const r = await createThemeFolderAndFav(avid, themeName, { title: nameOf(themeName, false) })
  if (r.ok) antMessage.success(r.message)
  else antMessage.error(r.message)
}
