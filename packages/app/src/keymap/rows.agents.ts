// Agents-screen rows — OWNED BY W4 (composer + decision overlays; W3 authored
// the read-only subset). See rows.tabs.ts for the split rationale.
//
// KEYMAP-REDESIGN letter budget (see keymap.ts's standard comment): agents is
// the busiest screen (its composer holds focus by default, so EVERY
// non-arrow action here must be mod-qualified to survive Composer's generic
// ctrl/meta forward path) and gets all 9 of the non-global-pinned letters:
// d e j k o p r u y. Six low-frequency overlay openers were retired to
// mouse+palette-only to fit the reserved-letter ban (system.effort,
// system.accountSwitch, system.remoteControl, system.result,
// perm.allowTool, perm.allowServer) — each already has a mouse affordance.
import type { KeymapRow } from "../keymap";

export const AGENT_ROWS: readonly KeymapRow[] = [
  { chord: "up", action: "agents.up", scope: "agents", label: "select" },
  { chord: "down", action: "agents.down", scope: "agents", label: "select" },
  { chord: "left", action: "agents.foldLeft", scope: "agents", label: "fold" },
  { chord: "right", action: "agents.foldRight", scope: "agents", label: "fold" },
  // was ctrl+f (reserved letter "f") — a pure view toggle, but the composer's
  // default focus forces every agents-scope action to be mod-qualified
  // (keymap.ts's family-2 promotion rule), so it takes the freed "r" letter
  // (system.result's dedicated hotkey retired below).
  { chord: "mod+r", action: "agents.toggleView", scope: "agents", label: "flow / list" },
  { chord: "mod+o", action: "agents.spawn", scope: "agents", label: "spawn" },
  // DESTROY: terminating a running agent can't be resumed — promoted off
  // mod+letter (was ctrl+k, "k" also reserved-adjacent-free but the action
  // itself is destroy-class) onto mod+shift+k.
  { chord: "mod+shift+k", action: "agents.kill", scope: "agents", label: "kill" },
  // AGENT-RESUME-UI: mod+shift+g, because every nearer letter is taken — mod+shift+r is the
  // checkpoint revert two rows down, and the agents scope forces mod-qualification.
  { chord: "mod+shift+g", action: "agents.resume", scope: "agents", label: "resume" },
  // note mod+e ("agents.detail") is deliberately ONE action id shared by the
  // tool-detail toggle (TranscriptPanel) and the permission card's pretty/raw
  // toggle (PermissionCard): the card's registration shadows the panel's
  // while it is mounted (registry last-wins), exactly the FlowPane pattern.
  { chord: "mod+e", action: "agents.detail", scope: "agents", label: "detail" },
  // DESTROY: ending the conductor session is not casually reversible (a
  // respawn is a NEW session) — promoted off mod+letter (was ctrl+w, "w"
  // reserved) onto mod+shift+w.
  { chord: "mod+shift+w", action: "agents.closeMain", scope: "agents", label: "close main" },
  // F12 (W12): `v` toggles a message's raw markdown view. Hint-only in the ONE
  // table (footers/help render "v raw"); the live binding is TranscriptPanel's
  // capture-phase handler, GATED on an in-pane text selection so typing 'v' in
  // the always-focused composer is never hijacked (unbound → resolveChord skips
  // it, but registerActionHandler("agents.rawToggle") still runs via runAction).
  { chord: "v", action: "agents.rawToggle", scope: "agents", label: "raw", unbound: true },
  { chord: "mod+u", action: "composer.popQueued", scope: "agents", label: "edit queued" },
  // A7 (coverage §A7-4): pgup/pgdn scroll the transcript 5 lines (wheel=3). The
  // live binding is TranscriptPanel's capture-phase handler (it fires while the
  // always-focused composer owns the keyboard); these rows keep the ONE-table
  // rule so the Footer/HelpScreen render the chords.
  { chord: "pageup", action: "agents.scrollUp", scope: "agents", label: "scroll ↑" },
  { chord: "pagedown", action: "agents.scrollDown", scope: "agents", label: "scroll ↓" },
  // Permission answer chords (A3/B6). Their PRIMARY binding lives in
  // AgentsScreen's capture-phase handler so they work above every other
  // overlay and while the composer owns focus (TUI-017); these rows keep the
  // one-table rule for footers/help and the non-focused fallback path.
  { chord: "mod+y", action: "perm.allow", scope: "agents", label: "allow", when: "pendingPermission" },
  // was ctrl+n ("n" reserved) — "deny" takes the freed "j" letter
  // (system.mcpPalette moved off agents scope entirely, see rows.system.ts).
  { chord: "mod+j", action: "perm.deny", scope: "agents", label: "deny", when: "pendingPermission" },
  // F20 (W22, D16 checkpoints): mod+k snapshots the selected agent's repo
  // (manual trigger, was ctrl+s — "s" reserved); mod+shift+r reverts to the
  // checkpoint currently on screen (DESTROY per rule4's explicit "revert",
  // was bare 'r') — the strip's latest, or the card's selected row while it's
  // open (CheckpointsCard shadows CheckpointStrip's registration, mod+e's
  // precedent above). Both handlers no-op on a dark (non-git cwd) repo — see
  // commands.checkpoints.ts.
  { chord: "mod+k", action: "agents.checkpoint", scope: "agents", label: "checkpoint" },
  { chord: "mod+shift+r", action: "agents.checkpointRevert", scope: "agents", label: "revert checkpoint", when: "checkpointVisible" },
  // IN-APP-TERMINAL Task 6: mod+j is already fully allocated (perm.deny above, when a
  // permission is pending) — this row exists ONLY so the footer/help surface the chord;
  // resolveChord skips unbound rows (same "v" raw-toggle precedent above), and the real
  // binding is TerminalDock's own capture-phase listener, which defers to perm.deny whenever
  // a permission is actually pending.
  { chord: "mod+j", action: "terminal.toggle", scope: "agents", label: "terminal", unbound: true },
];
