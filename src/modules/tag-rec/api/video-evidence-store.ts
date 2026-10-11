import { mergeTagRecPartitionFields, normalizeTagRecPartition } from '../model/partition'
import { rememberTagRecPartition } from './partition-cache'
import { persistVideoTags } from './video-tags-store'
import type { TagRecItemExtend } from '$define'
import type { TagTopItem, ViewDetailTagItem } from './endpoints'

export type TagRecVideoEvidence = Partial<
  Pick<
    TagRecItemExtend,
    | 'title'
    | 'desc'
    | 'owner'
    | 'aid'
    | 'cid'
    | 'duration'
    | 'pubdate'
    | 'tid'
    | 'tidv2'
    | 'tnamev2'
    | 'pid_v2'
    | 'pid_name_v2'
    | 'ownTagIds'
    | 'ownTagNames'
    | 'fieldEvidence'
  >
>

const known = new Map<string, { at: number; fields: TagRecVideoEvidence }>()

export function getCachedTagRecVideoEvidence(bvid: string): TagRecVideoEvidence | undefined {
  const entry = known.get(bvid)
  if (!entry) return
  if (
    Date.now() - entry.at >
    (entry.fields.ownTagIds !== undefined && entry.fields.fieldEvidence?.desc === 'complete' ? 15 * 60_000 : 15_000)
  ) {
    known.delete(bvid)
    return
  }
  known.delete(bvid)
  known.set(bvid, entry)
  return entry.fields
}

/**
 * /view/detail 响应 => BV 事实入库 (证据短缓存 + 分区持久缓存 + 视频标签持久层)。
 * 所有拿到完整详情响应的路径 (证据补查 / 分区补查) 都必须经此入库 —— 同一接口的
 *   任一消费者把字段沉淀全, 其它消费者读缓存即可, 不再为「同一个响应」二次付费。
 */
export async function rememberTagRecVideoEvidence(
  bvid: string,
  data: { View?: TagTopItem; Tags?: ViewDetailTagItem[] } | undefined,
): Promise<TagRecVideoEvidence | undefined> {
  const view = data?.View
  if (!view || view.bvid !== bvid) return
  // A later response that omits fields must not downgrade what an earlier complete
  // response already established: defined fields still update, absent ones retain.
  const prev = known.get(bvid)?.fields
  const fields: TagRecVideoEvidence = {
    ...mergeTagRecPartitionFields<TagRecVideoEvidence>(prev ?? {}, normalizeTagRecPartition(view)),
    // 审计 §5: 整包回包的内容字段全量沉淀 —— 同一 BV 先以残缺行进队, 详情送达后
    //   简介/UP/时长/avid/cid 补齐候选, 不再为「展示用的完整字段」二次付费
    ...(typeof view.title === 'string' && { title: view.title }),
    ...(typeof view.desc === 'string' && { desc: view.desc }),
    ...(view.owner && { owner: view.owner }),
    ...(typeof view.duration === 'number' && { duration: view.duration }),
    ...(typeof view.pubdate === 'number' && { pubdate: view.pubdate }),
    ...(typeof view.aid === 'number' && { aid: view.aid }),
    ...(typeof view.cid === 'number' && { cid: view.cid }),
    fieldEvidence: {
      title: typeof view.title === 'string' ? 'complete' : (prev?.fieldEvidence?.title ?? 'missing'),
      desc: typeof view.desc === 'string' ? 'complete' : (prev?.fieldEvidence?.desc ?? 'missing'),
    },
  }
  const tags = data?.Tags
  if (Array.isArray(tags)) {
    // An authoritative Tags array replaces tag evidence; an absent one keeps it.
    if (tags.every((tag) => Number.isSafeInteger(tag.tag_id) && tag.tag_id! > 0))
      fields.ownTagIds = tags.map((tag) => tag.tag_id!)
    else delete fields.ownTagIds
    fields.ownTagNames = tags.flatMap((tag) => (typeof tag.tag_name === 'string' ? [tag.tag_name] : []))
    await persistVideoTags(bvid, tags, { partial: false }).catch(() => undefined)
  }
  rememberTagRecPartition(bvid, view)
  known.delete(bvid)
  known.set(bvid, { at: Date.now(), fields })
  while (known.size > 2_000) known.delete(known.keys().next().value!)
  return fields
}
