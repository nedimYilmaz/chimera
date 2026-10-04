import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LexicalRanker } from "@chimera/core/memory-search";
import { MemoryStore } from "@chimera/core/memory";
import type { MemoryRecord } from "@chimera/protocol";

function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return { id: "1", author: "ag", text: "", tags: [], kind: "note", treeId: null, taskId: null, createdAt: 0, updatedAt: 0, ...over };
}

describe("LexicalRanker", () => {
  it("scores a text-matching record above a non-matching one", () => {
    const ranker = new LexicalRanker();
    const relevant = rec({ id: "a", text: "the scheduler retries failed queue tasks" });
    const irrelevant = rec({ id: "b", text: "the tui renders panes and overlays" });
    ranker.prepare([relevant, irrelevant]);
    expect(ranker.score("queue tasks", relevant)).toBeGreaterThan(ranker.score("queue tasks", irrelevant));
  });

  it("gives a bonus for query terms hitting tags or kind", () => {
    const ranker = new LexicalRanker();
    const tagged = rec({ id: "a", text: "unrelated body", tags: ["retry"] });
    const plain = rec({ id: "b", text: "unrelated body" });
    ranker.prepare([tagged, plain]);
    expect(ranker.score("retry", tagged)).toBeGreaterThan(ranker.score("retry", plain));

    const decision = rec({ id: "c", text: "body", kind: "decision" });
    ranker.prepare([decision]);
    expect(ranker.score("decision", decision)).toBeGreaterThan(0);
  });

  it("returns 0 for an empty query", () => {
    const ranker = new LexicalRanker();
    const r = rec({ text: "anything" });
    ranker.prepare([r]);
    expect(ranker.score("", r)).toBe(0);
  });
});

describe("MemoryStore.search ranking", () => {
  it("ranks the relevant note above the irrelevant one for a text query", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mem-s-"));
    const mem = new MemoryStore(dir);
    mem.add({ author: "ag", text: "the tui renders panes and overlays" });
    const hit = mem.add({ author: "ag", text: "the scheduler retries failed queue tasks" });
    const results = mem.search({ query: "queue retry tasks" });
    expect(results[0].record.id).toBe(hit.id);
    expect(results[0].score).toBeGreaterThan(0);
  });
});
