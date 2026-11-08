import { describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle, SessionMaterializationContext } from '@gugu/session-core/agents/plugins';
import { pluginRegistry, listUserExposedPlugins } from '../../registry';
import { kiroAuthStatus } from './auth';
import { createKiroMcpNotices, preApproveGuguTool } from './notices';
import { materializeKiroSessionBundle } from './session-bundle';

const ctx = { surface: 'acp', cwd: '/w', lifecycle: 'new' } as unknown as SessionMaterializationContext;
const bundle = (autonomy: unknown): SessionCapabilityBundle => ({
  env: { GUGU_TOKEN: 'secret', KEEP: 'yes' },
  mcpServers: [{ name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', authorizationEnv: 'GUGU_TOKEN' }],
  promptBlocks: { identity: 'I am kiro' },
  autonomy,
  model: null,
} as unknown as SessionCapabilityBundle);

describe('kiro session bundle', () => {
  it.each([
    ['read-only', ['read-workspace']],
    ['edit', ['edit-workspace', 'dev-shell']],
    ['full-access', ['allow-all']],
  ])('%s opens with its policy presets on session/new', (permissionMode, policyPreset) => {
    const result = materializeKiroSessionBundle(ctx, bundle({ mode: 'approval-required', permissionMode }));
    expect(result.acp?.meta).toEqual({ kiro: { policyPreset } });
  });

  it('plan is stricter than every Kiro tier: refuses to start rather than open looser', () => {
    expect(() => materializeKiroSessionBundle(ctx, bundle({ mode: 'approval-required', permissionMode: 'plan' })))
      .toThrow("no permission mode for 'plan'");
  });

  it('the MCP token leaves the process environment and identity rides the session context', () => {
    const result = materializeKiroSessionBundle(ctx, bundle({ mode: 'approval-required', permissionMode: 'edit' }));
    expect(result.env).toEqual({ KEEP: 'yes' });
    expect(result.acp?.mcpServers).toHaveLength(1);
    expect(result.prompt?.carrier).toBe('session-context');
  });

  it('is on sale with the vendor-closed model and every other unit native', () => {
    expect(listUserExposedPlugins().map((provider) => provider.metadata.id)).toContain('kiro');
    const { units } = pluginRegistry.get('kiro')!.capabilities.sessionBundle;
    expect(units.model).toMatchObject({ kind: 'none', degraded: { code: 'unsupported-channel' } });
    for (const unit of [units.mcp, units.env, units.autonomy, units.promptBlocks]) expect(unit.kind).toBe('native');
  });

  it('offers no install command on Windows, where the registry has no build, and keeps the docs link', () => {
    const declared = pluginRegistry.get('kiro')!.capabilities.hostDependency;
    expect(Object.keys(declared.installCommands).sort()).toEqual(['linux', 'macos']);
    expect(declared.installDocs).toContain('kiro.dev');
  });
});

describe('kiro sign-in status', () => {
  const statusOf = (exec: () => Promise<{ stdout: string; stderr: string }>) =>
    kiroAuthStatus({ cli: 'kiro-cli', exec, fs: {} as never, env: {} });

  it('reads Kiro\'s own whoami: signed in, signed out, and a failed instrument', async () => {
    expect(await statusOf(async () => ({ stdout: '{"account":{}}', stderr: '' }))).toEqual({ kind: 'authenticated' });
    await expect(statusOf(async () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: '{"account":null}' }); }))
      .resolves.toMatchObject({ kind: 'unauthenticated' });
    await expect(statusOf(async () => { throw Object.assign(new Error('timed out'), { killed: true }); }))
      .resolves.toMatchObject({ kind: 'unknown' });
  });
});

describe('kiro MCP notices', () => {
  const response = (id: number) => ({ id, result: {} });
  const update = { method: 'session/update', params: { sessionId: 's', update: {} } };
  const failed = { method: '_kiro/mcp/status', params: { sessionId: 's', servers: [{ name: 'gugu', status: 'failed', error: 'boom' }] } };

  it('holds a notice raised before the session is routed, then raises it once', () => {
    const observe = createKiroMcpNotices();
    observe(response(1));
    expect(observe(failed)).toEqual([]);
    expect(observe(update)).toEqual([]);
    observe(response(2));
    const released = observe(update);
    expect(released).toHaveLength(1);
    expect(JSON.stringify(released[0])).toContain('boom');
    expect(observe(failed)).toEqual([]);
    expect(observe(update)).toEqual([]);
  });

  it('stays quiet while gugu connects, and for other servers', () => {
    const observe = createKiroMcpNotices();
    observe(response(1)); observe(response(2)); observe(update);
    expect(observe({ method: '_kiro/mcp/status', params: { sessionId: 's', servers: [{ name: 'gugu', status: 'connecting' }] } })).toEqual([]);
    expect(observe({ method: '_kiro/mcp/status', params: { sessionId: 's', servers: [{ name: 'other', status: 'failed' }] } })).toEqual([]);
    expect(observe({ method: '_kiro/governance/state', params: { sessionId: 's', features: { mcpEnabled: true } } })).toEqual([]);
  });

  it('raises for an organization that disabled MCP and for an unreachable governance service', () => {
    const off = createKiroMcpNotices();
    off(response(1)); off(response(2)); off(update);
    expect(JSON.stringify(off({ method: '_kiro/governance/state', params: { sessionId: 's', features: { mcpEnabled: false } } })))
      .toContain('organization has disabled');
    const down = createKiroMcpNotices();
    down(response(1)); down(response(2)); down(update);
    expect(JSON.stringify(down({ method: '_kiro/mcp/governance_disabled', params: { sessionId: 's', apiFailure: true } })))
      .toContain('could not reach');
  });
});

describe('kiro pre-approval of Gugu tools', () => {
  const options = [
    { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ];
  const request = (kiro: unknown, title = '@gugu/message_send') =>
    ({ sessionId: 's', toolCall: { toolCallId: 't', title }, options, _meta: { kiro } }) as never;

  it('approves only by the structured identity of the gugu server', () => {
    expect(preApproveGuguTool(request({ mcpTool: { identity: { serverName: 'gugu' } } }))).toBe('accept');
    expect(preApproveGuguTool(request({ mcpTool: { identity: { serverName: 'other' } } }))).toBeUndefined();
    // A title alone proves nothing: a shell call could be named anything.
    expect(preApproveGuguTool(request({ consent: { capability: 'shell' } }))).toBeUndefined();
  });
});
