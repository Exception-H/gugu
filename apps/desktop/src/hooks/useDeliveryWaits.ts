import { useMemo } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageAgentWakes } from '@gugu/core/shared/ui/messageState'
import { deliveryWaits, type HeldMessage } from '@gugu/core/shared/ui/systemNotice'

/** My messages no running instance can deliver to an agent they wake: their bubbles say so until it reads them. */
export function useDeliveryWaits(messages: readonly MessageItem[], memberReadSeqs: Record<string, number>, wakes: MessageAgentWakes): ReadonlyMap<string, HeldMessage> {
  return useMemo(() => deliveryWaits(messages, memberReadSeqs, wakes), [messages, memberReadSeqs, wakes])
}
