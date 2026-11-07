// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink, groupFileLink, guguLink } from '@gugu/core/shared/ui/guguLink'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const ME = '11111111-1111-4111-8111-111111111111'
const ALICE = '22222222-2222-4222-8222-222222222222'
const CHAT = '33333333-3333-4333-8333-333333333333'
const MESSAGE = '44444444-4444-4444-8444-444444444444'
const DOC = '55555555-5555-4555-8555-555555555555'
const PHOTO = '66666666-6666-4666-8666-666666666666'
const GONE = '77777777-7777-4777-8777-777777777777'

const mocks = vi.hoisted(() => ({
  fileMetadata: vi.fn(),
  getMessageById: vi.fn(),
  listedSession: vi.fn(),
  rowOpens: vi.fn(() => true),
}))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('@/components/appSlot/phoneAppHost', () => ({ openPhoneLink: vi.fn(async () => ({ kind: 'opened' })) }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ fileMetadata: mocks.fileMetadata }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: mocks.getMessageById } }))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({
  useAttachmentObjectUrl: () => ({ status: 'ready', objectUrl: 'blob:thumb', retry: () => undefined }),
}))
vi.mock('../../../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => [{ device_id: 'mac', label: 'Studio' }] }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async (importOriginal) => ({
  ...await importOriginal<object>(), listedSession: mocks.listedSession, rowOpens: mocks.rowOpens, useLiveDeviceSessions: () => ({}),
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  disconnect() {}
}

// Markdown loads the card on first use; load it once here so a busy run does not spend a case's wait on compiling it.
beforeAll(async () => { await import('../../../../apps/desktop/src/components/markdown/ResourceCard') }, 120000)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NearObserver)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  attachmentQueryClient.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function render(content: string) {
  const store = { chats: [{ id: CHAT, name: 'Design review' }], identitiesById: { [ALICE]: { id: ALICE, display_name: 'Alice' } } }
  await act(async () => {
    root.render(createElement(AuthContext.Provider, { value: { user: { id: ME } } as never },
      createElement(ChatStoreProvider, { value: store as never }, createElement(Markdown, { trust: 'chat', content }))))
  })
}
// Cards load lazily (Markdown imports them on first use) and read once near the viewport: wait for both.
const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.dynamicImportSettled() }); check() }, { timeout: 10000 })

const cards = () => container.querySelector('.gg-resource-cards')

describe('link cards in a chat bubble', () => {
  it('draws a folder file as its name, size and type, keeping the link in the text', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', version: 2, file_name: 'plan.pdf', content_type: 'application/pdf', size_bytes: 2048 } })
    await render(`see ${groupFileLink(DOC, { version: 2 })}`)
    await settle(() => expect(cards()?.textContent).toContain('plan.pdf'))
    expect(mocks.fileMetadata).toHaveBeenCalledWith(DOC, 2)
    expect(container.querySelector('p')?.textContent).toContain(`gugu-file://${DOC}?v=2`)
    expect(cards()?.textContent).toContain('2.0 KB')
    expect(cards()?.textContent).toContain('PDF')
  })

  it('draws an image file with its thumbnail', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', version: 1, file_name: 'shot.png', content_type: 'image/png', size_bytes: 10, width: 4, height: 3 } })
    await render(`[shot](${groupFileLink(PHOTO)})`)
    await settle(() => expect(cards()?.querySelector('img')).not.toBeNull())
    expect(cards()?.querySelector<HTMLImageElement>('img.gg-resource-card-thumb')?.src).toBe('blob:thumb')
    expect(cards()?.textContent).toContain('shot.png')
  })

  it('draws one message as its sender and opening lines', async () => {
    mocks.getMessageById.mockResolvedValue({ id: MESSAGE, chat_id: CHAT, sender_user_id: ALICE, content: 'Ship the blue header today', retracted_at: null })
    await render(`as agreed: [the decision](${conversationLink(CHAT, MESSAGE)})`)
    await settle(() => expect(cards()?.textContent).toContain('Alice'))
    expect(mocks.getMessageById).toHaveBeenCalledWith(MESSAGE, ME)
    expect(cards()?.textContent).toContain('Ship the blue header today')
  })

  it('draws a task item as its task title', async () => {
    mocks.listedSession.mockReturnValue({ row: { deviceId: 'mac', session: { conversationId: 'S1', title: 'Fix login' } } })
    await render(`from [the plan](${guguLink({ kind: 'session', sessionId: 'S1', itemId: 'turn:2' })})`)
    await settle(() => expect(cards()?.textContent).toContain('Fix login'))
  })

  it('says unavailable when the reader cannot read the target, instead of falling back to a bare link', async () => {
    mocks.fileMetadata.mockResolvedValue({ status: 'gone', sha256: null })
    mocks.getMessageById.mockResolvedValue(null)
    mocks.listedSession.mockReturnValue({ unread: [] })
    mocks.rowOpens.mockReturnValue(false)
    await render([groupFileLink(GONE), conversationLink(CHAT, MESSAGE), conversationLink('88888888-8888-4888-8888-888888888888', MESSAGE),
      guguLink({ kind: 'session', sessionId: 'S9', itemId: 'x' })].map((uri, index) => `[ref ${index}](${uri})`).join(' '))
    await settle(() => expect(container.querySelector('.gg-resource-card-box')?.textContent).toContain('文件已删除'))
    await settle(() => expect(container.querySelectorAll('.gg-resource-card-box')[1]?.textContent).toContain('不可用：已删除，或你无权查看'))
    await settle(() => expect(container.querySelectorAll('.gg-resource-card-box')).toHaveLength(4))
    const boxes = [...container.querySelectorAll('.gg-resource-card-box')].map(node => node.textContent ?? '')
    expect(boxes).toHaveLength(4)
    expect(boxes[0]).toContain('文件已删除')
    for (const text of boxes.slice(1)) expect(text).toContain('不可用：已删除，或你无权查看')
    // A chat this reader is not in is never read.
    expect(mocks.getMessageById).toHaveBeenCalledTimes(1)
  })

  it('leaves bare chats, @ file pills and non-chat documents without cards', async () => {
    await render(`[the chat](${conversationLink(CHAT)}) @[deck](${groupFileLink(DOC)})`)
    expect(cards()).toBeNull()
    await act(async () => root.render(createElement(Markdown, { trust: 'document', content: groupFileLink(DOC) })))
    expect(cards()).toBeNull()
  })
})
