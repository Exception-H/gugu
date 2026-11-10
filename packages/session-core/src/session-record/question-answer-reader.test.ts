import { describe, expect, it } from 'vitest'
import { readQuestionAnswerDelivery } from './question-answer'

describe('serialized question answer reading', () => {
  it.each(['null', '[]', '42', '"answered"'])('ignores a non-object envelope %s', (json) => {
    expect(readQuestionAnswerDelivery(`<gugu_question_answer>\n${json}\n</gugu_question_answer>`)).toBeUndefined()
  })
})
