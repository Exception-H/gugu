import { vi } from 'vitest'

/**
 * Shared double for `vi.mock('@main/lib/logger')`.
 *
 * The production logger is a full {@link Logger}: it exposes `debug/info/warn/error` *and* `child`.
 * Scope creation (`packages/session-wire/src/util/scope.ts`) calls `log.child({ scope })` for every
 * labelled scope, so a hand-written mock that only lists `warn/error/info` throws
 * `logger.child is not a function` the moment the code under test reaches a scope — which is how a
 * freshly merged feature can turn an unrelated old test red.
 *
 * `child()` returns the same object on purpose: callers log through the child, so a test that
 * asserts on `log.warn` must observe those writes. Returning a fresh stub would make assertions
 * silently pass. Pass `overrides` when a test needs a specific spy or a sink.
 */
export type TestLoggerMock = {
  level: 'error'
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  child: (bindings?: Record<string, unknown>) => TestLoggerMock
}

export function createLoggerMock(overrides: Partial<TestLoggerMock> = {}): TestLoggerMock {
  const log = {
    level: 'error' as const,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  } as TestLoggerMock
  if (!overrides.child) log.child = () => log
  return log
}
