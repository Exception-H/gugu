// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  signInWithOtp: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ data: { session: { access_token: 'x' }, user: { id: 'u' } }, error: null })),
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  supabase: { auth: mocks },
  identityDb: {},
  syncSchemaClientSession: vi.fn(async () => undefined),
}))

import { authService } from '../../../../apps/desktop/src/lib/auth'
import { consumePendingReferrer, rememberReferrerFromLink } from '../../../../apps/desktop/src/lib/referral'

const otpData = () => (mocks.signInWithOtp.mock.calls.at(-1) as unknown as [{ options: { data: Record<string, unknown> } }])[0].options.data

// The referral link is the personal short code (qrPayload @@@short-qr). The OS hands it to the App before
// sign-up (official /j/ page → gugu://…/j/?<n>); email sign-up then carries it in user metadata, which
// billing.claim_device_free_credits reads to grant the referral reward.
describe('referral from a link the OS opened', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })

  it('a contact short link, on the web or handed over on the app scheme, becomes the sign-up referrer', async () => {
    rememberReferrerFromLink('gugu://gugu.nextmind.space/j/?123456789')
    await authService.requestLoginOtp('new@example.test')
    expect(otpData().referrer_gugu_number).toBe('123456789')
    await authService.verifyLoginOtp('new@example.test', '000000')
    expect(consumePendingReferrer()).toBeNull()

    rememberReferrerFromLink('https://gugu.nextmind.space/j/?42')
    expect(consumePendingReferrer()).toBe('42')
  })

  it('group invites and other links leave the referrer alone', async () => {
    rememberReferrerFromLink('https://gugu.nextmind.space/j/?208803.n4bQgYhMfWWaL-qgxVrQFQ')
    rememberReferrerFromLink('gugu://chat/00000000-0000-4000-8000-000000000001')
    rememberReferrerFromLink('https://example.com/?ref=7')
    expect(consumePendingReferrer()).toBeNull()
    await authService.requestLoginOtp('new@example.test')
    expect(otpData()).not.toHaveProperty('referrer_gugu_number')
  })
})
