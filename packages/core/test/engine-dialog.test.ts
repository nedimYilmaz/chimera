import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine agent.answerDialog RPC (native-CLI-parity Phase 2, Task DLG1)", () => {
  const spawnBody = (over: Record<string, unknown> = {}) =>
    ({ spec: { prompt: "hello", cwd: "/tmp", isolation: "none", ...over } });

  it("routes agent.answerDialog(completed) to supervisor.answerDialog and unblocks the dialog", async () => {
    const e = engineWithScenarios([[
      { dialog: { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: { questions: [] } } },
      { end: { resultText: "done" } },
    ]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    let handled: unknown;
    e.events.subscribe((ev) => {
      if (ev.kind === "agent_dialog") {
        void e.handle("agent.answerDialog", {
          dialogId: ev.data["dialogId"],
          decision: { behavior: "completed", result: { answers: { q: "a" } } },
        }).then((r) => { handled = r; });
      }
    });
    const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 })) as { state: string };
    expect(final.state).toBe("done");
    expect(handled).toEqual({ handled: true });
  });

  it("routes agent.answerDialog(cancelled) to supervisor.answerDialog", async () => {
    const e = engineWithScenarios([[
      { dialog: { dialogId: "d2", dialogKind: "k", payload: {} } },
      { end: { resultText: "done" } },
    ]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
    e.events.subscribe((ev) => {
      if (ev.kind === "agent_dialog") {
        void e.handle("agent.answerDialog", { dialogId: ev.data["dialogId"], decision: { behavior: "cancelled" } });
      }
    });
    const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 })) as { state: string };
    expect(final.state).toBe("done");
  });

  it("agent.answerDialog returns {handled:false} for an unknown dialogId", async () => {
    const e = engineWithScenarios([]);
    expect(await e.handle("agent.answerDialog", { dialogId: "nope", decision: { behavior: "cancelled" } }))
      .toEqual({ handled: false });
  });

  it("agent.answerDialog rejects a malformed decision (bad behavior, zod -> protocol)", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.answerDialog", { dialogId: "d1", decision: { behavior: "maybe" } }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("agent.answerDialog rejects params missing 'decision'", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.answerDialog", { dialogId: "d1" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("agent.answerDialog rejects params missing 'dialogId'", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.answerDialog", { decision: { behavior: "cancelled" } })).rejects.toMatchObject({ code: "protocol" });
  });

  it("agent.answerDialog rejects an empty dialogId", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.answerDialog", { dialogId: "", decision: { behavior: "cancelled" } }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("no-regression: agent.answerQuestion RPC is untouched by the new agent.answerDialog case", async () => {
    const e = engineWithScenarios([]);
    expect(await e.handle("agent.answerQuestion", { questionId: "nope", answer: { text: "x" } }))
      .toEqual({ handled: false });
  });
});
