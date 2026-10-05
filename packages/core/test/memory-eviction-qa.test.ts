import { pruneOverflowForTest } from "./memory-test-helpers.js";
import { describe, it, expect } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, PinCapError } from "../src/memory.js";
import { EventLog } from "../src/events.js";
import { MemoryRecordSchema, type MemoryRecord } from "@chimera/protocol";

// F36 QA (PHASE 6). The landed suite proves the value function and the event plumbing; these are
// the four carry-forward proofs the plan's own tests stop short of: the ADVERSARIAL pin case
// (many maximal unpinned vs one old pinned), a self-granted inbound count, that an archived
// record is actually RESTORABLE (case 13 only proves a line exists), and that the real 1,641-record
// pre-F36 corpus loads and can be pinned without losing a single note.

type Seed = Partial<MemoryRecord> & { id: string; text: string };

function seedStore(seeds: Seed[], opts: { alarmAt?: number; maxRecords?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-qa-"));
  writeFileSync(join(dir, "memory.json"), JSON.stringify({
    records: seeds.map((s, i) => ({
      author: "ag", title: null, folder: null, kind: "note", scope: null, pinned: false,
      tags: [], treeId: null, taskId: null, createdAt: i + 1, updatedAt: i + 1, ...s,
    })),
  }));
  return { dir, events: new EventLog(dir), mem: new MemoryStore(dir, new EventLog(dir), undefined, undefined, opts) };
}

describe("F36 QA: pins under maximal adversarial pressure", () => {
  it("QA-1: one OLD pinned note outlives 20 maximum-value unpinned records", () => {
    // Every unpinned record here is at the ceiling an unpinned record can reach:
    // decision (W_DECISION 5) + inbound at the cap (INBOUND_CAP 10) = 15. The pinned record is the
    // WEAKEST possible pin — a plain note, created first, so insertion order also argues against it.
    const targets = Array.from({ length: 20 }, (_, i) => ({
      id: `H${i}`, title: `High ${i}`, text: `high value decision note ${i}`, kind: "decision" as const,
    }));
    // 64 links per note is the parser's cap, so 10 mentions x 5 targets per linker note.
    const linkers = Array.from({ length: 4 }, (_, k) => ({
      id: `LK${k}`,
      text: Array.from({ length: 5 }, (_, j) => `[[High ${k * 5 + j}]] `.repeat(10)).join(""),
    }));
    const { mem } = seedStore(
      [{ id: "P", title: "Pinned", text: "the oldest note in the store", pinned: true }, ...targets, ...linkers],
      { alarmAt: 0, maxRecords: 1 },
    );

    const order = mem.evictionOrder();
    const byId = new Map(order.map((e) => [e.record.id, e]));
    expect(byId.get("H0")!.inbound).toBe(10);
    expect(byId.get("H0")!.value).toBe(15);                 // the unpinned ceiling
    expect(order[order.length - 1]!.record.id).toBe("P");   // last to go, whatever else is in the store

    // One write -> one prune pass with overflow = size - 1. The pin is the sole survivor.
    mem.edit("P", { text: "the oldest note in the store, revised" });
    pruneOverflowForTest(mem);
    expect(mem.stats().total).toBe(1);
    expect(mem.get("P").record.pinned).toBe(true);
  });
});

describe("F36 QA: inbound is an EARNED signal", () => {
  it("QA-2: a record cannot credit itself by linking to its own title", () => {
    // memory.ts's W_INBOUND comment calls inbound "the only earned signal - another agent chose to
    // reference this note". A self-mention is the one grant that can never be revoked by evicting
    // the linker, because the linker IS the beneficiary; it must not score.
    const { mem } = seedStore([
      { id: "S", title: "Selfie", text: "[[Selfie]] ".repeat(10) + "a note that references itself" },
      { id: "T", title: "Target", text: "an honestly referenced note" },
      { id: "L", text: "[[Target]] ".repeat(10) },
    ]);
    const byId = new Map(mem.evictionOrder().map((e) => [e.record.id, e]));
    expect(byId.get("S")!.inbound).toBe(0);
    expect(byId.get("S")!.value).toBe(0);
    expect(byId.get("T")!.inbound).toBe(10);   // an external referrer still counts, once per mention
  });
});

describe("F36 QA: the archive is a restorable backup, not just a log line", () => {
  it("QA-3: an archived record parses under the strict schema and reloads unchanged", () => {
    const { dir, mem } = seedStore(
      [{ id: "n0", title: "Doomed", text: "the note about to be evicted", folder: "chimera/qa", kind: "decision", tags: ["a"] },
       ...Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, text: `keeper note ${i}`, pinned: true }))],
      { alarmAt: 0, maxRecords: 10 },
    );
    mem.edit("k9", { text: "keeper note nine, revised" });
    pruneOverflowForTest(mem);

    const lines = readFileSync(join(dir, "memory-evicted.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    // The point of archive-before-delete is RECOVERY: the line must be a whole, schema-valid record
    // that can be dropped back into a store without surgery, not a lossy summary.
    const restored = MemoryRecordSchema.parse(JSON.parse(lines[0]!));
    expect(restored.id).toBe("n0");

    const fresh = mkdtempSync(join(tmpdir(), "chimera-mem-qa-restore-"));
    writeFileSync(join(fresh, "memory.json"), JSON.stringify({ records: [restored] }));
    const revived = new MemoryStore(fresh);
    expect(readdirSync(fresh).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(false);
    expect(revived.get("n0").record).toEqual(restored);
  });
});

// The real pre-F36 corpus: 1,641 records written by the pre-F34 schema, so neither `scope` nor
// `pinned` exists on ANY of them. MemoryRecordSchema is .strict() and quarantines the WHOLE file on
// one bad record, so this is the test that says "the zero-migration claim holds on the actual data",
// not on a 3-record synthetic (memory-eviction-events.test.ts case 16). Skips where the fixture is
// absent - see docs/superpowers/research/harness-2026-09/qa/F36.md for the recorded run.
const FIXTURE = join(homedir(), ".chimera", "memory.json.pre-F34");

describe("F36 QA: the real pre-F36 store", () => {
  it.skipIf(!existsSync(FIXTURE))("QA-4: 1,641 legacy records load, default, and evict nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-qa-legacy-"));
    copyFileSync(FIXTURE, join(dir, "memory.json"));   // a COPY: the live store is never touched
    const mem = new MemoryStore(dir);

    expect(readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(false);
    const st = mem.stats();
    expect(st.total).toBe(1641);
    expect(st.capacity.pinned).toBe(0);
    expect(st.capacity.alarming).toBe(false);            // 1641/10000 = 0.164 is below the 0.9 alarm
    expect(st.byScope.reduce((n, x) => n + x.count, 0)).toBe(st.total);
    expect(st.byScope).toEqual([{ scope: null, count: 1641 }]);   // every record is scope null
    for (const hit of mem.search({ limit: 1641 })) expect(hit.record.pinned).toBe(false);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);   // a load evicts nothing

    // The per-scope pin cap is a REFUSAL, never an eviction: pinning inside the one (null) scope
    // that holds all 1,641 records must not cost a single note.
    const ids = mem.search({ limit: 3 }).map((h) => h.record.id);
    for (const id of ids) mem.edit(id, { pinned: true });
    expect(mem.stats().total).toBe(1641);
    expect(mem.stats().capacity.pinned).toBe(3);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);
  }, 120_000);
});

describe("F36 QA: the pin cap refuses, it never evicts", () => {
  it("QA-5: the 51st pin in the null scope throws and costs nothing", () => {
    const { dir, mem } = seedStore(Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`, text: `scopeless note number ${i}`, pinned: i < 50,
    })));
    expect(() => mem.edit("s50", { pinned: true })).toThrow(PinCapError);
    expect(mem.stats().total).toBe(51);
    expect(mem.get("s50").record.pinned).toBe(false);
    expect(existsSync(join(dir, "memory-evicted.jsonl"))).toBe(false);
  });
});
