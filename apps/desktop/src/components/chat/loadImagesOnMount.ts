import { createContext } from 'react'

/**
 * The task timeline draws a sent picture without its dimensions (they come with a chat row, not with a send's receipt),
 * so the picture's size is known only once it has loaded. There it loads as soon as its row is mounted, ahead of the
 * viewport, and the timeline's scroll anchoring absorbs the change before the reader gets there.
 */
export const LoadImagesOnMount = createContext(false)
