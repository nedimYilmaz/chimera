import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// PAUSED-CONDUCTOR (operator-reported): a conductor whose workers are still running was parked
// "paused" by the idle reaper and its workers could then no longer reach it. Two halves are
// tested here — the reaper must not park an agent that still owns live sub-agents, and a wake
// must actually be able to run work (a resumeOnly spec with no session resumes into nothing).

const SPAWN_A = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } as const;
const SPAWN_B = { prompt: "x", cwd: "/tmp", account: "second", isolation: "none" } as const;

const LIVE = (sessionId?: string): FakeStep[] => [
  { emit: { kind: "agent_started", data: sessionId ? { sessionId } : {} } },
  { awaitSend: true },
  { end: { resultText: "done" } },
];

describe("AgentSupervisor.hasLiveDependants / parkIdle", () => {
  it("refuses to park an agent whose child (parentId) is still running, and parks it once the child settles", async () => {
    const { sup } = makeSupervisor([LIVE("s1"), LIVE("s2")]);
    const c = await sup.spawn(SPAWN_A, { agentId: "conductor" });
    await sup.spawn(SPAWN_B, { agentId: "worker", parentId: "conductor" });

    expect(sup.hasLiveDependants("conductor")).toBe(true);
    await sup.parkIdle("conductor", 99_999);
    expect(sup.status(c.agentId).state).toBe("running");

    await sup.kill("worker");
    expect(sup.hasLiveDependants("conductor")).toBe(false);
    await sup.parkIdle("conductor", 99_999);
    expect(sup.status(c.agentId).state).toBe("paused");
    expect(sup.status(c.agentId).pauseReason).toBe("idle-timeout");
  });

  it("counts a deliverTo worker as a live dependant — but NOT once it is dormant (its wake revives the owner anyway)", async () => {
    const { sup } = makeSupervisor([LIVE("s1"), LIVE("s2")]);
    await sup.spawn(SPAWN_A, { agentId: "conductor" });
    await sup.spawn({ ...SPAWN_B, deliverTo: "conductor" }, { agentId: "worker" });

    expect(sup.hasLiveDependants("conductor")).toBe(true);

    // the worker itself is idle-reaped: a clockless pause is not in-flight work the owner is owed —
    // counting it would keep a conductor with one dormant pool worker resident forever.
    await sup.parkIdle("worker", 99_999);
    expect(sup.status("worker").state).toBe("paused");
    expect(sup.hasLiveDependants("conductor")).toBe(false);
  });

  it("a worker on a CLOCKED hold (session-limit, resumeAt set) still counts — it is coming back on its own", async () => {
    const { sup } = makeSupervisor([LIVE("s1"), LIVE("s2")]);
    await sup.spawn(SPAWN_A, { agentId: "conductor" });
    await sup.spawn(SPAWN_B, { agentId: "worker", parentId: "conductor" });
    await sup.parkIdle("worker", 99_999);
    const rec = (sup as unknown as { agents: Map<string, { pauseReason?: string; resumeAt?: number }> }).agents.get("worker")!;
    rec.pauseReason = "session-limit"; rec.resumeAt = Date.now() + 60_000;
    expect(sup.hasLiveDependants("conductor")).toBe(true);
  });

  it("a same-tree record one level down with NO ownership edge is not a dependant — the stamped edges are the rule", async () => {
    // A sibling's child sits at exactly this depth in the same tree; a depth+1 heuristic counted
    // it as the conductor's own sub-agent and kept the conductor resident for a stranger's work.
    const { sup } = makeSupervisor([LIVE("s1"), LIVE("s2")]);
    await sup.spawn(SPAWN_A, { agentId: "conductor" });
    await sup.spawn(SPAWN_B, { agentId: "stray", treeId: "conductor", depth: 1, parentId: null });
    expect(sup.status("stray").depth).toBe(1);
    expect(sup.hasLiveDependants("conductor")).toBe(false);
  });

  it("an unrelated running agent is not a dependant", async () => {
    const { sup } = makeSupervisor([LIVE("s1"), LIVE("s2")]);
    await sup.spawn(SPAWN_A, { agentId: "conductor" });
    await sup.spawn(SPAWN_B, { agentId: "stranger" });
    expect(sup.hasLiveDependants("conductor")).toBe(false);
  });
});

