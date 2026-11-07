import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readWindowFrame, writeWindowFrame, syncWindowDirectory } from './disk-frame';
import type { SourceRange, SourceSnapshot, WindowByteSource, WindowReadRequest } from './types';

type Frame = { path: string[]; array: boolean; key: string; index: number; state: 'key' | 'colon' | 'value' | 'comma' };
type Token = { kind: 'key' | 'metadata' | 'skip' | 'candidate'; raw: string | null; escaped: boolean; start: number; path: string[] };
type State = { version: 1; offset: number; stack: Frame[]; token: Token | null; skipDepth: number;
  skipString: boolean; skipEscape: boolean; primitive: boolean; metadata: Record<string, unknown> };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function metadataPath(path: string[]) {
  return path.length === 1 && ['uuid', 'parentUuid', 'type'].includes(path[0]) ||
    path.length === 2 && ['message', 'payload'].includes(path[0]) && ['id', 'type', 'role'].includes(path[1]);
}
function bodyPath(path: string[], provider: string) {
  if (path[0] !== (provider === 'claude' ? 'message' : 'payload')) return false;
  return path.length === 2 && ['content', 'message', 'output', 'arguments'].includes(path[1]) ||
    path[1] === 'content' && ['text', 'thinking', 'content'].includes(path.at(-1)!) &&
      (path.length === 4 || path.length === 5 && path[3] === 'input' || path.length === 6 && path[3] === 'content');
}
function enter(path: string[], provider: string) {
  if (!path.length) return true;
  if (path[0] !== (provider === 'claude' ? 'message' : 'payload')) return false;
  return path.length === 1 || path[1] === 'content' &&
    (path.length === 2 || path.length === 3 || path.length === 4 && ['content', 'input'].includes(path[3]) ||
      path.length === 5 && path[3] === 'content');
}
function advance(state: State, bytes: Uint8Array, start: number, provider: string): number | null {
  const consumed = () => { const frame = state.stack.at(-1); if (frame) { frame.state = 'comma'; if (frame.array) frame.index += 1; } };
  const path = () => { const frame = state.stack.at(-1); return frame ? [...frame.path, frame.array ? String(frame.index) : frame.key] : []; };
  for (let at = 0; at < bytes.length; at += 1) {
    const byte = bytes[at]; state.offset = start + at + 1;
    if (state.token) {
      const token = state.token;
      if (token.kind === 'candidate') {
        if (byte !== 34) return token.start; // Nonempty body; no body bytes are accumulated here.
        state.token = null; consumed(); continue;
      }
      if (!token.escaped && byte === 34) {
        if (token.raw !== null) {
          const value = JSON.parse(utf8.decode(Buffer.from('"' + token.raw + '"', 'latin1'))) as string;
          if (token.kind === 'key') { const frame = state.stack.at(-1)!; frame.key = value; frame.state = 'colon'; }
          else if (token.kind === 'metadata') {
            if (token.path.length === 1) state.metadata[token.path[0]] = value;
            else ((state.metadata[token.path[0]] ??= {}) as Record<string, unknown>)[token.path[1]] = value;
            consumed();
          } else consumed();
        } else {
          if (token.kind === 'key') { const frame = state.stack.at(-1)!; frame.key = ''; frame.state = 'colon'; }
          else consumed();
        }
        state.token = null; continue;
      }
      // Only bounded identity scalars and short field names can enter a checkpoint.
      // Other strings are streamed byte by byte; their contents are never retained.
      if (token.raw !== null) token.raw = token.raw.length < 256 ? token.raw + String.fromCharCode(byte) : null;
      if (token.escaped) token.escaped = false;
      else if (byte === 92) token.escaped = true;
      continue;
    }
    if (state.skipDepth) {
      if (state.skipString) {
        if (state.skipEscape) state.skipEscape = false;
        else if (byte === 92) state.skipEscape = true;
        else if (byte === 34) state.skipString = false;
      } else if (byte === 34) state.skipString = true;
      else if (byte === 123 || byte === 91) state.skipDepth += 1;
      else if (byte === 125 || byte === 93) state.skipDepth -= 1;
      continue;
    }
    if (state.primitive) {
      if (![44, 93, 125, 32, 9, 10, 13].includes(byte)) continue;
      state.primitive = false;
    }
    const frame = state.stack.at(-1);
    if ([32, 9, 10, 13].includes(byte)) continue;
    if (byte === 123 || byte === 91) {
      const currentPath = path(); consumed();
      if (enter(currentPath, provider)) state.stack.push({ path: currentPath, array: byte === 91, key: '', index: 0, state: byte === 91 ? 'value' : 'key' });
      else state.skipDepth = 1;
    } else if (byte === 125 || byte === 93) state.stack.pop();
    else if (byte === 44) { if (!frame) throw new SyntaxError('Unexpected header comma'); frame.state = frame.array ? 'value' : 'key'; }
    else if (byte === 58) { if (!frame || frame.state !== 'colon') throw new SyntaxError('Unexpected header colon'); frame.state = 'value'; }
    else if (byte === 34) {
      const currentPath = path();
      const kind = frame?.state === 'key' ? 'key' : bodyPath(currentPath, provider) ? 'candidate' : metadataPath(currentPath) ? 'metadata' : 'skip';
      state.token = { kind, raw: kind === 'key' || kind === 'metadata' ? '' : null, escaped: false, start: start + at + 1, path: currentPath };
    } else { consumed(); state.primitive = true; }
  }
  return null;
}

