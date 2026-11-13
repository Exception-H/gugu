// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/features/sidebar/sidebar-primitives', () => ({
  sidebarRowContentInsetX: '',
  SidebarMenuButton: ({
    children,
    onClick,
    isActive,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    isActive?: boolean;
  } & Record<string, unknown>) => (
    <div role="button" data-active={String(Boolean(isActive))} onClick={onClick} {...props}>{children}</div>
  ),
}));

import { NewAgentSidebarEntry } from './new-agent-entry';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.navigate.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('global new-agent entry', () => {
  it('renders in the global sidebar and opens the projectless form', async () => {
    await act(async () => root.render(<NewAgentSidebarEntry />));
    const entry = host.querySelector('[data-testid="sidebar-new-agent"]');
    expect(entry).not.toBeNull();
    expect(entry?.getAttribute('aria-label')).toBe('sidebar.newAgent');
    await act(async () => (entry as HTMLElement).click());
    expect(mocks.navigate).toHaveBeenCalledWith('new-agent');
  });

  it('marks itself active when the form is the current view', async () => {
    await act(async () => root.render(<NewAgentSidebarEntry active />));
    expect(host.querySelector('[data-testid="sidebar-new-agent"]')?.getAttribute('data-active')).toBe('true');
  });
});
