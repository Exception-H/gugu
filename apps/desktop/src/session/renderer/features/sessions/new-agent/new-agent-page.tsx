import { ChevronDown, Sparkles, Users } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useContactsStore } from '@/store/contactsContext';
import {
  getProjectManagerStore,
  getProjectStore,
} from '@renderer/features/projects/stores/project-selectors';
import { machineLibraryHost } from '@renderer/features/library/library-host';
import { ComposerProjectPicker } from '@renderer/features/sessions/composer-context-tray';
import { ComposerTray } from '@renderer/features/sessions/composer-tray';
import {
  sessionComposerDockBandClassName,
  sessionComposerDockedWidthClassName,
} from '@renderer/features/sessions/session-composer-styles';
import { useCreateSessionCallback } from '@renderer/features/sessions/create-session-modal/use-create-session-callback';
import { useCreateSessionState } from '@renderer/features/sessions/create-session-modal/use-create-session-state';
import { useProjectGitContext } from '@renderer/features/sessions/create-session-modal/use-project-git-context';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { SessionField } from '@renderer/features/sessions/session-config/session-field';
import { useInitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { SessionStateProvider } from '@renderer/features/sessions/session-config/session-state-context';
import {
  describeImplicitProjectFailure,
  MachineProjectPicker,
  useMachineCreateContext,
} from '@renderer/features/sessions/use-machine-create-target';
import {
  ImplicitSessionHomeProjectError,
  ensureImplicitSessionHomeProjectId,
} from '@renderer/features/sessions/implicit-session-home-project';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import {
  machineChoiceFromHost,
  localMachineChoice,
  type MachineChoice,
} from '@renderer/features/remote-hosts/machine-choice';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { log } from '@renderer/utils/logger';
import { sessionRuntimeOfView } from '@shared/core/sessions/sessions';
import { CreateDeliveryError } from '../create-session-modal/create-delivery-error';
import {
  LOCAL_DEVICE_ID,
  readStoredTarget,
  validateTarget,
  writeStoredTarget,
  type NewAgentTargetProblem,
} from './new-agent-target';
import {
  createResidentAgent,
  fetchAgentDefaultName,
  newAgentFailureKey,
  planNewAgentSubmit,
} from './new-agent-submit';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

function projectPathOf(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  return getProjectStore(projectId)?.data?.path ?? null;
}

function targetDeps() {
  return {
    deviceExists: (deviceId: string) =>
      deviceId === LOCAL_DEVICE_ID || Boolean(remoteHostsStore.device(deviceId)),
    projectExists: (projectId: string) => Boolean(getProjectManagerStore().projects.get(projectId)),
    projectPath: (projectId: string) => projectPathOf(projectId),
    projectMachine: (projectId: string) => machineRegistry.machineOf(projectId),
  };
}

type PageTarget = { deviceId: string | null; projectId: string | null };

function routeTarget(projectId: string | undefined): { target: PageTarget; problem: NewAgentTargetProblem | null } {
  if (!projectId) {
    const stored = readStoredTarget();
    // 先照上次选的原样打开；设备名册可能晚一拍到，校验在挂载后的 effect 里做（不在这里猜）。
    return { target: stored ?? { deviceId: LOCAL_DEVICE_ID, projectId: null }, problem: null };
  }
  const deviceId = machineRegistry.machineOf(projectId) ?? LOCAL_DEVICE_ID;
  return { target: { deviceId, projectId }, problem: null };
}

function remoteChoice(deviceId: string, translate: Translate): MachineChoice {
  const device = remoteHostsStore.device(deviceId);
  const connection = remoteHostsStore.connectionState(deviceId);
  if (!device) return { id: deviceId, label: deviceId, isLocal: false, isOnline: false };
  return machineChoiceFromHost(
    device,
    connection,
    translate(
      device.directTerminal
        ? 'task.deviceHintBoth'
        : device.cloudComputer
          ? 'task.deviceHintCloudComputer'
          : 'task.deviceHintGeneralOnly'
    )
  );
}

const blockMessageKey: Record<'name-required' | 'first-task-required' | 'group-needs-first-turn' | 'platform-model-needs-first-turn', SessionMessageKey> = {
  'name-required': 'newAgent.validation.nameRequired',
  'first-task-required': 'newAgent.validation.firstTaskRequired',
  'group-needs-first-turn': 'newAgent.validation.groupNeedsFirstTurn',
  'platform-model-needs-first-turn': 'newAgent.validation.platformModelNeedsFirstTurn',
};

/**
 * 全局 / 项目内的「新建 Agent」共用这一页。
 *
 * 它不另造创建协议：运行时/模型/权限/首轮来自 `useInitialSessionState`，显示名与 workspace 验证来自
 * `useCreateSessionState`，普通创建与首轮投递来自 `useCreateSessionCallback`。本页只多做两件事：
 * 1. 允许项目为空（走隐式任务工作区）；
 * 2. 在「不勾开工」时把提交交给 0.4 的 resident 动作，而不是发一条假的首轮。
 */
export const NewAgentPage = observer(function NewAgentPage() {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { params } = useParams('new-agent');
  const { autoApproveByDefault, includeIssueContextByDefault } = useSessionSettings();
  const contacts = useContactsStore();
  const routeProjectId = params.projectId;
  const initial = useMemo(() => routeTarget(routeProjectId), [routeProjectId]);
  const [deviceId, setDeviceId] = useState<string | null>(initial.target.deviceId);
  const [projectId, setProjectId] = useState<string | null>(initial.target.projectId);
  const [remotePath, setRemotePath] = useState<string | null>(null);
  const [targetProblem, setTargetProblem] = useState<NewAgentTargetProblem | null>(initial.problem);
  const [implicitProjectId, setImplicitProjectId] = useState<string | undefined>(undefined);
  const [implicitProjectFailure, setImplicitProjectFailure] = useState<unknown>(null);
  const [startNow, setStartNow] = useState(false);
  const [groupChatId, setGroupChatId] = useState<string | null>(null);
  const [defaultName, setDefaultName] = useState('');
  const [defaultNameFailed, setDefaultNameFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [residentFailure, setResidentFailure] = useState<SessionMessageKey | null>(null);
  const residentIdRef = useRef<string | null>(null);

  useEffect(() => {
    remoteHostsStore.start();
  }, []);

  // 上次选择只在「有效且可用」时保留：设备不在了 / 项目目录读不到 = 清空并要求重选，
  // ❌ 不改成另一台设备或另一个目录。
  useEffect(() => {
    if (!deviceId) return;
    const checked = validateTarget({ deviceId, projectId }, targetDeps());
    if (checked.ok) {
      setTargetProblem(null);
      return;
    }
    setTargetProblem(checked.problem);
    if (checked.problem === 'device') {
      setDeviceId(null);
      setProjectId(null);
    } else {
      setProjectId(null);
    }
  }, [deviceId, projectId]);

  // 从项目行进来的 projectId 变了（同一个视图换项目）：重新落一次目标；坏项目不悄悄换掉。
  const lastRouteProject = useRef(routeProjectId);
  useEffect(() => {
    if (lastRouteProject.current === routeProjectId) return;
    lastRouteProject.current = routeProjectId;
    const next = routeTarget(routeProjectId);
    setDeviceId(next.target.deviceId);
    setProjectId(next.target.projectId);
    setRemotePath(null);
    setTargetProblem(next.problem);
  }, [routeProjectId]);

  const remote = deviceId && deviceId !== LOCAL_DEVICE_ID
    ? { deviceId, projectPath: remotePath }
    : null;
  const machineContext = useMachineCreateContext(remote);

  useEffect(() => {
    if (deviceId !== LOCAL_DEVICE_ID || projectId) return;
    let cancelled = false;
    void ensureImplicitSessionHomeProjectId().then(
      (id) => {
        if (cancelled) return;
        if (!id) {
          setImplicitProjectFailure(new ImplicitSessionHomeProjectError('unavailable'));
          return;
        }
        setImplicitProjectId(id);
        setImplicitProjectFailure(null);
      },
      (error: unknown) => {
        if (!cancelled) setImplicitProjectFailure(error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, projectId]);

  const implicitProjectError = implicitProjectFailure
    ? describeImplicitProjectFailure(implicitProjectFailure, translate)
    : null;
  const effectiveProjectId = deviceId === LOCAL_DEVICE_ID
    ? projectId ?? implicitProjectId
    : machineContext?.projectId;
  const workdir = projectId && deviceId === LOCAL_DEVICE_ID
    ? projectPathOf(projectId)
    : projectPathOf(effectiveProjectId);

  useEffect(() => {
    if (!deviceId || !effectiveProjectId) return;
    // 不选项目 = 隐式任务工作区：存 null，下一次仍从「不选项目」开始，而不是把隐藏工作区 id 当项目。
    const persistsProject = deviceId === LOCAL_DEVICE_ID && !projectId ? null : effectiveProjectId;
    writeStoredTarget({ deviceId, projectId: persistsProject });
  }, [deviceId, effectiveProjectId, projectId]);

  const {
    defaultBranch,
    isUnborn,
    currentBranch,
    repositoryWorkspaceId,
  } = useProjectGitContext(effectiveProjectId);

  const initialSession = useInitialSessionState(
    effectiveProjectId,
    undefined,
    autoApproveByDefault,
    { resetPromptOnProjectChange: false, dispatchesToChat: false }
  );

  useEffect(() => {
    const provider = initialSession.provider;
    if (!provider || !effectiveProjectId) {
      setDefaultName('');
      setDefaultNameFailed(false);
      return;
    }
    let cancelled = false;
    setDefaultName('');
    setDefaultNameFailed(false);
    void fetchAgentDefaultName(rpc, provider, effectiveProjectId).then(
      (name) => {
        if (!cancelled) setDefaultName(name);
      },
      (error: unknown) => {
        if (cancelled) return;
        setDefaultName('');
        setDefaultNameFailed(true);
        log.error('read the scoped default agent name failed', error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [initialSession.provider, effectiveProjectId]);

  const state = useCreateSessionState(
    effectiveProjectId,
    defaultBranch,
    isUnborn,
    currentBranch,
    repositoryWorkspaceId,
    undefined,
    null,
    {
      requireGeneratedName: false,
      runInProjectDir: true,
      nameSeed: defaultName,
      rawName: true,
    }
  );

  const { handleCreateSession, canCreate, deliveryError } = useCreateSessionCallback({
    selectedProjectId: effectiveProjectId,
    state,
    initialSession,
    navigate,
    onClose: () => {},
    agentDisplayName: state.sessionName.effectiveSessionName,
    birthChatId: startNow && groupChatId ? groupChatId : undefined,
    openAfterCreate: true,
  });

  const plan = planNewAgentSubmit({
    startNow,
    displayName: state.sessionName.effectiveSessionName,
    firstTask: initialSession.prompt,
    groupChatId,
    platformModel: initialSession.platformModel,
  });
  const blockKey = plan.kind === 'blocked' ? blockMessageKey[plan.reason] : null;

  const contextBlocked = Boolean(machineContext?.blocked);
  const contextBlockReason = machineContext?.blockReason ?? null;
  const contextError = contextBlockReason ?? implicitProjectError;
  const contextPending = !contextError && !effectiveProjectId;
  const formReady =
    Boolean(deviceId) &&
    !targetProblem &&
    Boolean(effectiveProjectId) &&
    !contextBlocked &&
    !contextError &&
    !contextPending &&
    state.isValid &&
    Boolean(initialSession.provider) &&
    !initialSession.providerError;
  const canSubmit =
    !submitting &&
    plan.kind !== 'blocked' &&
    formReady &&
    (plan.kind === 'resident'
      ? Boolean(state.workspaceConfig.resolvedConfig)
      : canCreate);

  const chooseDevice = (nextId: string) => {
    const nextDevice = nextId === LOCAL_DEVICE_ID ? LOCAL_DEVICE_ID : nextId;
    setDeviceId(nextDevice);
    setProjectId(null);
    setRemotePath(null);
    setTargetProblem(null);
    setResidentFailure(null);
    writeStoredTarget({ deviceId: nextDevice, projectId: null });
  };

  const chooseProject = (nextId: string | undefined) => {
    setProjectId(nextId ?? null);
    setTargetProblem(null);
    setResidentFailure(null);
    if (deviceId) writeStoredTarget({ deviceId, projectId: nextId ?? null });
  };

  const chooseRemotePath = (path: string | null) => {
    setRemotePath(path);
    setTargetProblem(null);
    setResidentFailure(null);
  };

  const submit = () => {
    if (!canSubmit || !effectiveProjectId || !initialSession.provider) return;
    setResidentFailure(null);
    if (plan.kind === 'first-turn') {
      handleCreateSession();
      return;
    }
    if (plan.kind !== 'resident') return;
    const workspaceConfig = state.workspaceConfig.resolvedConfig;
    if (!workspaceConfig) return;
    const id = residentIdRef.current ?? crypto.randomUUID();
    residentIdRef.current = id;
    setSubmitting(true);
    void createResidentAgent(rpc, {
      id,
      projectId: effectiveProjectId,
      workspaceConfig,
      provider: initialSession.provider,
      runtime: sessionRuntimeOfView(initialSession.sessionView),
      displayName: state.sessionName.effectiveSessionName,
      permissionMode: initialSession.permissionMode,
      model: initialSession.platformModel ? null : initialSession.model,
      effort: initialSession.effort,
    }).then(
      (session) => {
        residentIdRef.current = null;
        navigate('session', { projectId: session.projectId, sessionId: session.id });
      },
      (error: unknown) => {
        setResidentFailure(newAgentFailureKey(error));
        log.error('create resident agent failed', error);
      }
    ).finally(() => {
      setSubmitting(false);
    });
  };

  const devices: MachineChoice[] = [
    localMachineChoice(LOCAL_DEVICE_ID, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map((id) => remoteChoice(id, translate)),
  ];
  const selectedGroup = groupChatId
    ? contacts.groupChats.find((group) => group.id === groupChatId) ?? null
    : null;

  const projectPicker = remote ? (
    <MachineProjectPicker
      target={{ deviceId: remote.deviceId, projectPath: remotePath }}
      onSelect={chooseRemotePath}
    />
  ) : (
    <ComposerProjectPicker
      selectedId={projectId ?? undefined}
      onSelect={chooseProject}
    />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <h1 className="gg-type-page-title">{translate('newAgent.title')}</h1>

          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="new-agent-name">{translate('newAgent.name')}</FieldLabel>
              <Input
                id="new-agent-name"
                value={state.sessionName.sessionName}
                onChange={(event) => state.sessionName.handleSessionNameChange(event.target.value)}
                placeholder={state.sessionName.placeholder || translate('newAgent.namePlaceholder')}
                autoComplete="off"
              />
              <FieldDescription>
                {defaultNameFailed
                  ? translate('newAgent.nameUnavailable')
                  : translate('newAgent.nameHint', { name: state.sessionName.placeholder || translate('newAgent.namePlaceholder') })}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="new-agent-group">{translate('newAgent.group')}</FieldLabel>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button id="new-agent-group" variant="outline" className="w-full justify-between" data-testid="new-agent-group-picker">
                      <span className="flex min-w-0 items-center gap-2">
                        <Users className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {selectedGroup ? selectedGroup.alias || selectedGroup.name : translate('newAgent.groupNone')}
                        </span>
                      </span>
                      <ChevronDown className="size-3.5 shrink-0" />
                    </Button>
                  }
                />
                <DropdownMenuContent className="w-auto min-w-(--anchor-width)">
                  <DropdownMenuLabel>{translate('newAgent.group')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setGroupChatId(null)}>
                    <Users className="size-3.5" />
                    <span>{translate('newAgent.groupNone')}</span>
                  </DropdownMenuItem>
                  {contacts.groupChats.map((group) => (
                    <DropdownMenuItem key={group.id} onClick={() => setGroupChatId(group.id)}>
                      <Users className="size-3.5" />
                      <span className="truncate">{group.alias || group.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <FieldDescription>{translate('newAgent.birthGroupHint')}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="new-agent-workdir">{translate('newAgent.workdir')}</FieldLabel>
              <Input
                id="new-agent-workdir"
                value={workdir ?? translate('newAgent.workdirTaskWorkspace')}
                readOnly
                aria-readonly="true"
              />
              <FieldDescription>{translate('newAgent.workdirHint')}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>{translate('newAgent.runtimeModel')}</FieldLabel>
              <FieldDescription>{translate('newAgent.runtimeModelHint')}</FieldDescription>
            </Field>
          </div>

          {targetProblem ? (
            <p role="alert" className="text-xs text-[var(--em-foreground-destructive)]">
              {translate(targetProblem === 'device' ? 'newAgent.defaultDeviceUnavailable' : 'newAgent.defaultDirectoryUnavailable')}
            </p>
          ) : null}
          {contextBlocked ? (
            <p role="alert" className="text-xs text-[var(--em-foreground-destructive)]">
              {translate('newAgent.deviceOffline')}
            </p>
          ) : null}
          {contextError ? (
            <p role="alert" className="text-xs text-[var(--em-foreground-destructive)]">{contextError}</p>
          ) : null}
          {contextPending ? (
            <p role="status" className="text-xs text-foreground-muted">{translate('newAgent.preparingContext')}</p>
          ) : null}
          {blockKey ? (
            <p role="alert" className="text-xs text-foreground-muted">{translate(blockKey)}</p>
          ) : null}
          {residentFailure ? (
            <div role="alert" className="flex flex-col gap-1 text-xs">
              <span className="text-[var(--em-foreground-destructive)]">{translate(residentFailure)}</span>
              <span className="text-foreground-muted">{translate('newAgent.createFailedNext')}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className={sessionComposerDockBandClassName}>
        <div className={sessionComposerDockedWidthClassName}>
          <ComposerTray
            projectPicker={projectPicker}
            devicePicker={
              <MachinePicker
                size="compact"
                testId="new-agent-device-picker"
                wakeOnPick="retry"
                machines={devices}
                selectedId={deviceId}
                onSelect={chooseDevice}
                onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
              />
            }
            host={machineContext?.host ?? machineLibraryHost(null)}
          >
            <SessionStateProvider
              workspaceConfig={state.workspaceConfig}
              initialSession={initialSession}
              projectId={effectiveProjectId}
              isUnborn={isUnborn}
              hasPR={false}
              includeIssueContextByDefault={includeIssueContextByDefault}
            >
              <SessionField
                placeholder={translate('newAgent.firstTaskPlaceholder')}
                showAutoApproveToggle
                enableAttachments={startNow}
              />
            </SessionStateProvider>
          </ComposerTray>

          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="new-agent-start-now"
                checked={startNow}
                onCheckedChange={(checked) => setStartNow(checked === true)}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="new-agent-start-now" className="text-foreground">
                  {translate('newAgent.startNow')}
                </Label>
                <p className="text-xs text-foreground-muted">{translate('newAgent.startNowHint')}</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <CreateDeliveryError failure={deliveryError} />
              <Button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="ml-auto shrink-0"
                data-testid="new-agent-submit"
              >
                <Sparkles className="size-4" />
                {submitting ? translate('newAgent.creating') : translate('newAgent.create')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

function NewAgentViewWrapper({ children }: { children: ReactNode; projectId?: string }) {
  return <>{children}</>;
}

export const newAgentView = {
  WrapView: NewAgentViewWrapper,
  TitlebarSlot: ShellTitlebar,
  MainPanel: NewAgentPage,
  // 从项目行带进来的是「这一次」的项目；离开后从全局入口进来不该继承上一个项目。
  transientParams: ['projectId'] as const,
};
