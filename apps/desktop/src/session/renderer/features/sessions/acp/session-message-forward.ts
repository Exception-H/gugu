import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ChatMessage } from '@gugu/session-chat-ui';
import type { ForwardPiece } from '@/components/chat/forwardToChats';

/**
 * What forwarding one timeline bubble carries, or null when it carries nothing that can go. A chat message the agent sent goes
 * as itself; words go as words. `sender` is the name the timeline shows on an agent's bubble; `null` names the forwarder.
 */
export function sessionForwardPieces(input: {
  itemId: string; message: ChatMessage; text: string; sender: string | null; carried?: MessageItem;
}): ForwardPiece[] | null {
  const { carried } = input;
  if (carried) {
    // A chat message the agent sent goes as itself; what it handed its owner in the task has no chat message behind it:
    // its words go as words, and a file kept in the task's folder cannot go (its bytes are not readable here).
    if (carried.chat_id && !carried.session_file) return [{ kind: 'message', message: carried, sender: input.sender ?? undefined }];
    return carried.content_type === 'text' && carried.content?.trim() ? [{ kind: 'text', sender: input.sender, text: carried.content }] : null;
  }
  if (input.message.role !== 'assistant') {
    // A prompt is the forwarder's own unless it was delivered from someone; the timeline's label for one's own is not a name.
    const facts = input.message.guguDelivery?.segments[0]?.facts;
    return [facts ? { kind: 'text', sender: input.sender, senderId: userIdOf(facts.fromId), text: input.text } : { kind: 'text', sender: null, text: input.text }];
  }
  return [{ kind: 'text', sender: input.sender, text: input.text }];
}

/** The user a delivery's `from_id` names (`user:<id>`), if it names one. */
function userIdOf(fromId: string | null | undefined): string | null {
  return fromId?.startsWith('user:') ? fromId.slice('user:'.length) : null;
}
