import { Sparkles } from '@/lib/icons';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SidebarMenuButton, sidebarRowContentInsetX } from '@renderer/features/sidebar/sidebar-primitives';
import { cn } from '@renderer/utils/utils';

/**
 * 全局侧栏的「新建 Agent」—— 不选项目也能进同一个表单。
 *
 * 它与「新建任务」并排，但**不是**同一个动作：新建任务要首句才建得出来；新建 Agent 允许
 * 先建一个常驻 Agent（0.4），等第一条消息再启动。
 */
export function NewAgentSidebarEntry({ active = false }: { active?: boolean }) {
  const { navigate } = useNavigate();
  const { translate } = useSessionMessages();
  return (
    <SidebarMenuButton
      isActive={active}
      onClick={() => navigate('new-agent')}
      aria-label={translate('sidebar.newAgent')}
      data-testid="sidebar-new-agent"
      className={cn('w-full justify-between')}
    >
      <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
        <Sparkles className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
        <span className="truncate">{translate('sidebar.newAgent')}</span>
      </span>
    </SidebarMenuButton>
  );
}
