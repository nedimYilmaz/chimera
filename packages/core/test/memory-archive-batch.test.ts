import { pruneOverflowForTest } from "./memory-test-helpers.js";
import { describe, it, expect, beforeEach, vi } from "vitest";

// F36.FIX (QA findings 5 + 6): the pre-delete archive used to be ONE read+trim+rewrite of the whole
// jsonl PER EVICTED RECORD — quadratic the moment a lowered cap dooms a batch — and its success was
// invisible to the event log. Counting real node:fs calls is the only way to prove the batching;
// isolated in its own file so the vi.mock("node:fs") touches nobody else's module graph.
let archiveWrites = 0;
let failArchiveWrites = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (String(args[0]).endsWith("memory-evicted.jsonl.tmp")) {
        archiveWrites++;
        if (failArchiveWrites) throw new Error("ENOSPC: simulated full disk");
      }
      return actual.writeFileSync(...args);
    },
  };
});

const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { MemoryStore } = await import("@chimera/core/memory");
const { EventLog } = await import("@chimera/core/events");

// An over-cap store on disk: one save() then buys a whole multi-record eviction pass.
function seeded(count: number, maxRecords: number) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-archive-batch-"));
  writeFileSync(join(dir, "memory.json"), JSON.stringify({
    records: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, text: `batch probe number ${i}`, author: "ag", title: null, folder: null,
      kind: "note", scope: null, pinned: false, tags: [], treeId: null, taskId: null,
      createdAt: i + 1, updatedAt: i + 1,
    })),
  }));
  const events = new EventLog(dir);
  return { dir, events, mem: new MemoryStore(dir, events, undefined, undefined, { alarmAt: 0, maxRecords }) };
}

describe("MemoryStore eviction archive (F36.FIX)", () => {
  beforeEach(() => { archiveWrites = 0; failArchiveWrites = false; });

  it("writes the archive ONCE per eviction pass, not once per evicted record", () => {
    const { dir, mem } = seeded(30, 10);
    mem.edit("n29", { text: "batch probe number twenty-nine, revised" });   // dooms 20 in one pass
    pruneOverflowForTest(mem);

    expect(archiveWrites).toBe(1);
    const lines = readFileSync(join(dir, "memory-evicted.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(20);                      // every victim is still archived
    expect(lines.map((l) => JSON.parse(l).id as string)).toContain("n0");
    expect(mem.stats().total).toBe(10);
  });

  // F36.FIX item 2 — the plan's `archived` semantics are "the archive is a black box, not a second
  // store": an evicted record leaves `records` entirely, so search/get/stats simply cannot see it.
  // Pinned here because the QA read of the plan expected a per-record flag that no schema has.
  it("an archived record is gone from search/get — the archive is not a search surface", () => {
    const { dir, mem } = seeded(30, 10);
    mem.edit("n29", { text: "batch probe number twenty-nine, revised" });
    pruneOverflowForTest(mem);

    const live = new Set(mem.search({ limit: 100 }).map((s) => s.record.id));
    const archived = readFileSync(join(dir, "memory-evicted.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l).id as string);
    expect(archived.length).toBe(20);
    for (const id of archived) {
      expect(live.has(id)).toBe(false);
      expect(() => mem.get(id)).toThrow();
    }
    expect(live.size).toBe(10);
    expect(mem.stats().total).toBe(10);
  });

  it("a failed archive write is reported on the event, and never breaks the store", () => {
    const { dir, events, mem } = seeded(12, 10);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failArchiveWrites = true;
    try {
      mem.edit("n11", { text: "batch probe number eleven, revised" });
    pruneOverflowForTest(mem);
    } finally {
      warn.mockRestore();
    }

    const evicted = events.tail(null, 100).filter((e) => e.kind === "memory_evicted");
    expect(evicted).toHaveLength(2);
    // The honest answer, not the contract's optimistic one: the safety net tore.
    for (const e of evicted) expect(e.data["archived"]).toBe(false);
    // memory.json is the product — a full disk takes the archive, never the add.
    expect(mem.stats().total).toBe(10);
    expect(JSON.parse(readFileSync(join(dir, "memory.json"), "utf8")).records).toHaveLength(10);
  });
});
