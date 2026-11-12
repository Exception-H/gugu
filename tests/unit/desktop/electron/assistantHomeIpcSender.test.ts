import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_HOME_CHANNELS } from '../../../../apps/desktop/src/lib/assistantHomeIpc'

const f = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  prepare: vi.fn(),
  wipe: vi.fn(),
  mainWindow: { webContents: { id: 1 } } as { webContents: { id: number } } | null,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => f.handlers.set(channel, handler) },
}))
vi.mock('../../../../apps/desktop/electron/assistant-home-prepare', () => ({
  prepareLocalAssistantHome: f.prepare,
  wipeLocalAssistantHome: f.wipe,
}))
vi.mock('../../../../apps/desktop/electron/assistant-runtime-prepare', () => ({
  prepareAssistantRuntime: vi.fn(),
  discardAssistantPreparation: vi.fn(),
}))
vi.mock('../../../../apps/desktop/electron/ipc-bridge', () => ({ getMainWindow: () => f.mainWindow }))

const { installAssistantHome } = await import('../../../../apps/desktop/electron/assistant-home')

// prepare / wipe 会建、也会 rm -rf 本机助理的家;preload 是通用桥,渲染层能拿到 channel 就能调到。
// 所以这两个处理器只认主窗口(会话页与咕咕同文档同窗口,不是另一扇窗)。
beforeEach(() => {
  f.prepare.mockClear()
  f.wipe.mockClear()
})

describe('assistant-home prepare / wipe 的来源校验', () => {
  function install() {
    f.handlers.clear()
    installAssistantHome()
    const main = { id: 'main' }
    f.mainWindow = { webContents: main as unknown as { id: number } }
    return { main, other: { id: 'other' } }
  }

  it('主窗口能 prepare 与 wipe', async () => {
    const { main } = install()
    f.prepare.mockResolvedValueOnce({ workdir: '/x' })
    f.wipe.mockResolvedValueOnce({ removed: true })
    await expect(f.handlers.get(ASSISTANT_HOME_CHANNELS.prepare)!({ sender: main }, {})).resolves.toEqual({ workdir: '/x' })
    await f.handlers.get(ASSISTANT_HOME_CHANNELS.wipe)!({ sender: main })
    expect(f.wipe).toHaveBeenCalledTimes(1)
  })

  it('别的窗口一律拒绝,且不会碰文件系统', async () => {
    const { other } = install()
    // 处理器本身是同步的:Electron 会把同步 throw 变成渲染层那条 invoke 的 rejection。
    expect(() => f.handlers.get(ASSISTANT_HOME_CHANNELS.prepare)!({ sender: other }, {})).toThrow('main window')
    expect(() => f.handlers.get(ASSISTANT_HOME_CHANNELS.wipe)!({ sender: other })).toThrow('main window')
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.wipe).not.toHaveBeenCalled()
  })

  it('主窗口还没建立时同样拒绝', async () => {
    const { main } = install()
    f.mainWindow = null
    expect(() => f.handlers.get(ASSISTANT_HOME_CHANNELS.wipe)!({ sender: main })).toThrow('main window')
  })
})
