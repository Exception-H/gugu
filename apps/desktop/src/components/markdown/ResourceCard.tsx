import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import type { FileMetadata } from '@gugu/core/shared/fileResolver'
import { attachmentQuery, attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { fileMetadata } from '../../lib/fileAccess'
import { chatService } from '../../lib/chat'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { readCachedDevices } from '../../store/devicesCache'
import { listedSession, rowOpens, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { FileAttachmentCard } from '../chat/FileAttachmentCard'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { MessageQuoteFrame } from '../chat/MessageQuote'
import { quotedContentView } from '../chat/quotedContent'
import { useNearViewport } from '../../hooks/useNearViewport'
import { cardTarget } from './resourceCards'

/** Card reads, keyed by the reader's account (attachmentQueryClient keeps reads key-only). */
const fileCardQuery = attachmentQuery('resource-card-file', (_accountId: string | undefined, itemId: string, version: number | null) =>
  fileMetadata(itemId, version ?? undefined))
const messageCardQuery = attachmentQuery('resource-card-message', (accountId: string, messageId: string) => chatService.getMessageById(messageId, accountId))

/**
 * The card under a chat paragraph for one linked resource (resourceCards.ts). Each card reads through the reader the
 * chat already uses for that resource — file metadata, the message reader, the task directory — as the person reading;
 * what that read cannot show is said on the card ("unavailable"), never turned back into a bare link.
 */
export function ResourceCard({ href, mine, onOpen }: { href: string; mine: boolean; onOpen: () => void }) {
  const target = cardTarget(href)
  if (target?.kind === 'file') return <FileCard itemId={target.itemId} version={target.version} mine={mine} onOpen={onOpen} />
  if (target?.kind === 'chat' && target.messageId) return <MessageCard chatId={target.chatId} messageId={target.messageId} mine={mine} onOpen={onOpen} />
  if (target?.kind === 'session') return <TaskItemCard sessionId={target.sessionId} mine={mine} onOpen={onOpen} />
  return null
}

function FileCard({ itemId, version, mine, onOpen }: { itemId: string; version?: number; mine: boolean; onOpen: () => void }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  const read = useQuery({ ...fileCardQuery(user?.id, itemId, version ?? null), enabled: near && !!user }, attachmentQueryClient)
  const unavailable = (details: string) => <FileAttachmentCard file={{ fileName: t('messaging:resourceCard.file'), sizeBytes: 0, mimeType: '' }} isMine={mine} details={details} onOpen={onOpen} />
  let card
  if (read.isError) card = unavailable(t('messaging:attachmentView.fileUnavailable'))
  else if (!read.data) card = <FileAttachmentCard file={{ fileName: t('messaging:resourceCard.file'), sizeBytes: 0, mimeType: '' }} isMine={mine} details="…" />
  else if (read.data.status !== 'ready') card = unavailable(t(read.data.status === 'gone' ? 'messaging:attachmentView.fileGone' : read.data.status === 'expired' ? 'messaging:attachmentView.fileExpired' : 'messaging:attachmentView.fileMissing'))
  else if (read.data.revision.source === 'local' && read.data.revision.host_online === false) card = unavailable(t('messaging:attachmentView.holderOffline', { machine: read.data.revision.host_label ?? t('messaging:attachmentView.holderMachine') }))
  else card = <ReadyFile metadata={read.data} itemId={itemId} mine={mine} onOpen={onOpen} />
  return <div ref={box} className="gg-resource-card-box">{card}</div>
}

function ReadyFile({ metadata, itemId, mine, onOpen }: { metadata: Extract<FileMetadata, { status: 'ready' }>; itemId: string; mine: boolean; onOpen: () => void }) {
  const { t } = useTranslation('messaging')
  const { revision } = metadata
  const image = isRenderableImage(revision.file_name, revision.content_type)
  const version = revision.version ?? 1
  const thumb = useAttachmentObjectUrl({ kind: 'item', itemId, version }, 'thumb', image, metadata)
  const file = { fileName: revision.file_name, sizeBytes: revision.size_bytes, mimeType: revision.content_type, kind: image ? 'image' as const : 'file' as const }
  const versionLabel = version > 1 ? t('attachmentView.fileVersion', { n: version }) : undefined
  return <>
    {image && thumb.status === 'ready' ? <img src={thumb.objectUrl} alt={revision.file_name} className="chat-inline-image gg-resource-card-thumb" onClick={onOpen} /> : null}
    <FileAttachmentCard file={file} isMine={mine} versionLabel={versionLabel} onOpen={onOpen}
      details={image && thumb.status !== 'ready' && thumb.status !== 'loading' ? t('attachmentView.imageUnavailable') : undefined} />
  </>
}

function MessageCard({ chatId, messageId, mine, onOpen }: { chatId: string; messageId: string; mine: boolean; onOpen: () => void }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const chat = chats.find(row => row.id === chatId)
  const box = useRef<HTMLDivElement>(null)
  const near = useNearViewport(box)
  // Read even when the chat is not in this window's list (a topic, a chat not loaded yet): the reader's row access decides,
  // with the same checks as opening the link (a live message in that chat). Unavailable only once that read says so.
  const read = useQuery({ ...messageCardQuery(user?.id ?? '', messageId), enabled: near && !!user }, attachmentQueryClient)
  const message = read.data && read.data.chat_id === chatId && !read.data.retracted_at ? read.data : null
  const unavailable = read.isError || (read.isSuccess && !message)
  const sender = message?.sender_user_id ? identitiesById[message.sender_user_id]?.display_name : undefined
  const head = sender ?? chat?.name ?? t('messaging:resourceCard.message')
  const text = unavailable ? t('messaging:resourceCard.unavailable') : message ? quotedContentView(widgetMessagePreview(message.content) ?? message.content).text : '…'
  return <div ref={box} className="gg-resource-card-box"><MessageQuoteFrame mine={mine} head={head} text={text} preview onClick={onOpen} /></div>
}

function TaskItemCard({ sessionId, mine, onOpen }: { sessionId: string; mine: boolean; onOpen: () => void }) {
  const { t } = useTranslation('messaging')
  const listed = listedSession(readCachedDevices(), useLiveDeviceSessions(), sessionId)
  const row = 'row' in listed ? listed.row : null
  const device = row ? readCachedDevices().find(entry => entry.device_id === row.deviceId) : undefined
  const text = !row ? t('messaging:resourceCard.unavailable')
    : rowOpens(row.session) ? t('messaging:resourceCard.taskItem')
      : t('messaging:resourceCard.taskOffline', { machine: device?.label ?? t('messaging:attachmentView.holderMachine') })
  return <div className="gg-resource-card-box"><MessageQuoteFrame mine={mine} head={row?.session.title ?? t('messaging:resourceCard.task')} text={text} preview onClick={onOpen} /></div>
}
