import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextAgentDefaultName } from '@gugu/core/shared/agentDefaultName';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@gugu/core/shared/sessionProject';
import { createAgent, updateAgent, writeAgentName } from '@gugu/core/local/state/agents';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  renamed: vi.fn(),
  getProject: vi.fn(),
  checkLocalHarnessAvailable: vi.fn(),
  resolveProjectFolder: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('./session-events', () => ({ sessionEvents: { _emit: mocks.renamed } }));
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

import { renameSession } from './renameSession';
import { createResidentSession } from './operations/createSession';
import {
  TaskNameConflictError,
  loadTaskNames,
  setTaskNameOwner,
  setTaskNamer,
  taskName,
  taskNameFor,
} from './task-name';

describe('scope-aware task display names (P0-0.6)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let env: NodeJS.ProcessEnv;
  let boundRenames: Array<{ sessionId: string; agentUserId: string; name: string; source: string }>;
  let seen: string[];

  const nameOf = (id: string) => {
    const row = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string };
    return JSON.parse(row.config).agentDisplayName as string | undefined;
  };
  const rowName = (id: string) => {
    const row = fixture.sqlite.prepare('SELECT id, config FROM sessions WHERE id = ?').get(id) as { id: string; config: string };
    return taskName({ id: row.id, config: JSON.parse(row.config) });
  };
  const insert = (id: string, projectId: string, name?: string) => {
    const config = name
      ? `{"version":"1","type":"acp","agentDisplayName":${JSON.stringify(name)}}`
      : '{"version":"1","type":"acp"}';
    fixture.sqlite.prepare('INSERT INTO sessions (id, project_id, provider, runtime, config) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, 'codex', 'acp', config);
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'task-name-scope-')) };
    await loadTaskNames(env);
    seen = [];
    boundRenames = [];
    mocks.getProject.mockReturnValue({ id: 'project-a' });
    mocks.checkLocalHarnessAvailable.mockResolvedValue(null);
    mocks.resolveProjectFolder.mockResolvedValue({ kind: 'root' });
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES
        ('project-a', 'Project A', '/a'),
        ('project-b', 'Project B', '/b'),
        ('${IMPLICIT_SESSION_HOME_PROJECT_ID}', '任务工作区', '/task-home');
    `);
    setTaskNamer({
      defaultName: async (_provider, taken, options) => {
        expect(options).toEqual({ scoped: true });
        seen = [...taken];
        return nextAgentDefaultName([], '新助手', { reservedNames: taken });
      },
      renameBound: async () => {},
    });
  });

  afterEach(async () => {
    setTaskNamer(null);
    await setTaskNameOwner(null, env);
    await rm(env.GUGU_HOME!, { recursive: true, force: true });
    fixture.close();
    mocks.db = undefined;
  });

  it('default names count only the visible scope: a project, or the implicit task workspace', async () => {
    insert('a-1', 'project-a', '新助手 1');
    insert('a-2', 'project-a', '新助手 2');
    insert('b-1', 'project-b', '新助手 7');
    insert('home-1', IMPLICIT_SESSION_HOME_PROJECT_ID, '新助手 4');

    await expect(taskNameFor('codex', null, 'project-a')).resolves.toBe('新助手 3');
    expect(seen).toEqual(['新助手 1', '新助手 2']);

    await expect(taskNameFor('codex', null, 'project-b')).resolves.toBe('新助手 8');
    expect(seen).toEqual(['新助手 7']);

    await expect(taskNameFor('codex', null, IMPLICIT_SESSION_HOME_PROJECT_ID)).resolves.toBe('新助手 5');
    expect(seen).toEqual(['新助手 4']);
  });

  it('a manual rename is checked in its project and fails loudly on a duplicate', async () => {
    insert('taken', 'project-a', '同名助手');
    insert('renamed', 'project-a', '原名');

    await expect(renameSession('renamed', '同名助手')).rejects.toBeInstanceOf(TaskNameConflictError);
    await expect(renameSession('renamed', '同名助手')).rejects.toThrow(/already taken/);
    expect(nameOf('taken')).toBe('同名助手');
    expect(nameOf('renamed')).toBe('原名');

    // Chinese is kept verbatim: no ASCII slug, no suffixing.
    await renameSession('renamed', '中文 助手');
    expect(nameOf('renamed')).toBe('中文 助手');
  });

  it('the same name is allowed in another project and in the implicit task workspace', async () => {
    insert('a', 'project-a', '同名助手');
    insert('b', 'project-b', '原名 B');
    insert('home', IMPLICIT_SESSION_HOME_PROJECT_ID, '原名 Home');

    await renameSession('b', '同名助手');
    await renameSession('home', '同名助手');

    expect(nameOf('a')).toBe('同名助手');
    expect(nameOf('b')).toBe('同名助手');
    expect(nameOf('home')).toBe('同名助手');
  });

  it('two concurrent renames to one name: exactly one succeeds at the persistence layer', async () => {
    insert('a', 'project-a', 'A');
    insert('b', 'project-a', 'B');

    const results = await Promise.allSettled([
      renameSession('a', '并发同名'),
      renameSession('b', '并发同名'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TaskNameConflictError);
    const count = (fixture.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE project_id = 'project-a' AND json_extract(config, '$.agentDisplayName') = '并发同名'",
    ).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('two concurrent resident creates with one name: exactly one lands', async () => {
    const params = (id: string) => ({
      projectId: 'project-a',
      workspaceConfig: {
        version: '2' as const,
        workspace: { kind: 'repository-instance' as const, workspaceId: 'ws' },
      },
      agent: {
        id,
        provider: 'codex' as const,
        runtime: 'acp' as const,
        displayName: '并发创建',
      },
    });

    const results = await Promise.all([
      createResidentSession(params('resident-1')),
      createResidentSession(params('resident-2')),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    const failed = results.find((result) => !result.success);
    expect(failed).toMatchObject({
      success: false,
      error: { type: 'provision-failed', message: expect.stringContaining('already taken') },
    });
    const rows = fixture.sqlite.prepare(
      "SELECT id FROM sessions WHERE project_id = 'project-a' AND json_extract(config, '$.agentDisplayName') = '并发创建'",
    ).all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('a bound rename walks the existing roster path and survives a reload', async () => {
    await createAgent({ name: 'Codex 7', agent_type: 'codex', path: '/w', prompt: '', gugu_user_id: 'agent-7' }, env);
    await updateAgent({ guguUserId: 'agent-7' }, {
      cache: { emdash_session_id: 'bound', sessionpage_owner_user_id: 'owner' },
    }, env);
    await setTaskNameOwner('owner', env);
    insert('bound', 'project-a');

    setTaskNamer({
      defaultName: async () => 'unused',
      renameBound: async (sessionId, agentUserId, name, source) => {
        boundRenames.push({ sessionId, agentUserId, name, source });
        await writeAgentName(agentUserId, name, 'local', env);
      },
    });

    await renameSession('bound', '中文助手');

    expect(boundRenames).toEqual([{ sessionId: 'bound', agentUserId: 'agent-7', name: '中文助手', source: 'manual' }]);
    expect(nameOf('bound')).toBeUndefined(); // the identity name is the one name; the pending record is cleared
    expect(rowName('bound')).toBe('中文助手');

    // Restart: the roster projects the identity name back onto the task.
    await loadTaskNames(env);
    expect(rowName('bound')).toBe('中文助手');

    // A bound name is part of the scope check too.
    insert('other', 'project-a', 'Other');
    await expect(renameSession('other', '中文助手')).rejects.toBeInstanceOf(TaskNameConflictError);
  });
});
