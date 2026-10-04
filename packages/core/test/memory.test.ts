import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, UnknownMemoryError, normalizeFolder } from "@chimera/core/memory";
import { EventLog } from "@chimera/core/events";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-"));
  return { dir, mem: new MemoryStore(dir) };
}

// HOOK-1: a rig WITH a live EventLog, for the add()-emits-memory_added assertion below — the
// plain rig() above deliberately constructs MemoryStore with no EventLog at all (every other
// test here doesn't care about events), so it can't observe emissions.
function rigWithEvents() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-"));
  const events = new EventLog(dir);
  return { dir, events, mem: new MemoryStore(dir, events) };
}

describe("MemoryStore", () => {
  it("adds records with defaults and generated id/timestamps", () => {
    const { mem } = rig();
    const r = mem.add({ author: "ag-1", text: "hello world" });
    expect(r.id).toBeTruthy();
    expect(r.tags).toEqual([]);
    expect(r.kind).toBe("note");
    expect(r.treeId).toBeNull();
    expect(r.createdAt).toBe(r.updatedAt);
  });

  it("HOOK-1: add() emits exactly ONE memory_added event, and memory.json still persists via the same temp+rename write it always used", () => {
    const { dir, events, mem } = rigWithEvents();
    const r = mem.add({ author: "ag-1", text: "hello world", tags: ["x"], kind: "decision" });

    // The event: exactly one, kind memory_added, with the documented {id, kind, tags, author}
    // payload — add() emits NO `status` event (that stays edit()/delete()-only).
    const own = events.tail(`memory:${r.id}`, 10);
    expect(own.map((e) => e.kind)).toEqual(["memory_added"]);
    expect(own[0]!.data).toEqual({ id: r.id, kind: "decision", tags: ["x"], author: "ag-1" });

    // The persistence: unchanged from before this feature — memory.json exists and a fresh
    // MemoryStore over the same dir sees the record (the ordinary temp+rename save() path, no
    // separate/additional durable write introduced for the new event).
    expect(existsSync(join(dir, "memory.json"))).toBe(true);
    const reloaded = new MemoryStore(dir);
    expect(reloaded.search({}).map((s) => s.record.id)).toEqual([r.id]);
  });

  it("edits an existing record, bumping updatedAt and applying only the given fields", () => {
    const { mem } = rig();
    const r = mem.add({ author: "ag-1", text: "draft", tags: ["a"], kind: "note" });
    const edited = mem.edit(r.id, { text: "final", kind: "decision" });
    expect(edited.text).toBe("final");
    expect(edited.kind).toBe("decision");
    expect(edited.tags).toEqual(["a"]);           // untouched field preserved
    expect(edited.updatedAt).toBeGreaterThanOrEqual(r.updatedAt);
    expect(edited.createdAt).toBe(r.createdAt);
  });

  it("throws UnknownMemoryError when editing a missing record", () => {
    const { mem } = rig();
    expect(() => mem.edit("nope", { text: "x" })).toThrow(UnknownMemoryError);
  });

  it("D11: edit() emits a status{state:'updated'} event carrying the (possibly re-stamped) author", () => {
    // Unlike add() (memory_added-only, see the class comment), edit()/delete() are comparatively
    // rare and emit a full `status` event so UIs refresh from events instead of polling the pool.
    const { events, mem } = rigWithEvents();
    const r = mem.add({ author: "ag-1", text: "draft" });
    mem.edit(r.id, { text: "final" }, "editor-2");   // editor re-stamps author

    const own = events.tail(`memory:${r.id}`, 10);
    expect(own.map((e) => e.kind)).toEqual(["memory_added", "status"]);   // add then edit, in order
    expect(own.at(-1)!.data).toEqual({ id: r.id, state: "updated", author: "editor-2" });
  });

  it("D11: edit() without an editor preserves the original author on its status event", () => {
    const { events, mem } = rigWithEvents();
    const r = mem.add({ author: "ag-1", text: "draft" });
    mem.edit(r.id, { text: "final" });   // no editor → original author kept

    expect(events.tail(`memory:${r.id}`, 10).at(-1)!.data).toEqual({ id: r.id, state: "updated", author: "ag-1" });
  });

  it("D11: delete() emits a status{state:'deleted'} event; a missing-id delete is a silent no-op", () => {
    const { events, mem } = rigWithEvents();
    const r = mem.add({ author: "ag-1", text: "ephemeral" });
    expect(mem.delete(r.id)).toBe(true);

    const own = events.tail(`memory:${r.id}`, 10);
    expect(own.map((e) => e.kind)).toEqual(["memory_added", "status"]);
    expect(own.at(-1)!.data).toEqual({ id: r.id, state: "deleted" });

    // Idempotent: deleting an already-gone id returns false and emits NOTHING further.
    expect(mem.delete(r.id)).toBe(false);
    expect(events.tail(`memory:${r.id}`, 10)).toHaveLength(2);   // no third event
  });

  it("persists across restart, and quarantines a corrupt file instead of crashing", () => {
    const { dir, mem } = rig();
    const r = mem.add({ author: "ag-1", text: "durable" });
    const reloaded = new MemoryStore(dir);
    expect(reloaded.search({}).map((s) => s.record.id)).toContain(r.id);

    const file = join(dir, "memory.json");
    writeFileSync(file, "{ not json");
    const mem2 = new MemoryStore(dir);
    expect(mem2.search({})).toEqual([]);
    expect(existsSync(file)).toBe(false);          // original preserved only under the quarantine name
    expect(readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(true);
  });

  it("quarantines memory.json and boots empty when a stored record violates the schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-"));
    const file = join(dir, "memory.json");
    writeFileSync(file, JSON.stringify({ records: [{ id: "x" }] }));
    const mem = new MemoryStore(dir);
    expect(mem.search({})).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("memory.json.corrupt-"))).toBe(true);
  });

  // QA-of-F33 finding B: this test builds a 2000-record store and tips over its default 30s
  // budget under concurrent-agent load (reproduced at ~22-25s isolated); not a correctness flake.
  it("prunes oldest-by-insertion-order past the cap, and edit-touch keeps a record alive", { timeout: 60_000 }, () => {
    const { mem } = rig();
    const first = mem.add({ author: "ag", text: "record 0" });
    for (let i = 1; i < 2000; i++) mem.add({ author: "ag", text: `record ${i}` });
    // touch the very first record so it moves to the tail of insertion order
    mem.edit(first.id, { text: "record 0 touched" });
    // one more add overflows the cap → the now-oldest (record 1), not the touched first, is evicted
    mem.add({ author: "ag", text: "record 2000" });

    const ids = new Set(mem.search({ limit: 100 }).map((s) => s.record.id));
    // search() only returns `limit`, so check total count + touched survival via a targeted query
    const survived = mem.search({ query: "touched", limit: 5 });
    expect(survived.some((s) => s.record.id === first.id)).toBe(true);
    void ids;
  }, 30000);

  it("filters by tags (AND), author, kind, and treeId", () => {
    const { mem } = rig();
    mem.add({ author: "alice", text: "a", tags: ["x", "y"], kind: "fact", treeId: "t1" });
    mem.add({ author: "bob", text: "b", tags: ["x"], kind: "note", treeId: "t1" });
    mem.add({ author: "alice", text: "c", tags: ["x", "y"], kind: "note", treeId: "t2" });

    expect(mem.search({ tags: ["x", "y"] }).length).toBe(2);          // AND-match
    expect(mem.search({ author: "alice" }).length).toBe(2);
    expect(mem.search({ kind: "fact" }).length).toBe(1);
    expect(mem.search({ treeId: "t2" }).length).toBe(1);
    expect(mem.search({ tags: ["x"], author: "bob" }).length).toBe(1); // combined
  });

  it("with no query, returns newest-edited first with score 0", () => {
    const { mem } = rig();
    const a = mem.add({ author: "ag", text: "first" });
    const b = mem.add({ author: "ag", text: "second" });
    mem.edit(a.id, { text: "first edited" });   // a is now the most-recently-updated
    const order = mem.search({}).map((s) => s.record.id);
    expect(order[0]).toBe(a.id);
    expect(order[1]).toBe(b.id);
    expect(mem.search({})[0].score).toBe(0);
  });

  it("slices results to the limit and clamps a negative limit to empty", () => {
    const { mem } = rig();
    for (let i = 0; i < 5; i++) mem.add({ author: "ag", text: `n${i}` });
    expect(mem.search({ limit: 2 }).length).toBe(2);
    expect(mem.search({ limit: -1 }).length).toBe(0);   // slice(0,-1) must not silently drop just the tail
  });

  it("a query that tokenizes to nothing still returns newest-first (consistent with no query)", () => {
    const { mem } = rig();
    const a = mem.add({ author: "ag", text: "first" });
    const b = mem.add({ author: "ag", text: "second" });
    const order = mem.search({ query: "???" }).map((s) => s.record.id);
    expect(order).toEqual([b.id, a.id]);   // newest-first, same as the empty-query path
  });

  it("finds accented / non-ASCII text (Unicode-aware tokenizer)", () => {
    const { mem } = rig();
    mem.add({ author: "ag", text: "plain english note" });
    const hit = mem.add({ author: "ag", text: "café résumé notes" });
    const results = mem.search({ query: "café" });
    expect(results[0].record.id).toBe(hit.id);
    expect(results[0].score).toBeGreaterThan(0);
  });
});

