import { join } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createRecentReader } from '@gugu/session-core/session-record/window-cache/recent-reader';
import { createDiskBodyPageIo } from '@gugu/session-core/session-record/window-cache/body-reader';
import { readSourceLocator } from '@gugu/session-core/session-record/window-cache/source-locator';
import { openWindowByteSource } from '@gugu/session-core/session-record/window-cache/file-source';
import { loadReverseIndexTask } from '@gugu/session-core/session-record/window-cache/record-locators';
import { createReverseIndexScheduler } from '@gugu/session-core/session-record/window-cache/reverse-index-runner';
import { createSourceReopenResolver } from '@gugu/session-core/session-record/window-cache/reopen-source';
import type { WindowReadRequest, WindowIoCounters, WindowSourceLocator } from '@gugu/session-core/session-record/window-cache/types';
import { createDesktopWindowReader } from './desktop-window-reader';

export type DesktopSourceRequest = WindowReadRequest & { cwd?: string; nativeSourcePath?: string };

/** One host-owned resolver; file discovery and page reads share the request budget. */
export function createDesktopSourceWindowReader(options: {
  request(id: string, limit?: number, signal?: AbortSignal): Promise<DesktopSourceRequest>;
  reportError(error: unknown): void;
  observed?(conversationId: string, io: Readonly<WindowIoCounters>, phase: 'window' | 'discovery'): void;
}) {
  const resolver = createSourceReopenResolver();
  let discovery: { key: string; abort: AbortController; promise: Promise<WindowSourceLocator>; waiters: number } | undefined;
  const reported = new WeakSet<WindowReadRequest>();
  const listeners = new Set<() => void>();
  const locatedRequests = new WeakMap<WindowReadRequest, WindowSourceLocator>();
  const scheduler = createReverseIndexScheduler({ onFailure: options.reportError,
    onLocated: () => { for (const changed of listeners) changed(); } });
  async function locate(input: DesktopSourceRequest): Promise<WindowSourceLocator | null> {
    const cached = locatedRequests.get(input);
    if (cached) return cached;
    const harness = input.locator.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('Unsupported window source');
    const saved = await readSourceLocator(input.cacheDirectory, harness, input.locator.providerSessionId, input.budget);
    if (saved.kind === 'hit') { locatedRequests.set(input, saved.locator); return saved.locator; }
    if (saved.reason !== 'not_found') throw new Error(`Source locator failure: ${saved.reason}`);
    return null;
  }
  function finish(input: WindowReadRequest) {
    if (reported.has(input)) return;
    reported.add(input); options.observed?.(input.conversationId, input.budget.counters, 'window');
  }
  /** One selected background discovery, no whole-job queue. Known paths bypass it. */
  async function locateForRead(input: DesktopSourceRequest): Promise<WindowSourceLocator> {
    const saved = await locate(input);
    input.signal?.throwIfAborted();
    if (saved) return saved;
    const key = JSON.stringify([input.cacheDirectory, input.locator, input.cwd, input.nativeSourcePath]);
    if (!discovery || discovery.key !== key || discovery.abort.signal.aborted) {
      discovery?.abort.abort(new Error('Source discovery selection changed'));
      const abort = new AbortController();
      const promise = (async () => {
        for (;;) {
          abort.signal.throwIfAborted();
          const budget = createWindowBudget();
          try {
            const result = await resolver.resolveSourceForReopen(input, budget, abort.signal);
            if (result.kind === 'located') return { version: 1 as const, harness: input.locator.harness as 'claude' | 'codex',
              providerSessionId: input.locator.providerSessionId, path: result.path, source: result.source, sourceLineage: result.sourceLineage };
            if (result.kind === 'cache_miss') throw Object.assign(new Error('Native record source was not found'), { code: 'record_not_found' });
          } finally { options.observed?.(input.conversationId, budget.counters, 'discovery'); }
          await setImmediate(undefined, { signal: abort.signal });
        }
      })();
      discovery = { key, abort, promise, waiters: 0 };
    }
    const selected = discovery; selected.waiters += 1;
    let cancel: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(input.signal?.reason ?? new Error('Source discovery cancelled'));
        input.signal?.addEventListener('abort', cancel, { once: true });
        if (input.signal?.aborted) cancel();
      });
      const value = await Promise.race([selected.promise, cancelled]);
      locatedRequests.set(input, value); return value;
    } finally {
      if (cancel) input.signal?.removeEventListener('abort', cancel);
      selected.waiters -= 1;
      if (selected.waiters === 0) { selected.abort.abort(); if (discovery === selected) discovery = undefined; }
    }
  }
  function reader(input: WindowReadRequest) {
    return createRecentReader({
      openSource: async current => {
        const located = await locateForRead(current);
        const source = await openWindowByteSource(located.path);
        try {
          if ((await source.snapshot()).sourceInstance !== located.source.sourceInstance)
            throw new Error('Native source locator refers to a replaced file');
          return { source, sourceLineage: located.sourceLineage, close: () => source.close() };
        } catch (error) { await source.close(); throw error; }
      },
      body: createDiskBodyPageIo(join(input.cacheDirectory, 'bodies'), async (_body, budget) => {
        const located = await locate({ ...input, budget });
        if (!located) return false;
        const source = await openWindowByteSource(located.path);
        try { const current = await source.snapshot(); return current.sourceInstance === _body.sourceLineage && current.snapshotRevision === _body.revision; }
        finally { await source.close(); }
      }),
      schedulePending: async (current, snapshot, ticket) => {
        const located = await locate(current);
        if (!located) throw new Error('Native source locator disappeared');
        const job = { scope: current.scope, sourceLineage: located.sourceLineage, decoderVersion: 1, jobId: ticket.ticket };
        const saved = await loadReverseIndexTask(current.cacheDirectory, job, current.budget);
        if (saved.kind === 'hit' && saved.position.kind === 'located') return;
        const checkpoint = saved.kind === 'hit' ? saved.position.checkpoint : { version: 1 as const, jobId: ticket.ticket,
          sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance, sourceLineage: located.sourceLineage,
          snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size, recordEnd: ticket.sourceFence.end,
          scanBefore: ticket.nextScanOffset, sourceFence: ticket.sourceFence };
        if (checkpoint.sourceInstance !== snapshot.sourceInstance || checkpoint.snapshotRevision !== snapshot.snapshotRevision)
          throw new Error('Reverse checkpoint no longer matches the source revision');
        scheduler.schedule(located.path, checkpoint, current.cacheDirectory, current.scope);
      },
    });
  }
  async function measured<T>(input: WindowReadRequest, read: () => Promise<T>) {
    await scheduler.pause();
    try { return await read(); }
    finally { finish(input); }
  }
  const bridge = createDesktopWindowReader({ request: options.request, finish,
    openRecent: input => measured(input, () => reader(input).openRecent(input)),
    readOlder: input => measured(input, () => reader(input).readOlder(input)),
    readBody: input => measured(input, () => reader(input).readBody(input)),
    watch: async (_id, changed, input) => {
      const located = await locateForRead(input);
      listeners.add(changed);
      watchFile(located.path, { persistent: false, interval: 250 }, changed);
      return () => { listeners.delete(changed); unwatchFile(located.path, changed); };
    },
  });
  return { ...bridge, async dispose() { discovery?.abort.abort(); await scheduler.dispose(); await resolver.dispose(); } };
}
