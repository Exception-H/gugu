import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { DeviceProject, DeviceProjectFolder } from '@gugu/core/shared/types/deviceProject'
import { isAssistantHome } from '@/lib/assistantHome'

export type PhoneProjectEntry = { id: string; label: string; rootPath: string | null; folders: DeviceProjectFolder[] }

/**
 * 手机上的项目列表:项目 = accountProjectsStore(桌面侧栏同一份,❌ 自己按群拼 device_projects);
 * 文件夹路径照各台机器发布的 device_projects(`records`,按这个项目的绑定取)。
 * #1629 parity: projects bound only on the personal assistant's own host are the assistant's home, not the
 * person's projects, so the list leaves them out (host identity is the device row, never the project name).
 */
export function phoneProjectRows(projects: readonly AccountProject[], records: Record<string, DeviceProject[]>, devices: readonly Device[], cloudDeviceId: string | null): PhoneProjectEntry[] {
  const byDevice = new Map(devices.map(device => [device.device_id,device]))
  const assistantHost = (deviceId: string) => { const device = byDevice.get(deviceId); return device ? isAssistantHome(device,cloudDeviceId) : deviceId === cloudDeviceId }
  return projects.flatMap(project => {
    if (project.archived) return []
    if (project.bindings.length > 0 && project.bindings.every(binding => assistantHost(binding.deviceId))) return []
    const folders = project.bindings.filter(binding => !assistantHost(binding.deviceId))
      .flatMap(binding => records[binding.deviceId]?.find(record => record.localProjectId === binding.localProjectId)?.folders ?? [])
    return [{ id: project.chatId,label: project.name,rootPath: folders[0]?.path ?? null,folders }]
  })
}
