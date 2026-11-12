import type { GroupJoinRequest } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { chatService } from './chat'
import { isGroupManagerRole } from './groupMemberPermissions'
import { pendingFirst } from './requestHistory'

/**
 * @@@6418 入群申请(#858)是冲着「人」来的请求 —— 和好友申请一样归通讯录「新的请求」,❌ 折叠在群里。
 * 一条申请带上它要进的那个群,卡片上才说得清「谁想进哪个群」。
 */
export type ManagedGroupJoinRequest = GroupJoinRequest & {
  group: Pick<ContactGroupChat, 'id' | 'name' | 'avatar_url'>
}

/** 我能审的群 = 我是群主或管理员、且群还在(解散的群没有人会再去审)。 */
export function managedGroupChats(groupChats: readonly ContactGroupChat[]): ContactGroupChat[] {
  return groupChats.filter((group) => isGroupManagerRole(group.my_role) && group.status !== 'archived')
}

/**
 * 读我管理的每个群的入群申请(含已处理的),等我处理的在前。一次读(list_managed_group_join_requests,
 * 服务端按同一道管理权限逐群判定),只留调用方问到的这些群 —— 群信息从这里带上。
 * 读失败整体 fail-loud —— 少读一个群 = 让管理员以为「没人申请」而漏审(#1125)。没有我管理的群就一发不打。
 */
export async function listManagedGroupJoinRequests(groups: readonly ContactGroupChat[]): Promise<ManagedGroupJoinRequest[]> {
  if (groups.length === 0) return []
  const byId = new Map(groups.map((group) => [group.id, group]))
  return (await chatService.listManagedGroupJoinRequests()).flatMap((row) => {
    const group = byId.get(row.chat_id)
    return group ? [{ ...row, group: { id: group.id, name: group.name, avatar_url: group.avatar_url } }] : []
  }).sort(pendingFirst)
}
