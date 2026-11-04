import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
import { ask } from '@main/core/asks'
import { sqlite } from '@main/db/client'
import { makeChatClient } from '../supabase'
import {
  requestAgentGroupJoin,
  resumePendingAgentGroupJoins,
  type AgentGroupJoinDeps,
  type AgentGroupJoinInput,
  type AgentGroupJoinOutcome,
} from '@main/core/groups/agent-group-join'

export interface AgentGroupJoinAuth {
  accessToken: string
  userId: string
}

/**
 * The desktop host's real dependencies: the session timeline's `ask`, the local SQLite record, and the one membership RPC.
 * The RPC still runs as the signed-in actor and the database still checks membership and group rules.
 */
export function agentGroupJoinDepsFor(auth: AgentGroupJoinAuth): AgentGroupJoinDeps {
  const admin = createGroupAdmin(makeChatClient(auth.accessToken), auth.userId)
  return {
    sqlite,
    ask: (conversationId, request, options) => ask(conversationId, request, options),
    addAgent: input => admin.addAgent(input.chatId, input.targetAgentId, {
      asTask: input.asTask,
      authorization: { kind: 'agent-confirmed', operationId: input.operationId },
    }),
  }
}

export function requestAgentGroupJoinForAuth(
  input: AgentGroupJoinInput,
  auth: AgentGroupJoinAuth,
): Promise<AgentGroupJoinOutcome> {
  return requestAgentGroupJoin(input, agentGroupJoinDepsFor(auth))
}

/** Boot hook: a pending record survives a restart; this re-asks under its original operation id. */
export function resumeAgentGroupJoinsForAuth(
  auth: AgentGroupJoinAuth,
  filter: { sessionId?: string } = {},
): Promise<AgentGroupJoinOutcome[]> {
  return resumePendingAgentGroupJoins(agentGroupJoinDepsFor(auth), filter)
}