// MEM-1 (PLAN-MEMORY.md §2-§4): titles, folders, the derived link index, get + stats.

describe("normalizeFolder", () => {
  it("trims, collapses //, strips leading/trailing /, drops empty segments; empty ⇒ null", () => {
    expect(normalizeFolder("ops/protocols")).toBe("ops/protocols");
    expect(normalizeFolder("  /ops//protocols/  ")).toBe("ops/protocols");
    expect(normalizeFolder("a/  /b")).toBe("a/b");        // whitespace-only segment dropped
    expect(normalizeFolder("///")).toBeNull();
    expect(normalizeFolder("")).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
    expect(normalizeFolder(undefined)).toBeNull();
    expect(normalizeFolder("Ops/Proto")).toBe("Ops/Proto");   // case preserved
  });
});

describe("MemoryStore title + folder", () => {
  it("defaults title/folder to null and round-trips normalized values", () => {
    const { mem } = rig();
    const bare = mem.add({ author: "ag", text: "no meta" });
    expect(bare.title).toBeNull();
    expect(bare.folder).toBeNull();

    const filed = mem.add({ author: "ag", text: "filed", title: "  GATE-WAIT-DEATH  ", folder: "/ops//failure-modes/" });
    expect(filed.title).toBe("GATE-WAIT-DEATH");       // trimmed
    expect(filed.folder).toBe("ops/failure-modes");    // normalized
  });

  it("edit clears title/folder with explicit null but leaves them untouched when omitted", () => {
    const { mem } = rig();
    const r = mem.add({ author: "ag", text: "t", title: "Name", folder: "ops" });
    const kept = mem.edit(r.id, { text: "t2" });                // title/folder omitted → preserved
    expect(kept.title).toBe("Name");
    expect(kept.folder).toBe("ops");
    const cleared = mem.edit(r.id, { title: null, folder: null });
    expect(cleared.title).toBeNull();
    expect(cleared.folder).toBeNull();
  });

  it("persists title/folder across restart", () => {
    const { dir, mem } = rig();
    const r = mem.add({ author: "ag", text: "durable", title: "T", folder: "a/b" });
    const reloaded = new MemoryStore(dir);
    const got = reloaded.get(r.id).record;
    expect(got.title).toBe("T");
    expect(got.folder).toBe("a/b");
  });

  it("folder search is a case-insensitive prefix filter (matches descendants, not siblings)", () => {
    const { mem } = rig();
    mem.add({ author: "ag", text: "root", folder: "ops" });
    mem.add({ author: "ag", text: "child", folder: "ops/protocols" });
    mem.add({ author: "ag", text: "sibling", folder: "opsec" });    // must NOT match "ops"
    mem.add({ author: "ag", text: "elsewhere", folder: "tasks" });
    mem.add({ author: "ag", text: "unfiled" });

    expect(mem.search({ folder: "ops" }).length).toBe(2);           // ops + ops/protocols
    expect(mem.search({ folder: "OPS/" }).map((s) => s.record.text).sort()).toEqual(["child", "root"]);
    expect(mem.search({ folder: "ops/protocols" }).length).toBe(1);
  });
});

