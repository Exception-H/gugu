import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_DEVICE_ID,
  readStoredTarget,
  validateTarget,
  writeStoredTarget,
  type StorageLike,
} from './new-agent-target';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

const deps = (overrides: Partial<Parameters<typeof validateTarget>[1]> = {}) => ({
  deviceExists: (id: string) => id === 'device-a',
  projectExists: (id: string) => id === 'project-a',
  projectPath: (id: string) => (id === 'project-a' ? '/repo/a' : null),
  projectMachine: (id: string) => (id === 'project-a' ? 'device-a' : null),
  ...overrides,
});

describe('remembered new-agent target', () => {
  it('round-trips the last device and project', () => {
    const storage = memoryStorage();
    writeStoredTarget({ deviceId: 'device-a', projectId: 'project-a' }, storage);
    expect(readStoredTarget(storage)).toEqual({ deviceId: 'device-a', projectId: 'project-a' });
  });

  it('treats bad JSON and malformed rows as no memory', () => {
    expect(readStoredTarget(memoryStorage({ 'gugu.new-agent.last-target': '{' }))).toBeNull();
    expect(readStoredTarget(memoryStorage({ 'gugu.new-agent.last-target': '{"deviceId":1}' }))).toBeNull();
  });

  it('accepts a local project only when its directory is readable and belongs to this computer', () => {
    expect(validateTarget({ deviceId: LOCAL_DEVICE_ID, projectId: 'project-a' }, deps({
      projectMachine: () => null,
    }))).toEqual({ ok: true, target: { deviceId: LOCAL_DEVICE_ID, projectId: 'project-a' } });
    expect(validateTarget({ deviceId: LOCAL_DEVICE_ID, projectId: 'project-a' }, deps())).toMatchObject({
      ok: false,
      problem: 'directory',
    });
  });

  it('does not fall back to the local machine when the remembered device is gone', () => {
    const result = validateTarget({ deviceId: 'device-gone', projectId: null }, deps());
    expect(result).toMatchObject({ ok: false, problem: 'device' });
    expect(result.target.deviceId).toBe('device-gone');
  });

  it('rejects a project whose directory disappeared', () => {
    const result = validateTarget({ deviceId: LOCAL_DEVICE_ID, projectId: 'project-a' }, deps({
      projectPath: () => null,
      projectMachine: () => null,
    }));
    expect(result).toMatchObject({ ok: false, problem: 'directory' });
  });

  it('does not cry wolf when the remembered device is only offline', () => {
    const deviceExists = vi.fn(() => true);
    expect(validateTarget({ deviceId: 'device-a', projectId: null }, deps({ deviceExists }))).toEqual({
      ok: true,
      target: { deviceId: 'device-a', projectId: null },
    });
  });
});
