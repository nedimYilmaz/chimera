import { pruneOverflowForTest } from "./memory-test-helpers.js";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore,
  DuplicateMemoryError,
  SupersededTargetError,
  UnknownMemoryError,
  memoryValue,
} from "../src/memory.js";
import { MemoryVectorIndex } from "../src/memory-index.js";
import { demoteSuperseded, type ScoredRecord } from "../src/memory-search.js";
import type { MemoryRecord } from "@chimera/protocol";
import type { EmbeddingProvider } from "../src/memory-embed.js";

// F35: supersedes/supersededBy — a fact can be replaced by a new note that names the old one;
// the old note stays (audit trail) but is demoted in ranking and its readers are redirected.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-supersedes-"));
  return new MemoryStore(dir);
}

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "1", author: "ag", text: "", tags: [], kind: "note", treeId: null, taskId: null,
    createdAt: 0, updatedAt: 0, supersedes: null, supersededBy: null, ...over,
  } as MemoryRecord;
}

describe("MemoryStore.add supersedes", () => {
  it("1. supersede marks the target's supersededBy and stamps the new record's supersedes", () => {
    const m = rig();
    const old = m.add({ author: "a1", text: "prod runs on eu-west-1" });
    const next = m.add({ author: "a1", text: "prod runs on eu-central-1", supersedes: old.id });
    expect(next.supersedes).toBe(old.id);
    const reloaded = m.get(old.id).record;
    expect(reloaded.supersededBy).toBe(next.id);
  });

  it("2. superseding does not change the target's updatedAt or its position in insertion order", () => {
    const m = rig();
    const old = m.add({ author: "a1", text: "the widget uses lithium batteries" });
    const before = old.updatedAt;
    m.add({ author: "a1", text: "the widget uses sodium batteries now", supersedes: old.id });
    const reloaded = m.get(old.id).record;
    expect(reloaded.updatedAt).toBe(before);
    // no-query search sorts by updatedAt desc — the un-touched old record must NOT jump to the top
    const results = m.search({});
    expect(results[0].record.id).not.toBe(old.id);
  });

  it("3. a superseded record can still be the top lexical match, just demoted, not dropped", () => {
    const m = rig();
    const old = m.add({ author: "a1", text: "the gizmo runs at 9 volts exactly" });
    m.add({ author: "a1", text: "totally unrelated filler about kayaks and rivers", supersedes: undefined });
    m.add({ author: "a1", text: "the gizmo now runs at 12 volts exactly", supersedes: old.id });
    const hits = m.search({ query: "gizmo volts" });
    const ids = hits.map((h) => h.record.id);
    expect(ids).toContain(old.id);
    // demoted below the live successor even though it's a strong lexical match
    expect(ids.indexOf(old.id)).toBeGreaterThan(0);
  });

  it("4. demotion also applies with no query (newest-first listing)", () => {
    const m = rig();
    const old = m.add({ author: "a1", text: "note one" });
    const successor = m.add({ author: "a1", text: "note one revised", supersedes: old.id });
    m.add({ author: "a1", text: "note two, unrelated and newer than the successor" });
    const hits = m.search({ limit: 10 });
    const ids = hits.map((h) => h.record.id);
    expect(ids.indexOf(old.id)).toBeGreaterThan(ids.indexOf(successor.id));
  });

  it("5. demotion applies under hybrid/semantic search too", async () => {
    const CONCEPTS = ["dog"] as const;
    const fakeProvider: EmbeddingProvider = {
      id: "fake", model: "fake", dim: CONCEPTS.length,
      async embed(texts) {
        return texts.map((t) => {
          const v = new Float32Array(1);
          if (/dog|canine/i.test(t)) v[0] = 1;
          return v;
        });
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-supersedes-hybrid-"));
    const index = new MemoryVectorIndex(join(dir, "memory-index"), async () => fakeProvider);
    const m = new MemoryStore(dir, undefined, undefined, index);
    const old = m.add({ author: "a1", text: "the dog is friendly" });
    m.add({ author: "a1", text: "the dog is now known to be very friendly", supersedes: old.id });
    await index.flush();
    const hits = await m.searchHybrid({ query: "canine", mode: "semantic", limit: 10 });
    const ids = hits.map((h) => h.record.id);
    expect(ids.indexOf(old.id)).toBeGreaterThan(0);
  });

  it("6. demoteSuperseded is a stable rank shift that preserves within-group order and is identity when nothing is superseded", () => {
    const a: ScoredRecord = { record: rec({ id: "a" }), score: 3 };
    const c: ScoredRecord = { record: rec({ id: "c" }), score: 1 };
    const untouched = [a, c];
    expect(demoteSuperseded(untouched)).toBe(untouched); // identity: nothing superseded is a no-op
    const b: ScoredRecord = { record: rec({ id: "b", supersededBy: "z" }), score: 2 };
    const withSuperseded = [b, a, c];
    const shifted = demoteSuperseded(withSuperseded);
    expect(shifted.map((h) => h.record.id)).toEqual(["a", "c", "b"]);
  });

  it("7. memory_get marks the chain tip via a synthetic backlink, walking multiple hops", () => {
    const m = rig();
    const A = m.add({ author: "a1", text: "release cadence is weekly" });
    const B = m.add({ author: "a1", text: "release cadence is now biweekly", supersedes: A.id });
    const C = m.add({ author: "a1", text: "release cadence is now monthly", supersedes: B.id });
    const gotA = m.get(A.id);
    const tipBacklink = gotA.backlinks.find((bl) => bl.id === C.id);
    expect(tipBacklink).toBeDefined();
    expect(tipBacklink!.snippet).toContain("superseded by this note");
    // the middle record also resolves straight to the tip, not to B
    const gotB = m.get(B.id);
    expect(gotB.backlinks.find((bl) => bl.id === C.id)).toBeDefined();
    // the tip itself carries no such backlink about itself
    const gotC = m.get(C.id);
    expect(gotC.backlinks.find((bl) => bl.id === C.id)).toBeUndefined();
  });

  it("8. duplicate refusal names the existing record, teaches memory_edit, allowDuplicate, and supersedes", () => {
    const m = rig();
    const first = m.add({ author: "a1", text: "the cache TTL is 300 seconds" });
    try {
      m.add({ author: "a2", text: "the cache TTL is 300 seconds" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateMemoryError);
      expect((e as DuplicateMemoryError).duplicateOf).toBe(first.id);
      const msg = (e as Error).message;
      expect(msg).toContain("memory_edit");
      expect(msg).toContain("allowDuplicate");
      expect(msg).toContain("supersedes");
      expect(msg).toContain(first.id);
    }
  });

  it("9. supersedes lets the taught write through WITHOUT allowDuplicate", () => {
    const m = rig();
    const first = m.add({ author: "a1", text: "the cache TTL is 300 seconds" });
    expect(() => m.add({ author: "a2", text: "the cache TTL is 300 seconds", supersedes: first.id })).not.toThrow();
  });

  it("10. supersedes only excuses the duplicate check against the NAMED record, not any other match", () => {
    const m = rig();
    const first = m.add({ author: "a1", text: "the cache TTL is 300 seconds" });
    const unrelated = m.add({ author: "a1", text: "the retry backoff is exponential" });
    // naming `unrelated` doesn't excuse duplicating `first`'s text
    expect(() => m.add({ author: "a2", text: "the cache TTL is 300 seconds", supersedes: unrelated.id })).toThrow(DuplicateMemoryError);
  });

  it("11. superseding an already-superseded record is refused, naming the current tip", () => {
    const m = rig();
    const A = m.add({ author: "a1", text: "config lives in etcd" });
    const B = m.add({ author: "a1", text: "config now lives in consul", supersedes: A.id });
    try {
      m.add({ author: "a2", text: "config now lives somewhere else entirely and not etcd", supersedes: A.id });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SupersededTargetError);
      expect((e as SupersededTargetError).currentId).toBe(B.id);
      expect((e as Error).message).toContain(B.id);
    }
  });

  it("12. superseding an unknown id throws UnknownMemoryError and writes nothing", () => {
    const m = rig();
    expect(() => m.add({ author: "a1", text: "brand new fact, no relation", supersedes: "nope-not-real" })).toThrow(UnknownMemoryError);
    expect(m.search({}).length).toBe(0);
  });

  it("13. the supersedes relation is immutable through edit() — no way to set/change it there", () => {
    const m = rig();
    const A = m.add({ author: "a1", text: "note A" });
    const B = m.add({ author: "a1", text: "note B", supersedes: A.id });
    const edited = m.edit(B.id, { text: "note B, revised" }, "editor-1");
    expect(edited.supersedes).toBe(A.id);
  });

  it("14. supersededBy cannot be supplied by the caller at add time (schema-rejected/ignored input)", () => {
    const m = rig();
    // supersededBy isn't part of MemoryAddInput's public surface; even if a caller smuggles it
    // through, the store computes it itself and a fresh record must start unsuperseded.
    const r = m.add({ author: "a1", text: "fresh fact", ...( { supersededBy: "bogus" } as object) });
    expect(r.supersededBy).toBeNull();
  });

  it("15. deleting the successor un-supersedes and un-demotes the target", () => {
    const m = rig();
    const A = m.add({ author: "a1", text: "the door code is 1234" });
    const B = m.add({ author: "a1", text: "the door code is 5678", supersedes: A.id });
    m.delete(B.id);
    const reloadedA = m.get(A.id).record;
    expect(reloadedA.supersededBy).toBeNull();
    const hits = m.search({ limit: 10 });
    expect(hits[0].record.id).toBe(A.id);
  });

  it("16. a legacy store with no supersession fields loads intact and un-quarantined", () => {
    // Plan §3 case 16 / §6 rollback: MemoryRecordSchema is .strict() and one bad record quarantines
    // the WHOLE memory.json to memory.json.corrupt-* and boots an empty store — the single genuinely
    // destructive path in this feature. The fields must therefore DEFAULT, not be required. A store
    // written by this build cannot prove that, so strip the two keys off the persisted file (the
    // literal pre-F35 on-disk shape) and boot a second store on the same dir.
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-legacy-"));
    const seed = new MemoryStore(dir);
    const ids = ["legacy note one", "legacy note two about kayaks", "legacy note three about volts"]
      .map((text) => seed.add({ author: "a1", text }).id);
    const file = join(dir, "memory.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
    for (const r of raw.records) { delete r["supersedes"]; delete r["supersededBy"]; }
    writeFileSync(file, JSON.stringify(raw, null, 2));

    const reloaded = new MemoryStore(dir);
    expect(reloaded.stats().total).toBe(3);
    expect(readdirSync(dir).filter((f) => f.startsWith("memory.json.corrupt-"))).toEqual([]);
    for (const id of ids) {
      const r = reloaded.get(id).record;
      expect(r.supersedes).toBeNull();
      expect(r.supersededBy).toBeNull();
    }
  });

  // QA F35-3 (carry-forward (c)): F33 rewrote searchHybrid's exit paths, so demotion has to survive
  // on EVERY one of them. Case 5 covers only the semantic exit; these are the lexical and the
  // no-evidence ("neither list produced a hit") exits, reached with no index configured at all.
  it("17. demotion holds on searchHybrid's lexical and no-query exits (no entity/vector evidence)", async () => {
    const m = rig();
    const old = m.add({ author: "a1", text: "the gizmo runs at 9 volts exactly" });
    m.add({ author: "a1", text: "unrelated filler about kayaks and rivers" });
    const succ = m.add({ author: "a1", text: "the gizmo now runs at 12 volts exactly", supersedes: old.id });

    const lexical = (await m.searchHybrid({ query: "gizmo volts", mode: "lexical", limit: 10 })).map((h) => h.record.id);
    expect(lexical).toContain(old.id);
    expect(lexical.indexOf(old.id)).toBeGreaterThan(lexical.indexOf(succ.id));

    // no query at all → the newest-first listing exit, which never touches a ranker
    const listing = (await m.searchHybrid({ limit: 10 })).map((h) => h.record.id);
    expect(listing.indexOf(old.id)).toBeGreaterThan(listing.indexOf(succ.id));

    // hybrid mode with no index: the semantic list is empty, so this lands on the same fallback
    const hybrid = (await m.searchHybrid({ query: "gizmo volts", mode: "hybrid", limit: 10 })).map((h) => h.record.id);
    expect(hybrid.indexOf(old.id)).toBeGreaterThan(hybrid.indexOf(succ.id));
  });

  // QA F35-4 (carry-forward (f)): F36 ranks for EVICTION, F35 ranks for SEARCH, and the two must not
  // be confused — a pinned record that got superseded is still pinned. Demoted, never evicted.
  it("18. a superseded PINNED record is demoted in search but never evicted", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-pin-supersede-"));
    const m = new MemoryStore(dir, undefined, undefined, undefined, { maxRecords: 4 });
    const old = m.add({ author: "a1", text: "the release train departs on tuesdays" });
    m.edit(old.id, { pinned: true }, "op");
    m.add({ author: "a1", text: "the release train departs on thursdays now", supersedes: old.id });
    const letters = "abcdefgh";
    for (let i = 0; i < 6; i++) m.add({ author: "a1", text: `filler ${letters[i]} about quokkas ${i * 7}` });

    expect(m.get(old.id).record.id).toBe(old.id);      // survived every prune pass
    const ids = m.search({ limit: 10 }).map((h) => h.record.id);
    expect(ids).toContain(old.id);
    expect(ids.indexOf(old.id)).toBe(ids.length - 1);  // …and sits last, below every live record
  });

  // QA F35-1 (the bug this QA pass found): prune() used to delete an evicted record straight out of
  // the map, skipping the repair delete() performs. The target kept a supersededBy pointing at a
  // record that no longer exists — permanently rank-shifted, with get() showing no backlink to
  // explain it, because supersessionTip() ends the walk on the dead pointer.
  it("19. evicting the SUCCESSOR un-supersedes its target, exactly as deleting it does", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-evict-supersede-"));
    const m = new MemoryStore(dir, undefined, undefined, undefined, { maxRecords: 4 });
    const old = m.add({ author: "a1", text: "the release train departs on tuesdays" });
    m.edit(old.id, { pinned: true }, "op");   // pin the target so only the successor is evictable
    const succ = m.add({ author: "a1", text: "the release train departs on thursdays now", supersedes: old.id });
    const letters = "abcdefgh";
    for (let i = 0; i < 6; i++) m.add({ author: "a1", text: `filler ${letters[i]} about quokkas ${i * 7}` });

    expect(() => m.get(succ.id)).toThrow();            // the successor really was evicted
    expect(m.get(old.id).record.supersededBy).toBeNull();
    const ids = m.search({ query: "release train tuesdays" }).map((h) => h.record.id);
    expect(ids[0]).toBe(old.id);                       // un-demoted: it is the current fact again
  });

  // F34-2 (QA finding, F34.md §3/§5(a)): the duplicate refusal must also carry the scope hint when
  // the existing record lives in a DIFFERENT scope than the caller's write.
  it("F34-2: duplicate refusal across scopes names the existing record's id AND the scope hint", () => {
    const m = rig();
    const alpha = m.add({ author: "alpha-agent", text: "the build pipeline runs on self-hosted runners", scope: "alpha" });
    try {
      m.add({ author: "beta-agent", text: "the build pipeline runs on self-hosted runners", scope: "beta" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateMemoryError);
      expect((e as DuplicateMemoryError).duplicateOf).toBe(alpha.id);
      const msg = (e as Error).message;
      expect(msg).toContain(alpha.id);
      expect(msg).toContain("scoped to `alpha`");
      expect(msg).toContain('memory_search {scope:"*"}');
    }
  });
});

// ── F35.QA-FIX (qa/F35.md findings B / E / F, plus F34.md's F34-2) ──────────────────────────────
// Each block below pins a POLICY DECISION, not just a behaviour: where the QA report left a choice
// open, the comment records which way it went and why the alternative was refused.

describe("F35-B: supersession is scope-guarded (audience superset)", () => {
  // THE RULE: supersede is allowed only when the new note reaches everyone the old one reaches.
  // A scope-narrowed search returns "that scope PLUS global" (F34), so the successor's audience
  // covers the target's iff the scopes are equal or the WRITER is global. This is deliberately
  // stricter than F35.md proposed — it also refuses scoped → GLOBAL, which would push one
  // project's text into every other project's read of the target via the synthetic backlink.
  it("21. a scoped write cannot supersede a record in ANOTHER scope, and leaves it untouched", () => {
    const m = rig();
    const alpha = m.add({ author: "alpha-agent", text: "credentials rotate every 90 days", scope: "alpha" });
    const before = m.stats().total;
    expect(() => m.add({
      author: "beta-agent", text: "credentials rotate every 30 days", scope: "beta", supersedes: alpha.id,
    })).toThrow(SupersededTargetError);
    // The harm F35-B measured, asserted directly: alpha's record must still be the current fact.
    expect(m.get(alpha.id).record.supersededBy).toBeNull();
    expect(m.stats().total).toBe(before);          // and the refused note was not filed either
  });

  it("22. the refusal is a `conflict` naming both scopes, never the id of a foreign chain tip", () => {
    const m = rig();
    const alpha = m.add({ author: "alpha-agent", text: "the alpha deploy window is 02:00 UTC", scope: "alpha" });
    const tip = m.add({
      author: "alpha-agent", text: "the alpha deploy window moved to 04:00 UTC",
      scope: "alpha", supersedes: alpha.id,
    });
    try {
      m.add({ author: "beta-agent", text: "the beta deploy window is 06:00 UTC", scope: "beta", supersedes: alpha.id });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SupersededTargetError);
      expect((e as SupersededTargetError).code).toBe("conflict");
      const msg = (e as Error).message;
      expect(msg).toContain("scoped to `alpha`");
      expect(msg).toContain("`beta`");
      // The scope check runs BEFORE the already-superseded check on purpose: an across-the-boundary
      // refusal must not hand back the tip's id, the one piece of foreign state that refusal leaks.
      expect(msg).not.toContain(tip.id);
    }
  });

  it("23. a GLOBAL write may supersede a scoped record; a scoped write may not supersede a global one", () => {
    const m = rig();
    const scoped = m.add({ author: "alpha-agent", text: "the alpha cache ttl is 60 seconds", scope: "alpha" });
    // Writer is global ⇒ its audience is everyone, which covers alpha's readers. Allowed.
    const globalSucc = m.add({ author: "ops", text: "the alpha cache ttl is 300 seconds now", supersedes: scoped.id });
    expect(m.get(scoped.id).record.supersededBy).toBe(globalSucc.id);

    const globalRec = m.add({ author: "ops", text: "every service emits otel traces on port 4317" });
    // Writer is scoped ⇒ readers outside beta would never see the replacement. Refused.
    expect(() => m.add({
      author: "beta-agent", text: "every service emits otel traces on port 4318", scope: "beta",
      supersedes: globalRec.id,
    })).toThrow(SupersededTargetError);
    expect(m.get(globalRec.id).record.supersededBy).toBeNull();
    // A global target has no owning scope to defer to, so the refusal must name a reachable exit.
    try {
      m.add({ author: "beta-agent", text: "every service emits otel traces on port 4318", scope: "beta", supersedes: globalRec.id });
    } catch (e) { expect((e as Error).message).toContain("memory_edit"); }
  });

  it("24. same-scope supersession is unaffected, and so is the wildcard-folded global case", () => {
    const m = rig();
    const a = m.add({ author: "a1", text: "the alpha queue drains every 5 minutes", scope: "alpha" });
    const b = m.add({ author: "a2", text: "the alpha queue drains every 2 minutes", scope: "alpha", supersedes: a.id });
    expect(m.get(a.id).record.supersededBy).toBe(b.id);
    // normalizeScope() folds "*" to null, so SCOPE_ALL needs no case of its own — a "*" write is
    // simply a global write, and global may supersede anything.
    const c = m.add({ author: "a3", text: "the alpha queue drains continuously now", scope: "*", supersedes: b.id });
    expect(m.get(b.id).record.supersededBy).toBe(c.id);
  });
});

describe("F34-2: the duplicate refusal only names exits the caller can actually use", () => {
  // THE DECISION (F34.md §5(a) left it open): F34 criterion 8 STANDS — edit() never re-stamps a
  // record's scope for a foreign editor. Option (i) would have moved the record under the second
  // writer, silently changing what every OTHER reader of that scope sees; the stranding F34-2
  // reported is a findability problem in the REFUSAL TEXT, so that is where it is fixed. The
  // message now drops the two exits that do not work across a boundary instead of teaching them.
  const refusalFor = (m: MemoryStore, author: string, text: string, scope?: string): string => {
    try {
      m.add({ author, text, ...(scope !== undefined ? { scope } : {}) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateMemoryError);
      return (e as Error).message;
    }
  };
  const TEXT = "the nightly reindex job runs at 03:00 and takes about twenty minutes";

  it("25. scoped caller vs a dup in a FOREIGN scope: neither memory_edit nor supersedes is offered", () => {
    const m = rig();
    m.add({ author: "alpha-agent", text: TEXT, scope: "alpha" });
    const msg = refusalFor(m, "beta-agent", TEXT, "beta");
    // memory_edit would leave the note in `alpha`, invisible to beta's default search — following
    // that advice is exactly how F34-2's reporter stranded their note. supersedes is refused by
    // the audience-superset rule above. Only the exit that works is named.
    expect(msg).not.toContain("memory_edit");
    expect(msg).not.toContain("supersedes:");
    expect(msg).toContain("allowDuplicate: true");
    expect(msg).toContain('memory_search {scope:"*"}');
  });

  it("26. scoped caller vs a GLOBAL dup: memory_edit is offered, supersedes is not", () => {
    const m = rig();
    m.add({ author: "ops", text: TEXT });
    const msg = refusalFor(m, "beta-agent", TEXT, "beta");
    expect(msg).toContain("memory_edit");        // a global record stays visible to a scoped reader
    expect(msg).not.toContain("supersedes:");    // but scoped → global supersession is refused
  });

  it("27. an UNSCOPED caller vs a scoped dup is offered BOTH exits", () => {
    const m = rig();
    m.add({ author: "alpha-agent", text: TEXT, scope: "alpha" });
    // engine.ts narrows nothing for a caller with no project binding, so it still reads every
    // scope after editing — and being global, its audience covers alpha's, so it may supersede.
    const msg = refusalFor(m, "ops", TEXT);
    expect(msg).toContain("memory_edit");
    expect(msg).toContain("supersedes:");
  });

  it("28. a same-scope refusal still teaches all three exits, and edit() never re-stamps scope", () => {
    const m = rig();
    const dup = m.add({ author: "alpha-agent", text: TEXT, scope: "alpha" });
    const msg = refusalFor(m, "alpha-two", TEXT, "alpha");
    expect(msg).toContain("memory_edit");
    expect(msg).toContain("supersedes:");
    expect(msg).toContain("allowDuplicate: true");
    // Criterion 8, pinned: a foreign editor changes the text and the author, never the scope.
    const edited = m.edit(dup.id, { text: "the nightly reindex job now runs at 05:00 sharp" }, "beta-agent");
    expect(edited.scope).toBe("alpha");
    expect(edited.author).toBe("beta-agent");
  });
});

describe("F35-E: supersession is deliberately NOT an eviction-value term", () => {
  // THE DECISION: the F36 plan's normative weight list is exactly W_PIN / W_DECISION / W_INBOUND
  // (+ INBOUND_CAP) and its formula carries no supersession term, so the two forward-promise
  // comments were wrong, not the code. They were corrected rather than implemented: a superseded
  // record is precisely what answers "why did we change our mind?", and search demotion already
  // charges it for being obsolete. This test pins the DECISION — it passed before the fix too.
  it("29. being superseded does not lower a record's eviction value", () => {
    const live = rec({ id: "live", text: "x" });
    const dead = rec({ id: "dead", text: "x", supersededBy: "live" });
    expect(memoryValue(dead, 0)).toBe(memoryValue(live, 0));
    expect(memoryValue(rec({ id: "d2", kind: "decision", supersededBy: "live" }), 3))
      .toBe(memoryValue(rec({ id: "l2", kind: "decision" }), 3));
  });
});

describe("F35-F: removing a mid-chain record SPLICES, it does not clear", () => {
  // THE FIX: with A→B→C, removing B must leave A superseded by C. Clearing A's back-pointer (the
  // old behaviour) presents a stale fact as current while the newer fact C is still live, and
  // leaves C.supersedes dangling at a dead id so supersessionTip() ends its walk on nothing.
  const chain = (m: MemoryStore) => {
    const a = m.add({ author: "a1", text: "the ledger reconciles on mondays at dawn" });
    const b = m.add({ author: "a1", text: "the ledger reconciles on wednesdays at dawn", supersedes: a.id });
    const c = m.add({ author: "a1", text: "the ledger reconciles on fridays at dawn", supersedes: b.id });
    return { a, b, c };
  };

  it("30. delete(B) from A→B→C repoints A at C and C at A, without bumping updatedAt", () => {
    const m = rig();
    const { a, b, c } = chain(m);
    const aStamp = m.get(a.id).record.updatedAt;
    const cStamp = m.get(c.id).record.updatedAt;

    expect(m.delete(b.id)).toBe(true);
    expect(m.get(a.id).record.supersededBy).toBe(c.id);
    expect(m.get(c.id).record.supersedes).toBe(a.id);
    // updatedAt drives the no-query newest-first order, so a repair must not float either record
    // to the top of every listing — the same reason add()'s forward stamp leaves it alone.
    expect(m.get(a.id).record.updatedAt).toBe(aStamp);
    expect(m.get(c.id).record.updatedAt).toBe(cStamp);
    // A is still obsolete, so it must still rank last: the demotion did not get cleared with B.
    const ids = m.search({ query: "ledger reconciles dawn" }).map((h) => h.record.id);
    expect(ids).toEqual([c.id, a.id]);
  });

  it("31. deleting the LAST successor then hands the fact back — A becomes current again", () => {
    const m = rig();
    const { a, b, c } = chain(m);
    m.delete(b.id);
    m.delete(c.id);      // the dangling-pointer case F35-F flagged as the splice's own follow-on
    expect(m.get(a.id).record.supersededBy).toBeNull();
    const ids = m.search({ query: "ledger reconciles dawn" }).map((h) => h.record.id);
    expect(ids).toEqual([a.id]);
  });

  // Both eviction tests seed a chain through one store, then re-boot on the same dir under a cap
  // the loaded set already breaches — the constructor loads WITHOUT pruning, so the next add()
  // is refused; the private batch primitive below independently exercises chain repair.
  const seedChainOverCap = (tag: string, maxRecords: number) => {
    const dir = mkdtempSync(join(tmpdir(), `chimera-mem-${tag}-`));
    const seed = new MemoryStore(dir);
    const a = seed.add({ author: "a1", text: "the ledger reconciles on mondays at dawn" });
    seed.edit(a.id, { pinned: true }, "op");   // pin A so only its successors are ever evictable
    const b = seed.add({ author: "a1", text: "the ledger reconciles on wednesdays at dawn", supersedes: a.id });
    const c = seed.add({ author: "a1", text: "the ledger reconciles on fridays at dawn", supersedes: b.id });
    return { a, b, c, m: new MemoryStore(dir, undefined, undefined, undefined, { maxRecords }) };
  };

  it("32. eviction repairs the chain the same way delete() does — one victim per pass", () => {
    const { a, b, c, m } = seedChainOverCap("splice-evict", 3);
    m.add({ author: "a1", text: "unrelated filler about quokkas and their tidy burrows" });
    expect(() => m.get(b.id)).toThrow();                 // B evicted; C survives this pass
    expect(m.get(a.id).record.supersededBy).toBe(c.id);  // spliced, not cleared
    expect(m.get(c.id).record.supersedes).toBe(a.id);

    m.add({ author: "a1", text: "another filler about pangolins and their scaly armour" });
    expect(() => m.get(c.id)).toThrow();
    expect(m.get(a.id).record.supersededBy).toBeNull();  // no successor left ⇒ A is current again
  });

  it("33. a pass evicting TWO links of one chain repairs from live state, not its stale snapshot", () => {
    // evictionOrder() snapshots every record BEFORE the first delete, and evicting B rewrites C's
    // `supersedes` from B to A. So C's snapshot is stale by the time its own turn comes: repairing
    // from it looks up the already-deleted B, finds nothing, and silently gives up — leaving
    // A.supersededBy dangling at the evicted C. That is the exact F35-A harm the splice would have
    // reintroduced, and it only reproduces when overflow > 1 puts both links in ONE pass.
    const { a, b, c, m } = seedChainOverCap("splice-evict-pair", 1);
    pruneOverflowForTest(m);
    expect(() => m.get(b.id)).toThrow();
    expect(() => m.get(c.id)).toThrow();
    const survivor = m.get(a.id).record;
    expect(survivor.supersededBy).not.toBe(c.id);        // the dangling pointer, named explicitly
    expect(survivor.supersededBy).toBeNull();
    const ids = m.search({ query: "ledger reconciles dawn" }).map((h) => h.record.id);
    expect(ids[0]).toBe(a.id);                           // un-demoted: it is the current fact again
  });
});
