import { expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'
const frame = Buffer.from([0xff,0xc0,0,11,8,0,11,0,37,1,1,0x11,0])
const jpeg = (prefix: Buffer) => Buffer.concat([Buffer.from([0xff,0xd8]),prefix,frame])
const webp = (kind: string, length: number, payload: number[]) => { const b=Buffer.alloc(20+payload.length);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WEBP',8);b.write(kind,12);b.writeUInt32LE(length,16);b.set(payload,20);return b }

it('rejects a frame whose declared length does not contain its dimensions', () => { const broken=Buffer.from(frame);broken.writeUInt16BE(2,2);expect(imagePixelSize(jpeg(broken.subarray(0,0)).map((v,i)=>v))).toEqual({width:37,height:11});expect(imagePixelSize(Buffer.concat([Buffer.from([255,216]),broken]))).toBeNull() })

it('rejects PNG dimensions above the signed 31-bit format limit', () => { const b=Buffer.alloc(24);b.set([137,80,78,71,13,10,26,10]);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(0x80000000,16);b.writeUInt32BE(1,20);expect(imagePixelSize(b)).toBeNull() })
