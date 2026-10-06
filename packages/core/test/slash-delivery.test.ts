import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// SLASH-IS-EXPLICIT: a provider slash command only works VERBATIM. Any other message gets the
// "[from <sender>] " attribution prefix, which masks the leading "/" so the backend reads prose.
// That is not a subtlety — it is the difference between a command running and silently not.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 6 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const rig = async () => {
  const e = new Engine({ home: makeEngineHome(), backends: backends() });
  const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
  await flush();
  const sent: string[] = [];
  const handles = (e.supervisor as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
  const real = handles.get(a.agentId)!;
  handles.set(a.agentId, { ...real, send: async (t: string) => { sent.push(t); } });
  return { e, agentId: a.agentId, sent };
};
// F09: this rig stubs the handle's send, so the agent never emits a turn-opening event and
// every agent.send RPC waits out PROMPT_ACK_WAIT_MS (9 s) before answering "pending". These
// tests assert delivery, not latency — give them room for that measured, deliberate wait.
const SLOW = 30_000;

describe("slash delivery", () => {
  it("delivers a slash-flagged message VERBATIM — no attribution prefix", async () => {
    const { e, agentId, sent } = await rig();
    await e.handle("agent.send", { agentId, text: "/compact", from: "conductor", slash: true });
    await flush();
    expect(sent).toEqual(["/compact"]);
  }, SLOW);

  it("preserves ordinary message text; the adapter uses its separate delivery envelope", async () => {
    const { e, agentId, sent } = await rig();
    await e.handle("agent.send", { agentId, text: "/compact", from: "conductor" });
    await flush();
    expect(sent).toEqual(["/compact"]);   // the backend sees prose, not a command
  }, SLOW);

  it("never guesses from a leading slash — an ordinary message may legitimately start with one", async () => {
    const { e, agentId, sent } = await rig();
    await e.handle("agent.send", { agentId, text: "/Users/alice/repo is ready", from: "worker" });
    await flush();
    expect(sent[0]).toBe("/Users/alice/repo is ready");
  }, SLOW);

  it("a slash message is never coalesced with others — a command must be the whole turn", async () => {
    const { e, agentId, sent } = await rig();
    await e.handle("agent.send", { agentId, text: "one", from: "a" });
    await e.handle("agent.send", { agentId, text: "/compact", from: "a", slash: true });
    await e.handle("agent.send", { agentId, text: "two", from: "a" });
    await flush();
    expect(sent).toEqual(["one", "/compact", "two"]);
  }, SLOW);
});

describe("the agent-facing tool exposes it", () => {
  it("agent_send forwards slash:true, and omits it otherwise", async () => {
    const { MCP_TOOL_TABLE } = await import("@chimera/protocol/mcp-tools");
    const tool = MCP_TOOL_TABLE.find((t) => t.name === "agent_send")!;
    const withSlash = tool.resolve({ agentId: "a1", text: "/compact", slash: true }, { depth: 0 }) as { params: Record<string, unknown> };
    expect(withSlash.params).toEqual({ agentId: "a1", text: "/compact", slash: true });
    const without = tool.resolve({ agentId: "a1", text: "hello" }, { depth: 0 }) as { params: Record<string, unknown> };
    expect(without.params).toEqual({ agentId: "a1", text: "hello" });
  });
});
