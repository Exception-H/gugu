import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { platform } from '@/platform'
import { Link, QrCode } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { displayAvatarUrl } from '../../lib/dicebearAvatar'
import { qrColors } from '../../lib/qrColors'
import { useChatStore } from '../../store/chatContext'
import { useAgentLookPostersVersion } from '../agentAvatar/posters'
import { SharePosterDialog } from '../SharePosterDialog'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { buildUnifiedMembers } from './groupMemberModels'

/**
 * @@@group-share 分享本群只有这一处:画在「邀请」那张选人单里(群头部的邀请、成员页的邀请、拖任务进群都开它)。
 * 平时是选人单边上的一排(复制链接 / 二维码);没有可选的人时它就是整张单的主体(main):码直接画出来。
 * 链接为 null(开关关着、项目群)时调用方不画它 —— groupInviteLinkFor 是唯一的判定。
 */
export function GroupInviteShare({ inviteLink, groupName, snapshot, main = false }: {
  inviteLink: string
  groupName: string | null | undefined
  snapshot: GroupCollabSnapshot
  main?: boolean
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { identitiesById } = useChatStore('identitiesById')
  const [showPoster, setShowPoster] = useState(false)
  const [qr, setQr] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  // @@@445/#2470 海报 canvas 不走 React Avatar → 按同一口径预解析成员头像;小鸟的定格画好了会重渲染,这里跟着重读。
  useAgentLookPostersVersion()
  useEffect(() => {
    if (!main) return
    let cancelled = false
    QRCode.toDataURL(inviteLink, { width: 440, margin: 1, color: qrColors() })
      .then((url) => { if (!cancelled) setQr({ url, error: null }) })
      .catch((error: unknown) => { if (!cancelled) setQr({ url: null, error: messageForUser(error) }) })
    return () => { cancelled = true }
  }, [inviteLink, main])

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

  const size = main ? 'md' : 'sm'
  const buttons = (
    <div className="flex min-w-0 items-center gap-2">
      <Button variant={main ? 'primary' : 'secondary'} size={size} data-testid="group-invite-copy-link" title={inviteLink} onClick={() => { void copy() }}>
        <Link size={14} />{t('group.settings.copyLink')}
      </Button>
      <Button variant="secondary" size={size} data-testid="group-invite-qr" onClick={() => setShowPoster(true)}>
        <QrCode size={14} />{main ? t('sharing.posterTitle', { ns: 'contacts' }) : t('group.settings.qrCode')}
      </Button>
    </div>
  )
  return (
    <div data-testid="group-invite-link" data-layout={main ? 'main' : 'bar'} className={main ? 'flex flex-col items-center gap-5' : undefined}>
      {main ? (
        <div className="grid h-[220px] w-[220px] place-items-center overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--qr-paper)]">
          {qr.url ? <img src={qr.url} alt={t('group.settings.qrCode')} className="h-[208px] w-[208px]" />
            : qr.error ? <p role="alert" className="!m-0 !p-4 text-center text-[length:var(--font-caption)] text-[var(--danger-fg)]">{qr.error}</p>
            : <QrCode size={42} className="text-[var(--text-tertiary)]" aria-hidden />}
        </div>
      ) : null}
      {buttons}
      {showPoster ? (
        <SharePosterDialog
          title={resolveOrLoud(groupName, 'group share poster title')}
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
