/**
 * `gugu-attachments-v1` 的字节上限:Cache Storage 的 `keys()` 本身按写入先后排(同一个 key 重写会排到最后),条目大小读
 * `blob().size`(不读字节)—— 从最新往回累加,超出上限的那些(最旧的)删掉。❌ 另造索引或存储。
 * 淘汰按写入先后,不按读取(Cache API 不记读取时间);删掉的原图下次打开照常重新下载、校验。
 * `keep`:不计入、也不淘汰的条目(读到一半的续传分片:读完由它自己清掉,裁掉就断了)。
 */
export async function trimCacheToBytes(cache: Cache, maxBytes: number, keep: (url: string) => boolean): Promise<void> {
  const requests = (await cache.keys()).filter((request) => !keep(request.url))
  const sizes = await Promise.all(requests.map(async (request) => (await (await cache.match(request))?.blob())?.size ?? 0))
  let total = 0
  for (let i = requests.length - 1; i >= 0; i--) {
    total += sizes[i]!
    if (total > maxBytes) await cache.delete(requests[i]!)
  }
}
