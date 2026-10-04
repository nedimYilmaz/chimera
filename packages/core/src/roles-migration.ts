import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { RoleSpecSchema, type RoleSpec } from "@chimera/protocol";

const BAK_SUFFIX = ".pre-roles-unify.bak";

// Step 1: idempotent backup — a second boot after a successful migration is a no-op here
// (skips a file whose .bak already exists), matching the ONE required reversibility path
// ("stop the daemon, copy the .bak files back, start an old build").
function backupOnce(file: string): void {
  if (!existsSync(file)) return;
  const bak = `${file}${BAK_SUFFIX}`;
  if (existsSync(bak)) return;
  copyFileSync(file, bak);
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

// Structural check (not a schema parse — the point of operating on RAW JSON): a migrated
// slot is `{role: "<name>", overrides: {...}}`; an un-migrated slot is an inline
// RoleTemplate-shaped object, which never has a field literally named `role`
// (AgentSpecSchema's field set, checked directly against index.ts, has no such field).
function isRoleBinding(v: unknown): v is { role: string } {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)["role"] === "string";
}

// ROLES-UNIFY §7: runs once per boot, BEFORE TeamManager/RoleStore ever construct (both
// strict-parse their files immediately) — an old inline-RoleTemplate roles[key] row or a
// lingering `sharedRoles` key are unknown-shape under the new schemas, not merely
// differently-defaulted, so the strict parse would reject them outright rather than
// silently misreading them.
//
// Operates on raw JSON throughout, never the old (now-deleted) SessionRoleSpecSchema/
// RoleTemplateSchema: RoleSpecSchema is a strict superset of both old shapes (every field
// either schema required/allowed is also a valid RoleSpec field; every field an old row
// omitted takes its AgentSpec default), so parsing an old row through RoleSpecSchema
// directly — plus a `name` this migration itself assigns — is sufficient. There is
// nothing left needing the old schema's own validation.
export function migrateRolesOnBoot(home: string): void {
  const teamsFile = join(home, "teams.json");
  const oldRolesFile = join(home, "session-roles.json");
  const newRolesFile = join(home, "roles.json");

  backupOnce(teamsFile);
  backupOnce(oldRolesFile);

  // Step 2: seed the library from the legacy session-roles.json — ONLY the very first time
  // (roles.json not yet present). Once roles.json exists it is the live store of record,
  // possibly already edited by an operator (role.create/update/delete) — it must never be
  // regenerated/clobbered from the legacy file on a later boot.
  if (!existsSync(newRolesFile) && existsSync(oldRolesFile)) {
    let oldRows: unknown[];
    try {
      oldRows = JSON.parse(readFileSync(oldRolesFile, "utf8")) as unknown[];
    } catch (err) {
      throw new Error(
        `corrupt legacy session-role state in ${oldRolesFile}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
      );
    }
    const seeded: RoleSpec[] = oldRows.map((row) => RoleSpecSchema.parse(row));
    for (const spec of seeded) console.error(`[roles-migration] seeded library role "${spec.name}" from legacy session-roles.json`);
    writeJsonAtomic(newRolesFile, seeded);
  }

  // Steps 3-5: migrate team.roles[key] rows to bindings + drop sharedRoles. Stable order
  // (team array order as persisted, role keys sorted) so repeated runs are deterministic.
  if (!existsSync(teamsFile)) return;
  let teams: Array<Record<string, unknown>>;
  try {
    teams = JSON.parse(readFileSync(teamsFile, "utf8")) as Array<Record<string, unknown>>;
  } catch (err) {
    throw new Error(`corrupt coordination state in ${teamsFile}: ${(err as Error).message} — fix or remove the file and restart chimerad`);
  }

  const existingLibraryNames = new Set<string>(
    existsSync(newRolesFile) ? (JSON.parse(readFileSync(newRolesFile, "utf8")) as Array<{ name: string }>).map((r) => r.name) : [],
  );
  const newLibraryEntries: RoleSpec[] = [];
  let teamsChanged = false;

  const migratedTeams = teams.map((team) => {
    const teamName = String(team["name"]);
    const roles = (team["roles"] ?? {}) as Record<string, unknown>;
    const hadSharedRoles = "sharedRoles" in team;
    let rolesChanged = false;
    const nextRoles: Record<string, unknown> = {};
    for (const key of Object.keys(roles).sort()) {
      const value = roles[key];
      if (isRoleBinding(value)) { nextRoles[key] = value; continue; } // already migrated — idempotent re-run
      const qualifiedName = `${teamName}.${key}`;
      if (!existingLibraryNames.has(qualifiedName)) {
        const spec = RoleSpecSchema.parse({ ...(value as Record<string, unknown>), name: qualifiedName });
        newLibraryEntries.push(spec);
        existingLibraryNames.add(qualifiedName);
      }
      nextRoles[key] = { role: qualifiedName, overrides: {} };
      rolesChanged = true;
      console.error(`[roles-migration] team "${teamName}": role "${key}" -> library entry "${qualifiedName}"`);
    }
    if (!rolesChanged && !hadSharedRoles) return team; // nothing to do for this team
    teamsChanged = true;
    const { sharedRoles: _sharedRoles, ...rest } = team;
    return { ...rest, roles: nextRoles };
  });

  if (newLibraryEntries.length > 0) {
    const merged = [
      ...(existsSync(newRolesFile) ? (JSON.parse(readFileSync(newRolesFile, "utf8")) as unknown[]) : []),
      ...newLibraryEntries,
    ];
    writeJsonAtomic(newRolesFile, merged);
  }
  if (teamsChanged) writeJsonAtomic(teamsFile, migratedTeams);
}
