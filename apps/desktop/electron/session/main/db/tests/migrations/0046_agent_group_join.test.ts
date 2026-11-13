import { openFixture } from '@tooling/utils/db'
import { afterEach, describe, expect, it } from 'vitest'

describe('0046 agent group join requests', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>
  afterEach(() => fixture?.close())

  it('is additive and keeps at most one active operation per session/group/agent/seat', async () => {
    fixture = await openFixture('empty')
    const sql = fixture.sqlite
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_group_join_requests'").get())
      .toEqual({ name: 'agent_group_join_requests' })

    sql.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
      INSERT INTO sessions (id, project_id, workspace_id) VALUES ('s', 'p', 'root');
    `)
    const insert = (id: string, status: string, key = 'same-key') => sql.prepare(`
      INSERT INTO agent_group_join_requests
        (id, operation_key, session_id, chat_id, target_agent_id, actor_user_id, initiator_agent_id, as_task, status, digest, created_at, expires_at)
      VALUES (?, ?, 's', 'chat', 'agent', 'owner', 'initiator', 0, ?, 'digest', 1, 9999999999999)
    `).run(id, key, status)

    insert('op-1', 'pending')
    expect(() => insert('op-2', 'pending')).toThrow(/UNIQUE constraint failed/)
    // A terminal outcome frees the key for a fresh request with a new confirmation.
    sql.prepare("UPDATE agent_group_join_requests SET status = 'denied' WHERE id = 'op-1'").run()
    expect(() => insert('op-2', 'pending')).not.toThrow()
    // A different Agent or group is a different operation.
    expect(() => insert('op-3', 'pending', 'other-key')).not.toThrow()

    expect(sql.prepare('SELECT count(*) AS n FROM agent_group_join_requests').get()).toEqual({ n: 3 })
    expect(sql.pragma('foreign_key_check')).toEqual([])
    // The table is the only addition: sessions and their rows are untouched.
    expect(sql.prepare("SELECT id FROM sessions").all()).toEqual([{ id: 's' }])
  })

  it('cascades a pending record with its session and can be dropped for a rollback', async () => {
    fixture = await openFixture('empty')
    const sql = fixture.sqlite
    sql.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
      INSERT INTO sessions (id, project_id, workspace_id) VALUES ('s', 'p', 'root');
    `)
    sql.prepare(`
      INSERT INTO agent_group_join_requests
        (id, operation_key, session_id, chat_id, target_agent_id, actor_user_id, initiator_agent_id, as_task, status, digest, created_at, expires_at)
      VALUES ('op', 'k', 's', 'chat', 'agent', 'owner', 'initiator', 0, 'pending', 'd', 1, 2)
    `).run()
    sql.prepare("DELETE FROM sessions WHERE id = 's'").run()
    expect(sql.prepare('SELECT count(*) AS n FROM agent_group_join_requests').get()).toEqual({ n: 0 })
    sql.exec('DROP TABLE agent_group_join_requests;')
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_group_join_requests'").get()).toBeUndefined()
    expect(sql.prepare("SELECT id FROM sessions").all()).toEqual([])
  })
})
