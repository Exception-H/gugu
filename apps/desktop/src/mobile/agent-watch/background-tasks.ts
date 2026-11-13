import { useEffect, useMemo, useState } from 'react'
import {
  collectBackgroundCommandRoster,
  collectSubagentRoster,
  type BackgroundCommandEntry,
  type SubagentRosterEntry,
} from '@gugu/session-chat-ui/background-rosters'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { isSubagentDismissed } from '@renderer/features/sessions/view/subagent-dismissals'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { rendererLogger } from '@/lib/log'
import { fetchBackgroundTasks } from './sessionpage-rpc'

const log = rendererLogger('mobile/agent-watch/background-tasks')

/** 名单还在时多久再问一次那台机器「哪些命令还活着」:命令跑完、进程没了都不会往时间线里写一行。 */
export const BACKGROUND_TASKS_POLL_MS = 5000
/** 那台机器已经回「一条都没在跑」之后退到这个间隔:转录里剩下的候选都是早就跑完的旧命令。 */
const BACKGROUND_TASKS_IDLE_POLL_MS = BACKGROUND_TASKS_POLL_MS * 6

export type PhoneBackgroundTasks = {
  commands: BackgroundCommandEntry[]
  subagents: SubagentRosterEntry[]
  /** 那台电脑接得住停止(新版主机);老版本 = false,单子上不画停止键。 */
  canStop: boolean
}

/**
 * 手机看会话末尾那一句的两份名单(#638 搬到手机):与桌面消息列表末尾那一行同一对 `collect*Roster`,
 * 读的是手机手里这份时间线。时间线里最后一轮还开着时,它就是那一轮(桌面的 activeTurn)。
 * 命令名单再过一道运行时的筛子(#6582):旧轮里的命令可能随上一个进程没了,终态永远不会来。
 */
export function backgroundTaskRosters(
  sessionId: string,
  turns: readonly TranscriptTurn[],
  runningCommandTaskIds: readonly string[] | null,
): { commands: BackgroundCommandEntry[]; subagents: SubagentRosterEntry[] } {
  const last = turns.at(-1)
  const active = last && !last.outcome ? last : null
  const committed = active ? turns.slice(0, -1) : turns
  const shown = <T extends { id: string }>(rows: T[]) => rows.filter((row) => !isSubagentDismissed(sessionId, row.id))
  return {
    commands: shown(collectBackgroundCommandRoster(committed, active, translateSessionMessage('transcript.backgroundCommand'), runningCommandTaskIds)),
    subagents: shown(collectSubagentRoster(committed, active, translateSessionMessage('transcript.subagent'))),
  }
}

/**
 * `dismissals`:人按过 × 就加一,让名单重算(收起表是 mobx 的,React 这边不订它)。
 * `fetchRunning`:问那台机器哪些还活着;默认走 sessionpage RPC(另一台机器),本机会话传本机的那一问。
 */
export function usePhoneBackgroundTasks(
  deviceId: string,
  sessionId: string,
  turns: readonly TranscriptTurn[],
  dismissals: number,
  enabled: boolean,
  fetchRunning?: (deviceId: string, sessionId: string) => Promise<{ runningCommandTaskIds: string[] | null }>,
): PhoneBackgroundTasks {
  const [running, setRunning] = useState<{ key: string; ids: string[] | null; canStop: boolean } | null>(null)
  const key = `${deviceId}:${sessionId}`
  const known = running?.key === key ? running : null
  // 先不筛地算一遍:有没有东西可能在跑,决定要不要去问那台机器。
  const candidates = useMemo(() => (enabled ? backgroundTaskRosters(sessionId, turns, null) : { commands: [], subagents: [] }), [enabled, sessionId, turns, dismissals]) // eslint-disable-line react-hooks/exhaustive-deps -- dismissals re-reads the mobx dismissal set
  const asking = candidates.commands.length + candidates.subagents.length > 0
  useEffect(() => {
    if (!asking) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let interval = BACKGROUND_TASKS_POLL_MS
    const fetchRunningIds = fetchRunning ?? fetchBackgroundTasks
    // 用 setTimeout 串下一次,不用 setInterval:请求慢的时候不会叠起来。
    function schedule() {
      if (!live || timer || document.visibilityState !== 'visible') return
      timer = setTimeout(() => { timer = null; ask() }, interval)
    }
    function ask() {
      fetchRunningIds(deviceId, sessionId).then(
        (value) => {
          if (!live) return
          setRunning({ key, ids: value.runningCommandTaskIds, canStop: true })
          // 电脑明确回报「没有任务在跑」就退到慢速档 —— 否则只要转录里还留着旧命令,
          // 这台手机就每 5 秒问一次,问到用户关掉这一页为止。
          interval = value.runningCommandTaskIds !== null && value.runningCommandTaskIds.length === 0
            ? BACKGROUND_TASKS_IDLE_POLL_MS
            : BACKGROUND_TASKS_POLL_MS
          schedule()
        },
        (error: unknown) => {
          log.info({ error: String(error), deviceId }, 'that computer cannot report its running background tasks')
          if (!live) return
          setRunning({ key, ids: null, canStop: false })
          schedule()
        },
      )
    }
    // 页面看不见就别问:手机切走了还在后台轮询纯属白花电。
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') {
        if (timer) { clearTimeout(timer); timer = null }
        return
      }
      ask()
    }
    ask()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      live = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [asking, deviceId, sessionId, key, fetchRunning])
  return useMemo(() => {
    if (!asking) return { commands: [], subagents: [], canStop: false }
    const ids = known?.ids ?? null
    const commands = ids === null ? candidates.commands : candidates.commands.filter((entry) => ids.includes(entry.taskId))
    return { commands, subagents: candidates.subagents, canStop: known?.canStop ?? false }
  }, [asking, candidates, known])
}

/** 「后台 · 2 条命令 · 1 个子智能体」:与桌面那一行同一组文案键。 */
export function backgroundTasksLabel(commandCount: number, agentCount: number): string {
  const parts: string[] = []
  if (commandCount > 0) parts.push(translateSessionMessage(commandCount === 1 ? 'transcript.backgroundTasks.commandsOne' : 'transcript.backgroundTasks.commands', { count: commandCount }))
  if (agentCount > 0) parts.push(translateSessionMessage(agentCount === 1 ? 'transcript.backgroundTasks.subagentsOne' : 'transcript.backgroundTasks.subagents', { count: agentCount }))
  return translateSessionMessage('transcript.backgroundTasks.label', { parts: parts.join(' · ') })
}
