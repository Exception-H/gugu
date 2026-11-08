import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from '@/lib/icons';
import './extensions-panel.css';
import './app-store.css';
import './app-manage-page.css';
import { ResourceMenu } from '@/components/ResourceMenu';
import { runResourceAction } from '@/lib/resourceActions';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { ExtensionAgentStatus } from '@shared/extensions/agent-status';
import { givesAgentTools } from '@shared/extensions/app-places';
import type { AppSettings } from '@shared/extensions/app-settings';
import { declaredPermissions, localizedManifestText, localizedTabText, permissionSide, type DeclaredPermission } from '@shared/extensions/catalog';
import { claimedSuffixes, isOwnPage, type ExtensionManifest } from '@shared/extensions/manifest';
import type { MarketVersionHistoryEntry, MarketSourceRef } from '@shared/extensions/market';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';
import type { ResourceContext } from '@shared/resource-actions';
import { AppSettingsForm } from '../app-settings-form';
import { describeCapability, programDetails, type SessionTranslate } from '../extension-consent';
import type { ExtensionsApi } from '../extensions-host';
import type { ExtensionDisclosureLevel } from '../installed-extensions-store';
import { AppGivenSection } from './app-given-section';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { AppMoreMenu } from './app-more-menu';
import { PermissionIcon, formatSize, listOf } from './app-product-page';
import { AppVariantList, type AppVariantRow } from './app-variant-list';
import { VersionHistorySection, type Loadable } from './app-version-history';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';
import { InstalledRowNoticeLine, programFailureText, type InstalledRowNotice } from './installed-extension-row';

export type ManagePageApi = { marketHistory: (args: { extensionId: string }) => Promise<{ success: boolean; data?: MarketVersionHistoryEntry[]; error?: string }> } &
  Partial<Pick<ExtensionsApi, 'agentTools' | 'agentSkills' | 'appData'>>;

/**
 * 一个 App 的设置页:管「这台设备上装着的这一份」,市场上有没有它都一样能用。只读装着的 manifest 和这份的状态,市场只通过 `notice`
 * 说一句有没有新版;介绍和要不要装在市场页(app-product-page.tsx)。没内容的一节不画。手机用同一页,它管不了的那些回调就不给。
 */
