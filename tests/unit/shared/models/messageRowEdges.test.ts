import { describe, expect, it } from 'vitest'
import { mergeMessagesById, optimisticReplyFields, shallowEqualMessage } from '@gugu/core/shared/ui/messageListModels'
import { message } from '../../../support/testHarness'

describe('message row identity boundaries', () => {
  it('omits a retracted message body from the optimistic reply preview', () => {
    const target = message({ retracted_at: '2026-11-10T00:00:00Z', content: 'removed text' })
    expect(optimisticReplyFields([target], target.id).reply_to_content).toBeNull()
  })
  it('keeps one final row per id when a fresh page repeats it', () => {
    const first = message({ content: 'old' }), latest = message({ content: 'latest' })
    expect(mergeMessagesById([], [first, latest], first.chat_id)).toEqual([latest])
  })
  it('updates attachment identity and dimensions when the message body is unchanged', () => {
    const previous = message({ file_item_id: 'file', file_version: 1, image_dimensions: { width: 10, height: 10 } })
    const incoming = { ...previous, file_version: 2, image_dimensions: { width: 20, height: 10 } }
    expect(shallowEqualMessage(previous, incoming)).toBe(false)
    expect(mergeMessagesById([previous], [incoming], previous.chat_id)[0]).toMatchObject(incoming)
  })
  it('does not reuse a previous row from another chat with the same id', () => {
    const foreign = message({ chat_id: 'foreign', readers: ['foreign-reader'], delivery_status: 'read' })
    const fresh = message({ chat_id: 'target', readers: [], delivery_status: null })
    const [merged] = mergeMessagesById([foreign], [fresh], 'target')
    expect(merged).toBe(fresh)
    expect(merged.readers).toEqual([])
  })
})
