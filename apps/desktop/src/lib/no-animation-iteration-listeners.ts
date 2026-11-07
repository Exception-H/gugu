// @@@no-iteration-listener — React adds a capture and a bubble `animationiteration` listener to every root and portal
// container. Once any node in a document has one, Blink wakes the main thread at every iteration boundary of every
// running CSS animation to dispatch the event, compositor-driven ones included, and the flag never clears. With the
// running-bar shimmer and the avatar pulses that was ~12 whole-page style + layerize frames a second while idle.
// Nothing here listens for it (no `onAnimationIteration`; guarded by noAnimationIterationListeners.test.ts), so those
// registrations are dropped. Import for the side effect, before any root is created.
const ITERATION = 'animationiteration'
const INSTALLED = Symbol.for('gugu.noAnimationIterationListeners')

export function installNoAnimationIterationListeners(target: EventTarget = EventTarget.prototype): void {
  const host = target as EventTarget & { [INSTALLED]?: true }
  if (host[INSTALLED]) return
  const add = host.addEventListener
  host.addEventListener = function (this: EventTarget, type, listener, options) {
    if (type === ITERATION) return
    add.call(this, type, listener, options)
  }
  host[INSTALLED] = true
}

installNoAnimationIterationListeners()
