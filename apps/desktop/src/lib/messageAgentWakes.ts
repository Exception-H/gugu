import { loadMessageAgentWakes } from './chatMessageRevalidation'
import { rendererLogger } from './log'

// @@@agent-wakes - the server writes a message's wakes with the message and never changes them, so the signed-in
// account keeps one answer per message for every view that shows it (the only cache of them). The account's owner
// (accountStartBeat) forgets it on sign-out / account switch. A read that fails is logged; those messages stay
// without a receipt ring or a wait, and are not asked for again in a loop.
const known = new Map<string, ReadonlySet<string>>()
const pending = new Set<string>()
const failed = new Set<string>()
const listeners = new Set<() => void>()
let account = 0
const log = rendererLogger('chat/agent-wakes')

function changed(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeMessageAgentWakes(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Ask for the wakes of these messages; known, pending and failed ones are not asked again. */
export function requestMessageAgentWakes(ids: readonly string[]): void {
  const wanted = ids.filter((id) => !known.has(id) && !pending.has(id) && !failed.has(id))
  if (wanted.length === 0) return
  for (const id of wanted) pending.add(id)
  const asked = account
  void loadMessageAgentWakes(wanted).then((loaded) => {
    if (asked !== account) return
    for (const [id, agents] of loaded) known.set(id, agents)
  }, (error: unknown) => {
    if (asked !== account) return
    for (const id of wanted) failed.add(id)
    log.error({ error: String(error), count: wanted.length }, 'message recipients could not be read')
  }).finally(() => {
    if (asked !== account) return
    for (const id of wanted) pending.delete(id)
    changed()
  })
}

/** Sign-out / account switch: the next account starts with nothing known, nothing pending and nothing failed. */
export function forgetMessageAgentWakes(): void {
  account += 1
  known.clear()
  pending.clear()
  failed.clear()
  changed()
}

/** The known wakes among these messages, as a key that only changes when that set does. */
export function knownMessageAgentWakesKey(ids: readonly string[]): string {
  return ids.filter((id) => known.has(id)).join(',')
}

export function knownMessageAgentWakes(id: string): ReadonlySet<string> | undefined {
  return known.get(id)
}
