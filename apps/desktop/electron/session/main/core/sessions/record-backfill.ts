import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createHash } from 'node:crypto';
import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { indexHermesPrompts, originalHermesPrompt } from '@gugu/session-core/acp/hermes-prompt';
import { hashIdentity, identify, matchAfterStore, matchAfterStoreAt, recordIdentityFor, type Identity, type RecordIdentity } from './record-backfill-match';
import { ELIDED_PICTURE, type PictureFilter } from '@gugu/session-core/session-record/picture-elider';
import { appendRecordTurnNow, readUnfinishedRecordRowsNow, reviseRecordTurnNow, storedHeadNow, storedTurnsNewestFirstNow, withStoredTurns } from './session-turn-store';
import { sessionEngine, sessionProcess } from './session-process';

export type RecordBackfillResult = {
  inserted: number;
  status: 'complete' | 'active' | 'settling' | 'unavailable' | 'unsupported' | 'diverged' | 'cancelled' | 'runtime-changed';
};

/** What the last fill saw: the record's stamp and the store's newest row, so an unchanged session is not read at all. */
type Stamp = { record: string; storeHead: number; lastSettled: boolean; cursor?: Cursor };
const stamps = new KV<Record<string, Stamp>>('record-stamp');

/** Store rows whose identities a fill reads up front: the widest window matched before resume-tail. */
const STORE_WINDOW = 200;
/** Pictures copied into the store by one fill (as before resume-tail); past it a picture keeps only its size. */
const FILL_PICTURE_CHARS = 256 * 1024 * 1024;

const digest = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 16);

/**
 * #980 把 agent 自己的记录里有、库里(`session_turns`)还没有的那几轮补进库。
 *
 * 会话页的历史以 agent 自己的记录为准,库只是缓存:编程模式(终端)里跑的轮、在咕咕外面直接用命令跑的轮、
 * #5381 之前建的会话(库是空的),都只在记录里。从前它们靠「重放 + 按条数对齐」补进来 —— 条数在压缩、失败的轮
 * 之后就对不齐;而接回会话已经不再重放。
 *
 * 新轮只接在库尾;同一条记录轮的迟到答复在原行更新,不改它的库内顺序/引用。
 * 本次改动之前就漏在中间的那些轮(老会话里早年在终端跑过的)不补 —— 接在末尾会把次序打乱,比缺着更糟。
 *
 * resume-tail: the fill reads only the gap. An unchanged record (its stamp) is not read at all. Otherwise it is decoded
 * from the cursor the last fill left (where a turn starts in the record, and that turn's stored row), or from its
 * beginning when there is none or the record no longer shows it: both sides start at the same turn, so matching is the
 * same as over the whole record. One pass finds the anchor from turn identities alone, a second writes the turns after
 * it as they stream. Settled turns never accumulate: memory is the open turns and one turn, whatever the record's size.
 */
