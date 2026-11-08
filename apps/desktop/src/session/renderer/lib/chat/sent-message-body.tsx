import { useLayoutEffect, useRef } from 'react';
import type { ChatCommands } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels';
import { sentAttachmentLink } from '@gugu/session-core/session-record/send-receipt';
import { MessageBody } from '@/components/chat/MessageBody';
import { SentMessageSurface } from '@/components/chat/sentMessageSurface';

/**
 * One message an agent sent to people, drawn in its task timeline by the chat's own MessageBody — the same widget, file
 * card and reference tags the chat shows. The timeline row only reserves the slot; this reports what it drew.
 */
export function SentMessageBody({ message, commands, onSize }: {
  message: MessageItem;
  commands: ChatCommands | undefined;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sizeTo = useRef(onSize);
  sizeTo.current = onSize;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    // A hidden page (another tab, the app in the background) lays this out at 0×0: that is not its size, keep the last one.
    const report = () => { const rect = element.getBoundingClientRect(); if (rect.width > 0) sizeTo.current({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) }); };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, []);
  const sessionId = commands?.conversationAgentSession?.() ?? null;
  const shown: MessageItem = { ...message, sender_user_id: commands?.conversationAgentUserId?.() ?? null,
    ...(message.session_file ? { session_file: { ...message.session_file, session_id: sessionId } } : {}) };
  // Open a file the way this timeline already opens it: a chat file by its link, a session file through the session.
  const openFile = (meta: ParsedAttachment) => {
    if (meta.source.kind === 'session-file') {
      commands?.onViewAttachment?.({ attachment: { id: `path:${meta.source.path}`, name: meta.fileName, kind: meta.kind }, itemId: message.id, source: 'user-message' });
      return;
    }
    commands?.onOpenLink?.(meta.source.kind === 'item' ? `gugu-file://${meta.source.itemId}?v=${meta.source.version}` : sentAttachmentLink(message.id, message.chat_id || undefined));
  };
  return <div ref={box} data-sent-message-body-content={message.id} style={{ width: 'fit-content', maxWidth: '100%', minWidth: 0 }}>
    <SentMessageSurface.Provider value><MessageBody message={shown} compact={false} isGroup={false} authorIsAgent senderName={commands?.conversationAgentName?.() ?? ''}
      time={null} onOpenFile={openFile} onOpenWorkspaceFile={link => commands?.onOpenFile?.({ path: link.path, itemId: message.id, source: 'prose-link', ...(link.at ? { at: link.at } : {}) })} /></SentMessageSurface.Provider>
  </div>;
}
