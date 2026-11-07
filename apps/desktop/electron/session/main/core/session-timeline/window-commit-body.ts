import { decodeJsonStringBodyBytes, type JsonBodyPosition } from '@gugu/session-core/session-record/window-cache/body-reader';
import type { WindowFrameKey } from '@gugu/session-core/session-record/window-cache/frame';
import { BODY_TEXT_BYTES, type WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { assertWindowCommitSource, readWindowCommitSourceChunk, type WindowCommitSourceManifest } from './window-commit-source';

const CHUNK = 16 * 1024;

/** Read a proven JSON string range, with positions in the immutable serialized
 * source. Receipt/slot authorization belongs to the caller, not this decoder.
 * At most two physical frames are read; all bytes remain indexBytes. */
export async function readWindowCommitStringPage(directory: string,
  binding: Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'>, source: WindowCommitSourceManifest, options: {
    range: { start: number; end: number }; position: JsonBodyPosition; maxBytes: number; budget: WindowBudget; signal?: AbortSignal;
  }) {
  const { range, position, maxBytes, budget, signal } = options;
  if (![range.start, range.end, position.rawOffset, position.decodedOffset, maxBytes].every(Number.isSafeInteger) ||
    range.start < 1 || range.end <= range.start || range.end > source.bytes ||
    position.rawOffset < range.start || position.rawOffset >= range.end || position.decodedOffset < 0 ||
    position.decodedOffset > position.rawOffset - range.start ||
    maxBytes < 4 || maxBytes > BODY_TEXT_BYTES) throw new RangeError('Invalid commit string position');
  signal?.throwIfAborted();
  const length = Math.min(CHUNK, range.end - position.rawOffset), first = Math.floor(position.rawOffset / CHUNK);
  const last = Math.floor((position.rawOffset + length - 1) / CHUNK);
  const chunks: Uint8Array[] = [];
  for (let ordinal = first; ordinal <= last; ordinal++)
    chunks.push(await readWindowCommitSourceChunk(directory, binding, source, ordinal, budget, signal));
  const bytes = new Uint8Array(length);
  let written = 0;
  for (let at = 0; at < chunks.length; at++) {
    const offset = at === 0 ? position.rawOffset % CHUNK : 0;
    const part = chunks[at].subarray(offset, offset + length - written);
    bytes.set(part, written); written += part.length;
  }
  if (written !== length) throw new Error('Incomplete commit string span');
  const page = decodeJsonStringBodyBytes(bytes, { position, end: range.end, maxBytes, budget, signal });
  if (page.complete && page.next.rawOffset !== range.end) throw new Error('Commit string range mismatch');
  await assertWindowCommitSource(directory, binding, source);
  signal?.throwIfAborted();
  return page;
}
