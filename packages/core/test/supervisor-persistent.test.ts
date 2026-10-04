import { describe, it, expect } from "vitest";
import type { EventLog } from "@chimera/core/events";
import type { EventKind } from "@chimera/protocol";
import { makeSupervisor } from "./helpers.js";

// Waits for the Nth (1-indexed) occurrence of `kind` on `agentId` and resolves
// with that event's data. No wall-clock timers — driven purely by EventLog's
// subscribe callback, mirroring the wait patterns in supervisor.test.ts.
function waitForNth(
  events: EventLog, agentId: string, kind: EventKind, n: number, timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${kind} #${n} on ${agentId}`));
    }, timeoutMs);
    const unsub = events.subscribe((e) => {
      if (e.agentId === agentId && e.kind === kind) {
        seen += 1;
        if (seen === n) { clearTimeout(timer); unsub(); resolve(e.data); }
      }
    });
  });
}

// NOTE: the fake backend's `turn` step never ends the agent for ANY spec
// (persistent or not) — it has no idle-close guard at all. So these tests
// verify the supervisor/scheduler-level flow-through of `persistent` into
// the spawn spec (`fake.spawns[0].persistent`) plus the fake's `turn` step
// mechanics, NOT the backend idle-close behavior itself. That behavior lives
// solely in claude.ts's `!spec.conductor && !spec.persistent` guard, which
// is covered by inspection only — see the per-test note above the
// non-persistent test below.
describe("AgentSupervisor: persistent agents stay alive across turns (Task A2)", () => {
  it("stays 'running' (not 'done') after the first turn_complete", async () => {
    const { sup, events, fake } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { turn: { text: "did task 1" } },
      { awaitSend: true },
      { turn: { text: "did task 2" } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", persistent: true });

    // isolates the actual A2 flow-through: the `persistent` flag on the spawn
    // request must reach the backend's spawn spec. The fake's `turn` step
    // itself never ends the agent regardless of this flag (see file-level
    // note below) — this assertion is what proves the flag actually arrived.
    expect(fake.spawns[0]!.persistent).toBe(true);

    const firstTurn = waitForNth(events, rec.agentId, "turn_complete", 1);
    await sup.send(rec.agentId, "go");
    await firstTurn;

    expect(sup.status(rec.agentId).state).toBe("running");
  });

  it("a second send() drives a second turn_complete/message_complete while the agent remains running", async () => {
    const { sup, events, fake } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { turn: { text: "did task 1" } },
      { awaitSend: true },
      { turn: { text: "did task 2" } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", persistent: true });
    expect(fake.spawns[0]!.persistent).toBe(true);

    await sup.send(rec.agentId, "go");
    await waitForNth(events, rec.agentId, "turn_complete", 1);
    expect(sup.status(rec.agentId).state).toBe("running");

    // fresh subscriptions only count occurrences from here on: the scenario's
    // 2nd turn is the 1st (and only) turn_complete/message_complete these
    // listeners will ever see (message #1 in that window is the "next" echo
    // from awaitSend, message #2 is the turn's own text — hence n:2 here).
    const secondTurn = waitForNth(events, rec.agentId, "turn_complete", 1);
    const secondMessage = waitForNth(events, rec.agentId, "message_complete", 2);
    await sup.send(rec.agentId, "next");
    const [turnData, msgData] = await Promise.all([secondTurn, secondMessage]);

    expect(turnData).toEqual({ totalCostUsd: 0 });
    expect(msgData).toEqual({ text: "did task 2" });
    expect(sup.status(rec.agentId).state).toBe("running");
  });

  // CONTRAST — NOTE this proves less than the name implies: it uses a
  // DIFFERENT scenario ({end:} step) than tests 1/2/4 ({turn:} step), so it
  // only proves an {end:} step reaches a terminal state; it does NOT isolate
  // `persistent` as the reason tests 1/2/4 stay alive. The fake backend's
  // `turn` step never reads `spec.persistent` at all — it never emits
  // `result` regardless of the flag, so a non-persistent agent driven through
  // {turn:} steps would ALSO stay "running" in this fake. The real
  // behavioral effect of `persistent` (keeping the input stream open once a
  // turn would otherwise idle-close it) lives solely in the claude backend's
  // guard (`packages/core/src/backends/claude.ts`: `!spec.conductor &&
  // !spec.persistent`), which this suite does not exercise end-to-end — that
  // guard is inspection-covered only. What tests 1/2/4 verify at the
  // supervisor/fake layer is the flow-through of the flag itself
  // (`fake.spawns[0].persistent === true`), which is the mechanism this
  // fake can actually observe.
  it("a non-persistent agent still reaches a terminal state via the existing {end:} step", async () => {
    const { sup, fake } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { end: { resultText: "wrapped up" } },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });   // persistent defaults false
    expect(fake.spawns[0]!.persistent).toBe(false);

    await sup.send(rec.agentId, "go");
    const final = await sup.waitFor(rec.agentId, 1000);

    expect(final.state).toBe("done");
    expect(final.resultText).toBe("wrapped up");
  });

  it("fake `turn` step without text emits turn_complete but NO message_complete", async () => {
    const { sup, events, fake } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { turn: {} },
    ]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", persistent: true });
    expect(fake.spawns[0]!.persistent).toBe(true);

    const messageKinds: string[] = [];
    const unsub = events.subscribe((e) => {
      if (e.agentId === rec.agentId) messageKinds.push(e.kind);
    });
    await sup.send(rec.agentId, "go");
    await waitForNth(events, rec.agentId, "turn_complete", 1);
    unsub();

    // one message_complete from awaitSend's echo, then turn_complete from the
    // textless turn step — never a second message_complete.
    expect(messageKinds.filter((k) => k === "message_complete").length).toBe(1);
    expect(messageKinds.filter((k) => k === "turn_complete").length).toBe(1);
    expect(sup.status(rec.agentId).state).toBe("running");
  });
});
