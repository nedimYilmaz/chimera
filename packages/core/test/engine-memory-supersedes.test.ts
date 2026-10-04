import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { MemoryGetResult, MemoryRecord } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// F35.1: memory.add/memory.get RPC round-trips for supersedes/supersededBy. The store-level
// logic (chain resolution, rank demotion, immutability) is covered by memory-supersedes.test.ts;
// this file only proves the RPC surface (Engine.handle, the layer memory_add/memory_get actually
// go through) forwards/rejects the same way.

function makeEngine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

describe("Engine.handle memory.* supersedes", () => {
  it("17. memory.add {supersedes} marks the target's supersededBy via the RPC round-trip", async () => {
    const e = makeEngine();
    const old = (await e.handle("memory.add", { author: "a1", text: "prod runs on eu-west-1" })) as MemoryRecord;
    const next = (await e.handle("memory.add", {
      author: "a1", text: "prod runs on eu-central-1", supersedes: old.id,
    })) as MemoryRecord;
    expect(next.supersedes).toBe(old.id);
    const reloaded = (await e.handle("memory.get", { id: old.id })) as MemoryGetResult;
    expect(reloaded.record.supersededBy).toBe(next.id);
  });

  it("18. memory.add {supersedes: unknown} -> code:protocol; superseding an already-superseded target -> code:conflict", async () => {
    const e = makeEngine();
    await expect(
      e.handle("memory.add", { author: "a1", text: "brand new fact", supersedes: "nope-not-real" }),
    ).rejects.toMatchObject({ code: "protocol" });

    const A = (await e.handle("memory.add", { author: "a1", text: "config lives in etcd" })) as MemoryRecord;
    await e.handle("memory.add", { author: "a1", text: "config now lives in consul", supersedes: A.id });
    await expect(
      e.handle("memory.add", { author: "a2", text: "config now lives somewhere else entirely", supersedes: A.id }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("19. memory.get returns a synthetic backlink pointing at the chain tip via the RPC round-trip", async () => {
    const e = makeEngine();
    const A = (await e.handle("memory.add", { author: "a1", text: "release cadence is weekly" })) as MemoryRecord;
    const B = (await e.handle("memory.add", {
      author: "a1", text: "release cadence is now biweekly", supersedes: A.id,
    })) as MemoryRecord;
    const C = (await e.handle("memory.add", {
      author: "a1", text: "release cadence is now monthly", supersedes: B.id,
    })) as MemoryRecord;
    const gotA = (await e.handle("memory.get", { id: A.id })) as MemoryGetResult;
    const tipBacklink = gotA.backlinks.find((bl) => bl.id === C.id);
    expect(tipBacklink).toBeDefined();
  });

  it("20. memory.add rejects a caller-supplied supersededBy — MemoryAddParams is .strict()", async () => {
    const e = makeEngine();
    await expect(
      e.handle("memory.add", { author: "a1", text: "fresh fact, no relation", supersededBy: "bogus" }),
    ).rejects.toMatchObject({ code: "protocol" });
  });
});
