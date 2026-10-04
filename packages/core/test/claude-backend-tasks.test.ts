import { reduce, emptyAgent, initialState } from "../../ui-state/src/index.js";
import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// native-CLI-parity Phase 1, Task N1: tool id/parent capture + task_* -> agent_task mapping.

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

describe("ClaudeAgentBackend: tool id/parent capture (agent_task, Task N1)", () => {
  it("captures toolUseId + parentToolUseId on a tool_use block", async () => {
    const evs = await run([
      { type: "assistant", parent_tool_use_id: "tu_parent", message: { role: "assistant", content: [
        { type: "tool_use", id: "tu_child", name: "Bash", input: {} },
      ] } },
    ]);
    const toolCall = evs.find((e) => e.kind === "tool_call")!;
    expect(toolCall.data["toolUseId"]).toBe("tu_child");
    expect(toolCall.data["parentToolUseId"]).toBe("tu_parent");
  });

  it("maps task_started -> agent_task with status running", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "T1", tool_use_id: "tu_parent", subagent_type: "qa", description: "review" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task).toBeDefined();
    expect(task.data["taskId"]).toBe("T1");
    expect(task.data["toolUseId"]).toBe("tu_parent");
    expect(task.data["subagentType"]).toBe("qa");
    expect(task.data["status"]).toBe("running");
  });

  it("preserves the provider's background-task marker for lifecycle settlement", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "BG1", is_backgrounded: true, description: "tests" },
    ]);
    expect(evs.find((e) => e.kind === "agent_task")?.data).toMatchObject({
      taskId: "BG1", status: "running", isBackgrounded: true,
    });
  });

  it("maps task_updated -> agent_task with the patched status", async () => {
    const evs = await run([
      { type: "system", subtype: "task_updated", task_id: "T1", patch: { status: "completed" } },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["status"]).toBe("completed");
  });

  it("maps task_started with workflow_name/task_type -> agent_task workflowName/taskType", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "W1", workflow_name: "build", task_type: "local_workflow" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["workflowName"]).toBe("build");
    expect(task.data["taskType"]).toBe("local_workflow");
  });

  it("regression: a tool_use block without parent_tool_use_id/id still emits tool_call unchanged", async () => {
    const evs = await run([
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
      ] } },
    ]);
    const toolCall = evs.find((e) => e.kind === "tool_call")!;
    expect(toolCall.data["toolName"]).toBe("Edit");
    expect(toolCall.data["toolUseId"]).toBeUndefined();
    expect(toolCall.data["parentToolUseId"]).toBeNull();
  });

  // ---------- additional coverage beyond the brief's 5 examples ----------

  it("maps task_progress -> agent_task with status running and usage fields translated", async () => {
    const evs = await run([
      { type: "system", subtype: "task_progress", task_id: "T2", tool_use_id: "tu_2", subagent_type: "qa",
        description: "still working", usage: { total_tokens: 100, tool_uses: 3, duration_ms: 4200 },
        last_tool_name: "Bash", summary: "ran tests" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["status"]).toBe("running");
    expect(task.data["lastToolName"]).toBe("Bash");
    expect(task.data["summary"]).toBe("ran tests");
    expect(task.data["usage"]).toEqual({ totalTokens: 100, toolUses: 3, durationMs: 4200 });
  });

  it("task_progress with no usage field leaves usage undefined (no crash on missing usage)", async () => {
    const evs = await run([
      { type: "system", subtype: "task_progress", task_id: "T3", description: "working" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["usage"]).toBeUndefined();
  });

  it("task_updated carries patch.error and falls back to patch.description when top-level description is absent", async () => {
    const evs = await run([
      { type: "system", subtype: "task_updated", task_id: "T4", patch: { status: "failed", error: "boom", description: "from patch" } },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["status"]).toBe("failed");
    expect(task.data["error"]).toBe("boom");
    expect(task.data["description"]).toBe("from patch");
  });

  it("task_started prefers the top-level description over patch.description when both could apply", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "T5", description: "top-level" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["description"]).toBe("top-level");
  });

  it("task_started with no patch object at all does not throw (patch defaults to {})", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "T6" },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["taskId"]).toBe("T6");
    expect(task.data["status"]).toBe("running");
    expect(task.data["error"]).toBeUndefined();
  });

  it("skipTranscript is captured from skip_transcript when present", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "T7", skip_transcript: true },
    ]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.data["skipTranscript"]).toBe(true);
  });

  it("a system message with an unrelated subtype (e.g. init) does NOT emit agent_task", async () => {
    const evs = await run([
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
    ]);
    // Every stream ends with a trailing "result" event (pre-existing, unrelated behavior) — only
    // assert no agent_task snuck in alongside the untouched init branch.
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "result"]);
    expect(evs.find((e) => e.kind === "agent_task")).toBeUndefined();
  });

  // NOTHING-SILENTLY-DROPPED: this asserted an unknown subtype produced NOTHING — which is what
  // it did, and the bug. The SDK emits ~40 system subtypes and the branches here map a handful, so
  // api_retry (the CLI's "retrying a failed request"), hook_started/progress/response,
  // background_tasks_changed and error/error_during_execution all fell off the end of the chain
  // unseen — leaving the transcript unable to tell "working" from "retrying" from "wedged".
  it("an unknown system subtype is passed through as status, not dropped", async () => {
    const evs = await run([
      { type: "system", subtype: "some_future_subtype", task_id: "T8" },
    ]);
    // The trailing end-of-stream "result" is pre-existing, unrelated behaviour.
    expect(evs.map((e) => e.kind)).toEqual(["status", "result"]);
    expect(evs[0]!.data).toMatchObject({ sdkEvent: "some_future_subtype" });
  });

  it("still does not crash on one, and still claims no MAPPED kind for it", async () => {
    const evs = await run([{ type: "system", subtype: "another_future_one" }]);
    // Deliberately status, never a guessed agent_task/message_complete — passing it through
    // claims only that the SDK said something, which is true; a mapping would be a claim about a
    // payload shape nobody has observed.
    expect(evs.some((e) => e.kind === "agent_task" || e.kind === "message_complete")).toBe(false);
  });

  it("multiple task_* messages in one stream each produce their own agent_task event, in order", async () => {
    const evs = await run([
      { type: "system", subtype: "task_started", task_id: "T9", subagent_type: "qa" },
      { type: "system", subtype: "task_progress", task_id: "T9", usage: { total_tokens: 5 } },
      { type: "system", subtype: "task_updated", task_id: "T9", patch: { status: "completed" } },
    ]);
    const taskEvs = evs.filter((e) => e.kind === "agent_task");
    expect(taskEvs.map((e) => e.data["status"])).toEqual(["running", "running", "completed"]);
    expect(evs.map((e) => e.kind)).toEqual(["agent_task", "agent_task", "agent_task", "result"]);
  });

  it("every agent_task sink call carries the raw SDK message", async () => {
    const raw = { type: "system", subtype: "task_started", task_id: "T10" };
    const evs = await run([raw]);
    const task = evs.find((e) => e.kind === "agent_task")!;
    expect(task.raw).toEqual(raw);
  });
});

