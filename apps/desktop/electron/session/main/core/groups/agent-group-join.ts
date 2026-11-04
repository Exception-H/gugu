import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { PendingRequest } from '@gugu/session-core/session-record/contract'
import type { GroupJoinAuthorization as GroupJoinPermission, GroupJoinReceipt } from '@gugu/core/cloud/groupAdmin'
import { GROUP_JOIN_CONSENT_HUMAN_WINDOW_MS } from '@main/core/asks/sources'

/** The approval options this ask exposes; the record settles only on one of them. */
export const GROUP_JOIN_ALLOW_OPTION = 'group-join:allow'
export const GROUP_JOIN_DENY_OPTION = 'group-join:deny'

export type AgentGroupJoinStatus =
  | 'pending'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'denied'
  | 'expired'
  | 'withdrawn'
  | 'failed'

export type AgentGroupJoinRow = {
  id: string
  operationKey: string
  sessionId: string
  chatId: string
  targetAgentId: string
  actorUserId: string
  initiatorAgentId: string
  asTask: boolean
  status: AgentGroupJoinStatus
  digest: string
  createdAt: number
  expiresAt: number
  decidedAt: number | null
  decidedBy: string | null
  appliedAt: number | null
  resultStatus: string | null
  lastError: string | null
}

export type AgentGroupJoinOutcome =
  | {
      status: 'joined' | 'pending_approval' | 'already_member'
      operationId: string
      chatId: string
      targetAgentId: string
      receipt: GroupJoinReceipt
    }
  | {
      status: 'denied' | 'expired' | 'withdrawn' | 'unavailable' | 'in_progress'
      operationId: string
      chatId: string
      targetAgentId: string
      reason?: string
    }
  | {
      status: 'failed'
      operationId: string
      chatId: string
      targetAgentId: string
      error: string
    }

type AskAnswer = { optionId: string; by: string; digest?: string }
type AskResult = AskAnswer | 'withdrawn' | 'timeout' | 'unavailable'
export type AgentGroupJoinAsk = (
  conversationId: string,
  request: PendingRequest & { origin: NonNullable<PendingRequest['origin']> },
  options: { timeoutMs?: number; refuse?: (answer: AskAnswer) => string | null },
) => Promise<AskResult>

export interface AgentGroupJoinDeps {
  sqlite: Database.Database
  /** The host's real `ask()`; tests replace it. */
  ask: AgentGroupJoinAsk
  /** The one membership call. It must pass `authorization` through to `createGroupAdmin.addAgent`. */
  addAgent: (input: {
    chatId: string
    targetAgentId: string
    asTask: boolean
    operationId: string
    authorization: Extract<GroupJoinPermission, { kind: 'agent-confirmed' }>
  }) => Promise<GroupJoinReceipt>
  now?: () => number
  newOperationId?: () => string
  ttlMs?: number
}

export interface AgentGroupJoinInput {
  /** The session whose timeline asks the person. It must exist; no session = unavailable, never approval. */
  sessionId: string
  chatId: string
  /** The Agent being added (may be the initiator or one of the owner's other Agents). */
  targetAgentId: string
  /** The signed-in person whose authority the membership call uses. */
  actorUserId: string
  /** The Agent that asked for this join. */
  initiatorAgentId: string
  asTask: boolean
}

type Row = {
  id: string
  operation_key: string
  session_id: string
  chat_id: string
  target_agent_id: string
  actor_user_id: string
  initiator_agent_id: string
  as_task: number
  status: AgentGroupJoinStatus
  digest: string
  created_at: number
  expires_at: number
  decided_at: number | null
  decided_by: string | null
  applied_at: number | null
  result_status: string | null
  last_error: string | null
}

const ACTIVE = "('pending','approved','applying','applied')"
const inflight = new Map<string, Promise<AgentGroupJoinOutcome>>()

function rowOf(value: Row | undefined): AgentGroupJoinRow | null {
  if (!value) return null
  return {
    id: value.id,
    operationKey: value.operation_key,
    sessionId: value.session_id,
    chatId: value.chat_id,
    targetAgentId: value.target_agent_id,
    actorUserId: value.actor_user_id,
    initiatorAgentId: value.initiator_agent_id,
    asTask: value.as_task === 1,
    status: value.status,
    digest: value.digest,
    createdAt: value.created_at,
    expiresAt: value.expires_at,
    decidedAt: value.decided_at,
    decidedBy: value.decided_by,
    appliedAt: value.applied_at,
    resultStatus: value.result_status,
    lastError: value.last_error,
  }
}

