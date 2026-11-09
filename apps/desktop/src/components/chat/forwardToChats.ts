import type { MessageItem } from '@gugu/core/shared/types/chat'
import { forwardQuote, type ForwardQuoteItem } from '@gugu/core/shared/ui/forwardQuote'
import { useCallback } from 'react'
import { useAuth } from '../../store/auth'
import { useChatStore, type ChatContextValue } from '../../store/chatContext'

/**
 * What a forward carries, in reading order: chat messages, and words that have no chat message behind them
 * (a task's prompt and its agent's answer). `sender: null` is the forwarder.
 */
export type ForwardPiece =
  | { kind: 'message'; message: MessageItem }
  | { kind: 'text'; sender: string | null; text: string }

type Send = Pick<ChatContextValue, 'forwardMessage' | 'sendMessageToChat'>

/**
 * One forward into each picked chat. Words (text messages and plain text) go as one message: the note, then each piece
 * quoted under who said it. Files, widgets and cards go as themselves, after it; with nothing to quote, the note follows them.
 */
export async function forwardToChats(pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: string, io: Send & {
  /** Who a chat member is, by name; `null` = the forwarder. */
  nameOf: (userId: string | null) => string
}): Promise<void> {
  const quoted: ForwardQuoteItem[] = []
  let source: MessageItem | undefined
  const own: MessageItem[] = []
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      if (piece.text.trim()) quoted.push({ sender: io.nameOf(piece.sender), text: piece.text })
      continue
    }
    const message = piece.message
    if (message.content_type !== 'text') { own.push(message); continue }
    if (message.retracted_at || !message.content?.trim()) continue
    source ??= message
    quoted.push({
      sender: io.nameOf(message.sender_user_id),
      text: message.content,
      replyTo: message.reply_to_content ? { sender: io.nameOf(message.reply_to_sender_user_id ?? null), text: message.reply_to_content } : null,
    })
  }
  const body = quoted.length ? forwardQuote(quoted, note) : null
  for (const chatId of targetChatIds) {
    if (body !== null) {
      // A chat message among the words keeps the link to where they came from (read rights, the forwarded badge).
      if (source) await io.forwardMessage({ ...source, content: body, reply_to_message_id: null, reply_to_content: null, reply_to_sender_user_id: null }, chatId)
      else await io.sendMessageToChat(chatId, body)
    }
    for (const message of own) await io.forwardMessage(message, chatId)
    if (body === null && note.trim()) await io.sendMessageToChat(chatId, note.trim())
  }
}

/** `forwardToChats` with this account's chat store: senders named as the chat names them. */
export function useForwardToChats() {
  const { forwardMessage, sendMessageToChat, identitiesById } = useChatStore('forwardMessage', 'sendMessageToChat', 'identitiesById')
  const { user } = useAuth()
  return useCallback((pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: string) => {
    if (!user) throw new Error('Forwarding needs a signed-in account')
    const nameOf = (userId: string | null) => {
      const name = identitiesById[userId ?? user.id]?.display_name
      if (!name) throw new Error(`No name is known for ${userId ?? user.id}`)
      return name
    }
    return forwardToChats(pieces, targetChatIds, note, { forwardMessage, sendMessageToChat, nameOf })
  }, [forwardMessage, sendMessageToChat, identitiesById, user])
}
