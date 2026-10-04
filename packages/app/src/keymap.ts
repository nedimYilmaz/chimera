// W3 — the ONE keyboard table (PLAN-TAURI §4): every chord → action id, per
// scope. The root useHotkeys hook, the Footer, the PanelFooter hints and the
// future HelpScreen all render/dispatch FROM this table (single source, like
// the TUI's SHORTCUTS). W4 extends this same table.
//
// This module stays import-safe for pure unit tests: it never imports the app
// store (the hook receives it), only react + ui-state types.
import { useEffect, useSyncExternalStore } from "react";
import { keyboardPreferences, shortcutRows, sequenceSuffix } from "./state/keyboardPreferences";
import { isOnboardingGated, TAB_ORDER, type UiStore } from "@chimera/ui-state";
import { buildAgentRows, visibleAgentIds } from "./state/selectors";

// W7: "projects" joined the scope union when its tab went live (rows.projects.ts)
// — the one engine-side word that tab activation needs, mirroring the App.tsx
// screen-switch line (everything else W7 ships lives in its own files).
// KEYMAP-REDESIGN: "settings" joined the union so provider add/test/remove
// (previously ad hoc SettingsScreen listeners) could move into the shared
// table (rule 8 of the redesign brief).
export type KeyScope = "global" | "agents" | "projects" | "teams" | "queues" | "events" | "memory" | "settings" | "roles";

// Logical action catalog. Desktop dispatch uses leader sequences derived by
// shortcutRows; platform modifiers never register operating-system global shortcuts.
// Keep native editing and Tab focus navigation available on every screen.

export type KeymapRow = {
  chord: string;   // normalized: "ctrl+f", "shift+tab", "up", "1", "?"
  action: string;  // action id, resolved via the handler registry or the built-in store dispatch
  scope: KeyScope; // "global" applies everywhere; a tab scope only while that tab is active
  label: string;   // human hint the Footer/PanelFooter/HelpScreen render
  when?: string;   // optional condition tag (W4: e.g. "pendingPermission")
  // Declared-but-UNBOUND (review finding 12): the row exists so the footers
  // render its chord/label from the ONE table, but resolveChord skips it — no
  // handler ships until its W4 surface lands, and an unbound chord must not
  // swallow the browser default (preventDefault) for nothing.
  unbound?: boolean;
};

// The row declarations are split per OWNER so parallel workstreams never edit
// this file together: rows.tabs/rows.coord belong to the coordination-screens
// workstream, rows.global/rows.agents to the composer/overlays workstream.
// This file keeps the engine (chord parsing, registry, dispatch) plus the
// composed table. Import placement (below the KeymapRow type they reference)
// keeps the type export hoisting-safe for the row modules' own imports.
import { TAB_ROWS } from "./keymap/rows.tabs";
import { GLOBAL_ROWS } from "./keymap/rows.global";
import { AGENT_ROWS } from "./keymap/rows.agents";
import { COORD_ROWS } from "./keymap/rows.coord";
import { SYSTEM_ROWS } from "./keymap/rows.system";
import { PROJECTS_ROWS } from "./keymap/rows.projects";
import { HOST_ROWS } from "./keymap/rows.host";
import { SETTINGS_ROWS } from "./keymap/rows.settings";
import { VOICE_ROWS } from "./keymap/rows.voice";
import { ROLES_ROWS } from "./keymap/rows.roles";

export const KEYMAP: readonly KeymapRow[] = [
  ...TAB_ROWS,
  ...GLOBAL_ROWS,
  ...AGENT_ROWS,
  ...COORD_ROWS,
  ...SYSTEM_ROWS,
  ...PROJECTS_ROWS,
  ...HOST_ROWS,
  ...SETTINGS_ROWS,
  ...VOICE_ROWS,
  ...ROLES_ROWS,
  { chord: "leader+c", action: "system.compact", scope: "agents", label: "compact context" },
  { chord: "leader+shift+e", action: "system.effort", scope: "agents", label: "reasoning effort" },
  { chord: "leader+shift+a", action: "system.accountSwitch", scope: "agents", label: "switch account" },
  { chord: "leader+shift+d", action: "system.remoteControl", scope: "agents", label: "remote control" },
  { chord: "leader+shift+z", action: "system.result", scope: "agents", label: "last result" },
];

