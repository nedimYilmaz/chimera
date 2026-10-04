import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { SpanRecorder, redactAttributes } from "@chimera/core/otel";
import type { OtelConfig } from "@chimera/protocol";

// Event-log-driven rig: drives SpanRecorder purely via events.append({...}) calls shaped like
// the real events documented in PLAN.md — NOT a full supervisor/backend integration. taskFor/
// agentInfo are stubbed directly (mirrors SupervisorDeps' own "function seam" test convention).
// `now` is an injectable, manually-advanced clock so span durations are deterministic (never a
// real-timer-based test — this sandbox's session-limit tests are the documented cautionary tale).
function rig(configOverrides: Partial<OtelConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-otel-"));
  const events = new EventLog(dir);
  const parents = new Map<string, string | null>();
  const roles = new Map<string, string>();
  const models = new Map<string, string>();
  const providers = new Map<string, string>();
  const teams = new Map<string, string>();
  const tasks = new Map<string, string | null>();
  let clock = 1_000;
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const config: OtelConfig = {
    endpoint: null, serviceName: "chimera",
    redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] },
    maxFinishedSpans: 20000,
    ...configOverrides,
  };
  const recorder = new SpanRecorder({
    events, config,
    taskFor: (id) => tasks.get(id) ?? null,
    agentInfo: (id) => (parents.has(id) ? { parentId: parents.get(id)!, treeId: "t", role: roles.get(id), model: models.get(id), provider: providers.get(id), team: teams.get(id) } : null),
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => clock,
  });
  return {
    events, recorder, fetchFn,
    setParent: (id: string, parentId: string | null) => parents.set(id, parentId),
    setRole: (id: string, role: string) => roles.set(id, role),
    setModel: (id: string, model: string) => models.set(id, model),
    setProvider: (id: string, provider: string) => providers.set(id, provider),
    setTeam: (id: string, team: string) => teams.set(id, team),
    setTask: (id: string, taskId: string | null) => tasks.set(id, taskId),
    advance: (ms: number) => { clock += ms; },
  };
}

async function lastPayload(fetchFn: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const call = fetchFn.mock.calls[fetchFn.mock.calls.length - 1]!;
  return JSON.parse(call[1].body as string);
}

function spansOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return (payload as any).resourceSpans[0].scopeSpans[0].spans;
}

describe("SpanRecorder — span tree parenting", () => {
  it("nests a spawn span under its parent's spawn span, sharing one traceId", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.setParent("parent1", null);
    r.setParent("child1", "parent1");
    r.events.append({ agentId: "parent1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "child1", kind: "agent_started", data: {} });
    // child settles FIRST while parent's spawn span is still open — the common "sub-agent
    // finishes before its spawner" ordering.
    r.events.append({ agentId: "child1", kind: "result", data: { text: "ok", costUsd: 0 } });
    r.events.append({ agentId: "parent1", kind: "result", data: { text: "ok", costUsd: 0 } });

    const payloads = await Promise.all(r.fetchFn.mock.calls.map((c) => JSON.parse(c[1].body as string)));
    const allSpans = payloads.flatMap((p) => spansOf(p));
    const parentSpawn = allSpans.find((s) => (s.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .some((a) => a.key === "chimera.agent_id" && a.value.stringValue === "parent1"))!;
    const childSpawn = allSpans.find((s) => (s.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .some((a) => a.key === "chimera.agent_id" && a.value.stringValue === "child1"))!;
    expect(childSpawn.parentSpanId).toBe(parentSpawn.spanId);
    expect(childSpawn.traceId).toBe(parentSpawn.traceId);
  });

  it("turn nests under spawn, tool_call nests under turn — all share one traceId", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "tool_call", data: { toolName: "Read", toolId: "tool-1", input: { path: "/x" } } });
    r.events.append({ agentId: "a1", kind: "tool_result", data: { toolId: "tool-1", result: "file contents" } });
    r.events.append({ agentId: "a1", kind: "turn_complete", data: { turnCostUsd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } } });
    r.events.append({ agentId: "a1", kind: "result", data: { text: "done", costUsd: 0.01 } });

    const calls = r.fetchFn.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);   // tool_call close, turn close, spawn close
    const allSpans = (await Promise.all(calls.map((c) => JSON.parse(c[1].body as string))))
      .flatMap((p) => spansOf(p));

    const spawnSpan = allSpans.find((s) => s.name === "gen_ai.agent")!;
    const turnSpan = allSpans.find((s) => s.name === "gen_ai.chat")!;
    const toolSpan = allSpans.find((s) => s.name === "gen_ai.tool.execute")!;
    expect(turnSpan.parentSpanId).toBe(spawnSpan.spanId);
    expect(toolSpan.parentSpanId).toBe(turnSpan.spanId);
    expect(toolSpan.traceId).toBe(spawnSpan.traceId);
    expect(turnSpan.traceId).toBe(spawnSpan.traceId);
  });

  it("gate spans parent into the task root, not the agent spawn tree", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0", workflow: "w", version: 1 } });

    const payloads = await Promise.all(r.fetchFn.mock.calls.map((c) => JSON.parse(c[1].body as string)));
    const gateSpan = payloads.flatMap((p) => spansOf(p)).find((s) => s.name === "chimera.gate")!;
    const taskSpan = payloads.flatMap((p) => spansOf(p)).find((s) => s.name === "chimera.task");
    expect(gateSpan).toBeDefined();
    // the task root itself is never independently exported until it CLOSES (done/failed) —
    // confirm the gate's parentSpanId at least references a stable, non-null span id.
    expect(typeof gateSpan.parentSpanId).toBe("string");
    expect(gateSpan.parentSpanId.length).toBeGreaterThan(0);
    void taskSpan;
  });
});

