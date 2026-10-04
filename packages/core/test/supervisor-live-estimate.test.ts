import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { ModelMetadataLookup } from "@chimera/protocol";
import { makeSupervisor } from "./helpers.js";

// DYNAMIC-MODEL-METADATA (supervisor level): a mid-turn "usage" event drives applyLiveEstimate via
// `estimateEffectiveSpendUsd(usageFromRaw(usage), record.spec.model, this.deps.modelCatalog)`. Only
// the pure budget.ts helper was asserted before; this proves the supervisor actually threads its
// injected modelCatalog into that live estimate. A model absent from protocol's hardcoded map
// ("vendor-omega-2") is priced high enough by the catalog that the estimate trips the LIVE budget
// pause — a pause the flat-rate fallback (used when no catalog knows the model) would NOT trigger.

const settle = () => new Promise((r) => setTimeout(r, 40));

// Priced so 100k fresh input tokens ⇒ $100 estimate via the catalog (100_000 / 1e6 * 1000). The
// flat-rate fallback for the same usage is 100_000 * 3/1e6 = $0.30 — under the 0.5 ceiling, so only
// the catalog-priced estimate crosses it. (1M tokens would flat-rate to $3 and pause regardless —
// 100k is deliberately in the window where flat-rate stays under budget but catalog pricing does not.)
const catalog: ModelMetadataLookup = {
  contextWindow: () => undefined,
  pricing: (m) => (m === "vendor-omega-2" ? { inputPerMTok: 1000, outputPerMTok: 1000, cachedInputPerMTok: 1000 } : undefined),
};

// A mid-turn LIVE_CTX_USAGE snapshot (emitted BEFORE any terminal "result"), then park on a send so
// the live pause is observable without the turn's real cost landing and reconciling it.
const USAGE_THEN_PARK: FakeStep[] = [
  { emit: { kind: "usage", data: { usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
  { awaitSend: true },
];

describe("AgentSupervisor: live-estimate cost uses injected catalog pricing", () => {
  it("a mid-turn usage event trips the live budget pause using catalog pricing for a non-hardcoded model", async () => {
    const { sup, events } = makeSupervisor([USAGE_THEN_PARK], undefined, { modelCatalog: catalog });
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", model: "vendor-omega-2", maxBudgetUsd: 0.5 });
    await settle();
    // $1.00 catalog estimate > 0.5 ceiling → applyLiveEstimate pauses the tree (reversible, live).
    expect(sup.treePaused(root.agentId)).toBe(true);
    const breach = events.tail(root.agentId, 50)
      .find((e) => e.kind === "status" && e.data["reason"] === "budget" && e.data["live"] === true);
    expect(breach?.data).toMatchObject({ paused: true, treeId: root.agentId, maxBudgetUsd: 0.5, live: true });
  });

  it("without the catalog, the flat-rate estimate for the same usage stays under budget — no live pause", async () => {
    const { sup, events } = makeSupervisor([USAGE_THEN_PARK]);   // no modelCatalog
    const root = await sup.spawn({ prompt: "root", cwd: "/tmp", account: "main", isolation: "none", model: "vendor-omega-2", maxBudgetUsd: 0.5 });
    await settle();
    expect(sup.treePaused(root.agentId)).toBe(false);
    expect(events.tail(root.agentId, 50).some((e) => e.kind === "status" && e.data["live"] === true)).toBe(false);
  });
});
