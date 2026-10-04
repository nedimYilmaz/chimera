import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { MemoryRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// F36 QA (PHASE 6). engine-memory-events.test.ts case 22 proves memory_added reaches the engine's
// EventLog; NOTHING proves it for the two kinds the feature actually adds. memory.ts:327 claims the
// alarm fires "BEFORE prune() so a subscriber always sees the warning ahead of the loss" - that is
// an ORDER claim about the log, and this is the test that holds it to it at the RPC boundary.

// A full store, written before the Engine exists: the store loads it at construction, so ONE
// memory.add crosses the alarm and overflows the cap in a single save().
function fullEngineHome(records: number, opts: { pinned?: number } = {}): string {
  const home = makeEngineHome();
  writeFileSync(join(home, "memory.json"), JSON.stringify({
    records: Array.from({ length: records }, (_, i) => ({
      id: `seed${i}`, author: "ag", text: `seeded corpus entry number ${i}`, title: null, folder: null,
      kind: "note", scope: null, pinned: i < (opts.pinned ?? 0), tags: [], treeId: null, taskId: null,
      createdAt: i + 1, updatedAt: i + 1,
    })),
  }));
  return home;
}

function engineAt(home: string): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

describe("Engine memory capacity wiring (F36 QA)", () => {
  it("QA-6: one add at the cap logs memory_pressure, then memory_evicted, then memory_added", async () => {
    const home = fullEngineHome(2000);
    const e = engineAt(home);
    const rec = (await e.handle("memory.add", {
      author: "agent-1", text: "the straw that broke the bounded store",
    })) as MemoryRecord;

    const kinds = e.events.tail(null, 200).filter((ev) => ev.kind.startsWith("memory_")).map((ev) => ev.kind);
    expect(kinds).toEqual(["memory_pressure", "memory_evicted", "memory_added"]);

    const pressure = e.events.tail(null, 200).find((ev) => ev.kind === "memory_pressure")!;
    expect(pressure.data).toMatchObject({ limit: 2000, threshold: 0.9 });
    const evicted = e.events.tail("memory:seed0", 10).filter((ev) => ev.kind === "memory_evicted");
    expect(evicted).toHaveLength(1);   // the cheapest, oldest seed - addressed by its own record id
    expect(evicted[0]!.data).toMatchObject({ id: "seed0", value: 0, inbound: 0, pinned: false });
    expect(e.events.tail(`memory:${rec.id}`, 10).map((ev) => ev.kind)).toEqual(["memory_added"]);
    expect(existsSync(join(home, "memory-evicted.jsonl"))).toBe(true);   // archived before deleted
  }, 120_000);

  it("QA-7: the pin cap surfaces through Engine.handle as a `conflict` error", async () => {
    // PinCapError sets `code = "conflict"`; engine.ts's error normalization is what turns a thrown
    // store error into an RPC error the MCP client can act on, and it is untested for this class.
    const e = engineAt(fullEngineHome(51, { pinned: 50 }));
    await expect(e.handle("memory.edit", { id: "seed50", pinned: true, author: "agent-1" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(((await e.handle("memory.stats", {})) as { capacity: { pinned: number } }).capacity.pinned).toBe(50);
  }, 60_000);
});
