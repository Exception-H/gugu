/** @jsxImportSource solid-js */
import type { ChatMessage } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useChatName } from '@session-chat/lib/chat-name';
import { useSelfIdentity } from '@session-chat/lib/self-identity';
import { agentSendLabel } from '@session-chat/state/agent-send';
import * as styles from './activity.css';

/** A successful send links to its original chat; the timeline never repeats its body. */
export function SentMessageReceipt(props: { message: ChatMessage }) {
  const t = useChatTranslator(), commands = useCommands();
  const chatName = useChatName(), self = useSelfIdentity();
  const label = () => props.message.groupReply
    ? t('transcript.activityReplyToYou', { name: props.message.groupReply.name })
    : agentSendLabel(props.message.sentTo!, t, chatName, self());
  return <div class={styles.groupReply} data-sent-receipt={props.message.id}><button type="button" class={styles.groupReplyButton}
    onClick={() => {
      const to = props.message.sentTo;
      const target = props.message.groupReply?.target ?? (to?.kind === 'chat'
        ? { kind: 'chat' as const, chatId: to.conversationId ?? to.chatId! } : null);
      if (target) commands().onOpenSender?.({ ...target, messageId: /:sent:([^:]+)$/.exec(props.message.id)?.[1] });
    }} title={label()}>{label()} ›</button></div>;
}
