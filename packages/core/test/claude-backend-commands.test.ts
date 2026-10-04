import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// native-CLI-parity Phase 3, Task SC1: surface the SDK's slash_commands/skills/plugins/
// apiKeySource from init (additive agent_started data), and the live commands_changed push
// (new event kind), so the TUI (SC2) can render a `/` autocomplete. NO TUI here.

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
      interrupt: vi.fn(async () => {}),
    };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

async function run(messages: Msg[]): Promise<BackendEvent[]> {
  const { fn } = fakeQuery(messages);
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
  await settle();
  return evs;
}

describe("ClaudeAgentBackend: slash_commands/skills/plugins/apiKeySource surfaced from init (Task SC1)", () => {
  it("maps init's slash_commands/skills/plugins/apiKeySource onto agent_started data, alongside sessionId/model", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s", model: "m", slash_commands: ["compact", "cost"],
        skills: ["x"], plugins: [{ name: "p", path: "/p" }], apiKeySource: "oauth" },
    ]);
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started).toBeDefined();
    expect(started.data["sessionId"]).toBe("s");
    expect(started.data["model"]).toBe("m");
    expect(started.data["slashCommands"]).toEqual(["compact", "cost"]);
    expect(started.data["skills"]).toEqual(["x"]);
    expect(started.data["plugins"]).toEqual([{ name: "p", path: "/p" }]);
    expect(started.data["apiKeySource"]).toBe("oauth");
  });

  it("regression: an init message WITHOUT the new fields still emits agent_started with sessionId/model, new keys undefined", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
    ]);
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started).toBeDefined();
    expect(started.data["sessionId"]).toBe("s1");
    expect(started.data["model"]).toBe("m1");
    expect(started.data["slashCommands"]).toBeUndefined();
    expect(started.data["skills"]).toBeUndefined();
    expect(started.data["plugins"]).toBeUndefined();
    expect(started.data["mcpServers"]).toBeUndefined();
    expect(started.data["apiKeySource"]).toBeUndefined();
    // every existing claude-backend test relies on this exact kind sequence remaining unchanged
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "result"]);
  });

  // WS-D (parity: surface MCP servers read-only): init's mcp_servers (name+status
  // per configured server) rides onto agent_started.data.mcpServers, alongside the
  // pre-existing slash/skills/plugins fields, for the TUI to render connection health.
  it("maps init's mcp_servers onto agent_started data as mcpServers", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s", model: "m",
        mcp_servers: [{ name: "chimera", status: "connected" }, { name: "linear", status: "needs-auth" }] },
    ]);
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started.data["mcpServers"]).toEqual([
      { name: "chimera", status: "connected" },
      { name: "linear", status: "needs-auth" },
    ]);
  });

  it("init with an empty slash_commands/skills/plugins array surfaces the empty arrays (not dropped)", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s2", model: "m2", slash_commands: [], skills: [], plugins: [] },
    ]);
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started.data["slashCommands"]).toEqual([]);
    expect(started.data["skills"]).toEqual([]);
    expect(started.data["plugins"]).toEqual([]);
  });

  it("every agent_started sink call still carries the raw SDK init message", async () => {
    const raw = { type: "system", subtype: "init", session_id: "s3", model: "m3", slash_commands: ["a"] };
    const evs = await run([raw]);
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started.raw).toEqual(raw);
  });
});

describe("ClaudeAgentBackend: commands_changed live push (Task SC1)", () => {
  it("maps a system commands_changed message to a commands_changed event with data.commands deep-equal to the SDK array", async () => {
    const evs = await run([
      { type: "system", subtype: "commands_changed", commands: [{ name: "cost", description: "usage", argumentHint: "" }] },
    ]);
    const changed = evs.find((e) => e.kind === "commands_changed")!;
    expect(changed).toBeDefined();
    expect(changed.data["commands"]).toEqual([{ name: "cost", description: "usage", argumentHint: "" }]);
  });

  it("maps commands_changed entries carrying aliases through untouched", async () => {
    const commands = [{ name: "compact", description: "compact transcript", argumentHint: "[n]", aliases: ["c"] }];
    const evs = await run([
      { type: "system", subtype: "commands_changed", commands },
    ]);
    const changed = evs.find((e) => e.kind === "commands_changed")!;
    expect(changed.data["commands"]).toEqual(commands);
  });

  it("commands_changed with an empty commands array still emits the event with an empty list (REPLACE semantics)", async () => {
    const evs = await run([
      { type: "system", subtype: "commands_changed", commands: [] },
    ]);
    const changed = evs.find((e) => e.kind === "commands_changed")!;
    expect(changed).toBeDefined();
    expect(changed.data["commands"]).toEqual([]);
  });

  it("a missing commands field on the commands_changed message does not throw (defensive read, undefined data.commands)", async () => {
    const evs = await run([
      { type: "system", subtype: "commands_changed" },
    ]);
    const changed = evs.find((e) => e.kind === "commands_changed")!;
    expect(changed).toBeDefined();
    expect(changed.data["commands"]).toBeUndefined();
  });

  it("every commands_changed sink call carries the raw SDK message", async () => {
    const raw = { type: "system", subtype: "commands_changed", commands: [{ name: "x", description: "d", argumentHint: "" }] };
    const evs = await run([raw]);
    const changed = evs.find((e) => e.kind === "commands_changed")!;
    expect(changed.raw).toEqual(raw);
  });

  it("does not emit commands_changed for an unrelated system subtype (e.g. init) — sibling branches stay isolated", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s", model: "m" },
    ]);
    expect(evs.find((e) => e.kind === "commands_changed")).toBeUndefined();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "result"]);
  });

  it("does not emit agent_started for a commands_changed message — sibling branches stay isolated", async () => {
    const evs = await run([
      { type: "system", subtype: "commands_changed", commands: [] },
    ]);
    expect(evs.find((e) => e.kind === "agent_started")).toBeUndefined();
  });

  it("multiple commands_changed messages in one stream each produce their own event, in order", async () => {
    const evs = await run([
      { type: "system", subtype: "commands_changed", commands: [{ name: "a", description: "", argumentHint: "" }] },
      { type: "system", subtype: "commands_changed", commands: [{ name: "b", description: "", argumentHint: "" }] },
    ]);
    const changed = evs.filter((e) => e.kind === "commands_changed");
    expect(changed.map((e) => (e.data["commands"] as Array<{ name: string }>)[0]!.name)).toEqual(["a", "b"]);
  });
});
