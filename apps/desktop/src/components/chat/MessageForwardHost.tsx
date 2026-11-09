import { useEffect, useState } from 'react'
import { excerpt } from '@gugu/core/shared/ui/forwardQuote'
import { markdownPlainText } from '../../lib/markdownPlainText'
import { LiveForwardMessageDialog } from './ForwardMessageDialog'
import { FORWARD_PIECES_OPEN, pieceSender, useForwardNames, useForwardToChats, type ForwardPiece } from './forwardToChats'

/** The forward page for a view outside the chat (the task timeline, desktop and phone): the chat's own page and forward. */
export function MessageForwardHost() {
  const [pieces, setPieces] = useState<ForwardPiece[] | null>(null)
  const forwardTo = useForwardToChats()
  const names = useForwardNames()
  useEffect(() => {
    const open = (event: Event) => setPieces((event as CustomEvent<ForwardPiece[]>).detail)
    window.addEventListener(FORWARD_PIECES_OPEN, open)
    return () => window.removeEventListener(FORWARD_PIECES_OPEN, open)
  }, [])
  if (!pieces?.length) return null
  const messages = pieces.flatMap(piece => piece.kind === 'message' ? [piece.message] : [])
  // The bubble that was pressed is the last piece; a prompt before it only says what it answers.
  const said = pieces[pieces.length - 1]!
  const preview = said.kind === 'text' ? `${pieceSender(said, names)}：${excerpt(markdownPlainText(said.text), 200)}` : undefined
  return (
    <LiveForwardMessageDialog
      messages={messages}
      preview={preview}
      sourceChatId={messages[0]?.chat_id ?? ''}
      onForward={(targetChatIds, note) => forwardTo(pieces, targetChatIds, note)}
      onClose={() => setPieces(null)}
    />
  )
}
