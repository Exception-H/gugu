import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { platform } from '@/platform'
import { Link, QrCode } from '@/lib/icons'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { buildGroupInviteShareUrl } from '../../lib/groupInviteShareUrl'
import { displayAvatarUrl } from '../../lib/dicebearAvatar'
import { isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { useChatStore } from '../../store/chatContext'
import { useAgentLookPostersVersion } from '../agentAvatar/posters'
import { SharePosterDialog } from '../SharePosterDialog'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { buildUnifiedMembers } from './groupMemberModels'

/**
 * @@@group-share 分享本群只有这一处:画在「邀请」那张选人单里(群头部的邀请、成员页的邀请、拖任务进群都开它),
 * 选联系人和发链接 / 二维码在同一张单上。开关在「群管理」;关着时链接对加入无效,所以不画。项目群不拉人(gugu-dev#181)。
 */
export function GroupInviteShare({ chatId, settings, snapshot }: {
  chatId: string
  settings: GroupChatSettings | null
  snapshot: GroupCollabSnapshot
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { identitiesById } = useChatStore('identitiesById')
  const [showPoster, setShowPoster] = useState(false)
  const inviteLink = useMemo(
    () => buildGroupInviteShareUrl(settings?.public_id ?? null, settings?.join_token ?? null),
    [settings?.public_id, settings?.join_token],
  )
  // @@@445/#2470 海报 canvas 不走 React Avatar → 按同一口径预解析成员头像;小鸟的定格画好了会重渲染,这里跟着重读。
  useAgentLookPostersVersion()
  if (!settings?.invite_link_enabled || !inviteLink || isProjectGroupChat(chatId)) return null

  const members = buildUnifiedMembers(snapshot)
  const totalMembers = snapshot.humans.length + snapshot.agents.length
  const posterMemberUrls = members.slice(0, 9).map((m) => {
    const identity = identitiesById[m.id]
    return identity ? displayAvatarUrl(identity.avatar ?? null, m.id, `poster member "${identity.display_name || m.id}"`, identity.type) : null
  })
  const copy = async () => {
    try {
      await platform.writeClipboardText(inviteLink)
      toast(t('group.settings.inviteCopied'), 'success')
    } catch (error) {
      toast(t('actions.copyFailed', { ns: 'common' }), 'error', safeFailureLine(String((error as Error)?.message ?? error)))
    }
  }

  return (
    <div data-testid="group-invite-link" className="flex min-w-0 items-center gap-2">
      <Button variant="secondary" size="sm" data-testid="group-invite-copy-link" title={inviteLink} onClick={() => { void copy() }}>
        <Link size={14} />{t('group.settings.copyLink')}
      </Button>
      <Button variant="secondary" size="sm" data-testid="group-invite-qr" onClick={() => setShowPoster(true)}>
        <QrCode size={14} />{t('group.settings.qrCode')}
      </Button>
      {showPoster ? (
        <SharePosterDialog
          title={resolveOrLoud(settings.name, 'group share poster title')}
          subtitle={t('group.settings.posterSubtitle', { count: totalMembers })}
          qrValue={inviteLink}
          memberAvatarUrls={posterMemberUrls}
          totalMemberCount={totalMembers}
          qrCaption={t('group.settings.posterQrCaption')}
          ctaText={t('group.settings.posterCta')}
          onClose={() => setShowPoster(false)}
        />
      ) : null}
    </div>
  )
}
