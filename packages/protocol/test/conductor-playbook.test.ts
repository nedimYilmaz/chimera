import { describe, it, expect } from "vitest";
import { CONDUCTOR_PLAYBOOK } from "@chimera/protocol";
import { ENGINE_TOOL_NAMES } from "@chimera/protocol/engine-help";

describe("conductor instructions", () => {
  it("names only real tools", () => {
    const named = CONDUCTOR_PLAYBOOK.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(ENGINE_TOOL_NAMES).toContain(name);
  });

  it("preserves delegation, async delivery, dependency and landing rules", () => {
    for (const rule of ["queue_push", "deliverTo", "Never block-wait or poll", "subscribe", "dependsOn", "agent_result/agent_status", "terminal", "verified as landed"]) {
      expect(CONDUCTOR_PLAYBOOK).toContain(rule);
    }
  });

  it("limits roles and briefs to their own context instead of propagating shared prompts", () => {
    expect(CONDUCTOR_PLAYBOOK).toContain("scope, relevant evidence/files, acceptance and verification");
    expect(CONDUCTOR_PLAYBOOK).toContain("only reusable role-specific instructions");
    expect(CONDUCTOR_PLAYBOOK).toContain("Do not repeat shared policy or tool catalogs");
    expect(CONDUCTOR_PLAYBOOK).not.toContain("PROPAGATE");
    expect(CONDUCTOR_PLAYBOOK.length).toBeLessThan(1_600);
  });

  it("reuses roles with overrides before creating a new one", () => {
    expect(CONDUCTOR_PLAYBOOK).toContain("role_list before role_create");
    for (const field of ["overrides", "model", "effort", "permissionProfile", "instructions"]) {
      expect(CONDUCTOR_PLAYBOOK).toContain(field);
    }
    expect(CONDUCTOR_PLAYBOOK).toContain("Create a role only when none fits");
  });
});
