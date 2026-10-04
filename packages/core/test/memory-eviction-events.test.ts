import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, UnknownMemoryError } from "../src/memory.js";
import { MemoryLinkIndex } from "../src/memory-links.js";
import { EventLog } from "../src/events.js";
import type { MemoryRecord } from "@chimera/protocol";

// F36 (plan §3.2): the capacity ALARM that fires before any loss, plus the eviction events, the
// pre-delete archive and the cost bound of the value-ranked prune() underneath it.
// maxRecords is the test-only constructor seam so this doesn't need 2000 real adds to exercise.
function rig(alarmAt = 0.9, maxRecords = 10) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-pressure-"));
  const events = new EventLog(dir);
  const mem = new MemoryStore(dir, events, undefined, undefined, { alarmAt, maxRecords });
  return { dir, events, mem };
}

// A hand-written over-cap store: prune() runs inside save(), so seeding the file and making ONE
// write buys the same eviction pass a thousand add() calls would, without the O(n^2) snapshot I/O.
function seeded(seeds: Array<Partial<MemoryRecord> & { id: string; text: string }>, maxRecords: number) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-evict-"));
  writeFileSync(join(dir, "memory.json"), JSON.stringify({
    records: seeds.map((s, i) => ({
      author: "ag", title: null, folder: null, kind: "note", scope: null, pinned: false,
      tags: [], treeId: null, taskId: null, createdAt: i + 1, updatedAt: i + 1, ...s,
    })),
  }));
  const events = new EventLog(dir);
  return { dir, events, mem: new MemoryStore(dir, events, undefined, undefined, { alarmAt: 0, maxRecords }) };
}

function pressureEvents(events: EventLog) {
  return events.tail(null, 1000).filter((e) => e.kind === "memory_pressure");
}

function evictedEvents(events: EventLog) {
  return events.tail(null, 5000).filter((e) => e.kind === "memory_evicted");
}

describe("MemoryStore capacity alarm (F36 task 0)", () => {
  it("case 8: the alarm fires before any loss", () => {
    const { events, mem } = rig(0.9, 10);
    let first: string | undefined;
    for (let i = 0; i < 9; i++) {
      const r = mem.add({ author: "t", text: `note ${i}` });
      if (i === 0) first = r.id;
    }
    const alarms = pressureEvents(events);
    expect(alarms).toHaveLength(1);
    // nextToEvict carries its VALUE too: the warning and the eventual loss read the same rank, so
    // an operator can tell "the cheapest note in the store" from "a note that merely arrived first".
    expect(alarms[0]!.data).toEqual({
      total: 9, limit: 10, fill: 0.9, threshold: 0.9,
      nextToEvict: { id: first, title: null, value: 0 },
    });
    expect(mem.stats().total).toBe(9);
    expect(evictedEvents(events)).toHaveLength(0);
  });

  it("case 9: the alarm is edge-triggered and re-arms only below the hysteresis band", () => {
    const { events, mem } = rig(0.9, 10);
    for (let i = 0; i < 9; i++) mem.add({ author: "t", text: `note ${i}` });
    expect(pressureEvents(events)).toHaveLength(1);

    // A 10th add keeps fill >= threshold — already armed=false, so no second alarm.
    mem.add({ author: "t", text: "note 9" });
    expect(pressureEvents(events)).toHaveLength(1);

    // Drop fill to 0.8 (< 0.9 - 0.05 = 0.85) by deleting two records — re-arms.
    const all = mem.search({}).map((s) => s.record.id);
    mem.delete(all[0]!);
    mem.delete(all[1]!);
    expect(mem.stats().total).toBe(8);
    expect(pressureEvents(events)).toHaveLength(1);   // still just the one, re-arm alone fires nothing

    // Crossing the threshold again fires a second, independent alarm.
    mem.add({ author: "t", text: "note 10" });
    expect(pressureEvents(events)).toHaveLength(2);
  });

  it("case 10: alarmAt 0 disables the alarm, but prune still evicts on overflow", () => {
    const { events, mem } = rig(0, 5);
    let first: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = mem.add({ author: "t", text: `note ${i}` });
      if (i === 0) first = r.id;
    }
    expect(pressureEvents(events)).toHaveLength(0);
    expect(mem.stats().total).toBe(5);
    expect(() => mem.get(first!)).toThrow();
  });
});