/** Bind one operation: every field a person is approving is inside the digest. */
export function agentGroupJoinDigest(input: AgentGroupJoinInput & { operationId: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.operationId,
      input.sessionId,
      input.chatId,
      input.targetAgentId,
      input.actorUserId,
      input.initiatorAgentId,
      input.asTask,
    ]))
    .digest('hex')
}

export function agentGroupJoinOperationKey(input: AgentGroupJoinInput): string {
  return JSON.stringify([input.sessionId, input.chatId, input.targetAgentId, input.asTask])
}

export function readAgentGroupJoin(sqlite: Database.Database, id: string): AgentGroupJoinRow | null {
  return rowOf(sqlite.prepare('SELECT * FROM agent_group_join_requests WHERE id = ?').get(id) as Row | undefined)
}

/** Pending rows a restart may resume: still inside their deadline, not withdrawn or answered. */
export function listPendingAgentGroupJoins(sqlite: Database.Database, now = Date.now()): AgentGroupJoinRow[] {
  // An archived session's ask was withdrawn; a restart must not re-ask it. The row stays for the audit, but it is not
  // resumed and can never become consent.
  const rows = sqlite
    .prepare(`
      SELECT r.* FROM agent_group_join_requests r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.status = 'pending' AND r.expires_at > ? AND s.archived_at IS NULL
      ORDER BY r.created_at
    `)
    .all(now) as Row[]
  return rows.map(row => rowOf(row)!).filter(Boolean)
}

function activeRow(sqlite: Database.Database, key: string): AgentGroupJoinRow | null {
  return rowOf(sqlite
    .prepare(`SELECT * FROM agent_group_join_requests WHERE operation_key = ? AND status IN ${ACTIVE} ORDER BY created_at DESC LIMIT 1`)
    .get(key) as Row | undefined)
}

function outcomeOf(row: AgentGroupJoinRow): AgentGroupJoinOutcome {
  const base = { operationId: row.id, chatId: row.chatId, targetAgentId: row.targetAgentId }
  if (row.status === 'applied') {
    const status = row.resultStatus === 'pending_approval' || row.resultStatus === 'already_member' ? row.resultStatus : 'joined'
    return { ...base, status, receipt: { chat_id: row.chatId, status } }
  }
  if (row.status === 'denied' || row.status === 'expired' || row.status === 'withdrawn') return { ...base, status: row.status }
  if (row.status === 'failed') return { ...base, status: 'failed', error: row.lastError ?? 'the group did not confirm membership' }
  return { ...base, status: 'in_progress' }
}

function runOnce(id: string, work: () => Promise<AgentGroupJoinOutcome>): Promise<AgentGroupJoinOutcome> {
  // A retry of the same open operation waits on the first ask instead of opening a second card for the same item id.
  const running = inflight.get(id)
  if (running) return running
  const started = work().finally(() => {
    if (inflight.get(id) === started) inflight.delete(id)
  })
  inflight.set(id, started)
  return started
}

