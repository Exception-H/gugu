import { describe, expect, it } from 'vitest'
import { guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'

describe('session item reference identity', () => {
  it('round-trips opaque case-sensitive session/item identities through the shared parser', () => {
    const target = { kind: 'session' as const, sessionId: 'Session-A', itemId: 'turn:2/item(1)?%=中' }
    expect(parseGuguLink(guguLink(target))).toEqual(target)
    for (const uri of ['gugu-session://s?message=%ZZ', 'gugu-session://s?message=x&extra=y']) expect(parseGuguLink(uri)).toBeNull()
  })
})
