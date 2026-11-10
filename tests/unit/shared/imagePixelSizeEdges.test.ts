import { describe, expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'

const lossless = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvJIACAAdQhSJXof+BiOh/AAA=', 'base64')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACUAAAALCAIAAAB3WtMSAAAAHElEQVR4nGM8wcXFQEfARE/LRu0btW/UvhFlHwBbwgDymT3VBQAAAABJRU5ErkJggg==', 'base64')

describe('image header boundaries', () => {
  it('requires the complete PNG signature and the IHDR length', () => {
    for (const offset of [4, 5, 6, 7, 11]) {
      const broken = Buffer.from(png)
      broken[offset] ^= 1
      expect(imagePixelSize(broken)).toBeNull()
    }
    expect(imagePixelSize(png)).toEqual({ width: 37, height: 11 })
  })
  it('reads dimensions from the complete 25-byte VP8L header', () => {
    expect(imagePixelSize(lossless.subarray(0, 25))).toEqual({ width: 37, height: 11 })
    expect(imagePixelSize(lossless.subarray(0, 24))).toBeNull()
  })
})
