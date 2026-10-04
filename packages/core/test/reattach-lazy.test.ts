import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { AgentSpecSchema } from "@chimera/protocol";
import type { AgentRecord } from "@chimera/core/supervisor";
import { reattachConductors } from "@chimera/core/reattach";
import { makeEngineHome } from "./helpers.js";

// LAZY-REATTACH: a daemon restart used to re-spawn EVERY prior running agent immediately —
// on a real fleet that is ~20 provider CLI processes in one burst, right at the moment a
// reconnecting UI is trying to load its first snapshot (measured: enough to push agent.list
// past the desktop bridge's 30s call timeout, which left the app blank). The session lives in
// AgentRecord.sessionId, not in the process, so the process can be deferred with nothing lost:
// a prior running agent comes back PAUSED and its OS process starts on the first action that
// genuinely needs a live session (the existing resumePaused path — the same one a session-limit
// hold already uses), turning it running/green again.

function engineWith(fake: FakeAgentBackend): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", fake]]),
  });
}

function priorRunning(over: Partial<AgentRecord> = {}): AgentRecord {
  const spec = AgentSpecSchema.parse({ prompt: "the original brief", cwd: "/tmp", isolation: "none" });
  return {
    agentId: "agent-1", spec, accountName: "main", provider: "claude",
    state: "running", depth: 0, treeId: "agent-1", createdAt: Date.now(),
    principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    sessionId: "sess-1",
    ...over,
  } as AgentRecord;
}

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("lazy reattach (default)", () => {
  it("brings a prior running agent back PAUSED, with no backend process spawned", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning()]);
    await flush();

    const rec = e.supervisor.status("agent-1");
    expect(rec.state).toBe("paused");
    expect(rec.pauseReason).toBeTruthy();
    // the whole point: the burst of provider processes never happens
    expect(fake.launched?.length ?? 0).toBe(0);
  });

  it("keeps the agent VISIBLE and keeps its session, so resuming continues the same conversation", async () => {
    const e = engineWith(new FakeAgentBackend([[{ awaitSend: true }]]));
    reattachConductors(e, [priorRunning({ agentId: "a2", treeId: "a2", sessionId: "sess-2" })]);
    await flush();

    const listed = (await e.handle("agent.list", { lite: true })) as Array<Record<string, unknown>>;
    const row = listed.find((r) => r["agentId"] === "a2");
    expect(row).toBeTruthy();
    expect(row!["state"]).toBe("paused");
    expect(e.supervisor.status("a2").sessionId).toBe("sess-2");
  });

  it("arms NO auto-resume timer — a restart hold waits for the operator, unlike a session-limit hold", async () => {
    const e = engineWith(new FakeAgentBackend([[{ awaitSend: true }]]));
    reattachConductors(e, [priorRunning({ agentId: "a3", treeId: "a3" })]);
    await flush(60);
    // a session-limit reattach with no resumeAt resumes immediately; this one must NOT
    expect(e.supervisor.status("a3").state).toBe("paused");
  });

  it("resuming it launches the process and turns it running again", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning({ agentId: "a4", treeId: "a4" })]);
    await flush();
    expect(e.supervisor.status("a4").state).toBe("paused");

    const released = await e.handle("agent.release", { agentIds: ["a4"] });
    expect(released).toMatchObject({ released: ["a4"] });
    await flush();
    expect(e.supervisor.status("a4").state).toBe("running");
    expect(e.supervisor.status("a4").pauseReason).toBeUndefined();
  });

  it("the resumed launch does NOT re-send the original prompt — a restart resumes idle, as it always did", async () => {
    const e = engineWith(new FakeAgentBackend([[{ awaitSend: true }]]));
    reattachConductors(e, [priorRunning({ agentId: "a5", treeId: "a5" })]);
    await flush();
    // resumeOnly is stamped at reattach time so whichever path later resumes this record
    // (operator click, an RPC that needs the live session) inherits the idle-resume contract.
    expect((e.supervisor.status("a5").spec as { resumeOnly?: boolean }).resumeOnly).toBe(true);
  });

  it("a terminal record is still display-only, and a scheduler-owned worker is still skipped", async () => {
    const e = engineWith(new FakeAgentBackend([]));
    reattachConductors(e, [
      priorRunning({ agentId: "done-1", treeId: "done-1", state: "done" }),
      priorRunning({ agentId: "worker-1", treeId: "worker-1", membership: { team: "t", role: "r" } }),
    ]);
    await flush();
    expect(e.supervisor.status("done-1").state).toBe("done");
    // a membership worker is re-dispatched by the scheduler, never reattached
    expect(() => e.supervisor.status("worker-1")).toThrow();
  });
});

