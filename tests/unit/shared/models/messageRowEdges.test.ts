import { describe, expect, it } from 'vitest'
import { mergeMessagesById, optimisticReplyFields, shallowEqualMessage } from '@gugu/core/shared/ui/messageListModels'
import { message } from '../../../support/testHarness'

describe('message row identity boundaries', () => {
  it('does not reuse a previous row from another chat with the same id', () => {
    const foreign = message({ chat_id: 'foreign', readers: ['foreign-reader'], delivery_status: 'read' })
    const fresh = message({ chat_id: 'target', readers: [], delivery_status: null })
    const [merged] = mergeMessagesById([foreign], [fresh], 'target')
    expect(merged).toBe(fresh)
    expect(merged.readers).toEqual([])
  })
})
