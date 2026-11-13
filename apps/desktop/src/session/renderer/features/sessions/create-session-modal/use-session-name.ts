import { useCallback, useState } from 'react';
import { liveTransformSessionName } from '@renderer/utils/sessionNames';

export type SessionNameState = {
  /** The user's typed value — may be empty if they haven't typed anything yet. */
  sessionName: string;
  /** The generated name shown as placeholder when the input is empty. */
  placeholder: string;
  /** The name to use when creating: the user's value if non-empty, else the generated name. */
  effectiveSessionName: string;
  handleSessionNameChange: (value: string) => void;
  showSlugHint: boolean;
  isPending: boolean;
};

export function useSessionName(opts?: {
  generatedName?: string;
  isPending?: boolean;
  resetKey?: unknown;
  initialName?: string;
  /**
   * true = 这一格是**显示名**（agent 名），不是会话/分支 slug：中文、空格、大小写原样保留。
   * 新建 Agent 的显示名走这条；普通新建任务仍然走 `liveTransformSessionName` 的 ASCII 规则。
   */
  raw?: boolean;
}): SessionNameState {
  const { generatedName, isPending = false, resetKey, raw = false } = opts ?? {};
  const [sessionName, setSessionName] = useState('');
  const [showSlugHint, setShowSlugHint] = useState(false);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);

  // Reset user input when the project/context changes.
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setSessionName('');
    setShowSlugHint(false);
  }

  const handleSessionNameChange = useCallback((value: string) => {
    // 显示名是寻址名：中文直接可用，❌ 不走 generateSessionName 的 ASCII slug（0.6 的规则）。
    if (raw) {
      setSessionName(value);
      setShowSlugHint(false);
      return;
    }
    const transformed = liveTransformSessionName(value);
    setSessionName(transformed);
    const hasDroppedChars = /[^a-z0-9\s-]/i.test(value);
    setShowSlugHint(hasDroppedChars);
  }, [raw]);

  const placeholder = generatedName ?? '';
  const effectiveSessionName = sessionName.trim() || generatedName || '';

  return {
    sessionName,
    placeholder,
    effectiveSessionName,
    handleSessionNameChange,
    showSlugHint,
    isPending,
  };
}
