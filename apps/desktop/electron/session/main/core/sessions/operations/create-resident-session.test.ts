import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import type { CreateResidentSessionParams } from '@shared/core/sessions/create-resident-session';
import { sessionEvents } from '../session-events';
import { setTaskNamer } from '../task-name';
import { createResidentSession, createSession, prepareResidentSession } from './createSession';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  getProject: vi.fn(),
  select: vi.fn(),
  emit: vi.fn(),
  checkLocalHarnessAvailable: vi.fn(),
  resolveProjectFolder: vi.fn(),
  rows: [] as unknown[],
}));

vi.mock('@main/db/client', () => ({
  db: {
    transaction: mocks.transaction,
    select: mocks.select,
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));

vi.mock('@main/core/projects/operations/project-folders', () => ({
  resolveProjectFolder: mocks.resolveProjectFolder,
}));

vi.mock('@main/core/sessions/impl/harness-availability', () => ({
  checkLocalHarnessAvailable: mocks.checkLocalHarnessAvailable,
}));

vi.mock('@main/core/mcp-library/service', () => ({
  mcpLibraryService: { list: async () => [] },
}));

// The task namer counts the names this host's sessions already carry; only its fallback reads the db.
beforeEach(() => setTaskNamer({
  defaultName: async (provider, taken) => `${provider} ${taken.length + 1}`,
  renameBound: async () => { throw new Error('no identities in this test'); },
}));
afterEach(() => setTaskNamer(null));

const workspaceConfig = {
  version: '2' as const,
  workspace: { kind: 'repository-instance' as const, workspaceId: 'ws-repo-1' },
};

const params: CreateResidentSessionParams = {
  projectId: 'project-1',
  workspaceConfig,
  agent: {
    id: 'resident-1',
    provider: 'codex',
    runtime: 'acp',
    displayName: '新助手 1',
  },
};

/** `select()` has three shapes in the code under test: awaited directly, `.where().limit(1)`, and `.where().all()`. */
function rowsChain(rows: unknown[]) {
  const whereResult = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
    all: () => unknown[];
  };
  whereResult.limit = async () => rows;
  whereResult.all = () => rows;
  const fromResult = Promise.resolve(rows) as Promise<unknown[]> & { where: () => typeof whereResult };
  fromResult.where = () => whereResult;
  return { from: () => fromResult };
}

function setupTransactionMock() {
  const captured: unknown[] = [];
  mocks.transaction.mockImplementation((cb: (tx: unknown) => void) => {
    captured.length = 0;
    cb({
      // The resident insert re-checks the display name inside the same transaction.
      select: () => rowsChain(mocks.rows),
      insert: () => ({
        values: (vals: unknown) => {
          captured.push(vals);
          return { returning: () => ({ all: () => [vals] }) };
        },
      }),
    });
  });
  return captured;
}

const insertValue = (captured: unknown[]): Record<string, any> => captured.at(-1) as Record<string, any>;

describe('prepareResidentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
    mocks.select.mockImplementation(() => rowsChain(mocks.rows));
    mocks.getProject.mockReturnValue({});
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    setupTransactionMock();
  });

  it('project 不存在 ⇒ project-not-found,一行都不写', async () => {
    mocks.getProject.mockReturnValue(undefined);
    const result = await prepareResidentSession(params);
    expect(result).toEqual({ success: false, error: { type: 'project-not-found' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('workspace 不属于项目 ⇒ provision-failed,一行都不写', async () => {
    mocks.resolveProjectFolder.mockResolvedValue(null);
    const result = await prepareResidentSession(params);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('provision-failed');
      expect(result.error).toMatchObject({ message: expect.stringContaining('ws-repo-1') });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('harness 不可用 ⇒ harness-unavailable,一行都不写、不问 workspace', async () => {
    mocks.checkLocalHarnessAvailable.mockResolvedValue({
      reason: 'missing',
      providerId: 'codex',
      harnessName: 'codex',
      detail: 'not installed',
    });
    const result = await prepareResidentSession(params);
    expect(result).toEqual({
      success: false,
      error: {
        type: 'harness-unavailable',
        reason: 'missing',
        providerId: 'codex',
        harnessName: 'codex',
        detail: 'not installed',
      },
    });
    expect(mocks.resolveProjectFolder).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('合法输入 ⇒ resident 行:无首轮/无载荷/未认领首启/出生 idle', async () => {
    const result = await prepareResidentSession(params);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const conv = result.data.convInsert as Record<string, any>;
    expect(conv.id).toBe('resident-1');
    expect(conv.projectId).toBe('project-1');
    expect(conv.workspaceId).toBe('ws-repo-1');
    expect(conv.provider).toBe('codex');
    expect(conv.runtime).toBe('acp');
    expect(conv.providerSessionId).toBeNull();
    expect(conv.agentStatus).toBe('idle');
    expect(conv.agentStatusDetail).toBe('plain');
    expect(conv.config).toMatchObject({ version: '1', type: 'acp', resident: true });
    expect(conv.config).not.toHaveProperty('firstUtterance');
    expect(conv.config).not.toHaveProperty('initialQueue');
    expect(conv.config).not.toHaveProperty('initialPrompt');
  });

  it('中文显示名原样落进 config.agentDisplayName,不走 ASCII slug', async () => {
    const result = await prepareResidentSession(params);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.convInsert as Record<string, any>).config.agentDisplayName).toBe('新助手 1');
    }
  });

  it('pty resident 也写 resident 标记,且没有首轮载荷', async () => {
    const result = await prepareResidentSession({
      ...params,
      agent: { ...params.agent, runtime: 'pty' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const conv = result.data.convInsert as Record<string, any>;
      expect(conv.config).toMatchObject({ version: '1', type: 'pty', resident: true });
      expect(conv.config).not.toHaveProperty('firstUtterance');
      expect(conv.config).not.toHaveProperty('initialPrompt');
    }
  });
});

describe('createResidentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
    mocks.select.mockImplementation(() => rowsChain(mocks.rows));
    mocks.getProject.mockReturnValue({});
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    setupTransactionMock();
  });

  it('写且只写一行,出生与 session:created 各一次', async () => {
    const born: string[] = [];
    const off = sessionEvents.on('session:created', (session) => { born.push(session.id); });
    try {
      const captured = setupTransactionMock();
      const result = await createResidentSession(params);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session.id).toBe('resident-1');
        expect(result.data.session.title).toBe('新助手 1');
      }
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      expect(insertValue(captured).config.resident).toBe(true);
      expect(born).toEqual(['resident-1']);

      const created = mocks.emit.mock.calls.filter(([event]) => event === sessionCreatedChannel);
      expect(created).toHaveLength(1);
      expect((created[0][1] as { session: { id: string } }).session.id).toBe('resident-1');
    } finally {
      off();
    }
  });

  it('同 id 重复调用返回同一行,不重复 insert、不重复发事件', async () => {
    const captured = setupTransactionMock();
    await createResidentSession(params);
    mocks.rows = [insertValue(captured)];
    mocks.transaction.mockClear();
    mocks.emit.mockClear();

    const again = await createResidentSession(params);

    expect(again.success).toBe(true);
    if (again.success) expect(again.data.session.id).toBe('resident-1');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('同 id 已存在但不是 resident ⇒ 返回错误,不覆盖', async () => {
    mocks.rows = [{
      id: 'resident-1',
      projectId: 'project-1',
      provider: 'codex',
      runtime: 'acp',
      config: { version: '1', type: 'acp', agentDisplayName: '普通会话' },
    }];

    const result = await createResidentSession(params);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('provision-failed');
      expect(result.error).toMatchObject({ message: expect.stringContaining('different creation request') });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('同 id 的 resident 但请求不同(provider 变了)⇒ 返回错误,不覆盖', async () => {
    mocks.rows = [{
      id: 'resident-1',
      projectId: 'project-1',
      provider: 'claude',
      runtime: 'acp',
      config: { version: '1', type: 'acp', resident: true, agentDisplayName: '新助手 1' },
    }];

    const result = await createResidentSession(params);

    expect(result.success).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('普通 createSession 回归', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
    mocks.select.mockImplementation(() => rowsChain(mocks.rows));
    mocks.getProject.mockReturnValue({});
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    setupTransactionMock();
  });

  it('空首轮仍然当场抛,一行都不写', async () => {
    await expect(createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: 'Test Task',
        initialSession: {
          id: 'normal-1',
          provider: 'codex',
          title: 'Test Task',
          origin: { kind: 'create', firstUtterance: '   \n\t ' },
        },
      },
      workspaceConfig,
    })).rejects.toThrow(/必须带首轮/);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('正常带首轮的路径没有 resident 标记', async () => {
    const captured = setupTransactionMock();
    const result = await createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: 'Test Task',
        initialSession: {
          id: 'normal-1',
          provider: 'codex',
          title: 'Test Task',
          origin: { kind: 'create', firstUtterance: '开工' },
        },
      },
      workspaceConfig,
    });

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(insertValue(captured).config).not.toHaveProperty('resident');
  });
});
