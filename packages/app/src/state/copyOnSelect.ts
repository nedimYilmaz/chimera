// Final-acceptance MAJOR 2 — pane-scoped COPY-ON-SELECT (coverage A7-3; mock
// showSelection=1: Footer "drag select → auto copy", toast "note: 1791
// characters copied to clipboard"): terminal-native selection parity ported to
// the webview. Releasing a drag-selection whose BOTH endpoints sit inside the
// transcript pane (or the events table — same pattern) writes the selection
// text to the clipboard and raises the ui-state NOTICE (the Toast's 3s "note:"
// channel). shift/alt-modified releases skip — the terminal convention for
// "let the app keep the selection" per the mock's help — and selections in
// inputs/textareas/other panes never fire.
//
// Shape discipline: the GATE is pure (unit-tested, node env — nothing below
// module scope touches the DOM until called); the DOM collector + clipboard
// write are thin call-time glue shared by TranscriptPanel and EventsScreen.

import { resolveRawCopy } from "./richMessages";

export type SelectionGate = {
  /** Selection.isCollapsed — a plain click/caret never copies. */
  collapsed: boolean;
  /** Selected text length in chars; zero-length never copies. */
  textLength: number;
  /** BOTH selection endpoints sit inside the owning pane — a selection that
   * starts or ends in another pane belongs to nobody and never fires. */
  anchorInPane: boolean;
  focusInPane: boolean;
  /** Either endpoint sits in an input/textarea/contenteditable — native
   * editing selections are the browser's, never auto-copied. */
  inEditable: boolean;
  /** shift/alt-modified releases skip (terminal-native parity, mock help). */
  shiftKey: boolean;
  altKey: boolean;
};

/** The ONE pure gating rule: copy iff a real, pane-contained, non-editable
 * selection was released without shift/alt. */
export function shouldAutoCopy(g: SelectionGate): boolean {
  if (g.shiftKey || g.altKey) return false;
  if (g.collapsed || g.textLength === 0) return false;
  if (g.inEditable) return false;
  return g.anchorInPane && g.focusInPane;
}

/** The toast body — the mock's literal phrasing ("1791 characters copied to
 * clipboard" behind the Toast's own "note:" prefix). */
export function copiedNotice(chars: number): string {
  return `${chars} characters copied to clipboard`;
}

// ---------------------------------------------------------------------------
// DOM glue (call-time only — never touched by the node-env unit tests)
// ---------------------------------------------------------------------------

function nodeInEditable(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest("input, textarea, [contenteditable=''], [contenteditable='true']") != null;
}

/** F12 — the `data-msg-key` of the transcript message a DOM node sits in, or
 * null when the node isn't inside a keyed (assistant) message. Used to route
 * copy to the RAW markdown source (see richMessages.resolveRawCopy). */
export function nodeMsgKey(node: Node | null): string | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest<HTMLElement>("[data-msg-key]")?.dataset.msgKey ?? null;
}

/** F12 — the message key a live, non-collapsed, single-message selection sits
 * in, or null. Drives the `v` raw-toggle target (the message you selected).
 * Returns null for a collapsed caret or a selection that spans two messages. */
export function selectionMsgKey(pane: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!sel.anchorNode || !pane.contains(sel.anchorNode)) return null;
  if (!sel.focusNode || !pane.contains(sel.focusNode)) return null;
  const a = nodeMsgKey(sel.anchorNode);
  return a !== null && a === nodeMsgKey(sel.focusNode) ? a : null;
}

/** Collect the gate + text for one mouse release over `pane`. null when the
 * document holds no selection at all. `anchorKey`/`focusKey` carry the F12
 * message identity of each endpoint (null when outside a keyed message). */
export function paneSelectionSnapshot(
  pane: HTMLElement,
  ev: { shiftKey: boolean; altKey: boolean },
): { gate: SelectionGate; text: string; anchorKey: string | null; focusKey: string | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString();
  return {
    text,
    anchorKey: nodeMsgKey(sel.anchorNode),
    focusKey: nodeMsgKey(sel.focusNode),
    gate: {
      collapsed: sel.isCollapsed,
      textLength: text.length,
      anchorInPane: sel.anchorNode !== null && pane.contains(sel.anchorNode),
      focusInPane: sel.focusNode !== null && pane.contains(sel.focusNode),
      inEditable: nodeInEditable(sel.anchorNode) || nodeInEditable(sel.focusNode),
      shiftKey: ev.shiftKey,
      altKey: ev.altKey,
    },
  };
}

/** navigator.clipboard first; the execCommand("copy") fallback rides the
 * STILL-LIVE selection (we run inside the mouseup, before anything collapses
 * it), covering webviews where the async clipboard API is walled off. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

/** Install the pane's copy-on-select behavior; returns the disposer. The
 * listener rides WINDOW mouseup (a drag that starts in the pane routinely
 * releases outside it — the selection, not the release point, is what's
 * pane-scoped) and gates every release through shouldAutoCopy against `pane`.
 * `notify(chars)` fires only after a successful clipboard write.
 *
 * F12: when the whole selection sits inside ONE keyed message and `rawLookup`
 * knows its source, the RAW markdown is copied instead of the rendered text
 * (resolveRawCopy); a cross-message or non-keyed selection copies the DOM text
 * as before. The notice reports the characters ACTUALLY copied. */
export function installCopyOnSelect(
  pane: HTMLElement,
  notify: (chars: number) => void,
  rawLookup?: (key: string) => string | undefined,
): () => void {
  const onMouseUp = (ev: MouseEvent): void => {
    const snap = paneSelectionSnapshot(pane, ev);
    if (!snap || !shouldAutoCopy(snap.gate)) return;
    const raw = rawLookup ? resolveRawCopy(snap.anchorKey, snap.focusKey, rawLookup) : null;
    const payload = raw ?? snap.text;
    void writeClipboard(payload).then((ok) => {
      if (ok) notify(payload.length);
    });
  };
  window.addEventListener("mouseup", onMouseUp);
  return () => window.removeEventListener("mouseup", onMouseUp);
}