describe("MemoryStore eviction events and archive (F36 task 1)", () => {
  it("case 11: every eviction emits an event naming the record, lowest VALUE first", () => {
    // The three OLDEST records are decisions and the cheapest three sit in the middle — so an
    // insertion-order prune and a value-ranked prune disagree here, and the assertion picks a side.
    const { events, mem } = seeded([
      { id: "n0", text: "oldest decision note", kind: "decision" },
      { id: "n1", text: "second decision note", kind: "decision" },
      { id: "n2", text: "third decision note", kind: "decision" },
      { id: "n3", text: "cheapest note one", title: "Cheap One", folder: "chimera/x", scope: "alpha" },
      { id: "n4", text: "cheapest note two" },
      { id: "n5", text: "cheapest note three" },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `n${i + 6}`, text: `survivor note ${i}` })),
    ], 10);

    mem.edit("n12", { text: "survivor note six, revised" });   // one write → one prune pass, overflow 3

    const evicted = evictedEvents(events);
    expect(evicted.map((e) => (e.data as { id: string }).id)).toEqual(["n3", "n4", "n5"]);
    expect(evicted[0]!.data).toEqual({
      id: "n3", title: "Cheap One", kind: "note", author: "ag",
      folder: "chimera/x", scope: "alpha", value: 0, inbound: 0, pinned: false, archived: true,
    });
    expect(evicted[0]!.agentId).toBe("memory:n3");
    for (const id of ["n0", "n1", "n2"]) expect(mem.get(id).record.id).toBe(id);   // decisions kept
  });

  it("case 12: a pass over the event cap emits 50 named events plus one summary", () => {
    const { events, mem } = seeded(
      Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, text: `capacity probe number ${i}` })), 10);
    mem.edit("n99", { text: "capacity probe number ninety-nine, revised" });

    const evicted = evictedEvents(events);
    expect(evicted).toHaveLength(51);
    expect(evicted.slice(0, 50).map((e) => (e.data as { id: string }).id))
      .toEqual(Array.from({ length: 50 }, (_, i) => `n${i}`));
    // The withheld count is REPORTED, never silently dropped.
    expect(evicted[50]!.data).toEqual({ truncated: 40, total: 90, archived: true });
    expect(mem.stats().total).toBe(10);
  });

  it("case 13: the evicted record is archived before it is deleted", () => {
    const { dir, mem } = seeded(
      Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, text: `archive probe number ${i}` })), 10);
    mem.edit("n10", { text: "archive probe number ten, revised" });

    const lines = readFileSync(join(dir, "memory-evicted.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "n0", text: "archive probe number 0" });
    expect(() => mem.get("n0")).toThrow(UnknownMemoryError);   // gone from the store, kept on disk
  });

  it("case 14: the archive is capped and rotates oldest-first", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-archive-"));
    const mem = new MemoryStore(dir, undefined, undefined, undefined, { alarmAt: 0, maxRecords: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 506; i++)
      ids.push(mem.add({ author: "t", text: `rotation probe number ${i}`, allowDuplicate: true }).id);

    const lines = readFileSync(join(dir, "memory-evicted.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(500);
    const archived = new Set(lines.map((l) => JSON.parse(l).id as string));
    expect(archived.has(ids[0]!)).toBe(false);      // the 505 evictions overflowed the 500-line cap
    expect(archived.has(ids[504]!)).toBe(true);     // the most recent loss is the one worth reading
  });

  it("case 15: an eviction pass computes inbound counts exactly once", () => {
    const { mem } = seeded(
      Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, text: `cost probe number ${i}` })), 10);
    // alarmAt is 0 in this rig on purpose: checkPressure() also reads evictionOrder(), and its call
    // would be indistinguishable from prune()'s in the spy.
    const spy = vi.spyOn(MemoryLinkIndex.prototype, "resolveAll");
    try {
      mem.edit("n12", { text: "cost probe number twelve, revised" });   // evicts 3 in ONE pass
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      mem.edit("n11", { text: "cost probe number eleven, revised" });   // now at cap → no prune work
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("case 16: a legacy store with no pinned key loads unpinned and is not quarantined", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-legacy-pin-"));
    // The live 2026-09-02 shape: no `pinned` key at all, and 450 records with no title/folder
    // either. MemoryRecordSchema is .strict(), so a non-defaulted addition would rename this file
    // to memory.json.corrupt-* on the next boot and lose 1,641 notes.
    const base = { author: "ag", tags: [] as string[], kind: "note", treeId: null, taskId: null, createdAt: 1, updatedAt: 1 };
    writeFileSync(join(dir, "memory.json"), JSON.stringify({
      records: [
        { ...base, id: "L1", text: "legacy foldered note", folder: "chimera/overnight", title: "Legacy One" },
        { ...base, id: "L2", text: "legacy bare note" },
        { ...base, id: "L3", text: "legacy scoped note", scope: "alpha" },
      ],
    }, null, 2));

    const mem = new MemoryStore(dir);
    expect(readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(false);
    expect(mem.stats().total).toBe(3);
    for (const id of ["L1", "L2", "L3"]) expect(mem.get(id).record.pinned).toBe(false);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);   // a load evicts nothing
  });
});

