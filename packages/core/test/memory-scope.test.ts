import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, SCOPE_ALL, normalizeScope } from "@chimera/core/memory";
import { MemoryEditParams } from "@chimera/protocol";

const MAX_MEMORY_RECORDS = 12;   // explicit small fixture bound

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-scope-"));
  return { dir, mem: new MemoryStore(dir) };
}

// F34 §3.1 case 8: every text is exactly six tokens long, so avgDocLen is 6 whether or not the
// scope filter has removed a record. BM25's length normalization therefore cancels out and the
// ranking is monotone in the "widget" term frequency alone — which is what makes "the surviving
// order equals the unfiltered order" an assertion about the FILTER rather than about IDF luck.
function interleavedCorpus(mem: MemoryStore): { alpha: string; beta: string; global: string } {
  const a = mem.add({ author: "ag", text: "widget widget widget alpha aardvark abacus", scope: "alpha" });
  const b = mem.add({ author: "ag", text: "widget widget beta bravo brisket bramble", scope: "beta" });
  const g = mem.add({ author: "ag", text: "widget gamma golem gopher granite grommet" });
  return { alpha: a.id, beta: b.id, global: g.id };
}

describe("MemoryStore scope (F34)", () => {
  it("add() stamps and normalizes the scope it is given", () => {
    const { mem } = rig();
    expect(mem.add({ author: "ag", text: "padded scope one", scope: " alpha " }).scope).toBe("alpha");
    expect(mem.add({ author: "ag", text: "empty scope two", scope: "" }).scope).toBeNull();
    // The escape token is never a STORED scope: a project literally named "*" cannot smuggle
    // itself into every scope's default result set.
    expect(mem.add({ author: "ag", text: "star scope three", scope: SCOPE_ALL }).scope).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope(null)).toBeNull();
  });

  it("add() with no scope is global", () => {
    const { mem } = rig();
    expect(mem.add({ author: "ag", text: "unscoped note here" }).scope).toBeNull();
  });

  it("edit() preserves scope and cannot set one", () => {
    const { mem } = rig();
    const r = mem.add({ author: "ag", text: "scoped note here", scope: "alpha" });
    const edited = mem.edit(r.id, { text: "revised note there" }, "editor-1");
    expect(edited.scope).toBe("alpha");
    expect(edited.author).toBe("editor-1");
    // Scope is WHERE a note was written; a fact that moved is F35's supersedes, not a re-stamp.
    expect(MemoryEditParams.safeParse({ id: r.id, scope: "beta" }).success).toBe(false);
  });

  it("search with no scope filter returns every scope", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = new Set(mem.search({}).map((h) => h.record.id));
    expect(got).toEqual(new Set([ids.alpha, ids.beta, ids.global]));
  });

  it("search({scope}) returns that scope AND global, never another scope", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = mem.search({ scope: "alpha" }).map((h) => h.record.id);
    // The global record's PRESENCE is the assertion that matters: the default is never
    // (scope) alone, so a cross-project lesson filed globally stays reachable.
    expect(got).toContain(ids.global);
    expect(got).toContain(ids.alpha);
    expect(got).not.toContain(ids.beta);
  });

  it("search({scope:'*'}) is deep-equal to search({})", () => {
    const { mem } = rig();
    interleavedCorpus(mem);
    // Same records, same order, same SCORES — the escape must be the pre-F34 behaviour exactly.
    expect(mem.search({ scope: SCOPE_ALL, query: "widget" })).toEqual(mem.search({ query: "widget" }));
    // QA-F34: normalizeScope folds "" and whitespace to null too, so they are a SECOND, undocumented
    // widening escape. Pinned deliberately — it only ever widens, so it is safe, but a future
    // "reject an empty scope" change would be a behaviour change and should trip here.
    expect(mem.search({ scope: "", query: "widget" })).toEqual(mem.search({ query: "widget" }));
    expect(mem.search({ scope: "   ", query: "widget" })).toEqual(mem.search({ query: "widget" }));
  });

  it("scope matching is case-insensitive, like the folder filter beside it", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = mem.search({ scope: "ALPHA" }).map((h) => h.record.id);
    expect(got).toContain(ids.alpha);
    expect(got).not.toContain(ids.beta);
  });

  it("scope is a filter, not a ranking signal", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const unfiltered = mem.search({ query: "widget" }).map((h) => h.record.id);
    expect(unfiltered).toEqual([ids.alpha, ids.beta, ids.global]);   // beta sits BETWEEN the survivors
    const filtered = mem.search({ query: "widget", scope: "alpha" }).map((h) => h.record.id);
    expect(filtered).toEqual(unfiltered.filter((id) => id !== ids.beta));
  });

  it("stats().byScope counts every scope, global first", () => {
    const { mem } = rig();
    mem.add({ author: "ag", text: "beta note one", scope: "beta" });
    mem.add({ author: "ag", text: "alpha note two", scope: "alpha" });
    mem.add({ author: "ag", text: "alpha note three", scope: "alpha" });
    mem.add({ author: "ag", text: "global note four" });
    expect(mem.stats().byScope).toEqual([
      { scope: null, count: 1 },
      { scope: "alpha", count: 2 },
      { scope: "beta", count: 1 },
    ]);
  });

  // QA-F34, now settled by F36: the capacity cap is value-ranked, and it stays scope-BLIND by
  // design — F36's per-scope cap is on PINS, not on evictions, so no scope gets an eviction quota.
  // Pinned here: stats().byScope is computed AFTER prune and therefore always sums to the live
  // total, and the scope filter still returns (scope + global) on the post-eviction set.
  //
  // Seed a small explicit full store once, then use ordinary adds to verify scope-blind eviction.
  it("the scope filter composes with the value-ranked cap and stats().byScope", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-scope-cap-"));
    const SCOPES = ["alpha", "beta", null];
    const base = { author: "ag", title: null, folder: null, tags: [] as string[], kind: "note", treeId: null, taskId: null };
    writeFileSync(join(dir, "memory.json"), JSON.stringify({
      records: Array.from({ length: MAX_MEMORY_RECORDS }, (_, i) => ({
        ...base, id: `c${i}`, text: `capacity probe number ${i}`, scope: SCOPES[i % 3],
        createdAt: i + 1, updatedAt: i + 1,
      })),
    }));
    const mem = new MemoryStore(dir, undefined, undefined, undefined, { maxRecords: MAX_MEMORY_RECORDS });
    expect(mem.stats().total).toBe(MAX_MEMORY_RECORDS);

    // Two ordinary adds evict one low-value record each, preserving the configured bound.
    mem.add({ author: "ag", text: "the write that trips the cap" });
    mem.add({ author: "ag", text: "a second write exercises eviction across scopes" });
    const st = mem.stats();
    expect(st.total).toBe(MAX_MEMORY_RECORDS);
    // byScope is derived from the SAME post-prune map, so it can never disagree with total —
    // that identity is what makes it a safe input to F36's per-scope cap.
    expect(st.byScope.reduce((n, x) => n + x.count, 0)).toBe(st.total);
    expect(st.byScope[0].scope).toBeNull();

    // Scope-blind eviction: the two oldest (c0 alpha, c1 beta) went, and no scope was protected.
    // Every record here is an unpinned, unlinked note, so all F36 values are 0 and the insertion-
    // order tie-break decides — value ranking degenerates to exactly the old FIFO order.
    const live = new Set(mem.search({ limit: MAX_MEMORY_RECORDS }).map((h) => h.record.id));
    expect(live.has("c0")).toBe(false);
    expect(live.has("c1")).toBe(false);
    expect(live.has("c2")).toBe(true);

    // The filter still holds on the post-eviction set: alpha + global, never beta.
    const scopes = new Set(mem.search({ scope: "alpha", limit: MAX_MEMORY_RECORDS }).map((h) => h.record.scope));
    expect(scopes).toEqual(new Set(["alpha", null]));
  });

  it("scopeMode undefined/'all' is byte-identical to pre-F34-SCOPE-FILTER behaviour", () => {
    const { mem } = rig();
    interleavedCorpus(mem);
    expect(mem.search({ query: "widget", scope: "alpha" })).toEqual(
      mem.search({ query: "widget", scope: "alpha", scopeMode: "all" }),
    );
    expect(mem.search({ query: "widget" })).toEqual(
      mem.search({ query: "widget", scopeMode: "all" }),
    );
  });

  it("scopeMode:'global' keeps only unscoped records, regardless of scope", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = new Set(mem.search({ scopeMode: "global" }).map((h) => h.record.id));
    expect(got).toEqual(new Set([ids.global]));
    // Even a widening `scope` can't smuggle a project record back in once scopeMode narrows further.
    expect(new Set(mem.search({ scope: "alpha", scopeMode: "global" }).map((h) => h.record.id))).toEqual(new Set([ids.global]));
  });

  it("scopeMode:'project' drops unscoped records", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = new Set(mem.search({ scopeMode: "project" }).map((h) => h.record.id));
    expect(got).toEqual(new Set([ids.alpha, ids.beta]));
  });

  it("scopeMode:'project' with a scope name narrows to exactly that project, no global", () => {
    const { mem } = rig();
    const ids = interleavedCorpus(mem);
    const got = new Set(mem.search({ scope: "alpha", scopeMode: "project" }).map((h) => h.record.id));
    expect(got).toEqual(new Set([ids.alpha]));
  });

  it("scopeMode composes with limit: paging is computed AFTER the exact-membership filter", () => {
    const { mem } = rig();
    interleavedCorpus(mem);
    const got = mem.search({ scopeMode: "project", limit: 1 });
    expect(got).toHaveLength(1);
    expect(got[0].record.scope).not.toBeNull();
  });

  it("a legacy store loads with every record global and nothing quarantined", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-scope-legacy-"));
    // The 1,570 live records' exact shape as of 2026-09-02: no `scope` key at all. Since
    // MemoryRecordSchema is .strict(), a field that did NOT default would quarantine this file
    // on the next boot instead of parsing it — which is why `scope` is .nullable().default(null).
    const base = { author: "ag", tags: [] as string[], kind: "note", treeId: null, taskId: null, createdAt: 1, updatedAt: 1 };
    writeFileSync(join(dir, "memory.json"), JSON.stringify({
      records: [
        { ...base, id: "L1", text: "legacy foldered note", folder: "chimera/overnight", title: "Legacy One" },
        { ...base, id: "L2", text: "legacy unfoldered note", folder: null },
        { ...base, id: "L3", text: "legacy titled tagged note", title: "Legacy Three", tags: ["x", "y"] },
        { ...base, id: "S1", text: "already scoped note", scope: "alpha" },
      ],
    }, null, 2));

    const mem = new MemoryStore(dir);
    // Asserted FIRST: if the fixture itself were malformed the store would boot empty, and every
    // assertion below would fail for a reason that has nothing to do with scope.
    expect(readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(false);
    expect(mem.stats().total).toBe(4);
    for (const id of ["L1", "L2", "L3"]) expect(mem.get(id).record.scope).toBeNull();
    expect(mem.get("S1").record.scope).toBe("alpha");
    expect(new Set(mem.search({ scope: "alpha" }).map((h) => h.record.id))).toEqual(new Set(["L1", "L2", "L3", "S1"]));
    expect(new Set(mem.search({ scope: "beta" }).map((h) => h.record.id))).toEqual(new Set(["L1", "L2", "L3"]));
  });
});
