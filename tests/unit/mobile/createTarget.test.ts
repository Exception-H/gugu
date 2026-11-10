import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { accountProjects, createMachines, runCandidates } from '@/mobile/agent-watch/create-target'
import { defaultRunMachine } from '@renderer/features/projects/components/main-panel/project-device-scope'

const record = (localProjectId: string, chatId: string | null, path = `/${localProjectId}`): DeviceProject => ({
  localProjectId, name: 'work', rootPath: path, createdAt: '2026-11-01T00:00:00.000Z', chatId,
  folders: [{ workspaceId: `ws-${localProjectId}`, kind: 'root', path, attachedAt: null }],
})
const machine = (id: string, online: boolean, projects: DeviceProject[] = [], phone = false): Device => ({
  device_id: id, label: id, hostname: id, platform: phone ? 'android' : 'linux', status: online ? 'online' : 'offline',
  is_online: online, last_seen_at: '2026-11-09T00:00:00.000Z', projects,
  capabilities: phone ? { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } : { terminals: [], runtimes: ['codex'] },
})
const defaultOf = (project: ReturnType<typeof accountProjects>[number] | null, machines: Device[], saved?: string) =>
  defaultRunMachine(runCandidates(createMachines(project, machines), project), saved)

describe('手机新建页的「项目 · 机器」(DESIGN 点击路径 4a)', () => {
  const gpu = machine('gpu', true, [record('gpu-work', 'chat-work', '/root/work')])
  const juma = machine('juma', true, [record('juma-work', 'chat-work', '~/work')])
  const wen = machine('wen', false, [record('wen-work', 'chat-work', '~/work')])
  const mac = machine('mac', true)
  const phone = machine('phone', true, [], true)
  const machines = [mac, wen, juma, gpu, phone]
  const [work] = accountProjects(machines, null)

  it('一个项目在几台机器上有文件夹 = 账号上一个项目,带着各台上的本地项目', () => {
    expect(accountProjects(machines, null)).toHaveLength(1)
    expect(work).toMatchObject({ key: 'chat-work', name: 'work' })
    expect([...work!.homes]).toEqual(expect.arrayContaining([['gpu', 'gpu-work'], ['juma', 'juma-work'], ['wen', 'wen-work']]))
  })

  // #2412 review ④: an offline machine is listed but not selectable, the same rule as the desktop picker (machineAcceptsWork).
  it('选了项目:有文件夹的在线机器在前、离线的在后(点不动),没有文件夹的电脑在下且点不动;手机不列', () => {
    const rows = createMachines(work!, machines)
    expect(rows.map((row) => [row.device.device_id, row.available, row.localProjectId, row.path])).toEqual([
      ['juma', true, 'juma-work', '~/work'],
      ['gpu', true, 'gpu-work', '/root/work'],
      ['wen', false, 'wen-work', '~/work'],
      ['mac', false, null, null],
    ])
  })

  it('默认机器:上次那台在线就用它 → 有文件夹的第一台在线的 → 都不在线才回上次那台;❌ 没有文件夹的那台', () => {
    expect(defaultOf(work!, machines, 'gpu')).toBe('gpu')
    expect(defaultOf(work!, machines, 'wen'), 'last used is offline').toBe('juma')
    expect(defaultOf(work!, machines, 'mac'), 'last used has no folder').toBe('juma')
    // Every folder machine is offline: the offline one stays chosen (send blocked, draft kept), never a machine without a folder.
    expect(defaultOf(work!, [mac, wen], 'wen')).toBe('wen')
    expect(defaultOf(work!, [mac, wen])).toBe('wen')
    expect(defaultOf(work!, [mac]), 'no machine has a folder').toBeNull()
  })

  it('不选项目:全部机器,电脑在前、手机任务宿主在最后;离线的点不动;默认 = 第一台能用的', () => {
    const rows = createMachines(null, [phone, ...machines.filter((one) => one !== phone)])
    expect(rows.map((row) => [row.device.device_id, row.available])).toEqual([['mac', true], ['wen', false], ['juma', true], ['gpu', true], ['phone', true]])
    expect(rows.every((row) => row.localProjectId === null)).toBe(true)
    expect(defaultOf(null, machines)).toBe('mac')
    expect(defaultOf(null, machines, 'wen'), 'offline is never the default').toBe('mac')
  })

  it('还没绑项目群的本地项目只在它自己那台上', () => {
    const solo = machine('solo', true, [record('solo-p', null)])
    const [project] = accountProjects([solo, gpu], null).filter((one) => one.key !== 'chat-work')
    expect([...project!.homes]).toEqual([['solo', 'solo-p']])
    expect(createMachines(project!, [solo, gpu]).map((row) => [row.device.device_id, row.available])).toEqual([['solo', true], ['gpu', false]])
  })
})
