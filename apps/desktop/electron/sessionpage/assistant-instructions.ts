import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AssistantFileError } from '@gugu/core/shared/assistantFileError'
import {
  ASSISTANT_COMPUTER_WORKDIR_NAME, ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END, assistantBrief, assistantGuide,
  assistantHomePaths, upsertAssistantGuide, withDeniedTools, type AssistantHomeKind,
} from '@gugu/core/shared/assistantPolicy'
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import type { AssistantEngine } from '../../src/lib/assistantHomeIpc'
import { assistantRules } from '../assistant-rules-resolver'
import { preserveDamagedAssistantSettings, readAssistantFile, writeAssistantFile } from './assistant-files'

const refreshes = new Map<string, Promise<void>>()

/**
 * Role was checked by the caller. Only managed instructions change; memory and custom text stay. `rules`: the snapshot the
 * caller renders the rest of this start with; none — the one in use now (assistant-rules-resolver.ts), taken once. With no
 * rules here at all, nothing is written: the managed block and its reference stay exactly as they are (never an empty or
 * made-up one), until a refresh with the product's rules.
 */
export async function refreshAssistantContext(cwd: string, guguHome: string, kind: AssistantHomeKind, home = homedir(), engine: AssistantEngine = 'claude', rules?: AssistantProductRules): Promise<void> {
  if (kind === 'computer' && resolve(cwd) !== resolve(guguHome, ASSISTANT_COMPUTER_WORKDIR_NAME)) return
  const using = rules ?? (await assistantRules().current()).rules
  if (!using) return
  const key = assistantHomePaths(home, cwd, kind).instructions
  const previous = refreshes.get(key)
  const gate = Promise.withResolvers<void>()
  refreshes.set(key, gate.promise)
  if (previous) await previous
  try { await writeAssistantContext(cwd, kind, home, engine, using) }
  finally {
    gate.resolve()
    if (refreshes.get(key) === gate.promise) refreshes.delete(key)
  }
}

async function writeAssistantContext(cwd: string, kind: AssistantHomeKind, home: string, engine: AssistantEngine, rules: AssistantProductRules) {
  const referenceName = '.gugu-assistant-reference.md'
  const reference = join(cwd, referenceName)
  const full = assistantGuide(kind, rules)
  const paths = assistantHomePaths(home, cwd, kind)
  const brief = assistantBrief(kind, reference, paths.memoryDir, rules)
  const instructions = paths.instructions
  const current = await readAssistantFile(instructions) ?? ''
  if (kind === 'computer') await reclaimCloudLayout(home, paths.claudeMemoryDir, paths.memoryDir, engine)
  const settings = kind === 'computer' && engine === 'claude' ? [[paths.settings, await localAssistantSettings(paths.settings, cwd, rules.defaults.deniedTools)]] : []
  // Install the complete reference first, so the brief never points to an absent file.
  for (const [path, content] of [[reference, full], [instructions, upsertAssistantGuide(current, brief)], ...settings]) {
    const old = path === instructions ? current : await readAssistantFile(path)
    if (old === content) continue
    await writeAssistantFile(path, content)
  }
}

/** Project-only settings still load ancestor CLAUDE.md files (CLI 2.1.306).
 * Exclude that coding context while retaining this assistant's own instructions. */
async function localAssistantSettings(path: string, cwd: string, deniedTools: readonly string[]): Promise<string> {
  let raw = await readAssistantFile(path)
  // Damaged settings are replaced only if they are still the bytes we read; otherwise judge the newer content.
  for (let attempt = 0; attempt < 3 && raw !== null && /^[\0\s]*$/u.test(raw); attempt++) {
    if (await preserveDamagedAssistantSettings(path, raw)) { raw = null; break }
    raw = await readAssistantFile(path)
  }
  let settings: Record<string, unknown>
  let existing: string[]
  try {
    settings = JSON.parse(withDeniedTools(raw, deniedTools)) as Record<string, unknown>
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Assistant settings must be an object')
    const excluded = settings.claudeMdExcludes ?? []
    if (!Array.isArray(excluded) || excluded.some(value => typeof value !== 'string')) throw new Error('Assistant instruction exclusions must be strings')
    existing = excluded
  } catch (cause) { throw new AssistantFileError(path, 'invalid', cause) }
  const excluded: string[] = []
  for (let parent = dirname(resolve(cwd)); ; parent = dirname(parent)) {
    const literal = parent.replaceAll('\\', '/').replace(/[?*[\]{}()!+@]/g, '\\$&')
    const prefix = literal.endsWith('/') ? literal : `${literal}/`
    excluded.push(...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md', '.claude/rules/**'].map(name => `${prefix}${name}`))
    if (dirname(parent) === parent) break
  }
  return `${JSON.stringify({ ...settings, claudeMdExcludes: [...new Set([...existing, ...excluded])] }, null, 2)}\n`
}

/**
 * @@@server-home-reclaim 旧版本在人自己的 Linux server 上按云电脑布局跑助理(判据是启动方式,不是 GUGU_CLOUD_COMPUTER):
 * 说明段写进了 `~/.claude/CLAUDE.md`(这个 Linux 用户自己开的每个 Claude Code 会话都读),Codex 助理的笔记记在
 * `~/.claude/projects/<目录名>/memory` 的真目录里。住本机时把两样收回:只删我们那一段(人写的照留,删空了就删文件),
 * 笔记搬回它家里(Claude 助理那一夹本来就是链到家里的链接,不用搬)。
 */
async function reclaimCloudLayout(home: string, claudeMemoryDir: string, memoryDir: string, engine: AssistantEngine): Promise<void> {
  const personal = join(home, '.claude', 'CLAUDE.md')
  const current = await readAssistantFile(personal)
  const start = current?.indexOf(ASSISTANT_GUIDE_BEGIN) ?? -1
  const end = start < 0 ? -1 : current!.indexOf(ASSISTANT_GUIDE_END, start)
  if (current !== null && start >= 0 && end >= 0) {
    const rest = `${current.slice(0, start).replace(/\n+$/, '')}\n\n${current.slice(end + ASSISTANT_GUIDE_END.length).replace(/^\n+/, '')}`.trim()
    if (rest) await writeAssistantFile(personal, `${rest}\n`)
    else await rm(personal)
  }
  if (engine === 'codex' && (await lstat(claudeMemoryDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  }))?.isDirectory()) await adoptMemoryEntries(claudeMemoryDir, memoryDir)
}

/** 把一夹记忆搬进它家里(家里已有同名的保留家里那份),搬完删掉原夹。 */
export async function adoptMemoryEntries(from: string, memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
  for (const name of await readdir(from)) {
    const target = join(memoryDir, name)
    if (await lstat(target).then(() => true, () => false)) continue
    await rename(join(from, name), target)
  }
  await rm(from, { recursive: true })
}
