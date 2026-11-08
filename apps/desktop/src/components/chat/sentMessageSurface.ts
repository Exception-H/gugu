import { createContext } from 'react'

/**
 * The task timeline's slot a message body is drawn in; null in a chat. The same message can be on screen in both (a
 * group chat beside the task that sent to it), so its widget's tab is named per surface.
 *
 * In a slot a picture also loads as soon as its row is mounted: the timeline draws a sent picture without its dimensions
 * (they come with a chat row, not with a send's receipt), so its size is known only once it has loaded, and loading ahead
 * of the viewport lets the timeline's scroll anchoring absorb the change before the reader gets there.
 */
export const SentMessageSurface = createContext<number | null>(null)

export const widgetTabId = (messageId: string, slot: number | null) => slot === null ? `widget:${messageId}` : `widget:${messageId}:slot-${slot}`
