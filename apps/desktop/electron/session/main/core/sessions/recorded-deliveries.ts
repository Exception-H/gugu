import { and, eq, isNull } from 'drizzle-orm';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { messages, sessionPending } from '@main/db/schema';
import { storedTurnsNewestFirstNow, withStoredTurns } from './session-turn-store';

/**
 * #980 Which of the deliveries a resumed runtime may still hold were already received by the agent (resume-tail).
 *
 * The runtime asks this only of the deliveries it has queued (`cell.ts` `reconcileReplayedQueue`), and every delivery
 * enters it through the host's durable queue (`session_pending`), so the candidates are that queue's unsettled rows.
 * The answer is exact for them: a candidate is received when a stored turn carries it. The fill that runs just before
 * copies the record's missing turns into the store, so the store answers for the record too. Stored rows are read newest
 * first, one at a time, and only back to the oldest candidate's enqueue time.
 */
export async function recordedDeliveryIds(sessionId: string): Promise<string[]> {
  const pending = db.select({ text: messages.content, enqueuedAt: sessionPending.enqueuedAt }).from(sessionPending)
    .innerJoin(messages, eq(messages.id, sessionPending.messageId))
    .where(and(eq(sessionPending.sessionId, sessionId), isNull(sessionPending.settledAt))).all();
  const candidates = new Set(pending.flatMap(row => deliveryIdsOf(row.text)));
  if (!candidates.size) return [];
  const since = Math.min(...pending.map(row => sqliteTime(row.enqueuedAt)));
  return withStoredTurns(sessionId, async () => {
    const received = new Set<string>();
    for (const { turn, createdAt } of storedWithTimes(sessionId)) {
      // Second-precision times: a row from the same second as the oldest enqueue is still read.
      if (createdAt < since - 1000) break;
      for (const id of turnDeliveryIds(turn)) if (candidates.has(id)) received.add(id);
      if (received.size === candidates.size) break;
    }
    return [...received];
  });
}

function* storedWithTimes(sessionId: string): Generator<{ turn: TranscriptTurn; createdAt: number }> {
  for (const one of storedTurnsNewestFirstNow(sessionId)) yield { turn: one.turn, createdAt: sqliteTime(one.createdAt) };
}

const deliveryIdsOf = (text: string): string[] =>
  readDeliveryEnvelope(text)?.segments.flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId] : []) ?? [];

function turnDeliveryIds(turn: TranscriptTurn): string[] {
  return turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? deliveryIdsOf(item.text) : []);
}

/** SQLite's `CURRENT_TIMESTAMP` is UTC without a zone; rows a migration moved carry an ISO time. */
const sqliteTime = (value: string) => Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