export async function syncStoredHistoryFromRecord(sessionId: string, options: { signal?: AbortSignal; runtime?: 'pty' } = {}): Promise<RecordBackfillResult> {
  const { readSessionRow, locateRow } = await import('@main/core/session-timeline/service');
  const { createSessionRecordSource } = await import('@gugu/session-core/session-record');
  const { readRecordFrom } = await import('@gugu/session-core/session-record/fill-read');
  return withStoredTurns(sessionId, async () => {
    const result = (status: RecordBackfillResult['status'], inserted = 0): RecordBackfillResult => ({ inserted, status });
    if (options.signal?.aborted) return result('cancelled');
    // Runtime and record identity are read inside the same queue as live writes, never from a pre-queue snapshot.
    const row = readSessionRow(sessionId, { includeArchived: true });
    if (!row) return result('unavailable');
    if (options.runtime === 'pty' && row.runtime === 'acp') return result('runtime-changed');
    const harness = sessionRecordHarnessForProvider(row.provider);
    const identity = recordIdentityFor(harness);
    if (!identity) return result('unsupported');
    if (!row.providerSessionId) return result('unavailable');
    if (row.runtime === 'acp') {
      const { acpSessionLive } = await import('@main/core/session-timeline/write-bridge');
      if (await acpSessionLive(sessionId)) return result('active');
    }
    const current = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      return latest && latest.runtime === row.runtime && latest.provider === row.provider
        && latest.providerSessionId === row.providerSessionId;
    };
    const active = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      if (!latest || latest.archivedAt) return false;
      const status = parseAgentStatus(latest.agentStatus);
      return isAgentActive(status ? { status } : null) || (!status && sessionProcess(sessionId) !== null);
    };
    // End metadata is not a liveness signal: a stopped/crashed terminal can retain an unfinished last turn.
    const committedOnly = row.runtime !== 'acp' && active();
    // A terminal reports idle before its buffered record write lands. While its engine runs (owned, or in tmux and
    // not yet reattached after a restart), an unsettled last turn is still being written; once it is gone, the record is final.
    const finish = async (inserted: number, complete: boolean, lastSettled: boolean) => {
      if (inserted > 0) log.info('[record-backfill] filled in turns from the record', { sessionId, inserted });
      if (!current()) return result('runtime-changed', inserted);
      if (!complete || active()) return result('active', inserted);
      return result(row.runtime !== 'acp' && !lastSettled && await sessionEngine(sessionId) !== 'gone' ? 'settling' : 'complete', inserted);
    };

    const location = locateRow(row);
    if (!location.supported) return result('unavailable');
    const parentId = row.config?.forkedFrom?.sessionId;
    const parentRow = parentId ? readSessionRow(parentId, { includeArchived: true }) : null;
    const parentLocation = parentRow ? locateRow(parentRow) : null;
    if (parentId && !parentLocation?.supported) return result('diverged');

    // Unchanged record and store: nothing can be missing.
    const probe = createSessionRecordSource(location.locator);
    // A record the live mode cannot stamp (a `.zst` archive) is stamped as the snapshot read sees it; no stamp = read it.
    const stampOf = (source: typeof probe) => source.stamp ? source.stamp().catch(() => null) : Promise.resolve(null);
    const stamp = await stampOf(probe) ?? await stampOf(createSessionRecordSource(location.locator, { readMode: 'snapshot' }));
    const head = storedHeadNow(sessionId);
    const saved = await stamps.get(sessionId);
    if (stamp && saved && saved.record === stamp && saved.storeHead === head && !committedOnly) return finish(0, true, saved.lastSettled);

    // Identities of the store's newest rows, one row at a time (a row can hold megabytes of pictures); Hermes prompts are
    // matched by the receipts in those rows' messages.
    const storeIdentities = (limit: number, atLeast = 0) => {
      const rows: Array<{ seq: number; identity: Identity }> = [];
      const messages: TranscriptTurn['items'] = [];
      for (const one of storedTurnsNewestFirstNow(sessionId, limit, atLeast)) {
        rows.push({ seq: one.seq, identity: hashIdentity(identify(one.turn), digest) });
        if (harness === 'hermes') messages.push(...one.turn.items.filter(item => item.kind === 'message'));
      }
      return { rows, messages };
    };
    const window = storeIdentities(STORE_WINDOW);
    const hermes = harness === 'hermes' ? indexHermesPrompts(window.messages) : undefined;
    const unfinished = readUnfinishedRecordRowsNow(sessionId).map(one => ({ seq: one.seq, identity: hashIdentity(identify(one.turn), digest) }));
    let parentLineage: Awaited<ReturnType<typeof readRecordFrom>>['lineage'] | undefined;

    try {
      if (parentRow && parentLocation?.supported) {
        // A fork proves its parent's prefix once, by a snapshot read of the parent; nothing of it is kept.
        const parent = await readRecordFrom({ locator: parentLocation.locator, sessionId: parentRow.id, position: 0, snapshot: true, pictures: NO_PICTURES, onSettled: () => {} });
        parentLineage = parent.lineage ?? undefined;
        if (!parentLineage?.length) return result('diverged');
      }

      // First pass: turn identities and where each turn starts, no picture decoded; from the cursor, else the beginning.
      const scan = async (position: number) => {
        const seen: Identity[] = [];
        const starts: Array<number | null> = [];
        let unreceipted = false;
        const take = (turn: TranscriptTurn, start: number | null) => {
          if (hermes && turn.items.some(item => item.kind === 'message' && item.role === 'user' && originalHermesPrompt(item.text, hermes) === null)) unreceipted = true;
          seen.push(hashIdentity(identify(turn, hermes), digest));
          starts.push(start);
        };
        const read = await readRecordFrom({ locator: location.locator, sessionId, position, ...(parentLineage ? { parentLineage } : {}),
          pictures: NO_PICTURES, onSettled: (turns, _from, at) => turns.forEach((turn, index) => take(turn, at[index])) });
        const prefix = committedOnly && read.tail.length > read.committed ? read.tail.slice(0, read.committed) : read.tail;
        prefix.forEach((turn, index) => take(turn, read.tailStarts[index]));
        return { seen, starts, unreceipted, from: read.from, complete: prefix.length === read.tail.length, lastSettled: !!prefix.at(-1)?.outcome };
      };
      let plan: Plan | null = null;
      const cursor = !parentLineage && saved?.cursor ? saved.cursor : null;
      if (cursor) {
        // From the cursor both sides start at the same turn: what follows it is matched against the rows from its seq on.
        const scanned = await scan(cursor.position);
        if (options.signal?.aborted) return result('cancelled');
        if (scanned.unreceipted) return result('diverged');
        const since = storeIdentities(Number.MAX_SAFE_INTEGER, cursor.seq).rows;
        const first = since.at(-1);
        if (scanned.from === cursor.position && first?.seq === cursor.seq && scanned.seen.length
          && matchAfterStoreAt(scanned.seen.slice(0, 1), [first.identity], identity)?.anchor) {
          const found = matchPlan(scanned.seen, since, unfinished, identity, true);
          if (found === 'diverged') return result('diverged');
          if (found) plan = { ...found, from: cursor.position, starts: scanned.starts, complete: scanned.complete, lastSettled: scanned.lastSettled };
        }
        // A cursor the record no longer shows (replaced, rewritten) is dropped: match as if there were none.
      }
      if (!plan) {
        const scanned = await scan(0);
        if (options.signal?.aborted) return result('cancelled');
        // A record turn whose Hermes prompt the store cannot vouch for: the two diverged (as before).
        if (scanned.unreceipted) return result('diverged');
        let found = matchPlan(scanned.seen, window.rows, unfinished, identity, window.rows.length < STORE_WINDOW);
        // The store's newest rows are still ambiguous: compare against every stored row (as before).
        if (found === null && window.rows.length >= STORE_WINDOW) found = matchPlan(scanned.seen, storeIdentities(Number.MAX_SAFE_INTEGER).rows, unfinished, identity, true);
        if (found === null) log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
        if (found === null || found === 'diverged') return result('diverged');
        plan = { ...found, from: scanned.from, starts: scanned.starts, complete: scanned.complete, lastSettled: scanned.lastSettled };
      }

      // Second pass: the same start; turns after the anchor are written as they stream. Only their pictures are decoded,
      // within the budget (as before); the others keep their size. The newest settled turn whose stored row is known
      // becomes the next fill's cursor.
      let inserted = 0, index = 0;
      const pictures = writtenPictures(plan, FILL_PICTURE_CHARS);
      let next: Cursor | null = null;
      const write = (turn: TranscriptTurn, start: number | null) => {
        const at = index++;
        // An open turn changes identity as it completes: it could not be recognized at the cursor.
        const known = (seq: number) => { if (start !== null && turn.outcome) next = { position: start, seq }; };
        const seq = plan!.revise.get(at);
        if (seq === undefined && !plan!.append(at)) {
          if (plan!.anchor?.seen === at) known(plan!.anchor.seq);
          return;
        }
        if (options.signal?.aborted) throw new FillStopped('cancelled');
        if (!current()) throw new FillStopped('runtime-changed');
        // If a new turn started during an idle snapshot, leave its unproved suffix for the settled edge.
        if (row.runtime !== 'acp' && !committedOnly && active()) throw new FillStopped('active');
        const kept = elidedAsRefs(turn);
        if (seq !== undefined) { reviseRecordTurnNow(sessionId, seq, kept); known(seq); }
        else { known(appendRecordTurnNow(sessionId, kept)); inserted++; }
      };
      try {
        const read = await readRecordFrom({ locator: location.locator, sessionId, position: plan.from, ...(parentLineage ? { parentLineage } : {}),
          pictures, onSettled: (turns, _from, starts) => turns.forEach((turn, at) => write(turn, starts[at])) });
        if (read.from !== plan.from) throw new Error('record-backfill: the second pass started elsewhere than the first');
        const held = committedOnly && read.tail.length > read.committed ? read.committed : read.tail.length;
        for (let at = 0; at < held; at += 1) write(read.tail[at], read.tailStarts[at]);
      } catch (error) {
        if (error instanceof FillStopped) return result(error.status, inserted);
        throw error;
      }
      if (inserted < plan.appended) log.warn('[record-backfill] fewer turns than planned', { sessionId, planned: plan.appended, inserted });
      const done = await finish(inserted, plan.complete, plan.lastSettled);
      // The cursor holds whatever the status; the stamp lets the next fill skip the record only once this one completed.
      const kept = next ?? (cursor && plan.from === cursor.position ? cursor : null);
      await stamps.setOrThrow(sessionId, { record: done.status === 'complete' && stamp ? stamp : '', storeHead: storedHeadNow(sessionId),
        lastSettled: plan.lastSettled, ...(kept ? { cursor: kept } : {}) });
      return done;
    } catch (error) {
      log.warn('[record-backfill] record unreadable', { sessionId, error: (error as Error)?.message ?? String(error) });
      if ((error as Error)?.name === 'SessionRecordNotFoundError') return result('unavailable');
      if ((error as Error)?.name === 'SessionRecordForkDivergedError') return result('diverged');
      return result('unavailable');
    } finally {
      probe.stop();
    }
  });
}

