import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { migrateRolesOnBoot } from "../src/roles-migration.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "chimera-roles-migration-"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A real-shaped fixture mirroring the spec's §3.2 table (7 teams, old inline
// RoleTemplate rows) — small subset, same structural shape (role keys with cwd/account/
// isolation, a couple carrying `sharedRoles`/`discoveredRoles`).
const OLD_TEAMS = [
  {
    name: "chimera-dev",
    roles: {
      worker: { cwd: "/repo", account: "auto", isolation: "worktree" },
      "codex-worker": { cwd: "/repo", account: "codex", isolation: "worktree" },
      "pers-worker": { cwd: "/repo", account: "claude-pers", isolation: "worktree" },
    },
    maxConcurrent: 5, queue: "chimera-tasks", createdBy: null, purpose: "dev team",
    discoveredRoles: [], sharedRoles: [],
  },
  {
    name: "chimera-janitor",
    roles: { janitor: { cwd: "/repo", account: "auto", isolation: "worktree" } },
    maxConcurrent: 1, queue: "janitor-tasks", createdBy: null, purpose: null,
    discoveredRoles: [], sharedRoles: [],
  },
];

const OLD_SESSION_ROLES = [
  { name: "aws", permissionProfile: "full", instructions: "cloud", skills: [] },
  { name: "review", permissionProfile: "acceptEdits", instructions: "review", skills: ["code-review:ai-review-agentic"] },
];

describe("migrateRolesOnBoot (ROLES-UNIFY §7)", () => {
  it("migrates every team-role row to a <team>.<key> qualified binding, exactly per §3.2's naming scheme", () => {
    const home = tmpHome();
    writeFileSync(join(home, "teams.json"), JSON.stringify(OLD_TEAMS));
    writeFileSync(join(home, "session-roles.json"), JSON.stringify(OLD_SESSION_ROLES));

    migrateRolesOnBoot(home);

    const teams = readJson(join(home, "teams.json")) as Array<Record<string, unknown>>;
    const dev = teams.find((t) => t["name"] === "chimera-dev")!;
    expect(dev["roles"]).toEqual({
      worker: { role: "chimera-dev.worker", overrides: {} },
      "codex-worker": { role: "chimera-dev.codex-worker", overrides: {} },
      "pers-worker": { role: "chimera-dev.pers-worker", overrides: {} },
    });
    expect(dev).not.toHaveProperty("sharedRoles");

    const janitor = teams.find((t) => t["name"] === "chimera-janitor")!;
    expect(janitor["roles"]).toEqual({ janitor: { role: "chimera-janitor.janitor", overrides: {} } });

    const roles = readJson(join(home, "roles.json")) as Array<{ name: string; cwd?: string }>;
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual([
      "aws", "chimera-dev.codex-worker", "chimera-dev.pers-worker", "chimera-dev.worker",
      "chimera-janitor.janitor", "review",
    ]);
    // zero-drift by construction: the library entry carries the exact old inline content.
    expect(roles.find((r) => r.name === "chimera-dev.worker")!.cwd).toBe("/repo");
  });

  it("is idempotent: a second run changes neither file at all (byte-identical)", () => {
    const home = tmpHome();
    writeFileSync(join(home, "teams.json"), JSON.stringify(OLD_TEAMS));
    writeFileSync(join(home, "session-roles.json"), JSON.stringify(OLD_SESSION_ROLES));

    migrateRolesOnBoot(home);
    const teamsAfterFirst = readFileSync(join(home, "teams.json"), "utf8");
    const rolesAfterFirst = readFileSync(join(home, "roles.json"), "utf8");

    migrateRolesOnBoot(home);
    expect(readFileSync(join(home, "teams.json"), "utf8")).toBe(teamsAfterFirst);
    expect(readFileSync(join(home, "roles.json"), "utf8")).toBe(rolesAfterFirst);
  });

  it("writes .pre-roles-unify.bak for both files, once, and never overwrites it on a later run", () => {
    const home = tmpHome();
    writeFileSync(join(home, "teams.json"), JSON.stringify(OLD_TEAMS));
    writeFileSync(join(home, "session-roles.json"), JSON.stringify(OLD_SESSION_ROLES));

    migrateRolesOnBoot(home);
    expect(existsSync(join(home, "teams.json.pre-roles-unify.bak"))).toBe(true);
    expect(existsSync(join(home, "session-roles.json.pre-roles-unify.bak"))).toBe(true);
    const bakContent = readFileSync(join(home, "teams.json.pre-roles-unify.bak"), "utf8");
    expect(JSON.parse(bakContent)).toEqual(OLD_TEAMS); // the backup is the PRE-migration shape

    // simulate an operator edit landing after migration — a second run must not clobber the .bak
    writeFileSync(join(home, "teams.json"), JSON.stringify([{ name: "x" }]));
    migrateRolesOnBoot(home);
    expect(readFileSync(join(home, "teams.json.pre-roles-unify.bak"), "utf8")).toBe(bakContent);
  });

  it("never regenerates roles.json from the legacy file once roles.json already exists (an operator's post-migration edits survive a later boot)", () => {
    const home = tmpHome();
    writeFileSync(join(home, "teams.json"), JSON.stringify(OLD_TEAMS));
    writeFileSync(join(home, "session-roles.json"), JSON.stringify(OLD_SESSION_ROLES));
    migrateRolesOnBoot(home);

    const edited = (readJson(join(home, "roles.json")) as Array<Record<string, unknown>>)
      .map((r) => (r["name"] === "aws" ? { ...r, instructions: "operator-edited" } : r));
    writeFileSync(join(home, "roles.json"), JSON.stringify(edited));

    migrateRolesOnBoot(home);

    const roles = readJson(join(home, "roles.json")) as Array<{ name: string; instructions?: string }>;
    expect(roles.find((r) => r.name === "aws")!.instructions).toBe("operator-edited");
  });

  it("no teams.json / no session-roles.json ⇒ a complete no-op, no files created", () => {
    const home = tmpHome();
    migrateRolesOnBoot(home);
    expect(existsSync(join(home, "teams.json"))).toBe(false);
    expect(existsSync(join(home, "roles.json"))).toBe(false);
  });
});
