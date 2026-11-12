import { expect, it } from 'vitest'
import { byteRange, answerBesideDocument } from './preview/chat-folder-preview'
import { createPortDetector, findLoopbackPorts } from './remote-port-detect'

it('accepts HTTP range units case-insensitively',()=>{expect(byteRange('Bytes=1-3',10)).toEqual({start:1,end:3})})