class FillStopped extends Error {
  constructor(readonly status: RecordBackfillResult['status']) { super(status); }
}

type Plan = {
  from: number;
  /** Record turn (index from `from`) → the unfinished store row it completes. */
  revise: Map<number, number>;
  /** Whether a record turn is appended: the matched ones, and any the record grew by between the passes. */
  append: (index: number) => boolean;
  appended: number;
  /** Where each turn read (index from `from`) starts in the record; null where the source does not say. */
  starts: Array<number | null>;
  /** The newest record turn recognized as a stored row, and that row's seq. */
  anchor: { seen: number; seq: number } | null;
  complete: boolean;
  lastSettled: boolean;
};

/** Where the next fill starts: a record position and the stored row of the turn that starts there. */
type Cursor = { position: number; seq: number };

/**
 * The store's rows (newest first) matched against the record turns read (`matchAfterStore`, the windows of before);
 * `null` = they do not anchor. Both sides start together: the record from its beginning, or from the cursor's turn and
 * the store from its row, never from inside the record (content identities could not tell new turns from stored ones
 * they repeat).
 */
function matchPlan(
  seen: Identity[],
  stored: Array<{ seq: number; identity: Identity }>,
  unfinished: Array<{ seq: number; identity: Identity }>,
  identity: RecordIdentity,
  storeComplete: boolean,
): Omit<Plan, 'from' | 'starts' | 'complete' | 'lastSettled'> | 'diverged' | null {
  const revise = new Map<number, number>();
  for (let at = 0; at < seen.length; at += 1) {
    const hits = unfinished.filter(one => matchAfterStore([seen[at]], [one.identity], identity)?.length === 0);
    if (hits.length > 1) return 'diverged';
    if (hits.length === 1) revise.set(at, hits[0].seq);
  }
  let matched: ReturnType<typeof matchAfterStoreAt> = null;
  let rows = stored;
  if (seen.length === 0) matched = { missing: [], anchor: null };
  else {
    const windows = identity === 'content' ? [10, 50, 200, Number.MAX_SAFE_INTEGER] : [10, 50, 200];
    for (const limit of windows) {
      rows = stored.slice(0, limit);
      matched = matchAfterStoreAt(seen, rows.map(row => row.identity), identity,
        { hasOlderStoredTurns: rows.length === limit || (!storeComplete && rows.length === stored.length) });
      if (matched !== null || rows.length < limit) break;
    }
  }
  if (matched === null) return null;
  const append = new Set(matched.missing.filter(at => !revise.has(at)));
  return {
    revise, appended: append.size,
    anchor: matched.anchor ? { seen: matched.anchor.seen, seq: rows[matched.anchor.stored].seq } : null,
    append: (index) => append.has(index) || index >= seen.length,
  };
}

