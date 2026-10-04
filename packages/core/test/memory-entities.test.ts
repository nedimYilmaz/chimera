import { describe, it, expect } from "vitest";
import {
  harvestEntities,
  MemoryEntityIndex,
  MAX_ENTITIES_PER_RECORD,
  ENTITY_ORDER_MAX,
} from "@chimera/core/memory-entities";
import type { MemoryRecord } from "@chimera/protocol";

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return { id: "1", author: "ag", text: "", tags: [], kind: "note", treeId: null, taskId: null, createdAt: 0, updatedAt: 0, ...over };
}

describe("harvestEntities", () => {
  it("harvests a repo path, a file:line, a sha, camel/snake/dotted identifiers from one paragraph", () => {
    const text =
      "See packages/core/src/memory.ts:71 and memory-search.ts:23 for rrfFuse and MAX_MEMORY_RECORDS. " +
      "Commit 9f3a2c1 fixed index.queryOrder in docs/superpowers/research/harness-2026-09 today.";
    const ents = harvestEntities(text);
    expect(ents).toContain("packages/core/src/memory.ts:71");
    expect(ents).toContain("memory-search.ts:23");
    expect(ents).toContain("rrffuse");
    expect(ents).toContain("max_memory_records");
    expect(ents).toContain("9f3a2c1");
    expect(ents).toContain("index.queryorder");
    expect(ents).toContain("docs/superpowers/research/harness-2026-09");
  });

  it('rejects prose: "and/or", "read/write", "e.g.", "defaced", "acceded"', () => {
    const text = "This is read/write and/or best effort, e.g. the log looked defaced or acceded to.";
    const ents = harvestEntities(text);
    expect(ents).not.toContain("and/or");
    expect(ents).not.toContain("read/write");
    expect(ents).not.toContain("e.g");
    expect(ents).not.toContain("defaced");
    expect(ents).not.toContain("acceded");
  });

  it("dedupes and preserves first-seen order", () => {
    const text = "rrfFuse is used in rrfFuse and again rrfFuse, then MemoryLinkIndex, then rrfFuse.";
    const ents = harvestEntities(text);
    expect(ents.filter((e) => e === "rrffuse")).toHaveLength(1);
    expect(ents.indexOf("rrffuse")).toBeLessThan(ents.indexOf("memorylinkindex"));
  });

  it("caps at MAX_ENTITIES_PER_RECORD", () => {
    const idents = Array.from({ length: 500 }, (_, i) => `identifier_number_${i}`);
    const text = idents.join(" ");
    const ents = harvestEntities(text);
    expect(ents).toHaveLength(MAX_ENTITIES_PER_RECORD);
  });

  it("truncates the scanned text at HARVEST_MAX_CHARS", () => {
    const padding = "x".repeat(25000);
    const text = `${padding} MyLateIdentifierToken`;
    const ents = harvestEntities(text);
    expect(ents).not.toContain("mylateidentifiertoken");
  });
});