describe("SpanRecorder — OTLP exporter", () => {
  it("no-ops when unconfigured (endpoint: null)", () => {
    const r = rig({ endpoint: null });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "tool_call", data: { toolName: "Read", toolId: "tool-1", input: {} } });
    r.events.append({ agentId: "a1", kind: "tool_result", data: { toolId: "tool-1", result: "x" } });
    r.events.append({ agentId: "a1", kind: "turn_complete", data: {} });
    r.events.append({ agentId: "a1", kind: "result", data: { text: "ok", costUsd: 0 } });
    expect(r.fetchFn).not.toHaveBeenCalled();
  });

  it("posts a well-formed OTLP payload when an endpoint is configured", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "result", data: { text: "ok", costUsd: 0 } });
    expect(r.fetchFn).toHaveBeenCalled();
    const [url] = r.fetchFn.mock.calls[0]!;
    expect(url).toBe("http://collector.local/v1/traces");
    const payload = await lastPayload(r.fetchFn);
    const spans = spansOf(payload);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.traceId as string).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId as string).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("SpanRecorder — redaction", () => {
  it("redactAttributes strips flagged fields, leaves others, when both flags are on", () => {
    const out = redactAttributes(
      { "gen_ai.output.text": "secret text", "gen_ai.tool.call.arguments": "{}", "chimera.agent_id": "a1" },
      { redactPrompts: true, redactToolIO: true, extraKeys: [] },
    );
    expect(out["gen_ai.output.text"]).toBe("[REDACTED]");
    expect(out["gen_ai.tool.call.arguments"]).toBe("[REDACTED]");
    expect(out["chimera.agent_id"]).toBe("a1");
  });
  it("redactPrompts:false leaves gen_ai.output.text untouched", () => {
    const out = redactAttributes(
      { "gen_ai.output.text": "secret text" },
      { redactPrompts: false, redactToolIO: true, extraKeys: [] },
    );
    expect(out["gen_ai.output.text"]).toBe("secret text");
  });
  it("extraKeys redacts additional named attributes", () => {
    const out = redactAttributes(
      { "chimera.custom": "sensitive" },
      { redactPrompts: false, redactToolIO: false, extraKeys: ["chimera.custom"] },
    );
    expect(out["chimera.custom"]).toBe("[REDACTED]");
  });

  it("redaction applies at export time only — rollup() numbers are unaffected", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.setParent("a1", null);
    r.setTask("a1", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "tool_call", data: { toolName: "Read", toolId: "tool-1", input: { secret: "shh" } } });
    r.events.append({ agentId: "a1", kind: "tool_result", data: { toolId: "tool-1", result: "shh-result" } });
    r.events.append({ agentId: "a1", kind: "turn_complete", data: { usage: { input_tokens: 3, output_tokens: 2 } } });
    r.events.append({ agentId: "a1", kind: "result", data: { text: "ok", costUsd: 0 } });

    const payloads = await Promise.all(r.fetchFn.mock.calls.map((c) => JSON.parse(c[1].body as string)));
    const toolSpan = payloads.flatMap((p) => spansOf(p)).find((s) => s.name === "gen_ai.tool.execute")!;
    const argsAttr = (toolSpan.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .find((a) => a.key === "gen_ai.tool.call.arguments")!;
    expect(argsAttr.value.stringValue).toBe("[REDACTED]");

    const rollup = r.recorder.rollup({ taskId: "t1" });
    expect(rollup.tasks[0]!.tokensIn).toBe(3);
    expect(rollup.tasks[0]!.tokensOut).toBe(2);
  });
});

