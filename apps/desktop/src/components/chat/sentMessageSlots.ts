import type { ChatCommands } from '@gugu/session-chat-ui'
import type { MessageItem } from '@gugu/core/shared/types/chat'

/** A task timeline's slot for one message the agent sent to people, waiting to be drawn by the chat's MessageBody. */
export type SentMessageSlot = {
  root: HTMLElement
  message: MessageItem
  commands: () => ChatCommands | undefined
  onSize: (size: { width: number; height: number }) => void
}

let slots: readonly SentMessageSlot[] = []
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** The timeline (in whichever React root it runs) hands its slot over; the returned function takes it back. */
export function offerSentMessageSlot(slot: SentMessageSlot): () => void {
  slots = [...slots, slot]
  changed()
  return () => { slots = slots.filter(entry => entry !== slot); changed() }
}

export const subscribeSentMessageSlots = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const sentMessageSlots = () => slots
