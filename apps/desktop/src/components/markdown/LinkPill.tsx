import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { attachmentQuery, attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { fileMetadata } from '../../lib/fileAccess'
import { chatService } from '../../lib/chat'
import { chatDb } from '../../lib/supabase'
import { topicService } from '../../lib/topics'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { quotedContentView } from '../chat/quotedContent'
import { quoteSummary } from '../chat/quoteSummary'
import { GroupFileName } from './GroupFileName'
import { MentionPill } from './MentionPill'
import { linkPillTarget } from './linkPills'

// Reads are key-only (attachmentQueryClient): file metadata, a message, and a chat the window does not list yet.
const fileQuery = attachmentQuery('link-pill-file', (_accountId: string | undefined, itemId: string, version: number | null) =>
  fileMetadata(itemId, version ?? undefined))
const messageQuery = attachmentQuery('link-pill-message', (accountId: string, messageId: string) => chatService.getMessageById(messageId, accountId))
/** A topic this window does not list (a source member watching it): its facts name the source, the source lists it. */
const unlistedTopicQuery = attachmentQuery('link-pill-topic', async (accountId: string, chatId: string) => {
  const { data, error } = await chatDb.rpc('chat_facts', { p_chat_id: chatId, p_as_user_id: accountId })
  if (error) throw new Error(error.message)
  const facts = (Array.isArray(data) ? data[0] : data) as { kind?: string; source_chat_id?: string | null } | undefined
  if (facts?.kind !== 'topic' || !facts.source_chat_id) return null
  return (await topicService.listTopicsOfChat(facts.source_chat_id, chatId))[0]?.name ?? null
})

type DrawProps = { href: string; onClick: (event: MouseEvent) => void; children: ReactNode; rest?: Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'title' | 'onClick' | 'children' | 'className'> }

/**
 * A chat link drawn in place as the file mention chip: a file by its name, a chat or topic as `# name`, a message as
 * `sender：its first words`, each read as the person reading. Until the read answers it shows the link's own words;
 * a target that read cannot show is greyed, with the reason on hover.
 */
export function LinkPill(props: DrawProps) {
  const target = linkPillTarget(props.href)
  if (target?.kind === 'file') return <FilePill {...props} itemId={target.itemId} version={target.version} />
  if (target?.kind === 'chat') return <ChatPill {...props} chatId={target.chatId} messageId={target.messageId} />
  return <>{props.children}</>
}

function FilePill({ href, onClick, children, rest, itemId, version }: DrawProps & { itemId: string; version?: number }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const read = useQuery({ ...fileQuery(user?.id, itemId, version ?? null), enabled: !!user }, attachmentQueryClient)
  const ready = read.data?.status === 'ready' ? read.data.revision : null
  const offline = ready?.source === 'local' && ready.host_online === false
  const reason = read.isError ? t('attachmentView.fileUnavailable')
    : read.data && read.data.status !== 'ready' ? t(read.data.status === 'gone' ? 'attachmentView.fileGone' : read.data.status === 'expired' ? 'attachmentView.fileExpired' : 'attachmentView.fileMissing')
      : offline ? t('attachmentView.holderOffline', { machine: ready.host_label ?? t('attachmentView.holderMachine') }) : null
  // Named the way the file list names it (GroupFileName, 摩擦单 F39): the file's own name once read, the link's words before.
  const words = typeof children === 'string' ? children : Array.isArray(children) && children.every(part => typeof part === 'string') ? children.join('') : null
  const name = ready?.file_name ?? words
  const label = name !== null ? <GroupFileName name={name} /> : children
  return <MentionPill href={href} file title={reason ?? (ready?.file_name ?? '')} unavailable={reason !== null} onClick={onClick} rest={rest}>{label}</MentionPill>
}

function ChatPill({ href, onClick, children, rest, chatId, messageId }: DrawProps & { chatId: string; messageId?: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const listed = chats.find(row => row.id === chatId)
  const message = useQuery({ ...messageQuery(user?.id ?? '', messageId ?? ''), enabled: !!user && !!messageId }, attachmentQueryClient)
  const topic = useQuery({ ...unlistedTopicQuery(user?.id ?? '', chatId), enabled: !!user && !messageId && !listed }, attachmentQueryClient)
  let label: ReactNode = children
  let unavailable = false
  if (messageId) {
    // The same checks as opening the link (useLinkNavigation): a live message in that chat.
    const row = message.data && message.data.chat_id === chatId && !message.data.retracted_at ? message.data : null
    unavailable = message.isError || (message.isSuccess && !row)
    if (row) {
      const sender = row.sender_user_id ? identitiesById[row.sender_user_id]?.display_name : undefined
      const words = quoteSummary(quotedContentView(widgetMessagePreview(row.content) ?? row.content).text)
      label = sender ? `${sender}：${words}` : words
    }
  } else if (listed) label = listed.kind === 'group' || listed.kind === 'topic' ? `# ${listed.name}` : listed.name // a group or topic reads as a channel; a direct chat as its name
  else {
    unavailable = topic.isError || (topic.isSuccess && !topic.data)
    if (topic.data) label = `# ${topic.data}`
  }
  return <MentionPill href={href} title={unavailable ? t('linkPill.unavailable') : typeof label === 'string' ? label : ''} unavailable={unavailable} onClick={onClick} rest={rest}>{label}</MentionPill>
}
