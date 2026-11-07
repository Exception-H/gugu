import { BODY_CHUNK_BYTES, BODY_TEXT_BYTES } from './types';
import type { BodyChunkDescriptor, SegmentRef, SourceSnapshot, WindowBodyRef, WindowBodyResult, WindowBudget, WindowByteSource } from './types';

/** A persisted tokenizer checkpoint points inside a JSON string, after its opening quote. */
export type JsonBodyPosition = { rawOffset: number; decodedOffset: number };
export type JsonBodyPage = {
  kind: 'body'; text: string; next: JsonBodyPosition; complete: boolean;
} | { kind: 'reset'; reason: 'source_changed' };

const decoder = new TextDecoder('utf-8', { fatal: true });
const escapes: Record<number, string> = { 34: '"', 92: '\\', 47: '/', 98: '\b', 102: '\f', 110: '\n', 114: '\r', 116: '\t' };
const same = (a: SourceSnapshot, b: SourceSnapshot) => a.sourceId === b.sourceId &&
  a.sourceInstance === b.sourceInstance && a.snapshotRevision === b.snapshotRevision && a.size === b.size;

/** Reads at the checkpoint, never at the record head. The next position is independently seekable. */
export async function readJsonStringBodyPage(source: WindowByteSource, options: {
  snapshot: SourceSnapshot; position: JsonBodyPosition; end: number; maxBytes: number;
  budget: WindowBudget; signal?: AbortSignal;
}): Promise<JsonBodyPage> {
  const { snapshot, position, end, maxBytes, budget, signal } = options;
  if (![position.rawOffset, position.decodedOffset, end, maxBytes].every(Number.isSafeInteger) ||
    position.rawOffset < 0 || position.decodedOffset < 0 || end <= position.rawOffset || end > snapshot.size ||
    maxBytes < 4 || maxBytes > BODY_TEXT_BYTES) throw new RangeError('Invalid body page position');
  signal?.throwIfAborted();
  if (!same(snapshot, await source.snapshot())) return { kind: 'reset', reason: 'source_changed' };
  const length = Math.min(64 * 1024, end - position.rawOffset);
  let bytes: Uint8Array = new Uint8Array(0), used = 0, failed = false, failure: unknown;
  await budget.read('sourceBytes', length, async () => {
    bytes = new Uint8Array(length);
    try {
      while (used < length && !signal?.aborted) {
        const count = await source.read(bytes, used, length - used, position.rawOffset + used);
        if (!Number.isSafeInteger(count) || count < 0 || count > length - used) throw new RangeError('Invalid body read length');
        if (!count) break;
        used += count;
      }
    } catch (error) { failed = true; failure = error; }
    return used;
  });
  if (failed) throw failure;
  signal?.throwIfAborted();
  if (used !== length || !same(snapshot, await source.snapshot())) return { kind: 'reset', reason: 'source_changed' };
  const parts: string[] = [];
  let cursor = 0, decoded = 0, complete = false;
  const unicode = (at: number) => {
    const hex = decoder.decode(bytes.subarray(at, at + 4));
    if (!/^[\da-f]{4}$/i.test(hex)) throw new SyntaxError('Invalid JSON Unicode escape');
    return Number.parseInt(hex, 16);
  };
  while (cursor < length && decoded < maxBytes) {
    signal?.throwIfAborted();
    const byte = bytes[cursor];
    if (byte === 34) { cursor += 1; complete = true; break; }
    if (byte < 32) throw new SyntaxError('Unescaped JSON string control character');
    let width = 1, text: string, output: number;
    if (byte === 92) {
      if (cursor + 2 > length) {
        if (position.rawOffset + length === end) throw new SyntaxError('Incomplete JSON string escape');
        break;
      }
      const escaped = bytes[cursor + 1];
      if (escaped === 117) {
        if (cursor + 6 > length) {
          if (position.rawOffset + length === end) throw new SyntaxError('Incomplete JSON Unicode escape');
          break;
        }
        const high = unicode(cursor + 2);
        width = 6;
        if (high >= 0xd800 && high <= 0xdbff) {
          // Do not split a possible surrogate pair across physical pages.
          if (cursor + 12 > length && position.rawOffset + length < end) break;
          if (cursor + 12 <= length && bytes[cursor + 6] === 92 && bytes[cursor + 7] === 117) {
            const low = unicode(cursor + 8);
            if (low >= 0xdc00 && low <= 0xdfff) {
              text = String.fromCharCode(high, low); width = 12; output = 4;
            } else { text = String.fromCharCode(high); output = 3; }
          } else { text = String.fromCharCode(high); output = 3; }
        } else { text = String.fromCharCode(high); output = high < 128 ? 1 : high < 2048 ? 2 : 3; }
      } else {
        text = escapes[escaped];
        if (text === undefined) throw new SyntaxError('Invalid JSON string escape');
        width = 2; output = 1;
      }
    } else {
      // Coalesce ordinary UTF-8 into one bounded decode instead of one string per byte.
      const start = cursor;
      let span = cursor;
      while (span < length && bytes[span] !== 34 && bytes[span] !== 92 && bytes[span] >= 32) {
        const lead = bytes[span];
        const unit = lead < 128 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (!unit) throw new SyntaxError('Invalid JSON string UTF-8');
        if (span + unit > length) {
          if (position.rawOffset + length === end) throw new SyntaxError('Incomplete JSON string UTF-8');
          break;
        }
        if (decoded + span - start + unit > maxBytes) break;
        span += unit;
      }
      if (span === start) break;
      width = span - start; output = width; text = decoder.decode(bytes.subarray(start, span));
    }
    if (decoded + output > maxBytes) break;
    parts.push(text); decoded += output; cursor += width;
  }
  if (cursor === length && position.rawOffset + cursor === end && !complete)
    throw new SyntaxError('JSON string has no closing quote');
  budget.charge('decodedBytes', decoded);
  budget.charge('outputBytes', decoded);
  signal?.throwIfAborted();
  return { kind: 'body', text: parts.join(''), complete,
    next: { rawOffset: position.rawOffset + cursor, decodedOffset: position.decodedOffset + decoded } };
}

