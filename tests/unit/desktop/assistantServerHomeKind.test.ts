import { expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END, assistantHomeKind, assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { refreshAssistantContext } from '../../../apps/desktop/electron/sessionpage/assistant-instructions'

it('treats a self-hosted Linux server as a computer home; only the cloud computer identity selects the cloud layout', () => {
  expect(assistantHomeKind({ GUGU_SERVER_MODE: '1' })).toBe('computer')
  expect(assistantHomeKind({ GUGU_SERVER_MODE: '1', GUGU_CLOUD_COMPUTER: '1' })).toBe('cloud')
  expect(assistantHomeKind({})).toBe('computer')
})

it('decides every assistant layout in the main process from the home identity, never from the launch mode', () => {
  const main = readFileSync(join(__dirname, '../../../apps/desktop/electron/main.ts'), 'utf8')
  expect(main).not.toMatch(/SERVER_MODE \? 'cloud'/)
  expect(main.match(/assistantHomeKind\(process\.env\)/g)?.length).toBe(4)
})

it('removes the assistant guide an older server build wrote into the personal Claude instructions and keeps the owner text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-server-reclaim-'))
  try {
    const cwd = join(root, 'assistant')
    const personal = join(root, '.claude', 'CLAUDE.md')
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(personal, `# my rules\nuse tabs\n\n${ASSISTANT_GUIDE_BEGIN}\n# 你是谁\n个人助理\n${ASSISTANT_GUIDE_END}\n\ntrailing note\n`)
    await refreshAssistantContext(cwd, root, 'computer', root)
    expect(await readFile(personal, 'utf8')).toBe('# my rules\nuse tabs\n\ntrailing note\n')
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toContain(ASSISTANT_GUIDE_BEGIN)

    await writeFile(personal, `${ASSISTANT_GUIDE_BEGIN}\n# 你是谁\n${ASSISTANT_GUIDE_END}\n`)
    await refreshAssistantContext(cwd, root, 'computer', root)
    await expect(lstat(personal)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('moves a Codex assistant’s notes from the cloud-layout memory folder back into its home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-server-memory-'))
  try {
    const cwd = join(root, 'assistant')
    const paths = assistantHomePaths(root, cwd, 'computer')
    await mkdir(paths.claudeMemoryDir, { recursive: true })
    await writeFile(join(paths.claudeMemoryDir, 'note.md'), 'remember tea')
    await refreshAssistantContext(cwd, root, 'computer', root, 'codex')
    expect(await readFile(join(paths.memoryDir, 'note.md'), 'utf8')).toBe('remember tea')
    await expect(lstat(paths.claudeMemoryDir)).rejects.toMatchObject({ code: 'ENOENT' })

    // A Claude assistant's folder is the link into its home: left untouched.
    await symlink(paths.memoryDir, paths.claudeMemoryDir, 'dir')
    await refreshAssistantContext(cwd, root, 'computer', root, 'claude')
    expect((await lstat(paths.claudeMemoryDir)).isSymbolicLink()).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
