import type {
  RecordCursor, SessionpageSessionBodyReadRequest, SessionpageSessionEvent,
  SessionpageSessionOlderRequest, SessionpageSessionSubscribeRequest,
  TimelineAfterResult, TimelineOlderResult, TimelineSnapshot,
} from '@gugu/session-core/session-record/contract';
import type {
  WindowBodyResult, WindowPage, WindowReadRequest, WindowResult,
} from '../../../../../../../packages/session-core/src/session-record/window-cache/types';

export interface DesktopWindowIo {
  request(conversationId: string, limit?: number, signal?: AbortSignal): Promise<WindowReadRequest>;
  openRecent(request: WindowReadRequest): Promise<WindowResult>;
  readOlder(request: WindowReadRequest & { cursor: NonNullable<WindowPage['olderCursor']> }): Promise<WindowResult>;
  readBody(request: WindowReadRequest & SessionpageSessionBodyReadRequest): Promise<WindowBodyResult>;
  /** Observe a source revision; this must not acquire a legacy timeline. */
  watch(conversationId: string, changed: () => void, request: WindowReadRequest): Promise<() => void>;
}

function page(result: WindowResult): WindowPage {
  if (result.kind === 'reset') throw new Error(`Window source reset: ${result.reason}`);
  if (result.kind === 'cache_miss') throw new Error(`Window cache unresolved: ${result.reason}`);
  return result;
}
function project(value: WindowPage): TimelineSnapshot {
  const { kind: _kind, scope: _scope, commitSeq: _commit, io: _io, turns, ...fields } = value;
  const seq = Math.max(0, ...value.coveredRanges.map(range => range.end), ...value.pendingLongRecords.map(ticket => ticket.pinnedEnd));
  // A byte endpoint is not an event revision: same-size rewrites must replace the
  // client window. Append rebasing requires a separately verified source anchor.
  return { ...fields, cursor: { epoch: `${value.sourceLineage}:${value.snapshotRevision}`, seq }, turns, settlements: [], hasOlder: value.moreBefore !== 'no' };
}
function afterPage(snapshot: TimelineSnapshot, cursor: RecordCursor | null): TimelineAfterResult {
  if (!cursor || cursor.epoch !== snapshot.cursor.epoch) return { ok: false, reset: 'epoch_changed', snapshot };
  if (cursor.seq > snapshot.cursor.seq) return { ok: false, reset: 'cursor_ahead', snapshot };
  const { turns, settlements, hasOlder: _older, ...fields } = snapshot;
  return { ok: true, batch: { ...fields, from: cursor.seq, settlements, removedTurnIds: [],
    turns: turns.map(turn => ({ ...turn, itemIds: turn.items.map(item => item.id) })) } };
}

/** All four read/subscribe paths share bounded window I/O. No timeline or archive is acquired. */
export function createDesktopWindowReader(io: DesktopWindowIo) {
  async function snapshot(input: { conversationId: string; limit?: number }, signal?: AbortSignal): Promise<TimelineSnapshot> {
    const request = await io.request(input.conversationId, input.limit, signal);
    const value = project(page(await io.openRecent(request)));
    signal?.throwIfAborted();
    return value;
  }
  async function after(input: { conversationId: string; cursor: RecordCursor }, signal?: AbortSignal): Promise<TimelineAfterResult> {
    return afterPage(await snapshot(input, signal), input.cursor);
  }
  async function older(input: SessionpageSessionOlderRequest, signal?: AbortSignal): Promise<TimelineOlderResult> {
    if (!input.cursor) throw new Error('A window cursor is required for older history');
    const request = await io.request(input.conversationId, input.limit, signal);
    const value = page(await io.readOlder({ ...request, cursor: input.cursor }));
    signal?.throwIfAborted();
    const snapshot = project(value);
    const { cursor, settlements: _settlements, ...fields } = snapshot;
    return { ...fields, epoch: cursor.epoch };
  }
  async function body(input: SessionpageSessionBodyReadRequest, signal?: AbortSignal): Promise<WindowBodyResult> {
    const request = await io.request(input.conversationId, undefined, signal);
    if (input.bodyRef.scope !== request.scope) throw new Error('Body does not belong to this conversation');
    const value = await io.readBody({ ...request, ...input });
    signal?.throwIfAborted();
    return value;
  }
  async function subscribe(input: SessionpageSessionSubscribeRequest, emit: (event: SessionpageSessionEvent) => void,
    failed: (error: unknown) => void): Promise<() => void> {
    const abort = new AbortController();
    let cursor = input.cursor, running = false, dirty = false, stopped = false;
    let stopWatch: (() => void) | undefined;
    const stop = () => { if (!stopped) { stopped = true; abort.abort(); stopWatch?.(); } };
    const pump = async () => {
      dirty = true;
      if (running || stopped) return;
      running = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const value = await snapshot({ conversationId: input.conversationId }, abort.signal);
          if (stopped) return;
          const result = afterPage(value, cursor);
          cursor = value.cursor;
          emit({ subscriptionId: input.subscriptionId, result });
        }
      } catch (error) { if (!stopped) { stop(); failed(error); } }
      finally { running = false; }
    };
    try {
      const request = await io.request(input.conversationId, undefined, abort.signal);
      stopWatch = await io.watch(input.conversationId, () => { void pump(); }, request);
      if (stopped) stopWatch();
      else void pump();
      return stop;
    } catch (error) { stop(); throw error; }
  }
  return { snapshot, after, older, body, subscribe };
}