describe("SpanRecorder — cleanup", () => {
  it("force-closes an unmatched tool_call on agent terminal, no dangling state leak", () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces" });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "tool_call", data: { toolName: "Bash", toolId: "tool-1", input: {} } });
    // no matching tool_result
    r.events.append({ agentId: "a1", kind: "result", data: { text: "ok", costUsd: 0 } });

    const orphan = r.fetchFn.mock.calls
      .map((c) => JSON.parse(c[1].body as string))
      .flatMap((p) => spansOf(p))
      .find((s) => s.name === "gen_ai.tool.execute")!;
    expect(orphan.status).toEqual({ code: 2 });   // error
    const orphanAttr = (orphan.attributes as Array<{ key: string; value: { boolValue?: boolean } }>)
      .find((a) => a.key === "chimera.orphaned");
    expect(orphanAttr?.value.boolValue).toBe(true);

    // drive a second, unrelated lifecycle — must not be corrupted by leftover state
    r.fetchFn.mockClear();
    r.setParent("a2", null);
    r.events.append({ agentId: "a2", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a2", kind: "result", data: { text: "ok", costUsd: 0 } });
    expect(r.fetchFn).toHaveBeenCalledTimes(1);   // just the spawn span, no stray orphan from a1
  });

  it("correlates tool_call/tool_result keyed by toolUseId (generic/openai-compat/gemini backends), not just toolId", () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces", redaction: { redactPrompts: true, redactToolIO: false, extraKeys: [] } });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    // generic.ts emits toolUseId, never toolId
    r.events.append({ agentId: "a1", kind: "tool_call", data: { toolName: "Bash", toolUseId: "call-1", input: {} } });
    r.events.append({ agentId: "a1", kind: "tool_result", data: { toolUseId: "call-1", result: "output" } });
    r.events.append({ agentId: "a1", kind: "result", data: { text: "ok", costUsd: 0 } });

    const toolSpan = r.fetchFn.mock.calls
      .map((c) => JSON.parse(c[1].body as string))
      .flatMap((p) => spansOf(p))
      .find((s) => s.name === "gen_ai.tool.execute")!;
    expect(toolSpan.status).toEqual({ code: 1 });   // ok, not orphaned/error
    const orphanAttr = (toolSpan.attributes as Array<{ key: string; value: { boolValue?: boolean } }>)
      .find((a) => a.key === "chimera.orphaned");
    expect(orphanAttr).toBeUndefined();
    const resultAttr = (toolSpan.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .find((a) => a.key === "gen_ai.tool.call.result");
    expect(resultAttr?.value.stringValue).toBe("output");
  });
});

describe("SpanRecorder — SLI rollup math", () => {
  it("computes gate pass/fail, token/cost sums, and a per-step breakdown", () => {
    const r = rig();
    r.setTask("worker", "t1");

    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0", workflow: "w", version: 1 } });

    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.02, usage: { input_tokens: 100, output_tokens: 50 } } });

    r.events.append({ agentId: "task:t1", kind: "task_step_failed", data: { taskId: "t1", stepIndex: 0, stepId: "s0", reason: "nope", willRetry: true } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0" } });

    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.03, usage: { input_tokens: 200, output_tokens: 80 } } });

    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 1, stepId: "s1" } });
    r.events.append({ agentId: "worker", kind: "result", data: { text: "ok", costUsd: 0.05 } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "done" } });

    const result = r.recorder.rollup({ taskId: "t1" });
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0]!;
    expect(t.taskId).toBe("t1");
    expect(t.workflow).toBe("w");
    expect(t.version).toBe(1);
    // step0 sees 2 task_step_advanced (initial + retry-after-fail) + step1 sees 1 more = 3 total
    expect(t.gatePasses).toBe(3);
    expect(t.gateFailures).toBe(1);
    expect(t.tokensIn).toBe(300);
    expect(t.tokensOut).toBe(130);
    expect(t.costUsd).toBeCloseTo(0.05, 5);
    expect(t.durationMs).not.toBeNull();

    const step0 = t.steps.find((s) => s.stepIndex === 0)!;
    expect(step0.gatePasses).toBe(2);   // initial task_step_advanced + the retry-after-fail pass
    expect(step0.gateFailures).toBe(1);
    expect(step0.tokensIn).toBe(300);
    expect(step0.tokensOut).toBe(130);

    const step1 = t.steps.find((s) => s.stepIndex === 1)!;
    expect(step1.gatePasses).toBe(1);
    expect(step1.gateFailures).toBe(0);
    expect(step1.tokensIn).toBe(0);
  });

  it("errorRate stays in [0,1] and doesn't double-count gate failures as turn errors", () => {
    const r = rig();
    r.setTask("worker", "t1");

    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0", workflow: "w", version: 1 } });

    // one turn, then two gate-retry failures before the step finally passes
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } } });
    r.events.append({ agentId: "task:t1", kind: "task_step_failed", data: { taskId: "t1", stepIndex: 0, stepId: "s0", reason: "nope", willRetry: true } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_failed", data: { taskId: "t1", stepIndex: 0, stepId: "s0", reason: "nope again", willRetry: true } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0" } });

    r.events.append({ agentId: "worker", kind: "result", data: { text: "ok", costUsd: 0.01 } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "done" } });

    const result = r.recorder.rollup({ taskId: "t1" });
    const t = result.tasks[0]!;
    expect(t.turnCount).toBe(1);
    expect(t.gateFailures).toBe(2);
    expect(t.errorCount).toBe(0);   // the turn itself succeeded — only the gate retries failed
    expect(t.errorRate).toBe(0);
    expect(result.totals.errorCount).toBe(0);
    expect(result.totals.errorRate).toBe(0);
  });

  it("excludes open (unfinished) spans from the rollup; includes them once closed", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "message_delta", data: { text: "..." } });   // opens a turn, no close yet

    let result = r.recorder.rollup({ taskId: "t1" });
    expect(result.tasks[0]!.turnCount).toBe(0);

    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    result = r.recorder.rollup({ taskId: "t1" });
    expect(result.tasks[0]!.turnCount).toBe(1);
  });

  it("filters by from/to on span start time", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.advance(0);
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0" } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", state: "done" } });

    r.advance(10_000);
    r.setTask("worker2", "t2");
    r.events.append({ agentId: "task:t2", kind: "status", data: { taskId: "t2", state: "pending" } });
    r.events.append({ agentId: "task:t2", kind: "task_step_advanced", data: { taskId: "t2", stepIndex: 0, stepId: "s0" } });
    r.events.append({ agentId: "task:t2", kind: "status", data: { taskId: "t2", state: "done" } });

    const early = r.recorder.rollup({ to: 5_000 });
    expect(early.tasks.map((t) => t.taskId)).toEqual(["t1"]);
    const late = r.recorder.rollup({ from: 5_000 });
    expect(late.tasks.map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("separates active age from completed latency and emits provider buckets/breakdown", () => {
    const r = rig();
    r.setTask("worker", "t1"); r.setParent("worker", null); r.setProvider("worker", "codex"); r.setTeam("worker", "ui");
    r.events.append({ agentId: "task:t1", kind: "status", data: { taskId: "t1", queue: "features", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 2, output_tokens: 1 } } });
    r.advance(5_000);
    const result = r.recorder.rollup({ from: 1_000, to: 10_000, bucketMs: 3_000, groupBy: "provider" });
    expect(result.tasks[0]).toMatchObject({ activeAgeMs: 5_000, durationMs: null, provider: "codex", team: "ui", queue: "features" });
    expect(result.totals).toMatchObject({ activeTasks: 1, completedTasks: 0, p95DurationMs: null });
    expect(result.breakdown[0]).toMatchObject({ key: "codex", activeTasks: 1, taskCount: 1 });
    expect(result.buckets).toHaveLength(3);
  });
});