// F36.FIX (QA finding 4): the hysteresis band alone makes the alarm ONE-SHOT for the store it
// matters most for — one parked at the cap, whose fill can never fall back under the band. These
// pin the two deterministic re-arms that give a long-lived daemon a second (and third) warning.
describe("MemoryStore capacity alarm re-arm (F36.FIX)", () => {
  it("case 17: re-arms every 100 evicted records, so a store parked at the cap keeps warning", () => {
    const { events, mem } = rig(0.8, 5);
    // Adds 1-4 cross the 0.8 threshold (alarm #1). Eviction starts at add 6 and runs one per add,
    // so the 100th loss completes on add 105 and the NEXT save announces alarm #2 — checkPressure()
    // runs before prune(), which is exactly the ordering that keeps a warning ahead of a loss.
    for (let i = 0; i < 106; i++) mem.add({ author: "t", text: `rearm probe number ${i}`, allowDuplicate: true });

    const alarms = pressureEvents(events);
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!.data).toMatchObject({ limit: 5, threshold: 0.8 });
    expect(evictedEvents(events).length).toBeGreaterThan(100);
  });

  it("case 18: a capacity config change re-arms; an identical one does not", () => {
    const { events, mem } = rig(0.9, 10);
    for (let i = 0; i < 9; i++) mem.add({ author: "t", text: `config probe number ${i}`, allowDuplicate: true });
    expect(pressureEvents(events)).toHaveLength(1);

    mem.setCapacity({ alarmAt: 0.9 });        // no effective change → the spent edge stays spent
    mem.add({ author: "t", text: "config probe after a no-op change", allowDuplicate: true });
    expect(pressureEvents(events)).toHaveLength(1);

    // A NEW threshold is a new question about this store, and the old edge answered the old one.
    mem.setCapacity({ alarmAt: 0.5 });
    mem.add({ author: "t", text: "config probe after a real change", allowDuplicate: true });
    const alarms = pressureEvents(events);
    expect(alarms).toHaveLength(2);
    expect(alarms[1]!.data).toMatchObject({ threshold: 0.5, limit: 10 });
  });

  it("case 19: every per-record eviction event says whether the archive write landed", () => {
    const { events, mem } = seeded(
      Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, text: `flag probe number ${i}` })), 10);
    mem.edit("n11", { text: "flag probe number eleven, revised" });   // evicts 2 in one pass

    const evicted = evictedEvents(events);
    expect(evicted).toHaveLength(2);
    for (const e of evicted) expect(e.data["archived"]).toBe(true);
  });
});
