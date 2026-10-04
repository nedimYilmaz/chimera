// TRANSCRIPT-FIND — ⌘F as find-in-page: how many matches are ON SCREEN, and stepping through them.
//
// The search bar already had a "hits" number, but it came from the events.search RPC — a server
// side index over the agent's whole history. That is a different question from the one the marks
// in front of you answer, and the two disagree loudly: with the word highlighted a dozen times in
// the transcript, the bar read "0 hits". A count that contradicts what the operator can see is
// worse than no count.
//
// So the count and the navigation both come from the marks themselves. The history search stays —
// it reaches turns that were evicted or never loaded, which no DOM scan can — but it is no longer
// what the number means.

/** Stamped on every <mark> the highlighter renders (MessageBody's Highlighted). */
export const HIT_ATTR = "data-transcript-hit";
/** Stamped on the ONE mark the cursor is on. Driven imperatively rather than through React state:
 *  the alternative is threading a global match index down to a leaf span that re-renders on every
 *  streamed delta, to carry a value that is unset almost always. */
export const HIT_CURRENT_ATTR = "data-transcript-hit-current";

/** Where the cursor lands after stepping `delta` from `current` over `total` matches.
 *
 *  WRAPS, because a find that stops dead at the end reads as broken — you press again and nothing
 *  happens, with no way to tell "no more" from "not working". Returns -1 when there is nothing to
 *  step through, which is the only state with no valid cursor.
 *
 *  `current` of -1 means "no cursor yet": stepping UP from there lands on the LAST match, not the
 *  first. Searching a transcript means looking back through it, so the nearest match is the one at
 *  the bottom — the same reason Enter is bound to the upward step. */
export function nextMatchIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta < 0 ? total - 1 : 0;
  return ((current + delta) % total + total) % total;
}

/** Every match currently rendered, in document order. */
export function matchElements(root: ParentNode | null | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(`[${HIT_ATTR}]`));
}

/** Move the cursor to `index`, clearing the old one, and bring it into view.
 *  Returns the index actually applied (-1 when there was nothing to apply it to). */
export function applyMatchCursor(root: ParentNode | null | undefined, index: number): number {
  const marks = matchElements(root);
  for (const m of marks) m.removeAttribute(HIT_CURRENT_ATTR);
  const target = marks[index];
  if (!target) return -1;
  target.setAttribute(HIT_CURRENT_ATTR, "");
  // "center" rather than the default: a match scrolled to the very edge of the pane is technically
  // visible and practically missed.
  target.scrollIntoView({ block: "center", behavior: "auto" });
  return index;
}
