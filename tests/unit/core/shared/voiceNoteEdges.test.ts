import { describe, expect, it } from 'vitest'
import { exportFileName, groupVoiceNotesByWeek, parseTranscript, renderTranscript, summaryTitle, transcriptTail } from '@gugu/core/shared/voiceNotes'

describe('voice-note text boundaries', () => {
  it('does not cut a summary title inside a Unicode code point', () => {
    const title = 'a'.repeat(199) + '🍵'
    expect(summaryTitle('# ' + title)).toBe(title)
  })
  it('sorts same-week notes by instant when timestamp offsets differ', () => {
    const older = '2026-11-10T10:00:00+08:00', newer = '2026-11-10T03:00:00Z'
    expect(groupVoiceNotesByWeek([older, newer], (value) => value, new Date('2026-11-11T00:00:00Z'))[0].items).toEqual([newer, older])
  })
  it('keeps continuation lines when reloading a rendered transcript', () => {
    const lines = [{ startMs: 0, speaker: 'Lin', text: 'Hello\nworld' }]
    expect(parseTranscript(renderTranscript(lines))).toEqual(lines)
  })
  it('returns an empty transcript tail when zero lines are requested', () => {
    expect(transcriptTail([{ startMs: 0, speaker: 'Lin', text: 'Hello' }], 0)).toBe('')
  })
  it('round-trips timestamps beyond 99 hours', () => {
    const lines = [{ startMs: 360_005_000, speaker: 'Lin', text: 'Hello' }]
    expect(parseTranscript(renderTranscript(lines))).toEqual(lines)
  })
})
