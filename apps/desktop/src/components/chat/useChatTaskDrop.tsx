import { useState } from 'react'
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components'
import { MAX_ATTACHMENT_BYTES } from '@gugu/session-core/session-record/contract'
import { base64ToBytes } from '@shared/lib/base64'
import { basenameFromAnyPath } from '@shared/path-name'
import { notify } from '@/lib/notices'
import { useSessionMentionDrop } from '../../session/renderer/lib/chat/use-session-mention-drop'
import type { LocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import type { DraggedWorkspaceFile } from '../../session/renderer/lib/drag-files'
import { workspaceRpc } from '../../session/renderer/features/sessions/workspace-backend/workspace-backend'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { TaskDropGroupInvite } from './TaskDropGroupInvite'
import type { ChatMessageComposerProps } from './chatComposerModels'

const folderNotice = () => notify({ title: translateSessionMessage('chat.folderDropUnsupportedTitle'),
  description: translateSessionMessage('chat.folderDropUnsupportedDescription'), tier: 'error' })

/** A computer file dropped on a chat goes as the file, the paperclip's way: read where it is, never its local path. */
async function readWorkspaceFile({ projectId, workspaceId, targetPath }: DraggedWorkspaceFile & { projectId: string }): Promise<File> {
  const files = workspaceRpc(projectId).files
  const parts: BlobPart[] = []
  for (let offset = 0, size = Infinity; offset < size;) {
    const result = await files.readChunk(projectId, workspaceId, { path: targetPath, offset, length: 512 * 1024 })
    if (!result.success) throw new Error(String(result.error.type))
    size = result.data.size
    if (size > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('too large'), { code: 'too-large' })
    const bytes = base64ToBytes(result.data.data)
    if (bytes.length === 0 && offset < size) throw new Error('The file changed while it was read')
    parts.push(bytes.slice().buffer)
    offset += bytes.length
  }
  return new File(parts, basenameFromAnyPath(targetPath))
}

/** A group drop shares the normal mention resolver and the normal member picker. */
export function useChatTaskDrop({ chatId, isGroupChat, groupMembers = [], provider, editorApiRef, enabled, attachFiles }: Pick<ChatMessageComposerProps, 'chatId' | 'isGroupChat' | 'groupMembers'> & {
  provider: LocalSessionMentionProvider
  editorApiRef: { current: PromptEditorRef | null }
  enabled: boolean
  attachFiles: (files: File[]) => void
}) {
  const [invite, setInvite] = useState<{ chatId: string; item: MentionItem } | null>(null)
  if (invite && (invite.chatId !== chatId || !enabled || !isGroupChat)) setInvite(null)
  const drop = useSessionMentionDrop({ provider, editorApiRef, onMentionResolved: (item) => {
    if (!enabled) return false
    if (!isGroupChat || groupMembers.some((member) => `aid:${member.id}` === item.label)) return
    if (chatId) setInvite({ chatId, item })
    return false
  }, onWorkspaceFileDropped: (file) => {
    if (!enabled) return
    if (file.directory) return folderNotice()
    const failed = (error: { code?: string }) => notify({ tier: 'error',
      title: translateSessionMessage(error.code === 'too-large' ? 'composer.attachmentTooLarge' : 'composer.attachmentUploadFailed') })
    const { projectId } = file
    if (!projectId) return failed({})
    void readWorkspaceFile({ ...file, projectId }).then((read) => attachFiles([read]), failed)
  } })
  return { ...drop, onDirectoriesDropped: folderNotice, invitation: invite && invite.chatId === chatId
    ? <TaskDropGroupInvite key={`${invite.chatId}:${invite.item.id}`} chatId={invite.chatId} agentId={invite.item.label.slice('aid:'.length)} onClose={() => setInvite(null)} /> : null }
}
