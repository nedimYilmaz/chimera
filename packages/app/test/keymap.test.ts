import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, reduce, type Action, type AgentView, type UiState, type UiStore } from "@chimera/ui-state";
import {
  BROWSER_RESERVED,
  chordOf,
  dispatchAction,
  displayChord,
  handleHotkey,
  hasActionHandler,
  isEditableTarget,
  isMacPlatform,
  KEYMAP,
  type KeyScope,
  keyLabel,
  registerActionHandler,
  RESERVED_EDITING_KEYS,
  resolveChord,
  runAction,
  shouldForwardComposerChord,
  shouldResolveChordFor,
} from "../src/keymap";
import { buildPaletteCatalog } from "../src/state/commands.system";

// A tiny in-memory store over the REAL reducer, so dispatch-table tests
// exercise the exact projection the app runs.
function makeStore(seed?: Partial<UiState>): UiStore & { state: UiState } {
  let state: UiState = { ...initialState, ...seed };
  const store = {
    getState: () => state,
    dispatch: (a: Action) => { state = reduce(state, a); },
    subscribe: () => () => {},
    connectAndLoad: () => Promise.resolve(),
    get state() { return state; },
  };
  return store;
}

function fleet(): Partial<UiState> {
  const mk = (id: string, extra: Partial<AgentView>): AgentView => ({ ...emptyAgent(id), state: "running", ...extra });
  return {
    agents: {
      main: mk("main", { conductor: true }),
      w1: mk("w1", { membership: { team: "tui-crew", role: "dev" }, treeId: "w1", depth: 0 }),
      w2: mk("w2", { membership: { team: "tui-crew", role: "dev" }, treeId: "w2", depth: 0 }),
      sh: mk("sh", { treeId: "w2", depth: 1, shadow: true, label: "code-review" }),
    },
    agentOrder: ["main", "w1", "w2", "sh"],
    teams: { available: true, items: [{ name: "tui-crew", createdBy: "main" }] },
    selectedAgentId: "main",
  };
}

describe("KEYMAP table", () => {
  it("has the W3 rows: 1-5, tab cycle, help, esc, agents nav/fold/view", () => {
    const chords = KEYMAP.map((r) => `${r.scope}:${r.chord}`);
    for (const expected of [
      "global:1", "global:2", "global:3", "global:4", "global:5",
      "global:tab", "global:shift+tab", "global:?", "global:esc",
      "agents:up", "agents:down", "agents:left", "agents:right", "agents:mod+r",
    ]) expect(chords).toContain(expected);
  });
  it("never maps one chord twice within an applicable scope pair", () => {
    for (const scope of ["agents", "teams", "queues", "events", "memory", "projects"] as const) {
      // Mirror resolveChord's own `!r.unbound` guard: overlay-owned unbound
      // global chords (host-tools `p`/`space`, F12 `v`) never resolve through
      // the base table, so a bound screen chord of the same key (events/queues
      // `p`) is not a collision.
      // VOICE-STOP: a `when`-gated row (esc → voice.stopSpeaking) deliberately SHADOWS its
      // ungated twin while the gate is active — resolveChord prefers it, then falls back — so
      // it is not a collision either.
      const applicable = KEYMAP
        .filter((r) => !r.unbound && r.when === undefined && (r.scope === "global" || r.scope === scope))
        .map((r) => r.chord);
      expect(new Set(applicable).size).toBe(applicable.length);
    }
  });
  it("labels every row (the Footer/Help render from these)", () => {
    for (const r of KEYMAP) expect(r.label.length).toBeGreaterThan(0);
    expect(keyLabel("tab")).toBe("tabs");
    expect(keyLabel("?")).toBe("help");
  });
  it("keeps the footer chords in the ONE table (finding 12) — W4 has bound them", () => {
    for (const [chord, label] of [
      ["mod+p", "permissions"],
      ["/", "commands"],
      ["mod+o", "spawn"],
      ["mod+shift+k", "kill"],
    ] as const) {
      const row = KEYMAP.find((r) => r.chord === chord);
      expect(row?.label).toBe(label);          // the footers render this
      expect(row?.unbound).toBeUndefined();    // W4 landed the handlers — bound rows now
    }
  });
  it("declares exactly the intended unbound rows (W8 card chords)", () => {
    const unbound = KEYMAP.filter((r) => r.unbound);
    // W8's space/p: the host-tools card binds them via its own capture-phase
    // listener while open (rows.host.ts documents why), so the rows stay
    // label-only here and must never resolve/preventDefault. (W7 bound the
    // former "2:tab.projects" slot — no longer in this set.)
    // F12's `v`: TranscriptPanel's capture-phase handler owns it (gated on an
    // in-pane selection so typing 'v' in the composer isn't hijacked), so the
    // row is label-only for the "v raw" footer/help hint and must not resolve.
    // IN-APP-TERMINAL Task 6's mod+j: already fully allocated by perm.deny
    // (mod+j, when a permission is pending) — TerminalDock's own capture-phase
    // listener owns the live binding, so this row is label-only too (rows.agents.ts).
    expect(unbound.map((r) => `${r.chord}:${r.action}`)).toEqual([
      "v:agents.rawToggle",
      "mod+j:terminal.toggle",
      "space:host.cycle",
      "p:host.profileEdit",
    ]);
    expect(resolveChord("space", "agents")).toBeUndefined();
    // KEYMAP-REDESIGN: queues.pin/events.pin promoted off bare 'p' onto
    // mod+p (rule 3: "pin" is a mutate example) — bare 'p' now only exists as
    // the unbound host.profileEdit row, so it never resolves anywhere.
    expect(resolveChord("p", "teams")).toBeUndefined();
    expect(resolveChord("p", "events")).toBeUndefined();
    expect(resolveChord("p", "queues")).toBeUndefined();
    expect(resolveChord("mod+p", "events")?.action).toBe("events.pin");
    expect(resolveChord("mod+p", "queues")?.action).toBe("queues.pin");
    expect(resolveChord("v", "agents")).toBeUndefined();
  });
});

