import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { NormalizedEvent } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// WD Stage 1 (coverage B7, replay bar): the "events.replay" RPC — the engine-level
// surface over EventLog.replay (range/limit/agentId semantics are pinned in
// events-replay.test.ts; this file pins the RPC contract: param validation, defaults,
// and the local-only agentId rule).

function engine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

function seed(e: Engine, n: number, agentId = "a1"): void {
  for (let i = 0; i < n; i++) e.events.append({ agentId, kind: "status", data: { i } });
}

describe("Engine.handle events.replay (WD Stage 1)", () => {
  it("returns the seeded range seq-ordered, honoring fromSeq/toSeq", async () => {
    const e = engine();
    seed(e, 5);
    const evs = (await e.handle("events.replay", { fromSeq: 2, toSeq: 4 })) as NormalizedEvent[];
    expect(evs.map((x) => x.seq)).toEqual([2, 3, 4]);
    expect(evs.every((x) => x.agentId === "a1")).toBe(true);
  });

  it("filters by a bare local agentId", async () => {
    const e = engine();
    seed(e, 2, "a1");
    seed(e, 2, "a2");
    const evs = (await e.handle("events.replay", { agentId: "a2" })) as NormalizedEvent[];
    expect(evs.map((x) => x.seq)).toEqual([3, 4]);
  });

  it("defaults limit to 500 and accepts {} / missing params", async () => {
    const e = engine();
    seed(e, 3);
    expect(((await e.handle("events.replay", {})) as NormalizedEvent[]).length).toBe(3);
    expect(((await e.handle("events.replay", undefined)) as NormalizedEvent[]).length).toBe(3);
  });

  it("caps limit at 5000 (a larger ask is a protocol error, not a silent clamp)", async () => {
    const e = engine();
    await expect(e.handle("events.replay", { limit: 5001 })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("events.replay", { limit: 0 })).rejects.toMatchObject({ code: "protocol" });
  });

  it("applies limit as a forward window from fromSeq", async () => {
    const e = engine();
    seed(e, 10);
    const evs = (await e.handle("events.replay", { fromSeq: 3, limit: 4 })) as NormalizedEvent[];
    expect(evs.map((x) => x.seq)).toEqual([3, 4, 5, 6]);
  });

  it("rejects an engine-qualified agentId (replay is local-only; the qualified-id router fires first)", async () => {
    // On an unfederated engine the router rejects with "federation is not configured" —
    // either way, a qualified id NEVER reaches the local replay reader.
    await expect(engine().handle("events.replay", { agentId: "studio/w1" }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
