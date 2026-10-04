import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import styles from "./WikiAutocomplete.module.css";

// MEM-5 (PLAN-MEMORY.md §8) — the `[[` title-autocomplete shared by the note
// card (single-line text input) and the in-place editor (textarea). It reads
// the live value + caret straight off the DOM element (during onChange the
// controlled element already holds the newly-typed value, so no stale-state
// race), detects an OPEN `[[partial` token immediately left of the caret, and
// offers the known titles filtered by that partial. Picking one splices
// `[[Title]]` in and drops the caret just past the inserted `]]`.

type FieldEl = HTMLInputElement | HTMLTextAreaElement;

// The open-token matcher: a `[[` with no closing `]]`, `|`, or newline between
// it and the caret (so `[[a]] more [[b` only sees the trailing `b`).
const OPEN_TOKEN_RE = /\[\[([^[\]\n|]*)$/;

// --- pure helpers (unit-tested; the hook is a thin stateful shell over these) ---

/** Detect an open `[[partial` token immediately left of the caret. Returns the
 * index of the `[[` and the partial query, or null when the caret isn't inside
 * an unterminated wiki-link. */
export function detectWikiToken(value: string, caret: number): { tokenStart: number; query: string } | null {
  const m = OPEN_TOKEN_RE.exec(value.slice(0, caret));
  if (!m) return null;
  return { tokenStart: caret - m[1]!.length - 2, query: m[1]! };
}

/** Splice `[[title]]` in place of the open token, returning the new value and the
 * caret position just past the inserted `]]`. */
export function spliceWikiLink(value: string, tokenStart: number, caret: number, title: string): { next: string; caretPos: number } {
  return { next: `${value.slice(0, tokenStart)}[[${title}]]${value.slice(caret)}`, caretPos: tokenStart + title.length + 4 };
}

/** Case-insensitive substring filter of the known titles by the partial query,
 * capped. An empty query lists the first `limit` titles. */
export function filterWikiCandidates(titles: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  return (q ? titles.filter((t) => t.toLowerCase().includes(q)) : titles).slice(0, limit);
}

export function useWikiAutocomplete(opts: {
  titles: string[];
  onChange: (next: string) => void;
  elRef: RefObject<FieldEl | null>;
}) {
  const { titles, onChange, elRef } = opts;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tokenStart, setTokenStart] = useState<number | null>(null);

  // Re-evaluate the open-token state from the element's current value+caret.
  // Called by the field on every change / caret move (keyup, click).
  const refresh = (): void => {
    const el = elRef.current;
    if (!el) { setOpen(false); return; }
    const tok = detectWikiToken(el.value, el.selectionStart ?? el.value.length);
    if (!tok) { setOpen(false); setTokenStart(null); return; }
    setTokenStart(tok.tokenStart);
    setQuery(tok.query);
    setActive(0);
    setOpen(true);
  };

  const candidates = useMemo(() => filterWikiCandidates(titles, query), [query, titles]);

  const showing = open && candidates.length > 0;

  const insert = (title: string): void => {
    const el = elRef.current;
    if (!el || tokenStart == null) return;
    const caret = el.selectionStart ?? el.value.length;
    const { next, caretPos } = spliceWikiLink(el.value, tokenStart, caret, title);
    onChange(next);
    setOpen(false);
    // The value update is async (React state); restore focus+caret next frame.
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caretPos, caretPos); });
  };

  // Returns true when it consumed the key (the field must then early-return so
  // its own Enter/Esc handlers don't also fire).
  const onKeyDown = (ev: KeyboardEvent): boolean => {
    if (!showing) return false;
    if (ev.key === "ArrowDown") { ev.preventDefault(); setActive((a) => (a + 1) % candidates.length); return true; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setActive((a) => (a - 1 + candidates.length) % candidates.length); return true; }
    if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); insert(candidates[active] ?? candidates[0]!); return true; }
    if (ev.key === "Escape") { ev.preventDefault(); setOpen(false); return true; }
    return false;
  };

  return { showing, candidates, active, query, refresh, onKeyDown, insert, setActive };
}

export function WikiAutocompletePopup({ candidates, active, onPick, placement = "below" }: {
  candidates: string[];
  active: number;
  onPick: (title: string) => void;
  placement?: "below" | "above";
}) {
  return (
    <div className={placement === "above" ? styles.popupAbove : styles.popup} role="listbox" data-wiki-autocomplete>
      {candidates.map((t, i) => (
        <div
          key={t}
          className={i === active ? styles.optionActive : styles.option}
          role="option"
          aria-selected={i === active}
          // onMouseDown (not onClick) so the pick fires BEFORE the field blurs.
          onMouseDown={(e) => { e.preventDefault(); onPick(t); }}
          data-wiki-option={t}
        >
          <span className={styles.optBracket}>[[</span>{t}<span className={styles.optBracket}>]]</span>
        </div>
      ))}
    </div>
  );
}
