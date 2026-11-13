import { openFixture } from '@tooling/utils/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GROUP_JOIN_ALLOW_OPTION,
  GROUP_JOIN_DENY_OPTION,
  listPendingAgentGroupJoins,
  readAgentGroupJoin,
  requestAgentGroupJoin,
  resumePendingAgentGroupJoins,
  type AgentGroupJoinAsk,
  type AgentGroupJoinDeps,
  type AgentGroupJoinInput,
} from './agent-group-join'

const INPUT: AgentGroupJoinInput = {
  sessionId: 'session-1',
  chatId: 'chat-1',
  targetAgentId: 'agent-target',
  actorUserId: 'owner-1',
  initiatorAgentId: 'agent-initiator',
  asTask: false,
}

type Fixture = Awaited<ReturnType<typeof openFixture>>

function depsFor(
  fixture: Fixture,
  ask: AgentGroupJoinAsk,
  addAgent: AgentGroupJoinDeps['addAgent'],
  overrides: Partial<AgentGroupJoinDeps> = {},
): AgentGroupJoinDeps {
  let n = 0
  return {
    sqlite: fixture.sqlite,
    ask,
    addAgent,
    newOperationId: () => `operation-${++n}`,
    ...overrides,
  }
}

const answer = (by: string, optionId = GROUP_JOIN_ALLOW_OPTION, digest?: string): AgentGroupJoinAsk => async () => ({
  optionId, by, ...(digest ? { digest } : {}),
})

/** Approve with the digest the ask actually carried, like a surface that drew this operation. */
const approving = (by = 'person-1'): AgentGroupJoinAsk => async (_id, request) => ({
  optionId: GROUP_JOIN_ALLOW_OPTION,
  by,
  digest: (request.origin.payload as { digest: string }).digest,
})

