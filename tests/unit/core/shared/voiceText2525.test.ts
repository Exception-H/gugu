import { expect, it } from 'vitest'
import { parseTranscript, renderTranscript, parseModelTranscript, formatTimestamp, formatClock, looksHallucinated, summaryRequestText } from '@gugu/core/shared/voiceNotes'

it('reads indented timestamp rows as new transcript entries', () => {expect(parseTranscript('[00:00] Lin：One\n  [00:01] Q：Two\n')).toEqual([{startMs:0,speaker:'Lin',text:'One'},{startMs:1000,speaker:'Q',text:'Two'}])})

it('does not create seek positions from invalid timestamp fields', () => {expect(parseTranscript('[00:60] Lin：Bad\n[1:60:00] Q：Bad')).toEqual([])})
