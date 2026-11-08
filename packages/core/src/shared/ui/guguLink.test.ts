import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGuguLink } from './guguLink'

afterEach(() => vi.unstubAllGlobals())

describe('parseGuguLink', () => {
  /** A WebView before Chromium 130: a custom scheme's URL has no host, and its authority stays in the path. */
  const oldWebViewUrl = class extends URL {
    override get hostname() {
      return this.protocol === 'https:' || this.protocol === 'http:' ? super.hostname : ''
    }
  }

  it.each([[true], [false]])('reads an App link the same with and without a host for custom schemes (old WebView: %s)', (old) => {
    if (old) vi.stubGlobal('URL', oldWebViewUrl)
    expect(parseGuguLink('gugu://ext/kanban/board?view=team')).toEqual({ kind: 'app', extensionId: 'kanban', tab: 'board', path: '', query: { view: 'team' }, place: null })
    expect(parseGuguLink('gugu-beta://app/kanban?variant=mine')).toEqual({ kind: 'app-detail', extensionId: 'kanban', variant: 'mine' })
    expect(parseGuguLink('https://ext/kanban/board')).toBeNull()
    expect(parseGuguLink('gugu://ext/kanban')).toBeNull()
  })
})
