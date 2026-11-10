import { describe, expect, it } from 'vitest'
import { createContactQrPayload, createGroupInviteQrPayload, createGuguQrUrl, parseGuguQrPayload } from '@gugu/core/shared/qrPayload'

describe('QR payload boundaries', () => {
  it('rejects ids that cannot be represented without rounding', () => {
    const id = Number.MAX_SAFE_INTEGER + 1
    expect(parseGuguQrPayload(`https://example.test/j/?${id}`)).toBeNull()
    expect(parseGuguQrPayload({ version: 1, kind: 'contact', gugu_number: id })).toBeNull()
    expect(() => createContactQrPayload(id)).toThrow()
    expect(() => createGroupInviteQrPayload(id, 'a'.repeat(32))).toThrow()
    expect(parseGuguQrPayload(`https://example.test/j/?${Number.MAX_SAFE_INTEGER}`)).toMatchObject({ gugu_number: Number.MAX_SAFE_INTEGER })
  })
})
