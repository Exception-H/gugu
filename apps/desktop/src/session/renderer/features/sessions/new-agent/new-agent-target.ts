/**
 * 新建 Agent 的上次设备/项目选择。只记「上次亲手选过的那一个」，不记任何「猜的」默认值。
 *
 * 失效时**不回落本机、不换目录**：读回来的目标原样交给校验，校验不过就返回 problem，
 * 页面据此清空选择并要求人重选。这样界面不会在用户不知情时把 Agent 建到另一台机器或另一个目录。
 */

export const LOCAL_DEVICE_ID = 'local';
const STORAGE_KEY = 'gugu.new-agent.last-target';

export type NewAgentTarget = {
  /** `local` 或 remote device id。 */
  deviceId: string;
  /** null = 不进项目（走隐式任务工作区）。 */
  projectId: string | null;
};

export type NewAgentTargetProblem = 'device' | 'directory';

export type NewAgentTargetValidation =
  | { ok: true; target: NewAgentTarget }
  | { ok: false; problem: NewAgentTargetProblem; target: NewAgentTarget };

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type TargetValidationDeps = {
  deviceExists: (deviceId: string) => boolean;
  projectExists: (projectId: string) => boolean;
  /** 项目的真实目录；空 = 项目没挂上 / 目录不可用。 */
  projectPath: (projectId: string) => string | null | undefined;
  /** 项目在哪台机器上；null = 本机。 */
  projectMachine: (projectId: string) => string | null;
};

function storageOrNull(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读上次选择；坏数据当作没记过（不是「回落到本机」，页面仍会按默认本机/不选项目开始）。 */
export function readStoredTarget(storage: StorageLike | null = storageOrNull()): NewAgentTarget | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { deviceId, projectId } = parsed as { deviceId?: unknown; projectId?: unknown };
    if (typeof deviceId !== 'string' || !deviceId) return null;
    if (projectId !== null && projectId !== undefined && typeof projectId !== 'string') return null;
    return { deviceId, projectId: projectId ?? null };
  } catch {
    return null;
  }
}

export function writeStoredTarget(target: NewAgentTarget, storage: StorageLike | null = storageOrNull()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    // 记不住不是创建失败：这次仍然按屏幕上选的目标建，下一次回到默认态。
  }
}

/**
 * 只接受「有效且可用」的上次选择：
 * - 设备必须还在名下（本机恒在）；
 * - 项目必须还在、目录读得到，并且确实在那台设备上。
 * 连不上但仍在名下的设备**不算失效**——它是人上次选的那台，页面会用统一提示说它离线，而不是悄悄换掉。
 */
export function validateTarget(target: NewAgentTarget, deps: TargetValidationDeps): NewAgentTargetValidation {
  if (target.deviceId !== LOCAL_DEVICE_ID && !deps.deviceExists(target.deviceId)) {
    return { ok: false, problem: 'device', target };
  }
  if (target.projectId) {
    const expectedMachine = target.deviceId === LOCAL_DEVICE_ID ? null : target.deviceId;
    if (!deps.projectExists(target.projectId) || !deps.projectPath(target.projectId) || deps.projectMachine(target.projectId) !== expectedMachine) {
      return { ok: false, problem: 'directory', target };
    }
  }
  return { ok: true, target };
}