/** Footer/PanelFooter lookups: the label for a chord (first match wins). */
export function keyLabel(chord: string): string | undefined {
  return KEYMAP.find((r) => r.chord === chord)?.label;
}

// ---------------------------------------------------------------------------
// chord normalization
// ---------------------------------------------------------------------------

const KEY_ALIASES: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "esc",
  Tab: "tab",
  " ": "space",
  Enter: "enter",
};

export type ChordEvent = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** True on macOS — sniffs navigator (userAgentData.platform first, then the
 * deprecated .platform, then .userAgent) so chordOf/displayChord resolve the
 * SAME "which physical key is mod" answer the real OS would give. Accepts an
 * override for tests (chordOf/displayChord's own mac? param) instead of
 * mutable global state. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined =
  typeof navigator !== "undefined" ? navigator : undefined): boolean {
  const s = `${nav?.userAgentData?.platform ?? ""} ${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /mac/i.test(s);
}

/** KeyboardEvent → normalized chord string ("mod+e", "mod+shift+x", "up",
 * "?"). "mod" is resolved to ONE physical modifier per platform — metaKey on
 * macOS, ctrlKey elsewhere (isMacPlatform, or the `mac` override for tests) —
 * so the OTHER modifier never produces "mod" (pressing Ctrl+E on a Mac does
 * nothing; it does not accidentally fire a Cmd+E binding). Shift is only
 * significant for non-printable keys (tab/arrows) — a printable key already
 * carries shift in ev.key ("?" itself). */
export function chordOf(ev: ChordEvent, mac: boolean = isMacPlatform()): string {
  const base = KEY_ALIASES[ev.key] ?? ev.key.toLowerCase();
  const parts: string[] = [];
  const modPressed = mac ? ev.metaKey : ev.ctrlKey;
  if (modPressed) parts.push("mod");
  else if (ev.ctrlKey || ev.metaKey) parts.push(ev.metaKey ? "meta" : "ctrl"); // wrong-platform modifier: never matches a "mod" row
  // A single Latin letter's shift state only changes its CASE ("r" → "R"),
  // which `base` just lowercased away — unlike a symbol key ("/" → "?") whose
  // shifted form is already a distinct character `base` preserves untouched.
  // Without this, mod+shift+<letter> (every DESTROY-tier chord: kill,
  // closeMain, checkpointRevert, dissolve, delete…) could never be produced
  // from a real keydown, since ev.key.length is 1 either way.
  const isPlainLetter = /^[a-zA-Z]$/.test(ev.key);
  if (ev.shiftKey && (ev.key.length > 1 || isPlainLetter)) parts.push("shift");
  if (ev.altKey) parts.push("alt");
  parts.push(base);
  return parts.join("+");
}

/** Render a chord token back to a platform-appropriate label for the Footer/
 * HelpScreen/hint strings — "mod+shift+x" → "⌘⇧x" on macOS, "Ctrl+Shift+x"
 * elsewhere. Only chords that actually contain the "mod" token get this
 * treatment (glyph-tight join on macOS); anything else (nav chords like
 * "up"/"alt+left", or a chord string outside this KEYMAP's own vocabulary)
 * passes through UNCHANGED — safe to call on every KEYMAP row without
 * mangling an unrelated one. */
export function formatPhysicalChord(chord: string, mac: boolean = isMacPlatform()): string {
  if (!chord.split("+").includes("mod")) return chord;
  const parts = chord.split("+").map((p) => {
    if (p === "mod") return mac ? "⌘" : "Ctrl";
    if (p === "shift") return mac ? "⇧" : "Shift";
    return p;
  });
  return mac ? parts.join("") : parts.join("+");
}

/** Display the actual desktop sequence, including hints supplied by older panels. */
export function displayChord(chord: string, mac: boolean = isMacPlatform()): string {
  if (chord.includes(" ")) return chord.split(" ").map(part => formatPhysicalChord(part, mac)).join(" → ");
  const source = KEYMAP.find(row => row.chord === chord);
  const suffix = source ? sequenceSuffix(source) : chord.startsWith("mod+") && chord !== "mod+f" ? chord.slice(4) : null;
  return suffix ? `${formatPhysicalChord(keyboardPreferences().leader, mac)} → ${formatPhysicalChord(suffix, mac)}` : formatPhysicalChord(chord, mac);
}
export function desktopKeymap(): KeymapRow[] { return shortcutRows(KEYMAP); }
export function actionChord(action: string): string { const row=desktopKeymap().find(r=>r.action===action); return row ? displayChord(row.chord) : "unbound"; }

/** "⌘" / "Ctrl" alone — for hint strings that splice just the modifier into
 * their own text (e.g. `` `${modLabel()}+e edit` ``). */
export function modLabel(mac: boolean = isMacPlatform()): string {
  return mac ? "⌘" : "Ctrl";
}

/** Find the active row for a chord under the current tab (global rows always
 * apply; tab-scoped rows only on their tab). Unbound rows (label-only W4
 * declarations) never resolve. Pure — unit-testable. */
export function resolveChord(chord: string, activeTab: string): KeymapRow | undefined {
  const applicable = KEYMAP.filter((r) => !r.unbound && r.chord === chord && (r.scope === "global" || r.scope === activeTab));
  // W4 `when` tags were decorative (footer hints only). VOICE-STOP makes them a real gate for the
  // tags that register a predicate: a gated row WINS its chord while its condition holds (that's
  // how `esc` can mean "stop speaking" only while the app is speaking) and is invisible otherwise.
  // Tags with no registered predicate keep their old, purely decorative meaning — so
  // pendingPermission/checkpointVisible/hostTools rows resolve exactly as before.
  return applicable.find((r) => r.when !== undefined && isWhenActive(r.when))
    ?? applicable.find((r) => r.when === undefined || !whenPredicates.has(r.when));
}

// ---------------------------------------------------------------------------
// `when` predicate registry — a mounted surface declares when its gated rows
// are live (same shape as registerActionHandler: last registration wins,
// dispose restores). Kept here so resolveChord stays pure w.r.t. React.
// ---------------------------------------------------------------------------

const whenPredicates = new Map<string, Array<() => boolean>>();

export function registerWhen(tag: string, fn: () => boolean): () => void {
  const stack = whenPredicates.get(tag) ?? [];
  stack.push(fn);
  whenPredicates.set(tag, stack);
  return () => {
    const cur = whenPredicates.get(tag);
    if (!cur) return;
    const i = cur.indexOf(fn);
    if (i >= 0) cur.splice(i, 1);
    if (cur.length === 0) whenPredicates.delete(tag);
  };
}

/** True when SOME registered predicate for the tag currently holds. */
export function isWhenActive(tag: string): boolean {
  const stack = whenPredicates.get(tag);
  if (!stack || stack.length === 0) return false;
  return stack.some((fn) => {
    try { return fn(); } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// action handler registry (screen-local behaviors: view toggles, flow-pane
// cursor…). Last registration wins; disposing restores the previous handler —
// so a mounted FlowPane can shadow the AgentsScreen's list handlers.
// ---------------------------------------------------------------------------

const registry = new Map<string, Array<() => void>>();

export function registerActionHandler(action: string, fn: () => void): () => void {
  const stack = registry.get(action) ?? [];
  stack.push(fn);
  registry.set(action, stack);
  return () => {
    const cur = registry.get(action);
    if (!cur) return;
    const i = cur.indexOf(fn);
    if (i >= 0) cur.splice(i, 1);
    if (cur.length === 0) registry.delete(action);
  };
}

/** True when a mounted screen/overlay currently owns this contextual action. */
export function hasActionHandler(action: string): boolean {
  return (registry.get(action)?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// built-in store dispatches (everything not claimed by a screen registration)
// ---------------------------------------------------------------------------

/** Dispatch an action id against the store. Returns true when handled. The
 * agents-list defaults step over the FOLD-AWARE visible order (selectors) so
 * a selection can never land on a hidden row. */
export function dispatchAction(action: string, store: UiStore): boolean {
  const state = store.getState();
  if (action.startsWith("tab.")) {
    const name = action.slice(4);
    // ONBOARDING-GATE R2: zero CONFIRMED accounts — every tab action is
    // swallowed (true = handled, no chord falls through to typing/etc) except
    // landing back on "agents", where WelcomeScreen's onboarding block lives.
    if (isOnboardingGated(state) && name !== "agents") return true;
    if (name === "next") { store.dispatch({ type: "tabNext" }); return true; }
    if (name === "prev") { store.dispatch({ type: "tabPrev" }); return true; }
    const tab = TAB_ORDER.find((t) => t === name);
    if (tab) { store.dispatch({ type: "selectTab", tab }); return true; }
    return false;
  }
  switch (action) {
    case "agents.up":
    case "agents.down": {
      const visible = visibleAgentIds(state);
      if (visible.length === 0) return true;
      const cur = state.selectedAgentId ? Math.max(0, visible.indexOf(state.selectedAgentId)) : 0;
      const next = Math.min(visible.length - 1, Math.max(0, cur + (action === "agents.down" ? 1 : -1)));
      store.dispatch({ type: "selectAgent", agentId: visible[next]! });
      return true;
    }
    case "agents.foldLeft": {
      // P3-T3: team-group fold is retired (team is a badge, not a foldable
      // header) — only the per-agent SUBTREE fold remains.
      const sel = state.selectedAgentId;
      if (!sel) return true;
      const row = buildAgentRows(state).find((r) => r.agentId === sel);
      if (row && row.collapsible && !row.collapsed) {
        store.dispatch({ type: "collapse", agentId: sel }); // fold the selected subtree
      }
      return true;
    }
    case "agents.foldRight": {
      const sel = state.selectedAgentId;
      if (!sel) return true;
      const row = buildAgentRows(state).find((r) => r.agentId === sel);
      if (row && row.collapsed) {
        store.dispatch({ type: "collapse", agentId: sel }); // unfold the selected subtree
      }
      return true;
    }
    case "help.toggle":     // W3 stub — HelpScreen lands with W5/W6
      store.dispatch({ type: "helpOpen", open: !state.helpOpen });
      return true;
    case "global.escape":   // W4: on the agents tab this is SHADOWED by the
      // AgentsScreen-registered close-priority chain (help → toolDetail →
      // slash → target menu → spawn → question later → permission later →
      // clear composer → drop queued → interrupt; the exact order + rationale
      // live on commands.agents.ts's resolveEscTier). This built-in remains
      // the non-agents fallback.
      if (state.helpOpen) store.dispatch({ type: "helpOpen", open: false });
      return true;
    default:
      return false;
  }
}

/** Resolve + run: screen registration wins, else the built-in dispatch. */
export function runAction(action: string, store: UiStore): boolean {
  const stack = registry.get(action);
  if (stack && stack.length > 0) {
    stack[stack.length - 1]!();
    return true;
  }
  return dispatchAction(action, store);
}

/** Should a keydown be ignored because an editable element owns the keys? */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** BUG A: chords the browser's native editing owns while the Composer has
 * focus — select-all / copy / paste / cut / undo / redo. Composer.onKeyDown
 * must never forward these to resolveChord (else Cmd/Ctrl+A/Z would run an
 * app action instead of the native edit — moot for accounts/mcpPalette today
 * since KEYMAP-REDESIGN moved both off the agents scope entirely, but this
 * stays a defensive blocklist regardless of whatever's currently bound).
 * Chords outside the composer are unaffected — mod+a/mod+z still resolve
 * there (on the scopes that bind them). */
export const RESERVED_EDITING_KEYS = new Set(["a", "c", "v", "x", "z"]);

/** Pure decision for Composer.onKeyDown's ctrl/meta bridge to the ONE keymap
 * table: forward a single-character ctrl/meta chord UNLESS it's a native
 * editing chord (BUG A, RESERVED_EDITING_KEYS) or mod+y/mod+j (perm.allow/
 * perm.deny — the permission capture-phase handler owns those; "j" replaced
 * "n" here when KEYMAP-REDESIGN moved perm.deny off ctrl+n, "n" being
 * OS-reserved). */
export function shouldForwardComposerChord(ev: Pick<ChordEvent, "ctrlKey" | "metaKey" | "key">): boolean {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key.length !== 1) return false;
  const key = ev.key.toLowerCase();
  if (key === "y" || key === "j") return false;
  return !RESERVED_EDITING_KEYS.has(key);
}

/** The text an editable target currently holds ("" when empty) — input/textarea
 * value, else the contentEditable text. Used by the B1 tab-nav exception. */
export function editableValue(t: EventTarget | null): string {
  const el = t as (HTMLInputElement | HTMLTextAreaElement | HTMLElement) | null;
  if (!el) return "";
  const val = (el as HTMLInputElement | HTMLTextAreaElement).value;
  if (typeof val === "string") return val;
  return el.textContent ?? "";
}

/** The root useHotkeys gate, pulled out as a pure/unit-testable function: does
 * this keydown reach resolveChord, or does the editable target keep it?
 *
 * TYPING-OWNS-THE-KEYBOARD: an editable target keeps EVERY key. No exceptions.
 *
 * There used to be one (B1): a bare 1-7 in an editable field that was still EMPTY navigated the
 * tab strip, on a "bare y/n while empty" precedent from the TUI. It reads as a harmless edge case
 * and is the opposite — the first character typed into an empty field is the single most common
 * keystroke a field ever receives, so the exception fired precisely when someone started typing.
 * Reported as "I press 1 in an input and the tab switches". The Composer had already been carved
 * out of it in a separate fix, which is itself the evidence: the exception was producing this bug
 * and was being patched one field at a time.
 *
 * Nothing text-related is lost by this, because everything text-related is the browser's, not
 * ours. Chords the native webview owns (reload/find/print/zoom, BROWSER_RESERVED) are handled
 * BEFORE this gate in handleHotkey and are unaffected. Modifier chords were already blocked here
 * for editable targets — the empty-field digit was the only key that leaked through. */
export function shouldResolveChordFor(target: EventTarget | null, chord: string): boolean {
  // TRANSCRIPT-SEARCH: a narrow carve-out, kept honest by being an explicit list rather than a
  // rule. The gate above exists because app chords were firing while someone typed — pressing "1"
  // mid-message switched tabs. Find is the exception the original complaint already named ("no
  // shortcut while typing in an input, unless it is text-related"): every editor opens find from
  // inside the text you are editing, and having to click away first is the annoyance, not the fix.
  if (EDITABLE_PASSTHROUGH.has(chord)) return true;
  return !isEditableTarget(target);
}

/** Chords that reach the app even while an input has focus. Add to this only for something that is
 *  ABOUT the text — anything else belongs behind the gate. */
export const EDITABLE_PASSTHROUGH: ReadonlySet<string> = new Set(["mod+f"]);

/** Chords WebView2 (Windows) / webkit2gtk (Linux) act on as native browser
 * accelerators — reload, find-on-page, print, zoom — whenever nothing in
 * KEYMAP claims them first (confirmed against WebView2's
 * AreBrowserAcceleratorKeysEnabled doc, which lists exactly these as
 * script-preventable; devtools/back-forward are its own set and NOT included
 * here — see the audit table in the KEYMAP-REDESIGN follow-up notes).
 * macOS/WKWebView has no equivalent default handler (no custom Tauri menu,
 * no devtools/reload accelerator wired in tauri.conf.json), so swallowing
 * these there is a harmless no-op, not a platform-specific branch.
 * "mod+=" / "mod++" cover both the unshifted and shifted zoom-in key across
 * keyboard layouts. */
export const BROWSER_RESERVED: ReadonlySet<string> = new Set([
  "mod+r", "mod+shift+r", "f5",
  "mod+f", "mod+p",
  "mod+=", "mod++", "mod+-", "mod+0",
]);

/** A keydown carrying just what handleHotkey needs — satisfied by a real
 * KeyboardEvent, so useHotkeys passes one straight through. */
export type HotkeyEvent = ChordEvent & {
  target: EventTarget | null;
  repeat: boolean;
  preventDefault: () => void;
};

/** The root hotkey decision + dispatch, pulled out as a pure/unit-testable
 * function (shouldResolveChordFor's precedent) since this package's vitest
 * config is node-env/no-DOM — a mounted `window.addEventListener` listener
 * can't be driven from a test here. */
export function handleHotkey(ev: HotkeyEvent, store: UiStore): void {
  if (ev.repeat && ev.key === "Tab") return; // holding tab shouldn't spin the tab strip
  const chord = chordOf(ev);
  // VOICE R5 (design doc §6 "Repeat guard"): holding ⌥Space auto-repeats keydown — without this
  // it would toggle conversation mode rapidly on/off for as long as the key is held.
  if (ev.repeat && chord === "alt+space") return;
  // BROWSER_RESERVED swallow fires BEFORE the editable-target gate below: it
  // must win even while the Composer textarea (or another input) owns focus
  // — those carve themselves out of the app-action path past this point, but
  // none of them stopPropagation() a reload/find/print/zoom chord, so this
  // still sees every one of them on its way to the native webview handler.
  const reserved = BROWSER_RESERVED.has(chord);
  if (reserved) ev.preventDefault();
  // B1: an editable target normally owns every key EXCEPT a bare tab-nav
  // digit while it is EMPTY (TUI-001 precedent) — then the digit navigates
  // tabs; with any content the field keeps it (composer typing of digits
  // mid-message is untouched). BUG B narrows this: the Composer opts out
  // of the exception entirely (shouldResolveChordFor).
  const row = resolveChord(chord, store.getState().activeTab);
  if (!row) return;
  // An ACTIVELY-gated row bypasses the editable-target gate on purpose: while the app is talking
  // at the operator, Esc must stop it even with the composer focused (that focus is exactly where
  // they are). Ungated rows keep the old rule.
  const gated = row.when !== undefined && isWhenActive(row.when);
  if (!gated && !shouldResolveChordFor(ev.target, chord)) return;
  if (!reserved) ev.preventDefault();
  runAction(row.action, store);
}

type SequenceState = { pending: boolean; until: number; tab: string; };
let sequence: SequenceState = { pending: false, until: 0, tab: "" };
let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
const sequenceListeners = new Set<() => void>();
export function cancelKeySequence(): void {
  clearTimeout(sequenceTimer);
  sequence = { pending: false, until: 0, tab: "" };
  for (const fn of sequenceListeners) fn();
}
export function useKeySequence(): boolean {
  return useSyncExternalStore(fn => { sequenceListeners.add(fn); return () => { sequenceListeners.delete(fn); }; }, () => sequence.pending);
}
export type DesktopKeyEvent = HotkeyEvent & { isComposing?: boolean; defaultPrevented?: boolean; stopImmediatePropagation?: () => void };
/** True means app handling finished; native edit defaults may still run. */
export function handleDesktopKey(ev: DesktopKeyEvent, store: UiStore, now = Date.now()): boolean {
  if (ev.isComposing || ev.defaultPrevented || ev.key === "Process" || (ev.ctrlKey && ev.metaKey)) return false;
  const chord = chordOf(ev);
  const tab = store.getState().activeTab;
  const consume = () => { ev.preventDefault(); ev.stopImmediatePropagation?.(); };
  if (sequence.pending && (now > sequence.until || sequence.tab !== tab)) cancelKeySequence();
  if (sequence.pending) {
    if (["Control", "Meta", "Shift", "Alt"].includes(ev.key)) return true;
    if (ev.repeat) { consume(); return true; }
    const suffix = chord.replace(/^mod\+/, "");
    const row = desktopKeymap().find(r => r.chord === `${keyboardPreferences().leader} ${suffix}` && (r.scope === "global" || r.scope === tab));
    consume(); cancelKeySequence();
    if (row) {
      if (row.action.startsWith("perm.") && store.getState().pendingPermissions.length === 0) return true;
      runAction(row.action, store);
    }
    return true;
  }
  if (chord === keyboardPreferences().leader) {
    consume(); if (ev.repeat) return true;
    sequence = { pending: true, until: now + 3000, tab };
    sequenceTimer = setTimeout(cancelKeySequence, 3000);
    for (const fn of sequenceListeners) fn();
    return true;
  }
  // Normal Tab moves focus. Copy/cut/paste/undo/redo and OS shortcuts retain
  // their native meanings even when old overlay listeners are mounted.
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    if (chord === "mod+f" && tab === "agents") { consume(); runAction("transcript.search", store); return true; }
    if (((ev.ctrlKey || ev.metaKey) && /^[a-z]$/i.test(ev.key)) || chord === "alt+space") {
      ev.stopImmediatePropagation?.(); return true;
    }
    return false;
  }
  if (ev.key === "Tab") return false;
  return false;
}
let activeKeyboardStore: UiStore | null = null;
// Install before component effects: child dialogs also have capture listeners.
// The guard remains inert until useHotkeys supplies the active app store.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", ev => { if (activeKeyboardStore) handleDesktopKey(ev, activeKeyboardStore); }, { capture: true });
  window.addEventListener("blur", cancelKeySequence);
}
export function useHotkeys(store: UiStore): void {
  useEffect(() => {
    activeKeyboardStore = store;
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented || ev.isComposing || ev.key === "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      handleHotkey(ev, store);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); if (activeKeyboardStore === store) activeKeyboardStore = null; cancelKeySequence(); };
  }, [store]);
}
