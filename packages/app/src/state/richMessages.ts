// F12 (W12) — per-message raw-view toggles + the selection→message resolution
// the RAW-markdown copy path needs. Framework-free singleton store (same shape
// as commands.agents.ts's composerLocal) so the capture-phase key handlers can
// read/toggle FRESH state without refs; a useSyncExternalStore binding gives
// components reactivity.
//
// Copy semantics (F12 done-when: "copy yields the original markdown"):
//   Each assistant message wrapper in the transcript carries a stable
//   `data-msg-key` (`${agentId}#${transcriptIndex}`). On a copy (drag-select
//   auto-copy OR mod+y) we resolve the message key from the selection's DOM
//   endpoints; when BOTH endpoints land inside the SAME keyed message we copy
//   that message's RAW markdown source (looked up from the live transcript by
//   the caller) instead of the rendered layout. A partial drag that spans two
//   messages — or a selection inside a non-keyed (user/system/plain) message —
//   has no single raw source, so it falls back to the browser's DOM text
//   (which, for those plain bodies, equals the source anyway).
import { useSyncExternalStore } from "react";

/** `${agentId}#${transcriptIndex}` — the per-message identity on the DOM. */
export function msgKey(agentId: string, index: number): string {
  return `${agentId}#${index}`;
}

// ---------------------------------------------------------------------------
// raw-view toggle store
// ---------------------------------------------------------------------------

let rawKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export const richView = {
  isRaw(key: string): boolean {
    return rawKeys.has(key);
  },
  toggle(key: string): void {
    const next = new Set(rawKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    rawKeys = next;
    emit();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Test seam — reset toggles between cases. */
  reset(): void {
    rawKeys = new Set();
    emit();
  },
};

/** React binding: re-renders the owning message when its raw flag flips. */
export function useRawView(key: string): boolean {
  return useSyncExternalStore(richView.subscribe, () => rawKeys.has(key));
}

// ---------------------------------------------------------------------------
// selection → RAW copy resolution (pure — unit-tested in node, no DOM)
// ---------------------------------------------------------------------------

/** Given the message keys the two selection endpoints resolve to (null when an
 * endpoint isn't inside a keyed message) and a `lookup` for a key's raw source,
 * return the RAW markdown to copy, or null to fall back to the DOM text.
 *
 * Copy raw ONLY when both endpoints sit in the SAME keyed message and its
 * source is known — a cross-message drag or a non-keyed body has no single
 * source and must keep the browser's rendered-text selection. */
export function resolveRawCopy(
  anchorKey: string | null,
  focusKey: string | null,
  lookup: (key: string) => string | undefined,
): string | null {
  if (anchorKey === null || anchorKey !== focusKey) return null;
  return lookup(anchorKey) ?? null;
}