describe("MemoryEntityIndex.order", () => {
  it("returns only positive-overlap ids, IDF-ordered, capped at ENTITY_ORDER_MAX", () => {
    const idx = new MemoryEntityIndex();
    const target = rec({ id: "target", text: "uses MAX_MEMORY_RECORDS in memory.ts" });
    const decoy = rec({ id: "decoy", text: "unrelated prose about the weather" });
    const order = idx.order("MAX_MEMORY_RECORDS", [target, decoy]);
    expect(order).toEqual(["target"]);

    const many = Array.from({ length: ENTITY_ORDER_MAX + 20 }, (_, i) =>
      rec({ id: `r${i}`, text: `SharedEntityToken variant${i}` })
    );
    const bigOrder = idx.order("SharedEntityToken", many);
    expect(bigOrder.length).toBeLessThanOrEqual(ENTITY_ORDER_MAX);
  });

  it("an entity present in every candidate contributes zero and cannot reorder", () => {
    const idx = new MemoryEntityIndex();
    // QA-of-2a1673a4: this case previously used the query "packages/core", which PATH_RE rejects
    // (1 slash, no extension) — qEnts was [] and order() returned on the empty-query guard, so the
    // df === n branch was never reached. Use a path that actually harvests.
    expect(harvestEntities("packages/core/src/a.ts").length).toBeGreaterThan(0);
    const a = rec({ id: "a", text: "packages/core/src/a.ts is where the engine lives" });
    const b = rec({ id: "b", text: "packages/core/src/a.ts also hosts the supervisor" });
    const order = idx.order("packages/core/src/a.ts", [a, b]);
    expect(order).toEqual([]);
  });

  it("a path that ends a sentence harvests without the trailing period", () => {
    // QA-of-2a1673a4: PATH_RE's segment class contains ".", so "…harness-2026-09." was harvested
    // WITH the period — a token the query form of the same path can never produce. For an
    // extensionless directory path there is no FILE_RE fallback, so the signal vanished silently.
    expect(harvestEntities("contract lives in docs/superpowers/research/harness-2026-09."))
      .toContain("docs/superpowers/research/harness-2026-09");
    expect(harvestEntities("see packages/core/src/memory.ts."))
      .toContain("packages/core/src/memory.ts");
    // A real ":line" suffix must survive the strip.
    expect(harvestEntities("see packages/core/src/memory.ts:71.")).toContain("packages/core/src/memory.ts:71");
  });

  it("keeps the longest valid extension: .tsx is not truncated to .ts", () => {
    // QA-of-2a1673a4: the alternation is ordered and was unanchored, so "Component.tsx" harvested
    // as "component.ts" — colliding with a genuinely different file, Component.ts.
    expect(harvestEntities("Component.tsx renders it")).toContain("component.tsx");
    expect(harvestEntities("Component.tsx renders it")).not.toContain("component.ts");
    expect(harvestEntities("config.json holds it")).not.toContain("config.js");
  });

  it("QA-F33-A: a query equal to a kebab tag scores against the tagged record", () => {
    // The generic harvester deliberately never emits kebab (see "still emits no kebab tokens"
    // below) — so this only works if order() separately matches the raw query against tags.
    const idx = new MemoryEntityIndex();
    const tagged = rec({ id: "tagged", text: "unrelated prose", tags: ["harness-2026-09"] });
    const untagged = rec({ id: "untagged", text: "different unrelated prose" });
    expect(idx.order("harness-2026-09", [tagged, untagged])).toEqual(["tagged"]);
  });

  it("QA-F33-A: a namespaced tag also matches on its value part", () => {
    const idx = new MemoryEntityIndex();
    const tagged = rec({ id: "tagged", text: "unrelated prose", tags: ["team:chimera-harness"] });
    const untagged = rec({ id: "untagged", text: "different unrelated prose" });
    expect(idx.order("chimera-harness", [tagged, untagged])).toEqual(["tagged"]);
    expect(idx.order("team:chimera-harness", [tagged, untagged])).toEqual(["tagged"]);
  });

  it("QA-F33-A: a tag shared by every candidate contributes nothing", () => {
    const idx = new MemoryEntityIndex();
    const a = rec({ id: "a", text: "alpha", tags: ["harness-2026-09"] });
    const b = rec({ id: "b", text: "beta", tags: ["harness-2026-09"] });
    expect(idx.order("harness-2026-09", [a, b])).toEqual([]);
  });

  it("still emits no kebab tokens from prose (plan §2.1 decision — do not add kebab to the harvester)", () => {
    const ents = harvestEntities("this is a well-known file-level convention, harness-2026-09 style");
    expect(ents).not.toContain("well-known");
    expect(ents).not.toContain("file-level");
    expect(ents).not.toContain("harness-2026-09");
  });

  it("harvests each record once across two searches; re-harvests only an edited record", () => {
    const idx = new MemoryEntityIndex();
    const a = rec({ id: "a", text: "MemoryLinkIndex lives in memory-links.ts", updatedAt: 1 });
    const b = rec({ id: "b", text: "rrfFuse lives in memory-search.ts", updatedAt: 1 });

    idx.order("MemoryLinkIndex", [a, b]);
    expect(idx.stats().harvests).toBe(2);

    idx.order("rrfFuse", [a, b]);
    expect(idx.stats().harvests).toBe(2);

    const editedA = { ...a, text: "MemoryLinkIndex now also mentions rrfFuse", updatedAt: 2 };
    idx.order("rrfFuse", [editedA, b]);
    expect(idx.stats().harvests).toBe(3);
  });
});
