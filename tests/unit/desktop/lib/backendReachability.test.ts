import { afterEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  syncSince: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: db.rpc },
  dataClient: { schema: () => ({ rpc: () => ({ abortSignal: () => db.syncSince() }) }) },
}))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { bindBackendProbe, noteBackendAnswer, subscribeBackendRecovered } from '../../../../apps/desktop/src/lib/backendReachability'
import { createSupabaseAccountRevisionSource } from '../../../../apps/desktop/src/lib/supabaseAccountRevisionSource'
import { chatSeq, writeRead } from '../../../../apps/desktop/src/lib/readWriter'

const unbinds: Array<() => void> = []
afterEach(() => { for (const unbind of unbinds.splice(0)) unbind(); db.rpc.mockReset(); db.syncSince.mockReset() })

describe('backend recovered = the sync pull failed, then answered', () => {
  it('fires once on the failed → answered edge, never while the backend keeps answering', () => {
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    noteBackendAnswer(true)
    expect(recovered).not.toHaveBeenCalled()
    noteBackendAnswer(false)
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    noteBackendAnswer(true)
    expect(recovered).toHaveBeenCalledOnce()
  })

  it('reads the edge from sync_since itself: a rejected or refused pull is a failure, an aborted one is no reading', async () => {
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    const source = createSupabaseAccountRevisionSource()
    const live = new AbortController().signal
    db.syncSince.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(source.syncSince('5', 100, live)).rejects.toThrow('Failed to fetch')
    const aborted = new AbortController(); aborted.abort()
    db.syncSince.mockResolvedValueOnce({ data: { operations: [], has_more: false }, error: null })
    await source.syncSince('5', 100, aborted.signal).catch(() => undefined)
    expect(recovered).not.toHaveBeenCalled()
    db.syncSince.mockResolvedValueOnce({ data: { operations: [], has_more: false }, error: null })
    await source.syncSince('5', 100, live).catch(() => undefined)
    expect(recovered).toHaveBeenCalledOnce()
  })

  it('a new account starts from "answering": the last account\'s outage does not fire for it', () => {
    const unbind = bindBackendProbe(() => {})
    noteBackendAnswer(false)
    unbind()
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    noteBackendAnswer(true)
    expect(recovered).not.toHaveBeenCalled()
  })
})

describe('a cloud read that could not be written goes out again when the backend recovers', () => {
  it('keeps the highest read per stream, asks the beat to pull, and writes it once on recovery', async () => {
    const pull = vi.fn()
    unbinds.push(bindBackendProbe(pull))
    db.rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } })
    await expect(writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(7) })).rejects.toThrow('Failed to fetch')
    await expect(writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(9) })).rejects.toThrow('Failed to fetch')
    await expect(writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(8) })).rejects.toThrow('Failed to fetch')
    expect(pull).toHaveBeenCalledTimes(3)
    db.rpc.mockReset()
    db.rpc.mockResolvedValue({ data: [{ stream_id: 'main:c' }], error: null })
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await vi.waitFor(() => expect(db.rpc).toHaveBeenCalledOnce())
    expect(db.rpc).toHaveBeenCalledWith('mark_stream_read', expect.objectContaining({ p_chat_id: 'c', p_seq: 9 }))
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await Promise.resolve()
    expect(db.rpc).toHaveBeenCalledOnce()
  })
})
