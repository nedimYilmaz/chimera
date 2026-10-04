import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { TeamManager, DuplicateTeamError, UnknownTeamError } from "@chimera/core/teams";

const TEAM = {
  name: "builders",
  roles: {
    dev: { role: "blank", overrides: { cwd: "/tmp/proj", account: "main", isolation: "none" } },
    qa: { role: "blank", overrides: { cwd: "/tmp/proj", account: "second", isolation: "none", permissionProfile: "readOnly" } },
  },
  maxConcurrent: 2,
  queue: "work",
};

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-team-"));
  const events = new EventLog(dir);
  return { dir, events, teams: new TeamManager(dir, events) };
}

describe("TeamManager", () => {
  it("creates with binding overrides applied, lists, gets, persists across restart", () => {
    const { dir, events, teams } = rig();
    const created = teams.create(TEAM);
    expect(created.roles["qa"]!.overrides["permissionProfile"]).toBe("readOnly");
    expect(created.roles["dev"]!.overrides["permissionProfile"]).toBeUndefined();   // no override — resolves to the library's own default at read/spawn time
    expect(teams.list().map((t) => t.name)).toEqual(["builders"]);
    expect(teams.get("builders").queue).toBe("work");

    const reloaded = new TeamManager(dir, events);                          // simulated restart
    expect(reloaded.get("builders").maxConcurrent).toBe(2);
    expect(Object.keys(reloaded.get("builders").roles)).toEqual(["dev", "qa"]);
  });

  it("rejects duplicates and unknown lookups with typed errors", () => {
    const { teams } = rig();
    teams.create(TEAM);
    expect(() => teams.create(TEAM)).toThrow(DuplicateTeamError);
    expect(() => teams.get("ghost")).toThrow(UnknownTeamError);
    expect(() => teams.dissolve("ghost")).toThrow(UnknownTeamError);
  });

  it("dissolve removes the team and both transitions are status events", () => {
    const { events, teams } = rig();
    teams.create(TEAM);
    teams.dissolve("builders");
    expect(teams.list()).toEqual([]);
    const evs = events.tail("team:builders", 10);
    expect(evs.map((e) => e.data["state"])).toEqual(["created", "dissolved"]);
    expect(evs.every((e) => e.kind === "status")).toBe(true);
  });

  // ROLES-UNIFY §3.1/§4: a binding's `overrides` is a sparse z.record(string, unknown) bag by
  // design (protocol/src/index.ts, RoleBindingSchema) — TeamManager.create no longer rejects a
  // stray `prompt`/`content` key inside it, unlike the old inline RoleTemplate row (which WAS a
  // strict AgentSpec.omit({prompt,content})). That guarantee now lives one layer down, on the
  // LIBRARY role itself (RoleSpecSchema.omit({prompt,content}) — same omission, just moved).
  it("accepts a stray prompt/content key inside a binding's overrides (validated only at resolve/spawn time, not bind time)", () => {
    const { teams } = rig();
    const created = teams.create({ ...TEAM, name: "ok", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", prompt: "nope" } } } });
    expect(created.roles["dev"]!.overrides["prompt"]).toBe("nope");
  });

  it("createdBy round-trips through create/get/list and persists across a reload (T9d)", () => {
    const { dir, events, teams } = rig();
    const created = teams.create({ ...TEAM, createdBy: "agentX" });
    expect(created.createdBy).toBe("agentX");
    expect(teams.get("builders").createdBy).toBe("agentX");
    expect(teams.list()[0]!.createdBy).toBe("agentX");

    const reloaded = new TeamManager(dir, events);                          // simulated restart
    expect(reloaded.get("builders").createdBy).toBe("agentX");
  });

  it("createdBy defaults to null when omitted and persists as null across a reload", () => {
    const { dir, events, teams } = rig();
    const created = teams.create(TEAM);
    expect(created.createdBy).toBeNull();

    const reloaded = new TeamManager(dir, events);
    expect(reloaded.get("builders").createdBy).toBeNull();
  });

  it("fails fast with a clear error naming the file when teams.json is corrupt", () => {
    const { dir, events } = rig();
    writeFileSync(join(dir, "teams.json"), "{ truncated");
    expect(() => new TeamManager(dir, events)).toThrow(/teams\.json/);
  });
});
