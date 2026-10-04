import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// echoQuery: consumes the streaming-input prompt; each user message yields one
// assistant echo + one SDK result message. The generator ends when the input
// iterator ends — i.e. only when the backend closes the input queue.
function echoQuery() {
  const calls: Array<{ prompt: AsyncIterable<{ message: { content: Array<{ text?: string }> } }>; options: Record<string, unknown> }> = [];
  const fn = ((args: never) => {
    calls.push(args as never);
    const input = (args as { prompt: AsyncIterable<{ message: { content: Array<{ text?: string }> } }> }).prompt;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const m of input) {
          const text = String(m.message.content[0]?.text ?? "");
          yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo:${text}` }] } };
          yield { type: "result", subtype: "success", result: `echo:${text}`, total_cost_usd: 0.01 };
        }
      },
      interrupt: async () => {},
    };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: REPO_BACKED_CWD, isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("ClaudeAgentBackend conductor sessions", () => {
  it("one-shot sessions still close after an idle turn boundary; late sends reject", async () => {
    const { fn } = echoQuery();
    const evs: BackendEvent[] = [];
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["message_complete", "turn_complete", "result"]);
    await expect(h.send("too late")).rejects.toThrow(/closed/);   // never silently ACKed-and-lost (spec §8)
    await settle();
    expect(evs.filter((e) => e.kind === "message_complete").length).toBe(1);
  });

  it("send after close() rejects instead of silently dropping (no-drop, spec §8)", async () => {
    const { fn } = echoQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.close!();
    await settle();
    await expect(h.send("during the close window")).rejects.toThrow(/closed/);
  });

  it("conductor sessions stay open across turns and end on close()", async () => {
    const { fn } = echoQuery();
    const evs: BackendEvent[] = [];
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["message_complete", "turn_complete"]);   // no result yet
    await h.send("again");                           // second user turn via the open input stream
    await settle();
    expect(evs.filter((e) => e.kind === "message_complete").map((e) => e.data["text"]))
      .toEqual(["echo:task", "echo:again"]);
    expect(evs.every((e) => e.kind !== "result")).toBe(true);
    await h.close!();                                // graceful end
    await settle();
    const last = evs[evs.length - 1]!;
    expect(last.kind).toBe("result");
    expect(last.data).toEqual({ text: "echo:again", costUsd: 0.01 });
  });

  it("kill() still aborts a conductor without a result event", async () => {
    const { fn } = echoQuery();
    const evs: BackendEvent[] = [];
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), (e) => evs.push(e), async () => true);
    await settle();
    await h.kill();
    await settle();
    expect(evs.every((e) => e.kind !== "result")).toBe(true);
  });

  // --- Additional edge-case coverage beyond the brief's prescribed cases ---

  it("send() after kill() also rejects instead of silently dropping (same closed-queue guard, different call path)", async () => {
    expect.assertions(1);
    const { fn } = echoQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.kill();
    await settle();
    await expect(h.send("after kill")).rejects.toThrow(/closed/);
  });

  it("close() is idempotent — calling it a second time does not throw", async () => {
    const { fn } = echoQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.close!();
    await settle();
    await expect(h.close!()).resolves.toBeUndefined();
  });

  it("kill() after close() already ended the stream does not throw (idempotent shutdown ordering)", async () => {
    const { fn } = echoQuery();
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ conductor: true }), () => {}, async () => true);
    await settle();
    await h.close!();
    await settle();
    await expect(h.kill()).resolves.toBeUndefined();
  });

  it("a one-shot (non-conductor) handle also exposes close?() and it is safe to call after auto-close", async () => {
    const { fn } = echoQuery();
    const evs: BackendEvent[] = [];
    const h = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["message_complete", "turn_complete", "result"]);
    await expect(h.close!()).resolves.toBeUndefined();   // queue already auto-closed; close() must stay a no-throw no-op
  });
});
