import { describe, expect, it } from 'vitest'
import { memoryIndexHints, parseMemoryNote, readFrontmatter, removeIndexEntry } from '@gugu/core/shared/assistantMemory'

describe('memory text parsing boundaries', () => {
  it('requires a complete closing delimiter and preserves an empty header body', () => {
    expect(readFrontmatter('---\n---\nBody')).toEqual({ fields: {}, body: 'Body' })
    expect(readFrontmatter('---\nname: Note\n---suffix\nBody')).toEqual({
      fields: {}, body: '---\nname: Note\n---suffix\nBody',
    })
    expect(readFrontmatter('---\nname: Note\n---suffix\ntype: user\n---\nBody')).toEqual({
      fields: { name: 'Note', type: 'user' }, body: 'Body',
    })
  })
})
