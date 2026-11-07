import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import { EventStreamSource } from '@gugu/session-wire';
import { bindWindowCommitProjection, connectWindowCommitHost, reserveWindowCommitHost } from './window-commit-host';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { readWindowCommitSourceChunk } from './window-commit-source';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowCommittedEvent } from './window-commit-tap';
import { events as hostEvents } from '@main/lib/events';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined, root: '' }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));

describe('the main-process commit host and actual canonical writer', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, connected: Awaited<ReturnType<typeof connectWindowCommitHost>> | undefined;
  const source = () => new EventStreamSource<WindowCommittedEvent>({ generation: 21 });
  const stream = (events: ReturnType<typeof source>) => ({ snapshot: async () => events.snapshot(), attach: async (push: Parameters<typeof events.subscribe>[0]) => events.subscribe(push) });
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    state.root = await mkdtemp(join(tmpdir(), 'commit-host-'));
  });
  afterEach(async () => {
    // Close the test source even when a test only reserved a cold host.
    connected ??= await connectWindowCommitHost(stream(source()), () => {}); connected.close(); connected = undefined;
    fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(state.root, { recursive: true, force: true }); vi.clearAllMocks();
  });

  it('registers before worker availability, persists one real event and withholds delivery until projection completion', async () => {
    const events = source(), observed = vi.fn(), failed = vi.fn(), durable = Promise.withResolvers<void>();
    const projection = Promise.withResolvers<{ projectionId: string }>();
    bindWindowCommitProjection(async receipt => {
      expect(createWindowCommitReceipts(fixture.sqlite).byRow(receipt.rowId)?.sourceId).toBe(receipt.sourceId);
      const raw = await readWindowCommitSourceChunk(join(state.root, 'session-window-cache', 'committed'), receipt.binding, receipt.source, 0, createWindowBudget());
      expect(new TextDecoder().decode(raw)).toContain('whole cold turn'); durable.resolve(); return projection.promise;
    });
    const owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    expect(events.subscriberCount).toBe(0); expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    connected = await connectWindowCommitHost(stream(events), observed);
    const actual: WindowCommittedEvent = { sessionId: 'c', providerId: 'claude', platformCredentials: false, source: 'live', turn: {
      id: 'actual-turn', seq: 0, referenceId: 'actual-ref', initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'actual-item', seq: 0, role: 'assistant', text: 'whole cold turn' }],
    } };
    const received = vi.fn(), reading = owner.read(after).then(received); events.emit(actual); await durable.promise;
    expect(observed).toHaveBeenCalledExactlyOnceWith(actual); expect(received).not.toHaveBeenCalled();
    projection.resolve({ projectionId: 'deferred-producer-test' }); await reading;
    expect(received.mock.calls[0][0].entries[0]).toMatchObject({ rowId: 'c:0', storedSeq: 0, referenceId: 'actual-ref' });
    owner.ack(received.mock.calls[0][0].next); expect(failed).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
  });

  it('rejects new handoff reservations without a durable producer rather than declaring a successful empty view', () => {
    expect(() => reserveWindowCommitHost('view', 'c', vi.fn())).toThrow(expect.objectContaining({ code: 'live_projection_unavailable' }));
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
  });

  it('awaits source attachment before releasing the worker boundary and fails a cold owner on setup failure', async () => {
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed); await owner.prepare();
    const attachment = Promise.withResolvers<() => void>(), entered = Promise.withResolvers<void>(), returned = vi.fn();
    const connecting = connectWindowCommitHost({ snapshot: async () => source().snapshot(), attach: () => { entered.resolve(); return attachment.promise; } }, () => {}).then(returned);
    await entered.promise; expect(returned).not.toHaveBeenCalled();
    attachment.reject(new Error('private attach failed')); await expect(connecting).rejects.toThrow('private attach failed');
    expect(failed).toHaveBeenCalledTimes(1); owner.close();
  });

  it('fails bounded owners when cache initialization fails while keeping ordinary canonical writes available', async () => {
    await writeFile(join(state.root, 'session-window-cache'), 'not a directory');
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    const rejected = expect(owner.read(after)).rejects.toMatchObject({ code: 'live_store_changed' });
    const actual = source(); connected = await connectWindowCommitHost(stream(actual), () => {}); await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => reserveWindowCommitHost('next', 'c', vi.fn())).toThrow(expect.objectContaining({ code: 'live_projection_unavailable' }));
    const settled = Promise.withResolvers<void>();
    vi.mocked(hostEvents.emit).mockImplementation(channel => { if (channel.name === 'session:turn-settled') settled.resolve(); });
    actual.emit({ sessionId: 'c', source: 'live', turn: { id: 'real', seq: 0, referenceId: 'actual-ref', initiator: 'user', items: [], outcome: { kind: 'done' } } });
    await settled.promise;
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
  });

  it('reports worker disappearance once while explicit view cancellation remains silent', async () => {
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), cancelled = vi.fn(), a = reserveWindowCommitHost('one', 'c', failed), b = reserveWindowCommitHost('two', 'c', cancelled);
    const after = await a.prepare(); await b.prepare(); a.authorize(); b.close();
    connected = await connectWindowCommitHost(stream(source()), () => {});
    const rejected = expect(a.read(after)).rejects.toMatchObject({ code: 'live_source_gap' });
    connected.close(); await rejected;
    expect(failed).toHaveBeenCalledTimes(1); expect(cancelled).not.toHaveBeenCalled();
  });
});
