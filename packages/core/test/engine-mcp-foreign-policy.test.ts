import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// MCP-FOREIGN-POLICY (INTEGRATION): the CapabilityBroker's foreign-MCP seam
// (mcpToolMode) is OPTIONAL — a broker constructed without it makes decideMcpTool
// inert (returns null, emits nothing). broker.test.ts covers that inert case in
// isolation. THIS file proves the seam is actually WIRED at the engine level:
// Engine's ctor passes `(tool, serverKey) => this.toolPolicy.modeForMcpMaybe(...)`
// as the third arg, so the engine's live CapabilityBroker resolves real verdicts
// against the engine's OWN ToolPolicyStore — and host.setPolicy edits flow through
// to the very next MCP decision with no daemon restart.

function engine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

describe("Engine — foreign-MCP capability seam is wired", () => {
  it("decideMcpTool is LIVE (non-null) — proving the mcpToolMode seam reached the ctor", () => {
    // A broker wired WITHOUT the optional seam returns null here (see broker.test.ts
    // "feature not wired"). A non-null result is the load-bearing proof the engine
    // passed the modeForMcpMaybe seam as the third CapabilityBroker ctor arg.
    const e = engine();
    const result = e.capabilityBroker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result).not.toBeNull();
  });

  it("an UNGOVERNED foreign MCP tool prompts by default (ask-by-default, not silent allow/deny)", () => {
    const e = engine();
    const result = e.capabilityBroker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("prompt");
    expect(result?.reason).toContain("no policy set");
  });

  it("host.setPolicy(allow) on the exact tool name flows through the seam to the next decision", async () => {
    const e = engine();
    await e.handle("host.setPolicy", { tool: "mcp__ekb__search", profile: "*", mode: "allow" });
    const result = e.capabilityBroker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("allow");
  });

  it("host.setPolicy(deny) on the exact tool name flows through the seam to the next decision", async () => {
    const e = engine();
    await e.handle("host.setPolicy", { tool: "mcp__ekb__search", profile: "*", mode: "deny" });
    const result = e.capabilityBroker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("deny");
  });

  it("a SERVER-KEY policy governs every tool of that server through the wired seam", async () => {
    const e = engine();
    await e.handle("host.setPolicy", { tool: "mcp__ekb", profile: "*", mode: "deny" });
    // No exact-tool policy exists, so the server key governs both of the server's tools.
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__search")?.decision).toBe("deny");
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__fetch")?.decision).toBe("deny");
  });

  it("an exact-tool policy BEATS the server-key policy end-to-end", async () => {
    const e = engine();
    await e.handle("host.setPolicy", { tool: "mcp__ekb", profile: "*", mode: "deny" });
    await e.handle("host.setPolicy", { tool: "mcp__ekb__search", profile: "*", mode: "allow" });
    // Exact tool name wins over the server key for the specific tool...
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__search")?.decision).toBe("allow");
    // ...while a sibling tool with no exact key still falls back to the server-key deny.
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__fetch")?.decision).toBe("deny");
  });

  it("policy edits are read FRESH per decision — no restart between the ask default and the grant", async () => {
    const e = engine();
    // First decision with no policy: ask-by-default.
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__search")?.decision).toBe("prompt");
    // Grant it live; the SAME broker instance now resolves allow.
    await e.handle("host.setPolicy", { tool: "mcp__ekb__search", profile: "*", mode: "allow" });
    expect(e.capabilityBroker.decideMcpTool("a", "mcp__ekb__search")?.decision).toBe("allow");
  });

  it("every wired MCP decision is attributed to the principal and audited via the event log", () => {
    const e = engine();
    e.capabilityBroker.decideMcpTool("agent-42", "mcp__ekb__search");
    const events = e.events.tail("agent-42", 10).filter((ev) => ev.kind === "capability_decision");
    expect(events.length).toBe(1);
    const last = events[events.length - 1]!;
    expect(last.agentId).toBe("agent-42");
    expect((last.data as { action?: string }).action).toBe("mcp_tool");
    expect((last.data as { resource?: string }).resource).toBe("mcp__ekb__search");
  });
});
