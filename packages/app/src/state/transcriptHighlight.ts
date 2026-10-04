// TRANSCRIPT-HIGHLIGHT — the query the transcript should mark, while a search is open.
//
// A module store rather than a prop, deliberately. The text that needs marking sits five levels
// down (TranscriptPanel → TranscriptSegment → MessageBody → Inline → a text span) and the panel is
// re-rendered on every streamed delta. Threading a `highlight` prop through that chain would touch
// every component in it and add a parameter to the hottest render path in the app, to carry a
// value that is empty almost all of the time.
//
// It holds ONE query, because there is one search box. If that ever stops being true, the key
// becomes the agent id.

const listeners = new Set<() => void>();
let query = "";

export function highlightQuery(): string { return query; }

export function setHighlightQuery(next: string): void {
  // Whitespace-only is not a search: marking every gap in the transcript is worse than marking
  // nothing, and it is what a half-typed query looks like.
  const trimmed = next.trim();
  if (trimmed === query) return;
  query = trimmed;
  for (const fn of listeners) fn();
}

export function subscribeHighlight(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Split `text` into alternating plain/matched runs for `q`.
 *
 *  Case-INSENSITIVE, and returns the ORIGINAL casing of each match — a highlight that rewrites the
 *  text it marks is a bug that looks like a rendering glitch.
 *
 *  Returns a single unmatched run when there is nothing to mark, so the caller has one code path
 *  and the common case allocates one small array instead of branching.
 *
 *  Matching is LITERAL, not a regex: the query comes from an input where `(`, `*` and `.` are
 *  ordinary characters someone is searching for, and treating them as syntax would either throw or
 *  silently match the wrong thing. */
export function splitHighlight(text: string, q: string): Array<{ text: string; hit: boolean }> {
  if (q.length === 0 || text.length === 0) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (out.length === 0) return [{ text, hit: false }];
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}