describe("AgentSupervisor.resumePaused — wake observability and the resumeOnly fallback", () => {
  it("a wake with no sessionId falls back to a FRESH launch instead of resuming into nothing", async () => {
    // parkIdle stamps resumeOnly:true unconditionally; both backends skip the prompt when it is
    // set, so resumeOnly + resume:null would launch a session with no input at all and settle
    // instantly — the crash-loop shape this fallback exists to prevent.
    const { sup, fake, events } = makeSupervisor([LIVE(), LIVE()]);
    await sup.spawn(SPAWN_A, { agentId: "a1" });
    await waitUntil(() => sup.status("a1").state === "running");
    expect(sup.status("a1").sessionId).toBeUndefined();

    await sup.parkIdle("a1", 99_999);
    expect(sup.status("a1").spec.resumeOnly).toBe(true);

    await sup.resumePaused("a1", { resumedBy: "mailbox", from: "worker-7" });

    expect(fake.spawns[1]?.resumeOnly).toBe(false);
    expect(fake.spawns[1]?.resume).toBeNull();
    expect(fake.spawns[1]?.prompt).toBe("x");    // the fresh launch is only useful if the original prompt survived parkIdle
    const st = events.tail("a1", 100).filter((e) => e.kind === "status" && e.data["resumed"] === true);
    expect(st[0]?.data["resumeFallback"]).toBe("fresh-launch");
    expect(st[0]?.data["resumedBy"]).toBe("mailbox");
    expect(st[0]?.data["from"]).toBe("worker-7");
    expect(st[0]?.data["resumedFromPause"]).toBe("idle-timeout");
  });

  it("a wake WITH a session resumes it (resumeOnly kept) and still records who woke it", async () => {
    const { sup, fake, events } = makeSupervisor([LIVE("s1"), LIVE("s1")]);
    await sup.spawn(SPAWN_A, { agentId: "a2" });
    await waitUntil(() => sup.status("a2").sessionId === "s1");

    await sup.parkIdle("a2", 99_999);
    await sup.resumePaused("a2", { resumedBy: "mailbox", from: "worker-9" });

    expect(fake.spawns[1]?.resume).toBe("s1");
    expect(fake.spawns[1]?.resumeOnly).toBe(true);
    const st = events.tail("a2", 100).filter((e) => e.kind === "status" && e.data["resumed"] === true);
    expect(st[0]?.data["resumeFallback"]).toBeUndefined();
    expect(st[0]?.data["resumedBy"]).toBe("mailbox");
  });

  it("an operator resume carries no resumedBy — the event shape is unchanged for it", async () => {
    const { sup, events } = makeSupervisor([LIVE("s1"), LIVE("s1")]);
    await sup.spawn(SPAWN_A, { agentId: "a3" });
    await waitUntil(() => sup.status("a3").sessionId === "s1");
    await sup.parkIdle("a3", 99_999);
    await sup.resumePaused("a3");
    const st = events.tail("a3", 100).filter((e) => e.kind === "status" && e.data["resumed"] === true);
    expect("resumedBy" in (st[0]?.data ?? {})).toBe(false);
  });
});

// REMOTE-CONTROL-SURVIVES-PAUSE: a fresh process from resumePaused always starts with the RC
// bridge off, regardless of what the prior (now-killed) process had toggled — the operator's
// DESIRED state has to be persisted on the record and re-applied after every relaunch.
describe("AgentSupervisor.resumePaused — remote control survives the pause/resume cycle", () => {
  it("preserves remote control through idle reaping and re-issues it after an explicit hold/resume without a sessionId", async () => {
    const { sup, fake, events } = makeSupervisor([LIVE(), LIVE()]);
    await sup.spawn(SPAWN_A, { agentId: "rc1" });
    await waitUntil(() => sup.status("rc1").state === "running");

    const before = await sup.remoteControl("rc1", true);
    expect(before.enabled).toBe(true);

    await sup.parkIdle("rc1", 99_999);
    expect(sup.status("rc1").state).toBe("running");
    expect(fake.spawns).toHaveLength(1);
    await sup.hold("rc1");
    expect(sup.status("rc1").state).toBe("paused");
    await sup.resumePaused("rc1", { resumedBy: "mailbox", from: "worker-1" });
    await waitUntil(() => events.tail("rc1", 100).filter((e) => e.kind === "status" && e.data["remoteControl"] !== undefined).length > 1);

    const rcEvents = events.tail("rc1", 100).filter((e) => e.kind === "status" && e.data["remoteControl"] !== undefined);
    expect(rcEvents).toHaveLength(2);   // one from the initial enable, one re-issued after resume
    const reissued = rcEvents[1]!.data["remoteControl"] as { enabled: boolean; sessionUrl?: string };
    expect(reissued.enabled).toBe(true);
    expect(reissued.sessionUrl).toBeDefined();
  });

  it("does NOT re-enable remote control after an explicit disable — the intent was cleared, not just the live session", async () => {
    const { sup, events } = makeSupervisor([LIVE(), LIVE()]);
    await sup.spawn(SPAWN_A, { agentId: "rc2" });
    await waitUntil(() => sup.status("rc2").state === "running");

    await sup.remoteControl("rc2", true);
    await sup.remoteControl("rc2", false);

    await sup.parkIdle("rc2", 99_999);
    await sup.resumePaused("rc2", { resumedBy: "mailbox", from: "worker-2" });
    await waitUntil(() => sup.status("rc2").state === "running");
    await new Promise((r) => setTimeout(r, 20));   // give any (wrongly) re-issued RC a chance to land

    const rcEvents = events.tail("rc2", 100).filter((e) => e.kind === "status" && e.data["remoteControl"] !== undefined);
    // enable + disable = 2 events; a wrongly-reissued enable after resume would make this 3.
    expect(rcEvents).toHaveLength(2);
    expect((rcEvents[1]!.data["remoteControl"] as { enabled: boolean }).enabled).toBe(false);
  });
});
