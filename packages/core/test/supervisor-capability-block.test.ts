import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { CooldownTracker } from "@chimera/core/failover";
import { MailboxStore } from "@chimera/core/mailbox";
import { EventLog } from "@chimera/core/events";
import { CredentialResolver } from "@chimera/core/credentials";
import { AccountRegistry } from "@chimera/core/accounts";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ENGINE_TOOL_NAMES } from "@chimera/protocol/engine-help";
import { AgentSupervisor, CAPABILITY_BLOCK_TOOLS, buildCapabilityBlock } from "@chimera/core/supervisor";

// CAPABILITY-BLOCK-DRIFT: the supervisor's spawn-time AWARENESS capability block used to be
// a hand-written prose literal (packages/core/src/supervisor.ts) naming specific tools from
// memory, with nothing checking it against the actual MCP catalog (@chimera/protocol/
// engine-help's ENGINE_TOOL_NAMES — the same source server.ts/tui/app already generate from,
// per F07). A tool renamed or removed there silently made every spawned agent's system prompt
// wrong, with no failing test and no typecheck error.
//
// CAPABILITY_BLOCK_TOOLS is typed `satisfies Record<string, EngineToolName>` in supervisor.ts,
// so `tsc -b packages/core` already fails on a renamed/removed tool. This test is the runtime
// backstop (protects plain `vitest` runs) and, more importantly, PROVES the guard: it asserts
// every name the block references is still a live catalog member, so deleting/renaming an entry
// in ENGINE_TOOL_NAMES without updating supervisor.ts turns this red.
describe("supervisor — capability block drift guard", () => {
  it("every tool the capability block references is a live engine_help catalog entry", () => {
    const catalog = new Set(ENGINE_TOOL_NAMES);
    for (const [key, name] of Object.entries(CAPABILITY_BLOCK_TOOLS)) {
      expect(catalog.has(name), `capability block references "${name}" (as ${key}) — missing from ENGINE_TOOL_NAMES`).toBe(true);
    }
  });

  it("keeps discovery and routing policy without repeating the registered tool catalog", () => {
    const block = buildCapabilityBlock();
    for (const tool of ["chimera_tools", "chimera_call", "mcp_store_tools", "mcp_store_call"]) {
      expect(block).toContain(tool);
    }
    for (const tool of ["agent_spawn", "agent_status", "agent_wait", "terminal_read", "rename_self"]) {
      expect(block).not.toContain(tool);
    }
    expect(block).toContain("never access the daemon socket directly");
    expect(block.length).toBeLessThan(1_000);
    expect(block).toContain("do not copy these shared instructions");
  });
});

// Exercise the shared spawn boundary, including providers that do not use Claude's system prompt.
describe("Chimera-first MCP routing across providers", () => {
  it.each(["claude", "codex", "kimi", "openai"])("delivers the routing rule to %s without changing the stored task instructions", async (provider) => {
    const home = mkdtempSync(join(tmpdir(), "chimera-mcp-routing-"));
    const backend = new FakeAgentBackend([], provider);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(ChimeraConfigSchema.parse({
        accounts: [{ name: "test", provider, auth: { type: "keychain", service: "test", injectAs: "TEST_KEY" } }],
        autoOrder: ["test"],
      })),
      credentials: new CredentialResolver(async () => ({ stdout: "test-key", code: 0 })),
      backends: new Map([[provider, backend]]), events: new EventLog(home), mailboxes: new MailboxStore(home),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100,
    });
    const agent = await sup.spawn({ prompt: "task", instructions: "role instructions", cwd: home, isolation: "none", orchestration: { allow: true } });
    const delivered = backend.spawns[0]!.instructions!;
    expect(delivered).toContain("Use Chimera tools before provider-native MCP");
    expect(delivered).toContain("browser/desktop");
    expect(delivered).toContain("use a native fallback only if discovery finds no suitable tool");
    expect(delivered).toContain("busy desktop lease, timeout or connection error is not a missing tool");
    expect(delivered.indexOf("Use Chimera tools before provider-native MCP")).toBeLessThan(delivered.indexOf("role instructions"));
    expect(sup.status(agent.agentId).spec.instructions).toBe("role instructions");
    await sup.waitFor(agent.agentId, 1000);
  });
});
