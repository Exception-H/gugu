import { useState, useSyncExternalStore } from 'react';
import { platform } from '@/platform';
import { log } from '@renderer/utils/logger';
import type { ProjectFoldersState } from './project-folders';

/**
 * 项目里的新任务在哪台机器上跑(项目与机器解耦):项目是账号上的,机器只是这一次跑在哪里、用哪个文件夹。
 * 一次只选一台;记的是人上次在这个项目里选的那台,记在账号上(agentCreateDefaults.machineByProject,
 * 键 = 项目的跨设备身份:项目群 chatId,还没绑群 = 那一行的本地项目 id;值 = 设备 id),手机与别的桌面共用这一份。
 */
export const scopeKey = (deviceId: string | null) => deviceId ?? 'local';
export const machineOfKey = (key: string): string | null => (key === 'local' ? null : key);

/**
 * 账号上那份「每个项目上次在哪台」,换成这一端的写法(这台电脑 = 'local')。
 * 有选择器挂上就去读(距上次读到超过 REREAD_MS 才再读):开着的桌面也看得到手机 / 别的桌面后来的选择;读失败下次再读。
 * 这一端选了、账号上还没写好的那几个(pending)以这一端为准,❌ 被刚读回来的旧值盖掉。
 */
const REREAD_MS = 15_000;
const memory = {
  byProject: {} as Record<string, string>,
  pending: new Map<string, string>(),
  localDeviceId: null as string | null,
  reading: false,
  readAt: 0,
};
const listeners = new Set<() => void>();
let snapshot: Readonly<Record<string, string>> = {};

function publish(): void {
  snapshot = Object.fromEntries(Object.entries(memory.byProject).map(([project, device]) =>
    [project, device === memory.localDeviceId ? 'local' : device]));
  for (const listener of listeners) listener();
}

/** 这台电脑的设备 id;没读到过就再问一次(开机那一刻可能还没有)。 */
async function localDeviceId(): Promise<string | null> {
  if (!memory.localDeviceId) {
    const self = await Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).catch(() => null);
    memory.localDeviceId = self?.device_id ?? null;
  }
  return memory.localDeviceId;
}

function read(): void {
  if (memory.reading || Date.now() - memory.readAt < REREAD_MS) return;
  memory.reading = true;
  // 按需取账号那一层(它带着云端客户端,不在模块加载时拉进来)。
  const defaults = import('@/lib/agentCreateDefaults').then((cloud) => cloud.readAgentCreateDefaults());
  void Promise.all([defaults, localDeviceId()])
    .then(([defaults]) => {
      memory.byProject = { ...defaults.machineByProject, ...Object.fromEntries(memory.pending) };
      memory.readAt = Date.now();
      publish();
    })
    .catch((error: unknown) => log.warn('[projects] read the machine each project last ran on failed', error))
    .finally(() => { memory.reading = false; });
}

