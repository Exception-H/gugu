import { describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { forwardToChats } from '../../../../apps/desktop/src/components/chat/forwardToChats'

function message(overrides: Partial<MessageItem>): MessageItem {
  return { id: 'm', chat_id: 'src', sender_user_id: 'u-han', to_user_ids: null, seq: 1, content: 'hi', content_type: 'text',
    reply_to_message_id: null, retracted_at: null, created_at: '2026-11-09T00:00:00Z', reactions: [], ...overrides } as MessageItem
}
const names: Record<string, string> = { 'u-han': 'Han', 'u-mei': 'Mei', me: 'Me' }
function io() {
  return { forwardMessage: vi.fn(async () => {}), sendMessageToChat: vi.fn(async () => undefined), nameOf: (id: string | null) => names[id ?? 'me']! }
}

describe('forwardToChats', () => {
  it('sends picked words as one quoted message linked to the first source, into each chat', async () => {
    const send = io()
    await forwardToChats([
      { kind: 'message', message: message({ id: 'a', content: 'Friday?', sender_user_id: 'u-mei' }) },
      { kind: 'message', message: message({ id: 'b', content: 'Agreed.', reply_to_message_id: 'a', reply_to_content: 'Friday?', reply_to_sender_user_id: 'u-mei' }) },
    ], ['g1', 'g2'], 'for you', send)
    expect(send.forwardMessage).toHaveBeenCalledTimes(2)
    const [forwarded, chat] = send.forwardMessage.mock.calls[0] as unknown as [MessageItem, string]
    expect(chat).toBe('g1')
    expect(forwarded.id).toBe('a')
    expect(forwarded.reply_to_message_id).toBeNull()
    expect(forwarded.content).toBe('for you\n\n> **Mei**\n>\n> Friday?\n\n> **Han**\n>\n> > **Mei**：Friday?\n>\n> Agreed.')
    expect(send.sendMessageToChat).not.toHaveBeenCalled()
  })

  it('sends words with no chat message behind them as a new message', async () => {
    const send = io()
    await forwardToChats([{ kind: 'text', sender: null, text: 'Why?' }, { kind: 'text', sender: 'u-han', text: 'Because.' }], ['g1'], '', send)
    expect(send.forwardMessage).not.toHaveBeenCalled()
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', '> **Me**\n>\n> Why?\n\n> **Han**\n>\n> Because.')
  })

  it('forwards a file as itself, with the note after it', async () => {
    const send = io()
    const file = message({ id: 'f', content_type: 'attachment', content: '[file]' })
    await forwardToChats([{ kind: 'message', message: file }], ['g1'], ' look ', send)
    expect(send.forwardMessage).toHaveBeenCalledWith(file, 'g1')
    expect(send.sendMessageToChat).toHaveBeenCalledWith('g1', 'look')
  })

  it('leaves a retracted message out', async () => {
    const send = io()
    await forwardToChats([{ kind: 'message', message: message({ retracted_at: '2026-11-09T00:00:00Z' }) }], ['g1'], '', send)
    expect(send.forwardMessage).not.toHaveBeenCalled()
    expect(send.sendMessageToChat).not.toHaveBeenCalled()
  })
})
