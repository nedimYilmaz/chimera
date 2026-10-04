import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";

// F33 (docs/superpowers/research/harness-2026-09/plans/F33-entity-linking-rrf-signal.md):
// through-the-store proof that the entity order fires as searchHybrid's THIRD RRF list even
// with no vector index live — the default deployment shape under VITEST / embedder "off".
// The semantic-mode regression is already covered by memory-hybrid.test.ts; this file never
// touches it.
//
// GUARD for F34/F35/F36, which rewrite searchHybrid after F33: the two "hybrid lifts…" cases and
// "a path ending a sentence still lifts…" below all fail if the entity order stops being passed
// to rrfFuse as its third list. Do not delete them when refactoring that method.

function freshStore(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-entity-"));
  return new MemoryStore(dir);   // no index → cosineOrder is always null
}

describe("F33 entity-linking RRF signal", () => {
  it("lexical baseline: prose decoy outranks the identifier for MAX_MEMORY_RECORDS", () => {
    const store = freshStore();
    // Added first → older → loses the recency tie-break, so only a real ranking signal can lift it.
    const target = store.add({
      author: "t",
      text: "The store enforces MAX_MEMORY_RECORDS as a hard cap on how many records fit in the JSON file.",
    });
    const decoy = store.add({
      author: "t",
      text: "max memory records max memory records max memory records",
    });

    const lexical = store.search({ query: "MAX_MEMORY_RECORDS", limit: 10 });
    expect(lexical[0]?.record.id).toBe(decoy.id);
    expect(lexical.some((s) => s.record.id === target.id)).toBe(true);
  });

  it("hybrid lifts the record that names MAX_MEMORY_RECORDS above the prose decoy", async () => {
    const store = freshStore();
    const target = store.add({
      author: "t",
      text: "The store enforces MAX_MEMORY_RECORDS as a hard cap on how many records fit in the JSON file.",
    });
    store.add({
      author: "t",
      text: "max memory records max memory records max memory records",
    });

    const hybrid = await store.searchHybrid({ query: "MAX_MEMORY_RECORDS", mode: "hybrid", limit: 10 });
    expect(hybrid[0]?.record.id).toBe(target.id);
  });

  it("hybrid lifts the record naming packages/core/src/memory-links.ts over the same-token decoy", async () => {
    const store = freshStore();
    const target = store.add({
      author: "t",
      text:
        "This is a fairly long note about the link index. See packages/core/src/memory-links.ts " +
        "for the implementation, including rationale about incremental maintenance on add/edit/delete.",
    });
    const decoy = store.add({
      author: "t",
      text:
        "packages core src memory links ts packages core src memory links ts engine lives at " +
        "packages/core/src/engine.ts for comparison, also packages core src memory links ts",
    });

    const lexical = store.search({ query: "packages/core/src/memory-links.ts", limit: 10 });
    expect(lexical[0]?.record.id).toBe(decoy.id);

    const hybrid = await store.searchHybrid({
      query: "packages/core/src/memory-links.ts",
      mode: "hybrid",
      limit: 10,
    });
    expect(hybrid[0]?.record.id).toBe(target.id);
  });

  it("hybrid with no entity overlap and no index is deep-equal to search(), scores included", async () => {
    const store = freshStore();
    store.add({ author: "t", text: "See packages/core/src/memory-links.ts and MAX_MEMORY_RECORDS." });
    store.add({ author: "t", text: "camelCaseIdentifier and snake_case_identifier both live here too." });

    // "hello world" harvests zero entities (no path, file, sha, camel, snake, or dotted form) —
    // so entityOrder is [] and, with no index, cosineOrder is null: the "neither" guard fires.
    const lexical = store.search({ query: "hello world", limit: 10 });
    const hybrid = await store.searchHybrid({ query: "hello world", mode: "hybrid", limit: 10 });
    expect(hybrid).toEqual(lexical);
  });

  it("a path ending a sentence still lifts the record that names it", async () => {
    // QA-of-2a1673a4 regression: PATH_RE swallowed the trailing period, so an extensionless
    // directory path at the end of a sentence produced an entity ("…-09.") that the query form
    // could never match — the feature was inert for the single most common way paths appear in
    // prose. Before the fix this asserted decoy-on-top.
    const store = freshStore();
    const target = store.add({
      author: "t",
      text: "The phase contract for this pipeline lives in docs/superpowers/research/harness-2026-09.",
    });
    store.add({
      author: "t",
      text: "docs superpowers research harness 2026 09 docs superpowers research harness 2026 09",
    });

    const q = "docs/superpowers/research/harness-2026-09";
    expect(store.search({ query: q, limit: 10 })[0]?.record.id).not.toBe(target.id);
    const hybrid = await store.searchHybrid({ query: q, mode: "hybrid", limit: 10 });
    expect(hybrid[0]?.record.id).toBe(target.id);
  });

  it("an entity shared by every candidate leaves hybrid deep-equal to search()", async () => {
    // Plan criterion 5, at store level. QA-of-2a1673a4: the unit test for this passed vacuously
    // and the property did NOT hold — idf(df === n) was a small POSITIVE number, and because
    // rrfFuse consumes order rather than magnitude, the resulting all-tied list collapsed to
    // newest-first recency and was fused as a full peer of BM25. Observed: lexical a,c,b became
    // hybrid c,a,b — the strongest BM25 match demoted by a zero-information entity.
    const store = freshStore();
    store.add({ author: "t", allowDuplicate: true, text: "packages/core/src/a.ts alpha alpha alpha alpha alpha" });
    store.add({ author: "t", allowDuplicate: true, text: "packages/core/src/a.ts beta" });
    store.add({ author: "t", allowDuplicate: true, text: "packages/core/src/a.ts alpha gamma" });

    const q = "packages/core/src/a.ts alpha";
    const lexical = store.search({ query: q, limit: 10 });
    const hybrid = await store.searchHybrid({ query: q, mode: "hybrid", limit: 10 });
    expect(hybrid).toEqual(lexical);
  });

  it("QA-F33-A: a query equal to a kebab tag ranks the tagged record above an untagged peer", async () => {
    // QA finding A (docs/superpowers/research/harness-2026-09/qa/F33.md): tags are indexed
    // record-side but the generic query harvester never emits kebab, so before the fix this
    // query scored zero entity evidence. The precise order()/matchQueryTags mechanism is
    // isolated (no LexicalRanker tag-bonus confound) in memory-entities.test.ts; this is the
    // through-the-store end-to-end proof that the wiring reaches searchHybrid.
    const store = freshStore();
    const tagged = store.add({
      author: "t",
      text: "generic unrelated notes about the pipeline",
      tags: ["harness-2026-09"],
    });
    const untagged = store.add({ author: "t", text: "different generic unrelated notes" });

    const hybrid = await store.searchHybrid({ query: "harness-2026-09", mode: "hybrid", limit: 10 });
    expect(hybrid[0]?.record.id).toBe(tagged.id);
    expect(hybrid.some((s) => s.record.id === untagged.id)).toBe(true);
  });

  it("QA-F33-A: a tag shared by every record contributes nothing", async () => {
    const store = freshStore();
    store.add({ author: "t", allowDuplicate: true, text: "alpha alpha alpha alpha alpha", tags: ["harness-2026-09"] });
    store.add({ author: "t", allowDuplicate: true, text: "beta", tags: ["harness-2026-09"] });
    store.add({ author: "t", allowDuplicate: true, text: "alpha gamma", tags: ["harness-2026-09"] });

    const q = "harness-2026-09 alpha";
    const lexical = store.search({ query: q, limit: 10 });
    const hybrid = await store.searchHybrid({ query: q, mode: "hybrid", limit: 10 });
    expect(hybrid).toEqual(lexical);
  });

  it('mode:"lexical" and sync search() are unchanged on an entity-dense corpus', async () => {
    const store = freshStore();
    store.add({ author: "t", text: "packages/core/src/memory.ts defines MemoryStore and MAX_MEMORY_RECORDS." });
    store.add({ author: "t", text: "rrfFuse lives in packages/core/src/memory-search.ts, see memory.search too." });
    store.add({ author: "t", text: "MemoryEntityIndex harvests SNAKE_CASE, camelCase, and a1b2c3d7 sha." });

    const query = "packages/core/src/memory.ts MAX_MEMORY_RECORDS";
    const lexical = store.search({ query, limit: 10 });
    const hybridLexicalMode = await store.searchHybrid({ query, mode: "lexical", limit: 10 });
    expect(hybridLexicalMode).toEqual(lexical);
  });
});
