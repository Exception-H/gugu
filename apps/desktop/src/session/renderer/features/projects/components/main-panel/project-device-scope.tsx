import { useState } from 'react';
import type { ProjectFoldersState } from './project-folders';

/**
 * 项目里的新任务在哪台机器上跑(项目与机器解耦):项目是账号上的,机器只是这一次跑在哪里、用哪个文件夹。
 * 一次只选一台;记的是人上次在这个项目里选的那台(键 = 项目的跨设备身份:项目群 chatId,还没绑群 = 那一行的本地项目 id)。
 */
const STORAGE_KEY = 'gugu.projectRunMachine.v1';
export const scopeKey = (deviceId: string | null) => deviceId ?? 'local';
export const machineOfKey = (key: string): string | null => (key === 'local' ? null : key);

type SavedMachines = Record<string, string>;

function readSaved(): SavedMachines {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'string'));
  } catch { return {}; }
}

function persist(next: SavedMachines): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* This choice still applies in this window. */ }
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

/** 记下人在别处(新建页先选了机器再选项目)选的那台:进了项目块,它有这个项目的文件夹就默认用它。 */
export function rememberRunMachine(projectKey: string, deviceId: string | null): void {
  persist({ ...readSaved(), [projectKey]: scopeKey(deviceId) });
}

/**
 * 这个项目此刻选着的机器。`pick` = 人选的(记下来,下次默认还是它);候选里没有它(没有文件夹)也照选 ——
 * 那是人刚在那台机器上挂了文件夹、文件夹清单还没读回来。
 */
export function useProjectRunMachine(projectKey: string, candidates: readonly RunMachineCandidate[]) {
  const [saved, setSaved] = useState(readSaved);
  const [picked, setPicked] = useState<{ projectKey: string; key: string } | null>(null);
  const chosen = picked && picked.projectKey === projectKey ? picked.key : defaultRunMachine(candidates, saved[projectKey]);
  const pick = (deviceId: string | null) => {
    const key = scopeKey(deviceId);
    setPicked({ projectKey, key });
    setSaved((current) => {
      const next = { ...current, [projectKey]: key };
      persist(next);
      return next;
    });
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
