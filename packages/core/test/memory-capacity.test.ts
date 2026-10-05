import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCapacityError, MemoryStore } from "../src/memory.js";
import { MemoryVectorIndex } from "../src/memory-index.js";
import { MemoryEntityIndex } from "../src/memory-entities.js";
import { MemoryRecordSchema } from "@chimera/protocol";
import { EventLog } from "../src/events.js";

function fixture(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-memory-capacity-"));
  const records = Array.from({ length: count }, (_, i) => MemoryRecordSchema.parse({
    id: `seed${i}`, author: "seed", title: `Entry ${i}`, kind: i === 0 ? "decision" : "fact",
    pinned: i === 0, scope: i % 2 === 0 ? "alpha" : "beta", folder: "capacity/scale", tags: ["scale"],
    text: `MemoryCapacityContract packages/core/src/capacity-${i}.ts\n` +
      `Durable fixture number ${i} keeps scoped knowledge and [[Entry 0]] linked. `.repeat(8),
    createdAt: i + 1, updatedAt: i + 1,
  }));
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ records }));
  return { dir, records };
}

describe("configurable memory capacity", () => {
  it("retains over-cap notes across load, edit, refusal, delete and reload", () => {
    const { dir, records } = fixture(4);
    const events = new EventLog(dir);
    const provider = vi.fn(async () => null);
    const index = new MemoryVectorIndex(join(dir, "memory-index"), provider);
    const store = new MemoryStore(dir, events, undefined, index, { maxRecords: 2 });
    const before = readFileSync(join(dir, "memory.json"), "utf8");
    const eventState = events.tail(null, 100);
    const indexState = index.status(4);
    const linkState = store.get("seed0");
    const graphState = store.graph({});
    const append = vi.spyOn(events, "append");
    const enqueue = vi.spyOn(index, "enqueue");
    const drop = vi.spyOn(index, "drop");
    const linkSet = vi.spyOn(store["links"], "set");
    const linkRemove = vi.spyOn(store["links"], "remove");
    const duplicateCheck = vi.spyOn(store, "findDuplicate");
    for (const text of ["new addition [[Entry 0]]", records[1]!.text]) {
      expect(() => store.add({ author: "agent", scope: "beta", text, supersedes: "seed1" }))
        .toThrow(MemoryCapacityError);
    }
    expect(events.tail(null, 100)).toEqual(eventState);
    expect(index.status(4)).toEqual(indexState);
    expect(store.get("seed0")).toEqual(linkState);
    expect(store.graph({})).toEqual(graphState);
    for (const spy of [append, enqueue, drop, linkSet, linkRemove, duplicateCheck]) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(provider).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "memory.json"), "utf8")).toBe(before);
    expect(store.get("seed1").record.supersededBy).toBeNull();
    store.edit("seed3", { text: "revised over-cap note", pinned: true });
    store.delete("seed2");
    const reloaded = new MemoryStore(dir, undefined, undefined, undefined, { maxRecords: 2 });
    expect(reloaded.stats().capacity).toMatchObject({ total: 3, limit: 2, fill: 1.5 });
    expect(reloaded.get("seed3").record).toMatchObject({ text: "revised over-cap note", scope: "beta", pinned: true });
    expect(events.tail(null, 100).filter((e) => e.kind === "memory_evicted")).toEqual([]);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);
    expect(() => reloaded.add({ author: "agent", text: "still blocked" })).toThrow(MemoryCapacityError);
    reloaded.delete("seed1");
    reloaded.add({ author: "agent", text: "allowed after explicit deletion" });
    expect(reloaded.stats().total).toBe(2);
    expect(reloaded.get("seed0").record.pinned).toBe(true);
  });

  it("updates capacity without writes or loss, and validates the store-level seam", () => {
    const { dir } = fixture(4);
    const store = new MemoryStore(dir);
    expect(store.stats().capacity.limit).toBe(10_000);
    const before = readFileSync(join(dir, "memory.json"), "utf8");
    store.setCapacity({ maxRecords: 1 });
    expect(store.stats().capacity).toMatchObject({ total: 4, limit: 1, fill: 4 });
    expect(readFileSync(join(dir, "memory.json"), "utf8")).toBe(before);
    expect(() => store.add({ author: "agent", text: "blocked" })).toThrow(MemoryCapacityError);
    for (const maxRecords of [0, -1, 1.5, 100_001, NaN, Infinity]) {
      expect(() => store.setCapacity({ maxRecords })).toThrow();
      expect(() => new MemoryStore(dir, undefined, undefined, undefined, { maxRecords })).toThrow();
    }
    expect(store.stats().capacity.limit).toBe(1);
    store.setCapacity({ maxRecords: 5 });
    store.add({ author: "agent", text: "allowed after increase" });
    expect(store.stats().total).toBe(5);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);
  });

  it("loads and searches 10000 linked notes with a warm bounded entity cache", async () => {
    const { dir, records } = fixture(10_000);
    const started = performance.now();
    const store = new MemoryStore(dir);
    const stats = store.stats();
    expect(stats.capacity).toMatchObject({ total: 10_000, limit: 10_000, pinned: 1 });
    expect(stats.byScope).toEqual([{ scope: "alpha", count: 5000 }, { scope: "beta", count: 5000 }]);
    expect(stats.capacity.nextToEvict[0]?.id).toBe("seed1");
    const scoped = store.search({ query: "capacity-9998.ts", scope: "alpha", limit: 3 });
    expect(scoped[0]?.record.id).toBe("seed9998");
    expect(scoped.every((hit) => hit.record.scope === "alpha")).toBe(true);
    const index = new MemoryEntityIndex();
    index.setCapacity(10_000);
    const cold = index.order("MemoryCapacityContract", records);
    // An entity shared by every note has zero IDF; caching must still retain all notes.
    expect(cold).toEqual([]);
    expect(index.stats()).toEqual({ harvests: 10_000, cached: 10_000 });
    expect(index.order("MemoryCapacityContract", records)).toEqual(cold);
    expect(index.stats()).toEqual({ harvests: 10_000, cached: 10_000 });
    expect(index.order("packages/core/src/capacity-9998.ts", records)).toEqual(["seed9998"]);
    expect(index.stats()).toEqual({ harvests: 10_000, cached: 10_000 });
    index.setCapacity(3);
    expect(index.stats().cached).toBe(3);
    await store.searchHybrid({ query: "MemoryCapacityContract", limit: 3 });
    const graph = store.graph({});
    expect(graph.nodes).toHaveLength(10_000);
    expect(graph.edges).toHaveLength(9999);
    // One real save at scale must preserve ranking, archive, links, scopes, pins and persistence.
    store.add({ author: "agent", text: "fresh capacity probe", allowDuplicate: true });
    expect(() => store.get("seed1")).toThrow();
    expect(store.get("seed0").record.pinned).toBe(true);
    const archived = JSON.parse(readFileSync(join(dir, "memory-evicted.jsonl"), "utf8").trim());
    expect(archived).toEqual(records[1]);
    const reloaded = new MemoryStore(dir);
    expect(reloaded.stats().total).toBe(10_000);
    expect(reloaded.get("seed9999").links[0]?.resolvedId).toBe("seed0");
    console.info(`memory 10000-record load/stats/search/cache/graph/save/reload: ${Math.round(performance.now() - started)}ms`);
  }, 30_000);
});
