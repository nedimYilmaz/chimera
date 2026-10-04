// HUMAN-TURN-COLOR — the accent your own transcript turns are drawn in, chosen by the operator.
//
// Same shape as panes.ts (module store + localStorage + subscribe), for the same reason: it is a
// per-operator display preference, not engine state, so it must not take a daemon round trip and
// must survive a reload without one.
//
// PRESETS RATHER THAN A FREE COLOUR PICKER. The value is painted on a dark surface as a 3px rule
// and a small-caps header, so a legibility floor matters more here than total freedom — an
// arbitrary #101014 would make your own turns HARDER to find, which is the exact bug this whole
// treatment exists to fix.

const STORAGE_KEY = "chimera.appearance.v1";

export type UserTurnPreset = { id: string; label: string; cssVar: string };

/** The palette itself lives in tokens.css — this is a list of ids and the vars they name, so the
 *  app stays token-only and a STORED preference can never put an arbitrary value into a CSS
 *  property (it is looked up here, never interpolated).
 *  Green first: distinct from --accent (the agent's lavender) and from --info (mail delivered from
 *  another agent), both of which already mean something else in this transcript. */
export const USER_TURN_PRESETS: readonly UserTurnPreset[] = [
  { id: "green", label: "green", cssVar: "--user-turn-green" },
  { id: "teal", label: "teal", cssVar: "--user-turn-teal" },
  { id: "amber", label: "amber", cssVar: "--user-turn-amber" },
  { id: "pink", label: "pink", cssVar: "--user-turn-pink" },
  { id: "blue", label: "blue", cssVar: "--user-turn-blue" },
];

export const USER_TURN_DEFAULT = USER_TURN_PRESETS[0]!.id;

/** The `var(--…)` a preset id resolves to, for both the document property and the settings
 *  swatch. Unknown id falls back to the default rather than emitting an invalid value. */
export function userTurnCssValue(id: string): string {
  const preset = USER_TURN_PRESETS.find((p) => p.id === id) ?? USER_TURN_PRESETS[0]!;
  return `var(${preset.cssVar})`;
}

/** The CSS custom property the transcript reads. Set on <html>, so a change repaints every turn
 *  already on screen without re-rendering the transcript. */
export const USER_TURN_VAR = "--user-turn";

const listeners = new Set<() => void>();
let choice = read();

function read(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (typeof raw !== "string") return USER_TURN_DEFAULT;
    const parsed = JSON.parse(raw) as unknown;
    const v = (parsed as { userTurn?: unknown } | null)?.userTurn;
    // Only an id we ship. An unknown one is far more likely a corrupted entry than a considered
    // choice, and taking it on trust is how a stored string reaches a CSS property.
    return USER_TURN_PRESETS.some((p) => p.id === v) ? (v as string) : USER_TURN_DEFAULT;
  } catch {
    return USER_TURN_DEFAULT;
  }
}

/** The selected PRESET ID (not a colour). */
export function userTurnColor(): string { return choice; }

export function setUserTurnColor(next: string): void {
  if (!USER_TURN_PRESETS.some((p) => p.id === next) || next === choice) return;
  choice = next;
  try {
    if (next === USER_TURN_DEFAULT) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ userTurn: next }));
  } catch { /* a full/disabled localStorage must not break the choice for this session */ }
  for (const fn of listeners) fn();
}

export function subscribeAppearance(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Push the current value onto the document. Idempotent; safe with no DOM (tests, SSR-ish). */
export function applyAppearance(): void {
  if (typeof document === "undefined") return;
  document.documentElement?.style?.setProperty(USER_TURN_VAR, userTurnCssValue(choice));
}
