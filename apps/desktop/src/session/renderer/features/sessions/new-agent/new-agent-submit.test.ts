import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import type { CreateResidentSessionParams } from '@shared/core/sessions/create-resident-session';
import {
  ResidentAgentCreateError,
  createResidentAgent,
  fetchAgentDefaultName,
  newAgentFailureKey,
  planNewAgentSubmit,
} from './new-agent-submit';

const workspaceConfig = {
  version: '2' as const,
  workspace: { kind: 'repository-instance' as const, workspaceId: 'ws-1' },
};

const session = {
  id: 'resident-1',
  projectId: 'project-1',
  title: '新助手 1',
  providerId: 'codex',
  runtime: 'acp',
  agentStatus: 'idle',
  lastInteractedAt: '2026-11-04T00:00:00.000Z',
} as unknown as Session;

describe('planNewAgentSubmit', () => {
  it('does not require a first task when the agent is resident', () => {
    expect(planNewAgentSubmit({ startNow: false, displayName: '新助手 1', firstTask: '   ' })).toEqual({ kind: 'resident' });
  });

  it('requires a non-empty first task when starting right away', () => {
    expect(planNewAgentSubmit({ startNow: true, displayName: '新助手 1', firstTask: '  \n ' })).toEqual({
      kind: 'blocked',
      reason: 'first-task-required',
    });
    expect(planNewAgentSubmit({ startNow: true, displayName: '新助手 1', firstTask: '修一下登录' })).toEqual({ kind: 'first-turn' });
  });

  it('requires a display name in both modes', () => {
    expect(planNewAgentSubmit({ startNow: false, displayName: '  ', firstTask: '' })).toEqual({ kind: 'blocked', reason: 'name-required' });
    expect(planNewAgentSubmit({ startNow: true, displayName: '', firstTask: '做' })).toEqual({ kind: 'blocked', reason: 'name-required' });
  });

  it('refuses to silently drop a group or platform model on the resident path', () => {
    expect(planNewAgentSubmit({ startNow: false, displayName: '新助手 1', firstTask: '', groupChatId: 'chat-1' })).toEqual({
      kind: 'blocked',
      reason: 'group-needs-first-turn',
    });
    expect(planNewAgentSubmit({ startNow: false, displayName: '新助手 1', firstTask: '', platformModel: 'glm-5.2' })).toEqual({
      kind: 'blocked',
      reason: 'platform-model-needs-first-turn',
    });
  });
});

describe('createResidentAgent', () => {
  it('calls only the resident action with the scoped name and no first turn', async () => {
    const createResidentSession = vi.fn(async () => ({ success: true as const, data: { session } }));
    const client = { sessionCreate: { createResidentSession } };
    await expect(createResidentAgent(client, {
      id: 'resident-1',
      projectId: 'project-1',
      workspaceConfig,
      provider: 'codex',
      runtime: 'acp',
      displayName: '新助手 1',
      permissionMode: 'edit',
      model: 'gpt-5',
      effort: 'high',
    })).resolves.toBe(session);

    expect(createResidentSession).toHaveBeenCalledOnce();
    expect(createResidentSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceConfig,
      agent: {
        id: 'resident-1',
        provider: 'codex',
        runtime: 'acp',
        displayName: '新助手 1',
        permissionMode: 'edit',
        model: 'gpt-5',
        effort: 'high',
      },
    });
    const params = (createResidentSession.mock.calls[0] as unknown as [CreateResidentSessionParams])[0];
    expect(params.agent).not.toHaveProperty('firstUtterance');
    expect(params.agent).not.toHaveProperty('initialPrompt');
  });

  it('throws a semantic error instead of returning a half-created session', async () => {
    const client = {
      sessionCreate: {
        createResidentSession: vi.fn(async () => ({ success: false as const, error: { type: 'project-not-found' as const } })),
      },
    };
    const error = await createResidentAgent(client, {
      id: 'resident-1', projectId: 'missing', workspaceConfig, provider: 'codex', runtime: 'acp', displayName: '新助手 1',
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResidentAgentCreateError);
    expect(newAgentFailureKey(error)).toBe('newAgent.projectUnavailable');
  });
});

describe('fetchAgentDefaultName', () => {
  it('asks for the name in the selected project scope', async () => {
    const agentDefaultName = vi.fn(async () => '新助手 3');
    await expect(fetchAgentDefaultName({ sessionCreate: { agentDefaultName } }, 'codex', 'project-a')).resolves.toBe('新助手 3');
    expect(agentDefaultName).toHaveBeenCalledWith({ provider: 'codex', projectId: 'project-a' });
  });
});

describe('newAgentFailureKey', () => {
  it.each([
    [{ type: 'project-not-found' }, 'newAgent.projectUnavailable'],
    [{ type: 'harness-unavailable', reason: 'missing', providerId: 'codex', harnessName: 'codex', detail: 'x' }, 'newAgent.runtimeUnavailable'],
    [{ type: 'provision-failed', message: 'x' }, 'newAgent.createFailed'],
    [{ type: 'provision-timeout', timeoutMs: 1 }, 'newAgent.workspaceUnavailable'],
  ] as const)('maps a known failure to an actionable next step', (failure, key) => {
    expect(newAgentFailureKey(new ResidentAgentCreateError(failure))).toBe(key);
  });

  it('falls back to a generic line for unknown errors', () => {
    expect(newAgentFailureKey(new Error('boom'))).toBe('newAgent.createFailed');
  });
});
