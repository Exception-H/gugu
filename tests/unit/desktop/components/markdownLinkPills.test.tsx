// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink, groupFileLink } from '@gugu/core/shared/ui/guguLink'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const ME = '11111111-1111-4111-8111-111111111111'
const ALICE = '22222222-2222-4222-8222-222222222222'
const CHAT = '33333333-3333-4333-8333-333333333333'
const MESSAGE = '44444444-4444-4444-8444-444444444444'
const DOC = '55555555-5555-4555-8555-555555555555'
const GONE = '77777777-7777-4777-8777-777777777777'
const TOPIC = '88888888-8888-4888-8888-888888888888'
const SOURCE = '99999999-9999-4999-8999-999999999999'

const mocks = vi.hoisted(() => ({ fileMetadata: vi.fn(), getMessageById: vi.fn(), chatFacts: vi.fn(), listTopicsOfChat: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('@/components/appSlot/phoneAppHost', () => ({ openPhoneLink: vi.fn(async () => ({ kind: 'opened' })) }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ fileMetadata: mocks.fileMetadata }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.getMessageById } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: mocks.chatFacts } }))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({ topicService: { listTopicsOfChat: mocks.listTopicsOfChat } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Markdown loads the pill on first use; load it once here so a busy run does not spend a case's wait on compiling it.
beforeAll(async () => { await import('../../../../apps/desktop/src/components/markdown/LinkPill') }, 120000)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  attachmentQueryClient.clear()
  vi.clearAllMocks()
})

async function render(content: string, trust: 'chat' | 'document' = 'chat') {
  const store = { chats: [{ id: CHAT, name: 'Design review', kind: 'group' }], identitiesById: { [ALICE]: { id: ALICE, display_name: 'Alice' } } }
  await act(async () => {
    root.render(createElement(AuthContext.Provider, { value: { user: { id: ME } } as never },
      createElement(ChatStoreProvider, { value: store as never }, createElement(Markdown, { trust, content }))))
  })
}
// Pills load lazily and then read: wait for both.
const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.dynamicImportSettled() }); check() }, { timeout: 10000 })
const pills = () => [...container.querySelectorAll<HTMLAnchorElement>('a.gg-md-mention')]

describe('chat link pills, drawn in place', () => {
  it('draws a file link as the file pill with the file name, in the sentence', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', version: 2, file_name: 'plan.pdf', content_type: 'application/pdf', size_bytes: 2048 } })
    await render(`see [the spec](${groupFileLink(DOC, { version: 2 })}) before Friday`)
    await settle(() => expect(pills()[0]?.textContent).toBe('plan.pdf'))
    expect(mocks.fileMetadata).toHaveBeenCalledWith(DOC, 2)
    expect(pills()[0]?.dataset.mentionKind).toBe('file')
    expect(container.querySelector('p')?.textContent).toBe('see plan.pdf before Friday')
  })

  it('draws a chat or topic link as # its name', async () => {
    mocks.chatFacts.mockResolvedValue({ data: [{ kind: 'topic', source_chat_id: SOURCE }], error: null })
    mocks.listTopicsOfChat.mockResolvedValue([{ chat_id: TOPIC, name: 'Launch' }])
    await render(`in [here](${conversationLink(CHAT)}) and [there](${conversationLink(TOPIC)})`)
    await settle(() => expect(pills().map(pill => pill.textContent)).toEqual(['# Design review', '# Launch']))
    // A listed chat is named from the list; a topic the window does not list is read through its source.
    expect(mocks.chatFacts).toHaveBeenCalledWith('chat_facts', { p_chat_id: TOPIC, p_as_user_id: ME })
    expect(mocks.listTopicsOfChat).toHaveBeenCalledWith(SOURCE, TOPIC)
  })

  it('draws a message link as sender：its first words, showing the link\'s words until the read answers', async () => {
    let answer!: (row: unknown) => void
    mocks.getMessageById.mockReturnValue(new Promise(resolve => { answer = resolve }))
    await render(`as agreed in [the decision](${conversationLink(CHAT, MESSAGE)})`)
    await settle(() => expect(mocks.getMessageById).toHaveBeenCalledWith(MESSAGE, ME))
    expect(pills()[0]?.textContent).toBe('the decision')
    expect(pills()[0]?.dataset.unavailable).toBeUndefined()
    await act(async () => answer({ id: MESSAGE, chat_id: CHAT, sender_user_id: ALICE, content: 'Ship the blue header today, keep the old footer', retracted_at: null }))
    await settle(() => expect(pills()[0]?.textContent).toBe('Alice：Ship the blue header tod…'))
  })

  it('greys a link whose read cannot show it, keeping its words', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'gone', sha256: null })
    mocks.getMessageById.mockResolvedValue(null)
    mocks.chatFacts.mockResolvedValue({ data: [], error: null })
    await render(`[old notes](${groupFileLink(GONE)}) [elsewhere](${conversationLink(CHAT, MESSAGE)}) [a topic](${conversationLink(TOPIC)})`)
    await settle(() => expect(pills().map(pill => pill.dataset.unavailable)).toEqual(['true', 'true', 'true']))
    expect(pills().map(pill => pill.textContent)).toEqual(['old notes', 'elsewhere', 'a topic'])
    expect(pills()[0]?.title).toBe('文件已删除')
    expect(pills()[1]?.title).toBe('不可用：已删除，或你无权查看')
  })

  it('leaves web links, task links and document Markdown as links', async () => {
    await render('[site](https://example.com) [step](gugu-session://S1?message=turn%3A2)')
    expect(pills()).toHaveLength(0)
    await render(`[the spec](${groupFileLink(DOC)})`, 'document')
    expect(pills()).toHaveLength(0)
    expect(mocks.fileMetadata).not.toHaveBeenCalled()
  })
})
