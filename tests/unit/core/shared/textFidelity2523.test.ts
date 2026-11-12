import { expect, it } from 'vitest'
import { excerpt, forwardQuote } from '@gugu/core/shared/ui/forwardQuote'
import { serializeWidgetMessage, widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { readFrontmatter, memoryIndexHints } from '@gugu/core/shared/assistantMemory'

it('keeps complete Unicode characters in forward excerpts', () => { expect(excerpt('a🍵bc', 4)).toBe('a🍵bc'); expect(excerpt('a🍵bcd', 4)).toBe('a🍵b…') })
