import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, DuplicateMemoryError } from "@chimera/core/memory";

// MEMORY-NO-DUPLICATES: the rule is enforced in the STORE, not in a prompt. An agent cannot
// know what the pool already holds, every agent judges "the same fact" differently, and many of
// them write concurrently — so the only place that can see the collision is the place all the
// writes go through. These tests are the guarantee; the prompt block only explains it.

const store = () => new MemoryStore(mkdtempSync(join(tmpdir(), "chimera-mem-")));

describe("memory.add duplicate refusal", () => {
  it("refuses a REWORDED restatement, not merely an identical string", () => {
    const m = store();
    const first = m.add({ author: "a1", title: "slow boot", text: "the chimera daemon boot stall is caused by the event log integrity scan running synchronously at startup" });
    expect(() => m.add({
      author: "a2",
      text: "the event log integrity scan runs synchronously at startup, which is what causes the chimera daemon boot stall",
    })).toThrow(DuplicateMemoryError);
    // and it hands over the record to edit, so the caller needs no second search
    try {
      m.add({ author: "a2", text: "the event log integrity scan runs synchronously at startup, which is what causes the chimera daemon boot stall" });
    } catch (e) {
      expect((e as DuplicateMemoryError).duplicateOf).toBe(first.id);
      expect((e as Error).message).toContain("memory_edit");
    }
  });

  it("refuses an identical body at ANY length — no threshold needed to know that", () => {
    const m = store();
    m.add({ author: "a1", text: "prod is eu-west-1" });
    expect(() => m.add({ author: "a2", text: "  PROD IS EU-WEST-1  " })).toThrow(DuplicateMemoryError);
  });

  it("does NOT refuse two short notes that merely share words — Jaccard is noise down there", () => {
    const m = store();
    m.add({ author: "a1", text: "deploy the api" });
    expect(() => m.add({ author: "a1", text: "deploy the worker" })).not.toThrow();
  });

  it("does NOT refuse a genuinely different fact that happens to share vocabulary", () => {
    const m = store();
    m.add({ author: "a1", text: "the staging database runs postgres 14 and is restored from a nightly snapshot of production" });
    expect(() => m.add({
      author: "a1",
      text: "the analytics warehouse runs clickhouse and ingests from kafka with a two minute lag on every event stream",
    })).not.toThrow();
  });

  it("allowDuplicate is the deliberate escape — a second copy can only be made on purpose", () => {
    const m = store();
    const first = m.add({ author: "a1", text: "the chimera daemon boot stall is caused by the event log integrity scan running at startup" });
    const second = m.add({
      author: "a1",
      text: "the chimera daemon boot stall is caused by the event log integrity scan running at startup",
      allowDuplicate: true,
    });
    expect(second.id).not.toBe(first.id);
    expect(m.search({ limit: 10 })).toHaveLength(2);
  });

  it("editing the existing record is unobstructed — the path the refusal points at actually works", () => {
    const m = store();
    const first = m.add({ author: "a1", title: "boot", text: "the daemon boot stall comes from the event log integrity scan running at startup" });
    const updated = m.edit(first.id, { text: "the daemon boot stall came from the event log integrity scan; it is deferred since d3f0acb" }, "a2");
    expect(updated.id).toBe(first.id);
    expect(updated.author).toBe("a2");
    expect(m.search({ limit: 10 })).toHaveLength(1);
  });

  it("findDuplicate answers the question WITHOUT writing, so a caller can check first", () => {
    const m = store();
    const first = m.add({ author: "a1", text: "every chimera agent record carries a projectId resolved from its cwd at spawn time" });
    expect(m.findDuplicate("a chimera agent record carries the projectId resolved from its own cwd at spawn time")?.id).toBe(first.id);
    expect(m.findDuplicate("the tauri cockpit renders excalidraw scenes inline as a read only canvas")).toBeNull();
  });
});
