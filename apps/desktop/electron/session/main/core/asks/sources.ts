import type { AskSource } from '@gugu/session-core/session-record/contract';
import type { AgentWaitKind } from '@gugu/core/shared/agentStatus';
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions';
/**
 * How long a person has to answer "may this Agent join that group". The ask is the only consent; once it lapses the
 * pending record expires and the membership call is never made. Kept in one place: the store and the Ask deadline must
 * agree, or a record could outlive the answer it is waiting for.
 */
export const GROUP_JOIN_CONSENT_HUMAN_WINDOW_MS = 15 * 60_000;
export type AskSourceSpec = { waitKind: AgentWaitKind; raisedBy: 'runtime' | 'host'; timeoutMs?: number };
export const ASK_SOURCE_SPEC = {
  'harness-permission': { waitKind: 'approval', raisedBy: 'runtime' },
  'harness-question': { waitKind: 'question', raisedBy: 'runtime' },
  'agent-question': { waitKind: 'question', raisedBy: 'host' },
  'app-install': { waitKind: 'approval', raisedBy: 'host', timeoutMs: INSTALL_CONSENT_HUMAN_WINDOW_MS },
  'group-join': { waitKind: 'approval', raisedBy: 'host', timeoutMs: GROUP_JOIN_CONSENT_HUMAN_WINDOW_MS },
} as const satisfies Record<AskSource, AskSourceSpec>;

/** Archived records may name a source removed in a later release. */
export function askSourceSpec(source: string): AskSourceSpec | undefined {
  return Object.hasOwn(ASK_SOURCE_SPEC, source) ? ASK_SOURCE_SPEC[source as AskSource] : undefined;
}
