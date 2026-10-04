// Global (non-tab) rows — OWNED BY W4 (overlays, composer, palettes). See
// rows.tabs.ts for why the KEYMAP literal is split per owner.
import type { KeymapRow } from "../keymap";

export const GLOBAL_ROWS: readonly KeymapRow[] = [
  { chord: "?", action: "help.toggle", scope: "global", label: "help" },
  // W4: on the agents tab, AgentsScreen registers the FULL close-priority
  // chain for this action (see commands.agents.ts resolveEscTier — the order
  // is documented there); the keymap's built-in help-close remains the
  // fallback everywhere else.
  { chord: "esc", action: "global.escape", scope: "global", label: "clear/back" },
  // KEYMAP-REDESIGN: composer.permissions is a MUTATE action (cycles ◇ask ⇄
  // ◆bypass) so it moved from ctrl+p to mod+p — same letter, now
  // platform-resolved. Composer.tsx forwards it generically while the
  // compose textarea holds focus (the "composer forward path", rule 1).
  { chord: "mod+p", action: "composer.permissions", scope: "agents", label: "permissions" },
  // TRANSCRIPT-SEARCH: mod+f was already in BROWSER_RESERVED — swallowed so the webview's own
  // find-on-page never opens over the app, but going nowhere. It opens the transcript's search
  // instead, which is what the key means here. Listed in EDITABLE_PASSTHROUGH so it works from
  // inside the composer, the way find does in every editor.
  { chord: "mod+f", action: "transcript.search", scope: "agents", label: "search transcript" },
  { chord: "/", action: "composer.commands", scope: "agents", label: "commands" },
];
