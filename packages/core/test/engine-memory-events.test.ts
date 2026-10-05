import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { MemoryRecord, MemoryStatsResult } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// F36 task 0 (plan §3.4 case 22): engine.ts constructed MemoryStore with `events: undefined`,
// so memory_added never reached the engine's event log in the daemon — this is the regression
// test proving that wiring is fixed. Fails on today's main.

function makeEngine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

describe("Engine memory event wiring (F36 task 0)", () => {
  it("case 22: memory.add through the engine appends memory_added to the engine event log", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "agent-1", text: "capacity alarm lands first" })) as MemoryRecord;

    const own = e.events.tail(`memory:${rec.id}`, 10);
    expect(own.map((ev) => ev.kind)).toEqual(["memory_added"]);
    expect(own[0]!.data).toEqual({ id: rec.id, kind: rec.kind, tags: rec.tags, author: rec.author });
  });

  it("case 23: memory.stats returns a capacity block the cockpit can render", async () => {
    const e = makeEngine();
    await e.handle("memory.add", { author: "agent-1", text: "a note worth keeping" });
    const st = (await e.handle("memory.stats", {})) as MemoryStatsResult;

    // The whole point of capacity is that it is answerable BEFORE anything is lost: a fresh store
    // must report a full, quiet block rather than nothing until the first eviction.
    expect(st.capacity.limit).toBe(10_000);
    expect(st.capacity.total).toBe(st.total);
    expect(st.capacity.fill).toBeCloseTo(st.total / 10_000);
    expect(st.capacity.alarmAt).toBe(0.9);
    expect(st.capacity.alarming).toBe(false);
    expect(st.capacity.pinned).toBe(0);
    // A preview, not the whole ranking — the operator needs to see WHO goes next, not a full-store list.
    expect(st.capacity.nextToEvict.length).toBeLessThanOrEqual(5);
    expect(st.capacity.nextToEvict[0]).toMatchObject({ value: 0, inbound: 0, pinned: false });
  });
});
