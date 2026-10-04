import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@chimera/core/memory";
import { MemoryVectorIndex } from "../src/memory-index.js";
import type { EmbeddingProvider } from "../src/memory-embed.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@chimera/protocol";

// MEM-2 (PLAN-MEMORY.md §4): memory.graph nodes/edges over a fixture store, hand-computed.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-graph-"));
  return { dir, mem: new MemoryStore(dir) };
}

// MEM-7: a deterministic fake embedder over a tiny concept space, same shape as memory-hybrid's —
// no model download, no network. Notes sharing a concept word embed close together.
const CONCEPTS = ["dog", "cat", "car"] as const;
const SYNONYMS: Record<string, (typeof CONCEPTS)[number]> = {
  dog: "dog", canine: "dog", puppy: "dog",
  cat: "cat", feline: "cat", kitten: "cat",
  car: "car", automobile: "car", vehicle: "car",
};
function conceptEmbed(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length);
  for (const tok of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const c = SYNONYMS[tok];
    if (c) v[CONCEPTS.indexOf(c)] += 1;
  }
  return v;
}
const fakeProvider: EmbeddingProvider = {
  id: "fake", model: "fake-concepts", dim: CONCEPTS.length,
  async embed(texts) { return texts.map(conceptEmbed); },
};

// Store wired with the fake vector index (mirrors memory-hybrid.test.ts's makeStore).
function rigWithIndex() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-graph-sem-"));
  const index = new MemoryVectorIndex(join(dir, "memory-index"), async () => fakeProvider);
  const mem = new MemoryStore(dir, undefined, undefined, index);
  return { dir, mem, index };
}

function byId(nodes: MemoryGraphNode[]): Map<string, MemoryGraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}
function edge(edges: MemoryGraphEdge[], source: string, target: string): MemoryGraphEdge | undefined {
  return edges.find((e) => e.source === source && e.target === target);
}

