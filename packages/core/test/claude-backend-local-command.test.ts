import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// native-CLI-parity, Task SC2a: surface the SDK's SDKLocalCommandOutputMessage
// ({type:"system", subtype:"local_command_output", content:string}) — emitted when an agent
// runs a real slash command (skill/built-in like /compact) — into the transcript via the
// EXISTING message_complete kind (no new event kind), so the reducer renders it as a line.

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

describe("ClaudeAgentBackend: local_command_output surfaced as message_complete (Task SC2a)", () => {
  it("maps a system local_command_output message's content onto a message_complete event's data.text", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: "Compacted 12k→3k tokens" },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete).toBeDefined();
    expect(complete.data["text"]).toBe("Compacted 12k→3k tokens");
  });

  it("tags the emitted event with role:'system' and localCommand:true", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: "hello" },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete.data["role"]).toBe("system");
    expect(complete.data["localCommand"]).toBe(true);
  });

  it("regression: empty content string maps to text:'' without throwing", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: "" },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete).toBeDefined();
    expect(complete.data["text"]).toBe("");
  });

  it("regression: absent content field maps to text:'' without throwing (defensive read)", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output" },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete).toBeDefined();
    expect(complete.data["text"]).toBe("");
  });

  it("regression: a non-string content (e.g. number/object) falls back to text:'' rather than throwing or passing it through", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: 12345 },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete).toBeDefined();
    expect(complete.data["text"]).toBe("");
  });

  it("every local_command_output sink call carries the raw SDK message", async () => {
    const raw = { type: "system", subtype: "local_command_output", content: "raw-check" };
    const evs = await run([raw]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete.raw).toEqual(raw);
  });

  it("other system subtypes (init/task_started/commands_changed) still map to their own kinds, unaffected", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      { type: "system", subtype: "commands_changed", commands: [] },
      { type: "system", subtype: "task_started", task_id: "t1" },
      { type: "system", subtype: "local_command_output", content: "out" },
    ]);
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "commands_changed", "agent_task", "message_complete", "result",
    ]);
    const localOut = evs.find((e) => e.kind === "message_complete")!;
    expect(localOut.data["text"]).toBe("out");
  });

  it("does not emit agent_started, commands_changed, or agent_task for a local_command_output message — sibling branches stay isolated", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: "isolated" },
    ]);
    expect(evs.find((e) => e.kind === "agent_started")).toBeUndefined();
    expect(evs.find((e) => e.kind === "commands_changed")).toBeUndefined();
    expect(evs.find((e) => e.kind === "agent_task")).toBeUndefined();
    expect(evs.map((e) => e.kind)).toEqual(["message_complete", "result"]);
  });

  it("multiple local_command_output messages in one stream each produce their own message_complete event, in order", async () => {
    const evs = await run([
      { type: "system", subtype: "local_command_output", content: "first" },
      { type: "system", subtype: "local_command_output", content: "second" },
    ]);
    const completes = evs.filter((e) => e.kind === "message_complete");
    expect(completes.map((e) => e.data["text"])).toEqual(["first", "second"]);
  });
});