// R2 (inline sub-agent/workflow surfacing): message_complete/tool_result gain the SAME
// parentToolUseId conditional-spread treatment tool_call already had — see claude.ts's assistant/
// user branches. `forwardSubagentText: true` is what makes a subagent's own text arrive at all.
describe("ClaudeAgentBackend: parentToolUseId on message_complete/tool_result (R2)", () => {
  it("sets forwardSubagentText: true on the SDK options object", async () => {
    const { fn, calls } = fakeQuery([]);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(calls[0]!.options["forwardSubagentText"]).toBe(true);
  });

  it("threads parentToolUseId onto message_complete for a subagent-tagged assistant text block", async () => {
    const evs = await run([
      { type: "assistant", parent_tool_use_id: "tu_sub", message: { role: "assistant", content: [
        { type: "text", text: "sub-agent says hi" },
      ] } },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete.data["text"]).toBe("sub-agent says hi");
    expect(complete.data["parentToolUseId"]).toBe("tu_sub");
  });

  it("a top-level assistant text block (parent_tool_use_id: null) omits parentToolUseId entirely — byte-identical to before this change", async () => {
    const evs = await run([
      { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [
        { type: "text", text: "top-level turn" },
      ] } },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete.data).toEqual({ text: "top-level turn" });
    expect("parentToolUseId" in complete.data).toBe(false);
  });

  it("a top-level assistant text block with NO parent_tool_use_id key at all (older CLI) also omits parentToolUseId", async () => {
    const evs = await run([
      { type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "old cli turn" },
      ] } },
    ]);
    const complete = evs.find((e) => e.kind === "message_complete")!;
    expect(complete.data).toEqual({ text: "old cli turn" });
  });

  it("threads parentToolUseId onto every tool_result block from a subagent-tagged user message", async () => {
    const evs = await run([
      { type: "user", parent_tool_use_id: "tu_sub", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "result a" },
        { type: "tool_result", tool_use_id: "tu_b", content: "result b" },
      ] } },
    ]);
    const results = evs.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.data["parentToolUseId"])).toEqual(["tu_sub", "tu_sub"]);
    expect(results.map((e) => e.data["toolId"])).toEqual(["tu_a", "tu_b"]);
  });

  it("a top-level tool_result (parent_tool_use_id: null) omits parentToolUseId — byte-identical to before this change", async () => {
    const evs = await run([
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "result a" },
      ] } },
    ]);
    const result = evs.find((e) => e.kind === "tool_result")!;
    expect(result.data).toEqual({ toolId: "tu_a", result: "result a" });
    expect("parentToolUseId" in result.data).toBe(false);
  });

  it("a user message with no tool_result blocks at all keeps the historical single empty-data event", async () => {
    const evs = await run([
      { type: "user", parent_tool_use_id: "tu_sub", message: { role: "user", content: [] } },
    ]);
    const result = evs.find((e) => e.kind === "tool_result")!;
    expect(result.data).toEqual({});
  });
});


