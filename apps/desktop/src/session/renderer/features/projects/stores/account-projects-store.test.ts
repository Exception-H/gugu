import { runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { AccountProjectsStore } from './account-projects-store';

const read = vi.hoisted(() => ({ list: vi.fn<() => Promise<AccountProject[]>>(), self: vi.fn(async () => ({ device_id: 'this-computer' })) }));
vi.mock('@/lib/deviceProjects', () => ({ listMyAccountProjects: () => read.list() }));
vi.mock('@/platform', () => ({ platform: { getLocalDeviceSelfSnapshot: () => read.self() } }));

const paper: AccountProject = {
  chatId: 'chat-paper',
  name: 'Paper',
  archived: false,
  bindings: [
    { deviceId: 'gpu', localProjectId: 'gpu-paper' },
    { deviceId: 'this-computer', localProjectId: 'local-paper' },
    { deviceId: 'juma', localProjectId: 'juma-paper' },
    { deviceId: 'not-loaded', localProjectId: 'nl-paper' },
  ],
};
const empty: AccountProject = { chatId: 'chat-empty', name: 'Empty', archived: false, bindings: [] };

/** 项目表:本机一个、gpu(连着)一个、juma(离线,建得最早)一个;not-loaded 那台的项目不在表里。 */
function storeWith(projects: AccountProject[], local: { here?: boolean } = {}) {
  const store = new AccountProjectsStore();
  const table = new Map<string, { createdAt: string }>([
    ['gpu-paper', { createdAt: '2026-06-01' }],
    ['juma-paper', { createdAt: '2026-01-01' }],
    ...(local.here === false ? [] : [['local-paper', { createdAt: '2026-12-01' }] as const]),
  ]);
  const machineOf: Record<string, string> = { 'gpu-paper': 'gpu', 'juma-paper': 'juma' };
  store.attach({ projects: table, machineOf: (id) => machineOf[id] ?? null, connected: (deviceId) => deviceId === 'gpu' });
  runInAction(() => {
    store.list = projects;
    store.localDeviceId = 'this-computer';
    store.status = 'ready';
  });
  return store;
}

afterEach(() => {
  read.list.mockReset();
});

describe('accountProjectsStore helpers', () => {
  it('membersOf: bindings present in the project table, this computer first, then connected, then earliest', () => {
    const store = storeWith([paper, empty]);
    expect(store.membersOf('chat-paper')).toEqual(['local-paper', 'gpu-paper', 'juma-paper']);
    expect(store.representativeOf('chat-paper')).toBe('local-paper');
    expect(store.membersOf('chat-empty')).toEqual([]);
    expect(store.representativeOf('chat-empty')).toBeUndefined();
    expect(store.membersOf('chat-unknown')).toEqual([]);
  });

  it('without a folder on this computer the connected machine represents the project', () => {
    const store = storeWith([paper], { here: false });
    expect(store.membersOf('chat-paper')).toEqual(['gpu-paper', 'juma-paper']);
    expect(store.representativeOf('chat-paper')).toBe('gpu-paper');
  });

  it('a binding counts only on its own machine: a remote id that is local here, or the reverse, is not a member', () => {
    const store = storeWith([{ ...paper, bindings: [{ deviceId: 'gpu', localProjectId: 'local-paper' }, { deviceId: 'this-computer', localProjectId: 'gpu-paper' }] }]);
    expect(store.membersOf('chat-paper')).toEqual([]);
  });

  it('projectOfLocal: by the table machine, or by an explicit machine (null = this computer)', () => {
    const store = storeWith([paper, empty]);
    expect(store.projectOfLocal('local-paper')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('gpu-paper')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('nl-paper', 'not-loaded')?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('local-paper', null)?.chatId).toBe('chat-paper');
    expect(store.projectOfLocal('local-paper', 'gpu')).toBeUndefined();
    expect(store.projectOfLocal('stray')).toBeUndefined();
  });
});

describe('accountProjectsStore reading', () => {
  it('reads the list and this computer, fails loud on error, and clear drops the account', async () => {
    const store = new AccountProjectsStore();
    expect(store.status).toBe('loading');
    read.list.mockResolvedValueOnce([paper]);
    await store.refresh();
    expect(store.status).toBe('ready');
    expect(store.localDeviceId).toBe('this-computer');
    expect(store.projects).toEqual([paper]);

    read.list.mockRejectedValueOnce(new Error('rpc down'));
    await store.refresh();
    expect(store.status).toBe('error');
    expect(store.error).toBe('rpc down');

    store.clear();
    expect(store.status).toBe('loading');
    expect(store.projects).toEqual([]);
    expect(store.localDeviceId).toBeNull();
  });

  it('a refresh asked for while reading reads again afterwards; a read that lands after clear is dropped', async () => {
    const store = new AccountProjectsStore();
    let resolveFirst!: (list: AccountProject[]) => void;
    read.list.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce([paper, empty]);
    const first = store.refresh();
    void store.refresh();
    await vi.waitFor(() => expect(read.list).toHaveBeenCalledTimes(1));
    resolveFirst([paper]);
    await first;
    await vi.waitFor(() => expect(store.projects).toEqual([paper, empty]));
    expect(read.list).toHaveBeenCalledTimes(2);

    let resolveLate!: (list: AccountProject[]) => void;
    read.list.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    const late = store.refresh();
    await vi.waitFor(() => expect(read.list).toHaveBeenCalledTimes(3));
    store.clear();
    resolveLate([empty]);
    await late;
    expect(store.projects).toEqual([]);
    expect(store.status).toBe('loading');
  });
});
