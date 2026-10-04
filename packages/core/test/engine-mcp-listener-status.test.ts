import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { McpListenerStatus } from "@chimera/protocol";

// F49.2: daemon.status is the ONLY carrier for the settings screens' mcp-listener block (plan
// §2.9) — these tests pin the shape the app/TUI selectors read.

function makeHome(mcpListenerEnabled = false): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    mcpListener: { enabled: mcpListenerEnabled },
  }));
  return home;
}

function makeEngine(mcpListenerEnabled = false): Engine {
  return new Engine({ home: makeHome(mcpListenerEnabled), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

async function mcpListenerStatus(e: Engine, callerAgentId?: string): Promise<McpListenerStatus> {
  const params = callerAgentId ? { callerAgentId } : {};
  const status = (await e.handle("daemon.status", params)) as { mcpListener: McpListenerStatus };
  return status.mcpListener;
}

describe("Engine daemon.status — mcpListener pass-through", () => {
  it("reports the listener as disabled on a default config", async () => {
    const status = await mcpListenerStatus(makeEngine());
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.grants).toEqual([]);
  });

  it("lists one grant row per live grant, with agentId, provider and since", async () => {
    const e = makeEngine(true);
    const grant = await e.mcpListener.grant({ agentId: "agent-1", provider: "claude", depth: 0 });
    expect(grant).not.toBeNull();
    const status = await mcpListenerStatus(e);
    expect(status.grants).toHaveLength(1);
    expect(status.grants[0]).toMatchObject({ agentId: "agent-1", provider: "claude" });
    expect(typeof status.grants[0]!.since).toBe("number");
    await e.mcpListener.disable();
  });

  // F49.QA-FIX2 (finding #4): an agent-sourced daemon_status call (via callerAgentId, forced by
  // the MCP tool's resolve()) must only ever see its OWN grant row(s) — mirrors worktree_lease_list.
  it("scopes grants to callerAgentId when the MCP tool forces it, but the operator's unfiltered call keeps the full roster", async () => {
    const e = makeEngine(true);
    await e.mcpListener.grant({ agentId: "agent-1", provider: "claude", depth: 0 });
    await e.mcpListener.grant({ agentId: "agent-2", provider: "codex", depth: 0 });

    const scoped = await mcpListenerStatus(e, "agent-1");
    expect(scoped.grants).toHaveLength(1);
    expect(scoped.grants[0]).toMatchObject({ agentId: "agent-1" });

    const scopedOther = await mcpListenerStatus(e, "agent-2");
    expect(scopedOther.grants).toHaveLength(1);
    expect(scopedOther.grants[0]).toMatchObject({ agentId: "agent-2" });

    const scopedStranger = await mcpListenerStatus(e, "not-a-grant-holder");
    expect(scopedStranger.grants).toEqual([]);

    const unfiltered = await mcpListenerStatus(e);
    expect(unfiltered.grants).toHaveLength(2);

    await e.mcpListener.disable();
  });

  it("reloadConfig flipping mcpListener.enabled to false revokes every grant live", async () => {
    const e = makeEngine(true);
    await e.mcpListener.grant({ agentId: "agent-1", provider: "claude", depth: 0 });
    expect((await mcpListenerStatus(e)).grants).toHaveLength(1);
    await e.handle("config.patch", { patch: { mcpListener: { enabled: false } } });
    const status = await mcpListenerStatus(e);
    expect(status.grants).toEqual([]);
    expect(status.listening).toBe(false);
  });
});
