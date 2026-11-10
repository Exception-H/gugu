import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { MessageProvider, PromptEditor, type MentionItem } from '@gugu/session-ui/react/components'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { useLocale } from '@/i18n'
import { addressedUserIds } from '@/lib/mention'
import { useAuth } from '../../store/auth'
import { useTheme } from '../../store/theme'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import type { ForwardNote } from './forwardToChats'
import type { MentionTarget } from './useChatDraft'
import { useChatMentionRoster, useGroupMentionProvider } from './useGroupMentionProvider'

/**
 * A forward's note: the group composer's editor and @, over the members of the chat being forwarded into. @ needs one
 * chat: with several picked, a name means a different member in each, so the note offers no one, and an @ already written
 * is flagged as notifying no one.
 */
export function ForwardNoteEditor({ chat, several, onChange }: {
  /** The one chat picked; null with none or several. */
  chat: ChatItem | null
  several: boolean
  onChange: (note: ForwardNote) => void
}) {
  const { t } = useTranslation('messaging')
  const { theme } = useTheme()
  const { resolvedLocale } = useLocale()
  const { user } = useAuth()
  const [text, setText] = useState('')
  const [picks, setPicks] = useState<MentionTarget[]>([])
  const roster = useChatMentionRoster(several ? null : chat)
  const { members, mentionProvider, renderMentionIcon, pickOf } = useGroupMentionProvider({ chatId: roster.room ? chat?.id : null,
    isGroupChat: roster.room, groupMembers: roster.groupMembers, currentUserId: user?.id ?? null, agentStatuses: roster.agentStatuses })
  useEffect(() => { onChange({ text, toUserIds: roster.room ? addressedUserIds(text, picks, members) : [] }) }, [text, picks, members, roster.room, onChange])
  const onMentionInsert = useCallback((item: MentionItem) => {
    const pick = pickOf(item)
    if (pick) setPicks((current) => current.some((existing) => existing.userId === pick.userId) ? current : [...current, pick])
  }, [pickOf])
  return (
    <SessionUiTheme theme={theme} skin>
      <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
        <div className="mt-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-[10px] py-[7px] text-[length:var(--font-body)]" data-forward-note="">
          <PromptEditor inputTestId="forward-note" enterBehavior="newline" placeholder={t('forward.note')}
            onChange={setText} onMentionInsert={onMentionInsert} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} />
        </div>
        {several && picks.length > 0 && text.includes('@') && (
          <div className="mt-1 text-[length:var(--font-caption)] text-[var(--text-tertiary)]" data-testid="forward-note-mention-dropped">{t('forward.mentionNeedsOneChat')}</div>
        )}
      </MessageProvider>
    </SessionUiTheme>
  )
}
