import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

const SPAWN = { prompt: "x", cwd: "/tmp", account: "main", isolation: "none" } as const;

describe("AgentSupervisor dialogs (native-CLI-parity Phase 2, Task DLG1)", () => {
  it("a {dialog} scenario step emits agent_dialog with dialogId/dialogKind/payload; answerDialog resolves it", async () => {
    expect.assertions(4);
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: { questions: [{ q: "?" }] } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_dialog") {
        expect(e.data["dialogId"]).toBe("d1");
        expect(e.data["dialogKind"]).toBe("permission_ask_user_question");
        expect(e.data["payload"]).toEqual({ questions: [{ q: "?" }] });
        expect(sup.answerDialog("d1", { behavior: "completed", result: { answers: { q: "a" } } })).toBe(true);
      }
    });
    await sup.waitFor(rec.agentId, 1000);
  });

  it("times out an unanswered dialog to {behavior:'cancelled'} and appends a dialogResolved status event", async () => {
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d-timeout", dialogKind: "permission_ask_user_question", payload: {} } },
    ];
    const { sup, events } = makeSupervisor([scenario]); // questionTimeoutMs: 100 in makeSupervisor
    const rec = await sup.spawn(SPAWN);
    const seen: Array<Record<string, unknown>> = [];
    events.subscribe((e) => { if (e.kind === "status") seen.push(e.data); });
    // wait past the timeout window
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resolved = seen.find((d) => d["dialogResolved"] === true);
    expect(resolved).toEqual({ dialogResolved: true, dialogId: "d-timeout", cancelled: true, timedOut: true });
    void rec; // agent stays "running" (no end step) — only the timeout/cleanup behavior is under test
  });

  it("answerDialog('nope', ...) returns false for an unknown dialogId", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.answerDialog("nope", { behavior: "cancelled" })).toBe(false);
  });

  it("answerDialog returns false when called again after the dialog already resolved", async () => {
    expect.assertions(2);
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d2", dialogKind: "k", payload: {} } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_dialog") {
        expect(sup.answerDialog("d2", { behavior: "completed", result: "first" })).toBe(true);
      }
    });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.answerDialog("d2", { behavior: "completed", result: "second" })).toBe(false);
  });

  it("scrubs an injected credential out of the agent_dialog event payload (spec §6)", async () => {
    expect.assertions(2);
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d3", dialogKind: "k", payload: { prompt: "use token=tok-second please" } } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    // spawning on "second" resolves keychain secret "tok-second" into the supervisor's secrets list
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    events.subscribe((e) => {
      if (e.kind === "agent_dialog") {
        const payload = e.data["payload"] as { prompt: string };
        expect(payload.prompt).not.toContain("tok-second");
        expect(payload.prompt).toContain("[REDACTED]");
        sup.answerDialog("d3", { behavior: "cancelled" });
      }
    });
    await sup.waitFor(rec.agentId, 1000);
  });

  it("toolUseId is undefined in the agent_dialog event data when the fake step doesn't supply one", async () => {
    expect.assertions(1);
    // The fake backend's decideDialog fire-and-forget call never sets DialogRequest.toolUseId
    // (the FakeStep's `dialog` variant carries no toolUseId field) — the brief's decideDialog
    // always includes the key (`toolUseId: req.toolUseId`, unconditional, unlike ask()'s
    // conditional header spread), so it comes through as present-but-undefined.
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d4", dialogKind: "k", payload: {} } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_dialog") {
        expect(e.data["toolUseId"]).toBeUndefined();
        sup.answerDialog("d4", { behavior: "cancelled" });
      }
    });
    await sup.waitFor(rec.agentId, 1000);
  });

  it("persists the agent_dialog event to the EventLog", async () => {
    const scenario: FakeStep[] = [
      { dialog: { dialogId: "d5", dialogKind: "k", payload: {} } },
      { end: { resultText: "done" } },
    ];
    const { sup, dir, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn(SPAWN);
    events.subscribe((e) => {
      if (e.kind === "agent_dialog") sup.answerDialog("d5", { behavior: "cancelled" });
    });
    await sup.waitFor(rec.agentId, 1000);
    const { EventLog } = await import("@chimera/core/events");
    const kinds = new EventLog(dir).tail(rec.agentId, 50).map((e) => e.kind);
    expect(kinds).toContain("agent_dialog");
  });

  it("existing 3-arg backend.spawn call sites keep typechecking / working (no-regression)", async () => {
    // supervisor-permission.test.ts / supervisor-questions.test.ts already cover this at runtime;
    // this test asserts a plain permission-only scenario is unaffected by the new decideDialog wiring.
    const { sup } = makeSupervisor([[{ askPermission: { toolName: "Read" } }, { end: { resultText: "ok" } }]]);
    const rec = await sup.spawn(SPAWN);
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
  });
});
