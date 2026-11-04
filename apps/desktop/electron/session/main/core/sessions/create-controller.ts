import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import type { CreateResidentSessionParams } from '@shared/core/sessions/create-resident-session';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { agentDefaultName } from './agent-default-name';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';
import { admitFirstMessages } from './session-life-creation';

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  // 常驻 Agent:只建一行可列出、可打开、可恢复的会话,不发送首轮、不铸身份、不进群、不起进程。
  async createResidentSession(params: CreateResidentSessionParams) {
    return sessionService.createResidentSession(params);
  },
  // 新建 Agent 表单的显示名默认值:按 projectId 的作用域自增，中文原样，❌ 不是会话 slug。
  async agentDefaultName(params: { provider: CreateResidentSessionParams['agent']['provider']; projectId?: string | null }) {
    return agentDefaultName(params.provider, params.projectId);
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  // The desktop task page's launch of the session it just created: workspace first, then its creation turns.
  async provisionWorkspace(sessionId: string, options?: { deferFirstTurn?: boolean }) {
    const result = await sessionService.provisionWorkspace(sessionId);
    if (result.success && !options?.deferFirstTurn) await admitFirstMessages(sessionId);
    return result;
  },
  admitFirstMessages,
  generateSessionName,
});
