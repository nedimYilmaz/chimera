import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// ANSWERED-PROMPT-STAYS-PENDING: a prompt that gets ANSWERED must announce itself on the event
// log, exactly like the timeout fallbacks already did. Before this, respondPermission /
// answerQuestion / answerDialog resolved their promise and emitted NOTHING — so a client only
// cleared its banner because IT had dispatched a local action right after calling the RPC. Any
// other surface (the other client, a reloaded one, or an agent answering another agent through
// the chimera MCP tools) kept showing a stale `?` until the agent hit a terminal state. Observed
// live: an agent whose question its conductor had answered had exactly one agent_question event
// in the log and no resolution of any kind.
const PARKED = (): FakeStep[] => [{ awaitSend: true }, { end: { resultText: "done" } }];

const SPAWN = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } as const;

function resolvedEvents(events: { tail: (agentId: string, n: number) => Array<{ kind: string; data: Record<string, unknown> }> }, agentId: string) {
  return events.tail(agentId, 50).filter((e) =>
    e.kind === "status" && (e.data["questionResolved"] === true || e.data["permissionResolved"] === true || e.data["dialogResolved"] === true));
}

describe("answering a prompt announces its resolution on the event log", () => {
  it("answerQuestion emits status{questionResolved} for the asking agent — WITHOUT timedOut", async () => {
    const { sup, events } = makeSupervisor([PARKED()]);
    const a = await sup.spawn(SPAWN);

    let questionId = "";
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) questionId = String(e.data["questionId"]);
    });
    const asked = sup.ask(a.agentId, { prompt: "which way?" });
    await new Promise((r) => setTimeout(r, 20));
    expect(questionId).not.toBe("");

    expect(sup.answerQuestion(questionId, { text: "left" } as never)).toBe(true);
    await asked;

    const resolved = resolvedEvents(events, a.agentId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data).toEqual({ questionResolved: true, questionId });
    // `timedOut` is what tells a reader the daemon gave up rather than a human deciding —
    // stamping it on a real answer would misreport every answered prompt as abandoned.
    expect("timedOut" in resolved[0]!.data).toBe(false);
  });

  it("does NOT emit for an unknown questionId (nothing was pending, nothing to announce)", async () => {
    const { sup, events } = makeSupervisor([PARKED()]);
    const a = await sup.spawn(SPAWN);
    expect(sup.answerQuestion("no-such-question", { text: "x" } as never)).toBe(false);
    expect(resolvedEvents(events, a.agentId)).toHaveLength(0);
  });

  it("a SECOND answer for the same questionId is a no-op — one question, one resolution event", async () => {
    const { sup, events } = makeSupervisor([PARKED()]);
    const a = await sup.spawn(SPAWN);
    let questionId = "";
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) questionId = String(e.data["questionId"]);
    });
    const asked = sup.ask(a.agentId, { prompt: "which way?" });
    await new Promise((r) => setTimeout(r, 20));

    expect(sup.answerQuestion(questionId, { text: "left" } as never)).toBe(true);
    expect(sup.answerQuestion(questionId, { text: "right" } as never)).toBe(false);
    await asked;
    expect(resolvedEvents(events, a.agentId)).toHaveLength(1);
  });

  it("respondPermission emits status{permissionResolved} carrying the decision", async () => {
    // Driven the way the real path is: the backend asks, the supervisor routes it to a
    // permission_request (permissionRequest: "tui"), and an external answerer responds.
    const { sup, events } = makeSupervisor([[{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }]]);
    let requestId = "";
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      requestId = String(e.data["requestId"]);
      sup.respondPermission(requestId, true);
    });
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "acceptEdits", on: { permissionRequest: "tui" },
    });
    await sup.waitFor(rec.agentId, 2000);

    const resolved = resolvedEvents(events, rec.agentId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data).toEqual({ permissionResolved: true, requestId, allow: true });
    // `timedOut` is what tells a reader the daemon gave up rather than a human deciding —
    // stamping it on a real answer would misreport every answered prompt as abandoned.
    expect("timedOut" in resolved[0]!.data).toBe(false);
  });
});
