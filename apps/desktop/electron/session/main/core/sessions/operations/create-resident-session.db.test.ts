import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppDb } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { getSessions } from '../getSessions';
import { getSessionsForProject } from '../getSessionsForProject';
import { isResidentNeverRun } from '../never-run-session';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  getProject: vi.fn(),
  checkLocalHarnessAvailable: vi.fn(),
  resolveProjectFolder: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject },
}));
vi.mock('@main/core/projects/operations/project-folders', () => ({
  resolveProjectFolder: mocks.resolveProjectFolder,
}));
vi.mock('@main/core/sessions/impl/harness-availability', () => ({
  checkLocalHarnessAvailable: mocks.checkLocalHarnessAvailable,
}));
vi.mock('@main/core/mcp-library/service', () => ({ mcpLibraryService: { list: async () => [] } }));

const { createResidentSession, createSession } = await import('./createSession');

const params = {
  projectId: 'p',
  workspaceConfig: {
    version: '2' as const,
    workspace: { kind: 'repository-instance' as const, workspaceId: 'ws' },
  },
  agent: {
    id: 'resident-1',
    provider: 'codex' as const,
    runtime: 'acp' as const,
    displayName: '新助手 1',
  },
};

let fixture: Awaited<ReturnType<typeof openFixture>>;

const rawConfig = (id: string) => JSON.parse(
  (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string }).config,
);
const rowCount = () => (fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.getProject.mockReturnValue({ id: 'p' });
  mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
  mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
  fixture.sqlite.exec(`
    INSERT INTO projects (id, name, path) VALUES ('p', 'Project', '/repo');
  `);
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});

describe('createResidentSession against the real database', () => {
  it('写一行:config.resident 落库并读得回来,列表可见,一句没聊过', async () => {
    const result = await createResidentSession(params);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.session).toMatchObject({ id: 'resident-1', projectId: 'p', title: '新助手 1' });

    expect(rowCount()).toBe(1);
    const config = rawConfig('resident-1');
    expect(config).toMatchObject({ version: '1', type: 'acp', resident: true, agentDisplayName: '新助手 1' });
    expect(config).not.toHaveProperty('firstUtterance');
    expect(config).not.toHaveProperty('initialQueue');
    expect(config).not.toHaveProperty('initialPrompt');

    // versionedJsonColumn 的读取路径也认这个 additive 字段。
    const [row] = await fixture.db.select().from(sessions).where(eq(sessions.id, 'resident-1'));
    expect(row.config).toMatchObject({ resident: true });
    expect(row.providerSessionId).toBeNull();
    expect(row.agentStatus).toBe('idle');

    expect((await getSessions()).map((session) => session.id)).toContain('resident-1');
    expect((await getSessionsForProject('p')).map((session) => session.id)).toContain('resident-1');
    await expect(isResidentNeverRun('resident-1')).resolves.toBe(true);
  });

  it('同 id 重试只落一行', async () => {
    const first = await createResidentSession(params);
    const second = await createResidentSession(params);

    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.data.session.id).toBe(first.data.session.id);
      expect(second.data.session.title).toBe('新助手 1');
    }
    expect(rowCount()).toBe(1);
  });

  it('同 id 但请求不同 ⇒ 报错,原行原样保留', async () => {
    await createResidentSession(params);
    const result = await createResidentSession({
      ...params,
      agent: { ...params.agent, provider: 'claude' },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('provision-failed');
    expect(rowCount()).toBe(1);
    expect(rawConfig('resident-1').resident).toBe(true);
  });

  it('完全重复(同 id、同名、同工作区、同引擎) ⇒ 幂等复用那一行,不新建、不重复发事件', async () => {
    const first = await createResidentSession(params);
    expect(first.success).toBe(true);

    const again = await createResidentSession(params);

    expect(again.success).toBe(true);
    if (first.success && again.success) {
      expect(again.data.session.id).toBe('resident-1');
      expect(again.data.session.title).toBe('新助手 1');
    }
    expect(rowCount()).toBe(1);
  });

  it('只改名字 ⇒ 不再静默拿回旧会话:报错,原文一行未动', async () => {
    await createResidentSession(params);

    const result = await createResidentSession({
      ...params,
      agent: { ...params.agent, displayName: '换了个名字' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('provision-failed');
      expect(result.error).toMatchObject({ message: expect.stringContaining('different creation request') });
    }
    expect(rowCount()).toBe(1);
    expect(rawConfig('resident-1').agentDisplayName).toBe('新助手 1');
  });

  it('只换工作区 ⇒ 不再静默拿回旧会话:报错,原文一行未动', async () => {
    await createResidentSession(params);

    const result = await createResidentSession({
      ...params,
      workspaceConfig: {
        ...params.workspaceConfig,
        workspace: { ...params.workspaceConfig.workspace, workspaceId: 'ws-other' },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('provision-failed');
      expect(result.error).toMatchObject({ message: expect.stringContaining('different creation request') });
    }
    expect(rowCount()).toBe(1);
    expect(fixture.sqlite.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get('resident-1'))
      .toEqual({ workspace_id: 'ws' });
  });

  it('改名后拿到新 id(渲染层 request key 变了) ⇒ 正常新建第二行,旧会话原样保留', async () => {
    await createResidentSession(params);

    const renamed = await createResidentSession({
      ...params,
      agent: { ...params.agent, id: 'resident-2', displayName: '换了个名字' },
    });

    expect(renamed.success).toBe(true);
    if (renamed.success) {
      expect(renamed.data.session.id).toBe('resident-2');
      expect(renamed.data.session.title).toBe('换了个名字');
    }
    expect(rowCount()).toBe(2);
    expect(rawConfig('resident-1').agentDisplayName).toBe('新助手 1');
    expect(rawConfig('resident-2').agentDisplayName).toBe('换了个名字');
  });

  it('普通 createSession 空首轮仍然抛,库里零行', async () => {
    await expect(createSession({
      projectId: 'p',
      sessionConfig: {
        version: '1',
        name: '普通会话',
        initialSession: {
          id: 'normal-1',
          provider: 'codex',
          title: '普通会话',
          origin: { kind: 'create', firstUtterance: '  ' },
        },
      },
      workspaceConfig: params.workspaceConfig,
    })).rejects.toThrow(/必须带首轮/);

    expect(rowCount()).toBe(0);
  });
});
