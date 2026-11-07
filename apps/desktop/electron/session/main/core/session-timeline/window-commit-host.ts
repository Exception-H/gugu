import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { persistCommittedTurn } from '../sessions/session-turn-store';
import { createWindowCommitRuntime } from './window-commit-runtime';
import type { WindowCommitReceipt } from './window-commit-receipt';
import type { WindowCommittedEvent } from './window-commit-tap';

type Producer = (receipt: WindowCommitReceipt) => Promise<{ projectionId: string }>;
type Runtime = ReturnType<typeof createWindowCommitRuntime>;
type Slot = { runtime: Runtime; project?: Producer; enabled: boolean; storageFailed?: unknown; observe(event: WindowCommittedEvent): void };
let current: Slot | undefined;
const report = (message: string, error: unknown) => { try { log.warn(message, { error }); } catch { /* Diagnostics cannot interrupt the writer. */ } };
function slot(): Slot {
  if (current) return current;
  const value: Slot = { enabled: false, observe() {}, runtime: createWindowCommitRuntime({
    persist(event, capture) {
      const written = persistCommittedTurn({ ...event, windowCapture: capture });
      try { value.observe(event); } catch (error) { report('sessionWindow: commit observer failed', error); }
      return written;
    },
    capture(event, cursor, committed) {
      const directory = join(app.getPath('userData'), 'session-window-cache', 'committed');
      const scope = createHash('sha256').update(JSON.stringify([directory, event.sessionId])).digest('hex');
      return { directory, scope, cursor, committed };
    },
    project(receipt) {
      if (!value.project) throw Object.assign(new Error('Commit projection is unavailable'), { code: 'live_projection_unavailable' });
      return value.project(receipt);
    },
    report: error => report('sessionWindow: committed history failed', error),
  }) }; current = value; return value;
}

/** Await in lazyWorker.onSpawned, before any start/resume can receive the worker. */
export async function connectWindowCommitHost(source: Parameters<Runtime['attach']>[0], observe: Slot['observe']) {
  const selected = slot(); selected.observe = observe;
  // Initialize before the awaited worker-start barrier, never before joining the
  // canonical writer queue where concurrent mkdir waits could reorder commits.
  const userData = app.getPath('userData'), cache = join(userData, 'session-window-cache'), directory = join(cache, 'committed');
  try {
    await mkdir(directory, { recursive: true });
    for (const path of [directory, cache, userData]) await syncWindowDirectory(path);
    selected.storageFailed = undefined;
  } catch (error) {
    selected.storageFailed = error; selected.runtime.invalidateStore();
    report('sessionWindow: commit storage unavailable', error);
  }
  try { await selected.runtime.attach(source); }
  catch (error) {
    selected.runtime.invalidate(); selected.runtime.close(); if (current === selected) current = undefined;
    throw error;
  }
  return { invalidate: () => selected.runtime.invalidate(), close() {
    selected.runtime.invalidate(); selected.runtime.close(); if (current === selected) current = undefined;
  } };
}
/** The durable producer must exist before a route can reserve the new handoff. */
export function bindWindowCommitProjection(project: Producer): () => void {
  const selected = slot();
  if (selected.project) throw new Error('A commit projection producer is already bound');
  selected.project = project; selected.enabled = true;
  return () => { selected.enabled = false; selected.runtime.invalidateStore(); };
}
export function reserveWindowCommitHost(...input: Parameters<Runtime['reserve']>) {
  const selected = slot();
  if (!selected.enabled || selected.storageFailed) throw Object.assign(new Error('Commit projection is unavailable'), { code: 'live_projection_unavailable' });
  return selected.runtime.reserve(...input);
}
