import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]);
const TEAM_SPEC = {
  name: "crew",
  roles: { dev: { role: "blank", overrides: { cwd: "/tmp/crew", account: "main", isolation: "none" } } },
  maxConcurrent: 2,
  queue: null,
};

// ROLES-UNIFY §5: team.attachRole/team.detachRole now write/remove a {role, overrides}
// BINDING (a reference, not a materialized copy) — role.update's old propagation loop is
// gone (§9.4): a binding resolves the library live, so an edit is visible everywhere
// without any team write at all.
describe("role attach/detach + live resolution (ROLES-UNIFY, formerly ROLES-TAB S2)", () => {
  it("attach writes a binding with a defaulted cwd override; resolving it live shows the skills nudge", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("team.create", { spec: TEAM_SPEC });
    await e.handle("role.create", {
      spec: { name: "reviewer", instructions: "review PRs", skills: ["code-review:ai-review-agentic"] },
    });

    const spec = await e.handle("team.attachRole", { team: "crew", role: "reviewer" }) as
      { roles: Record<string, { role: string; overrides: Record<string, unknown> }> };

    expect(spec.roles["reviewer"]).toEqual({ role: "reviewer", overrides: { cwd: "/tmp/crew" } });   // cwd defaulted from a sibling binding
    expect(Object.keys(spec.roles)).toEqual(["dev", "reviewer"]);   // sibling role untouched

    // resolveRole is only exercised live (read/spawn time) — team.status's not_spawned
    // preview row is the read-time call site (team-rpc.ts).
    const status = await e.handle("team.status", { name: "crew" }) as
      { agents: Array<{ membership: { role: string }; phase: string; spec: { instructions?: string } }> };
    const reviewerPreview = status.agents.find((a) => a.membership.role === "reviewer" && a.phase === "not_spawned")!;
    expect(reviewerPreview.spec.instructions).toContain("review PRs");
  });

  it("attach onto an existing team-role key refuses", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("team.create", { spec: TEAM_SPEC });
    await e.handle("role.create", { spec: { name: "dev", instructions: "x" } });

    await expect(e.handle("team.attachRole", { team: "crew", role: "dev" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("detach of an in-use role refuses with blocker detail; detach of an idle role removes it (no provenance list left to update)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("team.create", { spec: TEAM_SPEC });
    await e.handle("role.create", { spec: { name: "reviewer", instructions: "x" } });
    await e.handle("team.attachRole", { team: "crew", role: "reviewer" });

    const detached = await e.handle("team.detachRole", { team: "crew", role: "reviewer" }) as
      { roles: Record<string, unknown> };
    expect(Object.keys(detached.roles)).toEqual(["dev"]);
    expect(detached).not.toHaveProperty("sharedRoles");   // ROLES-UNIFY §2 table: the marker is gone, not just empty
  });

  // ROLES-UNIFY §9.4: role.update no longer fans out a write to every attached team —
  // a binding resolves the library live, so an edit to the library role is visible at
  // every binding on the very next read, with zero writes to any team.
  it("role.update needs no propagation: an edit is visible live at every binding, siblings and team-local overrides untouched", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("team.create", {
      spec: { ...TEAM_SPEC, roles: { dev: { role: "blank", overrides: { cwd: "/tmp/crew-dev", account: "main", isolation: "none" } }, qa: { role: "blank", overrides: { cwd: "/tmp/crew-qa", account: "main", isolation: "none" } } } },
    });
    await e.handle("role.create", { spec: { name: "reviewer", instructions: "v1" } });
    await e.handle("team.attachRole", { team: "crew", role: "reviewer", cwd: "/tmp/crew-reviewer" });
    const before = await e.handle("team.status", { name: "crew" }) as { spec: { roles: Record<string, unknown> } };

    await e.handle("role.update", { name: "reviewer", patch: { instructions: "v2" } });

    const status = await e.handle("team.status", { name: "crew" }) as
      { spec: { roles: Record<string, unknown> }; agents: Array<{ membership: { role: string }; phase: string; spec: { cwd?: string; instructions?: string } }> };
    expect(status.spec.roles).toEqual(before.spec.roles);   // the binding rows themselves are byte-identical — nothing was written
    const preview = (role: string) => status.agents.find((a) => a.membership.role === role && a.phase === "not_spawned")!.spec;
    expect(preview("reviewer").instructions).toContain("v2");          // resolved live, sees the edit immediately
    expect(preview("reviewer").cwd).toBe("/tmp/crew-reviewer");        // team-local override survives
    expect(preview("dev").cwd).toBe("/tmp/crew-dev");                  // sibling untouched
    expect(preview("qa").cwd).toBe("/tmp/crew-qa");                    // sibling untouched
  });

  // ROLES-BINDING-CORRECTNESS: team.create used to accept ANY role name in its bindings
  // (unlike attachRole/updateRoleBinding, which both validate via roles.get) — a
  // typo'd/nonexistent role parsed fine and silently failed to resolve at spawn time,
  // far from the mistake. Now it rejects at create, naming the unknown role.
  it("team.create rejects a binding referencing an unknown role, naming it, before anything persists", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await expect(e.handle("team.create", {
      spec: { name: "crew", roles: { dev: { role: "no-such-role", overrides: { cwd: "/tmp/crew" } } }, maxConcurrent: 2, queue: null },
    })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("no-such-role") });
    // nothing persisted — the team must not exist after the rejected create
    await expect(e.handle("team.list", {})).resolves.toEqual([]);
  });

  it("team.create still accepts a team whose bindings all reference real roles", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const spec = await e.handle("team.create", { spec: TEAM_SPEC }) as { name: string };
    expect(spec.name).toBe("crew");
  });

  it("team.create rejects when ONE of several bindings is unknown, even if the others are valid", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("role.create", { spec: { name: "reviewer", instructions: "x" } });
    await expect(e.handle("team.create", {
      spec: {
        name: "crew",
        roles: {
          dev: { role: "reviewer", overrides: { cwd: "/tmp/crew" } },
          qa: { role: "bogus", overrides: { cwd: "/tmp/crew" } },
        },
        maxConcurrent: 2, queue: null,
      },
    })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("bogus") });
  });

  it("role.delete refuses while the role is attached anywhere", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("team.create", { spec: TEAM_SPEC });
    await e.handle("role.create", { spec: { name: "reviewer", instructions: "x" } });
    await e.handle("team.attachRole", { team: "crew", role: "reviewer" });

    await expect(e.handle("role.delete", { name: "reviewer" })).rejects.toMatchObject({ code: "protocol" });

    await e.handle("team.detachRole", { team: "crew", role: "reviewer" });
    await expect(e.handle("role.delete", { name: "reviewer" })).resolves.toEqual({ ok: true });
  });
});
