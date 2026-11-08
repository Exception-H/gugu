import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';

/** Gugu's own server in `session/new.mcpServers` (GUGU_MCP_SERVER_NAME on the desktop side). */
const GUGU_SERVER = 'gugu';

type Wire = { id?: unknown; method?: string; result?: unknown; params?: Record<string, unknown> };

/**
 * Gugu's own MCP server never asks, same as on Claude and Codex: an agent must be able to reply in chat with nobody at
 * the approval prompt. Kiro has no per-session rule for this (presets cannot name an MCP server, and permissions.yaml
 * is the user's own file), so the request is answered here. The identity is Kiro's structured `mcpTool` block, never the
 * tool title, which a shell call could imitate. Measured on 3.0.0: `@gugu/ping_probe` under `edit-workspace` asks.
 */
export function preApproveGuguTool(request: RequestPermissionRequest): string | undefined {
  const kiro = request._meta?.kiro as { mcpTool?: { identity?: { serverName?: unknown } } } | undefined;
  if (kiro?.mcpTool?.identity?.serverName !== GUGU_SERVER) return undefined;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId;
}

/**
 * Kiro drops every MCP server, session-injected ones included, when an organization turns MCP off or when it cannot
 * reach its governance API (kiro.dev/docs/enterprise/governance/mcp; the fail-closed branch is measured on 3.0.0).
 * An agent without Gugu's server cannot reply in chat, so this must reach the transcript. Kiro reports it only in
 * `_kiro/*` notifications, which otherwise end up ignored by the ACP client.
 *
 * Each cause becomes one provider `notice` per session. A notice raised while `session/new` is still in flight would
 * be dropped (no route for the session yet), so it waits for the first `session/update` after that response.
 */
export function createKiroMcpNotices(): (message: Wire) => SessionNotification[] {
  const raised = new Set<string>();
  const pending = new Map<string, SessionNotification[]>();
  const routed = new Set<string>();
  let responses = 0;

  const raise = (sessionId: unknown, cause: string): SessionNotification[] => {
    if (typeof sessionId !== 'string' || raised.has(sessionId)) return [];
    raised.add(sessionId);
    const notice = {
      sessionId,
      update: { sessionUpdate: 'notice', title: 'Gugu tools are unavailable in this Kiro session', description: cause },
    } as unknown as SessionNotification;
    if (routed.has(sessionId)) return [notice];
    pending.set(sessionId, [...(pending.get(sessionId) ?? []), notice]);
    return [];
  };

  return (message) => {
    const params = message.params;
    if (message.id !== undefined && message.result !== undefined) responses += 1;
    switch (message.method) {
      case 'session/update': {
        const sessionId = params?.sessionId;
        // Two responses: `initialize`, then the `session/new` or `session/load` this session came from.
        if (typeof sessionId !== 'string' || responses < 2 || routed.has(sessionId)) return [];
        routed.add(sessionId);
        const held = pending.get(sessionId) ?? [];
        pending.delete(sessionId);
        return held;
      }
      case '_kiro/mcp/governance_disabled':
        return raise(params?.sessionId, params?.apiFailure
          ? 'Kiro could not reach its governance service, so it disabled MCP for now.'
          : 'Your organization has disabled MCP in Kiro.');
      case '_kiro/governance/state': {
        const features = params?.features as { mcpEnabled?: unknown } | undefined;
        return features?.mcpEnabled === false
          ? raise(params?.sessionId, 'Your organization has disabled MCP in Kiro.')
          : [];
      }
      case '_kiro/mcp/status': {
        const servers = (params?.servers ?? []) as { name?: unknown; status?: unknown; error?: unknown }[];
        const gugu = servers.find((server) => server.name === GUGU_SERVER);
        return gugu?.status === 'failed' || gugu?.status === 'disabled'
          ? raise(params?.sessionId, `Kiro reports the gugu MCP server as ${String(gugu.status)}${typeof gugu.error === 'string' ? `: ${gugu.error}` : '.'}`)
          : [];
      }
      default:
        return [];
    }
  };
}
