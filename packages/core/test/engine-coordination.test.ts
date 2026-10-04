import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };
const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("Engine coordination methods", () => {
  it("team/queue lifecycle: create, push, drain to done, list, status, dissolve", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends(new FakeAgentBackend([])) });   // unscripted fake → "fake:<prompt>"
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 1 } });
    await e.handle("team.create", { spec: TEAM_SPEC });
    const task = (await e.handle("queue.push", { queue: "work", prompt: "build it" })) as { taskId: string };
    expect(task.taskId).toBeTruthy();

    await waitUntil(() => e.queues.status("work").counts.done === 1);
    const st = (await e.handle("queue.status", { queue: "work" })) as {
      counts: Record<string, number>; tasks: Array<{ state: string; resultText: string | null }>;
    };
    expect(st.counts.done).toBe(1);
    expect(st.tasks[0]!.state).toBe("done");
    // SAFE-1 CACHE-PREFIX: fresh spawns get "Current teammates: ...\n\n" prepended to the
    // first user turn (scheduler.ts withTeamPreamble) — solo crew, so roster reads "none yet".
    expect(st.tasks[0]!.resultText).toBe("fake:Current teammates: none yet.\n\nbuild it");

    const teams = (await e.handle("team.list", {})) as Array<{ name: string; running: number; totalRuns: number }>;
    expect(teams[0]).toMatchObject({ name: "crew", running: 0 });
    // TEAM-STATS: the one task drained above ran on a crew worker — team.list's
    // totalRuns must reflect it (not just team.status's per-agent runCount).
    expect(teams[0]!.totalRuns).toBe(1);
    const tstat = (await e.handle("team.status", { name: "crew" })) as { running: number; agents: unknown[]; totalRuns: number };
    expect(tstat.running).toBe(0);
    expect(tstat.totalRuns).toBe(1);

    expect(await e.handle("team.dissolve", { name: "crew" })).toEqual({ ok: true });
    await expect(e.handle("team.status", { name: "crew" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("cancelTask cancels pending tasks on an unbound queue; typed errors for ghosts", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "loose" } });
    const t = (await e.handle("queue.push", { queue: "loose", prompt: "later" })) as { taskId: string };
    expect(await e.handle("queue.cancelTask", { taskId: t.taskId })).toEqual({ cancelled: true });
    expect(await e.handle("queue.cancelTask", { taskId: t.taskId })).toEqual({ cancelled: false });
    await expect(e.handle("queue.status", { queue: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("queue.cancelTask", { taskId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("queue.list enumerates queue specs over RPC (Phase 3 TUI dependency)", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    expect(await e.handle("queue.list", {})).toEqual([]);
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 1 } });
    await e.handle("queue.create", { spec: { name: "loose" } });
    const queues = (await e.handle("queue.list", {})) as Array<{ name: string; retryLimit: number }>;
    expect(queues.map((q) => q.name)).toEqual(["work", "loose"]);
    expect(queues[0]!.retryLimit).toBe(1);
  });

  it("team.create bound to an unknown queue rejects with a typed error and persists NOTHING", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("team.create", { spec: { ...TEAM_SPEC, queue: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    expect((await e.handle("team.list", {})) as unknown[]).toEqual([]);   // NOT persisted to teams.json
  });

  // D11: team.update / queue.update / queue.delete — CRUD completion (coverage §C13).
  it("team.update patches maxConcurrent/purpose live and rejects an unknown-queue patch", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const updated = (await e.handle("team.update", {
      name: "crew", patch: { maxConcurrent: 5, purpose: "ship the thing" },
    })) as { maxConcurrent: number; purpose: string | null };
    expect(updated.maxConcurrent).toBe(5);
    expect(updated.purpose).toBe("ship the thing");

    await expect(e.handle("team.update", { name: "crew", patch: { queue: "ghost" } }))
      .rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("team.update", { name: "ghost-team", patch: { purpose: "x" } }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  // [TEAM-ROLES-ONTHEFLY] A role is a spawn TEMPLATE (scheduler reads team.roles[role]
  // fresh per spawn), so ADD/CHANGE mid-flight is safe and only the removal of an in-use
  // role is gated. These replace the old blanket "refused while any member runs" test.
  const longRun = (): FakeStep[] => [{ awaitSend: true }, { end: { resultText: "done" } }];
  const role = (cwd: string) => ({ cwd, account: "main", isolation: "none" as const });

  it("team.update ADDS a role while a member runs (allowed); the next spawn uses the added template", async () => {
    const fake = new FakeAgentBackend([longRun(), longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/dev") } }, maxConcurrent: 2, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "dev task" });   // routes to the default (only) role
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);

    const added = (await e.handle("team.update", { name: "crew", patch: { roles: { dev: { role: "blank", overrides: role("/tmp/dev") }, reviewer: { role: "blank", overrides: role("/tmp/rev") } } } })) as { roles: Record<string, unknown> };
    expect(Object.keys(added.roles)).toEqual(["dev", "reviewer"]);

    // the freshly-added template is what the NEXT spawn resolves against
    await e.handle("queue.push", { queue: "work", prompt: "review task", role: "reviewer" });
    await waitUntil(() => fake.spawns.some((s) => s.cwd === "/tmp/rev"));
  });

  it("team.update CHANGES a role while its member runs (allowed); the running agent keeps its spawn-time spec, the next spawn uses the new template", async () => {
    const fake = new FakeAgentBackend([longRun(), longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/old") } }, maxConcurrent: 2, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "first" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    expect(fake.spawns[0]!.cwd).toBe("/tmp/old");

    const changed = (await e.handle("team.update", { name: "crew", patch: { roles: { dev: { role: "blank", overrides: role("/tmp/new") } } } })) as { roles: Record<string, { overrides: { cwd: string } }> };
    expect(changed.roles.dev!.overrides.cwd).toBe("/tmp/new");
    // the already-running agent's record keeps its SPAWN-TIME spec — the change never reaches it
    const tstat = (await e.handle("team.status", { name: "crew" })) as { agents: Array<{ phase: string; spec: { cwd: string } }> };
    expect(tstat.agents.find((a) => a.phase === "running")!.spec.cwd).toBe("/tmp/old");

    await e.handle("queue.push", { queue: "work", prompt: "second" });   // second dev task -> fresh spawn off the new template
    await waitUntil(() => fake.spawns.length === 2);
    expect(fake.spawns[1]!.cwd).toBe("/tmp/new");
  });

  it("team.update rejects removing a role that still has a running member, naming the role and the member id (full-replace implicit drop uses the same path)", async () => {
    const fake = new FakeAgentBackend([longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/dev") }, reviewer: { role: "blank", overrides: role("/tmp/rev") } }, maxConcurrent: 2, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "dev task" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    const agentId = e.scheduler.agentsFor("crew")[0]!;

    // full-replace patch that OMITS dev == an implicit removal of an in-use role
    let msg = "";
    await e.handle("team.update", { name: "crew", patch: { roles: { reviewer: { role: "blank", overrides: role("/tmp/rev") } } } }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain('"dev"');
    expect(msg).toContain(agentId);
  });

  it("team.update rejects removing a role referenced by a non-terminal task even with no running member of that role, naming the role and the task id", async () => {
    const fake = new FakeAgentBackend([longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    // maxConcurrent 1: the dev agent occupies the only slot, so the reviewer task stays PENDING (never spawns)
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/dev") }, reviewer: { role: "blank", overrides: role("/tmp/rev") } }, maxConcurrent: 1, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "dev task" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    const revTask = (await e.handle("queue.push", { queue: "work", prompt: "review task", role: "reviewer" })) as { taskId: string };
    await waitUntil(() => e.queues.status("work").counts.pending === 1);

    let msg = "";
    await e.handle("team.update", { name: "crew", patch: { roles: { dev: { role: "blank", overrides: role("/tmp/dev") } } } }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain('"reviewer"');
    expect(msg).toContain(revTask.taskId);
  });

  it("team.update rejects removing the team's FIRST role while a default (null-role) task still routes to it", async () => {
    const fake = new FakeAgentBackend([longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    // maxConcurrent 1: the first null-role task's agent holds the only slot, so a SECOND
    // null-role task stays pending. A default task's EFFECTIVE spawn role is the team's first
    // role (dev) even though its own `role` is null — a literal task.role compare would miss it.
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/dev") }, reviewer: { role: "blank", overrides: role("/tmp/rev") } }, maxConcurrent: 1, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "dev task 1" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);
    const pending = (await e.handle("queue.push", { queue: "work", prompt: "dev task 2" })) as { taskId: string };
    await waitUntil(() => e.queues.status("work").counts.pending === 1);

    // removing dev (the first role) is refused because the pending null-role task still routes to it
    let msg = "";
    await e.handle("team.update", { name: "crew", patch: { roles: { reviewer: { role: "blank", overrides: role("/tmp/rev") } } } }).catch((err: Error) => { msg = err.message; });
    expect(msg).toContain('"dev"');
    expect(msg).toContain(pending.taskId);   // proves the null-role task is mapped to its effective (first) role
  });

  it("team.update allows removing an UNUSED role while OTHER roles' members run", async () => {
    const fake = new FakeAgentBackend([longRun()]);
    const e = new Engine({ home: makeEngineHome(), backends: backends(fake) });
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { dev: { role: "blank", overrides: role("/tmp/dev") }, spare: { role: "blank", overrides: role("/tmp/spare") } }, maxConcurrent: 2, queue: "work" } });
    await e.handle("queue.push", { queue: "work", prompt: "dev task" });
    await waitUntil(() => e.queues.status("work").counts.in_progress === 1);

    // spare has no members and no tasks -> droppable even though dev's member is running
    const updated = (await e.handle("team.update", { name: "crew", patch: { roles: { dev: { role: "blank", overrides: role("/tmp/dev") } } } })) as { roles: Record<string, unknown> };
    expect(Object.keys(updated.roles)).toEqual(["dev"]);
  });

  it("queue.update patches retryLimit; queue.delete refuses with pending tasks and is idempotent once drained", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await e.handle("queue.create", { spec: { name: "loose", retryLimit: 1 } });
    const updated = (await e.handle("queue.update", { name: "loose", patch: { retryLimit: 4 } })) as { retryLimit: number };
    expect(updated.retryLimit).toBe(4);

    const t = (await e.handle("queue.push", { queue: "loose", prompt: "later" })) as { taskId: string };
    await expect(e.handle("queue.delete", { name: "loose" })).rejects.toMatchObject({ code: "protocol" });
    expect(e.queues.status("loose").counts.pending).toBe(1);   // task list unaffected by the refused delete

    await e.handle("queue.cancelTask", { taskId: t.taskId });   // cancel first, as the caller is required to
    expect(await e.handle("queue.delete", { name: "loose" })).toEqual({ deleted: true });
    expect(await e.handle("queue.delete", { name: "loose" })).toEqual({ deleted: false });   // idempotent
    expect(((await e.handle("queue.list", {})) as unknown[]).length).toBe(0);
  });

  it("teams, queues and tasks survive an engine restart; in_progress reverts to pending", async () => {
    const home = makeEngineHome();
    const e1 = new Engine({
      home,
      backends: backends(new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "never" } }]])),
    });
    await e1.handle("queue.create", { spec: { name: "work" } });
    await e1.handle("team.create", { spec: TEAM_SPEC });
    await e1.handle("queue.push", { queue: "work", prompt: "interrupted" });
    await waitUntil(() => e1.queues.status("work").counts.in_progress === 1);
    e1.scheduler.detach();                                    // "daemon dies"

    const e2 = new Engine({ home, backends: backends(new FakeAgentBackend([])) });
    expect((await e2.handle("team.list", {})) as unknown[]).toHaveLength(1);
    const st = (await e2.handle("queue.status", { queue: "work" })) as { counts: Record<string, number> };
    expect(st.counts.pending).toBe(1);                        // reverted on load (spec §3), no auto-drain yet

    await e2.scheduler.tick();                                // what chimerad main does on startup (Task 9)
    await waitUntil(() => e2.queues.status("work").counts.done === 1);
    const done = e2.queues.status("work").tasks[0]!;
    // SAFE-1 CACHE-PREFIX: same team-preamble prefix as above (see comment there).
    expect(done.resultText).toBe("fake:Current teammates: none yet.\n\ninterrupted");
    expect(done.attempts).toBe(0);                            // restart consumed no retry budget
  });
});
