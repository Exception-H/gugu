// 附件缓存的字节上限,在真 Cache Storage 上量:超了删最旧的,刚写入的还在;读到一半的续传分片不计入、不淘汰。
import { afterEach, describe, expect, it } from 'vitest'
import { trimCacheToBytes } from '@/lib/attachmentCacheBudget'

const NAME = 'attachment-cache-budget-test'
const ORIGIN = 'https://attachments.gugu.invalid'
const bytes = (n: number) => new Response(new Uint8Array(n))

afterEach(async () => { await caches.delete(NAME) })

describe('trimCacheToBytes', () => {
  it('drops the oldest entries past the byte budget and keeps the newest', async () => {
    const cache = await caches.open(NAME)
    for (const name of ['a', 'b', 'c', 'd']) await cache.put(`${ORIGIN}/sha256/${name}`, bytes(400))
    await trimCacheToBytes(cache, 1000, () => false)
    expect((await cache.keys()).map((r) => r.url.slice(-1))).toEqual(['c', 'd'])
  })

  it('rewriting an entry makes it the newest', async () => {
    const cache = await caches.open(NAME)
    for (const name of ['a', 'b', 'c']) await cache.put(`${ORIGIN}/sha256/${name}`, bytes(400))
    await cache.put(`${ORIGIN}/sha256/a`, bytes(400))
    await trimCacheToBytes(cache, 800, () => false)
    expect((await cache.keys()).map((r) => r.url.slice(-1))).toEqual(['c', 'a'])
  })

  it('never counts or evicts in-flight download chunks', async () => {
    const cache = await caches.open(NAME)
    await cache.put(`${ORIGIN}/chunks/x/0`, bytes(5000))
    for (const name of ['a', 'b']) await cache.put(`${ORIGIN}/sha256/${name}`, bytes(400))
    await trimCacheToBytes(cache, 500, (url) => url.startsWith(`${ORIGIN}/chunks/`))
    expect((await cache.keys()).map((r) => r.url.replace(ORIGIN, ''))).toEqual(['/chunks/x/0', '/sha256/b'])
  })
})
