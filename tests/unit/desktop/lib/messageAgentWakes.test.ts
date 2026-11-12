import { beforeEach, expect, it, vi } from 'vitest'

const load = vi.hoisted(() => vi.fn<(ids: string[]) => Promise<Map<string, Set<string>>>>())
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/chatMessageRevalidation', () => ({ loadMessageAgentWakes: load }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: logError }) }))

const { forgetMessageAgentWakes, knownMessageAgentWakes, knownMessageAgentWakesKey, requestMessageAgentWakes, subscribeMessageAgentWakes } =
  await import('@/lib/messageAgentWakes')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  forgetMessageAgentWakes()
  load.mockReset()
  logError.mockReset()
})

it('reads each message once for every view of the account', async () => {
  load.mockImplementation(async (ids) => new Map(ids.map((id) => [id, new Set(['agent-a'])])))
  const heard = vi.fn()
  const stop = subscribeMessageAgentWakes(heard)
  requestMessageAgentWakes(['m1', 'm2'])
  requestMessageAgentWakes(['m1', 'm2', 'm3']) // m1, m2 are in flight: only m3 is asked
  await settle()
  requestMessageAgentWakes(['m1', 'm3'])
  expect(load.mock.calls).toEqual([[['m1', 'm2']], [['m3']]])
  expect(knownMessageAgentWakesKey(['m3', 'm1', 'x'])).toBe('m3,m1')
  expect([...knownMessageAgentWakes('m2')!]).toEqual(['agent-a'])
  expect(heard).toHaveBeenCalled()
  stop()
})

it('logs a failed read and does not ask again in a loop', async () => {
  load.mockRejectedValue(new Error('Message recipients are unavailable: offline'))
  requestMessageAgentWakes(['m1'])
  await settle()
  requestMessageAgentWakes(['m1'])
  await settle()
  expect(load).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledOnce()
  expect(knownMessageAgentWakesKey(['m1'])).toBe('')
})

it('an account switch forgets everything, and an answer for the previous account is dropped', async () => {
  let answer!: (wakes: Map<string, Set<string>>) => void
  load.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  requestMessageAgentWakes(['old'])
  forgetMessageAgentWakes()
  answer(new Map([['old', new Set(['agent-a'])]]))
  await settle()
  expect(knownMessageAgentWakesKey(['old'])).toBe('')

  load.mockRejectedValueOnce(new Error('down'))
  requestMessageAgentWakes(['failed'])
  await settle()
  forgetMessageAgentWakes()
  load.mockResolvedValueOnce(new Map([['failed', new Set<string>()]]))
  requestMessageAgentWakes(['failed']) // the next account may read what the previous one could not
  await settle()
  expect(knownMessageAgentWakesKey(['failed'])).toBe('failed')
})
