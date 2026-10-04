import { describe, it, expect } from "vitest";
import {
  teamRoleUsage,
  sessionRoleUsage,
  attachedTeamNames,
  buildRemoveTeamRolePatch,
  buildSessionRolePatch,
  buildRoleBindingOverridePatch,
  builtinDiff,
  emptyAgent,
  roleConfig,
  overridesOf,
  resolvedRoleBindingSpec,
  overriddenFieldsOf,
  type AgentView,
} from "@chimera/ui-state";

// ROLES-UNIFY S4 (docs/superpowers/specs/2026-07-28-roles-unify.md §8 S4/§6.4): the
// rewritten usage join (bindings, not sharedRoles), the removal-only RMW builder, the
// new sparse override-patch builder, and the builtin diff over the widened field set.

function agent(overrides: Partial<AgentView>): AgentView {
  return { ...emptyAgent(overrides.agentId ?? "a1"), conductor: false, session: false, ...overrides };
}

describe("teamRoleUsage", () => {
  it("finds live agents by membership {team, role}", () => {
    const agents: Record<string, AgentView> = {
      a1: agent({ agentId: "a1", state: "running", membership: { team: "alpha", role: "builder" } }),
      a2: agent({ agentId: "a2", state: "done", membership: { team: "alpha", role: "builder" } }),
      a3: agent({ agentId: "a3", state: "running", membership: { team: "alpha", role: "reviewer" } }),
      a4: agent({ agentId: "a4", state: "running", membership: { team: "beta", role: "builder" } }),
    };
    const usage = teamRoleUsage(agents, "alpha", "builder");
    expect(usage.liveAgents.map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
    expect(usage.liveCount).toBe(1);   // only a1 is running; a2 is done
  });
});

describe("sessionRoleUsage", () => {
  it("finds live agents by sessionRole", () => {
    const agents: Record<string, AgentView> = {
      a1: agent({ agentId: "a1", state: "running", sessionRole: "aws" }),
      a2: agent({ agentId: "a2", state: "running", sessionRole: "review" }),
      a3: agent({ agentId: "a3", state: "paused", sessionRole: "aws" }),
    };
    const usage = sessionRoleUsage(agents, "aws");
    expect(usage.liveAgents.map((a) => a.agentId).sort()).toEqual(["a1", "a3"]);
    expect(usage.liveCount).toBe(2);
  });

  it("degrades cleanly when sessionRole is absent everywhere (older daemon / S1 not landed)", () => {
    const agents: Record<string, AgentView> = {
      a1: agent({ agentId: "a1", state: "running" }),   // sessionRole undefined -- emptyAgent default
      a2: agent({ agentId: "a2", state: "running", membership: { team: "alpha", role: "builder" } }),
    };
    const usage = sessionRoleUsage(agents, "aws");
    expect(usage.liveAgents).toEqual([]);
    expect(usage.liveCount).toBe(0);
  });
});

describe("attachedTeamNames", () => {
  it("scans roles[key].role bindings (ROLES-UNIFY §3.1 -- sharedRoles is gone)", () => {
    const teams = [
      { name: "alpha", roles: { builder: { role: "aws", overrides: {} }, reviewer: { role: "review", overrides: {} } } },
      { name: "beta", roles: { triage: { role: "review", overrides: { model: "haiku" } } } },
      { name: "gamma", roles: { solo: { role: "blank", overrides: {} } } },
    ];
    expect(attachedTeamNames(teams, "review").sort()).toEqual(["alpha", "beta"]);
    expect(attachedTeamNames(teams, "aws")).toEqual(["alpha"]);
  });

  it("reports a team once even when two keys bind the same library role", () => {
    const teams = [
      { name: "alpha", roles: { a: { role: "aws", overrides: {} }, b: { role: "aws", overrides: { model: "opus" } } } },
    ];
    expect(attachedTeamNames(teams, "aws")).toEqual(["alpha"]);
  });

  it("degrades cleanly to [] when roles is absent/malformed (older daemon / pre-migration shape)", () => {
    const teams = [{ name: "alpha" }, { name: "beta", roles: {} }, { name: "gamma", sharedRoles: ["aws"] }];
    expect(attachedTeamNames(teams, "aws")).toEqual([]);
  });
});

describe("buildRemoveTeamRolePatch", () => {
  it("removes exactly the named key, preserving sibling RoleBinding values byte-identically", () => {
    const spec = {
      roles: {
        builder: { role: "chimera-dev.worker", overrides: { model: "opus" } },
        reviewer: { role: "review", overrides: {} },
      },
    };
    const patch = buildRemoveTeamRolePatch(spec, "builder");
    expect(patch).toEqual({ roles: { reviewer: { role: "review", overrides: {} } } });
    expect((patch.roles as Record<string, unknown>)["reviewer"]).toBe(spec.roles.reviewer);
  });
});

describe("buildSessionRolePatch", () => {
  it("emits only changed keys over the widened RoleSpec field set (sparse -- role.update is not .partial())", () => {
    const prev = {
      model: "sonnet", permissionProfile: "full", instructions: "old", plugins: [], mcpToolAllowlist: {}, skills: [],
      effort: "medium", maxTurns: 40, persistent: false, poolSize: undefined, orchestration: { allow: true, maxDepth: 2 },
    };
    const next = { ...prev, instructions: "new", skills: ["a"], persistent: true };
    const patch = buildSessionRolePatch(prev, next);
    expect(patch).toEqual({ instructions: "new", skills: ["a"], persistent: true });
    // fields that didn't change are genuinely absent, not present-with-old-value
    expect("model" in patch).toBe(false);
    expect("effort" in patch).toBe(false);
    expect("orchestration" in patch).toBe(false);
  });

  it("emits {} when nothing changed", () => {
    const prev = { model: "sonnet", permissionProfile: "full" };
    expect(buildSessionRolePatch(prev, { ...prev })).toEqual({});
  });

  // AGENT-AUTONOMY: `autonomy` is a RoleSpec field like any other — must participate in the
  // sparse patch the same way permissionProfile does (present when changed, absent otherwise).
  it("includes autonomy when changed, omits it when unchanged", () => {
    const prev = { model: "sonnet", autonomy: "ask" };
    expect(buildSessionRolePatch(prev, { ...prev, autonomy: "full" })).toEqual({ autonomy: "full" });
    expect("autonomy" in buildSessionRolePatch(prev, { ...prev })).toBe(false);
  });
});

describe("buildRoleBindingOverridePatch", () => {
  it("emits only the fields the operator actually overrode vs the resolved/inherited value", () => {
    const resolved = {
      model: "sonnet", permissionProfile: "full", cwd: "/repo", persistent: false,
      orchestration: { allow: true, maxDepth: 2 }, instructions: "base",
    };
    const edited = { ...resolved, model: "opus" };
    const patch = buildRoleBindingOverridePatch(resolved, edited);
    expect(patch).toEqual({ model: "opus" });
    // every untouched key -- including nested-object ones -- is genuinely absent, not
    // present-with-the-inherited-value: this is the sparseness the operator's headline
    // requirement (editing the library role must still reach a non-overriding binding)
    // depends on.
    expect(Object.keys(patch)).toEqual(["model"]);
    expect("permissionProfile" in patch).toBe(false);
    expect("cwd" in patch).toBe(false);
    expect("orchestration" in patch).toBe(false);
    expect("instructions" in patch).toBe(false);
  });

  it("emits {} when the editor submits with nothing toggled to override", () => {
    const resolved = { model: "sonnet", cwd: "/repo", persistent: true };
    expect(buildRoleBindingOverridePatch(resolved, { ...resolved })).toEqual({});
  });

  it("resetting a field back to inherited drops it from the patch, not sets it undefined", () => {
    const resolved = { model: "sonnet", instructions: "base" };
    const editedThenReset = { model: "sonnet", instructions: "base" };   // editor snapped back to resolved
    const patch = buildRoleBindingOverridePatch(resolved, editedThenReset);
    expect(patch).toEqual({});
    expect("instructions" in patch).toBe(false);
  });
});

describe("roleConfig", () => {
  it("reads a flat spec's config badges + instructions", () => {
    expect(roleConfig({
      model: "claude-fable-5", permissionProfile: "acceptEdits", isolation: "worktree",
      maxTurns: 40, turnLimitPolicy: "fail", instructions: "you are the dev role.",
    })).toEqual({
      model: "claude-fable-5", permissionProfile: "acceptEdits", isolation: "worktree",
      maxTurns: 40, turnLimitPolicy: "fail", instructions: "you are the dev role.",
    });
  });

  it("degrades to nulls for missing/malformed fields", () => {
    expect(roleConfig(undefined)).toEqual({
      model: null, permissionProfile: null, isolation: null, maxTurns: null, turnLimitPolicy: null, instructions: null,
    });
    expect(roleConfig({ maxTurns: "40", instructions: "" })).toEqual({
      model: null, permissionProfile: null, isolation: null, maxTurns: null, turnLimitPolicy: null, instructions: null,
    });
  });
});

// ROLES-BINDING-CORRECTNESS: `roleConfig` reads a FLAT spec object — a raw `{role,
// overrides}` binding must be resolved first (resolvedRoleBindingSpec) or every field
// reads null regardless of what the binding actually sets. This is the exact bug: the
// app's TeamsScreen and the TUI's TeamDetailPane were calling roleConfig(binding)
// directly, so the team-role summary silently reported "default config" for every role.
describe("resolvedRoleBindingSpec / overridesOf / overriddenFieldsOf", () => {
  const LIBRARY = [
    { name: "dev", model: "claude-sonnet-5", permissionProfile: "acceptEdits", isolation: "worktree" },
  ];

  it("a binding WITHOUT overrides resolves to exactly the library role's config", () => {
    const binding = { role: "dev", overrides: {} };
    expect(roleConfig(resolvedRoleBindingSpec(binding, LIBRARY))).toMatchObject({
      model: "claude-sonnet-5", permissionProfile: "acceptEdits", isolation: "worktree",
    });
    expect(overriddenFieldsOf(binding)).toEqual([]);
  });

  it("a binding WITH overrides shows the pinned value, not the library default, and reports it as overridden", () => {
    const binding = { role: "dev", overrides: { model: "claude-opus-5" } };
    expect(roleConfig(resolvedRoleBindingSpec(binding, LIBRARY))).toMatchObject({
      model: "claude-opus-5", permissionProfile: "acceptEdits", isolation: "worktree",
    });
    expect(overriddenFieldsOf(binding)).toEqual(["model"]);
    expect(overridesOf(binding)).toEqual({ model: "claude-opus-5" });
  });

  it("reading a binding directly with roleConfig (the pre-fix bug) finds nothing", () => {
    const binding = { role: "dev", overrides: { model: "claude-opus-5", permissionProfile: "full" } };
    expect(roleConfig(binding)).toEqual({
      model: null, permissionProfile: null, isolation: null, maxTurns: null, turnLimitPolicy: null, instructions: null,
    });
  });

  it("falls back to just the binding's own overrides when the referenced library role is gone", () => {
    const binding = { role: "deleted-role", overrides: { model: "claude-haiku-4-5" } };
    expect(resolvedRoleBindingSpec(binding, LIBRARY)).toEqual({ model: "claude-haiku-4-5" });
  });

  it("overridesOf/resolvedRoleBindingSpec degrade cleanly on a null/undefined binding", () => {
    expect(overridesOf(undefined)).toEqual({});
    expect(overridesOf(null)).toEqual({});
    expect(resolvedRoleBindingSpec(undefined, LIBRARY)).toEqual({});
    expect(overriddenFieldsOf(undefined)).toEqual([]);
  });
});

describe("builtinDiff", () => {
  it("detects an edit vs the pristine builtin over the widened field set", () => {
    const builtin = { model: "sonnet", permissionProfile: "full", instructions: "orig", plugins: [], mcpToolAllowlist: {}, skills: [], persistent: false };
    const edited = { ...builtin, instructions: "customized" };
    expect(builtinDiff(edited, builtin)).toBe(true);
    expect(builtinDiff(builtin, builtin)).toBe(false);
  });

  it("detects a diff on a field outside the old 6-field subset (persistent/poolSize/orchestration)", () => {
    const builtin = { model: "sonnet", persistent: false, poolSize: undefined, orchestration: { allow: true, maxDepth: 2 } };
    const editedOrchestration = { ...builtin, orchestration: { allow: false, maxDepth: 2 } };
    expect(builtinDiff(editedOrchestration, builtin)).toBe(true);
  });
});
