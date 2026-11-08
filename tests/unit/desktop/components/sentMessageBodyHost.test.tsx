// @vitest-environment jsdom
import { act, useContext } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'
import { SentMessageSurface, widgetTabId } from '../../../../apps/desktop/src/components/chat/sentMessageSurface'
import { offerSentMessageSlot } from '../../../../apps/desktop/src/components/chat/sentMessageSlots'
import { SentMessageBodyHost } from '../../../../apps/desktop/src/components/chat/SentMessageBodyHost'

const open = vi.hoisted(() => ({ file: vi.fn() }))
vi.mock('@/components/chat/MessageBody', () => ({
  MessageBody: function Body({ message, onOpenWorkspaceFile }: { message: MessageItem; onOpenWorkspaceFile: (link: unknown) => void }) {
    const slot = useContext(SentMessageSurface)
    open.file = onOpenWorkspaceFile as typeof open.file
    return <p data-tab={widgetTabId(message.id, slot)}>{message.content}</p>
  },
}))

const message = { id: 'msg', chat_id: 'chat', content: 'said', content_type: 'text' } as MessageItem
const root = () => document.body.appendChild(document.createElement('div'))
let harness: ReturnType<typeof createReactHarness>
let observed: (() => void)[]
let rect: { width: number; height: number }
beforeEach(() => {
  observed = []; rect = { width: 120, height: 40 }
  vi.stubGlobal('ResizeObserver', class { constructor(private report: () => void) {} observe() { observed.push(this.report) } disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect)
})
afterEach(() => { harness?.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren() })
const slotOf = (element: HTMLElement, onSize = vi.fn(), commands = {}) => ({ root: element, message, commands: () => commands, onSize })

it('draws one message offered twice in both slots, each its own widget tab, and takes back only the slot that left', async () => {
  const errors = vi.spyOn(console, 'error')
  harness = createReactHarness(); await harness.render(<SentMessageBodyHost />)
  const first = root(), second = root()
  let takeFirst!: () => void, takeSecond!: () => void
  await act(async () => { takeFirst = offerSentMessageSlot(slotOf(first)); takeSecond = offerSentMessageSlot(slotOf(second)) })
  const tab = (element: HTMLElement) => element.querySelector('p')?.getAttribute('data-tab')
  expect(first.textContent).toBe('said'); expect(second.textContent).toBe('said')
  expect(tab(first)).not.toBe(tab(second))
  expect(tab(first)).not.toBe(widgetTabId('msg', null))
  expect(errors).not.toHaveBeenCalled()
  await act(async () => takeFirst())
  expect(first.textContent).toBe(''); expect(second.textContent).toBe('said')
  await act(async () => takeSecond())
  expect(second.textContent).toBe('')
})

it('reports the drawn size, and keeps the last one when a hidden page lays it out at 0×0', async () => {
  harness = createReactHarness(); await harness.render(<SentMessageBodyHost />)
  const onSize = vi.fn(), element = root()
  let take!: () => void
  await act(async () => { take = offerSentMessageSlot(slotOf(element, onSize)) })
  expect(onSize).toHaveBeenLastCalledWith({ width: 120, height: 40 })
  rect = { width: 0, height: 0 }; onSize.mockClear()
  observed.at(-1)!()
  expect(onSize).not.toHaveBeenCalled()
  rect = { width: 90.2, height: 60.1 }
  observed.at(-1)!()
  expect(onSize).toHaveBeenLastCalledWith({ width: 91, height: 61 })
  await act(async () => take())
})

it('opens a working-folder link in the task, the way the timeline opens it', async () => {
  harness = createReactHarness(); await harness.render(<SentMessageBodyHost />)
  const onOpenFile = vi.fn()
  let take!: () => void
  await act(async () => { take = offerSentMessageSlot(slotOf(root(), vi.fn(), { onOpenFile })) })
  open.file({ kind: 'workspace-file', path: 'src/a.ts' })
  expect(onOpenFile).toHaveBeenCalledWith({ path: 'src/a.ts', itemId: 'msg', source: 'prose-link' })
  await act(async () => take())
})
