import { memo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { SentMessageBody } from '@/session/renderer/lib/chat/sent-message-body'
import { sentMessageSlots, subscribeSentMessageSlots } from './sentMessageSlots'

// A row entering or leaving the virtual list changes the slot list on most scroll frames: only that slot draws.
const SlotBody = memo(SentMessageBody)

/**
 * Draws every offered slot from the app's own tree, where the signed-in account and the chat store are: the desktop
 * task page runs in a React root of its own, and MessageBody's file cards and reference tags read both. Mounted once.
 */
export function SentMessageBodyHost() {
  const current = useSyncExternalStore(subscribeSentMessageSlots, sentMessageSlots)
  return current.map(slot => createPortal(<SlotBody message={slot.message} commands={slot.commands()} onSize={slot.onSize} />, slot.root, slot.id))
}
