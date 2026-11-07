import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowCommitReceipts, type WindowCommitReceipt } from '../session-timeline/window-commit-receipt';
import * as writeHelpers from '../session-timeline/window-commit-write';
import { readWindowCommitSourceChunk } from '../session-timeline/window-commit-source';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({
  get db() { if (!state.db) throw new Error('No fixture DB'); return state.db; },
  get sqlite() { if (!state.sqlite) throw new Error('Unexpected raw SQLite access'); return state.sqlite; },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { events } from '@main/lib/events';
import { persistCommittedTurn } from './session-turn-store';

const cursor = (sequence: number) => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
const turn = (text = 'canonical 😀中文'.repeat(10000)): TranscriptTurn => ({
  id: 'runtime:0', seq: 0, referenceId: 'source:real', initiator: 'user', outcome: { kind: 'done' },
  items: [{ kind: 'message', id: 'runtime:0:item', seq: 0, role: 'assistant', text }],
});

describe('actual canonical writer capture', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, root: string;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    root = await mkdtemp(join(tmpdir(), 'canonical-source-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (root) await rm(root, { recursive: true, force: true }); });
  const settled = () => vi.mocked(events.emit).mock.calls.filter(([channel]) => channel.name === 'session:turn-settled').map(([, value]) => (value as { status: string }).status);
  function capture(sequence: number, phases: string[], completed: (receipt: WindowCommitReceipt | null) => Promise<void> = async () => {}) {
    return { directory: root, scope: 'a'.repeat(64), cursor: cursor(sequence),
      phase(name: 'source_durable' | 'canonical_committed', receipt: WindowCommitReceipt) {
        phases.push(name);
        const present = createWindowCommitReceipts(fixture.sqlite).byRow(receipt.rowId);
        expect(present?.sourceId ?? null).toBe(name === 'source_durable' ? null : receipt.sourceId);
      }, committed: completed };
  }

  it('reuses one serialized canonical value, commits its receipt in the row transaction and leaves final projection publication to the owner', async () => {
    const phases: string[] = [], original = JSON.stringify; let serializations = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
      if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) serializations++;
      return Reflect.apply(original, JSON, [value, ...rest]) as string;
    }) as typeof original);
    const committed = vi.fn(async (receipt: WindowCommitReceipt | null) => {
      expect(settled()).toEqual(['persisted']); expect(receipt).not.toBeNull();
      const row = fixture.sqlite.prepare('SELECT data FROM session_turns WHERE id=?').get(receipt!.rowId) as { data: string };
      expect(createHash('sha256').update(row.data).digest('hex')).toBe(receipt!.source.sha256);
      const bytes = await readWindowCommitSourceChunk(root, receipt!.binding, receipt!.source, 0, createWindowBudget());
      expect(bytes).toEqual(Buffer.from(row.data).subarray(0, bytes.length)); phases.push('owner-publication');
    });
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn(), windowCapture: capture(3, phases, committed) });
    expect(phases).toEqual(['source_durable', 'canonical_committed', 'owner-publication']);
    expect(serializations).toBe(1); expect(committed).toHaveBeenCalledTimes(1);
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')).toMatchObject({ rowId: 'c:0', storedSeq: 0, firstCommitCursor: cursor(3) });
  });

  it('rolls the actual canonical insert back when receipt insertion fails, and never calls the publication callback', async () => {
    const phases: string[] = [], committed = vi.fn(async () => {});
    vi.spyOn(writeHelpers, 'commitWindowReceipt').mockImplementationOnce(() => { throw new Error('receipt insertion failed'); });
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('rollback'), windowCapture: capture(3, phases, committed) })).rejects.toThrow('receipt insertion failed');
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
    expect(committed).not.toHaveBeenCalled(); expect(phases).toEqual(['source_durable']); expect(settled()).toEqual(['failed']);
  });

  it('updates the same real stored row while keeping the first cursor and previous immutable source', async () => {
    const receipts: WindowCommitReceipt[] = [], completed = async (receipt: WindowCommitReceipt | null) => { if (receipt) receipts.push(receipt); };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('first'), windowCapture: capture(3, [], completed) });
    const revisionCapture = capture(10, [], completed); delete (revisionCapture as Partial<typeof revisionCapture>).phase;
    await persistCommittedTurn({ sessionId: 'c', source: 'revision', turn: turn('revised 😀'), windowCapture: revisionCapture });
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([{ id: 'c:0' }]);
    const latest = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!;
    expect(latest.firstCommitCursor).toEqual(cursor(3)); expect(latest.latestRevisionCursor).toEqual(cursor(10));
    expect(latest.rowId).toBe(receipts[0].rowId); expect(latest.sourceId).not.toBe(receipts[0].sourceId);
    const old = await readWindowCommitSourceChunk(root, receipts[0].binding, receipts[0].source, 0, createWindowBudget());
    expect(new TextDecoder().decode(old)).toContain('first');
    expect(JSON.parse((fixture.sqlite.prepare('SELECT data FROM session_turns').get() as { data: string }).data).items[0].text).toBe('revised 😀');
  });

  it('keeps canonical settlement persisted when later projection publication fails', async () => {
    const phases: string[] = [];
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('kept'),
      windowCapture: capture(3, phases, async () => { throw new Error('projection failed'); }) })).rejects.toThrow('projection failed');
    expect(settled()).toEqual(['persisted']);
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')).not.toBeNull();
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
  });

  it('leaves uncaptured legacy writes on the existing DB gateway without touching new receipt storage', async () => {
    state.sqlite = undefined;
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('legacy') });
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
  });

  it('captures the event cursor before awaiting the existing canonical writer queue', async () => {
    const observer = capture(3, []);
    const pending = persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('cursor'), windowCapture: observer });
    observer.cursor.sequence = 99; await pending;
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!.latestRevisionCursor).toEqual(cursor(3));
  });
});
