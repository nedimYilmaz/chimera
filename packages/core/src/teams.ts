import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TeamSpecSchema, type TeamSpec } from "@chimera/protocol";
import type { EventLog } from "./events.js";

export class UnknownTeamError extends Error {
  code = "protocol" as const;
  name = "UnknownTeamError";
}

export class DuplicateTeamError extends Error {
  code = "protocol" as const;
  name = "DuplicateTeamError";
}

// D11: only maxConcurrent/purpose/queue/roles are patchable — name and createdBy are
// immutable identity fields. `roles` is included in the shape but the running-members
// guard (a team must have zero live members) lives in engine.ts, which alone has
// scheduler access; TeamManager itself has no opinion on what's "safe" to patch.
export type TeamUpdateInput = {
  maxConcurrent?: number;
  purpose?: string | null;
  queue?: string | null;
  roles?: TeamSpec["roles"];
  // PROJECT-NATIVE-TEAMS T3: internal-only — the RPC's TeamUpdateParams.patch (engine.ts)
  // never exposes this field; only engine.ts's private syncProjectTeam patches it, always
  // alongside `roles`, when re-materializing a project's discovered roles.
  discoveredRoles?: string[];
};

export class TeamManager {
  private teams = new Map<string, TeamSpec>();
  private file: string;

  constructor(dir: string, private events: EventLog) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "teams.json");
    if (existsSync(this.file)) {
      try {
        for (const t of JSON.parse(readFileSync(this.file, "utf8")) as unknown[]) {
          const spec = TeamSpecSchema.parse(t);
          this.teams.set(spec.name, spec);
        }
      } catch (err) {
        // Defined corrupt-file behavior (not accidental): fail fast, name the
        // file, say how to recover. No silent quarantine — a coordinator
        // silently dropping teams on disk corruption is worse than a loud crash.
        throw new Error(
          `corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`,
        );
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;                          // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify([...this.teams.values()], null, 2));
    renameSync(tmp, this.file);
  }

  create(input: unknown): TeamSpec {
    const spec = TeamSpecSchema.parse(input);
    if (this.teams.has(spec.name)) throw new DuplicateTeamError(`team "${spec.name}" already exists`);
    this.teams.set(spec.name, spec);
    this.save();
    this.events.append({
      agentId: `team:${spec.name}`,
      kind: "status",
      data: { team: spec.name, state: "created", roles: Object.keys(spec.roles), queue: spec.queue },
    });
    return spec;
  }

  update(name: string, patch: TeamUpdateInput): TeamSpec {
    const existing = this.get(name);   // throws UnknownTeamError
    const spec = TeamSpecSchema.parse({
      ...existing,
      ...(patch.maxConcurrent !== undefined ? { maxConcurrent: patch.maxConcurrent } : {}),
      ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
      ...(patch.queue !== undefined ? { queue: patch.queue } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.discoveredRoles !== undefined ? { discoveredRoles: patch.discoveredRoles } : {}),
    });
    this.teams.set(name, spec);
    this.save();
    this.events.append({
      agentId: `team:${name}`, kind: "status",
      data: { team: name, state: "updated", patch: Object.keys(patch) },
    });
    return spec;
  }

  get(name: string): TeamSpec {
    const t = this.teams.get(name);
    if (!t) throw new UnknownTeamError(`unknown team "${name}"`);
    return t;
  }

  list(): TeamSpec[] {
    return [...this.teams.values()];
  }

  // Graceful drain: dissolve removes the team from the registry so no new work
  // is scheduled against it, but does NOT kill agents already running under it.
  dissolve(name: string): void {
    this.get(name);
    this.teams.delete(name);
    this.save();
    this.events.append({ agentId: `team:${name}`, kind: "status", data: { team: name, state: "dissolved" } });
  }
}
