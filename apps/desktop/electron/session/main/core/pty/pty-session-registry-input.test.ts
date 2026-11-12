import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ptyInputChannel } from '@shared/core/pty/ptyEvents';
import type { Pty } from './pty';

const f = vi.hoisted(() => ({
  handlers: new Map<unknown, (payload: unknown) => void>(),
  logError: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
    on: (channel: unknown, handler: (payload: unknown) => void) => {
      f.handlers.set(channel, handler);
      return () => f.handlers.delete(channel);
    },
  },
}));
vi.mock('@main/lib/logger', () => ({
  log: { error: f.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));

const { PtySessionRegistry } = await import('./pty-session-registry');

function fakePty(write: Pty['write']): Pty {
  return { write, resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} };
}

beforeEach(() => {
  f.handlers.clear();
  f.logError.mockClear();
});

// agent 进程刚退出、pty fd 已关时人还在敲键盘:write 抛 EBADF。这一发来自 events.emit,
// 抛出去 = 渲染层一条 rejected invoke + 这次按键丢失。按键通道必须自己收场,每条会话只记一次。
describe('PtySessionRegistry input', () => {
  it('PTY 写失败不把异常抛给 IPC 调用方,每条会话只记一次', () => {
    const registry = new PtySessionRegistry();
    const write = vi.fn(() => {
      throw new Error('Cannot write to closed pty');
    });
    registry.register('p:t:c', fakePty(write), { size: { cols: 80, rows: 24 } });
    const input = f.handlers.get(ptyInputChannel)!;
    expect(() => input('a')).not.toThrow();
    expect(() => input('b')).not.toThrow();
    expect(write.mock.calls).toEqual([['a'], ['b']]);
    expect(f.logError).toHaveBeenCalledTimes(1);
  });

  it('非预期写入错误不吞:照旧抛给调用方,而且每次都记', () => {
    const registry = new PtySessionRegistry();
    const write = vi.fn(() => {
      throw new Error('unexpected write failure: EINVAL');
    });
    registry.register('p:t:c', fakePty(write), { size: { cols: 80, rows: 24 } });
    const input = f.handlers.get(ptyInputChannel)!;
    expect(() => input('a')).toThrow('unexpected write failure');
    expect(() => input('b')).toThrow('unexpected write failure');
    expect(f.logError).toHaveBeenCalledTimes(2);
  });

  it('PTY 正常时按键照旧写进去,不记日志', () => {
    const registry = new PtySessionRegistry();
    const write = vi.fn();
    registry.register('p:t:c', fakePty(write), { size: { cols: 80, rows: 24 } });
    f.handlers.get(ptyInputChannel)!('ls\n');
    expect(write).toHaveBeenCalledWith('ls\n');
    expect(f.logError).not.toHaveBeenCalled();
  });
});
