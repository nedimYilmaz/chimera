import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { isRevivableHold } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";

// OPERATOR-HOLD: stop an agent NOW without losing it. The SDK cannot freeze a turn in place, so
// an immediate hold aborts the running turn — and what makes that safe is putting the turn's own
// input BACK in the mailbox, so release replays it against a session that still has full context.
//
// The invariants worth pinning: a held agent does not run, nothing wakes it but a release, and
// nothing about it is lost.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 8 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const spawn = async (e: Engine, prompt = "work") =>
  (await e.handle("agent.spawn", { spec: { prompt, cwd: "/tmp", isolation: "none" } })) as { agentId: string };

describe("agent.hold", () => {
  it("parks a running agent without ending it — the session survives for a later resume", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();

    const res = await e.handle("agent.hold", { agentIds: [a.agentId] }) as { held: string[]; skipped: unknown[] };
    expect(res.held).toEqual([a.agentId]);
    const rec = e.supervisor.status(a.agentId);
    expect(rec.state).toBe("paused");
    expect(rec.pauseReason).toBe("operator-hold");
    expect(rec.spec.resumeOnly).toBe(true);        // resumes the prior session, never re-runs the spawn prompt blind
  });

  it("a hold is NOT revivable — mail must not overrule a decision the operator made", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.hold", { agentIds: [a.agentId] });

    expect(isRevivableHold(e.supervisor.status(a.agentId))).toBe(false);
    // mail arrives and QUEUES; the agent stays down
    await e.handle("agent.send", { agentId: a.agentId, text: "are you there?" });
    await flush();
    expect(e.supervisor.status(a.agentId).state).toBe("paused");
    expect(e.mailboxes.pending(a.agentId).length).toBeGreaterThan(0);
  });

  it("requeues the aborted turn's own input, so releasing replays it rather than dropping it", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.send", { agentId: a.agentId, text: "the task" });
    await flush();                                  // delivered → now in-flight for the running turn
    expect(e.mailboxes.pending(a.agentId)).toHaveLength(0);

    await e.handle("agent.hold", { agentIds: [a.agentId] });
    expect(e.mailboxes.pending(a.agentId).map((m) => m.text)).toContain("the task");
  });

  it("holds many at once and reports what actually transitioned", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e), b = await spawn(e);
    await flush();
    await e.handle("agent.hold", { agentIds: [a.agentId] });          // a is already held

    const res = await e.handle("agent.hold", { agentIds: [a.agentId, b.agentId] }) as {
      held: string[]; skipped: Array<{ agentId: string; state: string }>;
    };
    expect(res.held).toEqual([b.agentId]);
    expect(res.skipped).toEqual([{ agentId: a.agentId, state: "paused" }]);   // a no-op, not a failure
  });

  it("is a no-op for an agent that already finished", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ end: { resultText: "done" } }]])]]) });
    const a = await spawn(e);
    await flush();
    const res = await e.handle("agent.hold", { agentIds: [a.agentId] }) as { held: string[] };
    expect(res.held).toEqual([]);
  });
});

describe("agent.release", () => {
  it("brings a held agent back and delivers what queued while it was down", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.hold", { agentIds: [a.agentId] });
    await e.handle("agent.send", { agentId: a.agentId, text: "queued while held" });

    const res = await e.handle("agent.release", { agentIds: [a.agentId] }) as { released: string[] };
    expect(res.released).toEqual([a.agentId]);
    await flush(120);                                            // relaunch + agent_started -> deliverPending
    expect(e.supervisor.status(a.agentId).state).toBe("running");
    expect(e.mailboxes.pending(a.agentId)).toHaveLength(0);      // drained into the resumed session
  });

  it.each(["session-limit", "crash-loop-backoff"] as const)("keeps protective %s pauses held", async (pauseReason) => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    // Protective pauses cannot be bypassed by the ordinary resume control.
    e.supervisor.reattachPaused({ ...e.supervisor.status(a.agentId), state: "paused", pauseReason });

    const res = await e.handle("agent.release", { agentIds: [a.agentId] }) as { released: string[]; skipped: unknown[] };
    expect(res.released).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(e.supervisor.status(a.agentId).pauseReason).toBe(pauseReason);   // left exactly as it was
  });

  it("releases many at once", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e), b = await spawn(e);
    await flush();
    await e.handle("agent.hold", { agentIds: [a.agentId, b.agentId] });
    const res = await e.handle("agent.release", { agentIds: [a.agentId, b.agentId] }) as { released: string[] };
    expect(res.released.sort()).toEqual([a.agentId, b.agentId].sort());
  });
});
