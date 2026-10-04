import { describe, it, expect } from "vitest";
import {
  MemoryRecordSchema,
  MemoryAddParams,
  MemoryEditParams,
  MemorySearchParams,
  MemoryIndexParams,
  MemoryIndexResult,
  MemoryConfigSchema,
} from "@chimera/protocol";

// WS-SCHEMA: the shared structured MEMORY store's record + param schemas. Each
// parses a valid value, applies its defaults, and rejects malformed input (strict).

describe("MemoryRecordSchema", () => {
  it("parses a full record and applies defaults for optional fields", () => {
    const rec = MemoryRecordSchema.parse({
      id: "m1", author: "a1", text: "remember X", createdAt: 1, updatedAt: 2,
    });
    expect(rec.tags).toEqual([]);
    expect(rec.kind).toBe("note");
    expect(rec.treeId).toBeNull();
    expect(rec.taskId).toBeNull();
    // MEM-1: new fields default to null so every already-persisted record parses.
    expect(rec.title).toBeNull();
    expect(rec.folder).toBeNull();
    // F35: defaulted, so a store written before supersession existed still parses.
    expect(rec.supersedes).toBeNull();
    expect(rec.supersededBy).toBeNull();
  });

  it("keeps explicit values", () => {
    const rec = MemoryRecordSchema.parse({
      id: "m1", author: "a1", text: "t", tags: ["x", "y"], kind: "decision",
      title: "T", folder: "ops/protocols", scope: "alpha",
      treeId: "tr1", taskId: "tk1", createdAt: 1, updatedAt: 2,
    });
    expect(rec).toEqual({
      id: "m1", author: "a1", text: "t", tags: ["x", "y"], kind: "decision",
      title: "T", folder: "ops/protocols", scope: "alpha",
      pinned: false,   // F36: defaulted, so a store written before pinning existed still parses
      supersedes: null, supersededBy: null,   // F35: defaulted, same reason
      treeId: "tr1", taskId: "tk1", createdAt: 1, updatedAt: 2,
    });
  });

  it("MEM-1: rejects a title over 120 chars", () => {
    expect(() => MemoryRecordSchema.parse({
      id: "m", author: "a", text: "t", title: "x".repeat(121), createdAt: 1, updatedAt: 2,
    })).toThrow();
  });

  it("rejects empty id/author/text, an unknown kind, and extra keys (strict)", () => {
    expect(() => MemoryRecordSchema.parse({ id: "", author: "a", text: "t", createdAt: 1, updatedAt: 2 })).toThrow();
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "", text: "t", createdAt: 1, updatedAt: 2 })).toThrow();
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "a", text: "", createdAt: 1, updatedAt: 2 })).toThrow();
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "a", text: "t", kind: "rumor", createdAt: 1, updatedAt: 2 })).toThrow();
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "a", text: "t", createdAt: 1, updatedAt: 2, bogus: true })).toThrow();
  });

  it("rejects a missing timestamp (either one)", () => {
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "a", text: "t", createdAt: 1 })).toThrow();
    expect(() => MemoryRecordSchema.parse({ id: "m", author: "a", text: "t", updatedAt: 2 })).toThrow();
  });
});

describe("MemoryAddParams", () => {
  it("parses a minimal add and defaults tags/kind/treeId/taskId + MEM-1 title/folder", () => {
    const p = MemoryAddParams.parse({ author: "a1", text: "hello" });
    // allowDuplicate defaults FALSE — refusing a second copy is the default posture, not an
    // opt-in; a caller has to ask for a duplicate on purpose.
    expect(p).toEqual({ author: "a1", text: "hello", title: null, folder: null, tags: [], kind: "note", treeId: null, taskId: null, allowDuplicate: false, supersedes: null });
  });

  it("rejects empty author/text, an invalid kind, and extra keys (strict)", () => {
    expect(() => MemoryAddParams.parse({ author: "", text: "t" })).toThrow();
    expect(() => MemoryAddParams.parse({ author: "a", text: "" })).toThrow();
    expect(() => MemoryAddParams.parse({ author: "a", text: "t", kind: "rumor" })).toThrow();
    expect(() => MemoryAddParams.parse({ author: "a", text: "t", bogus: 1 })).toThrow();
  });
});

