import { describe, it, expect } from "vitest";
import {
  MemoryGetParams,
  MemoryGetResult,
  MemoryStatsParams,
  MemoryStatsResult,
  MemoryGraphParams,
  MemoryGraphNodeSchema,
  MemoryGraphEdgeSchema,
  MemoryGraphResult,
  MemoryCapacitySchema,
  MemoryEvictionCandidateSchema,
  MemoryRecordSchema,
} from "@chimera/protocol";

// MEM-1/MEM-2: the memory.get / memory.stats / memory.graph schemas. protocol-memory.test.ts covers
// the record + add/edit/search/index surface; this file covers the get/stats/graph read models (the
// app-only folder-rail counts and the force-directed graph nodes/edges) so every memory.* schema has
// at least one parse + one strict-rejection assertion.

describe("MemoryGetParams / MemoryGetResult (MEM-1)", () => {
  it("requires a non-empty id and rejects extras (strict)", () => {
    expect(MemoryGetParams.parse({ id: "m1" })).toEqual({ id: "m1" });
    expect(() => MemoryGetParams.parse({ id: "" })).toThrow();
    expect(() => MemoryGetParams.parse({})).toThrow();
    expect(() => MemoryGetParams.parse({ id: "m1", bogus: true })).toThrow();
  });

  it("parses a record with resolved links and backlinks", () => {
    const r = MemoryGetResult.parse({
      record: { id: "m1", author: "a1", text: "see [[m2]]", createdAt: 1, updatedAt: 2 },
      links: [{ target: "m2", resolvedId: "m2", resolvedTitle: null }],
      backlinks: [{ id: "m0", title: "Intro", kind: "note", folder: "ops", snippet: "…see [[m1]]…" }],
    });
    expect(r.links[0].resolvedId).toBe("m2");
    expect(r.backlinks[0].kind).toBe("note");
    // The nested record schema still applies its own defaults.
    expect(r.record.tags).toEqual([]);
  });

  it("encodes a ghost link (resolvedId null, resolvedTitle set) and a missing link (both null)", () => {
    const r = MemoryGetResult.parse({
      record: { id: "m1", author: "a1", text: "t", createdAt: 1, updatedAt: 2 },
      links: [
        { target: "Runbook", resolvedId: null, resolvedTitle: "Runbook" },
        { target: "deadid", resolvedId: null, resolvedTitle: null },
      ],
      backlinks: [],
    });
    expect(r.links[0].resolvedTitle).toBe("Runbook");
    expect(r.links[1].resolvedId).toBeNull();
  });

  it("rejects an unknown key on a link (strict)", () => {
    expect(() => MemoryGetResult.parse({
      record: { id: "m1", author: "a1", text: "t", createdAt: 1, updatedAt: 2 },
      links: [{ target: "x", resolvedId: null, resolvedTitle: null, bogus: 1 }],
      backlinks: [],
    })).toThrow();
  });
});

describe("MemoryStatsParams / MemoryStatsResult (MEM-1)", () => {
  it("takes an empty params object and rejects any key (strict)", () => {
    expect(MemoryStatsParams.parse({})).toEqual({});
    expect(() => MemoryStatsParams.parse({ folder: "ops" })).toThrow();
  });

  it("parses totals with unfiled-null folder counts and top tags", () => {
    const r = MemoryStatsResult.parse({
      total: 3,
      byKind: { note: 2, decision: 1 },
      byFolder: [{ folder: null, count: 1 }, { folder: "ops", count: 2 }],
      // F34: byScope mirrors byFolder — null ⇒ global (every pre-F34 record).
      byScope: [{ scope: null, count: 2 }, { scope: "alpha", count: 1 }],
      topTags: [{ tag: "auth", count: 2 }, { tag: "infra", count: 1 }],
      // F36: REQUIRED — core always produces it, so a UI never has to guess a fallback.
      capacity: {
        limit: 2000, total: 3, fill: 0.0015, alarmAt: 0.9, alarming: false, pinned: 1,
        nextToEvict: [{ id: "m9", title: null, kind: "note", value: 0, inbound: 0, pinned: false }],
      },
    });
    expect(r.total).toBe(3);
    expect(r.capacity.nextToEvict[0].id).toBe("m9");
    expect(r.byFolder[0].folder).toBeNull();   // null ⇒ the virtual "unfiled" folder
    expect(r.byScope[0].scope).toBeNull();     // null ⇒ global
    expect(r.topTags[0].tag).toBe("auth");
  });

  it("rejects a negative count and a non-int total (strict)", () => {
    expect(() => MemoryStatsResult.parse({
      total: 1, byKind: {}, byFolder: [{ folder: "ops", count: -1 }], byScope: [], topTags: [],
    })).toThrow();
    expect(() => MemoryStatsResult.parse({
      total: 1.5, byKind: {}, byFolder: [], byScope: [], topTags: [],
    })).toThrow();
  });
});

