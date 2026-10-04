import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RoleSpecSchema, BUILTIN_ROLES, type RoleSpec } from "@chimera/protocol";

export class UnknownRoleError extends Error {
  code = "protocol" as const;
  name = "UnknownRoleError";
}

export class DuplicateRoleError extends Error {
  code = "protocol" as const;
  name = "DuplicateRoleError";
}

// ROLES-UNIFY §2/§8 S2: the unified role library (replaces SessionRoleStore) — one global
// registry over roles.json, keyed by RoleNameSchema (bare user names AND <team>.<key>
// qualified names alike, §3.2). Structurally identical load/seed/save pattern to the old
// SessionRoleStore it replaces. roles-migration.ts (run once at boot, BEFORE this
// constructor ever sees the file) is what actually moves data out of the legacy
// session-roles.json and inline team-role templates into roles.json — this class only
// ever reads/writes the unified file.
export class RoleStore {
  private roles = new Map<string, RoleSpec>();
  private file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "roles.json");
    if (existsSync(this.file)) {
      try {
        for (const r of JSON.parse(readFileSync(this.file, "utf8")) as unknown[]) {
          const spec = RoleSpecSchema.parse(r);
          this.roles.set(spec.name, spec);
        }
      } catch (err) {
        // Same defined corrupt-file policy as TeamManager: fail fast and loud, no silent
        // quarantine of on-disk role state.
        throw new Error(
          `corrupt role library state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
    let seeded = false;
    for (const builtin of BUILTIN_ROLES) {
      if (!this.roles.has(builtin.name)) {
        this.roles.set(builtin.name, builtin);
        seeded = true;
      }
    }
    if (seeded) this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.roles.values()], null, 2));
    renameSync(tmp, this.file);
  }

  create(input: unknown): RoleSpec {
    const spec = RoleSpecSchema.parse(input);
    if (this.roles.has(spec.name)) throw new DuplicateRoleError(`role "${spec.name}" already exists`);
    this.roles.set(spec.name, spec);
    this.save();
    return spec;
  }

  // ROLES-UNIFY §7 step 3/4: internal-only write for the boot migration's <team>.<key>
  // entries and syncProjectTeam's discovered-role entries (engine.ts) — both need to
  // write/overwrite a team-qualified name on every run without a create-vs-update branch,
  // bypassing role.create's dotted-name/duplicate rejection (an RPC-layer concern, not a
  // store invariant — the qualifier namespace is reserved from HAND-TYPED names, not from
  // the automatic writers that own it).
  upsert(input: unknown): RoleSpec {
    const spec = RoleSpecSchema.parse(input);
    this.roles.set(spec.name, spec);
    this.save();
    return spec;
  }

  update(name: string, patch: Partial<Omit<RoleSpec, "name">>): RoleSpec {
    const existing = this.get(name); // throws UnknownRoleError
    const spec = RoleSpecSchema.parse({ ...existing, ...patch, name });
    this.roles.set(name, spec);
    this.save();
    return spec;
  }

  get(name: string): RoleSpec {
    const r = this.roles.get(name);
    if (!r) throw new UnknownRoleError(`unknown role "${name}"`);
    return r;
  }

  list(): RoleSpec[] {
    return [...this.roles.values()];
  }

  delete(name: string): void {
    this.get(name); // throws UnknownRoleError
    this.roles.delete(name);
    this.save();
  }
}
