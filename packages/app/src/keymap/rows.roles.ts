// ROLES-TAB S5 — the Roles tab's own scope, split out like rows.coord.ts so
// this workstream never edits that file. Mirrors the Teams scope's
// vocabulary exactly (rule 6): mod+o create, mod+e edit, mod+shift+x delete.
import type { KeymapRow } from "../keymap";

export const ROLES_ROWS: readonly KeymapRow[] = [
  { chord: "up", action: "roles.up", scope: "roles", label: "select" },
  { chord: "down", action: "roles.down", scope: "roles", label: "select" },
  { chord: "mod+o", action: "roles.new", scope: "roles", label: "new session role" },
  { chord: "mod+e", action: "roles.edit", scope: "roles", label: "edit" },
  { chord: "mod+shift+x", action: "roles.delete", scope: "roles", label: "delete" },
];
