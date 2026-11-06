// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useToolbarDisclosure } from '../../../../packages/session-ui/src/react/components/chat-composer/use-toolbar-disclosure'

const harness = createReactHarness()
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
it('measures only in resize delivery, advances through unchanged-size levels, and restores labels when widened', async () => {
  let width = 100
  let delivering = false
  const reads: boolean[] = []
  const active = new Set<() => void>()
  class Observer {
    constructor(private callback: () => void) {}
    observe() { active.add(this.callback) }
    disconnect() { active.delete(this.callback) }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    reads.push(delivering)
    const level = Number((this.closest('[data-level]') as HTMLElement)?.dataset.level ?? 0)
    const left = this.dataset.end !== undefined ? 80 : 0
    const w = this.dataset.level !== undefined ? width : this.dataset.end !== undefined ? 20 : level < 2 ? 200 : 80
    return { left, right: left + w, width: w, top: 0, bottom: 20, height: 20 } as DOMRect
  })
  function Toolbar() {
    const { level, ref } = useToolbarDisclosure()
    return <div ref={ref} data-level={level}><span>Variable label</span><span data-end="">Send</span></div>
  }
  await harness.render(<Toolbar />)
  expect(reads).toEqual([])
  const deliver = async () => {
    delivering = true
    await act(async () => { for (const callback of [...active]) callback() })
    delivering = false
  }
  await deliver()
  await deliver()
  await deliver()
  expect(harness.container.firstElementChild!.getAttribute('data-level')).toBe('2')
  width = 300
  await deliver()
  await deliver()
  expect(harness.container.firstElementChild!.getAttribute('data-level')).toBe('0')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every(Boolean)).toBe(true)
})
