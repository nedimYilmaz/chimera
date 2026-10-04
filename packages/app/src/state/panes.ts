// PANE-RESIZE — the width of each screen's left pane, dragged by the operator and remembered.
//
// Keyed PER SCREEN, not one shared width, for two reasons: the screens genuinely disagree today
// (agents/queues/teams are 430px, settings 300, help 150) and collapsing them onto one number
// would silently redesign six screens the first time this shipped; and the panes hold different
// things, so "wide enough" is a different answer on each.
//
// Defaults below MIRROR the CSS that shipped before this existed — the guard test pins that, so a
// fresh install looks exactly as it did and only an explicit drag changes anything.

const STORAGE_KEY = "chimera.panes.v1";

/** Every resizable left pane. A screen not listed here simply has no divider. */
export type PaneKey =
  // Vertical splits — the left rail's width on each screen.
  | "agents" | "meetings" | "queues" | "teams" | "roles" | "projects" | "memory" | "inbox" | "settings" | "help"
  // memory is a THREE-column screen: a folder rail, the note list, then the detail. Two seams, so
  // two keys — "memory" stays the list's width (unchanged) and this is the rail's.
  | "memory.rail"
  // Horizontal splits — the height of the pane BELOW the seam. Named with the screen they live on,
  // because the same boundary means a different thing elsewhere.
  | "agents.composer";

export const PANE_DEFAULTS: Readonly<Record<PaneKey, number>> = {
  agents: 430, meetings: 300, queues: 430, teams: 430, roles: 430, projects: 430, memory: 430, inbox: 430,
  settings: 300, help: 150,
  // The composer band was content-sized (it grew with the textarea, up to its own max). 148 is
  // roughly where it settled with a couple of lines plus the queued/target chrome — a starting
  // point, not a rule, which is the whole reason it is draggable.
  "agents.composer": 148,
  "memory.rail": 172,
};

// Bounds are absolute, not proportional: a pane dragged to 20px is not a narrow pane, it is a lost
// one — nothing in it is readable and the divider is hard to find again. The upper bound is
// applied against the live container width at drag time (see clampPaneWidth), because a fixed
// ceiling would let a pane swallow the whole window on a small display.
export const PANE_MIN_PX = 180;

// PER-PANE FLOORS. A pane can only go as narrow as its CONTENT stays usable, and that differs:
// the agents list is a few flexible columns, while the schedules rail is a fixed-column table.
//
// queues is here for a concrete reason the tests found. SCHEDULE-NAME-INVISIBLE was a real bug —
// fixed columns overflowed the rail, so the job-name column resolved to zero width and every
// schedule showed as a cron expression with no name. It was fixed by making the budget fit at
// 430px. Making the rail DRAGGABLE put that bug back within reach: below ~348px the fixed columns
// win again and the name silently collapses. The floor is set above it rather than letting the
// drag reintroduce a bug someone already had to diagnose once.
//
// 348 = 20 (lead) + 70 + 56 + 64 (the trailing columns' own min-widths) + 110 (the name column's
// floor) + 28 (row padding). schedules-name-column.test.ts asserts that arithmetic against the
// real stylesheet, so widening a column fails there instead of silently re-hiding the name.
const PANE_MIN_OVERRIDES: Partial<Record<PaneKey, number>> = {
  queues: 348,
  // The composer must always show its input plus one row of chrome. Dragged shut it would hide the
  // thing you type into, with the seam sitting on top of it.
  "agents.composer": 96,
  // The rail shows folder names; below this they truncate to nothing useful.
  "memory.rail": 120,
};

/** The narrowest this particular pane may become. */
export function paneMinWidth(key: PaneKey): number {
  return PANE_MIN_OVERRIDES[key] ?? PANE_MIN_PX;
}
/** The right side must keep at least this much, whatever the operator drags. */
export const PANE_RIGHT_MIN_PX = 320;

/** Clamp a proposed width against the hard floor and the space actually available.
 *  Pure — the drag handler owns no policy of its own. */
export function clampPaneWidth(proposed: number, containerWidth: number, min = PANE_MIN_PX): number {
  const ceiling = Math.max(min, containerWidth - PANE_RIGHT_MIN_PX);
  return Math.round(Math.min(Math.max(proposed, min), ceiling));
}

type Widths = Partial<Record<PaneKey, number>>;

function read(): Widths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (typeof raw !== "string") return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Widths = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // A stored width that is not a sane number is DROPPED rather than used: a corrupted entry
      // would otherwise render a screen with an unusable pane and no obvious way back.
      if (k in PANE_DEFAULTS && typeof v === "number" && Number.isFinite(v) && v >= paneMinWidth(k as PaneKey)) {
        out[k as PaneKey] = Math.round(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

let widths: Widths = read();
const listeners = new Set<() => void>();

function emit(): void { for (const fn of listeners) fn(); }

function persist(): void {
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch { /* a full/disabled localStorage must not break the drag itself */ }
}

/** The width to render for `key` — the operator's, or the shipped default. */
export function paneWidth(key: PaneKey): number {
  return widths[key] ?? PANE_DEFAULTS[key];
}

export function setPaneWidth(key: PaneKey, px: number): void {
  const next = Math.round(px);
  if (widths[key] === next) return;
  widths = { ...widths, [key]: next };
  persist();
  emit();
}

/** Back to the shipped default for ONE pane — what double-clicking its divider does, the way a
 *  window edge behaves. Deletes the override rather than writing the default as a value, so a later
 *  change to PANE_DEFAULTS reaches a pane nobody deliberately sized. */
export function resetPaneWidth(key: PaneKey): void {
  if (widths[key] === undefined) return;
  const next = { ...widths };
  delete next[key];
  widths = next;
  persist();
  emit();
}

/** Back to the shipped layout, every screen at once. This is the escape hatch that makes dragging
 *  safe to try: an operator who has made a mess of one screen should not have to find and fix each
 *  pane by hand. */
export function resetPaneWidths(): void {
  if (Object.keys(widths).length === 0) return;
  widths = {};
  persist();
  emit();
}

/** True when anything has been dragged — the settings button says so rather than offering a reset
 *  that would do nothing. */
export function hasCustomPaneWidths(): boolean {
  return Object.keys(widths).length > 0;
}

export function subscribePanes(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam: drop in-memory state and re-read storage. */
export function __resetPaneStateForTests(): void {
  widths = read();
  emit();
}
