import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import type { CreateSessionError } from './create-session';
import type { GuguPermissionMode } from '@gugu/session-core/acp';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { Session, SessionRuntime } from './sessions';

export type ResidentAgentInput = {
  /** 由调用方预生成的会话 id；同一次提交重试必须复用同一个 id。 */
  id: string;
  provider: AgentProviderId;
  runtime: SessionRuntime;
  /** 用户可见显示名；必填，可中文。不要走 generateSessionName 的 ASCII slug。 */
  displayName: string;
  permissionMode?: GuguPermissionMode;
  model?: string;
  effort?: string;
};

export type CreateResidentSessionParams = {
  projectId: string;
  /** 与普通 createSession 同一个 workspace 结构；未选项目时用隐式任务工作区的 repositoryWorkspaceId。 */
  workspaceConfig: WorkspaceConfig;
  agent: ResidentAgentInput;
};

export type CreateResidentSessionSuccess = {
  session: Session;
};

export type CreateResidentSessionResult =
  | { success: true; data: CreateResidentSessionSuccess }
  | { success: false; error: CreateSessionError };