function subscribe(listener: () => void): () => void {
  read();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 选择器读的那一份(useSyncExternalStore 的两端);单独导出给测试。 */
export const runMachineMemory = { subscribe, current: (): Readonly<Record<string, string>> => snapshot };

/**
 * 记下这个项目这次选在哪台(null = 这台电脑):这一端立刻生效,账号上那份随后写上。
 * 只按项目群记(别的设备认得的那个身份);还没有群的项目不记 —— 记成某台机器上的本地 id,别处永远用不上、也没人收。
 */
export function rememberRunMachine(groupId: string | undefined, deviceId: string | null): void {
  if (!groupId) return;
  const projectKey = groupId;
  void (deviceId ? Promise.resolve(deviceId) : localDeviceId()).then((device) => {
    if (!device) {
      log.warn('[projects] this computer has no device id; the machine choice is not remembered', { projectKey });
      return;
    }
    memory.pending.set(projectKey, device);
    memory.byProject = { ...memory.byProject, [projectKey]: device };
    publish();
    return import('@/lib/agentCreateDefaults')
      .then((cloud) => cloud.rememberAgentCreateRunMachine(projectKey, device))
      .catch((error: unknown) => log.warn('[projects] remember the machine a project ran on failed', error))
      .finally(() => { if (memory.pending.get(projectKey) === device) memory.pending.delete(projectKey); });
  });
}

/** 测试用:清掉这一端的记忆与读数时间。 */
export function resetRunMachineMemoryForTest(): void {
  memory.byProject = {};
  memory.pending.clear();
  memory.localDeviceId = null;
  memory.reading = false;
  memory.readAt = 0;
  snapshot = {};
}

/** 有这个项目文件夹的一台机器(`key` 同 scopeKey;顺序 = 侧栏的代表顺序:本机 → 连着的 → 最早建的)。 */
export type RunMachineCandidate = { key: string; online: boolean };

/**
 * 默认在哪台跑(DESIGN「新建任务」):上次选的那台且它在线 → 本机(有文件夹)→ 有文件夹的在线机器里排最前的 →
 * 都不在线时才回到上次选的那台 → 第一台。❌ 换到一台没有文件夹的机器上。没有任何文件夹 = null。
 */
export function defaultRunMachine(candidates: readonly RunMachineCandidate[], saved: string | undefined): string | null {
  const savedOne = saved ? candidates.find((machine) => machine.key === saved) : undefined;
  if (savedOne?.online) return savedOne.key;
  if (candidates.some((machine) => machine.key === 'local')) return 'local';
  const online = candidates.find((machine) => machine.online);
  if (online) return online.key;
  return savedOne?.key ?? candidates[0]?.key ?? null;
}

/**
 * 这个项目此刻选着的机器。`projectKey` 分开这一页上的不同项目;`groupId` = 它的项目群(没有 = 不记、也不读记忆)。`pick` = 人选的(记下来,下次默认还是它);候选里没有它(没有文件夹)也照选 ——
 * 那是人刚在那台机器上挂了文件夹、文件夹清单还没读回来。
 */
export function useProjectRunMachine(projectKey: string, candidates: readonly RunMachineCandidate[], groupId: string | undefined) {
  const saved = useSyncExternalStore(runMachineMemory.subscribe, runMachineMemory.current);
  const [picked, setPicked] = useState<{ projectKey: string; key: string } | null>(null);
  const chosen = picked && picked.projectKey === projectKey ? picked.key : defaultRunMachine(candidates, groupId ? saved[groupId] : undefined);
  const pick = (deviceId: string | null) => {
    setPicked({ projectKey, key: scopeKey(deviceId) });
    rememberRunMachine(groupId, deviceId);
  };
  return { selected: chosen ? [chosen] : [], machine: chosen === null ? undefined : machineOfKey(chosen), pick };
}

/** `deviceOfMember` 只用来认还没答的那几个本地项目在哪台上;读到的文件夹各带自己的 deviceId。 */
export function foldersInScope(
  state: ProjectFoldersState,
  selected: readonly string[],
  deviceOfMember: (projectId: string) => string | null,
  isDeviceResting: (deviceId: string) => boolean = () => false,
): ProjectFoldersState {
  const inScope = (deviceId: string | null) => selected.includes(scopeKey(deviceId));
  const found = state.folders?.filter((folder) => inScope(folder.deviceId)) ?? null;
  // 范围里的机器还有没答的、答了的又一个都没有:还不知道 ⇒ 按读取中(null),❌ 报「所选设备不可用」。
  // A resting cloud device has not answered this read; its empty cached list is
  // not proof that the selected folders are unavailable. Typing wakes it via the
  // existing composer path, and reconnecting reloads the actual folder list.
  const waiting = state.unanswered.some((projectId) => inScope(deviceOfMember(projectId)))
    || selected.some((deviceId) => deviceId !== 'local' && isDeviceResting(deviceId));
  const folders = found?.length === 0 && waiting ? null : found;
  const chosen = folders?.find((folder) => folder.workspaceId === state.chosen?.workspaceId) ?? folders?.[0] ?? null;
  return { ...state, folders, chosen };
}
