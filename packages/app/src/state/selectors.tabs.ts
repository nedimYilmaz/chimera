// TOPBAR-OVERFLOW — pure fit computation for the responsive tab strip. Takes
// already-measured widths (the shell owns ResizeObserver/getBoundingClientRect)
// so this is unit-testable without a DOM.

export type TabSplit = { visible: number[]; hidden: number[] };

/** Greedy left-to-right fill: keep slots in strip order while they fit
 * `availableWidth`, reserving `overflowWidth` once anything must be hidden —
 * so the drop order is naturally "highest slot index first" (TOPBAR-OVERFLOW
 * #3). `widths[activeIndex]` is always forced into `visible` (acceptance #4)
 * even if it wouldn't otherwise fit; pass an out-of-range `activeIndex`
 * (e.g. -1) when nothing must be pinned. */
export function splitTabs(
  availableWidth: number,
  widths: readonly number[],
  activeIndex: number,
  overflowWidth: number,
): TabSplit {
  const n = widths.length;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= availableWidth) {
    return { visible: widths.map((_, i) => i), hidden: [] };
  }

  const budget = Math.max(0, availableWidth - overflowWidth);
  const hasActive = activeIndex >= 0 && activeIndex < n;
  const visible = new Set<number>();
  let used = 0;
  if (hasActive) {
    visible.add(activeIndex);
    used += widths[activeIndex]!;
  }
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) continue;
    const w = widths[i]!;
    if (used + w > budget) break; // stop at the first slot that doesn't fit — keeps the
    // drop contiguous (highest index first) instead of letting a later, narrower slot
    // sneak into a gap left by an earlier, wider one that didn't fit.
    visible.add(i);
    used += w;
  }

  const visibleArr: number[] = [];
  const hiddenArr: number[] = [];
  for (let i = 0; i < n; i++) (visible.has(i) ? visibleArr : hiddenArr).push(i);
  return { visible: visibleArr, hidden: hiddenArr };
}
