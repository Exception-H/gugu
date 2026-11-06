import { beforeEach, describe, expect, it, vi } from 'vitest';

// 这两条路径都要在 node 里跑:IPC 与机器路由都换成假的,附件字节从假 store 里来。
const { rpcOnMock, readUserImageDataUrl } = vi.hoisted(() => {
  const readUserImageDataUrl = vi.fn();
  const rpcOnMock = vi.fn(() => ({ app: { readUserImageDataUrl } }));
  return { readUserImageDataUrl, rpcOnMock };
});

vi.mock('@renderer/lib/ipc', () => ({ rpcOn: rpcOnMock }));
vi.mock('@renderer/lib/machine-routing', () => ({
  machineRegistry: { machineOf: () => ({ id: 'machine-1' }) },
}));
vi.mock('./acp-chat-resource-manager', () => ({
  resolveVisualEvidenceAttachmentDataUrl: () => undefined,
}));

import { createAttachmentDataUrlCache, resolveAttachmentDataUrl } from './attachment-data-url';
import type { AcpChatStore } from './acp-chat-store';

type FakeDownload = ReturnType<typeof vi.fn>;

function fakeStore(downloadAttachment: FakeDownload): AcpChatStore {
  return { projectId: 'project-1', session: { downloadAttachment } } as unknown as AcpChatStore;
}

beforeEach(() => {
  rpcOnMock.mockClear();
  readUserImageDataUrl.mockReset();
});

describe('附件 data URL 缓存', () => {
  it('读失败不进缓存:下一次看同一张图会重新去读,读到了就能用', async () => {
    const cache = createAttachmentDataUrlCache(4);

    const failed = cache.remember('att-1', Promise.resolve(null));
    await expect(failed).resolves.toBeNull();
    // 失败那次不留痕迹 —— 「这次没读到」不等于「这张图没有」。
    expect(cache.lookup('att-1')).toBeUndefined();
    expect(cache.size).toBe(0);

    // 网络恢复后再看:重新登记一条,这次读到了。
    await expect(cache.remember('att-1', Promise.resolve('data:image/png;base64,AA'))).resolves.toBe(
      'data:image/png;base64,AA',
    );
    await expect(cache.lookup('att-1')).resolves.toBe('data:image/png;base64,AA');
    expect(cache.size).toBe(1);
  });

  it('读失败后重试成功,并保住其他条目', async () => {
    const cache = createAttachmentDataUrlCache(4);
    await cache.remember('keep', Promise.resolve('keep-data'));

    // 抛错同样不算「没有这张图」。
    const rejected = cache.remember('att-2', Promise.reject(new Error('offline')));
    await expect(rejected).rejects.toThrow('offline');
    expect(cache.lookup('att-2')).toBeUndefined();

    await cache.remember('att-2', Promise.resolve('retried-data'));
    await expect(cache.lookup('att-2')).resolves.toBe('retried-data');
    await expect(cache.lookup('keep')).resolves.toBe('keep-data');
  });

  it('淘汰按最近访问(LRU):近期看过的条目不会被先挤掉', async () => {
    const cache = createAttachmentDataUrlCache(3);
    await cache.remember('a', Promise.resolve('A'));
    await cache.remember('b', Promise.resolve('B'));
    await cache.remember('c', Promise.resolve('C'));

    // 再看一眼 a —— 它本该是「最早先进来的」,但刚被访问过。
    await expect(cache.lookup('a')).resolves.toBe('A');

    // 第 4 条进来,只该挤掉最久没被看过的 b。
    await cache.remember('d', Promise.resolve('D'));
    expect(cache.size).toBe(3);
    await expect(cache.lookup('a')).resolves.toBe('A');
    await expect(cache.lookup('c')).resolves.toBe('C');
    await expect(cache.lookup('d')).resolves.toBe('D');
    expect(cache.lookup('b')).toBeUndefined();
  });
});

describe('resolveAttachmentDataUrl', () => {
  it('路径附件读失败后,再调用会重新走 RPC 并成功', async () => {
    const store = fakeStore(vi.fn());
    readUserImageDataUrl
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, dataUrl: 'data:image/png;base64,ZZ' });

    await expect(resolveAttachmentDataUrl(store, 'path:/tmp/gugu-shot-11.png')).resolves.toBeNull();
    // 失败那次没有被缓存成「这张图没有」。
    await expect(resolveAttachmentDataUrl(store, 'path:/tmp/gugu-shot-11.png')).resolves.toBe(
      'data:image/png;base64,ZZ',
    );
    expect(readUserImageDataUrl).toHaveBeenCalledTimes(2);
    expect(readUserImageDataUrl).toHaveBeenLastCalledWith('/tmp/gugu-shot-11.png');
  });

  it('会话附件下载失败后,再调用会重新下载并成功', async () => {
    const downloadAttachment = vi
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({
        success: true,
        data: { ref: { mimeType: 'image/png' }, data: new Uint8Array([0x41, 0x42]) },
      });
    const store = fakeStore(downloadAttachment);

    await expect(resolveAttachmentDataUrl(store, 'att-failure-retry-11')).resolves.toBeNull();
    await expect(resolveAttachmentDataUrl(store, 'att-failure-retry-11')).resolves.toBe(
      `data:image/png;base64,${btoa('AB')}`,
    );
    expect(downloadAttachment).toHaveBeenCalledTimes(2);
  });

  it('读到的附件会命中缓存,不再重复下载', async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      success: true,
      data: { ref: { mimeType: 'image/png' }, data: new Uint8Array([0x41]) },
    });
    const store = fakeStore(downloadAttachment);

    await expect(resolveAttachmentDataUrl(store, 'att-cached-11')).resolves.toBe(
      `data:image/png;base64,${btoa('A')}`,
    );
    await expect(resolveAttachmentDataUrl(store, 'att-cached-11')).resolves.toBe(
      `data:image/png;base64,${btoa('A')}`,
    );
    expect(downloadAttachment).toHaveBeenCalledTimes(1);
  });
});