export function AppManagePage({
  manifest,
  iconDataUrl,
  enabled,
  switching = false,
  lifecycle,
  pending,
  pendingPercent,
  locale,
  translate,
  machine,
  api,
  readOnly = false,
  backLabel,
  notice,
  origin,
  variants,
  revoked = [],
  pendingPermissions = [],
  agentStatus,
  disclosure,
  givenApi,
  docked = false,
  hiddenTabs = [],
  prompts,
  settingsApi,
  autoUpdate,
  dataBytesKey = 0,
  resource,
  onBack,
  onLifecycle,
  onInstallVersion,
  onSwitchVariant,
  onToggleEnabled,
  onToggleDock,
  onOpenInWindow,
  onForward,
  onSetTabHidden,
  onOpenTab,
  onTogglePermission,
  onDisclosureChange,
  onBrowseReplacement,
  onClearData,
  onViewInMarket,
  onOpenExternal,
  onUninstall,
}: {
  manifest: ExtensionManifest;
  iconDataUrl?: string | null;
  enabled: boolean;
  switching?: boolean;
  /** Open, switch on, or only a word: an update is said by `notice`, with its version. */
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  locale: string;
  translate: SessionTranslate;
  machine?: string;
  api: ManagePageApi;
  readOnly?: boolean;
  backLabel: string;
  notice?: InstalledRowNotice;
  origin?: ExtensionOrigin;
  variants?: { active: string; variants: readonly AppVariantRow[] };
  revoked?: readonly string[];
  pendingPermissions?: readonly string[];
  agentStatus?: ExtensionAgentStatus;
  disclosure?: ExtensionDisclosureLevel;
  givenApi?: Pick<ExtensionsApi, 'appPlaces' | 'changeAppPlaces'>;
  docked?: boolean;
  /** This install's pages the person turned off (`setTabHidden`). */
  hiddenTabs?: readonly string[];
  /** This App's prompts, as the library page draws them. */
  prompts?: ReactNode;
  settingsApi?: { read: () => Promise<{ success: boolean; data?: AppSettings; error?: string }>; save: (settings: AppSettings) => Promise<{ success: boolean; data?: AppSettings; error?: string }> };
  autoUpdate?: { on: boolean; onToggle: (on: boolean) => void };
  /** Changes when the App's data was cleared, so its size is read again. */
  dataBytesKey?: number;
  resource?: ResourceContext;
  onBack: () => void;
  onLifecycle: () => void;
  onInstallVersion?: (ref: MarketSourceRef) => void;
  onSwitchVariant?: (name: string) => void;
  /** Absent for one gugu ships: it cannot be switched off. */
  onToggleEnabled?: (enabled: boolean) => void;
  onToggleDock?: () => void;
  onOpenInWindow?: () => void;
  onForward?: () => void;
  onSetTabHidden?: (tab: string, hidden: boolean) => void;
  /** Opens one of the App's own pages: where `settingsTab` goes. */
  onOpenTab?: (tab: string) => void;
  onTogglePermission?: (permission: string, granted: boolean) => void;
  onDisclosureChange?: (level: ExtensionDisclosureLevel) => void;
  onBrowseReplacement?: (extensionId: string) => void;
  onClearData?: () => void;
  /** Absent when the market has no such App. */
  onViewInMarket?: () => void;
  onOpenExternal: (url: string) => void;
  onUninstall?: () => void;
}) {
  const text = localizedManifestText(manifest, locale);
  const permissions = declaredPermissions(manifest);
  const withdrawn = permissions.filter((permission) => revoked.includes(permission.key)).length;
  const disclosureSwitchId = useId();
  const programs = (manifest.contributes.mcpServers ?? []).map((server) => ('name' in server ? server.name : server.tools));

  // ── 版本历史:点开才读 ──
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Loadable<MarketVersionHistoryEntry[]>>({ status: 'idle' });
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistory({ status: 'loading' });
    void api.marketHistory({ extensionId: manifest.id }).then((result) => {
      if (cancelled) return;
      if (!result.success || !result.data) throw new Error(result.error ?? 'history unreadable');
      setHistory({ status: 'ready', data: result.data });
    }).catch((error: unknown) => {
      if (cancelled) return;
      log.warn('extension version history unreadable:', error);
      setHistory({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [api, manifest.id, historyOpen]);

  // ── 给 agent 的工具:装着、启用、没收回那一项的,问它的程序要清单 ──
  const toolsLive = enabled && givesAgentTools(manifest) && !revoked.includes('agents:tools');
  const [tools, setTools] = useState<Loadable<{ name: string; about: string | null }[] | null>>({ status: 'idle' });
  useEffect(() => {
    if (!toolsLive || !api.agentTools) {
      setTools({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setTools({ status: 'loading' });
    void api.agentTools({ extensionId: manifest.id }).then((result) => {
      if (cancelled) return;
      if (!result.success) throw new Error(result.error ?? 'tools unreadable');
      setTools({ status: 'ready', data: result.data ?? null });
    }).catch((error: unknown) => {
      if (cancelled) return;
      log.warn('App agent tools unreadable:', error);
      setTools({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [api, manifest.id, manifest.version, toolsLive]);
  const toolList = tools.status === 'ready' ? (tools.data ?? []) : [];

  const [skills, setSkills] = useState<string[]>([]);
  useEffect(() => {
    if (!manifest.contributes.skills || !api.agentSkills) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    void api.agentSkills({ extensionId: manifest.id }).then((result) => {
      if (cancelled) return;
      if (!result.success) throw new Error(result.error ?? 'skills unreadable');
      setSkills(result.data ?? []);
    }).catch((error: unknown) => log.warn('App skills unreadable:', error));
    return () => { cancelled = true; };
  }, [api, manifest.id, manifest.version, manifest.contributes.skills]);

  // ── 这台设备上的数据 ──
  const [dataBytes, setDataBytes] = useState<Loadable<number>>({ status: 'idle' });
  useEffect(() => {
    if (!api.appData) return;
    let cancelled = false;
    void api.appData({ extensionId: manifest.id }).then((result) => {
      if (cancelled) return;
      if (!result.success || result.data === undefined) throw new Error(result.error ?? 'App data unreadable');
      setDataBytes({ status: 'ready', data: result.data.bytes });
    }).catch((error: unknown) => {
      if (cancelled) return;
      log.warn('App data unreadable:', error);
      setDataBytes({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [api, manifest.id, dataBytesKey]);

  // ── 页面 ──
  const pageRows = manifest.contributes.tabs.filter((tab) => !tab.hostPage).map((tab) => {
    const title = localizedTabText(manifest, tab, locale).title;
    const suffixes = [...new Set([...claimedSuffixes(tab, 'session'), ...claimedSuffixes(tab, 'chat')])];
    const own = isOwnPage(manifest, tab);
    const note = own
      ? translate('extensions.addsTabPlain')
      : suffixes.length
        ? translate('extensions.addsTabOpens', { suffixes: listOf(suffixes, locale) })
        : translate('extensions.managePageCard');
    return (
      <Row key={tab.name} title={title} note={note} testId={`app-manage-page-${tab.name}`}>
        {own && onSetTabHidden ? (
          <Switch size="sm" checked={!hiddenTabs.includes(tab.name)} aria-label={title} onCheckedChange={(shown) => onSetTabHidden(tab.name, !shown)} />
        ) : null}
      </Row>
    );
  });

  // ── 权限 ──
  const permissionRow = (permission: DeclaredPermission) => {
    const off = revoked.includes(permission.key);
    const commands = permission.kind === 'capability' && permission.key === 'agents:tools' ? programDetails(manifest, translate) : undefined;
    return (
      <div className={cn('mk-pl mg-permission', off && 'is-revoked')} key={permission.key} data-testid={`app-permission-${permission.key}`}>
        <PermissionIcon permission={permission} side={permissionSide(permission)} />
        <span>
          {permission.kind === 'network'
            ? translate('extensions.permissionsNetwork', { hosts: permission.host })
            : describeCapability(permission.key, manifest, translate, machine)}
          {commands ? <pre>{`${commands.caption}\n${commands.lines.join('\n')}`}</pre> : null}
        </span>
        {onTogglePermission ? (
          <button type="button" className="mk-link" disabled={readOnly || pending !== undefined || pendingPermissions.includes(permission.key)} onClick={() => onTogglePermission(permission.key, off)}>
            {translate(off ? 'extensions.restore' : 'extensions.revoke')}
          </button>
        ) : null}
      </div>
    );
  };

  const settingsTab = manifest.contributes.settingsTab ? manifest.contributes.tabs.find((tab) => tab.name === manifest.contributes.settingsTab) : undefined;
  const links = [
    manifest.homepage && { label: translate('extensions.linkHomepage'), href: manifest.homepage },
    manifest.repository && { label: translate('extensions.linkRepository'), href: manifest.repository },
  ].filter((entry): entry is { label: string; href: string } => Boolean(entry));

  const sections: { id: string; label: string; note?: string; body: ReactNode }[] = [];
  if (onToggleDock || onOpenInWindow) {
    sections.push({ id: 'general', label: translate('extensions.manageGeneral'), body: <>
      {onToggleDock ? <Row title={translate('extensions.managePin')} testId="app-manage-pin"><Switch size="sm" checked={docked} aria-label={translate('extensions.managePin')} onCheckedChange={onToggleDock} /></Row> : null}
      {onOpenInWindow ? <Row title={translate('tabs.openInWindow')}><Button type="button" variant="outline" size="sm" onClick={onOpenInWindow}>{translate('extensions.open')}</Button></Row> : null}
    </> });
  }
  sections.push({ id: 'version', label: translate('extensions.manageVersion'), body: <>
    {autoUpdate ? (
      <Row title={translate('extensions.autoUpdate')} note={autoUpdate.on ? translate('extensions.pinHint') : translate('extensions.pinnedAt', { version: manifest.version })} testId="app-manage-auto-update">
        <Switch size="sm" checked={autoUpdate.on} disabled={readOnly} aria-label={translate('extensions.autoUpdate')} onCheckedChange={autoUpdate.onToggle} />
      </Row>
    ) : null}
    {onInstallVersion ? (
      <div className="mg-row is-block" data-testid="app-manage-history">
        <button type="button" className="mg-row-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
          <span>{translate('extensions.detailVersionHistory')}</span>
          <ChevronRight className={cn('size-4', historyOpen && 'rotate-90')} />
        </button>
        {historyOpen ? (
          <fieldset disabled={readOnly} className="contents">
            <div className="mk-vers">
              <VersionHistorySection
                state={history}
                extensionId={manifest.id}
                installedVersion={manifest.version}
                offeredVersion={autoUpdate?.on ? (notice?.kind === 'update' ? notice.version : manifest.version) : null}
                locale={locale}
                translate={translate}
                onOpenExternal={onOpenExternal}
                onInstallVersion={(version) => onInstallVersion({ extensionId: manifest.id, version })}
              />
            </div>
          </fieldset>
        ) : null}
      </div>
    ) : null}
    {variants && variants.variants.length > 1 && onSwitchVariant ? (
      <div className="mg-row is-block">
        <AppVariantList resource={resource} active={variants.active} variants={variants.variants} disabled={readOnly || pending !== undefined} translate={translate} onSwitch={onSwitchVariant} />
      </div>
    ) : null}
    {resource && onViewInMarket ? (
      <Row title={translate('extensions.manageFork')} note={translate('extensions.manageForkNote')} testId="app-manage-fork">
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => void runResourceAction('send-resource-url', resource)}>{translate('extensions.manageForkAction')}</Button>
      </Row>
    ) : null}
  </> });
  if ((manifest.settings?.length && settingsApi) || (settingsTab && onOpenTab)) {
    sections.push({ id: 'settings', label: translate('extensions.manageSettings'), body: <>
      {manifest.settings?.length && settingsApi ? <div className="mg-row is-block" data-testid="app-manage-fields"><AppSettingsForm manifest={manifest} active read={settingsApi.read} save={settingsApi.save} /></div> : null}
      {settingsTab && onOpenTab ? (
        <Row title={localizedTabText(manifest, settingsTab, locale).title} note={translate('extensions.manageOwnSettingsNote')} testId="app-manage-own-settings">
          <Button type="button" variant="outline" size="sm" disabled={!enabled} onClick={() => onOpenTab(settingsTab.name)}>{translate('extensions.open')}</Button>
        </Row>
      ) : null}
    </> });
  }
  if (pageRows.length > 0) sections.push({ id: 'pages', label: translate('extensions.managePages'), note: onSetTabHidden ? translate('extensions.managePagesNote') : undefined, body: pageRows });
  if (givesAgentTools(manifest)) {
    sections.push({ id: 'agents', label: translate('extensions.manageAgents'), body: <fieldset disabled={readOnly} className="contents">
      {agentStatus?.lastFailure ? (
        // 程序在 stderr 上的原话可能是一整段栈,不进文案(仓规 copy-leaks-internal-detail),放在悬停里。
        <Row title={<span className="text-foreground-destructive" title={agentStatus.lastFailure.stderrTail || undefined}>{programFailureText(agentStatus.lastFailure, translate)}</span>} />
      ) : null}
      {givenApi ? (
        <div className="mg-row is-block">
          <AppGivenSection extensionId={manifest.id} api={givenApi} machineName={machine} blocked={!enabled ? 'off' : revoked.includes('agents:tools') ? 'revoked' : undefined} />
        </div>
      ) : null}
      {disclosure && onDisclosureChange ? (
        <div className="mg-row">
          <span className="mg-row-tx is-inline">
            <label htmlFor={disclosureSwitchId}>{translate('extensions.fullDisclosureToggle')}</label>
            <InfoTooltip label={translate('extensions.fullDisclosureInfoLabel')} content={translate('extensions.fullDisclosureInfo')} />
          </span>
          <Switch id={disclosureSwitchId} size="sm" checked={disclosure === 'full'} disabled={readOnly || pending !== undefined} aria-label={translate('extensions.fullDisclosureToggle')} onCheckedChange={(full) => onDisclosureChange(full ? 'full' : 'progressive')} />
        </div>
      ) : null}
      {programs.length > 0 ? (
        toolList.length > 0 ? (
          <Collapsible className="mg-row is-block" data-testid="app-manage-tools">
            <CollapsibleTrigger className="mg-row-toggle">
              <span className="mg-row-tx">
                <span>{translate('extensions.manageTools', { n: String(toolList.length) })}</span>
                <i className="truncate">{toolList.slice(0, 6).map((tool) => tool.name).join('、')}</i>
              </span>
              <ChevronRight className="size-4" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <span className="mk-tools">
                {toolList.map((tool) => (
                  <span className="contents" key={tool.name}>
                    <code title={tool.about ?? undefined}>{tool.name}</code>
                    <i>{tool.about ?? ''}</i>
                  </span>
                ))}
              </span>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <Row title={translate('extensions.addsTools')} note={tools.status === 'loading' ? translate('extensions.inspecting') : translate('extensions.addsToolsWhenOn', { programs: listOf(programs, locale) })} testId="app-manage-tools" />
        )
      ) : null}
      {manifest.contributes.skills ? <Row title={translate('extensions.manageSkills')} note={skills.length > 0 ? skills.join('、') : translate('extensions.addsSkillsText')} testId="app-manage-skills" /> : null}
      {manifest.contributes.instructions ? <Row title={translate('extensions.addsInstructions')} note={manifest.contributes.instructions} testId="app-product-instructions" /> : null}
    </fieldset> });
  }
  if (prompts) sections.push({ id: 'prompts', label: translate('extensions.managePrompts'), note: translate('extensions.managePromptsNote'), body: <div className="mg-row is-block">{prompts}</div> });
  sections.push({ id: 'permissions', label: translate('extensions.detailPermissions'), note: withdrawn > 0
    ? translate('extensions.permissionsWithdrawnNote', { count: permissions.length, revoked: withdrawn })
    : translate(permissions.length === 0 ? 'extensions.permissionsNoteNone' : onTogglePermission ? 'extensions.permissionsNoteAsked' : 'extensions.permissionsNoteInstall'), body: permissions.length === 0
    ? <Row title={translate('extensions.permissionsNone')} />
    : <div className="mg-row is-block"><fieldset disabled={readOnly} className="contents">{permissions.map(permissionRow)}</fieldset></div> });
  if (api.appData && onClearData) {
    sections.push({ id: 'data', label: translate('extensions.manageData'), body: (
      <Row title={translate('extensions.manageDataRow')} note={translate('extensions.manageDataNote')} testId="app-manage-data">
        <span className="mg-value">{dataBytes.status === 'ready' ? (dataBytes.data === 0 ? translate('extensions.manageDataNone') : formatSize(dataBytes.data)) : dataBytes.status === 'error' ? translate('extensions.manageDataUnreadable') : ''}</span>
        <Button type="button" variant="outline" size="sm" disabled={readOnly || dataBytes.status !== 'ready' || dataBytes.data === 0} onClick={onClearData} data-testid="app-manage-data-clear">{translate('extensions.manageDataClear')}</Button>
      </Row>
    ) });
  }
  sections.push({ id: 'source', label: translate('extensions.manageSource'), body: <>
    <Row title={translate(`extensions.origin.${origin ?? 'unknown'}`)} note={manifest.author} testId="app-manage-origin">
      {onViewInMarket ? <Button type="button" variant="outline" size="sm" onClick={onViewInMarket} data-testid="app-manage-market">{translate('extensions.viewInMarket')}</Button> : null}
    </Row>
    <Row title={translate('extensions.manageApi', { version: String(manifest.apiVersion) })} note={manifest.license ? `${translate('extensions.infoLicense')} ${manifest.license}` : undefined}>
      {links.map((link) => <button type="button" className="mk-link" key={link.href} onClick={() => onOpenExternal(link.href)}>{link.label}</button>)}
    </Row>
    {onUninstall ? (
      <Row title={<span className="text-foreground-destructive">{translate('extensions.uninstallAction')}</span>} note={translate('extensions.manageUninstallNote')} testId="app-manage-uninstall">
        <Button type="button" variant="outline" size="sm" disabled={readOnly || pending !== undefined} onClick={onUninstall} data-testid="app-manage-uninstall-action">{translate('extensions.uninstallAction')}</Button>
      </Row>
    ) : null}
  </> });

  // 页面滚动时,左边那一列标出正看着哪一节。
  const [current, setCurrent] = useState(sections[0]!.id);
  const anchors = sections.map((section) => section.id).join(' ');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.find((entry) => entry.isIntersecting);
      if (seen) setCurrent(seen.target.getAttribute('data-manage-section')!);
    }, { rootMargin: '-15% 0px -75% 0px' });
    for (const node of document.querySelectorAll('[data-manage-section]')) observer.observe(node);
    return () => observer.disconnect();
  }, [anchors]);

  return (
    // Two boxes: `.mk` is the size container, and a container query reads an ancestor, never the element itself.
    <div className="mk" data-testid="app-manage-page" data-extension-id={manifest.id}>
      <div className="mg">
      <nav className="mg-anchors" aria-label={translate('extensions.appSettings')}>
        {sections.map((section) => (
          <button type="button" key={section.id} className={cn(current === section.id && 'is-on')} onClick={() => document.querySelector(`[data-manage-section="${section.id}"]`)?.scrollIntoView({ block: 'start' })}>
            {section.label}
          </button>
        ))}
      </nav>
      <div className="mg-main">
        <button type="button" className="mk-back" onClick={onBack} data-testid="app-manage-back">
          <ChevronLeft className="size-3.5" />
          {backLabel}
        </button>
        <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: manifest.id } }}>
          <header className="mg-head">
            <span className="mk-icon is-56"><ExtensionMonogram name={text.name} iconDataUrl={iconDataUrl} /></span>
            <div className="mg-head-tx">
              <h2>{text.name}</h2>
              <p>{[`v${manifest.version}`, machine].filter(Boolean).join(' · ')}</p>
            </div>
            <fieldset disabled={readOnly} className="contents">
              {onToggleEnabled ? <Switch checked={enabled} disabled={readOnly || switching} aria-label={translate('extensions.switchLabel', { name: text.name })} onCheckedChange={onToggleEnabled} data-testid="app-manage-switch" /> : null}
              <AppLifecycleButton state={lifecycle} pending={pending} percent={pendingPercent} disabled={readOnly} translate={translate} onClick={onLifecycle} testId="app-manage-action" />
              <AppMoreMenu name={text.name} enabled={enabled} docked={docked} disabled={readOnly || pending !== undefined} translate={translate} resource={resource} onForward={onForward} testId="app-manage-more" />
            </fieldset>
          </header>
        </ResourceMenu>
        {notice ? (
          <fieldset disabled={readOnly && notice.kind !== 'forkBehind'} className="contents">
            <div className={cn('mk-banner', notice.kind !== 'forkBehind' && notice.kind !== 'update' && notice.kind !== 'gone' && 'is-warn')} data-testid="app-manage-notice">
              <InstalledRowNoticeLine
                notice={notice}
                installedVersion={manifest.version}
                translate={translate}
                onInstallVersion={onInstallVersion ? (version) => onInstallVersion({ extensionId: manifest.id, version }) : undefined}
                onBrowseReplacement={() => onBrowseReplacement?.(manifest.id)}
              />
            </div>
          </fieldset>
        ) : null}
        {sections.map((section) => (
          <section className="mg-sec" key={section.id} data-manage-section={section.id} data-testid={`app-manage-${section.id}`}>
            <h3>{section.label}</h3>
            {section.note ? <p className="mg-note">{section.note}</p> : null}
            <div className="mg-group">{section.body}</div>
          </section>
        ))}
      </div>
      </div>
    </div>
  );
}

/** 一行:左边名目和一句说明,右边它的控件。 */
function Row({ title, note, testId, children }: { title: ReactNode; note?: string; testId?: string; children?: ReactNode }) {
  return (
    <div className="mg-row" data-testid={testId}>
      <div className="mg-row-tx">
        <span>{title}</span>
        {note ? <i>{note}</i> : null}
      </div>
      {children}
    </div>
  );
}