describe("MemoryEditParams", () => {
  it("parses an id-only edit (all fields optional) and a full edit", () => {
    expect(MemoryEditParams.parse({ id: "m1" })).toEqual({ id: "m1" });
    expect(MemoryEditParams.parse({ id: "m1", text: "new", tags: ["z"], kind: "fact" }))
      .toEqual({ id: "m1", text: "new", tags: ["z"], kind: "fact" });
  });

  it("MEM-1: accepts explicit null title/folder (clear) and omission (untouched)", () => {
    expect(MemoryEditParams.parse({ id: "m1", title: null, folder: null }))
      .toEqual({ id: "m1", title: null, folder: null });
    expect(MemoryEditParams.parse({ id: "m1", title: "New", folder: "ops" }))
      .toEqual({ id: "m1", title: "New", folder: "ops" });
    expect(MemoryEditParams.parse({ id: "m1" })).not.toHaveProperty("title");   // omitted stays absent
  });

  it("rejects a missing/empty id, an empty text, an invalid kind, and extra keys (strict)", () => {
    expect(() => MemoryEditParams.parse({ text: "t" })).toThrow();
    expect(() => MemoryEditParams.parse({ id: "" })).toThrow();
    expect(() => MemoryEditParams.parse({ id: "m1", text: "" })).toThrow();
    expect(() => MemoryEditParams.parse({ id: "m1", kind: "rumor" })).toThrow();
    expect(() => MemoryEditParams.parse({ id: "m1", bogus: true })).toThrow();
  });
});

describe("MemorySearchParams", () => {
  it("defaults limit to 20 and mode to hybrid with no filters (pure listing)", () => {
    // excerpt defaults FALSE — the app's Memory tab renders whole records and must not be
    // silently handed truncated ones; only the agent-facing tool opts in.
    expect(MemorySearchParams.parse({})).toEqual({ limit: 20, mode: "hybrid", excerpt: false });
  });

  it("parses a full tag+query filter incl. MEM-1 folder + mode", () => {
    const p = MemorySearchParams.parse({ query: "auth", tags: ["a", "b"], author: "a1", kind: "decision", treeId: "tr1", folder: "ops", mode: "semantic", limit: 5 });
    expect(p).toEqual({ query: "auth", tags: ["a", "b"], author: "a1", kind: "decision", treeId: "tr1", folder: "ops", mode: "semantic", limit: 5, excerpt: false });
  });

  it("MEM-1: rejects an invalid search mode", () => {
    expect(() => MemorySearchParams.parse({ mode: "fuzzy" })).toThrow();
  });

  it("accepts the inclusive limit edges 1 and 100", () => {
    expect(MemorySearchParams.parse({ limit: 1 }).limit).toBe(1);
    expect(MemorySearchParams.parse({ limit: 100 }).limit).toBe(100);
  });

  it("treats treeId as plain-optional (unlike the record) — rejects null", () => {
    expect(() => MemorySearchParams.parse({ treeId: null })).toThrow();
  });

  it("rejects a non-int / out-of-range limit, an invalid kind, and extra keys (strict)", () => {
    expect(() => MemorySearchParams.parse({ limit: 0 })).toThrow();
    expect(() => MemorySearchParams.parse({ limit: 101 })).toThrow();
    expect(() => MemorySearchParams.parse({ limit: 1.5 })).toThrow();
    expect(() => MemorySearchParams.parse({ kind: "rumor" })).toThrow();
    expect(() => MemorySearchParams.parse({ bogus: true })).toThrow();
  });

  it("F34-SCOPE-FILTER: scopeMode is optional and defaults to undefined (backward compatible)", () => {
    expect(MemorySearchParams.parse({})).not.toHaveProperty("scopeMode");
    expect(MemorySearchParams.parse({ query: "auth" })).not.toHaveProperty("scopeMode");
  });

  it("F34-SCOPE-FILTER: accepts each scopeMode enum value", () => {
    expect(MemorySearchParams.parse({ scopeMode: "global" }).scopeMode).toBe("global");
    expect(MemorySearchParams.parse({ scopeMode: "project" }).scopeMode).toBe("project");
    expect(MemorySearchParams.parse({ scopeMode: "all" }).scopeMode).toBe("all");
  });

  it("F34-SCOPE-FILTER: rejects an invalid scopeMode and composes with scope", () => {
    expect(() => MemorySearchParams.parse({ scopeMode: "everything" })).toThrow();
    const p = MemorySearchParams.parse({ scope: "alpha", scopeMode: "project" });
    expect(p.scope).toBe("alpha");
    expect(p.scopeMode).toBe("project");
  });
});