/** Real source/frame backend. A host-owned factory supplies authorization and the profile namespace. */
export async function createDesktopSourceWindowReader(request: DesktopWindowIo['request'], reportError: (error: unknown) => void) {
  const [{ createRecentReader }, { createDiskBodyPageIo }, { readSourceLocator }, { openWindowByteSource },
    { loadReverseIndexTask }, { createReverseIndexScheduler }, { watchFile, unwatchFile }, { join }] = await Promise.all([
    import('@gugu/session-core/session-record/window-cache/recent-reader'),
    import('@gugu/session-core/session-record/window-cache/body-reader'),
    import('@gugu/session-core/session-record/window-cache/source-locator'),
    import('@gugu/session-core/session-record/window-cache/file-source'),
    import('@gugu/session-core/session-record/window-cache/record-locators'),
    import('@gugu/session-core/session-record/window-cache/reverse-index-runner'), import('node:fs'), import('node:path'),
  ]);
  const listeners = new Set<() => void>();
  const scheduler = createReverseIndexScheduler({ onFailure: reportError, onLocated: () => { for (const changed of listeners) changed(); } });
  async function locate(input: WindowReadRequest) {
    const harness = input.locator.harness;
    if (harness !== 'claude' && harness !== 'codex') throw new Error('Unsupported window source');
    const result = await readSourceLocator(input.cacheDirectory, harness, input.locator.providerSessionId, input.budget);
    if (result.kind !== 'hit') throw new Error(`Window source locator unavailable: ${result.reason}`);
    return result.locator;
  }
  function reader(input: WindowReadRequest) {
    return createRecentReader({ body: createDiskBodyPageIo(join(input.cacheDirectory, 'bodies'), async body => {
      const located = await locate(input);
      const source = await openWindowByteSource(located.path);
      try { const current = await source.snapshot(); return current.sourceInstance === body.sourceLineage && current.snapshotRevision === body.revision; }
      finally { await source.close(); }
    }), schedulePending: async (current, snapshot, ticket) => {
      const located = await locate(current);
      const job = { scope: current.scope, sourceLineage: located.sourceLineage, decoderVersion: 1, jobId: ticket.ticket };
      const saved = await loadReverseIndexTask(current.cacheDirectory, job, current.budget);
      if (saved.kind === 'hit' && saved.position.kind === 'located') return;
      const checkpoint = saved.kind === 'hit' ? saved.position.checkpoint : { version: 1 as const, jobId: ticket.ticket,
        sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance, sourceLineage: located.sourceLineage,
        snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size, recordEnd: ticket.sourceFence.end,
        scanBefore: ticket.nextScanOffset, sourceFence: ticket.sourceFence };
      if (checkpoint.sourceInstance !== snapshot.sourceInstance || checkpoint.snapshotRevision !== snapshot.snapshotRevision)
        throw new Error('Reverse locating checkpoint no longer matches this source');
      scheduler.schedule(located.path, checkpoint, current.cacheDirectory, current.scope);
    } });
  }
  const bridge = createDesktopWindowReader({ request,
    openRecent: async input => { await scheduler.pause(); return reader(input).openRecent(input); },
    readOlder: async input => { await scheduler.pause(); return reader(input).readOlder(input); },
    readBody: async input => { await scheduler.pause(); return reader(input).readBody(input); },
    watch: async (_id, changed, input) => {
      const located = await locate(input);
      const notify = () => changed(); listeners.add(notify);
      watchFile(located.path, { persistent: false, interval: 250 }, notify);
      return () => { listeners.delete(notify); unwatchFile(located.path, notify); };
    },
  });
  return { ...bridge, dispose: () => scheduler.dispose() };
}
