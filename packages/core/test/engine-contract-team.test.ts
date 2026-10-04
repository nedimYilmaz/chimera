import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };

// FEATURE-11: exercises all 5 team.* methods through Engine.handle()'s RpcContract dispatch
// (see engine.ts's isContractMethod check) now that their handler bodies live in
// packages/core/src/rpc/team-rpc.ts's TeamRpc, not engine.ts's switch. core/test/
// engine-coordination.test.ts already covers this same family in more end-to-end depth (team +
// queue + scheduler interplay) and is left completely unmodified — it staying green is the
// strongest evidence the extraction changed nothing observable. This file's job is narrower:
// prove the reroute itself works for every migrated method in one place, including the two
// pre-persist guards (unknown queue, roles-while-running) that had to survive the case-body ->
// TeamRpc move verbatim, and that handle()'s response round-trips through spec.response.parse()
// without throwing.
describe("Engine team.* RpcContract dispatch (FEATURE-11)", () => {
  it("create -> list -> status -> update -> dissolve, end to end", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });

    const spec = await e.handle("team.create", { spec: TEAM_SPEC });
    expect(spec).toMatchObject({ name: "crew", maxConcurrent: 2, queue: "work" });

    const listed = await e.handle("team.list", {}) as Array<{ name: string; running: number; totalRuns: number }>;
    expect(listed).toEqual([{ ...spec, running: 0, totalRuns: 0 }]);

    const status = await e.handle("team.status", { name: "crew" }) as { spec: unknown; running: number; agents: Array<Record<string, unknown>>; totalRuns: number };
    expect(status.running).toBe(0);
    expect(status.totalRuns).toBe(0);   // TEAM-STATS: no agent has ever run for this team yet
    // no agent has ever spawned for this team yet -> a synthetic not_spawned row for its one
    // role. ROLES-UNIFY §4: the preview `spec` is the RESOLVED role (library "blank" defaults
    // + this binding's own overrides), not the raw {role, overrides} binding — "what a spawn
    // would use" (team-rpc.ts's own comment).
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]).toMatchObject({
      agentId: null, membership: { team: "crew", role: "dev" }, phase: "not_spawned", runCount: 0,
      spec: { cwd: "/tmp", account: "main", isolation: "none" },
    });

    const updated = await e.handle("team.update", { name: "crew", patch: { maxConcurrent: 5 } });
    expect(updated).toMatchObject({ name: "crew", maxConcurrent: 5 });

    expect(await e.handle("team.dissolve", { name: "crew" })).toEqual({ ok: true });
    await expect(e.handle("team.status", { name: "crew" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("team.create refuses an unknown queue binding BEFORE persisting the team (guard carried over verbatim)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("team.create", { spec: { ...TEAM_SPEC, queue: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(await e.handle("team.list", {})).toEqual([]);   // nothing persisted
  });

  it("team.update refuses an unknown queue binding BEFORE persisting the patch (guard carried over verbatim)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } } } });
    await expect(e.handle("team.update", { name: "crew", patch: { queue: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    const spec = await e.handle("team.status", { name: "crew" }) as { spec: { queue: string | null } };
    expect(spec.spec.queue).toBeNull();   // nothing persisted
  });

  // [TEAM-ROLES-ONTHEFLY] the roles guard now gates only the REMOVAL of an in-use role
  // (not any roles patch) — this proves that gate still reroutes through TeamRpc, and that
  // an add/change mid-flight passes through it.
  it("team.update refuses removing an in-use role but allows changing it while a member runs (guard carried over through TeamRpc)", async () => {
    const role = { cwd: "/tmp", account: "main", isolation: "none" };
    const e = new Engine({
      home: makeEngineHome(),
      backends: backends(new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])),
    });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { ...TEAM_SPEC, roles: { dev: { role: "blank", overrides: role }, reviewer: { role: "blank", overrides: role } } } });
    await e.handle("queue.push", { queue: "work", prompt: "long running" });   // routes to dev (first role)
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);

    // full-replace patch OMITTING dev == implicit removal of a role with a running member -> refused
    await expect(e.handle("team.update", { name: "crew", patch: { roles: { reviewer: { role: "blank", overrides: role } } } }))
      .rejects.toMatchObject({ code: "protocol" });
    // ...but CHANGING the running role's template mid-flight is allowed (applies at the next spawn)
    const changed = await e.handle("team.update", { name: "crew", patch: { roles: { dev: { role: "blank", overrides: { ...role, cwd: "/tmp/new" } }, reviewer: { role: "blank", overrides: role } } } }) as { roles: Record<string, { overrides: { cwd: string } }> };
    expect(changed.roles.dev!.overrides.cwd).toBe("/tmp/new");
  });
});

// WORKER-TEAM-CONTEXT: team.mine is my_team's authoritative fallback (protocol/mcp-tools.ts) for
// when a backend's chimera-mcp subprocess never forwarded CHIMERA_TEAM (found missing in both
// claude.ts and codex.ts) — it resolves the SAME team.status response, but from the caller's OWN
// AgentRecord.membership (stamped by the scheduler at spawn time, provider-agnostic) instead of
// trusting an env var a backend's spawn code has to remember to thread through.
describe("Engine team.mine (WORKER-TEAM-CONTEXT authoritative my_team fallback)", () => {
  it("resolves a real team member's team+roster from its agentId, byte-identical to team.status", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: backends(new FakeAgentBackend([[{ end: { resultText: "done" } }]])),
    });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: TEAM_SPEC });
    await e.handle("queue.push", { queue: "work", prompt: "task1" });
    await waitUntil(() => e.queues.status("work").counts.done === 1);

    // membersOf() is busy/tracked-only (goes empty once the team is idle, see team.status's own
    // comment above) — the finished member is still a real AgentRecord with membership stamped,
    // found via supervisor.list() exactly like team.status's own roster-building does.
    const member = e.supervisor.list().find((a) => a.membership?.team === "crew");
    expect(member).toBeDefined();

    const viaMine = await e.handle("team.mine", { agentId: member!.agentId });
    const viaStatus = await e.handle("team.status", { name: "crew" });
    expect(viaMine).toEqual(viaStatus);
  });

  it("returns { team: null } for an agentId with no team membership (e.g. a plain agent.spawn)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([[{ awaitSend: true }]])) });
    const solo = await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } }) as { agentId: string };
    expect(await e.handle("team.mine", { agentId: solo.agentId })).toEqual({ team: null });
  });

  it("returns { team: null } for a completely unknown agentId", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    expect(await e.handle("team.mine", { agentId: "ghost" })).toEqual({ team: null });
  });
});