function insertPending(
  sqlite: Database.Database,
  row: AgentGroupJoinRow,
): void {
  sqlite.prepare(`
    INSERT INTO agent_group_join_requests
      (id, operation_key, session_id, chat_id, target_agent_id, actor_user_id, initiator_agent_id,
       as_task, status, digest, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.operationKey, row.sessionId, row.chatId, row.targetAgentId, row.actorUserId, row.initiatorAgentId,
    row.asTask ? 1 : 0, row.status, row.digest, row.createdAt, row.expiresAt,
  )
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(error.message)
}

function settle(
  sqlite: Database.Database,
  id: string,
  status: AgentGroupJoinStatus,
  fields: { decidedAt?: number; decidedBy?: string | null; lastError?: string | null } = {},
): number {
  return sqlite.prepare(`
    UPDATE agent_group_join_requests
    SET status = ?, decided_at = COALESCE(?, decided_at), decided_by = COALESCE(?, decided_by), last_error = COALESCE(?, last_error)
    WHERE id = ? AND status = 'pending'
  `).run(status, fields.decidedAt ?? null, fields.decidedBy ?? null, fields.lastError ?? null, id).changes
}

function claim(
  sqlite: Database.Database,
  id: string,
): boolean {
  return sqlite.prepare("UPDATE agent_group_join_requests SET status = 'applying' WHERE id = ? AND status = 'approved'").run(id).changes === 1
}

function applyResult(
  sqlite: Database.Database,
  id: string,
  result: { status: 'joined' | 'pending_approval' | 'already_member' },
  now: number,
): void {
  sqlite.prepare("UPDATE agent_group_join_requests SET status = 'applied', applied_at = ?, result_status = ?, last_error = NULL WHERE id = ?")
    .run(now, result.status, id)
}

function applyFailure(sqlite: Database.Database, id: string, message: string): void {
  sqlite.prepare("UPDATE agent_group_join_requests SET status = 'failed', last_error = ? WHERE id = ?").run(message.slice(0, 2000), id)
}

async function execute(
  row: AgentGroupJoinRow,
  deps: AgentGroupJoinDeps,
  now: () => number,
): Promise<AgentGroupJoinOutcome> {
  if (row.status === 'applied') return outcomeOf(row)
  if (row.status === 'applying') return outcomeOf(row)
  if (!claim(deps.sqlite, row.id)) return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id) ?? row)
  try {
    const receipt = await deps.addAgent({
      chatId: row.chatId,
      targetAgentId: row.targetAgentId,
      asTask: row.asTask,
      operationId: row.id,
      authorization: { kind: 'agent-confirmed', operationId: row.id },
    })
    if (!['joined', 'pending_approval', 'already_member'].includes(receipt.status)) {
      throw new Error('add_group_agent: unexpected membership result')
    }
    applyResult(deps.sqlite, row.id, { status: receipt.status }, now())
    const applied = readAgentGroupJoin(deps.sqlite, row.id)!
    return outcomeOf(applied)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A human said yes; the database still said no (role, group rules, offline). No membership is invented.
    applyFailure(deps.sqlite, row.id, message)
    return { status: 'failed', operationId: row.id, chatId: row.chatId, targetAgentId: row.targetAgentId, error: message }
  }
}

async function askAndSettle(
  row: AgentGroupJoinRow,
  deps: AgentGroupJoinDeps,
  now: () => number,
): Promise<AgentGroupJoinOutcome> {
  const request: PendingRequest & { origin: NonNullable<PendingRequest['origin']> } = {
    itemId: row.id,
    kind: 'permission',
    title: `Allow Agent ${row.targetAgentId} to join group ${row.chatId}`,
    detail: `Operation ${row.id}. Nothing is added until you answer.`,
    options: [
      { optionId: GROUP_JOIN_ALLOW_OPTION, name: 'Allow once', kind: 'allow_once' },
      { optionId: GROUP_JOIN_DENY_OPTION, name: "Don't add", kind: 'reject_once' },
    ],
    origin: {
      source: 'group-join',
      payload: {
        operationId: row.id,
        chatId: row.chatId,
        targetAgentId: row.targetAgentId,
        actorUserId: row.actorUserId,
        initiatorAgentId: row.initiatorAgentId,
        asTask: row.asTask,
        digest: row.digest,
        expiresAt: row.expiresAt,
      },
    },
  }
  let result: AskResult
  try {
    result = await deps.ask(row.sessionId, request, {
      timeoutMs: Math.max(1, row.expiresAt - now()),
      // Only an answer that names this operation's digest may approve it. The item id already scopes the settlement;
      // the digest additionally refuses a surface that answered from a stale payload.
      refuse: answer => (answer.digest && answer.digest !== row.digest
        ? 'This answer does not belong to the group-join operation that is waiting'
        : null),
    })
  } catch (error) {
    // No answer surface: keep the record pending (it may be asked again while it is still inside its deadline).
    return {
      status: 'unavailable', operationId: row.id, chatId: row.chatId, targetAgentId: row.targetAgentId,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (result === 'unavailable') {
    return { status: 'unavailable', operationId: row.id, chatId: row.chatId, targetAgentId: row.targetAgentId }
  }
  if (result === 'timeout') {
    // The clock running out is not a yes.
    settle(deps.sqlite, row.id, 'expired', { decidedAt: now(), lastError: 'the person did not answer before the deadline' })
    return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id)!)
  }
  if (result === 'withdrawn') {
    settle(deps.sqlite, row.id, 'withdrawn', { decidedAt: now() })
    return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id)!)
  }
  if (result.optionId !== GROUP_JOIN_ALLOW_OPTION || (result.digest !== undefined && result.digest !== row.digest)) {
    // An unknown option, or an answer carrying another operation's digest, is not permission either.
    settle(deps.sqlite, row.id, 'denied', { decidedAt: now(), decidedBy: result.by })
    return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id)!)
  }
  if (now() > row.expiresAt) {
    settle(deps.sqlite, row.id, 'expired', { decidedAt: now(), lastError: 'the answer arrived after the deadline' })
    return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id)!)
  }
  if (settle(deps.sqlite, row.id, 'approved', { decidedAt: now(), decidedBy: result.by }) !== 1) {
    return outcomeOf(readAgentGroupJoin(deps.sqlite, row.id) ?? row)
  }
  return execute(readAgentGroupJoin(deps.sqlite, row.id)!, deps, now)
}

function validate(input: AgentGroupJoinInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && !value.trim()) throw new Error(`agent group join: ${name} is required`)
  }
}

/**
 * Ask one person to approve adding one Agent to one existing group, and only then call the membership RPC.
 *
 * Persisted before `ask()`: rejection, timeout, withdrawal, offline (`unavailable`) and an unknown option each leave a
 * terminal/pending state and never reach `approved`. A retry of an applied operation returns its cached receipt without a
 * second RPC; a retry of an open operation joins the first ask. The membership call still carries the actor and the
 * database still checks role and group rules — this consent is not authorization.
 */
export async function requestAgentGroupJoin(
  input: AgentGroupJoinInput,
  deps: AgentGroupJoinDeps,
): Promise<AgentGroupJoinOutcome> {
  validate(input)
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? GROUP_JOIN_CONSENT_HUMAN_WINDOW_MS
  const key = agentGroupJoinOperationKey(input)

  const continueWith = (row: AgentGroupJoinRow): Promise<AgentGroupJoinOutcome> => {
    if (row.status === 'applied') return Promise.resolve(outcomeOf(row))
    if (row.status === 'applying') return Promise.resolve(outcomeOf(row))
    if (row.status === 'approved') return runOnce(row.id, () => execute(row, deps, now))
    if (row.status === 'pending') {
      if (row.expiresAt <= now()) {
        settle(deps.sqlite, row.id, 'expired', { decidedAt: now(), lastError: 'the previous ask ran out before an answer' })
        return Promise.resolve(outcomeOf(readAgentGroupJoin(deps.sqlite, row.id)!))
      }
      return runOnce(row.id, () => askAndSettle(row, deps, now))
    }
    return Promise.resolve(outcomeOf(row))
  }

  const existing = activeRow(deps.sqlite, key)
  if (existing) return continueWith(existing)

  const id = deps.newOperationId?.() ?? randomUUID()
  const createdAt = now()
  const pending: AgentGroupJoinRow = {
    id,
    operationKey: key,
    sessionId: input.sessionId,
    chatId: input.chatId,
    targetAgentId: input.targetAgentId,
    actorUserId: input.actorUserId,
    initiatorAgentId: input.initiatorAgentId,
    asTask: input.asTask,
    status: 'pending',
    digest: agentGroupJoinDigest({ ...input, operationId: id }),
    createdAt,
    expiresAt: createdAt + ttl,
    decidedAt: null,
    decidedBy: null,
    appliedAt: null,
    resultStatus: null,
    lastError: null,
  }
  try {
    insertPending(deps.sqlite, pending)
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // Two retries raced to open the same operation; the winner's row is the only ask.
    const raced = activeRow(deps.sqlite, key)
    if (!raced) throw error
    return continueWith(raced)
  }
  return continueWith(pending)
}

/**
 * Resume asks that survived a process restart. The durable rows are the source; `hostAsks` was only the live view.
 * Callers pass the same dependencies they use for a fresh request (the owner's auth supplies `addAgent`).
 */
export async function resumePendingAgentGroupJoins(
  deps: AgentGroupJoinDeps,
  filter: { sessionId?: string } = {},
): Promise<AgentGroupJoinOutcome[]> {
  const now = deps.now ?? Date.now
  const rows = listPendingAgentGroupJoins(deps.sqlite, now())
    .filter(row => !filter.sessionId || row.sessionId === filter.sessionId)
  const outcomes: AgentGroupJoinOutcome[] = []
  for (const row of rows) {
    outcomes.push(await runOnce(row.id, () => askAndSettle(row, deps, now)))
  }
  return outcomes
}