describe("background task completion reaches the transcript", () => {
  const start = { type: "system", subtype: "task_started", task_id: "bg-login", task_type: "local_bash", is_backgrounded: true, description: "Start Atlas CLI device login" };
  it.each([["completed", "done"], ["failed", "failed"], ["stopped", "killed"]])("maps %s notifications without repeated background metadata", async (status, expected) => {
    const events = await run([start, { type: "system", subtype: "task_notification", task_id: "bg-login", status, summary: "command outcome", output_file: "/tmp/fixture.output" }]);
    const taskEvents = events.filter(e => e.kind === "agent_task");
    expect(taskEvents[1]?.data).toMatchObject({ taskId: "bg-login", taskType: "local_bash", isBackgrounded: true, status: status === "stopped" ? "killed" : status });
    const state = taskEvents.reduce((state, e, index) => reduce(state, { type: "event", event: { ...e, agentId: "ag-1", seq: index + 1, ts: 1000 + index } }), { ...initialState, agents: { "ag-1": emptyAgent("ag-1") } });
    expect(state.agents["ag-1"]!.transcript.filter(t => t.role === "task")).toEqual([expect.objectContaining({ status: expected, description: start.description })]);
  });
  it("preserves task identity when a foreground command is backgrounded by a patch", async () => {
    const events = await run([{ ...start, is_backgrounded: false }, { type: "system", subtype: "task_updated", task_id: "bg-login", patch: { is_backgrounded: true } }]);
    expect(events.filter(e => e.kind === "agent_task")[1]?.data).toMatchObject({ taskType: "local_bash", isBackgrounded: true });
  });
  it("normalizes the authoritative script set and excludes ambient tasks and subagents", async () => {
    const events = await run([{ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "shell", task_type: "local_bash", description: "script" },
      { task_id: "agent", task_type: "local_agent", description: "Explore" },
      { task_id: "watcher", task_type: "local_bash", ambient: true }, null,
    ] }, { type: "system", subtype: "background_tasks_changed", tasks: [] }, { type: "system", subtype: "background_tasks_changed", tasks: null }]);
    expect(events.filter(e => e.kind === "background_tasks").map(e => e.data)).toEqual([
      { tasks: [{ taskId: "shell", taskType: "local_bash", description: "script" }] }, { tasks: [] },
    ]);
  });
});
