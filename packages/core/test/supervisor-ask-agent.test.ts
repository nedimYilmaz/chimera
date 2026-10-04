import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, AgentNotRunningError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const SPAWN_A = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } as const;
const SPAWN_B = { prompt: "x", cwd: "/tmp", account: "second", isolation: "none" } as const;

// A stays parked on awaitSend so it remains "running" for the whole test
// (ask() doesn't require the asker to be running, but this mirrors realistic
// agent behavior and avoids incidental state-machine interference).
const PARKED = (): FakeStep[] => [{ awaitSend: true }, { end: { resultText: "a-done" } }];

// B: first awaitSend absorbs the delivered question (echoing it back as a
// message_complete event we can observe), then ends.
const RECEIVER = (): FakeStep[] => [{ awaitSend: true }, { end: { resultText: "b-done" } }];

describe("AgentSupervisor.ask — agent-to-agent `to` (spec §17 D1)", () => {
  it("delivers the question to B's mailbox and B's answer_question resolves A's blocked ask", async () => {
    const { sup, events } = makeSupervisor([PARKED(), RECEIVER()]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);

    let questionId = "";
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) questionId = String(e.data["questionId"]);
    });

    const delivered = new Promise<string>((resolve) => {
      events.subscribe((e) => {
        if (e.agentId === b.agentId && e.kind === "message_complete") resolve(String(e.data["text"]));
      });
    });

    const askPromise = sup.ask(a.agentId, { prompt: "pick one", to: { agentId: b.agentId } });
    expect(questionId).not.toBe(""); // registered + emitted synchronously before ask()'s first await

    const deliveredText = await delivered;
    expect(deliveredText).toContain(`[question ${questionId} from ${a.agentId}]`);
    expect(deliveredText).toContain("pick one");
    expect(deliveredText).toContain(`Answer it by calling answer_question with questionId "${questionId}"`);

    // simulate B calling answer_question — resolves via the EXISTING questionId registry
    expect(sup.answerQuestion(questionId, { text: "blue" })).toBe(true);

    const result = await askPromise;
    expect(result).toEqual({ questionId, answer: { text: "blue" } });
  });

  it("the emitted agent_question event carries to === B and replyTo === A", async () => {
    expect.assertions(2);
    const { sup, events } = makeSupervisor([PARKED(), RECEIVER()]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);

    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) {
        expect(e.data["to"]).toBe(b.agentId);
        expect(e.data["replyTo"]).toBe(a.agentId);
        sup.answerQuestion(String(e.data["questionId"]), { text: "x" });
      }
    });

    await sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } });
  });

  it("resolver exists before delivery: B can answer the instant it observes the delivered message", async () => {
    const { sup, events } = makeSupervisor([PARKED(), RECEIVER()]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);

    events.subscribe((e) => {
      if (e.agentId === b.agentId && e.kind === "message_complete") {
        const m = /\[question (\S+) from/.exec(String(e.data["text"]));
        if (m) sup.answerQuestion(m[1]!, { text: "answered-on-delivery" });
      }
    });

    const { answer } = await sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } });
    expect(answer).toEqual({ text: "answered-on-delivery" });
  });

  it("no `to`: byte-identical to §17 — no to/replyTo fields, and delivers nothing to any mailbox", async () => {
    expect.assertions(4);
    const { sup, events, dir } = makeSupervisor([PARKED(), RECEIVER()]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);

    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) {
        expect("to" in e.data).toBe(false);
        expect("replyTo" in e.data).toBe(false);
        // FEATURE-9: a plain ask() call (no `gate`) must not carry the key at all —
        // only a workflow approval-gate ask (scheduler.ts) sets it.
        expect("gate" in e.data).toBe(false);
        sup.answerQuestion(String(e.data["questionId"]), { text: "ok" });
      }
    });

    await sup.ask(a.agentId, { prompt: "no target here" });

    // B never received anything: no message_complete/mailbox activity for B.
    const { MailboxStore } = await import("@chimera/core/mailbox");
    expect(new MailboxStore(dir).pending(b.agentId)).toEqual([]);
  });

  // ASK-UNREACHABLE-TARGET-LEAK: the target's reachability is now checked BEFORE the
  // questionId is registered or the agent_question event is emitted, for BOTH an unknown
  // and a terminal (done/failed/killed) target — otherwise an undeliverable inter-agent ask
  // still broadcast a question-card event nothing would ever answer, which a human client
  // (app/tui) rendered as an orphaned QuestionCard falling to the human.
  it("bad target (unknown agent): rejects with NO agent_question event ever emitted", async () => {
    expect.assertions(2);
    const { sup, events } = makeSupervisor([PARKED()]);
    const a = await sup.spawn(SPAWN_A);
    let sawEvent = false;
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) sawEvent = true;
    });
    await expect(sup.ask(a.agentId, { prompt: "p", to: { agentId: "ghost" } }))
      .rejects.toBeInstanceOf(UnknownAgentError);
    expect(sawEvent).toBe(false);
  });

  it("bad target (done agent): rejects with NO agent_question event ever emitted and no leaked pending question", async () => {
    expect.assertions(3);
    const { sup, events } = makeSupervisor([PARKED(), [{ end: { resultText: "already-done" } }]]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);
    await sup.waitFor(b.agentId, 1000); // B finishes immediately -> state "done"
    let sawEvent = false;
    let questionId = "";
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) {
        sawEvent = true;
        questionId = String(e.data["questionId"]);
      }
    });
    await expect(sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } }))
      .rejects.toBeInstanceOf(AgentNotRunningError);
    expect(sawEvent).toBe(false);
    // no questionId was ever minted, so answering an empty string is trivially a no-op
    expect(sup.answerQuestion(questionId, { text: "late" })).toBe(false);
  });

  // PAUSED-CONDUCTOR (operator-reported): a target held only because nothing needed it
  // (daemon-restart / idle-timeout) is NOT unreachable — send() revives it exactly as a plain
  // agent_send does. Refusing it here was the asymmetry the operator hit: agent_send woke a
  // dormant conductor while ask_agent bounced off it, so workers spawned after a daemon restart
  // could not reach their own conductor.
  it("revivable-paused target (idle-timeout): the ask WAKES it and gets answered", async () => {
    const LIVE_B = (): FakeStep[] => [
      { emit: { kind: "agent_started", data: { sessionId: "s1" } } },
      { awaitSend: true },
      { end: { resultText: "b-done" } },
    ];
    const { sup, events } = makeSupervisor([PARKED(), LIVE_B(), LIVE_B()]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);
    await waitUntil(() => sup.status(b.agentId).sessionId === "s1");

    await sup.parkIdle(b.agentId, 99_999);
    expect(sup.status(b.agentId).state).toBe("paused");
    expect(sup.status(b.agentId).pauseReason).toBe("idle-timeout");

    events.subscribe((e) => {
      if (e.agentId === b.agentId && e.kind === "message_complete") {
        const m = /\[question (\S+) from/.exec(String(e.data["text"]));
        if (m) sup.answerQuestion(m[1]!, { text: "woken-and-answered" });
      }
    });

    const { answer } = await sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } });
    expect(answer).toEqual({ text: "woken-and-answered" });
    expect(sup.status(b.agentId).state).not.toBe("paused");

    // the wake is observable: the transcript says who woke it and out of which hold
    const woke = events.tail(b.agentId, 200)
      .filter((e) => e.kind === "status" && e.data["resumed"] === true);
    expect(woke[0]?.data["resumedBy"]).toBe("mailbox");
    // "ask" is the mailbox sender sentinel every ask-delivery rides under (see NON_AGENT_FROM
    // in the app's project selectors) — the asker's own id is inside the delivered question text.
    expect(woke[0]?.data["from"]).toBe("ask");
    expect(woke[0]?.data["resumedFromPause"]).toBe("idle-timeout");
  });

  it("non-revivable hold (operator-hold): rejects with a typed error NAMING the reason, no agent_question emitted", async () => {
    const { sup, events } = makeSupervisor([PARKED(), [{ awaitSend: true }]]);
    const a = await sup.spawn(SPAWN_A);
    const b = await sup.spawn(SPAWN_B);
    await sup.hold(b.agentId);
    expect(sup.status(b.agentId).pauseReason).toBe("operator-hold");

    let sawEvent = false;
    events.subscribe((e) => {
      if (e.kind === "agent_question" && e.agentId === a.agentId) sawEvent = true;
    });

    await expect(sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } }))
      .rejects.toThrow(/paused \(operator-hold\).*release it with agent_release/);
    await expect(sup.ask(a.agentId, { prompt: "p", to: { agentId: b.agentId } }))
      .rejects.toBeInstanceOf(AgentNotRunningError);
    expect(sawEvent).toBe(false);
  });
});
