import { describe, expect, it } from 'vitest'
import { exportFileName, groupVoiceNotesByWeek, parseTranscript, renderTranscript, summaryTitle, transcriptTail } from '@gugu/core/shared/voiceNotes'

describe('voice-note text boundaries', () => {
  it('round-trips timestamps beyond 99 hours', () => {
    const lines = [{ startMs: 360_005_000, speaker: 'Lin', text: 'Hello' }]
    expect(parseTranscript(renderTranscript(lines))).toEqual(lines)
  })
})