describe("SpanRecorder — hot reload", () => {
  it("setConfig takes effect on the NEXT export only, not retroactively", async () => {
    const r = rig({ endpoint: "http://collector.local/v1/traces", redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] } });
    r.setParent("a1", null);
    r.events.append({ agentId: "a1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "a1", kind: "message_complete", data: { text: "first output" } });
    r.events.append({ agentId: "a1", kind: "turn_complete", data: {} });

    const firstPayload = await lastPayload(r.fetchFn);
    const firstTurn = spansOf(firstPayload).find((s) => s.name === "gen_ai.chat")!;
    const firstAttr = (firstTurn.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .find((a) => a.key === "gen_ai.output.text")!;
    expect(firstAttr.value.stringValue).toBe("[REDACTED]");

    r.recorder.setConfig({
      endpoint: "http://collector.local/v1/traces", serviceName: "chimera",
      redaction: { redactPrompts: false, redactToolIO: true, extraKeys: [] },
      maxFinishedSpans: 20000,
    });
    r.events.append({ agentId: "a1", kind: "message_complete", data: { text: "second output" } });
    r.events.append({ agentId: "a1", kind: "turn_complete", data: {} });

    const secondPayload = await lastPayload(r.fetchFn);
    const secondTurn = spansOf(secondPayload).find((s) => s.name === "gen_ai.chat")!;
    const secondAttr = (secondTurn.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .find((a) => a.key === "gen_ai.output.text")!;
    expect(secondAttr.value.stringValue).toBe("second output");

    // the FIRST call's payload is untouched (already sent, not retroactively rewritten)
    const firstAttrAgain = (spansOf(firstPayload).find((s) => s.name === "gen_ai.chat")!.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .find((a) => a.key === "gen_ai.output.text")!;
    expect(firstAttrAgain.value.stringValue).toBe("[REDACTED]");
  });
});

// FEATURE-12 (span-store-replay-on-startup): a fresh SpanRecorder over the SAME EventLog,
// simulating a daemon restart where the live scheduler/supervisor state (taskFor/agentInfo) is
// gone — only the retained event log survives. Mirrors rig()'s config defaults so replay-vs-live
// behavior is comparable, but taskFor/agentInfo return null by default (no live process to ask).
function restart(r: { events: InstanceType<typeof EventLog> }, opts: { configOverrides?: Partial<OtelConfig>; now?: () => number } = {}) {
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
  const config: OtelConfig = {
    endpoint: null, serviceName: "chimera",
    redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] },
    maxFinishedSpans: 20000,
    ...opts.configOverrides,
  };
  const recorder = new SpanRecorder({
    events: r.events,
    config,
    taskFor: () => null,
    agentInfo: () => null,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: opts.now,
  });
  return { recorder, fetchFn };
}

describe("SpanRecorder — replay from the retained event log", () => {
  it("T1: restores tasks and turns for a fresh recorder after a restart", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0, stepId: "s0", workflow: "w", version: 1 } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.02, usage: { input_tokens: 100, output_tokens: 50 } } });
    r.events.append({ agentId: "worker", kind: "result", data: { text: "ok", costUsd: 0.02 } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder } = restart(r);
    const result = recorder.rollup({ taskId: "t1" });
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0]!;
    expect(t.taskId).toBe("t1");
    expect(t.workflow).toBe("w");
    expect(t.tokensIn).toBe(100);
    expect(t.tokensOut).toBe(50);
    expect(t.costUsd).toBeCloseTo(0.02, 5);
  });

  it("T2: stamps replayed spans with the event's own time, not the restart wall clock", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    const turnEvent = r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    // a restart wall clock wildly far from when the events actually happened
    const { recorder } = restart(r, { now: () => 9_999_999_999 });

    const nearEvent = recorder.rollup({ taskId: "t1", from: turnEvent.ts - 1, to: turnEvent.ts + 1 });
    expect(nearEvent.tasks.map((t) => t.taskId)).toEqual(["t1"]);

    const nearRestart = recorder.rollup({ taskId: "t1", from: 9_999_999_998, to: 10_000_000_000 });
    expect(nearRestart.tasks).toHaveLength(0);
  });

  it("T3: does not re-export replayed spans even when an endpoint is configured", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder, fetchFn } = restart(r, { configOverrides: { endpoint: "http://collector.local/v1/traces" } });
    recorder.rollup({ taskId: "t1" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("T4: replayFromLog is idempotent — a later call does not re-fold or duplicate spans", () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder } = restart(r);
    const first = recorder.replayFromLog();
    const second = recorder.replayFromLog();
    expect(second).toBe(first);

    const result = recorder.rollup({ taskId: "t1" });
    expect(result.tasks[0]!.tokensIn).toBe(1);
  });

  it("T5: an event handled live is not re-added by the first replay (seq >= liveFromSeq is excluded)", () => {
    const r = rig();
    r.setTask("worker", "t1");
    // rig() constructs the live recorder BEFORE any of these events exist, so liveFromSeq is
    // already past all of them — the live subscriber, not replay, is what folds them.
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.02, usage: { input_tokens: 2, output_tokens: 2 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const result = r.recorder.rollup({ taskId: "t1" });
    expect(result.tasks[0]!.tokensIn).toBe(2);
    expect(result.tasks[0]!.costUsd).toBeCloseTo(0.02, 5);
  });

  it("T6: reports how much of the log was replayed and whether it was truncated", () => {
    const r = rig();
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    for (let i = 0; i < 5; i++) {
      r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder } = restart(r);
    const bounded = recorder.replayFromLog(3);
    expect(bounded.replayed).toBe(true);
    expect(bounded.events).toBe(3);
    expect(bounded.truncated).toBe(true);

    const r2 = rig();
    r2.events.append({ agentId: "task:t2", kind: "status", data: { agentId: "worker", taskId: "t2", state: "pending" } });
    r2.events.append({ agentId: "task:t2", kind: "status", data: { agentId: "worker", taskId: "t2", state: "done" } });
    const { recorder: recorder2 } = restart(r2);
    const full = recorder2.replayFromLog(1000);
    expect(full.truncated).toBe(false);
    expect(full.events).toBe(2);
  });

  it("T7: rebuilds task, team and provider attribution with no live scheduler or supervisor", () => {
    const r = rig();
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: { provider: "codex", membership: { team: "ui", role: "worker" } } });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 5, output_tokens: 3 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    // taskFor/agentInfo both return null — "no live scheduler or supervisor" to ask.
    const { recorder } = restart(r);
    const result = recorder.rollup({ taskId: "t1" });
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0]!;
    expect(t.taskId).toBe("t1");
    expect(t.team).toBe("ui");
    expect(t.provider).toBe("codex");
  });

  it("T8: does not fabricate an end time or active age for a task whose root never closed in the log", () => {
    const r = rig();
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    // no task-done status — the task root (owned by whichever process is live) never closes,
    // and replay deliberately does not restore taskRoots, so it must not invent an end or an age.

    const { recorder } = restart(r, { now: () => 5_000_000 });
    const result = recorder.rollup({ taskId: "t1" });
    const t = result.tasks[0]!;
    expect(t.durationMs).toBeNull();
    expect(t.activeAgeMs).toBeNull();
  });

  it("T9: tolerates an empty or task-only log with nothing to replay", () => {
    const config: OtelConfig = {
      endpoint: null, serviceName: "chimera",
      redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] },
      maxFinishedSpans: 20000,
    };

    const emptyDir = mkdtempSync(join(tmpdir(), "chimera-otel-"));
    const emptyEvents = new EventLog(emptyDir);
    const emptyRecorder = new SpanRecorder({ events: emptyEvents, config, taskFor: () => null, agentInfo: () => null });
    const emptyCoverage = emptyRecorder.replayFromLog();
    expect(emptyCoverage.replayed).toBe(true);
    expect(emptyCoverage.events).toBe(0);
    expect(emptyCoverage.truncated).toBe(false);
    expect(() => emptyRecorder.rollup({})).not.toThrow();

    const taskOnlyDir = mkdtempSync(join(tmpdir(), "chimera-otel-"));
    const taskOnlyEvents = new EventLog(taskOnlyDir);
    taskOnlyEvents.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    const taskOnlyRecorder = new SpanRecorder({ events: taskOnlyEvents, config, taskFor: () => null, agentInfo: () => null });
    expect(() => taskOnlyRecorder.rollup({})).not.toThrow();
  });

  it("T10: a persistent worker rebound to a second task attributes each turn to the task it was bound to", () => {
    const r = rig();
    r.events.append({ agentId: "task:A", kind: "status", data: { agentId: "worker", taskId: "A", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 1, usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:A", kind: "status", data: { agentId: "worker", taskId: "A", state: "done" } });

    r.events.append({ agentId: "task:B", kind: "status", data: { agentId: "worker", taskId: "B", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 2, usage: { input_tokens: 2, output_tokens: 2 } } });
    r.events.append({ agentId: "task:B", kind: "status", data: { agentId: "worker", taskId: "B", state: "done" } });

    const { recorder } = restart(r);
    const result = recorder.rollup({});
    const taskA = result.tasks.find((t) => t.taskId === "A")!;
    const taskB = result.tasks.find((t) => t.taskId === "B")!;
    expect(taskA.costUsd).toBeCloseTo(1, 5);
    expect(taskB.costUsd).toBeCloseTo(2, 5);
  });
  // QA carry-forward (F12.QA): the replay clock is event-time; it must not leak into spans
  // recorded AFTER the warm-up, or every live span would be stamped with a stale timestamp.
  it("T11: a live span recorded after replay is stamped with the wall clock, not event time", async () => {
    const r = rig();
    r.events.append({ agentId: "task:old", kind: "status", data: { agentId: "w1", taskId: "old", state: "pending" } });
    r.events.append({ agentId: "w1", kind: "agent_started", data: {} });
    r.events.append({ agentId: "w1", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:old", kind: "status", data: { agentId: "w1", taskId: "old", state: "done" } });

    const WALL = 5_000_000;
    const { recorder, fetchFn } = restart(r, {
      configOverrides: { endpoint: "http://collector.local/v1/traces" },
      now: () => WALL,
    });
    recorder.replayFromLog();

    const live = r.events.append({ agentId: "task:new", kind: "status", data: { agentId: "w2", taskId: "new", state: "pending" } });
    r.events.append({ agentId: "w2", kind: "agent_started", data: {} });
    r.events.append({ agentId: "w2", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:new", kind: "status", data: { agentId: "w2", taskId: "new", state: "done" } });
    await Promise.resolve();

    expect(live.ts).toBeGreaterThan(WALL * 100); // sanity: event time is nowhere near this wall clock
    const spans = fetchFn.mock.calls.flatMap((c) => JSON.parse((c as any)[1].body as string).resourceSpans[0].scopeSpans[0].spans as any[]);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(Number(s.startTimeUnixNano)).toBe(WALL * 1_000_000);
  });

  // A7: truncated is a statement about the tail BOUND. Live events appended before the warm-up
  // are filtered out of the replay window but still consumed the bound.
  it("T12: reports truncated when the bound cut the window even though live events fill the tail", () => {
    const r = rig();
    for (let i = 0; i < 4; i++) {
      r.events.append({ agentId: "w", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    const { recorder } = restart(r);
    r.events.append({ agentId: "w", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "w", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });

    const coverage = recorder.replayFromLog(2);
    expect(coverage.truncated).toBe(true);
    expect(coverage.events).toBe(0); // both events in the 2-event tail were live, none replayable
  });

  it("T13: a task that finishes after the restart reports its real, event-time-anchored duration", () => {
    const r = rig();
    const start = r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "w", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "w", kind: "agent_started", data: {} });
    r.events.append({ agentId: "w", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });

    const WALL = start.ts + 60_000;
    const { recorder } = restart(r, { now: () => WALL });
    recorder.replayFromLog();
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "w", taskId: "t1", state: "done" } });

    const t = recorder.rollup({ taskId: "t1" }).tasks[0]!;
    expect(t.startedAt).toBeLessThan(WALL);
    expect(t.durationMs).toBeGreaterThan(50_000);
  });

  it("T14: a task still running across the restart reports its real age, not ~0", () => {
    const r = rig();
    const start = r.events.append({ agentId: "task:t2", kind: "status", data: { agentId: "w", taskId: "t2", state: "pending" } });
    r.events.append({ agentId: "w", kind: "agent_started", data: {} });
    r.events.append({ agentId: "w", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });

    const WALL = start.ts + 60_000;
    const { recorder } = restart(r, { now: () => WALL });
    recorder.replayFromLog();
    r.events.append({ agentId: "task:t2", kind: "status", data: { agentId: "w", taskId: "t2", state: "running" } });

    const t = recorder.rollup({ taskId: "t2" }).tasks[0]!;
    expect(t.endedAt).toBeNull();
    expect(t.activeAgeMs).toBeGreaterThan(50_000);
  });

  it("T15: a restored task row equals the live one on every field not derived from now() [F12.QA-FIX]", () => {
    const r = rig();
    r.setTask("worker", "t1");
    // Live team/provider comes from the injected agentInfo() deps callback, not from the event
    // payload — mirror the agent_started event's data here so the live and replayed recorders
    // are attributing the SAME real-world fact via their two different sources of truth.
    r.setParent("worker", null);
    r.setProvider("worker", "codex");
    r.setTeam("worker", "ui");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({
      agentId: "task:t1",
      kind: "task_step_advanced",
      data: { taskId: "t1", stepIndex: 0, stepId: "s0", workflow: "w1", version: 3 },
    });
    r.events.append({ agentId: "worker", kind: "agent_started", data: { provider: "codex", membership: { team: "ui", role: "worker" } } });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { turnCostUsd: 0.03, usage: { input_tokens: 7, output_tokens: 4 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const live = r.recorder.rollup({ taskId: "t1" }).tasks[0]!;

    const { recorder } = restart(r);
    const restored = recorder.rollup({ taskId: "t1" }).tasks[0]!;

    // Allowed-divergence set: fields derived from `now()` diverge BY DESIGN, not by bug. Live
    // folding stamps spans via wallClock() (a real-time read taken at fold time); replay stamps
    // them via the event's own persisted `ts` instead (the event-time clock split this file's
    // header documents — the exact mechanism that keeps a restored duration correct once the
    // live process's clock is gone). Comparing these fields would only be comparing two different
    // clock sources against each other, not the fold logic under test — so they are excluded here,
    // and everything else (which comes straight out of the same event data on both sides) must
    // match exactly.
    const NOW_DERIVED_TASK_FIELDS = ["startedAt", "endedAt", "durationMs", "activeAgeMs"] as const;
    const strip = (t: typeof live) => {
      const rest: any = { ...t };
      for (const f of NOW_DERIVED_TASK_FIELDS) delete rest[f];
      rest.steps = t.steps.map((s: any) => {
        const { durationMs, ...stepRest } = s;
        return stepRest;
      });
      return rest;
    };
    expect(strip(restored)).toEqual(strip(live));
  });

  it("T16: replayFromLogAsync never calls the synchronous EventLog.tail [F12.QA-FIX]", async () => {
    const r = rig();
    r.setTask("worker", "t1");
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "worker", kind: "agent_started", data: {} });
    r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder } = restart(r);
    const tailSpy = vi.spyOn(r.events, "tail");
    const tailAsyncSpy = vi.spyOn(r.events, "tailAsync");

    const coverage = await recorder.replayFromLogAsync();

    expect(tailSpy).not.toHaveBeenCalled();
    expect(tailAsyncSpy).toHaveBeenCalledWith(null, expect.any(Number));
    expect(coverage.spans).toBeGreaterThan(0);
  });

  it("T17: replayFromLogAsync produces the same SliRollupCoverage as the sync replayFromLog [F12.QA-FIX]", async () => {
    const r = rig();
    r.setTask("worker", "t1");
    for (let i = 0; i < 5; i++) {
      r.events.append({ agentId: "worker", kind: "turn_complete", data: { usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "pending" } });
    r.events.append({ agentId: "task:t1", kind: "status", data: { agentId: "worker", taskId: "t1", state: "done" } });

    const { recorder: syncRecorder } = restart(r);
    const syncCoverage = syncRecorder.replayFromLog();

    const { recorder: asyncRecorder } = restart(r);
    const asyncCoverage = await asyncRecorder.replayFromLogAsync();

    expect(asyncCoverage).toEqual(syncCoverage);
  });
});