const NO_PICTURES: PictureFilter = { keep: () => false, kept: () => {} };

/**
 * The second pass decodes a picture only when it lies in a turn the fill writes (by the turn starts the first pass
 * saw) and the budget still has room, as before resume-tail. Turns with no start keep theirs within the budget.
 */
function writtenPictures(plan: Plan, budget: number): PictureFilter {
  const known = plan.starts.flatMap((start, index) => start === null ? [] : [{ start, index }]);
  const turnAt = (at: number) => {
    let low = 0, high = known.length;
    while (low < high) { const mid = (low + high) >> 1; if (known[mid].start <= at) low = mid + 1; else high = mid; }
    return low === 0 ? null : known[low - 1].index;
  };
  let left = budget;
  return {
    keep(at) {
      if (left <= 0) return false;
      const index = turnAt(at);
      return index === null || plan.revise.has(index) || plan.append(index);
    },
    kept(chars) { left -= chars; },
  };
}

/** A picture the second pass left undecoded keeps only its size (`imageRefs`), as the transport projections show it. */
function elidedAsRefs(turn: TranscriptTurn): TranscriptTurn {
  const visit = (items: TranscriptTurn['items']): TranscriptTurn['items'] => {
    let changed = false;
    const next = items.map((item) => {
      const node = item as unknown as { images?: Array<{ mimeType: string; data: string }>; children?: TranscriptTurn['items'] };
      let out = item;
      if (node.images?.some(image => image.data.startsWith(ELIDED_PICTURE))) {
        const { images, ...rest } = node;
        out = { ...rest, imageRefs: images.map(({ mimeType, data }) => ({ mimeType,
          chars: data.startsWith(ELIDED_PICTURE) ? Number(data.slice(ELIDED_PICTURE.length)) : data.length })) } as unknown as typeof item;
      }
      const children = (out as typeof node).children;
      const kept = children ? visit(children) : children;
      if (kept !== children) out = { ...out, children: kept } as typeof item;
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : items;
  };
  const items = visit(turn.items);
  return items === turn.items ? turn : { ...turn, items };
}
