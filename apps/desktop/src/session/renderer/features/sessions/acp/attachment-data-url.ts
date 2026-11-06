/**
 * 会话里看过的每张附件图都会在这里留一份 base64。不设上限的话,翻过的会话越多内存越高,
 * 关掉会话也不释放 —— 「用一阵子就变卡」多半是从这儿开始的。
 *
 * 两条必须守住的边界:
 *
 * 1. **读失败不是结论。** 「这次没读到」和「这张图不存在」在 UI 上是同一个中性占位块,
 *    但缓存必须区分它们 —— 失败那次不进表(见 `remember`),否则一次断网就会让这张图
 *    永久显示成「没有」,网络回来也不会再试。
 * 2. **淘汰按最近访问,不按先进先出。** Map 的迭代顺序就是淘汰顺序,所以每次命中都把条目
 *    删掉再塞回去(见 `lookup`):最旧的那个是「最久没被看过的」,而不是「最早读进来的」。
 *    否则常用的图反而先被挤掉,下次再看又要重新走一轮 RPC。
 */
import { pathAttachmentTarget } from '@gugu/session-chat-ui/markdown-attachment-mentions';
import { resolveDeliveredAttachment } from '@renderer/lib/chat/delivered-message-presentation';
import { bytesToBase64 } from '@renderer/lib/base64';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { resolveVisualEvidenceAttachmentDataUrl } from './acp-chat-resource-manager';
import type { AcpChatStore } from './acp-chat-store';

export const ATTACHMENT_DATA_URL_CACHE_LIMIT = 24;

export interface AttachmentDataUrlCache {
  /** 命中时顺带给条目续命(LRU 触碰);没缓存过 = `undefined`。 */
  lookup(id: string): Promise<string | null> | undefined;
  /** 收下一条解析结果;解析成 `null`(读失败)或抛错时立即移出表,留给下一次重试。 */
  remember(id: string, promise: Promise<string | null>): Promise<string | null>;
  readonly size: number;
}

export function createAttachmentDataUrlCache(
  limit: number = ATTACHMENT_DATA_URL_CACHE_LIMIT,
): AttachmentDataUrlCache {
  const entries = new Map<string, Promise<string | null>>();

  const touch = (id: string, promise: Promise<string | null>): void => {
    // 先删再塞 = 挪到迭代顺序末尾 = 最近用过。
    entries.delete(id);
    entries.set(id, promise);
  };

  const evictOverflow = (): void => {
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  return {
    lookup(id) {
      const cached = entries.get(id);
      if (!cached) return undefined;
      touch(id, cached);
      return cached;
    },
    remember(id, promise) {
      // 只有「读到了」才配留在表里。判空/判错都带着身份比对,免得把后续重试写进来的新条目删掉。
      const entry = promise.then(
        (value) => {
          if (value === null && entries.get(id) === entry) entries.delete(id);
          return value;
        },
        (error: unknown) => {
          if (entries.get(id) === entry) entries.delete(id);
          throw error;
        },
      );
      touch(id, entry);
      evictOverflow();
      return entry;
    },
    get size() {
      return entries.size;
    },
  };
}

const attachmentDataUrlCache = createAttachmentDataUrlCache();

export function resolveAttachmentDataUrl(store: AcpChatStore, id: string): Promise<string | null> {
  if (id.startsWith('gugu-message-file://')) return resolveDeliveredAttachment(id);
  const fixtureDataUrl = resolveVisualEvidenceAttachmentDataUrl(store, id);
  if (fixtureDataUrl) return Promise.resolve(fixtureDataUrl);
  // 旧消息正文里那条绝对路径投影出来的附件(#5269):字节在盘上,不在 agent 的附件仓里 —— 照那条路径读。
  const path = pathAttachmentTarget(id);
  if (path) {
    const cachedPath = attachmentDataUrlCache.lookup(id);
    if (cachedPath) return cachedPath;
    // 字节在会话所在的那台机器上(别的机器上的会话 = 问那台机器)。
    const promise = rpcOn(machineRegistry.machineOf(store.projectId)).app.readUserImageDataUrl(path)
      .then((result) => (result.success ? result.dataUrl : null))
      .catch((error: unknown) => {
        // 读不到就退回中性占位块(旧消息里那些指着临时目录的路径就是这种)——❌ 不弹错。
        log.warn('Failed to read attachment image', { path, error });
        return null;
      });
    return attachmentDataUrlCache.remember(id, promise);
  }
  if (!store.session) return Promise.resolve(null);
  const cached = attachmentDataUrlCache.lookup(id);
  if (cached) return cached;
  const promise = store.session
    .downloadAttachment(id)
    .then((result) => {
      if (!result.success) return null;
      return `data:${result.data.ref.mimeType};base64,${bytesToBase64(result.data.data)}`;
    })
    .catch((error: unknown) => {
      log.warn('Failed to resolve ACP attachment', { id, error });
      return null;
    });
  return attachmentDataUrlCache.remember(id, promise);
}
