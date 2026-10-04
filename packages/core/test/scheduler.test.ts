import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";

const HOLD: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "held-done", costUsd: 0.01 } }];
const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.01 } }];
const DEV_TEAM = (maxConcurrent: number) => ({
  name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent, queue: "work",
});

describe("QueueScheduler drain", () => {
  it("drains a bound queue in parallel up to team maxConcurrent", async () => {
    const rig = makeCoordination([HOLD, HOLD, HAPPY("t3"), HAPPY("t4")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(2));
    for (const p of ["t1", "t2", "t3", "t4"]) rig.queues.push("work", { prompt: p });
    await rig.scheduler.tick();

    expect(rig.queues.status("work").counts).toEqual({ pending: 2, in_progress: 2, done: 0, failed: 0, blocked: 0, dead_letter: 0 });
    expect(rig.scheduler.runningFor("crew")).toBe(2);

    for (const agentId of rig.scheduler.agentsFor("crew")) await rig.sup.send(agentId, "go");
    await waitUntil(() => rig.queues.status("work").counts.done === 4);
    const st = rig.queues.status("work");
    expect(st.counts).toEqual({ pending: 0, in_progress: 0, done: 4, failed: 0, blocked: 0, dead_letter: 0 });
    expect(st.tasks.find((t) => t.prompt === "t1")!.resultText).toBe("held-done");
    expect(st.tasks.find((t) => t.prompt === "t3")!.resultText).toBe("t3");
  });

  it("EMPTY-RESULT-NOT-DONE: an agent that reaches \"done\" with empty text and no structured output fails the task instead of silently marking it done", async () => {
    // retryLimit 0: an empty result is now a RETRYABLE attempt (see scheduler-empty-result.test.ts
    // for the retry/exhaustion coverage) — this case is about the guard itself, not the policy.
    const rig = makeCoordination([HAPPY("")]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);
    const st = rig.queues.status("work");
    expect(st.counts).toEqual({ pending: 0, in_progress: 0, done: 0, failed: 1, blocked: 0, dead_letter: 0 });
    expect(st.tasks.find((t) => t.prompt === "t1")!.error).toBe("agent produced no result");
  });

  it("RESULT-SCHEMA-MISSING: a resultSchema task fails when the backend returns text but no structured output", async () => {
    const rig = makeCoordination([HAPPY('{"verdict":"ok"}')]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", resultSchema: { type: "object" } } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);
    expect(rig.queues.status("work").tasks[0]!.error).toBe("agent produced no structured result for resultSchema");
  });

  it("RESULT-SCHEMA-MISSING: a resultSchema task still marks done when structured output exists", async () => {
    const rig = makeCoordination([[{ end: { resultText: "", structuredOutput: { verdict: "ok" } } }]]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", resultSchema: { type: "object" } } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "t1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(rig.queues.status("work").counts.done).toBe(1);
  });

  it("respects priority then FIFO order with maxConcurrent 1", async () => {
    const rig = makeCoordination([HAPPY("a"), HAPPY("b"), HAPPY("c")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.push("work", { prompt: "low", priority: 0 });
    rig.queues.push("work", { prompt: "hi", priority: 5 });
    rig.queues.push("work", { prompt: "mid", priority: 1 });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 3);
    // SAFE-1 CACHE-PREFIX: team spawns now prepend a "Current teammates: ...\n\n" preamble
    // to prompt (moved off the cacheable system-prompt append) — strip it back off to assert
    // pure drain order, unaffected by the relocation.
    expect(rig.fake.spawns.map((s) => s.prompt!.split("\n\n").pop())).toEqual(["hi", "mid", "low"]);
  });

  it("uses the task's role template, applies overrides; unknown role fails permanently", async () => {
    const rig = makeCoordination([HAPPY("qa-run")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: {
        dev: { role: "blank", overrides: { cwd: "/tmp/dev", account: "main", isolation: "none" } },
        qa: { role: "blank", overrides: { cwd: "/tmp/qa", account: "second", isolation: "none", permissionProfile: "readOnly" } },
      },
      maxConcurrent: 2, queue: "work",
    });
    rig.queues.push("work", { prompt: "verify", role: "qa", overrides: { maxTurns: 3 } });
    const ghost = rig.queues.push("work", { prompt: "x", role: "ghost" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const s = rig.fake.spawns[0]!;
    expect(s.cwd).toBe("/tmp/qa");
    expect(s.accountName).toBe("second");
    expect(s.permissionProfile).toBe("readOnly");
    expect(s.maxTurns).toBe(3);

    const failed = rig.queues.status("work").tasks.find((t) => t.taskId === ghost.taskId)!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("unknown role");
  });

  // PROJTEAM-T5: a role template's `inherit.settingSources` (e.g. a project-native
  // team role set up to load the project's .claude/) is a normal AgentSpec field —
  // it must ride through the role->spec merge (agentTemplate spread) untouched,
  // the same way cwd/account/permissionProfile already do above.
  it("a role template's inherit.settingSources survives the scheduler's role->spec merge", async () => {
    const rig = makeCoordination([HAPPY("dev-run")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp/dev", account: "main", isolation: "none", inherit: { settingSources: ["project", "user"] } } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "go" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    expect(rig.fake.spawns[0]!.inherit.settingSources).toEqual(["project", "user"]);
  });

  it("dissolved teams stop draining; running agents finish their task", async () => {
    const rig = makeCoordination([HOLD, HAPPY("never")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(1));
    rig.queues.push("work", { prompt: "t1" });
    rig.queues.push("work", { prompt: "t2" });
    await rig.scheduler.tick();
    expect(rig.queues.status("work").counts.in_progress).toBe(1);

    rig.teams.dissolve("crew");
    const [agentId] = rig.scheduler.agentsFor("crew");
    await rig.sup.send(agentId!, "go");
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    await rig.scheduler.tick();
    expect(rig.queues.status("work").counts).toEqual({ pending: 1, in_progress: 0, done: 1, failed: 0, blocked: 0, dead_letter: 0 });
  });

  it("tolerates a team bound to a missing queue: tick resolves and emits a status event", async () => {
    // TeamManager does not validate queue existence (the Engine does), so a persisted team
    // can point at a queue that no longer exists — the startup tick must survive that.
    const rig = makeCoordination([]);
    rig.teams.create({ name: "lost", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "ghost" });
    await expect(rig.scheduler.tick()).resolves.toBeUndefined();
    const ev = rig.events.tail("team:lost", 10).at(-1)!;
    expect(ev.kind).toBe("status");
    expect(ev.data).toMatchObject({ team: "lost", state: "queue-missing", queue: "ghost" });
  });

  it("single-flight guard: concurrent ticks spawn each task exactly once", async () => {
    const rig = makeCoordination([HAPPY("once")]);
    rig.queues.create({ name: "work" });
    rig.teams.create(DEV_TEAM(2));
    rig.queues.push("work", { prompt: "solo" });
    await Promise.all([rig.scheduler.tick(), rig.scheduler.tick(), rig.scheduler.tick()]);
    await waitUntil(() => rig.queues.status("work").counts.done === 1);
    expect(rig.fake.spawns.length).toBe(1);                    // no double-spawn across racing ticks
  });

  it("passes a role's `persistent: true` through to the backend spawn spec, and strips `poolSize` (Task A2)", async () => {
    // Regression guard: A2's central correction was narrowing the scheduler's
    // destructure-strip from `{ persistent, poolSize, ...agentTemplate }` to
    // `{ poolSize, ...agentTemplate }` so `persistent` rides the spread into
    // AgentSupervisor.spawn and reaches the backend. Before that fix (or if
    // it regresses), `persistent` would be silently stripped here and this
    // assertion would fail even though every other scheduler test stays green.
    const rig = makeCoordination([HAPPY("worked")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({
      name: "crew",
      roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none", persistent: true, poolSize: 3 } } },
      maxConcurrent: 1, queue: "work",
    });
    rig.queues.push("work", { prompt: "p1" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const spawned = rig.fake.spawns[0]!;
    expect(spawned.persistent).toBe(true);
    expect("poolSize" in spawned).toBe(false);   // role/scheduling-only field must not ride into AgentSpec
  });

  it("a role naming an unknown account fails the task permanently (non-guardrail error class)", async () => {
    const rig = makeCoordination([HAPPY("never")]);
    rig.queues.create({ name: "work" });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "ghost", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "doomed" });
    await rig.scheduler.tick();
    const failed = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(failed.state).toBe("failed");                       // ConfigError (code "protocol") ≠ guardrail → permanent
    expect(failed.error).toContain("ghost");
    expect(failed.attempts).toBe(0);                           // no spawn happened; retry budget untouched
    expect(rig.fake.spawns.length).toBe(0);
  });
});

// ---------- Deferred Must #1 fold-in: AgentSupervisor.deliverPending must be ----------
// ---------- serialized per agent so overlapping triggers can't run concurrent ----------
// ---------- deliverBatch calls whose handle.send()s interleave across batches ----------
// (packages/core/src/supervisor.ts). Teams/queues make concurrent same-deliverTo
// delivery live (the scheduler spawns concurrent agents), so this closes a real
// cross-batch FIFO gap (spec §8). Placed here because RULES restrict this task's
// writable test files to coord-helpers.ts and scheduler.test.ts.
describe("AgentSupervisor.deliverPending — per-agent serialization (Deferred Must #1)", () => {
  it("two deliverPending triggers before the first deliverBatch settles stay globally FIFO", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const sent: string[] = [];
    let calls = 0;
    let releaseFirst: (() => void) | null = null;
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, {
      ...real,
      send: async (t: string) => {
        calls++;
        if (calls === 1) {
          // block the FIRST send until the test explicitly releases it — this opens the
          // exact race window Deferred Must #1 closes: a second deliverPending fires
          // while the first batch's deliverBatch is still in flight.
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        sent.push(t);
      },
    });

    const mb = new MailboxStore(dir);
    const castDeliverPending = (s: unknown) => s as unknown as { deliverPending(id: string): void };

    mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: "one" });
    castDeliverPending(sup).deliverPending(rec.agentId);       // batch 1: drains ["one"], blocks on send
    await new Promise((r) => setTimeout(r, 0));                // let batch 1 start and reach the block

    mb.enqueue(rec.agentId, { from: "b", kind: "user_message", text: "two" });
    castDeliverPending(sup).deliverPending(rec.agentId);       // batch 2: fired WHILE batch 1 is still in flight
    await new Promise((r) => setTimeout(r, 0));

    // without per-agent serialization, batch 2's deliverBatch would run concurrently
    // and "two" would be sent (and land here) before "one" is ever released
    expect(sent).toEqual([]);

    releaseFirst!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(["[from a] one", "[from b] two"]);    // globally FIFO — no cross-batch interleave
  });
});