describe("MemoryStore.graph", () => {
  it("builds a node per record and a link edge for an id-resolved [[link]]", () => {
    const { mem } = rig();
    const b = mem.add({ author: "a", text: "target note", title: "Target" });
    const a = mem.add({ author: "a", text: `see [[${b.id}]] for details`, title: "Linker" });

    const { nodes, edges } = mem.graph({});
    const map = byId(nodes);
    expect(nodes).toHaveLength(2);
    expect(map.get(a.id)?.label).toBe("Linker");   // label = title when present
    expect(map.get(b.id)?.title).toBe("Target");
    expect(map.get(b.id)?.label).toBe("Target");

    expect(edges).toHaveLength(1);
    const e = edge(edges, a.id, b.id)!;
    expect(e).toMatchObject({ source: a.id, target: b.id, kind: "link", weight: 1 });
    expect(map.get(a.id)?.degree).toBe(1);
    expect(map.get(b.id)?.degree).toBe(1);
    expect(map.get(a.id)?.ghost).toBeUndefined();
  });

  it("resolves a [[Title]] link to the titled record (not a ghost)", () => {
    const { mem } = rig();
    const b = mem.add({ author: "a", text: "the retry doctrine body", title: "Retry Doctrine" });
    const a = mem.add({ author: "a", text: "follows [[retry doctrine]]" });   // case-insensitive title match

    const { nodes, edges } = mem.graph({});
    expect(nodes).toHaveLength(2);   // no ghost node
    expect(edge(edges, a.id, b.id)).toBeDefined();
    expect(nodes.every((n) => n.ghost === undefined)).toBe(true);
  });

  it("emits a ghost node for a dangling [[Title]] link, deduped across sources", () => {
    const { mem } = rig();
    const a = mem.add({ author: "a", text: "todo: write [[Retry Doctrine]]" });
    const b = mem.add({ author: "a", text: "also see [[retry doctrine]]" });   // same title, diff case

    const { nodes, edges } = mem.graph({});
    const ghosts = nodes.filter((n) => n.ghost);
    expect(ghosts).toHaveLength(1);
    const g = ghosts[0];
    expect(g.id).toBe("ghost:retry doctrine");
    expect(g).toMatchObject({ ghost: true, kind: null, folder: null, tags: [], updatedAt: null });
    expect(g.title).toBe("Retry Doctrine");   // first-seen raw target as display
    expect(g.label).toBe("Retry Doctrine");
    // Two source edges into the one ghost ⇒ ghost degree 2.
    expect(edge(edges, a.id, g.id)).toBeDefined();
    expect(edge(edges, b.id, g.id)).toBeDefined();
    expect(g.degree).toBe(2);
  });

  it("excludes a dangling id-form [[link]] (missing debris) — no node, no edge", () => {
    const { mem } = rig();
    const a = mem.add({ author: "a", text: "was [[abcdef1234567890]] once" });   // id-form, no such record

    const { nodes, edges } = mem.graph({});
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(a.id);
    expect(edges).toHaveLength(0);
  });

  it("collapses repeated mentions of the same target into one edge with weight = count", () => {
    const { mem } = rig();
    const b = mem.add({ author: "a", text: "b" });
    const a = mem.add({ author: "a", text: `[[${b.id}]] then again [[${b.id}]]` });

    const { edges } = mem.graph({});
    expect(edges).toHaveLength(1);
    expect(edge(edges, a.id, b.id)?.weight).toBe(2);
  });

  it("skips self-links", () => {
    const { mem } = rig();
    const a = mem.add({ author: "a", text: "placeholder" });
    mem.edit(a.id, { text: `refers to [[${a.id}]] itself` });

    const { nodes, edges } = mem.graph({});
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
    expect(nodes[0].degree).toBe(0);
  });

  it("labels a titleless node with its first non-empty line, truncated to ~40 chars", () => {
    const { mem } = rig();
    const short = mem.add({ author: "a", text: "\n  first real line  \nsecond" });
    const long = mem.add({ author: "a", text: "x".repeat(80) });

    const map = byId(mem.graph({}).nodes);
    expect(map.get(short.id)?.label).toBe("first real line");
    const lbl = map.get(long.id)!.label;
    expect(lbl.endsWith("…")).toBe(true);
    expect([...lbl].length).toBe(40);
  });

  describe("filters mirror search narrowing (edges to filtered-out targets drop)", () => {
    it("filters by kind and drops the edge whose target is excluded", () => {
      const { mem } = rig();
      const note = mem.add({ author: "a", text: "a note", kind: "note" });
      const dec = mem.add({ author: "a", text: `decides against [[${note.id}]]`, kind: "decision" });

      const { nodes, edges } = mem.graph({ kind: "decision" });
      expect(nodes.map((n) => n.id)).toEqual([dec.id]);   // note excluded
      expect(edges).toHaveLength(0);                       // edge to the excluded note dropped
      expect(nodes[0].degree).toBe(0);
    });

    it("filters by folder prefix", () => {
      const { mem } = rig();
      const inOps = mem.add({ author: "a", text: "x", folder: "ops/failure" });
      mem.add({ author: "a", text: "y", folder: "tasks" });

      const ids = mem.graph({ folder: "ops" }).nodes.map((n) => n.id);
      expect(ids).toEqual([inOps.id]);
    });

    it("filters by tags (AND-match)", () => {
      const { mem } = rig();
      const both = mem.add({ author: "a", text: "x", tags: ["red", "blue"] });
      mem.add({ author: "a", text: "y", tags: ["red"] });

      const ids = mem.graph({ tags: ["red", "blue"] }).nodes.map((n) => n.id);
      expect(ids).toEqual([both.id]);
    });
  });

  it("accepts semanticEdges but returns no semantic edges with no vector index configured, never errors", () => {
    const { mem } = rig();
    const b = mem.add({ author: "a", text: "b" });
    mem.add({ author: "a", text: `[[${b.id}]]` });

    const { edges } = mem.graph({ semanticEdges: true });
    expect(edges.every((e) => e.kind === "link")).toBe(true);
  });

  describe("MEM-7: semanticEdges with a live vector index", () => {
    it("adds symmetrized top-neighbor cosine pairs above 0.6 once the index is ready", async () => {
      const { mem, index } = rigWithIndex();
      const dog1 = mem.add({ author: "a", text: "the dog is a loyal companion" });
      const dog2 = mem.add({ author: "a", text: "a loyal canine friend" });
      const car = mem.add({ author: "a", text: "the automobile drives on the road" });
      await index.flush();

      const { edges } = mem.graph({ semanticEdges: true });
      const semantic = edges.filter((e) => e.kind === "semantic");
      expect(semantic).toHaveLength(1);
      const [e] = semantic;
      // symmetrized: source/target order isn't guaranteed, just the unordered pair.
      expect(new Set([e.source, e.target])).toEqual(new Set([dog1.id, dog2.id]));
      expect(e.weight).toBeGreaterThan(0.6);
      expect(semantic.some((s) => s.source === car.id || s.target === car.id)).toBe(false);
    });

    it("counts semantic edges toward node degree", async () => {
      const { mem, index } = rigWithIndex();
      const a = mem.add({ author: "a", text: "the dog is a loyal companion" });
      const b = mem.add({ author: "a", text: "a loyal canine friend" });
      await index.flush();

      const { nodes } = mem.graph({ semanticEdges: true });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      expect(byId.get(a.id)?.degree).toBe(1);
      expect(byId.get(b.id)?.degree).toBe(1);
    });

    it("never errors and omits semantic edges before the index is ready (cold provider, then still building)", async () => {
      const { mem, index } = rigWithIndex();
      mem.add({ author: "a", text: "the dog is a loyal companion" });
      mem.add({ author: "a", text: "a loyal canine friend" });

      // Cold: the provider has never been resolved (status() ⇒ "off") — graph() must not itself
      // trigger a resolution attempt (it only reads status(), never calls ensureProvider()).
      expect(mem.graph({ semanticEdges: true }).edges.every((e) => e.kind === "link")).toBe(true);

      // Resolution kicked (mirroring a prior semantic search having warmed the provider) but the
      // embed queue deliberately NOT drained (no `await index.flush()`) — status() ⇒ "building".
      await index.ensureProvider();
      expect(mem.graph({ semanticEdges: true }).edges.every((e) => e.kind === "link")).toBe(true);
    });

    it("omits semantic edges when semanticEdges is false even with a ready index", async () => {
      const { mem, index } = rigWithIndex();
      mem.add({ author: "a", text: "the dog is a loyal companion" });
      mem.add({ author: "a", text: "a loyal canine friend" });
      await index.flush();

      const { edges } = mem.graph({});
      expect(edges).toHaveLength(0);
    });
  });

  // The <1s acceptance is about the GRAPH BUILD, which we time in isolation below (measured ~4ms
  // for 2000 records). The generous test timeout only accommodates the setup: each add() rewrites
  // the whole growing memory.json, so seeding 2000 records is O(n²) disk I/O that can crawl under
  // concurrent-agent CPU load — that setup cost is not what memory.graph is being measured for.
  // allowDuplicate skips add()'s O(n)-per-call fuzzy-duplicate scan (covered independently by
  // memory-no-duplicates.test.ts) — it isn't what this test measures, and left on it doubles the
  // O(n²) setup cost for no signal.
  it("serializes a 2000-record synthetic store in well under 1s", () => {
    const { mem } = rig();
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      // Chain each note to its predecessor by id + a shared ghost, to exercise real edges.
      const text = i === 0 ? `note ${i}` : `note ${i} → [[${ids[i - 1]}]] see [[Backlog]]`;
      ids.push(mem.add({ author: "a", text, folder: i % 2 === 0 ? "ops" : "tasks", allowDuplicate: true }).id);
    }
    // Best of a few runs so a stray GC pause under load can't fail a genuinely-fast operation.
    let elapsed = Infinity;
    let g = mem.graph({});
    for (let k = 0; k < 3; k++) {
      const start = performance.now();
      g = mem.graph({});
      const json = JSON.stringify(g);
      elapsed = Math.min(elapsed, performance.now() - start);
      expect(json.length).toBeGreaterThan(0);
    }

    expect(g.nodes.length).toBe(2001);       // 2000 records + 1 "Backlog" ghost
    expect(g.edges.length).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(1000);
  }, 30_000);
});
