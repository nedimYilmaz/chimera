// F39 commit 1 — L1-MEASURE instrumentation. Every compaction event must say WHAT IT FIRED
// AGAINST (threshold + which rung of the precedence chain produced it + model + provider), the
// synthetic ctx-reset usage event must be excludable from a spend ledger without pattern-matching
// a zero signature, and the call that actually PAYS for an SDK compaction (the prefix-cache
// rewrite on the next real turn) must be findable without guessing which call was "first after".
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import { GenericAgentBackend, type ChatClient, type ChatStreamEvent } from "@chimera/core/backends/generic";
import { normalizeKimiEvent, type KimiMapCtx } from "@chimera/core/backends/kimi";
import { CodexAgentBackend, type CodexThreadEvent } from "@chimera/core/backends/codex";
import type { BackendEvent, PermissionDecider, ResolvedAgentSpec } from "@chimera/core/backend";
import { fakeCodex, cxSpec } from "./codex-backend-helpers.js";

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const fn = (() => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: async () => {},
  })) as never;
  return { fn };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  const { compactionThresholdSource, ...specOver } = over;
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...specOver }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
    ...(compactionThresholdSource ? { compactionThresholdSource } : {}),
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const allow: PermissionDecider = async () => true;

const INIT: Msg = { type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-20260101" };
const BOUNDARY = (over: Record<string, unknown> = {}): Msg =>
  ({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 195_000, post_tokens: 20_000, ...over } });
const startUsage = (input: number): Msg =>
  ({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 5 } } } });

async function runClaude(messages: Msg[], s: ResolvedAgentSpec = spec()): Promise<BackendEvent[]> {
  const { fn } = fakeQuery(messages);
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fn }).spawn(s, (e) => evs.push(e), async () => true);
  await settle();
  return evs;
}

describe("F39 A1: a claude compact_boundary reports the threshold it fired against", () => {
  it("a spawn with compactionThreshold 500000 emits thresholdInForce 500000 and thresholdSource 'spawn'", async () => {
    const evs = await runClaude([INIT, BOUNDARY()], spec({ compactionThreshold: 500_000, compactionThresholdSource: "spawn" }));
    const data = evs.find((e) => e.kind === "compaction")!.data;
    expect(data["thresholdInForce"]).toBe(500_000);
    expect(data["thresholdSource"]).toBe("spawn");
  });

  it("a spawn with NO threshold emits thresholdInForce null and thresholdSource 'native' — never an omitted key, which is indistinguishable from an event written before this field existed", async () => {
    const evs = await runClaude([INIT, BOUNDARY()]);
    const data = evs.find((e) => e.kind === "compaction")!.data;
    expect(Object.hasOwn(data, "thresholdInForce")).toBe(true);
    expect(data["thresholdInForce"]).toBeNull();
    expect(data["thresholdSource"]).toBe("native");
  });

  it("carries the model the SDK REPORTED and the resolved provider — not the requested alias, which would overwrite actualModel via supervisor.onEvent's per-event model sniff", async () => {
    const evs = await runClaude([INIT, BOUNDARY()], spec({ model: "opus" }));
    const data = evs.find((e) => e.kind === "compaction")!.data;
    expect(data["model"]).toBe("claude-opus-5-20260101");   // system/init's model, not spec.model ("opus")
    expect(data["provider"]).toBe("claude");
    // and it agrees with what agent_started reported, so the sniff is a no-op
    expect(evs.find((e) => e.kind === "agent_started")!.data["model"]).toBe(data["model"]);
  });
});

describe("F39 A2/A3: the compaction's phantom cost and its real cost are both findable", () => {
  it("the post_tokens baseline-reset usage event is marked synthetic:'compaction-baseline'; the turn's own message_start usage is not", async () => {
    const evs = await runClaude([INIT, startUsage(150_000), BOUNDARY()]);
    const usage = evs.filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]!.data["synthetic"]).toBeUndefined();
    expect(usage[1]!.data["synthetic"]).toBe("compaction-baseline");
    // A2's whole point: a ledger keyed on the marker sums exactly the real calls.
    const real = usage.filter((e) => e.data["synthetic"] === undefined);
    expect(real.map((e) => (e.data["usage"] as { input_tokens: number }).input_tokens)).toEqual([150_000]);
  });

  it("the FIRST real usage event after a boundary carries afterCompaction:true and the second does not — and the message_delta re-emission of the same turn never carries it", async () => {
    const evs = await runClaude([
      INIT,
      startUsage(150_000),
      BOUNDARY(),
      startUsage(21_000),
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 40 } } },
      startUsage(30_000),
    ]);
    const real = evs.filter((e) => e.kind === "usage" && e.data["synthetic"] === undefined);
    expect(real.map((e) => e.data["afterCompaction"])).toEqual([undefined, true, undefined, undefined]);
    // the marked one is the message_start of the turn AFTER the boundary — the call that pays
    // the full prefix-cache rewrite
    expect((real[1]!.data["usage"] as { input_tokens: number }).input_tokens).toBe(21_000);
    // the synthetic reset must never consume the latch
    expect(evs.find((e) => e.data["synthetic"] === "compaction-baseline")!.data["afterCompaction"]).toBeUndefined();
  });
});