// KEYMAP-REDESIGN — the documented standard at the top of keymap.ts: platform
// modifier resolution, the reserved-combo ban, and the destroy tier.
describe("KEYMAP-REDESIGN", () => {
  it("binds mod+d to model on the agents scope, palette-reachable", () => {
    const row = resolveChord("mod+d", "agents");
    expect(row?.action).toBe("system.model");
    expect(row?.label).toBe("model");
    expect(row?.unbound).toBeUndefined();

    const catalog = buildPaletteCatalog(KEYMAP, []);
    const entry = catalog.find((e) => e.id === "system.model");
    expect(entry?.keyHint).toBe("mod+d");
    expect(entry?.description).toContain("agents");
  });
  it("restores effort, account, remote and result actions through leader sequences", () => {
    for (const action of ["system.effort", "system.accountSwitch", "system.remoteControl", "system.result"]) {
      expect(KEYMAP.some(r => r.action === action && r.chord.startsWith("leader+"))).toBe(true);
    }
  });
  it("no two rows in the SAME scope share a chord (dedicated per-scope sweep)", () => {
    const scopes: readonly KeyScope[] = ["global", "agents", "teams", "queues", "events", "memory", "projects", "settings"];
    for (const scope of scopes) {
      // VOICE-STOP: `when`-gated rows are excluded — they deliberately SHADOW an ungated row on
      // the same chord while their condition holds (esc = "stop speaking" only while speaking),
      // and resolveChord picks the gated one first, so this is a shadow, not an ambiguity.
      const applicable = KEYMAP.filter((r) => !r.unbound && r.when === undefined && (r.scope === "global" || r.scope === scope)).map((r) => r.chord);
      const dupes = applicable.filter((c, i) => applicable.indexOf(c) !== i);
      expect(dupes, `duplicate chord(s) reachable on scope "${scope}": ${dupes.join(", ")}`).toEqual([]);
    }
  });
  it("never binds a plain mod+letter chord on the OS-reserved list", () => {
    // TRANSCRIPT-SEARCH: "f" left this list, with a reason rather than an exception. The rule is
    // about not STEALING a chord whose meaning belongs to the OS or the webview — and mod+f's
    // meaning is "find in this thing", which every editor and browser implements itself. chimera
    // already swallows it via BROWSER_RESERVED so the webview's own find-on-page can never open
    // over the app; before this it was swallowed and then went nowhere, which is the worst of both.
    // The others stay: mod+w/q/c/v really do belong to the OS, and rebinding them breaks muscle
    // memory that has nothing to do with this app.
    const RESERVED = new Set(["w", "x", "z", "v", "c", "q", "t", "n", "a", "s", "m", "h"]);
    const violations = KEYMAP.filter((r) => {
      const m = /^mod\+([a-z])$/.exec(r.chord);
      return m !== null && RESERVED.has(m[1]!);
    });
    expect(violations.map((r) => `${r.scope}:${r.chord}`)).toEqual([]);
  });
  it("mod+f is bound, AND still swallowed before the webview sees it", () => {
    // Both halves matter: binding it without the swallow would open the app's search behind the
    // webview's own find-on-page.
    expect(KEYMAP.find((r) => r.chord === "mod+f")?.action).toBe("transcript.search");
    expect(BROWSER_RESERVED.has("mod+f")).toBe(true);
  });
  it("mod resolves to metaKey on macOS and ctrlKey elsewhere — never both", () => {
    const evCtrl = { key: "d", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    const evMeta = { key: "d", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false };
    // non-mac: ctrl is mod, meta is not.
    expect(chordOf(evCtrl, false)).toBe("mod+d");
    expect(chordOf(evMeta, false)).not.toBe("mod+d");
    // macOS: meta is mod, ctrl is not.
    expect(chordOf(evMeta, true)).toBe("mod+d");
    expect(chordOf(evCtrl, true)).not.toBe("mod+d");
    // the wrong-platform modifier never resolves a "mod" row.
    expect(resolveChord(chordOf(evCtrl, false), "agents")?.action).toBe("system.model");
    expect(resolveChord(chordOf(evCtrl, true), "agents")).toBeUndefined();
    expect(resolveChord(chordOf(evMeta, false), "agents")).toBeUndefined();
  });
  it("isMacPlatform reads the platform string, not just presence of any field", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe(false);
    // an explicitly-empty navigator-like object (no mac indicators) reads false —
    // NOT `isMacPlatform(undefined)`, which falls through to the real navigator
    // (whatever OS is actually running the test, e.g. this dev machine is a Mac).
    expect(isMacPlatform({})).toBe(false);
  });
  it("displayChord renders the platform label (HelpScreen/Footer source)", () => {
    expect(displayChord("mod+e", true)).toBe("⌘k → e");
    expect(displayChord("mod+e", false)).toBe("Ctrl+k → e");
    expect(displayChord("mod+shift+x", true)).toBe("⌘k → shift+x");
    expect(displayChord("mod+shift+x", false)).toBe("Ctrl+k → shift+x");
    expect(displayChord("up", true)).toBe("up"); // non-mod chords pass through
  });
  it("destroy-tier (mod+shift+letter) actions fire only with shift held", () => {
    for (const [action, chord] of [
      ["agents.kill", "mod+shift+k"],
      ["agents.closeMain", "mod+shift+w"],
      ["agents.checkpointRevert", "mod+shift+r"],
      ["teams.dissolve", "mod+shift+x"],
      ["memory.delete", "mod+shift+x"],
      ["projects.delete", "mod+shift+x"],
      ["settings.providerRemove", "mod+shift+x"],
    ] as const) {
      const row = KEYMAP.find((r) => r.action === action);
      expect(row?.chord, action).toBe(chord);
    }
  });
});

