// W7 (projects screen + a2a + plugins) rows — OWNED by that workstream alone;
// behaviors register via registerActionHandler from the owning modules
// (ProjectsScreen / A2ATicker / PluginsCard — see rows.tabs.ts for the
// per-owner split rationale).
//
// KEYMAP-REDESIGN chord decisions:
//  * projects-scope rows mirror the mock's s_projects footers 1:1, rebased
//    onto the new letter vocabulary: mod+o create (was ctrl+n — universal
//    "new" chord, rule 6), mod+shift+x hard delete (was ctrl+x — the
//    universal delete chord, same as memory.delete/teams.dissolve), mod+k
//    archive (was ctrl+d — a reversible/soft action, so MUTATE not destroy;
//    "d" is taken on this scope by host.toggle's everyScopeExceptAgents row,
//    so archive takes the free "k" instead), mod+r run team (was bare
//    "r" — rule 3 lists "run" as an explicit mutate example, so it can no
//    longer be bare; reuses the same letter as queues.scheduleRun/
//    memory.graph, different mutually-exclusive scopes).
//  * PLUGINS OPENER: mod+y (was ctrl+j — "j" is now system.mcpPalette's
//    letter). Declared on every scope but "agents" (rows.system.ts's
//    everyScopeExceptAgents helper) — the card reads the SELECTED AGENT's
//    spawn-spec skills + project commands, so it must open from any OTHER
//    screen; on agents itself it's mouse+palette-only (letter-budget trade).
//  * A2A HISTORY: the mock ticker's own hint is "enter → a2a geçmişi"; enter
//    is unclaimed on the agents scope (the composer owns it only while
//    focused — editable targets bypass the root handler), so the ticker binds
//    it agents-scoped and no-ops while the feed is empty.
import { everyScopeExceptAgents } from "./rows.system";
import type { KeymapRow } from "../keymap";

export const PROJECTS_ROWS: readonly KeymapRow[] = [
  // projects master/detail (mock s_projects 510 + 538 footers)
  { chord: "up", action: "projects.up", scope: "projects", label: "select" },
  { chord: "down", action: "projects.down", scope: "projects", label: "select" },
  { chord: "enter", action: "projects.drill", scope: "projects", label: "detail" },
  { chord: "mod+o", action: "projects.new", scope: "projects", label: "import/new" },
  { chord: "mod+k", action: "projects.archive", scope: "projects", label: "archive" },
  // DESTROY: the universal mod+shift+x "delete" chord.
  { chord: "mod+shift+x", action: "projects.delete", scope: "projects", label: "delete" },
  { chord: "mod+r", action: "projects.run", scope: "projects", label: "run team" },
  // FILEBROWSER-T6: file-tree collapse/expand — up/down/enter are shared with
  // the master list (FileTree shadows projects.up/down/drill via the registry
  // while it's mounted, same precedent as mod+e/FlowPane's fold rows), but
  // left/right were never bound at this scope, so the tree gets its own ids.
  { chord: "left", action: "projects.filesLeft", scope: "projects", label: "collapse" },
  { chord: "right", action: "projects.filesRight", scope: "projects", label: "expand" },
  // a2a ticker (mock showA2A 454: "enter → a2a geçmişi")
  { chord: "enter", action: "a2a.history", scope: "agents", label: "a2a history" },
  // plugins & commands card (chord decision above) — every scope but agents
  // (rows.system.ts's everyScopeExceptAgents helper, same letter-budget trade
  // as accounts/mcpPalette/host.toggle).
  ...everyScopeExceptAgents("mod+y", "plugins.toggleCard", "plugins"),
];
