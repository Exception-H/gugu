import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import type { RunMachineCandidate } from '@renderer/features/projects/components/main-panel/project-device-scope'
import { phoneProjectRows } from '../assistant/phoneProjectRows'
import { taskFoldersOfChat } from '../chat/phoneTaskFolders'

/**
 * 手机「+」新建页的「项目 · 机器」两行(DESIGN 点击路径 4a):项目是账号上的,机器只是这一次跑在哪。
 *
 * `key` = 项目的跨设备身份(项目群 chatId;还没绑群的本地项目 = 它自己那一行的 id),「上次在这个项目里用的机器」按它记。
 * `homes` = 有这个项目文件夹的机器 → 那台上的本地项目 id(建会话时带给那台机器)。
 */
export type CreateProject = { key: string; name: string; homes: ReadonlyMap<string, string>; groupId: string | undefined }

/** 账号下的项目:与「伙伴」项目列表同一种按项目群的归并(phoneProjectRows),数据是各台机器发布的 device_projects。 */
export function accountProjects(devices: readonly Device[], cloudDeviceId: string | null): CreateProject[] {
  const records = Object.fromEntries(devices.map((device) => [device.device_id, device.projects ?? []]))
  return phoneProjectRows(records, devices, cloudDeviceId).map((row) => {
    // 绑了群:各台机器上的文件夹与项群卡同一份(taskFoldersOfChat);没绑:只在它自己那台上。
    const folders = row.chatId ? taskFoldersOfChat(devices, row.chatId)?.folders ?? [] : row.folders.length > 0 ? [{ deviceId: row.deviceId, projectId: row.localProjectId }] : []
    return {
      key: row.chatId ?? row.id,
      groupId: row.chatId ?? undefined,
      name: row.label,
      homes: new Map(folders.flatMap((folder) => (folder.deviceId ? [[folder.deviceId, folder.projectId] as const] : []))),
    }
  })
}

/**
 * 机器列表里的一行。`localProjectId` = 选了项目时那台上的本地项目;没有这个项目的文件夹 = null(手机上还不能就地绑文件夹,点不动)。
 * `path` = 那台上这个项目的文件夹(行上写出来)。
 */
export type CreateMachine = { device: Device; localProjectId: string | null; path: string | null; available: boolean }

/**
 * 选了项目:有这个项目文件夹的机器在上(在线的在前),其余电脑在下、点不动。手机自己不是项目的运行机器(它没有文件夹)。
 * 不选项目:全部机器,电脑在前;手机任务宿主排在最后(它只跑自己的任务工作区)。
 */
export function createMachines(project: CreateProject | null, machines: readonly Device[]): CreateMachine[] {
  const computers = machines.filter((device) => !isPhoneDevice(device))
  if (!project) {
    return [...computers, ...machines.filter(isPhoneDevice)].map((device) => ({ device, localProjectId: null, path: null, available: true }))
  }
  const rows = computers.map((device) => {
    const localProjectId = project.homes.get(device.device_id) ?? null
    const path = device.projects?.find((record) => record.localProjectId === localProjectId)?.folders[0]?.path ?? null
    return { device, localProjectId, path }
  })
  const rank = (row: (typeof rows)[number]) => (row.localProjectId === null ? 2 : row.device.is_online ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b)).map((row) => ({ ...row, available: row.localProjectId !== null }))
}

/** 「上次用的机器」不选项目时记在这个键下(项目的键是项目群 chatId / 本地项目行 id,不会撞上)。 */
export const NO_PROJECT_KEY = '\u0000no-project'

/**
 * 默认在哪台跑的候选:与桌面同一条规则(useProjectRunMachine → defaultRunMachine),候选 = 能选的那几台,次序同列表。
 * 手机上没有「本机」那一步(手机不是项目的运行机器);不选项目时即 上次那台(在线)→ 第一台在线的 → 上次那台 → 第一台。
 */
export function runCandidates(rows: readonly CreateMachine[]): RunMachineCandidate[] {
  return rows.filter((row) => row.available).map((row) => ({ key: row.device.device_id, online: row.device.is_online }))
}
