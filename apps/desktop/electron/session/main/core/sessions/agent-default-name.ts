import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { taskNameFor } from './task-name';

/**
 * The default display name for a new agent, counted inside one scope (a project, or the implicit
 * task workspace). This is the renderer-facing read of the naming rule delivered in 0.6: the form
 * must not invent its own numbering and must not use the ASCII session slug.
 */
export function agentDefaultName(
  provider: AgentProviderId,
  projectId?: string | null
): Promise<string> {
  return taskNameFor(provider, null, projectId);
}
