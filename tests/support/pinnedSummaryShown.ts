/**
 * Whether any point of a pinned user-message summary is on screen. Resting, the summary is hidden over its own
 * message (@@@pin-cover); hidden elements are not hit, so a hit anywhere on the card means it shows. Probes near its
 * left edge: a right-aligned card's middle can lie outside a narrow test viewport.
 */
export function pinnedSummaryShown(summary: HTMLElement): boolean {
  const r = summary.getBoundingClientRect();
  for (let y = r.top + 1; y < r.bottom; y += 2) if (summary.contains(document.elementFromPoint(r.left + Math.min(16, r.width / 2), y))) return true;
  return false;
}
