// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { TranscriptTurn } from '@session-chat/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_TASKS_POLL_MS,
  usePhoneBackgroundTasks,
} from '../../../../apps/desktop/src/mobile/agent-watch/background-tasks'
import { createReactHarness } from '../../../support/testHarness'

/**
 * 这一问(#6382)是为「页面在后台」省的:那段时间没人看着,名单照旧,不必再问机器。
 * 从前它挂载时**无条件**先打一轮,页面完全不可见也照发 —— 跟自己的目标相反。
 * 这里钉两件事:不可见时一轮都不发(挂载那一刻 + 之后的每一轮轮询);可见时照旧(挂载一发、每 5 秒一发),
 * 从后台回来要立刻补一发,❌ 让人盯着旧名单等下一个 5 秒。
 */
const turn: TranscriptTurn = {
  id: 'live',
  seq: 0,
  initiator: 'user',
  startedAt: Date.now(),
  items: [{
    kind: 'spawn-subagent-tool-call', id: 'launch', seq: 0, toolCallId: 'launch',
    title: 'Audit chat perf', name: 'Audit chat perf', status: 'done',
    background: true, agentStatus: 'running', children: [],
  }],
} as unknown as TranscriptTurn

let harness: ReturnType<typeof createReactHarness>
let reported: 'visible' | 'hidden' = 'visible'

function setVisibility(next: 'visible' | 'hidden', notify = true) {
  reported = next
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => reported })
  if (notify) document.dispatchEvent(new Event('visibilitychange'))
}

function Probe({ fetchRunning }: { fetchRunning: (deviceId: string, sessionId: string) => Promise<{ runningCommandTaskIds: string[] | null }> }) {
  usePhoneBackgroundTasks('device-1', 'session-1', [turn], 0, true, fetchRunning)
  return createElement('div', {}, 'probe')
}

async function mount(fetchRunning: (deviceId: string, sessionId: string) => Promise<{ runningCommandTaskIds: string[] | null }>) {
  await harness.render(createElement(Probe, { fetchRunning }))
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  harness = createReactHarness()
  setVisibility('visible', false)
})

afterEach(() => {
  harness.cleanup()
  delete (document as unknown as Record<string, unknown>).visibilityState
  vi.useRealTimers()
})

describe('the background roster poll follows page visibility', () => {
  it('does not ask at all while the page is invisible, not even on mount', async () => {
    const fetchRunning = vi.fn(async () => ({ runningCommandTaskIds: null as string[] | null }))
    setVisibility('hidden', false)

    await mount(fetchRunning)
    expect(fetchRunning).not.toHaveBeenCalled()

    // 三轮轮询走过去:页面还没回来,一发都不发。
    await advance(BACKGROUND_TASKS_POLL_MS * 3)
    expect(fetchRunning).not.toHaveBeenCalled()
  })

  it('asks on mount and on every poll while the page is visible', async () => {
    const fetchRunning = vi.fn(async () => ({ runningCommandTaskIds: null as string[] | null }))

    await mount(fetchRunning)
    expect(fetchRunning).toHaveBeenCalledTimes(1)
    expect(fetchRunning).toHaveBeenCalledWith('device-1', 'session-1')

    await advance(BACKGROUND_TASKS_POLL_MS)
    expect(fetchRunning).toHaveBeenCalledTimes(2)
    await advance(BACKGROUND_TASKS_POLL_MS)
    expect(fetchRunning).toHaveBeenCalledTimes(3)

    // 去了后台:轮询还在走,但不再发;回来立刻补一发,而不是等下一个 5 秒。
    setVisibility('hidden')
    await advance(BACKGROUND_TASKS_POLL_MS * 2)
    expect(fetchRunning).toHaveBeenCalledTimes(3)

    await act(async () => { setVisibility('visible') })
    expect(fetchRunning).toHaveBeenCalledTimes(4)
    await advance(BACKGROUND_TASKS_POLL_MS)
    expect(fetchRunning).toHaveBeenCalledTimes(5)
  })

  it('stops listening to visibility once the roster is gone', async () => {
    const fetchRunning = vi.fn(async () => ({ runningCommandTaskIds: null as string[] | null }))
    await mount(fetchRunning)
    expect(fetchRunning).toHaveBeenCalledTimes(1)
    harness.cleanup()
    await act(async () => { setVisibility('hidden'); setVisibility('visible') })
    expect(fetchRunning).toHaveBeenCalledTimes(1)
    harness = createReactHarness()
  })
})
