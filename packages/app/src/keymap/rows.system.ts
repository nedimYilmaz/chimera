// W6 (system surfaces) rows — OWNED by that workstream alone; behaviors
// register via registerActionHandler from App.tsx (accounts/palette/perf-hud/
// pin/replay all toggle app-wide surfaces, so the ONE always-mounted owner
// registers them — see App's system-surface effect). model is agents-scoped
// (needs a selected agent).
//
// KEYMAP-REDESIGN: the OLD ctrl+shift+* capture-phase trio (perf hud/pin
// agent/replay) is retired along with App.tsx's dedicated capture handler —
// none of the three are DESTROY actions (perf hud + replay are view toggles;
// "pin" is rule 3's own mutate example), so mod+shift+letter was the wrong
// family for them. They now resolve through the NORMAL registerActionHandler
// path like every other row here, on plain mod+letter.
//
// accounts/mcpPalette/host.toggle/plugins.toggleCard are declared on every
// scope EXCEPT "agents" (forNonAgentScopes below) rather than "global" — this
// is the letter-budget move documented in keymap.ts's KEYBINDING STANDARD:
// agents is the one screen that needs every one of the 13 reserved-avoiding
// letters for its OWN actions, so these four overlays give up a direct
// agents-tab hotkey (still reachable there via the command palette, mod+b)
// to free 4 letters for agents' local vocabulary. system.palette/perfHud/
// pinSelected/replay stay genuinely "global" (must fire identically from
// every tab including agents) since none of them compete for an agents-local
// letter the way these four would.
import type { KeyScope, KeymapRow } from "../keymap";

const NON_AGENT_SCOPES: readonly KeyScope[] = ["teams", "queues", "events", "memory", "projects", "settings"];

/** Declares one row per non-agents scope (rows.projects.ts's plugins.toggleCard
 * reuses this too) — see the letter-budget note above for why "every scope
 * but agents" replaces the old literal scope:"global" for these overlays. */
export function everyScopeExceptAgents(chord: string, action: string, label: string): KeymapRow[] {
  return NON_AGENT_SCOPES.map((scope) => ({ chord, action, scope, label }));
}

export const SYSTEM_ROWS: readonly KeymapRow[] = [
  // was ctrl+a ("a" reserved) — mod+u, reachable from every tab but agents.
  ...everyScopeExceptAgents("mod+u", "system.accounts", "accounts"),
  // mock command palette (B7 "/ palette", coverage A7-2) — the ONE truly
  // global overlay opener that must work from agents too (it's the universal
  // command finder); chord unchanged.
  { chord: "mod+b", action: "system.palette", scope: "global", label: "palette" },
  // mcp tool palette — was ctrl+z ("z" reserved); reachable from every tab but
  // agents (mod+b's palette still reaches it there).
  ...everyScopeExceptAgents("mod+j", "system.mcpPalette", "mcp tools"),
  // mock model card hint: "mod+d / esc" — was ctrl+g (collided in MEANING
  // with memory.graph, rule 7's own named example); "d" is free on the
  // agents scope since host.toggle (below) no longer claims it there.
  { chord: "mod+d", action: "system.model", scope: "agents", label: "model" },
  // RETIRED (KEYMAP-REDESIGN letter budget): system.effort, system.accountSwitch,
  // system.remoteControl, system.result no longer have a dedicated agents-scope
  // hotkey — each already has a mouse affordance (chip/button), so they're
  // mouse+palette-reachable-elsewhere only where the palette lists them; on
  // the agents scope specifically they're mouse-only. This is the disclosed
  // trade that makes the 9-letter agents budget fit exactly (keymap.ts's
  // KEYBINDING STANDARD comment has the full accounting).
  // coverage B7 perf HUD: pure view toggle — was ctrl+shift+d, now mod+g
  // (global, resolves through the normal registry like every other row).
  { chord: "mod+g", action: "system.perfHud", scope: "global", label: "perf hud" },
  // pinned bar (B7): pin/unpin the SELECTED agent — "pin" is a rule-3 mutate
  // example, was ctrl+shift+p, now mod+i (global — the PinnedBar strip shows
  // on every tab, so pinning from any of them is intentional, unchanged
  // behavior from before the redesign).
  { chord: "mod+i", action: "system.pinSelected", scope: "global", label: "pin agent" },
  // replay bar (B7): no mock-documented opener — was ctrl+shift+r, now mod+l.
  { chord: "mod+l", action: "system.replay", scope: "global", label: "replay" },
];