// ---------- A4: the chimera-owned emitter ----------

function fakeChatClient(turnScripts: ChatStreamEvent[][]) {
  let turn = 0;
  const client: ChatClient = {
    stream() {
      const script = turnScripts[turn++] ?? [];
      return (async function* () { for (const ev of script) yield ev; })();
    },
  };
  return { client };
}
function genSpec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  const { compactionThresholdSource, ...specOver } = over;
  return {
    ...AgentSpecSchema.parse({ prompt: "do the task", cwd: tmpdir(), isolation: "none", ...specOver }),
    agentId: "gen-1", accountName: "gen-main", resolvedProvider: "test-provider", env: {}, depth: 0,
    ...(compactionThresholdSource ? { compactionThresholdSource } : {}),
  } as ResolvedAgentSpec;
}
// Same shape generic-backend.test.ts's own compaction case uses: 39 padded tool round-trips blow
// past the char budget, so a real budget-triggered compaction fires mid-run.
async function runGenericToCompaction(s: ResolvedAgentSpec): Promise<BackendEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), "f39-generic-"));
  const pad = "x".repeat(3000);
  const scripts: ChatStreamEvent[][] = [];
  for (let i = 0; i < 39; i++) {
    scripts.push([{ type: "message_complete", content: pad, model: "served-model-x", toolCalls: [{ id: `c${i}`, name: "list_dir", arguments: JSON.stringify({ path: dir }) }] }]);
  }
  scripts.push([{ type: "message_complete", content: "done", model: "served-model-x", toolCalls: [] }]);
  const { client } = fakeChatClient(scripts);
  const evs: BackendEvent[] = [];
  new GenericAgentBackend("test-provider", client).spawn({ ...s, cwd: dir } as ResolvedAgentSpec, (e) => evs.push(e), allow);
  for (let i = 0; i < 200 && !evs.some((e) => e.kind === "result"); i++) await settle();
  return evs;
}

describe("F39 A4: generic.ts's chimera-owned compaction reports the same facts, plus a real cost", () => {
  it("carries the four fields plus costUsd:0 — a fact, not an estimate: this compaction is a mechanical collapse, never an LLM call", async () => {
    // 20k tokens -> an 80k-char budget (compaction.ts's ~4 chars/token heuristic), which the
    // 39 padded round-trips below actually cross — a larger threshold simply never fires.
    const evs = await runGenericToCompaction(genSpec({ compactionThreshold: 20_000, compactionThresholdSource: "account" }));
    const data = evs.find((e) => e.kind === "compaction")!.data;
    expect(data["thresholdInForce"]).toBe(20_000);
    expect(data["thresholdSource"]).toBe("account");
    expect(data["costUsd"]).toBe(0);
    expect(data["provider"]).toBe("test-provider");
    expect(data["model"]).toBe("served-model-x");   // the SERVED model, not the requested one
    expect(data["budgetSource"]).toBe("operator");  // pre-existing field, untouched
  });

  it("a budgetSource of catalog/hardcoded/default maps to thresholdSource 'native' — no chimera threshold was in force, the model's own window was", async () => {
    const evs = await runGenericToCompaction(genSpec());
    const data = evs.find((e) => e.kind === "compaction")!.data;
    expect(data["budgetSource"]).toBe("default");
    expect(data["thresholdSource"]).toBe("native");
    expect(data["thresholdInForce"]).toBeNull();
  });
});

// ---------- A5: a backend that cannot report a field omits it ----------

describe("F39 A5: kimi gains the threshold, still claims no sizes; codex emits nothing at all", () => {
  const ctx = (over: Partial<KimiMapCtx> = {}): KimiMapCtx =>
    ({ toolTitles: new Map(), toolClosed: new Set(), commands: new Set(), ...over });

  it("kimi's compaction_update gains the threshold fields but still carries no trigger, no before and no after", () => {
    const e = normalizeKimiEvent(
      { sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" } as never,
      ctx({ compaction: { thresholdInForce: 300_000, thresholdSource: "provider", model: "kimi-k2", provider: "kimi" } }),
    ) as BackendEvent;
    expect(e.data["thresholdInForce"]).toBe(300_000);
    expect(e.data["thresholdSource"]).toBe("provider");
    expect(e.data["model"]).toBe("kimi-k2");
    expect(e.data["provider"]).toBe("kimi");
    // ACP reports none of these and a guess would read as a measurement (kimi.ts's own comment)
    expect(e.data["trigger"]).toBeUndefined();
    expect(e.data["before"]).toBeUndefined();
    expect(e.data["after"]).toBeUndefined();
  });

  it("a full codex run emits ZERO compaction events — its SDK exposes no such signal, and a fabricated one would be read as a measurement", async () => {
    const HAPPY: CodexThreadEvent[] = [
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "a", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 400_000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } },
    ];
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: fakeCodex([HAPPY]).factory })
      .spawn(cxSpec({ compactionThreshold: 100_000 }), (e) => evs.push(e), allow);
    for (let i = 0; i < 50 && !evs.some((e) => e.kind === "result"); i++) await settle();
    expect(evs.some((e) => e.kind === "result")).toBe(true);
    expect(evs.filter((e) => e.kind === "compaction")).toHaveLength(0);
  });
});
