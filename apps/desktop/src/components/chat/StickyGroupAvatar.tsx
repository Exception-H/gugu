import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** 组首那条消息的头像占位带这个标记;组尾的头像层往上找到它为止。 */
const GROUP_TOP_ATTR = 'data-avatar-group-top'

/** A measure reads layout and returns the style writes it wants. */
type Measure = () => (() => void) | undefined
const lists = new WeakMap<Element, { observer: ResizeObserver; measures: Set<Measure> }>()

/**
 * One observer per message list, not one per group tail: N observers on the same list each read rects and then wrote styles,
 * so every delivery forced N layouts. The shared one reads every layer first, then writes them all: one layout per delivery.
 */
function observeList(list: Element, measure: Measure): () => void {
  let entry = lists.get(list)
  if (!entry) {
    const measures = new Set<Measure>()
    const observer = new ResizeObserver(() => { for (const write of [...measures].map((read) => read())) write?.() })
    entry = { observer, measures }
    lists.set(list, entry)
  }
  const { observer, measures } = entry
  measures.add(measure)
  // Re-observing queues a fresh delivery, which is this layer's first measure.
  observer.unobserve(list)
  observer.observe(list)
  return () => {
    measures.delete(measure)
    if (measures.size) return
    observer.disconnect()
    lists.delete(list)
  }
}

/**
 * 消息行的头像那一列(owner 10-25,照 Telegram Web 的 .bubbles-group-avatar):头像画在一组连续消息的最后一条旁边,
 * 组里其余几条只留同宽的占位。最后一条那里套一层从组首气泡上沿伸到这条气泡下沿的绝对定位层,头像在层里
 * position:sticky 贴着输入坞上沿(没有浮动坞时是消息滚动区的底边):组尾在视口下面时头像停在视口底、跟着滚,直到组首滚出去;
 * 头像永远不越出自己这组气泡的纵向范围。行是文档流里的兄弟节点、没有组容器,层的上下沿在布局后量。
 */
export function GroupAvatarSlot({ wide, groupedWithPrev, groupedWithNext, children }: { wide: boolean; groupedWithPrev: boolean; groupedWithNext: boolean; children: ReactNode }) {
  const width = wide ? 'w-[44px]' : 'w-[32px]' // 手机 44(触控目标)、桌面 32,与头像按钮同宽
  if (groupedWithNext) return <div aria-hidden="true" {...(groupedWithPrev ? {} : { [GROUP_TOP_ATTR]: '' })} className={`${width} shrink-0`} />
  return <StickyGroupAvatar width={width} continuesGroup={groupedWithPrev}>{children}</StickyGroupAvatar>
}

function StickyGroupAvatar({ width, continuesGroup, children }: { width: string; continuesGroup: boolean; children: ReactNode }) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current, layer = layerRef.current
    const row = slot?.closest('[role="listitem"]')
    if (!slot || !layer || !row?.parentElement) return
    const measure = () => {
      // 一条成组的消息,组首就是自己这一行 ⇒ 不往上找(往上找会落到上一组的组首,层伸进别的组)。
      let top: Element | null = null
      for (let r = continuesGroup ? row.previousElementSibling : null; r && !top; r = r.previousElementSibling) top = r.querySelector(`[${GROUP_TOP_ATTR}]`)
      // 层的上下沿 = 组首那条气泡的上沿、这一条气泡的下沿:名字/时间行、表情回应都不算。
      const bubble = (r: Element) => r.querySelector('[data-message-bubble-row]')?.getBoundingClientRect()
      const own = bubble(row), first = bubble(top?.closest('[role="listitem"]') ?? row), box = slot.getBoundingClientRect()
      if (!own || !first) return undefined
      return () => {
        layer.style.bottom = `${box.bottom - own.bottom}px`
        layer.style.height = `${own.bottom - first.top}px`
      }
    }
    // No synchronous first measure (it forced a layout mid-commit): the shared observer's next delivery runs after layout,
    // before paint.
    return observeList(row.parentElement, measure)
  }, [continuesGroup])
  return (
    <div ref={slotRef} className={`${width} relative shrink-0 self-stretch`}>
      <div ref={layerRef} className="pointer-events-none absolute inset-x-0 flex flex-col justify-end">
        <div data-chat-dock-reads="" className="pointer-events-auto sticky bottom-[calc(var(--chat-dock-avatar-h,0px)+var(--spacing)*1.5)]">{children}</div>
      </div>
    </div>
  )
}
