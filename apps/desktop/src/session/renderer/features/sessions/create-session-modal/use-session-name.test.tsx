// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useSessionName, type SessionNameState } from './use-session-name';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: SessionNameState;
let root: Root;
let host: HTMLDivElement;

function Probe({ raw }: { raw: boolean }) {
  latest = useSessionName({ generatedName: '新助手 1', raw });
  return <span>{latest.effectiveSessionName}</span>;
}

function render(raw: boolean) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => root.render(<Probe raw={raw} />));
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('useSessionName', () => {
  it('keeps a Chinese display name exactly as typed when raw', async () => {
    await render(true);
    expect(host.textContent).toBe('新助手 1');
    await act(async () => latest.handleSessionNameChange('张三'));
    expect(latest.sessionName).toBe('张三');
    expect(latest.effectiveSessionName).toBe('张三');
    expect(latest.showSlugHint).toBe(false);
    expect(host.textContent).toBe('张三');
  });

  it('still applies the ASCII session-name rule for ordinary tasks', async () => {
    await render(false);
    await act(async () => latest.handleSessionNameChange('张三'));
    expect(latest.sessionName).toBe('');
    expect(latest.effectiveSessionName).toBe('新助手 1');
    expect(latest.showSlugHint).toBe(true);
  });
});
