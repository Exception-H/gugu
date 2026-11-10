import { describe, expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'

const lossless = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvJIACAAdQhSJXof+BiOh/AAA=', 'base64')

describe('image header boundaries', () => {
  it('reads dimensions from the complete 25-byte VP8L header', () => {
    expect(imagePixelSize(lossless.subarray(0, 25))).toEqual({ width: 37, height: 11 })
    expect(imagePixelSize(lossless.subarray(0, 24))).toBeNull()
  })
})
