import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An absolute path reaches one file only: the one the host handed the page. The machine the file is on says so
 * (`fileRootOf`), whoever asks: a page on this desktop, a page on another desktop (its call carried there in `app_call`),
 * a page on the phone. Each case goes through the function its host really calls, and the machine that answers is the
 * real `answerAppCall` → `machineVerbs` → `readWorkingCopy`: only the device RPC between them is a loop here.
 */
const f = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  root: '',
  /** Which machine is answering now: `there` is the one with the session (inside a cross-machine call). */
  side: 'here' as 'here' | 'there',
  answer: null as null | ((caller: unknown, action: unknown) => Promise<unknown>),
}));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: {}, shell: {} }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: () => undefined } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined } }));
vi.mock('@main/core/app/service', () => ({ appService: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    hasCapability: (_app: string, cap: string) => f.capabilities.has(cap),
    isEnabled: () => true,
    get: () => ({ manifest: { id: 'reader', name: 'Reader', version: '1.0.0', contributes: { tabs: [] } } }),
  }),
  extensionDataRoot: () => f.root,
}));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: { agentToolsRefusal: () => null, callFromPage: vi.fn() } }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: { removed() {}, renamed() {} }, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
// The session is on this machine for `local`, and on the other one (`dev-there`) for the cross-machine cases.
const SESSION = '22222222-2222-4222-8222-222222222222';
const scene = vi.hoisted(() => ({ sessionOn: 'here' as 'here' | 'there' }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async () => (scene.sessionOn === f.side ? { workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' } : null),
}));
vi.mock('@main/core/extensions/extension-agents', () => ({
  sessionsElsewhere: async () => ({ rows: [{ deviceId: 'dev-there', deviceLabel: 'there', session: { conversationId: SESSION, projectId: 'p', agent: null } }], unreached: [] }),
}));
/** The device RPC: the call arrives at the other machine's `answerAppCall`, answered there. */
const across = async (caller: unknown, action: unknown) => {
  f.side = 'there';
  try {
    return await f.answer!(caller, JSON.parse(JSON.stringify(action)));
  } finally {
    f.side = 'here';
  }
};
vi.mock('@main/core/sessions/session-family', () => ({
  otherMachines: () => ({ appCall: (caller: unknown, _device: string, action: unknown) => across(caller, action), isThisDevice: async (id: string) => id === 'dev-here' }),
}));
vi.mock('../../../../../src/mobile/agent-watch/sessionpage-rpc', () => ({ appCallOn: (_device: string, caller: unknown, action: unknown) => across(caller, action) }));

const { readAppFile } = await import('./app-files');
const { answerAppCall } = await import('./app-programs-elsewhere');
const { callOnComputer } = await import('../../../../../src/components/appSlot/phoneProgramCall');
f.answer = answerAppCall as never;

const workspace = `session:${SESSION}`;
const DENIED = /Not permitted: an absolute path reaches only the file the host handed this page/;
let outside = '';
let home = '';
let file = '';

beforeEach(async () => {
  f.capabilities.clear();
  f.capabilities.add('files:read');
  f.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-root-')));
  outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-out-')));
  home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-home-')));
  vi.stubEnv('GUGU_HOME', home);
  file = path.join(outside, 'notes.md');
  fs.writeFileSync(file, 'outside');
  fs.writeFileSync(path.join(outside, 'id_ed25519'), 'canary');
  fs.writeFileSync(path.join(f.root, 'in.txt'), 'inside');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [f.root, outside, home]) await fsp.rm(dir, { recursive: true, force: true });
});

const text = (chunk: { data: Uint8Array | string }) => typeof chunk.data === 'string' ? Buffer.from(chunk.data, 'base64').toString() : Buffer.from(chunk.data).toString();
const pageHanded = (handed: string | null, asAgent?: string) =>
  ({ pageId: 7, extensionId: 'reader', handed: handed === null ? null : { workspace, id: handed }, ...(asAgent ? { asAgent } : {}) }) as never;
const read = (page: never, id: string) => readAppFile(page, { ref: { workspace, id }, offset: 0, length: 100 });

describe('a page on this desktop, the session here', () => {
  beforeEach(() => { scene.sessionOn = 'here'; });

  it('reads no outside file it was not handed — nor does the agent working it; the handed one reads', async () => {
    await expect(read(pageHanded(null), file)).rejects.toThrow(DENIED);
    await expect(read(pageHanded(null, 'agent-1'), file)).rejects.toThrow(DENIED);
    await expect(read(pageHanded(file), path.join(outside, 'id_ed25519'))).rejects.toThrow(DENIED);
    expect(text(await read(pageHanded(file), file))).toBe('outside');
    expect(text(await read(pageHanded(null), 'in.txt'))).toBe('inside');
  });
});

describe('a page on another desktop, the session on this machine', () => {
  beforeEach(() => {
    scene.sessionOn = 'there';
    f.capabilities.add('files:read:all-machines');
  });

  it('reads no outside file it was not handed; the handed one, carried with the call, reads there', async () => {
    await expect(read(pageHanded(null), file)).rejects.toThrow(DENIED);
    await expect(read(pageHanded(file), path.join(outside, 'id_ed25519'))).rejects.toThrow(DENIED);
    expect(text(await read(pageHanded(file), file))).toBe('outside');
    expect(text(await read(pageHanded(null), 'in.txt'))).toBe('inside');
  });

  it('a call that names a handed file of another working copy reads nothing outside', async () => {
    const caller = { kind: 'app', deviceId: 'dev-here', deviceLabel: 'here', extensionId: 'reader', extensionName: 'Reader' };
    const action = { action: 'app_call', call_id: 'other-copy', session_id: SESSION, version: '1.0.0', method: 'filesRead',
      args: { ref: { workspace, id: file }, offset: 0, length: 100 }, handed: { workspace: 'session:another', id: file } };
    await expect(across(caller, action)).rejects.toThrow(DENIED);
  });
});

describe('a page on the phone, the session on a computer', () => {
  beforeEach(() => { scene.sessionOn = 'there'; });
  const phone = (args: Record<string, unknown>) => callOnComputer({ extensionId: 'reader', extensionName: 'Reader', version: '1.0.0' },
    { id: SESSION, deviceId: 'dev-there', deviceLabel: 'there' }, 'filesRead', args);

  it('reads no outside file: the phone hands a page no working copy file, and one the page says it was handed is not', async () => {
    await expect(phone({ ref: { workspace, id: file }, offset: 0, length: 100 })).rejects.toThrow(DENIED);
    await expect(phone({ ref: { workspace, id: file }, offset: 0, length: 100, handed: { workspace, id: file } })).rejects.toThrow(DENIED);
    expect(text(await phone({ ref: { workspace, id: 'in.txt' }, offset: 0, length: 100 }) as never)).toBe('inside');
  });
});
