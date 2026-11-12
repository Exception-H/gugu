import { expect, it } from 'vitest'
import { excerpt, forwardQuote } from '@gugu/core/shared/ui/forwardQuote'
import { serializeWidgetMessage, widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'
import { readFrontmatter, memoryIndexHints } from '@gugu/core/shared/assistantMemory'

it('keeps complete Unicode characters in forward excerpts', () => { expect(excerpt('a🍵bc', 4)).toBe('a🍵bc'); expect(excerpt('a🍵bcd', 4)).toBe('a🍵b…') })

it('keeps multiline sender names inside one quote heading', () => { expect(forwardQuote([{ sender: 'Lin\nQ', text: 'Hello' }])).toBe('> **Lin Q**\n>\n> Hello') })

it('writes widget preview fields first regardless of input property order', () => { const widget = { app: 'notes', view: 'main', text: 'Hello', v: 2 as const }; expect(widgetMessagePreview(serializeWidgetMessage(widget))).toBe('Hello') })
