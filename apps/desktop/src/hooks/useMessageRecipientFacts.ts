import { useEffect, useMemo, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageAgentWakes, MessageRecipientFacts } from '@gugu/core/shared/ui/messageState'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { loadMessageAgentWakes } from '@/lib/chatMessageRevalidation'

// @@@agent-wakes - the server writes a message's wakes with the message and never changes them, so one lookup
// per message serves every view that shows it.
const known = new Map<string, ReadonlySet<string>>()

/** The agents my sent messages wake (who they are delivered to). A message not loaded yet is absent. */
export function useMessageAgentWakes(messages: readonly MessageItem[]): MessageAgentWakes {
  const [wakes, setWakes] = useState<MessageAgentWakes>(() => new Map())
  const missing = useMemo(() => messages
    .filter((message) => message.is_mine && message.seq > 0 && !message.retracted_at && !wakes.has(message.id))
    .map((message) => message.id).sort().join(','), [messages, wakes])
  useEffect(() => {
    if (!missing) return
    let alive = true
    const ids = missing.split(',')
    const unknown = ids.filter((id) => !known.has(id))
    void (unknown.length ? loadMessageAgentWakes(unknown) : Promise.resolve(new Map<string, Set<string>>())).then((loaded) => {
      for (const [id, agents] of loaded) known.set(id, agents)
      if (!alive) return
      setWakes((previous) => {
        const next = new Map(previous)
        for (const id of ids) next.set(id, known.get(id)!)
        return next
      })
    })
    return () => { alive = false }
  }, [missing])
  return wakes
}

/** Who my messages are for (see MessageRecipientFacts): the line's agents and the wakes of its messages. */
export function useMessageRecipientFacts(messages: readonly MessageItem[], memberProfiles: Record<string, MemberProfileCardModel>): MessageRecipientFacts {
  const wakes = useMessageAgentWakes(messages)
  const agentKey = useMemo(() => Object.values(memberProfiles).filter((profile) => profile.type === 'agent').map((profile) => profile.id).sort().join(','), [memberProfiles])
  const agentIds = useMemo(() => new Set(agentKey ? agentKey.split(',') : []), [agentKey])
  return useMemo(() => ({ agentIds, wakes }), [agentIds, wakes])
}
