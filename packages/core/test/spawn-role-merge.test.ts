import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("agent.spawn role resolution (ad-hoc sessions design §4)", () => {
  it("a role's instructions/permissionProfile apply, but explicit spec fields win", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = await e.handle("agent.spawn", {
      spec: { prompt: "review PR 5", cwd: "/tmp", permissionProfile: "readOnly" },
      role: "review",
    }) as AgentRecord;
    // review's builtin permissionProfile is "acceptEdits" — the caller's explicit "readOnly" must win.
    expect(rec.spec.permissionProfile).toBe("readOnly");
    expect(rec.spec.instructions).toContain("code-review:ai-review-agentic");
    expect(rec.spec.instructions).toContain("security-reviewer:review");
  });

  it("omitting role leaves the spec byte-identical to today", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp" } }) as AgentRecord;
    expect(rec.spec.instructions).toBeUndefined();
  });

  it("an unknown role name surfaces as a protocol error, spawns nothing", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp" }, role: "ghost" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  // ROLES-UNIFY §4: this is the deliberate behavior WIDENING resolveRole introduces — a
  // session role now applies its FULL field set (previously curated to just model/
  // permissionProfile/plugins/mcpToolAllowlist/instructions), matching the operator
  // requirement that a role spawns identically everywhere (team or session).
  it("a custom role's effort/orchestration now flow through a session spawn (previously dropped by the old curated merge)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("role.create", {
      spec: { name: "widened", effort: "high", orchestration: { allow: false, maxDepth: 1 } },
    });
    const rec = await e.handle("agent.spawn", {
      spec: { prompt: "x", cwd: "/tmp" },
      role: "widened",
    }) as AgentRecord;
    expect(rec.spec.effort).toBe("high");
    expect(rec.spec.orchestration).toEqual({ allow: false, maxDepth: 1 });
  });

  it("the aws role's permissionProfile applies when the caller doesn't override it", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const rec = await e.handle("agent.spawn", {
      spec: { prompt: "check pods", cwd: "/tmp" },
      role: "aws",
    }) as AgentRecord;
    expect(rec.spec.permissionProfile).toBe("full");
    expect(rec.spec.instructions).toMatch(/mutation gate|classifyCloudMutation/i);
  });
});
