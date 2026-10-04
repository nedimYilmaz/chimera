// W8 (host tools card) rows — OWNED by that workstream alone; behaviors register via
// registerActionHandler from the owning modules (see rows.tabs.ts for the
// per-owner split rationale).
//
// KEYMAP-REDESIGN: was ctrl+h ("h" reserved) — moved to mod+d, and from a
// literal scope:"global" row to "every scope but agents" (rows.system.ts's
// everyScopeExceptAgents helper), the same letter-budget trade as
// accounts/mcpPalette/plugins (agents needs "d" for system.model instead;
// the card stays reachable from agents via the command palette, mod+b).
import { everyScopeExceptAgents } from "./rows.system";
import type { KeymapRow } from "../keymap";

export const HOST_ROWS: readonly KeymapRow[] = [
  // toggles the card (HostToolsCard registers "host.toggle" — the outlet
  // keeps it mounted on every screen); the same chord re-toggles it closed
  // (the TUI's opener-key convention). esc closes via OverlayCard.
  ...everyScopeExceptAgents("mod+d", "host.toggle", "host tools"),
  // Declared-but-unbound (rows.tabs.ts precedent): while the card is open its
  // capture-phase listener dispatches these SAME action ids (QuestionCard
  // pattern) — a global "space"/"p" row here could never shadow the per-tab
  // rows through resolveChord (HOST_ROWS compose last, first match wins), and
  // an idle chord must not preventDefault for nothing while the card is
  // closed. The rows keep the one-table rule for footers/help.
  { chord: "space", action: "host.cycle", scope: "global", label: "allow→ask→deny", when: "hostTools", unbound: true },
  { chord: "p", action: "host.profileEdit", scope: "global", label: "edit per profile", when: "hostTools", unbound: true },
];