describe("chordOf / resolveChord / isEditableTarget", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("normalizes arrows, tab, esc and modifier order", () => {
    expect(chordOf(key("ArrowUp"))).toBe("up");
    expect(chordOf(key("Escape"))).toBe("esc");
    expect(chordOf(key("Tab", { shiftKey: true }))).toBe("shift+tab");
    // KEYMAP-REDESIGN: mod resolves to ONE physical modifier per platform —
    // ctrl on non-mac, meta on mac — never both (see the KEYMAP-REDESIGN
    // describe block above for the full parity coverage).
    expect(chordOf(key("f", { ctrlKey: true }), false)).toBe("mod+f");
    expect(chordOf(key("F", { metaKey: true }), true)).toBe("mod+f");
    expect(chordOf(key("?", { shiftKey: true }))).toBe("?");     // shift folded into printables
  });
  it("resolves mod+shift+<letter> from a REAL shift keypress (destroy-tier prerequisite)", () => {
    // A real Ctrl+Shift+R keydown reports key:"R" (case reflects shift even
    // with Ctrl held) — base() used to lowercase that away and the shift
    // token was gated on key.length>1, so every mod+shift+letter DESTROY
    // chord (kill, closeMain, checkpointRevert, dissolve, delete…) was
    // unreachable from an actual keypress before this fix.
    expect(chordOf(key("R", { ctrlKey: true, shiftKey: true }), false)).toBe("mod+shift+r");
    expect(chordOf(key("X", { metaKey: true, shiftKey: true }), true)).toBe("mod+shift+x");
    // unshifted still has no shift token
    expect(chordOf(key("r", { ctrlKey: true }), false)).toBe("mod+r");
  });
  it("scopes rows: each tab resolves its OWN up-row (W5: teams has one too)", () => {
    expect(resolveChord("up", "agents")?.action).toBe("agents.up");
    expect(resolveChord("up", "teams")?.action).toBe("teams.up");
    expect(resolveChord("up", "events")?.action).toBe("events.up"); // F01: events has a row cursor now
    expect(resolveChord("1", "memory")?.action).toBe("tab.agents");
  });
  it("skips editable targets", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

// KEYMAP-HARDEN: the pre-fix useHotkeys only called preventDefault on a
// MATCHED row — an unbound chord (or one whose active tab has no binding)
// fell straight through to WebView2/webkit2gtk's own reload/find/print/zoom
// handler. BROWSER_RESERVED + handleHotkey (the pulled-out onKeyDown body)
// close that leak independent of resolveChord/scope.
describe("BROWSER_RESERVED swallow (native reload/find/print/zoom leak)", () => {
  // ctrlKey AND metaKey both set so the chord resolves to "mod+…" regardless
  // of which physical key THIS test run's isMacPlatform() sniff picks (the
  // suite runs on whatever host it's built on — 657b64a's "env-fragile
  // tests" fix is the precedent for not hardcoding one platform here).
  const ev = (key: string, opts: { mod?: boolean; shiftKey?: boolean } = {}) => {
    let prevented = false;
    return {
      key, ctrlKey: !!opts.mod, metaKey: !!opts.mod, altKey: false, shiftKey: !!opts.shiftKey, repeat: false,
      target: null as EventTarget | null,
      preventDefault: () => { prevented = true; },
      get defaultPrevented() { return prevented; },
    };
  };

  it("swallows an UNBOUND reserved chord on a tab with no binding for it — no action runs", () => {
    const store = makeStore({ activeTab: "teams" });
    const spawnBefore = store.state;
    const e = ev("r", { mod: true }); // mod+r: unbound on "teams" (only agents/queues/memory/projects bind it)
    handleHotkey(e, store);
    expect(e.defaultPrevented).toBe(true);
    expect(store.state).toBe(spawnBefore); // no dispatch happened
  });

  it("swallows mod+shift+r on every non-agents tab (unbound everywhere but agents)", () => {
    for (const tab of ["teams", "queues", "events", "memory", "projects", "settings"] as const) {
      const store = makeStore({ activeTab: tab });
      const e = ev("R", { mod: true, shiftKey: true });
      handleHotkey(e, store);
      expect(e.defaultPrevented, tab).toBe(true);
    }
  });

  it("swallows bare f5 (no modifier) regardless of tab", () => {
    const store = makeStore({ activeTab: "settings" });
    const e = ev("F5");
    handleHotkey(e, store);
    expect(e.defaultPrevented).toBe(true);
  });

  it("swallows mod+f and mod+p even where neither is bound", () => {
    for (const [key, tab] of [["f", "agents"], ["p", "teams"]] as const) {
      const store = makeStore({ activeTab: tab });
      const e = ev(key, { mod: true });
      handleHotkey(e, store);
      expect(e.defaultPrevented, `${key} on ${tab}`).toBe(true);
    }
  });

  it("a bound reserved chord (mod+r on agents) BOTH preventDefaults and runs the action", () => {
    const store = makeStore({ activeTab: "agents" });
    let ran = false;
    const off = registerActionHandler("agents.toggleView", () => { ran = true; });
    try {
      const e = ev("r", { mod: true });
      handleHotkey(e, store);
      expect(e.defaultPrevented).toBe(true);
      expect(ran).toBe(true);
    } finally {
      off();
    }
  });

  it("guard-fail case: mod+shift+r on agents swallows the reload even though checkpointRevert has no live handler", () => {
    // when:"checkpointVisible" is a cosmetic tag only — resolveChord doesn't
    // consult it — so this row always resolves on the agents tab; with no
    // CheckpointStrip/Card mounted (no registerActionHandler call), runAction
    // falls through to dispatchAction, which has no case for this action id
    // and returns false: the reload is still prevented, but nothing runs.
    expect(hasActionHandler("agents.checkpointRevert")).toBe(false);
    const store = makeStore({ activeTab: "agents" });
    const before = store.state;
    const e = ev("R", { mod: true, shiftKey: true });
    handleHotkey(e, store);
    expect(e.defaultPrevented).toBe(true);
    expect(store.state).toBe(before);
  });

  it("does not touch native-editing chords (mod+z etc.) — BROWSER_RESERVED has no overlap with RESERVED_EDITING_KEYS", () => {
    for (const k of RESERVED_EDITING_KEYS) expect(BROWSER_RESERVED.has(`mod+${k}`)).toBe(false);
  });

  it("non-reserved unbound chord is unaffected (pre-existing behavior, e.g. an input-hijack regression)", () => {
    const store = makeStore({ activeTab: "teams" });
    const e = ev("q", { mod: true }); // "q" is OS-reserved, never bound anywhere
    handleHotkey(e, store);
    expect(e.defaultPrevented).toBe(false);
  });
});

// TYPING-OWNS-THE-KEYBOARD: an editable target keeps EVERY key. There used to be an exception —
// a bare 1-7 in an EMPTY editable field navigated the tab strip, on the TUI's "bare y/n while
// empty" precedent — and it fired precisely when someone started typing, because the first
// character into an empty field is the most common keystroke a field ever gets. Reported as "I
// press 1 in an input and the tab switches".
describe("an editable target owns every key", () => {
  const input = (value: string) => ({ tagName: "INPUT", value } as unknown as EventTarget);

  it("keeps a digit in an EMPTY field — the case the old exception broke", () => {
    expect(shouldResolveChordFor(input(""), "2")).toBe(false);
  });

  it("keeps a digit mid-value too, as it always did", () => {
    expect(shouldResolveChordFor(input("hello 2"), "2")).toBe(false);
  });

  it("keeps every other key: letters, and modifier chords", () => {
    for (const chord of ["a", "mod+k", "mod+o", "shift+1", "enter"]) {
      expect(shouldResolveChordFor(input(""), chord)).toBe(false);
    }
  });

  it("covers textarea, select and contenteditable, not just input", () => {
    expect(shouldResolveChordFor({ tagName: "TEXTAREA", value: "" } as unknown as EventTarget, "3")).toBe(false);
    expect(shouldResolveChordFor({ tagName: "SELECT" } as unknown as EventTarget, "3")).toBe(false);
    expect(shouldResolveChordFor({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget, "3")).toBe(false);
  });

  it("the digit still resolves to its tab action when nothing is focused — the binding is intact", () => {
    expect(resolveChord("2", "memory")?.action).toBe("tab.projects");
  });

  it("non-editable targets always resolve (window, buttons, etc.)", () => {
    expect(shouldResolveChordFor(null, "2")).toBe(true);
    expect(shouldResolveChordFor({ tagName: "BUTTON" } as unknown as EventTarget, "2")).toBe(true);
  });
});

// BUG A (packages/app P0): Composer.onKeyDown's ctrl/meta→keymap forward path
// used a blocklist (everything but v/y/n) that swallowed native editing chords
// — Cmd/Ctrl+A opened Accounts instead of select-all, Cmd/Ctrl+Z opened the
// MCP palette instead of undo. shouldForwardComposerChord is the extracted
// decision (zero tests existed for this path before this fix).
describe("shouldForwardComposerChord (BUG A — native editing carve-out)", () => {
  const chord = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, ...mods });
  it("never forwards a reserved native-editing chord, ctrl or meta", () => {
    for (const k of [...RESERVED_EDITING_KEYS]) {
      expect(shouldForwardComposerChord(chord(k, { ctrlKey: true }))).toBe(false);
      expect(shouldForwardComposerChord(chord(k, { metaKey: true }))).toBe(false);
      expect(shouldForwardComposerChord(chord(k.toUpperCase(), { metaKey: true }))).toBe(false); // shift+key case
    }
  });
  it("never forwards mod+y or mod+j (permission capture-phase owns allow/deny)", () => {
    expect(shouldForwardComposerChord(chord("y", { ctrlKey: true }))).toBe(false);
    expect(shouldForwardComposerChord(chord("j", { metaKey: true }))).toBe(false);
  });
  it("forwards other single-character ctrl/meta chords (e.g. ctrl+p, ctrl+o, ctrl+k)", () => {
    expect(shouldForwardComposerChord(chord("p", { ctrlKey: true }))).toBe(true);
    expect(shouldForwardComposerChord(chord("o", { metaKey: true }))).toBe(true);
    expect(shouldForwardComposerChord(chord("k", { ctrlKey: true }))).toBe(true);
  });
  it("never forwards plain typing (no modifier) or multi-character keys", () => {
    expect(shouldForwardComposerChord(chord("a"))).toBe(false);       // no ctrl/meta — plain typing
    expect(shouldForwardComposerChord(chord("Enter", { ctrlKey: true }))).toBe(false);
  });
});

// A7 (coverage §A7-4): pgup/pgdn scroll the transcript (5 lines). The chords
// resolve to the scroll actions on the agents tab and appear in the ONE table.
describe("A7 pgup/pgdn transcript scroll rows", () => {
  it("resolves pageup/pagedown to the scroll actions on the agents tab", () => {
    expect(resolveChord("pageup", "agents")?.action).toBe("agents.scrollUp");
    expect(resolveChord("pagedown", "agents")?.action).toBe("agents.scrollDown");
    // scoped to agents — not the events/memory tabs
    expect(resolveChord("pageup", "events")).toBeUndefined();
  });
  it("chordOf names PageUp/PageDown without modifiers", () => {
    const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(chordOf(key("PageUp"))).toBe("pageup");
    expect(chordOf(key("PageDown"))).toBe("pagedown");
  });
});

describe("dispatchAction", () => {
  it("jumps and cycles tabs", () => {
    const store = makeStore();
    expect(dispatchAction("tab.teams", store)).toBe(true);
    expect(store.state.activeTab).toBe("teams");
    dispatchAction("tab.next", store);
    expect(store.state.activeTab).toBe("queues");
    dispatchAction("tab.prev", store);
    expect(store.state.activeTab).toBe("teams");
    dispatchAction("tab.agents", store);
    expect(store.state.activeTab).toBe("agents");
  });
  it("moves the selection over the fold-aware visible order", () => {
    const store = makeStore(fleet());
    dispatchAction("agents.down", store);
    expect(store.state.selectedAgentId).toBe("w1");
    dispatchAction("agents.down", store);
    dispatchAction("agents.down", store);
    expect(store.state.selectedAgentId).toBe("sh");
    dispatchAction("agents.down", store); // clamped at the end
    expect(store.state.selectedAgentId).toBe("sh");
    dispatchAction("agents.up", store);
    expect(store.state.selectedAgentId).toBe("w2");
  });
  it("left folds the selected subtree, right unfolds it", () => {
    const store = makeStore({ ...fleet(), selectedAgentId: "w2" });
    dispatchAction("agents.foldLeft", store);
    expect(store.state.collapsed.has("w2")).toBe(true);
    dispatchAction("agents.foldRight", store);
    expect(store.state.collapsed.has("w2")).toBe(false);
  });
  it("P3-T3: left is a no-op when the selection has no own subtree (team-group fold is retired)", () => {
    // w1's next entry (w2) is a DIFFERENT tree, so w1 has no subtree to fold —
    // previously this fell back to folding the whole "tui-crew" team group;
    // now team is a per-row badge, not a foldable header, so nothing happens.
    const store = makeStore({ ...fleet(), selectedAgentId: "w1" });
    dispatchAction("agents.foldLeft", store);
    expect(store.state.collapsed.size).toBe(0);
    expect(store.state.selectedAgentId).toBe("w1");
  });
  it("selection stepping never lands inside a folded SUBTREE", () => {
    const store = makeStore({ ...fleet(), collapsed: new Set(["w2"]), selectedAgentId: "w2" });
    dispatchAction("agents.down", store);
    expect(store.state.selectedAgentId).toBe("w2"); // sh is hidden, nothing visible below
  });

  // ONBOARDING-GATE R2: dispatchAction is the built-in fallback for agents/
  // teams/queues/events/memory + tab.next/prev (the four registry-shadowed
  // slots — projects/settings/inbox/slo — are gated in TopBar itself, see
  // TopBar.test.tsx).
  describe("ONBOARDING-GATE R2 — zero CONFIRMED accounts locks the tab strip", () => {
    it("swallows every tab.* action except landing back on agents", () => {
      const store = makeStore({ connected: true, accounts: [] });
      expect(dispatchAction("tab.teams", store)).toBe(true); // handled (swallowed), not routed
      expect(store.state.activeTab).toBe("agents"); // unchanged
      dispatchAction("tab.next", store);
      expect(store.state.activeTab).toBe("agents");
      dispatchAction("tab.agents", store); // the one exempt destination
      expect(store.state.activeTab).toBe("agents");
    });
    it("unlocks the moment an account is confirmed present", () => {
      const store = makeStore({ connected: true, accounts: [{ name: "a", provider: "claude" } as never] });
      dispatchAction("tab.teams", store);
      expect(store.state.activeTab).toBe("teams");
    });
    it("does NOT gate while disconnected (unknown accounts state, not confirmed empty)", () => {
      const store = makeStore({ connected: false, accounts: [] });
      dispatchAction("tab.teams", store);
      expect(store.state.activeTab).toBe("teams");
    });
  });
});

describe("runAction registry", () => {
  it("prefers the last screen registration and falls back after dispose", () => {
    const store = makeStore();
    const calls: string[] = [];
    const off1 = registerActionHandler("agents.toggleView", () => calls.push("first"));
    const off2 = registerActionHandler("agents.toggleView", () => calls.push("second"));
    runAction("agents.toggleView", store);
    expect(calls).toEqual(["second"]);
    off2();
    runAction("agents.toggleView", store);
    expect(calls).toEqual(["second", "first"]);
    off1();
    runAction("agents.toggleView", store); // no handler + no built-in: a no-op
    expect(calls).toEqual(["second", "first"]);
  });
  it("routes unregistered actions to the built-in store dispatch", () => {
    const store = makeStore();
    runAction("tab.events", store);
    expect(store.state.activeTab).toBe("events");
  });
});

// TYPING-OWNS-THE-KEYBOARD: the same rule, audited across the app's OTHER window-level keydown
// listeners — the ones that bind the window directly and so bypass handleHotkey's gate entirely.
// This is a source-level audit rather than a DOM test, because the listeners live inside screen
// components: what it pins is that no NEW unguarded bare-letter accelerator appears.
describe("window-level listeners outside the keymap gate", () => {
  it("the bare y/n permission accelerator is guarded by isEditableTarget", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/screens/AgentsScreen.tsx", import.meta.url), "utf8");
    const bareBranch = src.slice(src.indexOf('(ev.key === "y" || ev.key === "n")'));
    expect(bareBranch.slice(0, 200)).toContain("isEditableTarget(ev.target)");
  });
});
