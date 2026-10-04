import { describe, it, expect } from "vitest";
import { ProjectSpecSchema, TeamSpecSchema, RoleSpecSchema } from "@chimera/protocol";

describe("ProjectSpecSchema.loadProjectSettings (PROJECT-NATIVE-TEAMS T1)", () => {
  it("defaults to true", () => {
    const p = ProjectSpecSchema.parse({ name: "proj", path: "/tmp/proj", createdAt: 1 });
    expect(p.loadProjectSettings).toBe(true);
  });

  it("round-trips an explicit false through parse -> encode -> parse", () => {
    const input = { name: "proj", path: "/tmp/proj", createdAt: 1, loadProjectSettings: false };
    const parsed = ProjectSpecSchema.parse(input);
    expect(parsed.loadProjectSettings).toBe(false);

    const reparsed = ProjectSpecSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("parses a pre-existing persisted spec (no loadProjectSettings field) unaffected — default fills in", () => {
    // Simulates a projects.json row written before this change landed.
    const legacy = {
      name: "proj", path: "/tmp/proj", origin: null, teams: ["team-a"],
      queue: "q-a", createdAt: 1700000000000, archived: false,
      autoConductor: true, conductorId: null,
    };
    const parsed = ProjectSpecSchema.parse(legacy);
    expect(parsed.loadProjectSettings).toBe(true);
    expect(parsed.teams).toEqual(["team-a"]);
  });

  it("byte-identical parse: a full pre-existing projects.json row round-trips unchanged", () => {
    const legacy = {
      name: "proj", path: "/tmp/proj", origin: "https://example.com/repo.git",
      teams: ["team-a", "team-b"], queue: "q-a", createdAt: 1700000000000,
      archived: false, autoConductor: false, conductorId: "agent-9",
    };
    const parsed = ProjectSpecSchema.parse(legacy);
    const reencoded = JSON.parse(JSON.stringify(parsed));
    // Every nullable-default field added to ProjectSpecSchema must show up here: that is the
    // whole point of this test — an old row gains exactly the new keys and nothing else.
    expect(reencoded).toEqual({
      ...legacy, loadProjectSettings: true, permissionProfile: null, worktreeSetup: null,
      conductorAccount: null, conductorModel: null,
    });
  });
});

// PROJECT-CREATE-PERMISSION-PROFILE: mirrors the loadProjectSettings suite above exactly —
// same nullable-default-so-old-rows-parse-byte-identically discipline, one field over.
describe("ProjectSpecSchema.permissionProfile (PROJECT-CREATE-PERMISSION-PROFILE)", () => {
  it("defaults to null (no override — falls back to global config)", () => {
    const p = ProjectSpecSchema.parse({ name: "proj", path: "/tmp/proj", createdAt: 1 });
    expect(p.permissionProfile).toBeNull();
  });

  it("round-trips an explicit value through parse -> encode -> parse", () => {
    const input = { name: "proj", path: "/tmp/proj", createdAt: 1, permissionProfile: "full" };
    const parsed = ProjectSpecSchema.parse(input);
    expect(parsed.permissionProfile).toBe("full");
    const reparsed = ProjectSpecSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("parses a pre-existing persisted spec (no permissionProfile field) unaffected — default fills in", () => {
    const legacy = {
      name: "proj", path: "/tmp/proj", origin: null, teams: ["team-a"],
      queue: "q-a", createdAt: 1700000000000, archived: false,
      autoConductor: true, conductorId: null,
    };
    const parsed = ProjectSpecSchema.parse(legacy);
    expect(parsed.permissionProfile).toBeNull();
  });

  it("rejects an invalid profile value", () => {
    expect(() => ProjectSpecSchema.parse({ name: "proj", path: "/tmp/proj", createdAt: 1, permissionProfile: "bogus" })).toThrow();
  });
});

describe("TeamSpecSchema.discoveredRoles / projectNative (PROJECT-NATIVE-TEAMS T1)", () => {
  it("default discoveredRoles to [] and projectNative to null", () => {
    const t = TeamSpecSchema.parse({ name: "crew", roles: { dev: { role: "dev" } } });
    expect(t.discoveredRoles).toEqual([]);
    expect(t.projectNative).toBeNull();
  });

  it("round-trips explicit discoveredRoles/projectNative through parse -> encode -> parse", () => {
    const input = {
      name: "crew", roles: { dev: { role: "dev" } },
      discoveredRoles: ["dev", "qa"], projectNative: "my-proj",
    };
    const parsed = TeamSpecSchema.parse(input);
    expect(parsed.discoveredRoles).toEqual(["dev", "qa"]);
    expect(parsed.projectNative).toBe("my-proj");

    const reparsed = TeamSpecSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it("parses a pre-existing persisted teams.json row (no new fields) unaffected — defaults fill in", () => {
    const legacy = {
      name: "crew", roles: { dev: { role: "dev" } }, maxConcurrent: 4,
      queue: null, createdBy: null, purpose: null,
    };
    const parsed = TeamSpecSchema.parse(legacy);
    expect(parsed.discoveredRoles).toEqual([]);
    expect(parsed.projectNative).toBeNull();
  });

  it("byte-identical parse: a full pre-existing teams.json row's team-level fields round-trip unchanged", () => {
    // roles is intentionally excluded here: a RoleBindingSchema row (ROLES-UNIFY §3.1) is its
    // own two-field shape, unrelated to this test's team-level-fields focus — see the dedicated
    // "RoleSpecSchema stays unchanged" block below for the library-role guarantee.
    const legacy = {
      name: "crew", roles: { dev: { role: "dev", overrides: { persistent: true, poolSize: 2 } } },
      maxConcurrent: 4, queue: "q1", createdBy: "agentX", purpose: "does stuff",
    };
    const parsed = TeamSpecSchema.parse(legacy);
    const { roles: _roles, ...rest } = JSON.parse(JSON.stringify(parsed));
    expect(rest).toEqual({
      name: "crew", maxConcurrent: 4, queue: "q1", createdBy: "agentX", purpose: "does stuff",
      discoveredRoles: [], projectNative: null,
    });
  });

  it("still rejects an unknown top-level key (strict)", () => {
    expect(() => TeamSpecSchema.parse({
      name: "crew", roles: { dev: { role: "dev" } }, bogus: 1,
    })).toThrow();
  });
});

describe("RoleSpecSchema stays unchanged — no provenance on the role (strict-spawn constraint)", () => {
  it("rejects a role carrying discoveredRoles/projectNative directly", () => {
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", discoveredRoles: ["dev"] })).toThrow();
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp", projectNative: "my-proj" })).toThrow();
  });

  it("a plain valid role spec still parses (unaffected by this change)", () => {
    expect(() => RoleSpecSchema.parse({ name: "dev", cwd: "/tmp" })).not.toThrow();
  });
});
