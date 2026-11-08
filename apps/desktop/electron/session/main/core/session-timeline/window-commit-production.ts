import { join } from 'node:path';
import { app } from 'electron';
import { sqlite } from '@main/db/client';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { createWindowCommitPublisher } from './window-commit-publisher';
import { ensureWindowCommitProjection, reserveWindowCommitHost as reserve } from './window-commit-host';

/** Bind the actual durable publisher before reserving the stopped-session
 * boundary. Preparing only creates scalar SQLite statements and a cold lease;
 * source/projection I/O starts on a real commit after onSpawned's tap barrier. */
export function reserveWindowCommitHost(...input: Parameters<typeof reserve>) {
  ensureWindowCommitProjection(() => {
    const publisher = createWindowCommitPublisher(join(app.getPath('userData'), 'session-window-cache', 'committed'), createWindowCommitReceipts(sqlite));
    return async receipt => ({ projectionId: (await publisher.publish(receipt)).projectionId });
  });
  return reserve(...input);
}