describe("eager reattach (opt-out)", () => {
  it("still re-spawns immediately when configured, preserving the prior behavior", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning({ agentId: "e1", treeId: "e1" })], "eager");
    await flush(30);
    expect(e.supervisor.status("e1").state).toBe("running");
  });
});

describe("the first real message revives a dormant agent", () => {
  it("agent.send launches the held session instead of failing with 'not running'", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning({ agentId: "m1", treeId: "m1" })]);
    await flush();
    expect(e.supervisor.status("m1").state).toBe("paused");

    await e.supervisor.send("m1", "carry on");
    await flush();
    expect(e.supervisor.status("m1").state).toBe("running");
  });

  // ASK-REVIVES-DORMANT: ask() used to refuse any non-running target BEFORE reaching send()'s
  // revive step — so a child asking its parked conductor for a decision failed with "is paused;
  // cannot deliver messages" (two such failures on 2026-09-01 against a restart-dormant
  // conductor), exactly the moment the conductor was needed.
  it("agent.ask revives a dormant target and delivers the question, instead of refusing it", async () => {
    // scenario 1: the asker; scenario 2: the dormant target's relaunch (absorbs the question)
    const fake = new FakeAgentBackend([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning({ agentId: "d1", treeId: "d1" })]);
    await flush();
    expect(e.supervisor.status("d1").state).toBe("paused");
    const asker = await e.supervisor.spawn(AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none" }));

    const delivered = new Promise<string>((resolve) => {
      e.events.subscribe((ev) => {
        if (ev.agentId === "d1" && ev.kind === "message_complete") resolve(String(ev.data["text"]));
      });
    });
    const { answer } = await e.supervisor.ask(asker.agentId, { prompt: "which way?", to: { agentId: "d1" }, timeoutMs: 200, default: { text: "timed-out" } });
    expect(e.supervisor.status("d1").state).toBe("running");
    expect(await delivered).toContain("which way?");
    expect(answer).toEqual({ text: "timed-out" });      // nobody answered; the point is it was DELIVERED, not refused
  });

  it("agent.ask still refuses a session-limit target — that hold is not bypassable by asking either", async () => {
    const e = engineWith(new FakeAgentBackend([[{ awaitSend: true }]]));
    const prior = priorRunning({ agentId: "q2", treeId: "q2", state: "paused" });
    (prior as { pauseReason?: string }).pauseReason = "session-limit";
    (prior as { resumeAt?: number }).resumeAt = Date.now() + 60_000;
    e.supervisor.reattachPaused(prior);
    const asker = await e.supervisor.spawn(AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none" }));
    await flush();
    await expect(e.supervisor.ask(asker.agentId, { prompt: "p", to: { agentId: "q2" } })).rejects.toBeTruthy();
    expect(e.supervisor.status("q2").state).toBe("paused");
  });

  it("does NOT let a message bypass a session-limit hold — that hold has its own reset clock", async () => {
    const e = engineWith(new FakeAgentBackend([[{ awaitSend: true }]]));
    const prior = priorRunning({ agentId: "q1", treeId: "q1", state: "paused" });
    (prior as { pauseReason?: string }).pauseReason = "session-limit";
    (prior as { resumeAt?: number }).resumeAt = Date.now() + 60_000;
    e.supervisor.reattachPaused(prior);
    await flush();
    expect(e.supervisor.status("q1").state).toBe("paused");
    await expect(e.supervisor.send("q1", "let me in")).rejects.toBeTruthy();
    expect(e.supervisor.status("q1").state).toBe("paused");
  });
});

describe("mail landing on a dormant agent wakes it", () => {
  it("a message delivered to a restart-dormant agent resumes it instead of queueing silently", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const e = engineWith(fake);
    reattachConductors(e, [priorRunning({ agentId: "box-1", treeId: "box-1" })]);
    await flush();
    expect(e.supervisor.status("box-1").state).toBe("paused");

    // The path every deliverTo result, hook notify and subscription signal takes: enqueue +
    // deliverPending. Without the wake, the work would sit in a mailbox nobody drains and the
    // orchestration would stall with no error anywhere.
    await e.handle("agent.send", { agentId: "box-1", text: "result from a child" });
    await flush(20);
    expect(e.supervisor.status("box-1").state).toBe("running");
  });
});
