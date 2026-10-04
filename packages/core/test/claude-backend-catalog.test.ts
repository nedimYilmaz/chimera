import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema, computeCostUsd, type ModelMetadataLookup } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// DYNAMIC-MODEL-METADATA (claude backend): the constructor's lazy `modelCatalog` accessor is
// threaded into the result-event cost fallback — `computeCostUsd(..., this.deps.modelCatalog?.())`.
// These tests prove that threading end-to-end: a model ABSENT from protocol's hardcoded MODEL_PRICING
// map ("vendor-omega-2") still gets a real, catalog-priced result costUsd; and without the catalog
// the same run reports 0 (computeCostUsd returns null for an unpriced model → falls back to costUsd).

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

// A catalog that ONLY knows the non-hardcoded model — a real dynamic entry the hardcoded map lacks.
const catalog: ModelMetadataLookup = {
  contextWindow: () => undefined,
  pricing: (m) => (m === "vendor-omega-2" ? { inputPerMTok: 7, outputPerMTok: 21, cachedInputPerMTok: 0.7 } : undefined),
};

// No total_cost_usd anywhere → the pricing-table fallback (which reads the catalog) is what runs.
// The init message names a model absent from the hardcoded MODEL_PRICING map.
const NO_COST_UNKNOWN_MODEL: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "vendor-omega-2" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  {
    type: "result", subtype: "success", result: "done",
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
];

describe("ClaudeAgentBackend: modelCatalog-priced result cost (DYNAMIC-MODEL-METADATA)", () => {
  it("uses the injected catalog's pricing for a model absent from the hardcoded map", async () => {
    const { fn } = fakeQuery(NO_COST_UNKNOWN_MODEL);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn, modelCatalog: () => catalog })
      .spawn(spec({ model: "vendor-omega-2" }), (e) => evs.push(e), async () => true);
    await settle();
    // 1M fresh input tokens @ $7/MTok (catalog rate) = $7 — derived via the SAME computeCostUsd the
    // backend uses so the assertion tracks the catalog rather than a hand-copied literal.
    const expected = computeCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, "vendor-omega-2", catalog)!;
    expect(expected).toBeCloseTo(7, 10);
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["costUsd"]).toBeCloseTo(7, 10);
  });

  it("without the catalog, the same unknown-model run reports costUsd 0 (computeCostUsd null → carries the prior 0)", async () => {
    const { fn } = fakeQuery(NO_COST_UNKNOWN_MODEL);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn })   // no modelCatalog
      .spawn(spec({ model: "vendor-omega-2" }), (e) => evs.push(e), async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["costUsd"]).toBe(0);
  });
});
