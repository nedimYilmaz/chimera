// Tab-navigation rows — OWNED BY W5 (tab strip / screen switching). Split out
// of keymap.ts so W4 (rows.global/rows.agents + the dispatch engine) and W5
// (these rows + rows.coord) never edit the same file in parallel.
//
// W5: SIX tab slots per the mock (lines 24-35): 1 agents · 2 projects ·
// 3 teams · 4 queues · 5 events · 6 memory.
// W7: the projects slot is LIVE — TabId gained "projects" (ui-state), so the
// slot carries a real tab and chord 2 is bound. Its action ("tab.projects")
// resolves through the registry (TopBar registers the handler), NOT through
// dispatchAction's TAB_ORDER built-in — TAB_ORDER stays the TUI's five-tab
// surface, and the same TopBar registration shadows tab.next/tab.prev so the
// tab/shift+tab cycle walks THIS six-slot strip in mock order.
// W9: SEVEN slots now — the settings slot (mock line 36-37: "7 settings") is
// LIVE the same registry-handled way as projects. TabId gained "settings"
// (ui-state, NOT TAB_ORDER), chord 7 → tab.settings resolves through the TopBar
// registration, and the six→seven cycle picks it up automatically (cycleTab
// walks every non-null slot). The TUI is untouched: its cycling reads the
// five-entry TAB_ORDER, never this strip.
// FEATURE-9: EIGHT slots now — the inbox slot joins the same app-only way as
// projects/settings above (no design mock exists for it yet; this follows the
// established precedent rather than a mock). TabId gained "inbox" (ui-state,
// NOT TAB_ORDER), chord 8 → tab.inbox resolves through the TopBar registration.
import type { TabId } from "@chimera/ui-state";
import type { KeymapRow } from "../keymap";

export type AppTab = {
  // F13.2: nullable — the digits 1-9 and 0 are ALL taken by the first ten
  // slots, so the 11th ("runs") renders with no leading number and reaches its
  // chord (mod+shift+h) through the keymap row below instead.
  num: number | null;   // the mock's leading number ("3 teams")
  label: string;
  tab: TabId | null;    // null = inert slot (no dispatch)
  title?: string;       // hover tooltip for the inert slot
};

/** The tab strip, in mock order. TopBar renders EXACTLY this. */
export const APP_TABS: readonly AppTab[] = [
  { num: 1, label: "agents", tab: "agents" },
  { num: 2, label: "projects", tab: "projects" },
  { num: 3, label: "teams", tab: "teams" },
  { num: 4, label: "queues", tab: "queues" },
  { num: 5, label: "events", tab: "events" },
  { num: 6, label: "memory", tab: "memory" },
  { num: 7, label: "settings", tab: "settings" },
  { num: 8, label: "inbox", tab: "inbox" },
  { num: 9, label: "slo", tab: "slo" },
  // ROLES-TAB S5: a TENTH slot — chord "0" (1-9 are taken). Registry-handled
  // the same app-only way as projects/settings/inbox/slo above (TopBar
  // registers "tab.roles"; not in ui-state's TAB_ORDER).
  { num: 0, label: "roles", tab: "roles" },
  // F13.2: the ELEVENTH slot — unified run history. No digit is left (1-9 + 0
  // are spent), so it is numberless in the strip and bound to mod+shift+h
  // (mod+h is unusable: macOS Cmd+H is on keymap.test.ts's OS-reserved list).
  { num: null, label: "runs", tab: "runs" },
];

export const TAB_ROWS: readonly KeymapRow[] = [
  { chord: "1", action: "tab.agents", scope: "global", label: "agents" },
  // W7: bound — the handler registers from TopBar (see the header note).
  { chord: "2", action: "tab.projects", scope: "global", label: "projects" },
  { chord: "3", action: "tab.teams", scope: "global", label: "teams" },
  { chord: "4", action: "tab.queues", scope: "global", label: "queues" },
  { chord: "5", action: "tab.events", scope: "global", label: "events" },
  { chord: "6", action: "tab.memory", scope: "global", label: "memory" },
  // W9: bound — the handler registers from TopBar (see the header note), like tab.projects.
  { chord: "7", action: "tab.settings", scope: "global", label: "settings" },
  // FEATURE-9: bound — the handler registers from TopBar (see the header note), like tab.projects.
  { chord: "8", action: "tab.inbox", scope: "global", label: "inbox" },
  { chord: "9", action: "tab.slo", scope: "global", label: "fleet slo" },
  // ROLES-TAB S5: bound — the handler registers from TopBar (see the header note), like tab.projects.
  { chord: "0", action: "tab.roles", scope: "global", label: "roles" },
  // F13.2: no digit is left for the 11th tab. The plan proposed mod+h, but "h" is on
  // the OS-reserved list (macOS Cmd+H = Hide) that keymap.test.ts enforces, and every
  // other plain mod+letter is already bound — so run history takes mod+shift+h.
  { chord: "mod+shift+h", action: "tab.runs", scope: "global", label: "run history" },
  { chord: "tab", action: "tab.next", scope: "global", label: "tabs" },
  { chord: "shift+tab", action: "tab.prev", scope: "global", label: "tabs (back)" },
];
