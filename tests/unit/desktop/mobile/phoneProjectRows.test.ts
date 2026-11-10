import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { phoneProjectRows } from '../../../../apps/desktop/src/mobile/assistant/phoneProjectRows'

// The phone project list is the account project list (accountProjectsStore); folder paths come from device_projects.
// #1629 parity: a project bound only on the personal assistant's host is not one of the person's projects.

const device = (id: string, extra: Partial<Device> = {}): Device => ({
  device_id: id,
  label: id,
  is_online: true,
  is_current_device: false,
  cloud_computer: null,
  capabilities: {},
  ...extra,
} as unknown as Device)

const record = (localProjectId: string): DeviceProject => ({
  localProjectId,
  name: localProjectId,
  rootPath: `/home/${localProjectId}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  chatId: null,
  folders: [{ workspaceId: `${localProjectId}-root`, kind: 'root', path: `/home/${localProjectId}`, attachedAt: null }],
})

const project = (chatId: string, name: string, bindings: Array<[string, string]>, archived = false): AccountProject => ({
  chatId, name, archived, bindings: bindings.map(([deviceId, localProjectId]) => ({ deviceId, localProjectId })),
})

describe('phone projects list = account projects', () => {
  it('one entry per account project, folders of every machine it is bound on, named by the project', () => {
    const records = { laptop: [record('l-paper')], desk: [record('d-paper')] }
    const rows = phoneProjectRows([
      project('chat-paper', 'Paper', [['laptop', 'l-paper'], ['desk', 'd-paper']]),
      project('chat-empty', 'Empty', []),
      project('chat-old', 'Old', [], true),
    ], records, [device('laptop'), device('desk')], null)
    expect(rows.map(row => [row.id, row.label, row.folders.map(folder => folder.path)])).toEqual([
      ['chat-paper', 'Paper', ['/home/l-paper', '/home/d-paper']],
      ['chat-empty', 'Empty', []],
    ])
    expect(rows[0]!.rootPath).toBe('/home/l-paper')
  })

  it('drops a project bound only on the assistant host (by device row or by the cloud host id), keeps the same name elsewhere', () => {
    const devices = [device('cloud-host', { capabilities: { assistant_home: true } as Device['capabilities'] }), device('laptop')]
    const records = { 'cloud-host': [record('home')], laptop: [record('l1')] }
    const list = [project('chat-home', '助理', [['cloud-host', 'home']]), project('chat-l1', '助理', [['laptop', 'l1']]), project('chat-x', 'x', [['cloud-x', 'x1']])]
    expect(phoneProjectRows(list, records, devices, null).map(row => row.id)).toEqual(['chat-l1', 'chat-x'])
    expect(phoneProjectRows(list, records, devices, 'cloud-x').map(row => row.id)).toEqual(['chat-l1'])
  })

  it('does not mutate the published account records', () => {
    const records = { laptop: [record('l1')] }
    const before = JSON.stringify(records)
    phoneProjectRows([project('chat-l1', 'Paper', [['laptop', 'l1']])], records, [device('laptop')], null)
    expect(JSON.stringify(records)).toBe(before)
  })
})
