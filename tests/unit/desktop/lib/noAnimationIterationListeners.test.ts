import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installNoAnimationIterationListeners } from '../../../../apps/desktop/src/lib/no-animation-iteration-listeners'

it('drops animationiteration registrations and keeps every other event', () => {
  class Target extends EventTarget {}
  installNoAnimationIterationListeners(Target.prototype)
  installNoAnimationIterationListeners(Target.prototype) // idempotent: no double wrap
  const target = new Target()
  const iteration = vi.fn()
  const start = vi.fn()
  target.addEventListener('animationiteration', iteration, true)
  target.addEventListener('animationiteration', iteration)
  target.addEventListener('animationstart', start)
  target.dispatchEvent(new Event('animationiteration'))
  target.dispatchEvent(new Event('animationstart'))
  expect(iteration).not.toHaveBeenCalled()
  expect(start).toHaveBeenCalledOnce()
})

// The filter is only safe while nothing in the app listens for the event: make a new listener fail here, not silently.
it('no renderer source listens for animationiteration', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (name === 'node_modules' || name === 'dist') continue
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.(tsx?|jsx?)$/.test(name) || path.endsWith('no-animation-iteration-listeners.ts')) continue
      if (/onAnimationIteration|['"`]animationiteration['"`]/i.test(readFileSync(path, 'utf8'))) offenders.push(path)
    }
  }
  for (const root of ['apps/desktop/src', 'packages']) walk(join(__dirname, '../../../..', root))
  expect(offenders).toEqual([])
})
