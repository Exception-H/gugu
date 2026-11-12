import { expect, it } from 'vitest'
import { parseTranscript, renderTranscript, parseModelTranscript, formatTimestamp, formatClock, looksHallucinated, summaryRequestText } from '@gugu/core/shared/voiceNotes'

it('reads indented timestamp rows as new transcript entries', () => {expect(parseTranscript('[00:00] Lin：One\n  [00:01] Q：Two\n')).toEqual([{startMs:0,speaker:'Lin',text:'One'},{startMs:1000,speaker:'Q',text:'Two'}])})

it('does not create seek positions from invalid timestamp fields', () => {expect(parseTranscript('[00:60] Lin：Bad\n[1:60:00] Q：Bad')).toEqual([])})

it('rejects nonfinite voice durations rather than printing invalid clock labels', () => {for(const value of [NaN,Infinity]) {expect(()=>formatTimestamp(value)).toThrow();expect(()=>formatClock(value)).toThrow()}})

it('round-trips transcript text whose first line is empty', () => {const rows=[{startMs:0,speaker:'Lin',text:'\nSecond'}];expect(parseTranscript(renderTranscript(rows))).toEqual(rows)})

it('does not double-count supplementary characters in hallucination density',()=>{expect(looksHallucinated([{startMs:0,speaker:'Lin',text:'𠀀'.repeat(20)}],1000)).toBe(false)})
