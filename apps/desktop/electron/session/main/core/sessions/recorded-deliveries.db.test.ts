import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { buildSessionDirectEnvelope, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return mocks.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { recordedDeliveryIds } from './recorded-deliveries';
import { appendRecordTurnNow, withStoredTurns } from './session-turn-store';

let fixture: Awaited<ReturnType<typeof openFixture>>;
const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
const envelope = (id: string) => buildSessionDirectEnvelope({ senderSessionId: 'sender', senderTitle: 'Peer', messageId: id, content: `body ${id}`, at: '2026-11-09 08:00 UTC+0' });
const deliveryId = (id: string) => readDeliveryEnvelope(envelope(id))!.segments[0].facts!.messageId!;
const pending = (id: string, settled: boolean) => fixture.sqlite.prepare(
  `INSERT INTO messages (id, session_id, content, sender) VALUES (?, 's', ?, 'user');
`.trim()).run(`m-${id}`, envelope(id)) && fixture.sqlite.prepare(
  "INSERT INTO session_pending (session_id, message_id, kind, state, settled_at) VALUES ('s', ?, 'session-direct', ?, ?)",
).run(`m-${id}`, settled ? 'accepted' : 'queued', settled ? '2026-11-09 08:00:00' : null);
const turnWith = (id: string, seq: number): TranscriptTurn => ({ id: `s:turn:${seq}`, seq, initiator: 'user', outcome: { kind: 'done', reason: 'end_turn' },
  items: [{ kind: 'message', id: `s:turn:${seq}:message:u`, seq: 0, role: 'user', text: envelope(id) }] });
const store = (turn: TranscriptTurn) => withStoredTurns('s', () => appendRecordTurnNow('s', turn));

beforeEach(async () => {
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/repo'); INSERT INTO sessions(id,project_id,title) VALUES ('s','p','S');");
});
afterEach(() => { fixture.close(); mocks.db = undefined; });

it('answers for the deliveries still queued to the runtime: received when a stored turn carries one', async () => {
  pending(ids.a, false); pending(ids.b, false);
  await store(turnWith(ids.a, 0));
  expect(await recordedDeliveryIds('s')).toEqual([deliveryId(ids.a)]);
  await store(turnWith(ids.b, 1));
  expect((await recordedDeliveryIds('s')).sort()).toEqual([deliveryId(ids.a), deliveryId(ids.b)].sort());
});

it('reads nothing without a queued delivery, and never answers for a settled one', async () => {
  pending(ids.c, true);
  await store(turnWith(ids.c, 0));
  expect(await recordedDeliveryIds('s')).toEqual([]);
});

it('reads stored rows back only to the oldest queued delivery', async () => {
  // A row stored before the delivery was queued cannot be its turn.
  pending(ids.a, false);
  await store(turnWith(ids.a, 0));
  fixture.sqlite.exec("UPDATE session_turns SET created_at = '2020-01-01 00:00:00'");
  await store(turnWith(ids.b, 1));
  expect(await recordedDeliveryIds('s')).toEqual([]);
});
