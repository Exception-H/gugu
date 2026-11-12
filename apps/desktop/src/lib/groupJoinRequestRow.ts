import type { GroupJoinRequest } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'

/** One row of list_group_join_requests / list_managed_group_join_requests (same columns) as the client's join request. */
export function joinRequestFromRow(row: unknown): GroupJoinRequest & { requester_name: string; requester_avatar: string | null } {
  const r = row as {
    id: string
    chat_id: string
    requester_user_id: string
    requester_name: string | null
    requester_avatar: string | null
    message: string | null
    status: string
    created_at: string | null
    requester_type?: string | null; requested_by_user_id?: string | null
  }
  return {
    id: r.id,
    chat_id: r.chat_id,
    requester_user_id: r.requester_user_id,
    requester_type: r.requester_type === 'agent' ? 'agent' as const : 'human' as const, requested_by_user_id: r.requested_by_user_id ?? null,
    requester_name: resolveOrLoud(r.requester_name, `friend-request requester ${r.requester_user_id ?? r.chat_id}`),
    requester_avatar: r.requester_avatar ?? null,
    message: r.message ?? null,
    status: r.status === 'accepted' || r.status === 'rejected' ? r.status : 'pending',
    created_at: r.created_at ?? null,
  }
}
