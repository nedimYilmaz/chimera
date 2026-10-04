import { describe, expect, it } from "vitest";
import type { McpListenerStatus } from "@chimera/protocol";
import { MCP_LISTENER_FOOTNOTE, mcpListenerTransitions } from "../src/mcpListener.js";
import { initialState, reduce, type UiState } from "../src/index.js";

const on = (grants: McpListenerStatus["grants"]): McpListenerStatus => ({
  enabled: true, listening: grants.length > 0, address: "127.0.0.1:54321", grants,
});
const g = (agentId: string, provider = "kimi") => ({ agentId, provider, since: 0 });

describe("mcpListenerTransitions", () => {
  it("seeds silently on the first observation", () => {
    const r = mcpListenerTransitions(null, on([g("a1")]));
    expect(r.transitions).toEqual([]);
    expect(r.agentIds).toEqual(["a1"]);
  });

  it("reports a new grant as a connect and a vanished one as a disconnect", () => {
    const r = mcpListenerTransitions(["a1"], on([g("a2", "codex")]));
    expect(r.transitions.map((t) => t.kind)).toEqual(["connected", "disconnected"]);
    expect(r.transitions[0]!.text).toContain("codex client connected");
    expect(r.transitions[0]!.text).toContain("127.0.0.1:54321");
    expect(r.transitions[1]!.agentId).toBe("a1");
  });

  it("keeps the prior roster when the daemon omits the field entirely", () => {
    const r = mcpListenerTransitions(["a1"], undefined);
    expect(r).toEqual({ transitions: [], agentIds: ["a1"] });
  });

  it("treats a disabled listener as no grants", () => {
    const r = mcpListenerTransitions(["a1"], { enabled: false, listening: false, address: null, grants: [g("a1")] });
    expect(r.agentIds).toEqual([]);
    expect(r.transitions.map((t) => t.kind)).toEqual(["disconnected"]);
  });

  it("never echoes anything but agentId/provider/address", () => {
    const secret = "tok_deadbeef";
    const status = on([{ ...g("a1"), token: secret } as unknown as McpListenerStatus["grants"][number]]);
    const r = mcpListenerTransitions([], status);
    expect(r.transitions.map((t) => t.text).join(" ")).not.toContain(secret);
  });
});

describe("daemonStatus reducer — mcp listener transcript lines", () => {
  const withAgent = (): UiState =>
    reduce(initialState, { type: "agentRecords", records: [{ agentId: "a1", state: "running" } as never] });

  const status = (mcpListener?: McpListenerStatus) => ({
    type: "daemonStatus" as const,
    status: { protocolVersion: 1, agents: initialState.agentCounts, mcpListener },
  });

  it("writes connect/disconnect lines into the owning agent's transcript", () => {
    let s = reduce(withAgent(), status(on([])));           // seed: roster known, empty
    expect(s.mcpListenerGrantAgents).toEqual([]);
    s = reduce(s, status(on([g("a1")])));
    expect(s.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system" });
    expect(s.agents["a1"]!.transcript.at(-1)!.text).toContain("client connected");
    s = reduce(s, status(on([])));
    expect(s.agents["a1"]!.transcript.at(-1)!.text).toContain("client disconnected");
  });

  it("does not announce grants that were already live when the UI started", () => {
    const s = reduce(withAgent(), status(on([g("a1")])));
    expect(s.agents["a1"]!.transcript).toEqual([]);
  });

  it("ignores a grant for an agent this UI has no record of", () => {
    let s = reduce(initialState, status(on([])));
    s = reduce(s, status(on([g("ghost")])));
    expect(s.agents["ghost"]).toBeUndefined();
    expect(s.mcpListenerGrantAgents).toEqual(["ghost"]);
  });
});

it("footnote states the transport and the auth model without a token", () => {
  expect(MCP_LISTENER_FOOTNOTE).toContain("127.0.0.1");
  expect(MCP_LISTENER_FOOTNOTE).toContain("never shown here");
});
