import { describe, it, expect } from "vitest";
import { RoleNameSchema, RoleSpecSchema, RoleBindingSchema, TeamSpecSchema } from "../src/index.js";

// ROLES-UNIFY S1 acceptance (spec §8): RoleNameSchema accepts exactly zero or one `.` qualifier.
describe("RoleNameSchema — zero or one dot (§3.2 team-qualifier namespace)", () => {
  it("accepts a bare, undotted name", () => {
    expect(RoleNameSchema.parse("worker")).toBe("worker");
    expect(RoleNameSchema.parse("worker-2_x")).toBe("worker-2_x");
  });
  it("accepts exactly one dot (the team-qualified form)", () => {
    expect(RoleNameSchema.parse("chimera-dev.worker")).toBe("chimera-dev.worker");
  });
  it("rejects two or more dots", () => {
    expect(() => RoleNameSchema.parse("a.b.c")).toThrow();
    expect(() => RoleNameSchema.parse("chimera-dev.worker.extra")).toThrow();
  });
  it("rejects a leading or trailing dot (each side of the dot needs at least one char)", () => {
    expect(() => RoleNameSchema.parse(".worker")).toThrow();
    expect(() => RoleNameSchema.parse("worker.")).toThrow();
  });
  it("rejects an empty string", () => {
    expect(() => RoleNameSchema.parse("")).toThrow();
  });
  it("rejects characters outside letters/digits/_/-/. (e.g. '/', space)", () => {
    expect(() => RoleNameSchema.parse("team/worker")).toThrow();
    expect(() => RoleNameSchema.parse("bad name")).toThrow();
  });
});

// ROLES-UNIFY S1 acceptance (spec §8): the new schemas parse the migration's (§7) OUTPUT shapes
// byte-stably on a second parse. Built by hand from §7's description — S2 builds the real
// migration; this only asserts the protocol schemas accept and round-trip its target shapes.
describe("post-migration shapes parse byte-stably (spec §7/§8)", () => {
  it("roles.json: a migrated team-qualified library entry (§3.2, chimera-dev.worker) round-trips", () => {
    // §7 step 3: the OLD inline RoleTemplate-shaped content becomes a library entry named
    // <team>.<key>, unchanged field-for-field (zero-drift by construction).
    const migratedLibraryEntry = {
      name: "chimera-dev.worker",
      cwd: "/repo/chimera",
      displayLabel: undefined,
      account: "auto",
      provider: undefined,
      isolation: "worktree",
      workdirKey: undefined,
      model: "claude-sonnet-5",
      effort: "high",
      instructions: "You are the chimera-dev worker.",
      resultSchema: undefined,
      permissionProfile: "acceptEdits",
      acknowledgeCodexFullAccessRisk: false,
      maxTurns: 40,
      turnLimitPolicy: "fail",
      idleTimeoutMs: undefined,
      maxTurnDurationMs: undefined,
      inherit: { settingSources: [] },
      mcpServers: {},
      mcpToolAllowlist: undefined,
      plugins: [],
      orchestration: { allow: true, maxDepth: 2 },
      crossProviderFailover: false,
      deliverTo: null,
      deliverWake: undefined,
      maxBudgetUsd: null,
      conductor: false,
      session: false,
      persistent: false,
      poolSize: undefined,
      on: { permissionRequest: "auto" },
      providerOptions: {},
      resume: null,
      resumeOnly: false,
      cause: null,
      skills: [],
    };
    const parsed = RoleSpecSchema.parse(migratedLibraryEntry);
    const firstEncode = JSON.parse(JSON.stringify(parsed));
    const reparsed = RoleSpecSchema.parse(firstEncode);
    const secondEncode = JSON.parse(JSON.stringify(reparsed));
    expect(secondEncode).toEqual(firstEncode);
  });

  // AGENT-AUTONOMY: RoleSpecSchema is AgentSpecSchema.omit({prompt,content}).extend({...}) — a
  // role inherits any new AgentSpec field for free, no RoleSpecSchema edit needed. Confirms that
  // stays true for `autonomy` rather than assuming it.
  it("AGENT-AUTONOMY: RoleSpecSchema inherits autonomy from AgentSpecSchema (defaults \"ask\", accepts \"full\")", () => {
    expect(RoleSpecSchema.parse({ name: "worker" }).autonomy).toBe("ask");
    expect(RoleSpecSchema.parse({ name: "worker", autonomy: "full" }).autonomy).toBe("full");
  });

  it("roles.json: the 4 re-seeded BUILTIN_ROLES parse byte-stably on a second parse", () => {
    // §7 step 2: the 4 builtins re-seed as BUILTIN_ROLES unchanged.
    const builtin = RoleSpecSchema.parse({ name: "blank" });
    const encoded = JSON.parse(JSON.stringify(builtin));
    const reparsed = RoleSpecSchema.parse(encoded);
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(encoded);
  });

  it("teams.json: a migrated team's roles[key] is a {role, overrides} binding, sharedRoles absent (§7 step 3/5)", () => {
    // §3.2's concrete table: chimera-dev's `worker`/`codex-worker`/`pers-worker` keys become
    // bindings pointing at `chimera-dev.worker` etc., with empty overrides (zero-drift).
    const migratedTeam = {
      name: "chimera-dev",
      roles: {
        worker: { role: "chimera-dev.worker", overrides: {} },
        "codex-worker": { role: "chimera-dev.codex-worker", overrides: {} },
        "pers-worker": { role: "chimera-dev.pers-worker", overrides: {} },
      },
      maxConcurrent: 4,
      queue: null,
      createdBy: null,
      purpose: null,
      discoveredRoles: [],
      projectNative: null,
    };
    const parsed = TeamSpecSchema.parse(migratedTeam);
    expect(parsed).not.toHaveProperty("sharedRoles");
    const firstEncode = JSON.parse(JSON.stringify(parsed));
    const reparsed = TeamSpecSchema.parse(firstEncode);
    const secondEncode = JSON.parse(JSON.stringify(reparsed));
    expect(secondEncode).toEqual(firstEncode);
  });

  it("teams.json: a discoveredRoles-provenance binding round-trips identically (§7 step 4)", () => {
    const migratedTeam = {
      name: "PROJ-10308-native",
      roles: { developer: { role: "PROJ-10308-native.developer", overrides: {} } },
      maxConcurrent: 4, queue: null, createdBy: null, purpose: null,
      discoveredRoles: ["developer"], projectNative: "PROJ-10308-native",
    };
    const parsed = TeamSpecSchema.parse(migratedTeam);
    const firstEncode = JSON.parse(JSON.stringify(parsed));
    const reparsed = TeamSpecSchema.parse(firstEncode);
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(firstEncode);
  });

  it("a binding with a non-empty override patch round-trips byte-stably (RoleBindingSchema directly)", () => {
    const binding = { role: "chimera-dev.worker", overrides: { model: "opus", persistent: true } };
    const parsed = RoleBindingSchema.parse(binding);
    const firstEncode = JSON.parse(JSON.stringify(parsed));
    const reparsed = RoleBindingSchema.parse(firstEncode);
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(firstEncode);
  });
});
