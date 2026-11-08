import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findWindowsCommandPaths } from './windows-launcher';

/** A disk that holds exactly `files` (compared case-insensitively, as on NTFS). */
function disk(files: string[]) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (candidate: string) => set.has(candidate.toLowerCase());
}

describe('findWindowsCommandPaths: PATH × PATHEXT in-process, no `where`', () => {
  const home = 'C:\\Users\\张 三\\gugu home\\agents\\mise-bin';

  it('finds a launcher under a path with spaces and Chinese characters, byte for byte', () => {
    const env = { Path: `C:\\Windows\\System32;${home}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findWindowsCommandPaths('codex', { env, cwd: 'C:\\work', isFile: disk([`${home}\\codex.cmd`]) }))
      .toEqual([`${home}\\codex.cmd`]);
  });

  it('keeps `where` order: cwd first, then PATH, PATHEXT order within a directory; skips extensionless shims', () => {
    const env = { PATH: 'C:\\a;"C:\\b c";;C:\\a', PATHEXT: '.EXE;.CMD' };
    const isFile = disk(['C:\\work\\node.cmd', 'C:\\a\\node', 'C:\\a\\node.cmd', 'C:\\a\\node.exe', 'C:\\b c\\node.exe']);
    expect(findWindowsCommandPaths('node', { env, cwd: 'C:\\work', isFile })).toEqual([
      'C:\\work\\node.cmd',
      'C:\\a\\node.exe',
      'C:\\a\\node.cmd',
      'C:\\b c\\node.exe',
    ]);
  });

  it('looks only in the given directory for a path, and takes an exact extension first', () => {
    const env = { PATH: 'C:\\elsewhere', PATHEXT: '.EXE;.CMD' };
    const isFile = disk([`${home}\\codex.cmd`, 'C:\\elsewhere\\codex.cmd']);
    expect(findWindowsCommandPaths(`${home}\\codex.cmd`, { env, isFile })).toEqual([`${home}\\codex.cmd`]);
    expect(findWindowsCommandPaths('C:/Users/张 三/missing/codex.cmd', { env, isFile })).toEqual([]);
  });

  it('expands %VAR% from env (case-insensitive), and finds nothing when one does not expand', () => {
    const env = { LocalAppData: 'C:\\Users\\张 三\\AppData\\Local', PATHEXT: '.EXE' };
    const zcode = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
    expect(findWindowsCommandPaths('%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs', { env, isFile: disk([zcode]) }))
      .toEqual([zcode]);
    expect(findWindowsCommandPaths('%NOPE%\\zcode.cjs', { env, isFile: () => true })).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('finds a real file under a Chinese directory with a space', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-where-'));
    try {
      const dir = join(root, '测试 目录');
      mkdirSync(dir);
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\n');
      expect(findWindowsCommandPaths('codex', { env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, cwd: root }))
        .toEqual([join(dir, 'codex.cmd')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
