import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryValue } from "../src/memory.js";
import { EventLog } from "../src/events.js";
import type { MemoryRecord } from "@chimera/protocol";

// F36 §3.1: the VALUE function and the order it induces. Every fixture that needs a pin or a
// specific creation order is hand-written to memory.json rather than built with add(): pinning is
// edit-only by design, and 2,000 real adds cost O(n^2) snapshot I/O to observe one eviction.

type Seed = Partial<MemoryRecord> & { id: string; text: string };

function seedStore(seeds: Seed[], opts: { alarmAt?: number; maxRecords?: number } = {}, events?: EventLog) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-value-"));
  writeFileSync(join(dir, "memory.json"), JSON.stringify({
    records: seeds.map((s, i) => ({
      author: "ag", title: null, folder: null, kind: "note", scope: null, pinned: false,
      tags: [], treeId: null, taskId: null, createdAt: i + 1, updatedAt: i + 1, ...s,
    })),
  }));
  return { dir, mem: new MemoryStore(dir, events ?? new EventLog(dir), undefined, undefined, opts) };
}

function orderIds(mem: MemoryStore): string[] {
  return mem.evictionOrder().map((e) => e.record.id);
}

// 10 records spanning pinned × decision × inbound {0,1,3,13}. A single note may carry up to 64
// [[…]] mentions, so one linker can manufacture an inbound count of 13 without 13 extra records.
const MIXED: Seed[] = [
  { id: "A", title: "Alpha", text: "alpha target note" },                       // inbound 13 → capped 10
  { id: "B", title: "Beta", text: "beta target note", kind: "decision" },       // 5 + 3 = 8
  { id: "C", title: "Gamma", text: "gamma target note" },                       // 3
  { id: "D", text: "delta decision note", kind: "decision" },                   // 5
  { id: "E", title: "Epsilon", text: "epsilon target note" },                   // 1
  { id: "F", text: "zeta plain note" },                                         // 0
  { id: "G", text: "pinned plain note", pinned: true },                         // 1000
  { id: "H", title: "Eta", text: "pinned decision note", kind: "decision", pinned: true },  // 1006
  { id: "L1", text: "[[Alpha]] ".repeat(13) },
  { id: "L2", text: "[[Beta]] [[Beta]] [[Beta]] [[Gamma]] [[Gamma]] [[Gamma]] [[Epsilon]] [[Eta]]" },
];

describe("F36 value-ranked eviction", () => {
  it("case 1: memoryValue applies the named weights", () => {
    const { mem } = seedStore([{ id: "x", text: "a plain note" }]);
    const base = mem.get("x").record;
    expect(memoryValue(base, 0)).toBe(0);
    expect(memoryValue({ ...base, kind: "decision" }, 0)).toBe(5);
    expect(memoryValue(base, 3)).toBe(3);
    expect(memoryValue({ ...base, kind: "decision" }, 3)).toBe(8);
    // A pin outranks the best achievable earned score (W_DECISION + INBOUND_CAP = 15) by two orders
    // of magnitude — but it is a WEIGHT, so it is still a finite number on the same scale.
    expect(memoryValue({ ...base, pinned: true }, 0)).toBeGreaterThanOrEqual(1000);
  });

  it("case 2: eviction order over a mixed fixture is exact and survives a reload", () => {
    const { dir, mem } = seedStore(MIXED);
    const expected = ["F", "L1", "L2", "E", "C", "D", "B", "A", "G", "H"];
    expect(orderIds(mem)).toEqual(expected);
    expect(mem.evictionOrder().map((e) => e.value)).toEqual([0, 0, 0, 1, 3, 5, 8, 10, 1000, 1006]);
    // The order is a pure function of the persisted records, so a cold store agrees with a warm one
    // — the operator's preview cannot drift from what the next boot would actually evict.
    expect(orderIds(new MemoryStore(dir))).toEqual(expected);
  });

  it("case 3: insertion order is the tie-break, so a no-signal corpus is exactly the old FIFO", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-value-fifo-"));
    const mem = new MemoryStore(dir);
    const ids = Array.from({ length: 5 }, (_, i) => mem.add({ author: "t", text: `plain note number ${i}` }).id);
    expect(orderIds(mem)).toEqual(ids);
  });

  it("case 4: a pin outranks every unpinned combination in the fixture", () => {
    const { mem } = seedStore(MIXED);
    const order = mem.evictionOrder();
    const maxUnpinned = Math.max(...order.filter((e) => !e.record.pinned).map((e) => e.value));
    const minPinned = Math.min(...order.filter((e) => e.record.pinned).map((e) => e.value));
    expect(maxUnpinned).toBeLessThan(minPinned);
  });

  it("case 5: inbound is capped, so link spam cannot buy immortality", () => {
    const { mem } = seedStore([
      { id: "T40", title: "Spammed", text: "heavily referenced note" },
      { id: "T10", title: "Referenced", text: "honestly referenced note" },
      { id: "S", text: "[[Spammed]] ".repeat(40) },
      { id: "R", text: "[[Referenced]] ".repeat(10) },
    ]);
    const byId = new Map(mem.evictionOrder().map((e) => [e.record.id, e]));
    expect(byId.get("T40")!.inbound).toBe(40);
    expect(byId.get("T10")!.inbound).toBe(10);
    expect(byId.get("T40")!.value).toBe(byId.get("T10")!.value);
  });

  it("case 6: a store of nothing but pinned records still evicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-value-allpinned-"));
    const events = new EventLog(dir);
    writeFileSync(join(dir, "memory.json"), JSON.stringify({
      records: Array.from({ length: 11 }, (_, i) => ({
        id: `p${i}`, author: "ag", text: `pinned note number ${i}`, title: null, folder: null,
        kind: "note", scope: null, pinned: true, tags: [], treeId: null, taskId: null,
        createdAt: i + 1, updatedAt: i + 1,
      })),
    }));
    const mem = new MemoryStore(dir, events, undefined, undefined, { alarmAt: 0, maxRecords: 10 });
    // An edit is the smallest write that reaches save()->prune() without changing the record count.
    mem.edit("p10", { text: "pinned note number ten, revised" });
    expect(mem.stats().total).toBe(10);
    const evicted = events.tail(null, 100).filter((e) => e.kind === "memory_evicted");
    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.data).toMatchObject({ id: "p0", pinned: true, value: 1000 });
  });

  it("case 7: an edit moves a record to the back of the tie-break", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-value-touch-"));
    const mem = new MemoryStore(dir);
    const ids = Array.from({ length: 3 }, (_, i) => mem.add({ author: "t", text: `plain note number ${i}` }).id);
    mem.edit(ids[0]!, { text: "plain note number zero, revised" });
    expect(orderIds(mem)).toEqual([ids[1], ids[2], ids[0]]);
  });
});
