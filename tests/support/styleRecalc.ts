import { cdp } from 'vitest/browser'

type TraceEvent = { name: string; ph: string; args?: { elementCount?: number } }
type TraceSession = {
  send(method: string, params?: object): Promise<unknown>
  on(event: string, listener: (payload: { value: TraceEvent[] }) => void): void
}

// One pair of listeners for the page's lifetime; each measurement swaps in its own sink.
let sink: TraceEvent[] | null = null
let finished: (() => void) | null = null
let listening = false

/**
 * How many elements Chromium's style recalculation touched while `action` ran (the trace's
 * `UpdateLayoutTree.elementCount`, summed). The ruler for "this change re-styles what it concerns, not the page":
 * a count does not depend on how fast or busy the machine is, a duration does.
 *
 * Style pending before `action` is flushed first, and the style `action` dirties is flushed before the trace ends, so
 * the count is exactly what `action` cost. Give the page a known number of bystander elements and compare against it.
 */
export async function restyledElements(action: () => void | Promise<void>): Promise<number> {
  const session = cdp() as unknown as TraceSession
  if (!listening) {
    listening = true
    session.on('Tracing.dataCollected', (payload) => { sink?.push(...payload.value) })
    session.on('Tracing.tracingComplete', () => { finished?.() })
  }
  const events: TraceEvent[] = []
  const complete = new Promise<void>((resolve) => { finished = resolve })
  void document.body.offsetWidth
  sink = events
  await session.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline'], excludedCategories: ['*'] } })
  try {
    await action()
    void document.body.offsetWidth
  } finally {
    await session.send('Tracing.end')
    await complete
    sink = null
    finished = null
  }
  return events.filter((event) => event.name === 'UpdateLayoutTree' && event.ph === 'X').reduce((sum, event) => sum + (event.args?.elementCount ?? 0), 0)
}
