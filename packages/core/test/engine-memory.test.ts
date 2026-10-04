import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { MemoryGetResult, MemoryGraphResult, MemoryRecord, MemoryStatsResult } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// WS-MEM-WIRING: memory.add/edit/search RPC round-trips through Engine.handle.

function makeEngine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

describe("Engine.handle memory.*", () => {
  it("adds a record, stamping author/kind/tags and defaults", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", {
      author: "agent-1", text: "use bm25 for ranking", tags: ["search"], kind: "decision",
    })) as MemoryRecord;
    expect(rec.author).toBe("agent-1");
    expect(rec.text).toBe("use bm25 for ranking");
    expect(rec.tags).toEqual(["search"]);
    expect(rec.kind).toBe("decision");
    expect(rec.treeId).toBeNull();
    expect(rec.id.length).toBeGreaterThan(0);
  });

  it("edits an existing record and bumps updatedAt", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "a", text: "first" })) as MemoryRecord;
    const edited = (await e.handle("memory.edit", { id: rec.id, text: "second", tags: ["x"] })) as MemoryRecord;
    expect(edited.id).toBe(rec.id);
    expect(edited.text).toBe("second");
    expect(edited.tags).toEqual(["x"]);
    expect(edited.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt);
  });

  it("rejects an unknown id on edit with a protocol-coded error", async () => {
    const e = makeEngine();
    await expect(e.handle("memory.edit", { id: "ghost", text: "x" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("searches with a query and a tag filter", async () => {
    const e = makeEngine();
    await e.handle("memory.add", { author: "a", text: "ranking uses bm25 tf-idf", tags: ["search"] });
    await e.handle("memory.add", { author: "b", text: "unrelated note about queues", tags: ["queue"] });
    const scored = (await e.handle("memory.search", { query: "bm25", tags: ["search"] })) as { record: MemoryRecord; score: number }[];
    expect(scored.length).toBe(1);
    expect(scored[0].record.text).toContain("bm25");
  });

  it("rejects malformed add params (missing text) with a protocol-coded error", async () => {
    const e = makeEngine();
    await expect(e.handle("memory.add", { author: "a" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  // D11: memory.update is the canonical alias for the same edit path, and re-stamps
  // author when the caller passes one — the edit is visible to the very next search()
  // since both write through the same in-memory Map before returning.
  it("memory.update re-stamps author and is visible on the next search", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "agent-1", text: "original note", tags: ["x"] })) as MemoryRecord;
    const updated = (await e.handle("memory.update", { id: rec.id, text: "revised note", author: "agent-2" })) as MemoryRecord;
    expect(updated.text).toBe("revised note");
    expect(updated.author).toBe("agent-2");

    const scored = (await e.handle("memory.search", { query: "revised" })) as { record: MemoryRecord; score: number }[];
    expect(scored[0]!.record.text).toBe("revised note");
    expect(scored[0]!.record.author).toBe("agent-2");
  });

  it("memory.update without an author leaves the original author untouched", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "agent-1", text: "first" })) as MemoryRecord;
    const edited = (await e.handle("memory.update", { id: rec.id, text: "second" })) as MemoryRecord;
    expect(edited.author).toBe("agent-1");
  });

  it("memory.delete is idempotent and removes the record from the next search", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "a", text: "to be deleted", tags: ["gone"] })) as MemoryRecord;
    expect(await e.handle("memory.delete", { id: rec.id })).toEqual({ deleted: true });
    expect(await e.handle("memory.delete", { id: rec.id })).toEqual({ deleted: false });   // second delete: no-op, not an error

    const scored = (await e.handle("memory.search", { tags: ["gone"] })) as unknown[];
    expect(scored).toEqual([]);
  });

  it("memory.delete on an unknown id is a no-op, not an error", async () => {
    const e = makeEngine();
    expect(await e.handle("memory.delete", { id: "ghost" })).toEqual({ deleted: false });
  });

  // MEM-1: title/folder round-trip through the add param schema (defaults leave old callers
  // byte-identical), plus the new memory.get / memory.stats RPCs.
  it("memory.add accepts title/folder and memory.get returns resolved links + backlinks", async () => {
    const e = makeEngine();
    const hub = (await e.handle("memory.add", { author: "a", text: "hub note", title: "Hub", folder: "ops/protocols" })) as MemoryRecord;
    expect(hub.title).toBe("Hub");
    expect(hub.folder).toBe("ops/protocols");

    const linker = (await e.handle("memory.add", { author: "b", text: "see [[Hub]]" })) as MemoryRecord;
    const got = (await e.handle("memory.get", { id: hub.id })) as MemoryGetResult;
    expect(got.record.id).toBe(hub.id);
    expect(got.backlinks.map((bl) => bl.id)).toEqual([linker.id]);

    const linkView = (await e.handle("memory.get", { id: linker.id })) as MemoryGetResult;
    expect(linkView.links[0]).toMatchObject({ resolvedId: hub.id, resolvedTitle: "Hub" });
  });

  it("memory.get rejects an unknown id with a protocol-coded error", async () => {
    const e = makeEngine();
    await expect(e.handle("memory.get", { id: "nope" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("memory.stats returns totals, byFolder and topTags", async () => {
    const e = makeEngine();
    await e.handle("memory.add", { author: "a", text: "x", kind: "decision", folder: "ops", tags: ["t"] });
    await e.handle("memory.add", { author: "a", text: "y", kind: "fact", tags: ["t"] });
    const s = (await e.handle("memory.stats", {})) as MemoryStatsResult;
    expect(s.total).toBe(2);
    expect(s.byKind).toEqual({ decision: 1, fact: 1 });
    expect(s.topTags[0]).toEqual({ tag: "t", count: 2 });
    expect(s.byFolder).toContainEqual({ folder: "ops", count: 1 });
    expect(s.byFolder).toContainEqual({ folder: null, count: 1 });
  });

  it("existing memory.add without title/folder still defaults them to null (byte-identical)", async () => {
    const e = makeEngine();
    const rec = (await e.handle("memory.add", { author: "a", text: "legacy call" })) as MemoryRecord;
    expect(rec.title).toBeNull();
    expect(rec.folder).toBeNull();
  });

  // MEM-2: memory.graph round-trips through the engine dispatch (app-only RPC, no MCP tool).
  it("memory.graph returns nodes/edges incl. ghosts, honoring filters", async () => {
    const e = makeEngine();
    const hub = (await e.handle("memory.add", { author: "a", text: "hub", title: "Hub", folder: "ops" })) as MemoryRecord;
    await e.handle("memory.add", { author: "b", text: `see [[${hub.id}]] and [[Someday]]`, folder: "ops" });

    const g = (await e.handle("memory.graph", { folder: "ops" })) as MemoryGraphResult;
    expect(g.nodes.some((n) => n.id === hub.id)).toBe(true);
    expect(g.nodes.some((n) => n.ghost && n.id === "ghost:someday")).toBe(true);
    expect(g.edges.some((ed) => ed.target === hub.id && ed.kind === "link")).toBe(true);
  });

  it("memory.graph tolerates empty params and semanticEdges", async () => {
    const e = makeEngine();
    await e.handle("memory.add", { author: "a", text: "solo" });
    const g = (await e.handle("memory.graph", { semanticEdges: true })) as MemoryGraphResult;
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});
