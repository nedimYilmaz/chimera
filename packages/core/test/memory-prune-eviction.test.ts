import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, UnknownMemoryError } from "../src/memory.js";
import { MemoryVectorIndex } from "../src/memory-index.js";
import type { EmbeddingProvider } from "../src/memory-embed.js";

// MEM-4: overflow eviction must also drop the evicted record's VECTOR from the derived index
// (memory.ts prune(): `this.index?.drop(id)`). The fixture uses a small explicit capacity and
// evicts the lowest-VALUE records on save (F36); without the drop, the sidecar would leak vectors
// for records that no longer exist. Every record in these fixtures is an unpinned, unlinked note
// (value 0), so the insertion-order tie-break makes the value prune identical to the old FIFO
// order — which is why this regression gate still reads the same.
// The embedder is never resolved here (a fresh add on a never-searched store does not
// probe), so this stays fully network-free — we only assert the synchronous drop bookkeeping.

const MAX_MEMORY_RECORDS = 10;

const fakeProvider: EmbeddingProvider = {
  id: "fake", model: "fake-concepts", dim: 1,
  async embed(texts) { return texts.map(() => Float32Array.from([1])); },
};

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem4-prune-"));
  const index = new MemoryVectorIndex(join(dir, "memory-index"), async () => fakeProvider);
  const store = new MemoryStore(dir, undefined, undefined, index, { maxRecords: MAX_MEMORY_RECORDS });
  return { dir, index, store };
}

describe("MEM-4 prune eviction drops the evicted vector", () => {
  // The vector-drop contract needs only a small bounded store.
  it("calls index.drop for the oldest record once the cap is exceeded", { timeout: 30000 }, () => {
    const { store, index } = makeStore();
    const dropSpy = vi.spyOn(index, "drop");

    // Fill exactly to the cap — no eviction yet.
    const first = store.add({ author: "t", text: "oldest record 0" });
    for (let i = 1; i < MAX_MEMORY_RECORDS; i++) store.add({ author: "t", text: `record ${i}` });
    expect(dropSpy).not.toHaveBeenCalled();

    // One more add overflows by 1 → the oldest (insertion-order) record is evicted, and its vector
    // must be dropped from the index in the same prune pass.
    const overflow = store.add({ author: "t", text: "overflow record" });
    expect(dropSpy).toHaveBeenCalledWith(first.id);

    // The surviving newest record was never dropped.
    expect(dropSpy).not.toHaveBeenCalledWith(overflow.id);
  });

  it("removes the evicted record from the store (get throws, size stays capped)", { timeout: 30000 }, () => {
    const { store } = makeStore();
    const first = store.add({ author: "t", text: "oldest" });
    for (let i = 1; i <= MAX_MEMORY_RECORDS; i++) store.add({ author: "t", text: `record ${i}` });

    // The oldest record is gone from every read path...
    expect(() => store.get(first.id)).toThrow(UnknownMemoryError);
    // ...and the store never exceeds the cap.
    expect(store.stats().total).toBe(MAX_MEMORY_RECORDS);
  });

  it("does not drop anything while the store is at or below the cap", { timeout: 30000 }, () => {
    const { store, index } = makeStore();
    const dropSpy = vi.spyOn(index, "drop");
    for (let i = 0; i < MAX_MEMORY_RECORDS; i++) store.add({ author: "t", text: `record ${i}` });
    expect(dropSpy).not.toHaveBeenCalled();
    expect(store.stats().total).toBe(MAX_MEMORY_RECORDS);
  });
});
