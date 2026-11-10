import { describe, expect, it } from 'vitest'
import { exportFileName, groupVoiceNotesByWeek, parseTranscript, renderTranscript, summaryTitle, transcriptTail } from '@gugu/core/shared/voiceNotes'

describe('voice-note text boundaries', () => {
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
