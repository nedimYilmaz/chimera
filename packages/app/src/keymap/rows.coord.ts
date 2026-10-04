// Coordination-screen rows (teams/queues/events/memory) — OWNED BY W5.
// These rows declare the chords + footer labels; the BEHAVIORS are registered
// via registerActionHandler from the screen components themselves (keymap.ts's
// registry), so W5 never edits keymap.ts. A row's screen is mounted exactly
// while its scope is the active tab, so every action id below always has a
// live registration when it can resolve.
//
// KEYMAP-REDESIGN: none of these screens keep an input focused by default
// (unlike agents/memory's composer/search-box), so pure view toggles stay
// bare (queues.workflow, queues.scheduleToggle, events.filterCycle); every
// real mutate/destroy action is mod-qualified with ONE consistent letter per
// MEANING reused across every scope it appears in (rule 6): mod+o = create
// everywhere, mod+e = edit everywhere, mod+shift+x = the universal hard
// delete/dissolve/remove chord. teams/queues/memory/projects/settings all
// reuse this vocabulary — see keymap.ts's KEYBINDING STANDARD comment for the
// full letter-budget accounting.
import type { KeymapRow } from "../keymap";

export const COORD_ROWS: readonly KeymapRow[] = [
  // teams (mock s_teams footers: "↑↓ select · enter detail · mod+o new ·
  // mod+shift+x dissolve" / detail: "esc back · mod+shift+x dissolve")
  { chord: "up", action: "teams.up", scope: "teams", label: "select" },
  { chord: "down", action: "teams.down", scope: "teams", label: "select" },
  { chord: "enter", action: "teams.drill", scope: "teams", label: "detail" },
  // the old ctrl+t second chord for teams.drill is retired (redundant with
  // enter — "t" is reserved and the mouse/keyboard parity it existed for is
  // already covered by the row-click handler).
  { chord: "mod+o", action: "teams.new", scope: "teams", label: "new team" },
  // W16 (F15/D11): mod+e opens the SAME create card prefilled ("edit team ·
  // <name>"); roles lock while any member is running. Was bare "e" — promoted
  // to the universal mod+e "edit" chord for cross-screen consistency (rule 6).
  { chord: "mod+e", action: "teams.edit", scope: "teams", label: "edit team" },
  // DESTROY: the universal mod+shift+x "delete/dissolve" chord (was ctrl+d).
  { chord: "mod+shift+x", action: "teams.dissolve", scope: "teams", label: "dissolve" },
  // queues (mock s_queues footers: "↑↓ select · enter detail · mod+o new
  // queue" / detail: "↑↓ task · mod+shift+c cancel · mod+o push · esc back")
  { chord: "up", action: "queues.up", scope: "queues", label: "select" },
  { chord: "down", action: "queues.down", scope: "queues", label: "select" },
  { chord: "enter", action: "queues.drill", scope: "queues", label: "detail" },
  // W16: mod+o/mod+e/mod+shift+c are each dual-purpose, routed by QueuesScreen
  // at runtime by context: a queue drill open → push-task/cancel-task (F14);
  // the schedules panel focused (arrows fell off the queue list) → its OWN
  // create/edit; otherwise → queue.create/update/delete (D11).
  { chord: "mod+o", action: "queues.new", scope: "queues", label: "push task / new queue / new schedule" },
  { chord: "mod+e", action: "queues.edit", scope: "queues", label: "edit queue / edit schedule" },
  // DESTROY: "cancel" gets its own mnemonic letter distinct from the
  // universal delete (this chord's dual meaning — cancel a task OR delete a
  // queue — was already one chord pre-redesign; kept as one, re-lettered).
  { chord: "mod+shift+c", action: "queues.cancel", scope: "queues", label: "cancel task / delete queue" },
  // W18 (F16 task workflows, coverage B20/C14): the read-only WorkflowCard for
  // the selected queue's bound workflow — steps · gate states · ● enforced
  // badge · engine-parity note. Pure view toggle, no always-focused input on
  // this screen, so it stays bare (rule 2) — also "w" is mod-reserved anyway.
  { chord: "w", action: "queues.workflow", scope: "queues", label: "workflow" },
  // QUEUE-PAUSE: rule 3 explicitly lists "pause" as a mutate example.
  { chord: "mod+k", action: "queues.pauseToggle", scope: "queues", label: "pause/resume" },
  // row-level pin (F01 PinnedBar): mod+p pins/unpins the SELECTED task row
  // (the events-row equivalent below shares this exact chord, rule 6) — rule
  // 3 lists "pin" as mutate, so it's promoted off the old bare 'p'.
  { chord: "mod+p", action: "queues.pin", scope: "queues", label: "pin task" },
  // W15 (F14 schedules panel, coverage B19/C12): a PERMANENT sub-panel below
  // the queue master list (not a queue-detail affordance), so its own actions
  // ride bare chords free in this scope EXCEPT where rule 2/3 forbids it —
  // "space" is grandfathered bare (rule 2 lists it explicitly); "run now" is
  // rule 3's own mutate example, so it moves off bare 'r' onto mod+r (same
  // letter as projects.run and memory.graph — different, mutually exclusive
  // scopes, reused for letter economy); "delete" joins the universal
  // mod+shift+x chord (was bare 'd').
  { chord: "space", action: "queues.scheduleToggle", scope: "queues", label: "enable/disable" },
  { chord: "mod+r", action: "queues.scheduleRun", scope: "queues", label: "run now" },
  { chord: "mod+shift+x", action: "queues.scheduleDelete", scope: "queues", label: "delete schedule" },
  // events (mock s_events footer: "… · f filter by kind"); up/down move a
  // row cursor so mod+p has a selected row to pin/unpin (F01 PinnedBar).
  { chord: "up", action: "events.up", scope: "events", label: "select" },
  { chord: "down", action: "events.down", scope: "events", label: "select" },
  // pure view toggle, no always-focused input — stays bare (rule 2 names
  // "filter cycle" explicitly).
  { chord: "f", action: "events.filterCycle", scope: "events", label: "filter by kind" },
  { chord: "mod+p", action: "events.pin", scope: "events", label: "pin row" },
  // memory — master/detail split matches Projects/Teams/Queues (mock
  // s_memory's original single-pane footer "… · enter expand" now reads as
  // "enter detail" for the same master→detail pane convention).
  { chord: "up", action: "memory.up", scope: "memory", label: "record" },
  { chord: "down", action: "memory.down", scope: "memory", label: "record" },
  { chord: "enter", action: "memory.expand", scope: "memory", label: "detail" },
  { chord: "mod+o", action: "memory.new", scope: "memory", label: "add note" },
  // W16 (F15/D11): mod+e/mod+shift+x, NOT bare e/d — the search box is always
  // focused on this screen (unlike Teams/Queues' plain row lists), so a bare
  // letter must keep typing into the query (same reasoning as mod+o above).
  // This is the ORIGINAL "always-focused input promotes to mod" precedent
  // (keymap.ts's KEYBINDING STANDARD) that agents scope now mirrors too.
  { chord: "mod+e", action: "memory.edit", scope: "memory", label: "edit note" },
  { chord: "mod+shift+x", action: "memory.delete", scope: "memory", label: "delete note" },
  // MEM-5 (§8): search-mode cycle, graph toggle (list ⇄ graph, MEM-6), and the
  // link-navigation back step. Both are pure view toggles but — same
  // always-focused-search-box reasoning — must be mod-qualified. mod+m/mod+g
  // are retired (both letters are reserved: "m" minimize, and mod+g was also
  // colliding in MEANING with system.model on the agents scope, rule 7's own
  // named example) — mode takes mod+k, graph takes mod+r (both reused from
  // other, mutually exclusive scopes' vocabularies). alt+left is the nav
  // back-step (family-1 arrow, mod-qualified so it doesn't fight cursor moves).
  { chord: "mod+k", action: "memory.mode", scope: "memory", label: "search mode" },
  // F34.UI: the scope filter cycles all → @global → each project scope. mod+shift+k
  // is free on THIS scope (agents' kill owns it on the agents scope, and the
  // collision rule is per-scope) and reads as "the other half of mod+k's filter
  // pair" — mode ranks, scope narrows.
  { chord: "mod+shift+k", action: "memory.scope", scope: "memory", label: "scope filter" },
  { chord: "mod+r", action: "memory.graph", scope: "memory", label: "graph" },
  // F36.UI: pin/unpin the selected note — the operator's only control over what
  // value-ranked eviction keeps. "p" is the app's established pin letter (events
  // scope owns bare `p`); mod-qualified here for the always-focused search box.
  { chord: "mod+p", action: "memory.pin", scope: "memory", label: "pin note" },
  { chord: "alt+left", action: "memory.back", scope: "memory", label: "back" },
];
