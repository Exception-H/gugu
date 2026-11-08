import { describe, expect, it } from 'vitest';
import { kilocodeModelCredential } from './auth';
import { materializeKilocodeSessionBundle } from './session-bundle';

const GUGU_HOME = '/gugu-home-under-test';

function materialize(surface: 'acp' | 'tui', permissionMode: string) {
  const out = materializeKilocodeSessionBundle(
    { surface, lifecycle: 'fresh', cwd: '/worktree' },
    {
      mcpServers: [
        { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp' },
        { name: 'connected-apps', transport: 'http', url: 'http://127.0.0.1:2/mcp', owner: 'gugu' },
        { name: 'mine', transport: 'http', url: 'http://127.0.0.1:3/mcp', owner: 'user' },
      ],
      env: { GUGU_HOME },
      model: null,
      autonomy: { mode: permissionMode === 'full-access' ? 'full-access' : 'approval-required', permissionMode },
      promptBlocks: { platform: 'PLATFORM', identity: 'IDENTITY' },
      packages: [],
    } as never,
  );
  return { out, config: JSON.parse(out.env.KILO_CONFIG_CONTENT!) as Record<string, any> };
}

describe('Kilo session bundle', () => {
  it('keeps Gugu tools usable in guarded modes, but not the servers the user added', () => {
    for (const mode of ['plan', 'ask']) {
      expect(materialize('acp', 'read-only').config.agent[mode].permission).toEqual({
        'gugu_*': 'allow',
        'connected-apps_*': 'allow',
      });
    }
  });

  it('keeps approval rules across modes because the session can switch to code live', () => {
    for (const mode of ['plan', 'read-only', 'edit']) {
      expect(materialize('acp', mode).config.permission.bash).toBe('ask');
    }
    expect(materialize('acp', 'full-access').config.permission).toBe('allow');
  });

  it('selects the guarded agent at session creation for the serve leg', () => {
    expect(materialize('tui', 'plan').out.sessionCreatePatch).toEqual({ agent: 'plan' });
    expect(materialize('tui', 'read-only').out.sessionCreatePatch).toEqual({ agent: 'ask' });
    expect(materialize('tui', 'edit').out.sessionCreatePatch).toBeUndefined();
  });

  it('keeps session transcripts and telemetry away from the vendor', () => {
    const { env } = materialize('acp', 'edit').out;
    expect(env.KILO_TELEMETRY_LEVEL).toBe('off');
    expect(env.KILO_DISABLE_SESSION_INGEST).toBe('1');
  });

  it('retires the workspace plugin instead of writing it', () => {
    const { out } = materialize('acp', 'edit');
    expect(out.artifacts.map((artifact) => artifact.path)).not.toContain('/worktree/.kilo/plugins/gugu-notifications.js');
    expect(out.retiredArtifacts?.[0]?.path).toBe('/worktree/.kilo/plugins/gugu-notifications.js');
  });
});

describe('Kilo default model credential', () => {
  const ctx = (env: Record<string, string>, files: Record<string, string> = {}) =>
    ({ env, fs: { read: async (path: string) => files[path] ?? null } }) as never;

  it('reads its built-in gateway without a models.dev snapshot', async () => {
    expect(await kilocodeModelCredential(ctx({}), 'kilo/google/gemini-3-pro-image')).toBe('uncredentialed');
    expect(await kilocodeModelCredential(ctx({ KILO_API_KEY: 'k' }), 'kilo/x')).toBe('credentialed');
    expect(await kilocodeModelCredential(ctx({}, { '.local/share/kilo/auth.json': '{"kilo":{}}' }), 'kilo/x')).toBe('credentialed');
  });

  it('stays unknown for other providers when the snapshot is missing', async () => {
    expect(await kilocodeModelCredential(ctx({}), 'openai/gpt')).toBe('unknown');
  });
});
