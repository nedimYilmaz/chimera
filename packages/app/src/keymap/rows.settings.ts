// Settings-screen rows — NEW (KEYMAP-REDESIGN rule 8): the provider add/test/
// remove hotkeys used to live as an ad hoc keydown listener inside
// SettingsScreen's ProvidersSection (bare "t"/"d", ctrl+n), invisible to the
// Footer/HelpScreen and bypassing the shared isEditableTarget guard's usual
// one-table treatment. They now follow the same declare-here /
// registerActionHandler-in-the-screen pattern as every other coordination
// scope (rows.coord.ts).
//
// Chord decisions: mod+o add (the universal "create" chord, rule 6) · mod+k
// test (no other scope needs "test," so it gets a free letter) · mod+shift+x
// remove (rule 8 explicitly calls for the destroy tier here, joining the
// universal delete/remove chord used by memory.delete/projects.delete/
// teams.dissolve).
import type { KeymapRow } from "../keymap";

export const SETTINGS_ROWS: readonly KeymapRow[] = [
  { chord: "mod+o", action: "settings.providerAdd", scope: "settings", label: "add provider" },
  { chord: "mod+k", action: "settings.providerTest", scope: "settings", label: "test provider" },
  { chord: "mod+shift+x", action: "settings.providerRemove", scope: "settings", label: "remove provider" },
  { chord: "mod+shift+up", action: "settings.providerMoveUp", scope: "settings", label: "move up (failover priority)" },
  { chord: "mod+shift+down", action: "settings.providerMoveDown", scope: "settings", label: "move down (failover priority)" },
  { chord: "mod+e", action: "settings.providerRekey", scope: "settings", label: "re-key account" },
];
