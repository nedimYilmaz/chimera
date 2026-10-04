import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeCoordination, waitUntil } from "./coord-helpers.js";

const CRASH: FakeStep[] = [{ fail: { message: "backend process crashed" } }];
const RATE: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];
const HAPPY = (text: string): FakeStep[] => [{ end: { resultText: text, costUsd: 0.01 } }];

describe("QueueScheduler retries", () => {
  it("retries a crashed task within the retry budget and succeeds", async () => {
    const rig = makeCoordination([CRASH, HAPPY("second try")]);
    rig.queues.create({ name: "work", retryLimit: 1 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "flaky" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.done === 1);

    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.attempts).toBe(1);                    // one failed run consumed one attempt
    expect(task.resultText).toBe("second try");
    expect(rig.fake.spawns.length).toBe(2);
  });

  it("failover attempts count against the retry budget (spec §4)", async () => {
    const rig = makeCoordination([RATE, RATE, HAPPY("never")]);
    rig.queues.create({ name: "work", retryLimit: 1 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "auto", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "doomed" });
    await rig.scheduler.tick();
    await waitUntil(() => rig.queues.status("work").counts.failed === 1);

    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.attempts).toBe(2);                    // main 429 → failover to second 429 = 2 attempts, 1 run
    expect(task.error).toContain("rate-limit");
    expect(rig.fake.spawns.length).toBe(2);           // no third spawn: budget exhausted (2 > retryLimit 1)
  });

  it("guardrail-rejected spawns leave tasks pending without consuming the retry budget", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
      caps: { maxAgentsTotal: 1, perAccount: { main: 1 } },
    });
    const rig = makeCoordination([[{ awaitSend: true }, { end: { resultText: "unblocked" } }], HAPPY("ran-late")], cfg);
    rig.queues.create({ name: "work", retryLimit: 0 });     // any consumed attempt would fail it permanently
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 5, queue: "work" });
    rig.queues.push("work", { prompt: "holder" });
    const starved = rig.queues.push("work", { prompt: "starved" });
    await rig.scheduler.tick();

    expect(rig.queues.status("work").counts).toEqual({ pending: 1, in_progress: 1, done: 0, failed: 0, blocked: 0, dead_letter: 0 });
    expect(rig.queues.status("work").tasks.find((x) => x.taskId === starved.taskId)!.attempts).toBe(0);

    const [holder] = rig.scheduler.agentsFor("crew");
    await rig.sup.send(holder!, "go");
    await waitUntil(() => rig.queues.status("work").counts.done === 2);   // starved task ran once the slot freed
  });

  it("agent_kill settles the task as permanently failed — the in-flight cancel path (decision 7)", async () => {
    const rig = makeCoordination([[{ awaitSend: true }, { end: { resultText: "never", costUsd: 0 } }], HAPPY("never")]);
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");
    await rig.sup.kill(agentId!);                    // kill emits NO event — only the tick sweep can settle this
    await rig.scheduler.tick();                      // exactly what Engine's agent.kill case does (Task 8)

    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");               // NOT retried despite retryLimit 5
    expect(task.error).toBe("agent killed");
    expect(rig.fake.spawns.length).toBe(1);          // no resurrection spawn
  });

  it("relaunch-failure during failover cannot strand a task in_progress: the sweep settles it", async () => {
    // Simulate the no-event terminal path generically: force the tracked agent's record into a
    // terminal state without any event append (same observable shape as the Phase 1
    // `void this.launch(...).catch(() => { record.state = "failed"; })` relaunch-failure path).
    const rig = makeCoordination([[{ awaitSend: true }, { end: { resultText: "never", costUsd: 0 } }]]);
    rig.queues.create({ name: "work", retryLimit: 0 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "stranded?" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");
    rig.sup.status(agentId!).state = "failed";       // terminal, silently — no event reaches the scheduler

    await rig.scheduler.tick();                      // any later tick self-heals via the sweep
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("failed");               // settled per retry budget (0 retries), not stuck in_progress
  });

  it("re-ticks after guardrail cooldown starvation and drains without external stimulus", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    });
    const rig = makeCoordination([RATE, HAPPY("resumed")], cfg, { cooldownMs: 80, retickDelayMs: 25 });
    rig.queues.create({ name: "work", retryLimit: 5 });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "auto", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "cooled" });
    await rig.scheduler.tick();
    // main 429-fails → 80ms cooldown → settle's follow-up tick is guardrail-starved (sole account cooling,
    // zero agents running) → the 25ms fallback re-tick keeps retrying until the cooldown expires, then drains
    await waitUntil(() => rig.queues.status("work").counts.done === 1, 5000);
    expect(rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!.resultText).toBe("resumed");
    rig.scheduler.detach();
  });
});
