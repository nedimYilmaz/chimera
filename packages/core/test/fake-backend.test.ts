import { describe, it, expect } from "vitest";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { BackendEvent, PermissionDecider, ResolvedAgentSpec } from "@chimera/core/backend";
import { AgentSpecSchema } from "@chimera/protocol";

function spec(over: Partial<ResolvedAgentSpec> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp" }),
    agentId: "a1", accountName: "main", resolvedProvider: "claude", env: {}, depth: 0, ...over,
  };
}
const collect = () => { const evs: BackendEvent[] = []; return { evs, sink: (e: BackendEvent) => { evs.push(e); } }; };
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("FakeAgentBackend", () => {
  it("plays a scripted happy path and records the spawn", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "all done", costUsd: 0.12 } },
    ]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
    expect(evs[2]!.data).toEqual({ text: "all done", costUsd: 0.12 });
    expect(fake.spawns[0]!.agentId).toBe("a1");
  });

  it("routes permissions through the decider", async () => {
    const fake = new FakeAgentBackend([[
      { askPermission: { toolName: "Bash" } },
      { askPermission: { toolName: "Edit" } },
      { end: { resultText: "x" } },
    ]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async (req) => req.toolName === "Edit");
    await settle();
    expect(evs.map((e) => [e.kind, e.data["toolName"]])).toEqual([
      ["status", "Bash"], ["tool_call", "Edit"], ["turn_complete", undefined], ["result", undefined],
    ]);
  });

  it("awaitSend pauses until send() and kill() stops the script", async () => {
    const fake = new FakeAgentBackend([[
      { awaitSend: true },
      { end: { resultText: "after send" } },
    ]]);
    const { evs, sink } = collect();
    const h = fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs).toEqual([]);                     // paused
    await h.send("hello");
    await settle();
    expect(evs[0]).toEqual({ kind: "message_complete", data: { text: "echo:hello" } });
    expect(evs.map((e) => e.kind)).toContain("result");

    const fake2 = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const c2 = collect();
    const h2 = fake2.spawn(spec({ agentId: "a2" }), c2.sink, async () => true);
    await h2.kill();
    await h2.send("late");
    await settle();
    expect(c2.evs.every((e) => e.kind !== "result")).toBe(true);
  });

  it("fail emits an error event", async () => {
    const fake = new FakeAgentBackend([[{ fail: { message: "HTTP 429 Too Many Requests" } }]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs[0]!.kind).toBe("error");
    expect(evs[0]!.data["message"]).toContain("429");
  });

  // ---------- additional coverage: edges and branches beyond the brief's examples ----------

  it("falls back to a default agent_started + end scenario when scenarios are exhausted", async () => {
    const fake = new FakeAgentBackend([]);
    const { evs, sink } = collect();
    fake.spawn(spec({ prompt: "do the thing" }), sink, async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
    expect(evs[0]!.data).toEqual({});
    expect(evs[2]!.data).toEqual({ text: "fake:do the thing" });
  });

  it("consumes scenarios FIFO across multiple spawns, then falls back once exhausted", async () => {
    const fake = new FakeAgentBackend([
      [{ end: { resultText: "first" } }],
      [{ end: { resultText: "second" } }],
    ]);
    const c1 = collect();
    const c2 = collect();
    const c3 = collect();
    fake.spawn(spec({ agentId: "s1" }), c1.sink, async () => true);
    fake.spawn(spec({ agentId: "s2" }), c2.sink, async () => true);
    fake.spawn(spec({ agentId: "s3", prompt: "third" }), c3.sink, async () => true);
    await settle();
    expect(c1.evs[1]!.data).toEqual({ text: "first" });
    expect(c2.evs[1]!.data).toEqual({ text: "second" });
    expect(c3.evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
    expect(c3.evs[2]!.data).toEqual({ text: "fake:third" });
    expect(fake.spawns.map((s) => s.agentId)).toEqual(["s1", "s2", "s3"]);
  });

  it("end without costUsd omits the costUsd key entirely", async () => {
    const fake = new FakeAgentBackend([[{ end: { resultText: "no cost" } }]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs[1]!.data).toEqual({ text: "no cost" });
    expect("costUsd" in evs[1]!.data).toBe(false);
  });

  it("askPermission defaults input to {} when omitted, and passes it through when provided", async () => {
    const seen: unknown[] = [];
    const decide: PermissionDecider = async (req) => { seen.push(req.input); return true; };
    const fake = new FakeAgentBackend([[
      { askPermission: { toolName: "Bash" } },
      { askPermission: { toolName: "Edit", input: { file: "x.ts" } } },
      { end: { resultText: "done" } },
    ]]);
    const { sink } = collect();
    fake.spawn(spec(), sink, decide);
    await settle();
    expect(seen).toEqual([{}, { file: "x.ts" }]);
  });

  it("askPermission generates a distinct requestId per request", async () => {
    const seen: string[] = [];
    const decide: PermissionDecider = async (req) => { seen.push(req.requestId); return true; };
    const fake = new FakeAgentBackend([[
      { askPermission: { toolName: "Bash" } },
      { askPermission: { toolName: "Edit" } },
      { end: { resultText: "done" } },
    ]]);
    const { sink } = collect();
    fake.spawn(spec(), sink, decide);
    await settle();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(typeof seen[0]).toBe("string");
    expect(seen[0]!.length).toBeGreaterThan(0);
  });

  it("an early send() before the script reaches awaitSend is buffered, not dropped", async () => {
    const fake = new FakeAgentBackend([[
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { end: { resultText: "after buffered send" } },
    ]]);
    const { evs, sink } = collect();
    const h = fake.spawn(spec(), sink, async () => true);
    await h.send("early");            // arrives before setTimeout(run,0) has even fired
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "message_complete", "turn_complete", "result"]);
    expect(evs[1]!.data).toEqual({ text: "echo:early" });
  });

  it("fail tolerates an empty message string", async () => {
    const fake = new FakeAgentBackend([[{ fail: { message: "" } }]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs).toEqual([{ kind: "error", data: { message: "" } }]);
  });

  it("kill() while a permission decision is still pending suppresses the resulting event", async () => {
    let resolveDecision: (v: boolean) => void = () => {};
    const decide: PermissionDecider = () => new Promise((res) => { resolveDecision = res; });
    const fake = new FakeAgentBackend([[
      { askPermission: { toolName: "Bash" } },
      { end: { resultText: "never" } },
    ]]);
    const { evs, sink } = collect();
    const h = fake.spawn(spec(), sink, decide);
    await settle();               // script is parked awaiting the decider's promise
    await h.kill();
    resolveDecision(true);        // decider now resolves, but killed is already true
    await settle();
    expect(evs).toEqual([]);      // no tool_call, no turn_complete, no result
  });

  it("kill() racing a not-yet-resumed awaitSend resumption still suppresses the event", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const { evs, sink } = collect();
    const h = fake.spawn(spec(), sink, async () => true);
    await settle();               // parked at awaitSend, waiting for a send()
    h.send("late");               // synchronously resolves the parked promise (schedules resumption microtask)
    h.kill();                     // synchronously sets killed=true before that microtask runs
    await settle();
    expect(evs).toEqual([]);      // resumption observed killed=true and returned before emitting
  });

  it("kill(), send(), and interrupt() after the script already ended are safe no-ops", async () => {
    const fake = new FakeAgentBackend([[{ end: { resultText: "done" } }]]);
    const { evs, sink } = collect();
    const h = fake.spawn(spec(), sink, async () => true);
    await settle();
    const countAfterEnd = evs.length;
    await expect(h.interrupt()).resolves.toBeUndefined();
    await expect(h.kill()).resolves.toBeUndefined();
    await expect(h.send("too late")).resolves.toBeUndefined();
    await settle();
    expect(evs).toHaveLength(countAfterEnd);
  });

  it("exposes the fixed provider id and capabilities", () => {
    const fake = new FakeAgentBackend([]);
    expect(fake.provider).toBe("claude");
    expect(fake.capabilities).toEqual({
      supportsResume: true,
      supportsMcpServers: true,
      supportsSettingSources: true,
      supportsVoiceRealtime: false,
    });
  });

  // ---------- agent_task step (native-CLI-parity Phase 1, Task N1) ----------

  it("a { task: {...} } step drives an agent_task event through the sink with the mapped data", async () => {
    const fake = new FakeAgentBackend([[
      { task: { taskId: "T1", subagentType: "qa", status: "running" } },
      { end: { resultText: "ok" } },
    ]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_task", "turn_complete", "result"]);
    expect(evs[0]!.data).toEqual({ taskId: "T1", subagentType: "qa", status: "running" });
  });

  it("a { task: {...} } step with only taskId omits every other optional key", async () => {
    const fake = new FakeAgentBackend([[
      { task: { taskId: "T2" } },
      { end: { resultText: "ok" } },
    ]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs[0]).toEqual({ kind: "agent_task", data: { taskId: "T2" } });
  });

  it("a { task: {...} } step carries toolUseId/parentToolUseId/workflowName/description/skipTranscript through", async () => {
    const fake = new FakeAgentBackend([[
      { task: {
        taskId: "T3", toolUseId: "tu_1", parentToolUseId: "tu_0", subagentType: "qa",
        workflowName: "build", description: "reviewing", status: "running", skipTranscript: true,
      } },
      { end: { resultText: "ok" } },
    ]]);
    const { evs, sink } = collect();
    fake.spawn(spec(), sink, async () => true);
    await settle();
    expect(evs[0]!.data).toEqual({
      taskId: "T3", toolUseId: "tu_1", parentToolUseId: "tu_0", subagentType: "qa",
      workflowName: "build", description: "reviewing", status: "running", skipTranscript: true,
    });
  });

  // IMAGE.PASTE (TUI #7): send() gains an additive optional `images` param.
  // FakeAgentBackend ignores the attachment content itself (echo behavior
  // unaffected) but must accept the param so every Phase-1 call site stays valid.
  describe("send(): accepts an optional images param (IMAGE.PASTE, additive)", () => {
    it("send() with images still resolves and echoes the text unaffected", async () => {
      const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "after send" } }]]);
      const { evs, sink } = collect();
      const h = fake.spawn(spec(), sink, async () => true);
      await settle();
      await h.send("hello", [{ mediaType: "image/png", data: "aGVsbG8=" }]);
      await settle();
      expect(evs[0]).toEqual({ kind: "message_complete", data: { text: "echo:hello" } });
    });

    it("send() with an empty images array also resolves normally", async () => {
      const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "after send" } }]]);
      const { evs, sink } = collect();
      const h = fake.spawn(spec(), sink, async () => true);
      await settle();
      await h.send("hello", []);
      await settle();
      expect(evs[0]).toEqual({ kind: "message_complete", data: { text: "echo:hello" } });
    });

    it("send() without the images argument at all (backward compat) is unaffected", async () => {
      const fake = new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "after send" } }]]);
      const { evs, sink } = collect();
      const h = fake.spawn(spec(), sink, async () => true);
      await settle();
      await h.send("hello");
      await settle();
      expect(evs[0]).toEqual({ kind: "message_complete", data: { text: "echo:hello" } });
    });
  });
});
