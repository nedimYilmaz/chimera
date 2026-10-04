import { describe, it, expect } from "vitest";
import { CodexAgentBackend, type CodexThreadEvent } from "@chimera/core/backends/codex";
import type { BackendEvent } from "@chimera/core/backend";
import { computeCostUsd, type ModelMetadataLookup } from "@chimera/protocol";
import { fakeCodex, cxSpec, settle } from "./codex-backend-helpers.js";

// DYNAMIC-MODEL-METADATA (codex backend): the constructor's lazy `modelCatalog` accessor is threaded
// into the run's authoritative cost — `computeCostUsd(toCostUsage(cumulativeUsage), effectiveModel,
// this.deps.modelCatalog?.())`. These tests prove that threading: a model ABSENT from protocol's
// hardcoded MODEL_PRICING map ("gpt-5.2-codex-dynamic-pricing") still gets a catalog-priced run
// cost while resolving to the pinned SDK's search-capable gpt-5.2 metadata prefix, and without
// the catalog the same run falls back to 0 (computeCostUsd returns null for an unpriced model).

const SEARCH_CAPABLE_UNPRICED_MODEL = "gpt-5.2-codex-dynamic-pricing";
const catalog: ModelMetadataLookup = {
  contextWindow: () => undefined,
  pricing: (m) => (m === SEARCH_CAPABLE_UNPRICED_MODEL ? { inputPerMTok: 7, outputPerMTok: 21, cachedInputPerMTok: 0.7 } : undefined),
};

const TURN: CodexThreadEvent[] = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "item.completed", item: { id: "i0", type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
];

describe("CodexAgentBackend: modelCatalog-priced run cost (DYNAMIC-MODEL-METADATA)", () => {
  it("uses the injected catalog's pricing for a model absent from the hardcoded map", async () => {
    const { factory } = fakeCodex([TURN]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory, modelCatalog: () => catalog })
      .spawn(cxSpec({ model: SEARCH_CAPABLE_UNPRICED_MODEL }), (e) => evs.push(e), async () => true);
    await settle();
    // 1M fresh input tokens @ $7/MTok (catalog rate) = $7 — derived via the SAME computeCostUsd the
    // backend uses (toCostUsage: cached_input_tokens is a subset of input_tokens, here 0).
    const expected = computeCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, SEARCH_CAPABLE_UNPRICED_MODEL, catalog)!;
    expect(expected).toBeCloseTo(7, 10);
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["costUsd"]).toBeCloseTo(7, 10);
  });

  it("without the catalog, the same unknown-model run reports costUsd 0 (computeCostUsd null → 0 fallback)", async () => {
    const { factory } = fakeCodex([TURN]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory })   // no modelCatalog
      .spawn(cxSpec({ model: SEARCH_CAPABLE_UNPRICED_MODEL }), (e) => evs.push(e), async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["costUsd"]).toBe(0);
  });
});
