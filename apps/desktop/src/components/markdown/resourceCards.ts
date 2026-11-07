import { parseGuguLink } from '@gugu/core/shared/ui/guguLink'
import type { Element, ElementContent, Root } from 'hast'
import { FILE_PILL_CLASS } from './filePills'

/**
 * Chat link cards: a folder file, one chat message or one task item linked in a chat message also shows as a card
 * under its paragraph, as Discord embeds a link. The paragraph keeps the link as written; the card is a second `<a>`
 * to the same place (`Markdown`'s link draws it), so clicking either opens it the same way. Runs after sanitizing,
 * like the file pill pass; an `@` file pill already shows its file and gets no card.
 */
export const RESOURCE_CARD_CLASS = 'gg-resource-card'
const MAX_CARDS = 4

/** A link a card can describe: a file, a message (not a bare chat) or a task item (not a bare task). */
export function cardTarget(href: string) {
  const target = parseGuguLink(href)
  if (target?.kind === 'file') return target
  if (target?.kind === 'chat' && target.messageId) return target
  if (target?.kind === 'session' && target.itemId) return target
  return null
}

export function rehypeResourceCards() {
  return (tree: Root) => visit(tree)
}

function visit(parent: Root | Element): void {
  const next: unknown[] = []
  for (const node of parent.children) {
    next.push(node)
    if (node.type !== 'element') continue
    if (node.tagName !== 'p') { visit(node); continue }
    const hrefs = [...new Set(links(node))].slice(0, MAX_CARDS)
    if (hrefs.length) next.push({ type: 'element', tagName: 'div', properties: { className: ['gg-resource-cards'] },
      children: hrefs.map(href => ({ type: 'element', tagName: 'a', properties: { href, className: [RESOURCE_CARD_CLASS] }, children: [] })) })
  }
  parent.children = next as typeof parent.children
}

function links(node: Element): string[] {
  return (node.children as ElementContent[]).flatMap((child) => {
    if (child.type !== 'element') return []
    const href = child.properties?.href
    const classes = Array.isArray(child.properties?.className) ? child.properties.className : []
    if (child.tagName === 'a' && typeof href === 'string') return classes.includes(FILE_PILL_CLASS) || !cardTarget(href) ? [] : [href]
    return links(child)
  })
}
