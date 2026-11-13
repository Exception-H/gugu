import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { CreateSessionError } from '@shared/core/sessions/create-session';
import type { CreateResidentSessionParams } from '@shared/core/sessions/create-resident-session';
import type { Session, SessionRuntime } from '@shared/core/sessions/sessions';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';

export type NewAgentSubmitBlock =
  | 'name-required'
  | 'first-task-required'
  | 'group-needs-first-turn'
  | 'platform-model-needs-first-turn';

export type NewAgentSubmitPlan =
  | { kind: 'resident' }
  | { kind: 'first-turn' }
  | { kind: 'blocked'; reason: NewAgentSubmitBlock };

/**
 * 一个表单，两条真实结果（P0 1.6 的语义）：
 * - 不勾「建好就开工」= 常驻 Agent：走 createResidentSession，不铸身份、不起进程、不发占位提示词；
 * - 勾了 = 首条任务必须非空，走现有普通创建并投递首轮。
 *
 * resident 动作没有群入参、也没有平台模型入参（0.4 的边界）：同时选中时明确拦下，
 * ❌ 不静默丢掉群 / 换成 harness 模型。
 */
export function planNewAgentSubmit(input: {
  startNow: boolean;
  displayName: string;
  firstTask: string;
  groupChatId?: string | null;
  platformModel?: string | null;
}): NewAgentSubmitPlan {
  if (!input.displayName.trim()) return { kind: 'blocked', reason: 'name-required' };
  if (!input.startNow) {
    if (input.groupChatId) return { kind: 'blocked', reason: 'group-needs-first-turn' };
    if (input.platformModel) return { kind: 'blocked', reason: 'platform-model-needs-first-turn' };
    return { kind: 'resident' };
  }
  if (!input.firstTask.trim()) return { kind: 'blocked', reason: 'first-task-required' };
  return { kind: 'first-turn' };
}

export class ResidentAgentCreateError extends Error {
  readonly code = 'resident-agent-create-failed';
  constructor(readonly failure: CreateSessionError) {
    super(`resident agent creation failed: ${failure.type}`);
    this.name = 'ResidentAgentCreateError';
  }
}

type ResidentRpcClient = {
  sessionCreate: {
    createResidentSession(params: CreateResidentSessionParams): Promise<
      | { success: true; data: { session: Session } }
      | { success: false; error: CreateSessionError }
    >;
  };
};

export type ResidentAgentRequest = {
  /** 同一次提交重试复用同一个 id（0.4 的幂等约定）。 */
  id: string;
  projectId: string;
  workspaceConfig: WorkspaceConfig;
  provider: AgentProviderId;
  runtime: SessionRuntime;
  displayName: string;
  permissionMode?: CreateResidentSessionParams['agent']['permissionMode'];
  model?: string | null;
  effort?: string | null;
};

/** 不勾开工的提交：只调 0.4 的 resident 动作；失败抛带语义码的错误，文案在渲染边界翻。 */
export async function createResidentAgent(
  client: ResidentRpcClient,
  request: ResidentAgentRequest
): Promise<Session> {
  const result = await client.sessionCreate.createResidentSession({
    projectId: request.projectId,
    workspaceConfig: request.workspaceConfig,
    agent: {
      id: request.id,
      provider: request.provider,
      runtime: request.runtime,
      displayName: request.displayName,
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
    },
  });
  if (!result.success) throw new ResidentAgentCreateError(result.error);
  return result.data.session;
}

type DefaultNameRpcClient = {
  sessionCreate: {
    agentDefaultName(params: { provider: AgentProviderId; projectId?: string | null }): Promise<string>;
  };
};

/** 显示名默认值只问主进程的 task-name（按作用域自增），渲染层不自己数序号、不造 slug。 */
export function fetchAgentDefaultName(
  client: DefaultNameRpcClient,
  provider: AgentProviderId,
  projectId: string
): Promise<string> {
  return client.sessionCreate.agentDefaultName({ provider, projectId });
}

/** 失败只给「下一步能做什么」；原始原因留在调用点的日志里。 */
export function newAgentFailureKey(error: unknown):
  | 'newAgent.projectUnavailable'
  | 'newAgent.runtimeUnavailable'
  | 'newAgent.workspaceUnavailable'
  | 'newAgent.createFailed' {
  if (!(error instanceof ResidentAgentCreateError)) return 'newAgent.createFailed';
  switch (error.failure.type) {
    case 'project-not-found':
      return 'newAgent.projectUnavailable';
    case 'harness-unavailable':
      return 'newAgent.runtimeUnavailable';
    case 'provision-failed':
      // 同名冲突也走这一格：给用户的下一步是「换个名字 / 检查项目」，不是只盯着目录。
      return 'newAgent.createFailed';
    case 'provision-timeout':
      return 'newAgent.workspaceUnavailable';
    default:
      return 'newAgent.createFailed';
  }
}
