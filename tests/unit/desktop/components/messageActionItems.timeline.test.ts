import type { TFunction } from 'i18next'
import { expect, it, vi } from 'vitest'
import { messageActionItems, type MessageActionTarget } from '../../../../apps/desktop/src/components/chat/messageActionItems'

const t = ((key: string) => key) as unknown as TFunction<'messaging'>
const fn = vi.fn()
const timeline: MessageActionTarget = { isRetracted: false, content: 'x', onQuoteToComposer: fn, onCopy: fn, onForkTask: fn }
const keys = (input: MessageActionTarget) => messageActionItems(input, t).map(item => item.key)
const label = (input: MessageActionTarget, key: string) => messageActionItems(input, t).find(item => item.key === key)?.label

it('leads with what the clicked file or link can do', () => {
  expect(keys({ ...timeline, onOpenFile: fn, onDownload: fn })).toEqual(['openFile', 'download', 'quoteToComposer', 'copy', 'forkTask'])
  expect(keys({ ...timeline, onCopyLink: fn, onOpenLink: fn })).toEqual(['openLink', 'copyLink', 'quoteToComposer', 'copy', 'forkTask'])
})

it('says what a selection and a file card will copy or quote', () => {
  expect(label({ ...timeline, hasSelection: true }, 'copy')).toBe('message.actions.copySelection')
  expect(label({ ...timeline, hasSelection: true }, 'quoteToComposer')).toBe('message.actions.quoteSelectionToComposer')
  expect(label({ ...timeline, copiesFileName: true }, 'copy')).toBe('message.actions.copyFileName')
  expect(label(timeline, 'copy')).toBe('message.actions.copy')
})

it('leaves the chat menu in its own order and wording', () => {
  expect(label({ isRetracted: false, content: 'x', hasSelection: true, onCopy: fn }, 'copy')).toBe('message.actions.copy')
  expect(keys({ isRetracted: false, content: 'x', onCopy: fn, onCopyLink: fn, onOpenLink: fn, onDownload: fn })).toEqual(['copy', 'copyLink', 'openLink', 'download'])
})