describe("MemoryCapacitySchema / pinned (F36)", () => {
  it("case 25: the capacity block is strict and an empty eviction preview is valid", () => {
    const empty = MemoryCapacitySchema.parse({
      limit: 2000, total: 0, fill: 0, alarmAt: 0.9, alarming: false, pinned: 0, nextToEvict: [],
    });
    expect(empty.nextToEvict).toEqual([]);   // a store below the cap still reports a full block
    expect(() => MemoryCapacitySchema.parse({
      limit: 2000, total: 0, fill: 0, alarmAt: 0.9, alarming: false, pinned: 0, nextToEvict: [], bogus: 1,
    })).toThrow();
    expect(() => MemoryEvictionCandidateSchema.parse(
      { id: "m1", title: null, kind: "note", value: 0, inbound: 0 })).toThrow();   // pinned required
  });

  it("case 26: MemoryRecordSchema defaults pinned to false and round-trips a pinned record", () => {
    // The 1,641 live records carry no `pinned` key. MemoryRecordSchema is .strict(), so anything
    // but a defaulted addition would quarantine memory.json to .corrupt-<ts> on the next boot.
    const legacy = MemoryRecordSchema.parse({ id: "m1", author: "a1", text: "t", createdAt: 1, updatedAt: 2 });
    expect(legacy.pinned).toBe(false);
    const pinned = MemoryRecordSchema.parse({ ...legacy, pinned: true });
    expect(MemoryRecordSchema.parse(pinned)).toEqual(pinned);
  });
});

describe("MemoryGraphParams (MEM-2)", () => {
  it("accepts an empty query (whole graph) and a full filter", () => {
    expect(MemoryGraphParams.parse({})).toEqual({});
    expect(MemoryGraphParams.parse({ folder: "ops", kind: "decision", tags: ["a"], semanticEdges: true }))
      .toEqual({ folder: "ops", kind: "decision", tags: ["a"], semanticEdges: true });
  });

  it("rejects an invalid kind and extra keys (strict)", () => {
    expect(() => MemoryGraphParams.parse({ kind: "rumor" })).toThrow();
    expect(() => MemoryGraphParams.parse({ bogus: true })).toThrow();
  });
});

describe("MemoryGraphNodeSchema (MEM-2)", () => {
  it("parses a record node without the ghost flag", () => {
    const n = MemoryGraphNodeSchema.parse({
      id: "m1", title: "Auth", label: "Auth", kind: "decision", folder: "ops",
      tags: ["auth"], degree: 2, updatedAt: 5,
    });
    expect(n.ghost).toBeUndefined();
    expect(n.degree).toBe(2);
  });

  it("parses a ghost node (null record attributes, ghost:true)", () => {
    const g = MemoryGraphNodeSchema.parse({
      id: "ghost:runbook", title: "Runbook", label: "Runbook",
      kind: null, folder: null, tags: [], degree: 1, updatedAt: null, ghost: true,
    });
    expect(g.ghost).toBe(true);
    expect(g.kind).toBeNull();
    expect(g.updatedAt).toBeNull();
  });

  it("rejects ghost:false (only the literal true is allowed) and a negative degree", () => {
    expect(() => MemoryGraphNodeSchema.parse({
      id: "m1", title: null, label: "x", kind: "note", folder: null, tags: [], degree: 0, updatedAt: 1, ghost: false,
    })).toThrow();
    expect(() => MemoryGraphNodeSchema.parse({
      id: "m1", title: null, label: "x", kind: "note", folder: null, tags: [], degree: -1, updatedAt: 1,
    })).toThrow();
  });
});

describe("MemoryGraphEdgeSchema / MemoryGraphResult (MEM-2)", () => {
  it("parses link and semantic edges", () => {
    expect(MemoryGraphEdgeSchema.parse({ source: "m1", target: "m2", kind: "link", weight: 2 }).weight).toBe(2);
    expect(MemoryGraphEdgeSchema.parse({ source: "m1", target: "ghost:x", kind: "semantic", weight: 0.8 }).kind)
      .toBe("semantic");
  });

  it("rejects an unknown edge kind (strict)", () => {
    expect(() => MemoryGraphEdgeSchema.parse({ source: "m1", target: "m2", kind: "backlink", weight: 1 })).toThrow();
  });

  it("parses a full nodes+edges graph result and rejects extra keys", () => {
    const g = MemoryGraphResult.parse({
      nodes: [{ id: "m1", title: null, label: "m1", kind: "note", folder: null, tags: [], degree: 1, updatedAt: 1 }],
      edges: [{ source: "m1", target: "ghost:x", kind: "link", weight: 1 }],
    });
    expect(g.nodes).toHaveLength(1);
    expect(g.edges[0].target).toBe("ghost:x");
    expect(() => MemoryGraphResult.parse({ nodes: [], edges: [], bogus: true })).toThrow();
  });
});
