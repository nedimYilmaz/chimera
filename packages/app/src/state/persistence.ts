// OUTBOX-SURVIVES-RELOAD: localStorage persistence for the composer outbox
// queue + draft text. Lives HERE (app layer), not @chimera/ui-state, because
// ui-state is shared with the TUI (no localStorage there) and is deliberately
// storage-agnostic (see createStore.ts's own header). Mirrors AgentList.tsx's
// existing try/catch localStorage pattern (read on init, write on change) —
// any failure (unavailable storage, corrupt JSON, quota) degrades to "empty
// queue"/"empty draft", never a throw.
import type { OutboxItem } from "@chimera/ui-state";

export const OUTBOX_STORAGE_KEY = "chimera.composer.outbox.v1";
export const DRAFT_STORAGE_KEY = "chimera.composer.draft.v1";

// A restored item that still carries images/content blocks (base64) can be
// individually huge. Above this per-item serialized size, drop the heavy
// fields and keep only the text — better a plain-text message survives a
// reload than the whole queue gets refused. 20KB comfortably covers a normal
// pasted image thumbnail's JSON overhead without risking the total cap below.
const MAX_ITEM_BYTES = 20_000;
// Total serialized outbox budget. localStorage is commonly capped at ~5MB
// per origin shared with everything else the app stores; this is a small,
// conservative slice of that. Oldest items are dropped first to fit.
const MAX_TOTAL_BYTES = 300_000;
// The draft is plain text (no images) — generous but bounded so a runaway
// paste can't wedge startup.
const MAX_DRAFT_CHARS = 50_000;

function isOutboxItem(v: unknown): v is OutboxItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["id"] === "string" && typeof o["agentId"] === "string" && typeof o["text"] === "string";
}

/** Load the persisted outbox queue. Never throws — corrupt/missing/oversized state yields []. */
export function loadPersistedOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOutboxItem);
  } catch {
    return [];
  }
}

/**
 * Persist the current outbox queue, same tick as every add/remove/edit (no
 * timer/debounce — see the task's requirement that a drained item can never
 * be resurrected). Shrinks oversized items (drops images/content, keeps
 * text) and, if still over budget, drops the OLDEST items until it fits.
 * Never throws (private-mode/disabled storage, QuotaExceededError, etc).
 */
export function persistOutbox(items: readonly OutboxItem[]): void {
  try {
    const shrunk = items.map((item) => {
      const full = JSON.stringify(item);
      if (full.length <= MAX_ITEM_BYTES) return { item, size: full.length };
      const { images: _images, content: _content, ...rest } = item;
      const stripped = JSON.stringify(rest);
      return { item: stripped.length <= MAX_ITEM_BYTES ? rest : { ...rest, text: rest.text.slice(0, MAX_ITEM_BYTES) }, size: Math.min(stripped.length, MAX_ITEM_BYTES) };
    });
    let kept = shrunk;
    let total = kept.reduce((n, s) => n + s.size, 0);
    while (total > MAX_TOTAL_BYTES && kept.length > 0) {
      const [dropped, ...rest] = kept;
      total -= dropped?.size ?? 0;
      kept = rest;
    }
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(kept.map((s) => s.item)));
  } catch {
    // storage unavailable or quota exceeded — queue stays session-only for this write
  }
}

/** Load the persisted composer draft. Never throws — corrupt/missing state yields "". */
export function loadPersistedDraft(): string {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (typeof raw !== "string") return "";
    return raw.slice(0, MAX_DRAFT_CHARS);
  } catch {
    return "";
  }
}

/** Persist the composer draft text, same tick as every keystroke-driven update. */
export function persistDraft(text: string): void {
  try {
    if (!text) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, text.slice(0, MAX_DRAFT_CHARS));
  } catch {
    // storage unavailable or quota exceeded — draft stays session-only for this write
  }
}

// IN-APP-TERMINAL Task 6 / TERMINAL-DOCK-PER-AGENT: design doc §"Persistence" — the dock's
// HEIGHT persists across reloads (a layout preference, shared across agents); open/closed no
// longer does. Open-state became per-agent, and since tabs themselves are never persisted (no
// PTY/scrollback survives a reload — same as before), a persisted "open" flag would have
// nothing to apply to on boot: every agent starts with zero tabs post-reload, and this
// selector's own rule is that zero tabs means a closed, chromeless dock regardless of any
// open flag. Dropping it outright (rather than persisting per-agent, keyed by an agent id
// that reload can't even guarantee still exists) is simpler and behaviorally identical.
export const TERMINAL_DOCK_STORAGE_KEY = "chimera.terminal.dock.v1";
const DEFAULT_DOCK_HEIGHT = 260; // mirrors ui-state's own initialState.terminals.dockHeight

/** Load the persisted dock height. Never throws — corrupt/missing state yields the same
 * default ui-state's own initialState uses (260px). Tolerates the pre-existing `{open,height}`
 * shape on disk (from before open-state was dropped) by simply ignoring `open`. */
export function loadPersistedTerminalDock(): { height: number } {
  try {
    const raw = localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY);
    if (!raw) return { height: DEFAULT_DOCK_HEIGHT };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { height: DEFAULT_DOCK_HEIGHT };
    const o = parsed as Record<string, unknown>;
    return {
      height: typeof o["height"] === "number" && Number.isFinite(o["height"]) ? o["height"] : DEFAULT_DOCK_HEIGHT,
    };
  } catch {
    return { height: DEFAULT_DOCK_HEIGHT };
  }
}

/** Persist the dock's height, same tick as every resize (no timer). */
export function persistTerminalDock(height: number): void {
  try {
    localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify({ height }));
  } catch {
    // storage unavailable or quota exceeded — dock height stays session-only for this write
  }
}

// VOICE-STOP: "Speak agent replies" — the operator-facing mute for spoken output. Lives beside
// the other app prefs (not in ui-state, which is storage-agnostic for the TUI) and is read ONCE
// at module init by voice/ttsGate.ts, which owns the live value.
export const VOICE_PREFS_STORAGE_KEY = "chimera.voice.prefs.v1";

export type VoicePrefs = { speakReplies: boolean };

/** Default is today's behaviour (replies ARE spoken) — turning speech off is an explicit choice,
 * so a missing/corrupt entry must never silently mute the app. */
export const DEFAULT_VOICE_PREFS: VoicePrefs = { speakReplies: true };

/** Never throws — corrupt/missing/disabled storage yields the default. */
export function loadPersistedVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_VOICE_PREFS };
    const o = parsed as Record<string, unknown>;
    return { speakReplies: typeof o["speakReplies"] === "boolean" ? o["speakReplies"] : DEFAULT_VOICE_PREFS.speakReplies };
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

/** Persist the voice prefs, same tick as the toggle (no debounce). */
export function persistVoicePrefs(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(VOICE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable or quota exceeded — the pref stays session-only for this write
  }
}