describe('P0-2.1 agent group join: pending before membership', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await openFixture('empty')
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key)
        VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'P', '/repo');
      INSERT INTO sessions (id, project_id, workspace_id) VALUES ('session-1', 'project-1', 'root');
    `)
  })

  afterEach(() => fixture?.close())

  it('does not execute while the person has not answered', async () => {
    let answerAsk!: (value: { optionId: string; by: string; digest?: string }) => void
    const asked = new Promise<{ optionId: string; by: string; digest?: string }>(resolve => { answerAsk = resolve })
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const ask: AgentGroupJoinAsk = async (_id, request) => {
      // Keep the ask open; answer only after we have inspected the database.
      const settled = await asked
      return { ...settled, digest: settled.digest ?? (request.origin.payload as { digest: string }).digest }
    }
    const deps = depsFor(fixture, ask, addAgent)
    const pending = requestAgentGroupJoin(INPUT, deps)
    await vi.waitFor(() => expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('pending'))
    expect(addAgent).not.toHaveBeenCalled()
    answerAsk({ optionId: GROUP_JOIN_DENY_OPTION, by: 'person-1' })
    const result = await pending
    expect(result.status).toBe('denied')
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')).toMatchObject({ status: 'denied', decidedBy: 'person-1' })
  })

  it('a rejection never adds the Agent', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const result = await requestAgentGroupJoin(INPUT, depsFor(fixture, answer('person-1', GROUP_JOIN_DENY_OPTION), addAgent))
    expect(result.status).toBe('denied')
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('denied')
  })

  it('a timeout is not consent, even if the ask resolves later', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const result = await requestAgentGroupJoin(INPUT, depsFor(fixture, async () => 'timeout', addAgent))
    expect(result.status).toBe('expired')
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('expired')
  })

  it('offline (no Ask surface) keeps the record pending and adds nobody', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const result = await requestAgentGroupJoin(INPUT, depsFor(fixture, async () => 'unavailable', addAgent))
    expect(result.status).toBe('unavailable')
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('pending')
    // A retry while still inside the deadline re-asks the same durable operation instead of opening a new one.
    const retried = await requestAgentGroupJoin(INPUT, depsFor(fixture, approving('person-1'), addAgent))
    expect(retried).toMatchObject({ status: 'joined', operationId: 'operation-1' })
    expect(addAgent).toHaveBeenCalledTimes(1)
  })

  it('an approval still goes through the database membership check, and its refusal is not success', async () => {
    const addAgent = vi.fn(async () => { throw new Error('group_manager_required') })
    const result = await requestAgentGroupJoin(INPUT, depsFor(fixture, approving(), addAgent))
    // The person-facing answer points at what to change; the raw refusal stays on the row for audit.
    expect(result).toMatchObject({
      status: 'failed',
      error: 'the group refused the membership — check the agent role and the group rules',
    })
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')).toMatchObject({ status: 'failed', lastError: 'group_manager_required' })
  })

  it('binds the approval to this operation: a digest from another operation is refused', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const result = await requestAgentGroupJoin(INPUT, depsFor(fixture, answer('person-1', GROUP_JOIN_ALLOW_OPTION, 'another-operation'), addAgent))
    expect(result.status).toBe('denied')
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('denied')
  })

  it('records the operator who approved, and a retry of the applied operation does not execute twice', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    const deps = depsFor(fixture, approving('person-42'), addAgent)
    const first = await requestAgentGroupJoin(INPUT, deps)
    expect(first.status).toBe('joined')
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')).toMatchObject({
      status: 'applied', decidedBy: 'person-42', resultStatus: 'joined', actorUserId: 'owner-1', initiatorAgentId: 'agent-initiator',
    })
    const again = await requestAgentGroupJoin(INPUT, depsFor(fixture, approving('person-42'), addAgent))
    expect(again.status).toBe('joined')
    expect(addAgent).toHaveBeenCalledTimes(1)
    expect(listPendingAgentGroupJoins(fixture.sqlite)).toEqual([])
  })

  it('a retry after a denial asks again and still never treats the retry as the old consent', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    await requestAgentGroupJoin(INPUT, depsFor(fixture, answer('person-1', GROUP_JOIN_DENY_OPTION), addAgent))
    // A retry with no answer yet: the fresh operation is pending, nobody added.
    let release!: (value: 'timeout') => void
    const waiting = new Promise<'timeout'>(resolve => { release = resolve })
    const retried = requestAgentGroupJoin(INPUT, depsFor(fixture, async () => waiting, addAgent, { newOperationId: () => 'operation-2' }))
    await vi.waitFor(() => expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM agent_group_join_requests WHERE status = 'pending'").get()).toEqual({ n: 1 }))
    expect(addAgent).not.toHaveBeenCalled()
    release('timeout')
    expect((await retried).status).toBe('expired')
    expect(addAgent).not.toHaveBeenCalled()
  })

  it('never resumes an archived session and never turns its old pending row into consent', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    await requestAgentGroupJoin(INPUT, depsFor(fixture, async () => 'unavailable', addAgent))
    fixture.sqlite.prepare("UPDATE sessions SET archived_at = '2026-01-01T00:00:00Z' WHERE id = 'session-1'").run()
    expect(await resumePendingAgentGroupJoins(depsFor(fixture, approving(), addAgent))).toEqual([])
    expect(addAgent).not.toHaveBeenCalled()
    expect(readAgentGroupJoin(fixture.sqlite, 'operation-1')?.status).toBe('pending')
  })

  it('resumes a pending record after a restart under the same operation id', async () => {
    const addAgent = vi.fn(async () => ({ chat_id: 'chat-1', status: 'joined' as const }))
    await requestAgentGroupJoin(INPUT, depsFor(fixture, async () => 'unavailable', addAgent))
    const resumed = await resumePendingAgentGroupJoins(depsFor(fixture, approving(), addAgent))
    expect(resumed).toEqual([expect.objectContaining({ status: 'joined', operationId: 'operation-1' })])
    expect(addAgent).toHaveBeenCalledTimes(1)
  })
})