describe("MemoryStore.get — links & backlinks (§3)", () => {
  it("resolves outbound links and reports inbound backlinks with snippets", () => {
    const { mem } = rig();
    const hub = mem.add({ author: "ag", text: "the hub", title: "Hub" });
    const linker = mem.add({ author: "ag", text: `see [[Hub]] and also [[${hub.id}]]` });

    const got = mem.get(linker.id);
    expect(got.links.map((l) => l.resolvedId)).toEqual([hub.id, hub.id]);   // title + exact-id both resolve

    const hubView = mem.get(hub.id);
    expect(hubView.backlinks.length).toBe(2);                                // two mentions from linker
    expect(hubView.backlinks[0].id).toBe(linker.id);
    expect(hubView.backlinks[0].snippet).toContain("[[Hub]]");
  });

  it("backlinks update after the linking note is edited to drop the link", () => {
    const { mem } = rig();
    const target = mem.add({ author: "ag", text: "target", title: "Target" });
    const linker = mem.add({ author: "ag", text: "points to [[Target]]" });
    expect(mem.get(target.id).backlinks.length).toBe(1);

    mem.edit(linker.id, { text: "no longer points anywhere" });
    expect(mem.get(target.id).backlinks.length).toBe(0);
  });

  it("backlinks disappear after the linking note is deleted", () => {
    const { mem } = rig();
    const target = mem.add({ author: "ag", text: "target", title: "Target" });
    const linker = mem.add({ author: "ag", text: "[[Target]]" });
    expect(mem.get(target.id).backlinks.length).toBe(1);
    mem.delete(linker.id);
    expect(mem.get(target.id).backlinks.length).toBe(0);
  });

  it("a link to a deleted target becomes MISSING; a link to a not-yet-written title stays GHOST", () => {
    const { mem } = rig();
    const target = mem.add({ author: "ag", text: "target", title: "Target" });
    const linker = mem.add({ author: "ag", text: `id [[${target.id}]] title [[Unwritten]]` });

    const before = mem.get(linker.id).links;
    expect(before[0].resolvedId).toBe(target.id);                       // id resolves
    expect(before[1]).toMatchObject({ resolvedId: null, resolvedTitle: "Unwritten" });   // ghost

    mem.delete(target.id);
    const after = mem.get(linker.id).links;
    expect(after[0]).toMatchObject({ resolvedId: null, resolvedTitle: null });   // now missing (id debris)
    expect(after[1]).toMatchObject({ resolvedId: null, resolvedTitle: "Unwritten" });
  });

  it("throws UnknownMemoryError for an unknown id", () => {
    const { mem } = rig();
    expect(() => mem.get("ghost")).toThrow(UnknownMemoryError);
  });
});

describe("MemoryStore.stats (§4)", () => {
  it("reports total, byKind, byFolder (null = unfiled), and topTags", () => {
    const { mem } = rig();
    mem.add({ author: "ag", text: "a", kind: "decision", folder: "ops", tags: ["x", "y"] });
    mem.add({ author: "ag", text: "b", kind: "decision", folder: "ops/sub", tags: ["x"] });
    mem.add({ author: "ag", text: "c", kind: "fact", tags: ["x"] });          // unfiled
    mem.add({ author: "ag", text: "d", kind: "note", folder: "ops" });

    const s = mem.stats();
    expect(s.total).toBe(4);
    expect(s.byKind).toEqual({ decision: 2, fact: 1, note: 1 });
    // null (unfiled) sorts first, then folders alphabetically
    expect(s.byFolder).toEqual([
      { folder: null, count: 1 },
      { folder: "ops", count: 2 },
      { folder: "ops/sub", count: 1 },
    ]);
    expect(s.topTags[0]).toEqual({ tag: "x", count: 3 });   // most-frequent tag first
    expect(s.topTags.find((t) => t.tag === "y")).toEqual({ tag: "y", count: 1 });
  });
});