// MEM-4: local vector-index RPC + embedder config.
describe("MemoryIndexParams / MemoryIndexResult (MEM-4)", () => {
  it("defaults action to status and accepts rebuild", () => {
    expect(MemoryIndexParams.parse({})).toEqual({ action: "status" });
    expect(MemoryIndexParams.parse({ action: "rebuild" }).action).toBe("rebuild");
  });

  it("rejects an unknown action and extra keys (strict)", () => {
    expect(() => MemoryIndexParams.parse({ action: "nuke" })).toThrow();
    expect(() => MemoryIndexParams.parse({ bogus: true })).toThrow();
  });

  it("parses a full status result and enforces the state enum", () => {
    const r = MemoryIndexResult.parse({
      state: "ready", provider: "transformers", model: "bge-small-en-v1.5", dim: 384,
      embedded: 10, total: 12, pending: 2, degraded: false, error: null,
    });
    expect(r.state).toBe("ready");
    expect(MemoryIndexResult.parse({
      state: "off", provider: null, model: null, dim: 0,
      embedded: 0, total: 0, pending: 0, degraded: true, error: null,
    }).provider).toBeNull();
    expect(() => MemoryIndexResult.parse({
      state: "warming", provider: null, model: null, dim: 0, embedded: 0, total: 0, pending: 0, degraded: true, error: null,
    })).toThrow();
  });
});

describe("MemoryConfigSchema (MEM-4)", () => {
  it("defaults to auto + local Ollama endpoint, byte-identically for an empty config", () => {
    expect(MemoryConfigSchema.parse({})).toEqual({
      embedder: "auto", ollamaHost: "http://127.0.0.1:11434", ollamaModel: "nomic-embed-text",
      evictionAlarmAt: 0.9,
    });
  });

  it("accepts each embedder mode and rejects an unknown one / extra keys (strict)", () => {
    for (const embedder of ["auto", "off", "transformers", "ollama"]) {
      expect(MemoryConfigSchema.parse({ embedder }).embedder).toBe(embedder);
    }
    expect(() => MemoryConfigSchema.parse({ embedder: "openai" })).toThrow();
    expect(() => MemoryConfigSchema.parse({ bogus: true })).toThrow();
  });
});

// QA F35-2: plan criteria 13 and 14 name a SCHEMA half each — the store-level halves landed in
// packages/core/test/memory-supersedes.test.ts (cases 13/14) but the .strict() rejections that make
// the relation forge-proof and immutable at the RPC boundary had no assertion anywhere. Without
// these two, dropping `.strict()` (or adding a `supersededBy` key) breaks the feature silently.
describe("F35 supersession is store-owned: the schemas refuse the forgeries", () => {
  it("MemoryAddParams rejects a caller-supplied supersededBy but accepts supersedes", () => {
    expect(MemoryAddParams.safeParse({ author: "a1", text: "t", supersededBy: "x" }).success).toBe(false);
    expect(MemoryAddParams.safeParse({ author: "a1", text: "t", supersedes: "x" }).success).toBe(true);
  });

  it("MemoryEditParams rejects both supersedes and supersededBy — the relation is immutable", () => {
    expect(MemoryEditParams.safeParse({ id: "m1", supersedes: "x" }).success).toBe(false);
    expect(MemoryEditParams.safeParse({ id: "m1", supersededBy: "x" }).success).toBe(false);
  });

  it("MemoryRecordSchema defaults both supersession fields to null (pre-F35 records parse)", () => {
    const rec = MemoryRecordSchema.parse({ id: "m1", author: "a1", text: "t", createdAt: 1, updatedAt: 2 });
    expect(rec.supersedes).toBeNull();
    expect(rec.supersededBy).toBeNull();
  });
});
