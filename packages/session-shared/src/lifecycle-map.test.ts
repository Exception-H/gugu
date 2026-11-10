import { describe, expect, it } from 'vitest';
import { LifecycleMap } from './lifecycle-map';
import { err, ok } from './result';

describe('LifecycleMap error status', () => {
  it.each([false, 0, '', null])('preserves stored falsy errors %j in status', async (error) => {
    const resources = new LifecycleMap<string, unknown, unknown>();
    await resources.provision('bad', async () => err(error));
    expect(resources.bootstrapStatus('bad')).toEqual({ status: 'error', error });
    await resources.provision('ready', async () => ok('value'));
    await resources.teardown('ready', async () => err(error));
    expect(resources.teardownStatus('ready')).toEqual({ status: 'error', error });
  });
});
