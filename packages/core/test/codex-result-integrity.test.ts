import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAgentBackend, type CodexThreadEvent } from "@chimera/core/backends/codex";
import type { BackendEvent } from "@chimera/core/backend";
import { Engine } from "@chimera/core/engine";
import type { JobRecord } from "@chimera/protocol";
import { fakeCodex, cxSpec } from "./codex-backend-helpers.js";
import { makeMultiProviderHome } from "./helpers.js";

const message = (text: string, phase?: string): CodexThreadEvent => ({
  type: "item.completed", item: { id: "answer", type: "agent_message", text, ...(phase ? { phase } : {}) },
});
const completed: CodexThreadEvent = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
const effect: CodexThreadEvent = { type: "item.completed", item: { id: "canonical-edit", type: "mcp_tool_call", server: "chimera", tool: "memory_edit", status: "completed", result: { content: [{ type: "text", text: "canonical saved" }] } } };
const cases: Array<{ name: string; script: CodexThreadEvent[] }> = [
  { name: "interrupted", script: [message("I will verify the redirect next."), { ...completed, interrupted: true }] },
  { name: "missing completion", script: [message("Working on it.")] },
  { name: "failed", script: [message("Working on it."), { type: "turn.failed", error: { message: "turn failed" } }] },
];
const successful: Array<{ name: string; script: CodexThreadEvent[] }> = [
  { name: "empty response", script: [completed] },
  { name: "tool only", script: [effect, completed] },
  { name: "commentary only", script: [message("Checking now.", "commentary"), completed] },
];

describe("Codex terminal result integrity", () => {
  it.each(cases)("rejects $name instead of publishing progress as success", async ({ script }) => {
    const events: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: fakeCodex([script]).factory })
      .spawn(cxSpec(), e => events.push(e), async () => false);
    await vi.waitFor(() => expect(events.some(e => e.kind === "error")).toBe(true));
    expect(events.some(e => e.kind === "result")).toBe(false);
    if (script.at(-1)?.type !== "turn.failed") expect(events.at(-1)).toMatchObject({ kind: "error", data: { phase: "codex-turn-incomplete" } });
  });

  it.each(successful)("preserves authoritative completed $name with empty result text", async ({ script }) => {
    const events: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: fakeCodex([script]).factory })
      .spawn(cxSpec(), e => events.push(e), async () => false);
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("result"));
    expect(events.at(-1)?.data.text).toBe("");
    expect(events.some(e => e.kind === "error")).toBe(false);
  });

  it.each([undefined, "final_answer"])("accepts a completed final response with phase %s", async phase => {
    const events: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: fakeCodex([[message("Verified.", phase), completed]]).factory })
      .spawn(cxSpec(), e => events.push(e), async () => false);
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("result"));
    expect(events.at(-1)?.data.text).toBe("Verified.");
  });

  it("does not reuse an earlier final response when the latest turn has none", async () => {
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: fakeCodex([[message("Earlier result."), completed], [completed]]).factory })
      .spawn(cxSpec({ persistent: true }), e => events.push(e), async () => false);
    try {
      await vi.waitFor(() => expect(events.filter(e => e.kind === "turn_complete")).toHaveLength(1));
      await handle.send("verify the next item");
      await vi.waitFor(() => expect(events.filter(e => e.kind === "turn_complete")).toHaveLength(2));
      await handle.close?.();
      await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("result"));
      expect(events.at(-1)?.data.text).toBe("");
    } finally { await handle.kill(); }
  });

  it.each([undefined, "final_answer", "commentary"])("an interrupted turn followed by successful continuation uses only phase %s continuation text", async phase => {
    const fake = fakeCodex([[effect, message("Partial work."), { ...completed, interrupted: true }], [message("Latest response.", phase), completed]]);
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: fake.factory }).spawn(cxSpec({ persistent: true }), e => events.push(e), async () => false);
    try {
      await vi.waitFor(() => expect(events.some(e => e.kind === "turn_complete" && e.data.interrupted)).toBe(true));
      expect(events.some(e => e.kind === "error" || e.kind === "result")).toBe(false);
      await handle.send("continue from the saved canonical edit");
      await vi.waitFor(() => expect(events.filter(e => e.kind === "turn_complete")).toHaveLength(2));
      await handle.close?.();
      await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("result"));
      expect(events.at(-1)?.data.text).toBe(phase === "commentary" ? "" : "Latest response.");
      expect(fake.threads[0]?.runs).toHaveLength(2);
      expect(events.filter(e => e.kind === "tool_result")).toHaveLength(1);
    } finally { await handle.kill(); }
  });

  it.each([...cases.map(c => ({ ...c, expected: "failed" })), ...successful.map(c => ({ ...c, expected: "ok" }))])("the scheduler records $name as $expected without replaying partial tool effects", async ({ script, expected }) => {
    const fake = fakeCodex([[...(script.includes(effect) ? [] : [effect]), ...script], [message("must never replay"), completed]]);
    const backend = new CodexAgentBackend({ codexFactory: fake.factory });
    const home = makeMultiProviderHome();
    const configFile = join(home, "config.json");
    writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, "utf8")), wake: { holdAwakeDuringRuns: false, scheduleWake: false } }));
    const engine = new Engine({ home, backends: new Map([["codex", backend]]) });
    const name = "offline-result-integrity";
    await engine.handle("job.create", { spec: {
      name, schedule: { every: { unit: "hours", n: 1 } }, prompt: "verify canonical and redirect",
      target: { role: "blank", overrides: { account: "cx", provider: "codex", cwd: "/tmp", isolation: "none", permissionProfile: "acceptEdits", autonomy: "full", providerOptions: { codexTransport: "exec" } } },
    } });
    try {
      await engine.handle("job.runNow", { name });
      await vi.waitFor(async () => {
        const job = await engine.handle("job.status", { name }) as JobRecord;
        expect(job.lastRuns.at(-1)?.result).toBe(expected);
        expect(job.lastRuns).toHaveLength(1);
        const agent = engine.supervisor.status(job.lastRuns.at(-1)!.agentId!);
        expect(agent.state).toBe(expected === "ok" ? "done" : "failed");
        expect(agent.attempts).toHaveLength(1);
        expect(fake.threads).toHaveLength(1);
        expect(fake.threads[0]?.runs).toHaveLength(1);
        expect(engine.events.tail(agent.agentId, 30).filter(e => e.kind === "tool_result")).toHaveLength(1);
        if (expected === "failed") {
          expect(agent.failure).toMatchObject({ retryable: false, restartInPlace: false, failoverAccount: false });
          expect(job.failure?.retryAt).toBeNull();
        } else expect(agent.resultText).toBe("");
      });
    } finally {
      await engine.handle("job.delete", { name });
      engine.jobs.detach();
    }
  });
});
