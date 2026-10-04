import { describe, it, expect } from "vitest";
import { EventLog } from "@chimera/core/events";
import { makeSupervisor } from "./helpers.js";

const SPAWN = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } as const;

describe("AgentSupervisor questions (spec §17)", () => {
  it("ask() emits agent_question and resolves with the answer from answerQuestion", async () => {
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(sup.answerQuestion(String(e.data["questionId"]), { optionIds: ["yes"] })).toBe(true);
      }
    });
    const { questionId, answer } = await sup.ask(rec.agentId, {
      prompt: "proceed?",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    });
    expect(typeof questionId).toBe("string");
    expect(answer).toEqual({ optionIds: ["yes"] });
  });

  it("agent_question event data carries the spec §17.2 fields", async () => {
    expect.assertions(6);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn({ ...SPAWN, on: { permissionRequest: "tui" } });
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(typeof e.data["questionId"]).toBe("string");
        expect(e.data["prompt"]).toBe("pick one");
        expect(e.data["multiSelect"]).toBe(false);
        expect(e.data["freeform"]).toBe(false);           // options present ⇒ not free-form
        expect(e.data["policy"]).toBe("tui");
        expect(e.data["group"]).toBeNull();
        sup.answerQuestion(String(e.data["questionId"]), { optionIds: ["a"] });
      }
    });
    await sup.ask(rec.agentId, { prompt: "pick one", options: [{ id: "a", label: "A" }] });
  });

  it("free-form default: options absent ⇒ freeform true", async () => {
    expect.assertions(1);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(e.data["freeform"]).toBe(true);
        sup.answerQuestion(String(e.data["questionId"]), { text: "hi" });
      }
    });
    await sup.ask(rec.agentId, { prompt: "free text?" });
  });

  it("falls back to the default answer on timeout", async () => {
    const { sup } = makeSupervisor([]); // questionTimeoutMs: 100 in makeSupervisor
    const rec = await sup.spawn(SPAWN);
    const { answer } = await sup.ask(rec.agentId, { prompt: "pick", default: { text: "fallback" }, timeoutMs: 50 });
    expect(answer).toEqual({ text: "fallback" });
  });

  it("timeout with no default resolves to an empty answer", async () => {
    const { sup } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    const { answer } = await sup.ask(rec.agentId, { prompt: "pick", timeoutMs: 50 });
    expect(answer).toEqual({});
  });

  it("answerQuestion returns false for unknown question ids", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.answerQuestion("nope", { text: "x" })).toBe(false);
  });

  it("ask() throws UnknownAgentError for a ghost agent", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.ask("ghost", { prompt: "?" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("scrubs an injected credential out of the agent_question event data (spec §6)", async () => {
    expect.assertions(2);
    const { sup, events } = makeSupervisor([]);
    // spawning on "second" resolves keychain secret "tok-second" into the supervisor's secrets list
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        const prompt = String(e.data["prompt"]);
        expect(prompt).not.toContain("tok-second");   // secret redacted before persistence
        expect(prompt).toContain("[REDACTED]");
        sup.answerQuestion(String(e.data["questionId"]), { text: "ok" });
      }
    });
    await sup.ask(rec.agentId, { prompt: "use token=tok-second please" });
  });

  it("persists the agent_question event to the EventLog", async () => {
    const { sup, dir, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") sup.answerQuestion(String(e.data["questionId"]), { text: "done" });
    });
    await sup.ask(rec.agentId, { prompt: "logged?" });
    const kinds = new EventLog(dir).tail(rec.agentId, 50).map((e) => e.kind);
    expect(kinds).toContain("agent_question");
  });

  // ---------- additional coverage: every branch/edge in ask()/answerQuestion() ----------

  it("uses deps.questionTimeoutMs as the timeout when q.timeoutMs is omitted", async () => {
    const { sup } = makeSupervisor([]); // questionTimeoutMs: 100 in makeSupervisor
    const rec = await sup.spawn(SPAWN);
    const { answer } = await sup.ask(rec.agentId, { prompt: "pick" }); // no timeoutMs -> falls back to deps default
    expect(answer).toEqual({});
  });

  it("default with optionIds only resolves that shape on timeout", async () => {
    const { sup } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    const { answer } = await sup.ask(rec.agentId, { prompt: "pick", default: { optionIds: ["z"] }, timeoutMs: 50 });
    expect(answer).toEqual({ optionIds: ["z"] });
  });

  it("default with both optionIds and text merges both on timeout", async () => {
    const { sup } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    const { answer } = await sup.ask(rec.agentId, { prompt: "pick", default: { optionIds: ["z"], text: "note" }, timeoutMs: 50 });
    expect(answer).toEqual({ optionIds: ["z"], text: "note" });
  });

  it("includes header in the event data when provided, and omits the key when not", async () => {
    expect.assertions(2);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    let seen = 0;
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        seen++;
        if (seen === 1) {
          expect(e.data["header"]).toBe("Confirm");
          sup.answerQuestion(String(e.data["questionId"]), { text: "a" });
        } else {
          expect("header" in e.data).toBe(false);
          sup.answerQuestion(String(e.data["questionId"]), { text: "b" });
        }
      }
    });
    await sup.ask(rec.agentId, { prompt: "p1", header: "Confirm" });
    await sup.ask(rec.agentId, { prompt: "p2" });
  });

  it("omits the options key from event data when none are provided", async () => {
    expect.assertions(1);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect("options" in e.data).toBe(false);
        sup.answerQuestion(String(e.data["questionId"]), { text: "x" });
      }
    });
    await sup.ask(rec.agentId, { prompt: "free" });
  });

  it("preserves multiSelect:true when explicitly set", async () => {
    expect.assertions(1);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(e.data["multiSelect"]).toBe(true);
        sup.answerQuestion(String(e.data["questionId"]), { optionIds: ["a", "b"] });
      }
    });
    await sup.ask(rec.agentId, {
      prompt: "pick many",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      multiSelect: true,
    });
  });

  it("honors an explicit freeform:true override even when options are present", async () => {
    expect.assertions(1);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(e.data["freeform"]).toBe(true);
        sup.answerQuestion(String(e.data["questionId"]), { text: "x" });
      }
    });
    await sup.ask(rec.agentId, { prompt: "p", options: [{ id: "a", label: "A" }], freeform: true });
  });

  it("honors an explicit freeform:false override even when options are absent", async () => {
    expect.assertions(1);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        expect(e.data["freeform"]).toBe(false);
        sup.answerQuestion(String(e.data["questionId"]), { text: "x" });
      }
    });
    await sup.ask(rec.agentId, { prompt: "p", freeform: false });
  });

  it("redacts a secret nested inside an option's label (deep redaction, spec §6)", async () => {
    expect.assertions(2);
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        const opts = e.data["options"] as Array<{ label: string }>;
        expect(opts[0]!.label).not.toContain("tok-second");
        expect(opts[0]!.label).toContain("[REDACTED]");
        sup.answerQuestion(String(e.data["questionId"]), { optionIds: ["a"] });
      }
    });
    await sup.ask(rec.agentId, { prompt: "pick", options: [{ id: "a", label: "use tok-second" }] });
  });

  it("answerQuestion returns false when called again after the question already resolved", async () => {
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    let qid = "";
    events.subscribe((e) => {
      if (e.kind === "agent_question") {
        qid = String(e.data["questionId"]);
        sup.answerQuestion(qid, { text: "first" });
      }
    });
    const { answer } = await sup.ask(rec.agentId, { prompt: "p" });
    expect(answer).toEqual({ text: "first" });
    expect(sup.answerQuestion(qid, { text: "second" })).toBe(false);   // already resolved & removed from the registry
  });

  it("answerQuestion returns false for a questionId that has already resolved via timeout", async () => {
    const { sup } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    const { questionId } = await sup.ask(rec.agentId, { prompt: "p", timeoutMs: 50 }); // nobody answers -> times out
    expect(sup.answerQuestion(questionId, { text: "late" })).toBe(false);
  });

  // ---------- FEATURE-9 attention inbox bug fix: status{questionResolved} ----------

  it("the timeout fallback emits a correlatable status{questionResolved} event", async () => {
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    const { questionId } = await sup.ask(rec.agentId, { prompt: "p", timeoutMs: 50 }); // nobody answers -> times out
    const evs = events.tail(rec.agentId, 50);
    const resolved = evs.find((e) => e.kind === "status" && e.data["questionResolved"] === true)!;
    expect(resolved.data["questionId"]).toBe(questionId);
    expect(resolved.data["timedOut"]).toBe(true);
  });

  // ANSWERED-PROMPT-STAYS-PENDING: this test's real invariant is that ANSWERING CANCELS THE
  // TIMER — the timeout fallback must not also fire and double-resolve. It used to prove that by
  // asserting NO questionResolved event at all, which worked only while the timeout was the sole
  // producer of one. An answer now emits its own (that is the fix: a prompt answered by anyone
  // other than the client showing the banner used to leave a stale `?` forever). So the invariant
  // is pinned directly instead: exactly ONE resolution, and it is the answer's, not the timeout's.
  it("answering cancels the timeout — exactly one resolution event, and it is not the timeout's", async () => {
    const { sup, events } = makeSupervisor([]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_question") sup.answerQuestion(String(e.data["questionId"]), { text: "fast" });
    });
    await sup.ask(rec.agentId, { prompt: "p", timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 150));   // well past the 100ms timeout the answer must have cleared
    const resolved = events.tail(rec.agentId, 50).filter((e) => e.kind === "status" && e.data["questionResolved"] === true);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data["timedOut"]).toBeUndefined();
  });
});