/** Descriptor lookup is a point read by body/revision/ordinal, never a previous-chunk walk. */
export interface BodyPageIo {
  descriptor(body: WindowBodyRef, ordinal: number, budget: WindowBudget): Promise<BodyChunkDescriptor | null>;
  content(ref: SegmentRef, budget: WindowBudget): Promise<Uint8Array>;
}

export async function readIndexedBodyPage(io: BodyPageIo, input: {
  bodyRef: WindowBodyRef; offset: number; maxBytes: number; budget: WindowBudget; signal?: AbortSignal;
}): Promise<WindowBodyResult> {
  const { bodyRef: body, offset, maxBytes, budget, signal } = input;
  const binding = { bodyId: body.id, revision: body.revision };
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > BODY_TEXT_BYTES)
    return { ...binding, kind: 'reset', reason: 'invalid_cursor', io: budget.counters };
  signal?.throwIfAborted();
  if (body.byteLength !== null && offset > body.byteLength) return { ...binding, kind: 'reset', reason: 'invalid_cursor', io: budget.counters };
  const first = Math.floor(offset / BODY_CHUNK_BYTES);
  const count = Math.min(maxBytes, BODY_CHUNK_BYTES, body.byteLength === null ? maxBytes : body.byteLength - offset);
  const last = Math.floor((offset + count - 1) / BODY_CHUNK_BYTES);
  const loaded = new Map<number, Uint8Array>();
  async function load(ordinal: number): Promise<Uint8Array | null> {
    const cached = loaded.get(ordinal);
    if (cached) return cached;
    signal?.throwIfAborted();
    const descriptor = await io.descriptor(body, ordinal, budget);
    if (!descriptor?.content) return null;
    if (descriptor.bodyId !== body.id || descriptor.revision !== body.revision || descriptor.ordinal !== ordinal ||
      descriptor.decodedStart !== ordinal * BODY_CHUNK_BYTES || descriptor.decodedBytes < 1 || descriptor.decodedBytes > BODY_CHUNK_BYTES)
      throw new Error('Body chunk descriptor binding mismatch');
    const bytes = await io.content(descriptor.content, budget);
    if (bytes.length !== descriptor.decodedBytes) throw new Error('Body chunk length mismatch');
    loaded.set(ordinal, bytes); return bytes;
  }
  const chunks: Uint8Array[] = [];
  for (let ordinal = first; ordinal <= last; ordinal += 1) {
    const bytes = await load(ordinal);
    if (!bytes) return { ...binding, kind: 'needs_location', offset, io: budget.counters };
    chunks.push(bytes);
  }
  let previousOffset: number | null = offset === 0 ? null : Math.max(0, offset - BODY_CHUNK_BYTES);
  if (previousOffset !== null && previousOffset > 0) {
    const candidate = previousOffset;
    for (let scanned = 0; scanned <= 3; scanned += 1) {
      const ordinal = Math.floor(previousOffset / BODY_CHUNK_BYTES);
      const bytes = await load(ordinal);
      if (!bytes) return { ...binding, kind: 'needs_location', offset, io: budget.counters };
      const byte = bytes[previousOffset % BODY_CHUNK_BYTES];
      if (byte === undefined) throw new Error('Previous body boundary is outside its chunk');
      if ((byte & 0xc0) !== 0x80) break;
      previousOffset += 1;
    }
    if (previousOffset - candidate > 3 || previousOffset >= offset) throw new Error('Invalid previous UTF-8 boundary');
  }
  if (offset === body.byteLength) return { ...binding, kind: 'body', text: '', offset, nextOffset: offset, previousOffset, moreAfter: 'no', io: budget.counters };
  const available = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(available);
  let written = 0;
  for (const chunk of chunks) { combined.set(chunk, written); written += chunk.length; }
  const start = offset % BODY_CHUNK_BYTES;
  if (start >= available || (combined[start] & 0xc0) === 0x80) return { ...binding, kind: 'reset', reason: 'invalid_cursor', io: budget.counters };
  let end = Math.min(available, start + count);
  // At most three trailing bytes belong to a scalar completed by the next chunk.
  let text: string | undefined;
  for (let removed = 0; removed <= 3 && end > start; removed += 1, end -= 1) {
    try { text = decoder.decode(combined.subarray(start, end)); break; }
    catch (error) { if (removed === 3) throw error; }
  }
  if (text === undefined) throw new Error('Invalid UTF-8 body chunk');
  const length = end - start;
  budget.charge('decodedBytes', length); budget.charge('outputBytes', length);
  signal?.throwIfAborted();
  const nextOffset = offset + length;
  return { ...binding, kind: 'body', text, offset, nextOffset, previousOffset,
    moreAfter: body.byteLength === null ? 'unknown' : nextOffset < body.byteLength ? 'yes' : 'no', io: budget.counters };
}
