import { useEffect, useState, type RefObject } from 'react'

/** True once the element comes within 400px of the viewport, so a read for it waits until it is about to show. */
export function useNearViewport(ref: RefObject<Element | null>, enabled = true): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!enabled || near || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true)
    }, { rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, near, enabled])
  return near
}