/** One source block per invocation. The fixed checkpoint survives a process restart. */
export async function locateRecordBody(source: WindowByteSource, snapshot: SourceSnapshot, range: SourceRange, request: WindowReadRequest) {
  const key = { scope: request.scope, sourceLineage: snapshot.sourceInstance, decoderVersion: 1, kind: 'head' as const,
    cursor: 'body-header:' + digest(JSON.stringify([snapshot.snapshotRevision, range.start, range.end])) };
  const directory = join(request.cacheDirectory, 'body-headers');
  const previous = await readWindowFrame(directory, key, request.budget);
  let state: State;
  if (previous.kind === 'hit') {
    request.budget.charge('decodedBytes', previous.bytes.length);
    state = JSON.parse(utf8.decode(previous.bytes)) as State;
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < range.start || state.offset > range.end)
      throw new Error('Invalid body header checkpoint');
  } else {
    if (previous.reason !== 'not_found') throw new Error(`Body header checkpoint failure: ${previous.reason}`);
    state = { version: 1, offset: range.start, stack: [], token: null, skipDepth: 0, skipString: false, skipEscape: false, primitive: false, metadata: {} };
  }
  const start = state.offset, length = Math.min(65536, range.end - start);
  if (!length) return { kind: 'empty' as const };
  let bytes = new Uint8Array(0), used = 0, failed = false, failure: unknown;
  await request.budget.read('sourceBytes', length, async () => {
    bytes = new Uint8Array(length);
    try { while (used < length && !request.signal?.aborted) { const count = await source.read(bytes, used, length - used, start + used);
      if (!Number.isSafeInteger(count) || count < 0 || count > length - used) throw new RangeError('Invalid header read length');
      if (!count) break; used += count; } }
    catch (error) { failed = true; failure = error; }
    return used;
  });
  if (failed) throw failure;
  request.signal?.throwIfAborted();
  const current = await source.snapshot();
  if (used !== length || current.sourceInstance !== snapshot.sourceInstance || current.snapshotRevision !== snapshot.snapshotRevision)
    throw new Error('Source changed while locating body header');
  request.budget.charge('decodedBytes', length);
  const offset = advance(state, bytes, start, request.locator.harness);
  if (offset !== null) return { kind: 'located' as const, offset, metadata: state.metadata };
  if (state.offset === range.end) return { kind: 'empty' as const };
  await mkdir(directory, { recursive: true }); await syncWindowDirectory(request.cacheDirectory);
  await writeWindowFrame(directory, key, Buffer.from(JSON.stringify(state)));
  return { kind: 'locating' as const, nextOffset: state.offset };
}
