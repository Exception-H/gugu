import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ taskNameFor: vi.fn() }));
vi.mock('./task-name', () => ({ taskNameFor: mocks.taskNameFor }));

const { agentDefaultName } = await import('./agent-default-name');

describe('agentDefaultName', () => {
  beforeEach(() => {
    mocks.taskNameFor.mockReset();
    mocks.taskNameFor.mockResolvedValue('新助手 3');
  });

  it('forwards the project scope to the delivered task-name rule', async () => {
    await expect(agentDefaultName('codex', 'project-a')).resolves.toBe('新助手 3');
    expect(mocks.taskNameFor).toHaveBeenCalledWith('codex', null, 'project-a');
  });

  it('keeps the implicit task workspace when no project is given', async () => {
    await agentDefaultName('claude', null);
    expect(mocks.taskNameFor).toHaveBeenCalledWith('claude', null, null);
  });
});
