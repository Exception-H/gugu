import type { MessageItem } from '@gugu/core/shared/types/chat'
import { forwardQuote, type ForwardQuoteItem } from '@gugu/core/shared/ui/forwardQuote'
import { useCallback, useMemo } from 'react'
import { useAuth } from '../../store/auth'
import { useChatStore, type ChatContextValue } from '../../store/chatContext'

/**
 * What a forward carries, in reading order: chat messages, and words that have no chat message behind them
 * (a task's prompt and its agent's answer), under the name they were shown with; `sender: null` is the forwarder. A message's
 * `sender` names a speaker its row does not carry (what an agent sent, seen from its task). `senderId` is who said delivered
 * words: their name as this account knows it wins over the label the delivery wrote.
 */
export type ForwardPiece =
  | { kind: 'message'; message: MessageItem; sender?: string }
  | { kind: 'text'; sender: string | null; text: string; senderId?: string | null }

/** Opens the app's forward page from a view outside the chat (the task timeline); MessageForwardHost draws it. */
export const FORWARD_PIECES_OPEN = 'gugu:forward-pieces-open'

export function openForward(pieces: ForwardPiece[]): void {
  window.dispatchEvent(new CustomEvent<ForwardPiece[]>(FORWARD_PIECES_OPEN, { detail: pieces }))
}

type Send = Pick<ChatContextValue, 'forwardMessage' | 'sendMessageToChat'>
type Names = {
  /** Who a chat member is, by name; `null` = the forwarder. */
  nameOf: (userId: string | null) => string
  /** A name this account knows for a user, if any. */
  knownName: (userId: string) => string | undefined
}

/** Who said a plain-text piece, by name. */
export function pieceSender(piece: Extract<ForwardPiece, { kind: 'text' }>, names: Names): string {
  return (piece.senderId ? names.knownName(piece.senderId) : undefined) ?? piece.sender ?? names.nameOf(null)
}

/**
 * One forward into each picked chat. Words (text messages and plain text) go as one message: the note, then each piece
 * quoted under who said it. Files, widgets and cards go as themselves, after it; with nothing to quote, the note follows them.
 */
export async function forwardToChats(pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: string, io: Send & Names): Promise<void> {
  const quoted: ForwardQuoteItem[] = []
  let source: MessageItem | undefined
  const own: MessageItem[] = []
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      if (piece.text.trim()) quoted.push({ sender: pieceSender(piece, io), text: piece.text })
      continue
    }
    const { message } = piece
    if (message.content_type !== 'text') { own.push(message); continue }
    if (message.retracted_at || !message.content?.trim()) continue
    source ??= message
    quoted.push({
      sender: piece.sender ?? io.nameOf(message.sender_user_id),
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
  const { forwardMessage, sendMessageToChat } = useChatStore('forwardMessage', 'sendMessageToChat')
  const names = useForwardNames()
  return useCallback((pieces: readonly ForwardPiece[], targetChatIds: readonly string[], note: string) =>
    forwardToChats(pieces, targetChatIds, note, { forwardMessage, sendMessageToChat, ...names }), [forwardMessage, sendMessageToChat, names])
}

/** Names as this account's chat store knows them. */
export function useForwardNames(): Names {
  const { identitiesById } = useChatStore('identitiesById')
  const { user } = useAuth()
  return useMemo(() => ({
    knownName: (userId: string) => identitiesById[userId]?.display_name || undefined,
    nameOf: (userId: string | null) => {
      const id = userId ?? user?.id
      const name = id ? identitiesById[id]?.display_name : undefined
      if (!name) throw new Error(`No name is known for ${id ?? 'the signed-out forwarder'}`)
      return name
    },
  }), [identitiesById, user])
}
