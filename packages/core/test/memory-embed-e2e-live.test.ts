import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddingProvider } from "../src/memory-embed.js";
import { MemoryVectorIndex } from "../src/memory-index.js";
import { MemoryStore } from "../src/memory.js";

// MEM-4 (§6.2): OPT-IN live end-to-end check, same gate as memory-embed-live.test.ts — downloads the
// real model and drives a real MemoryStore + MemoryVectorIndex, proving the `mode: "semantic"` RPC
// path actually ranks by cosine rather than degrading to lexical. Run with CHIMERA_MEM4_LIVE=1.
const LIVE = process.env.CHIMERA_MEM4_LIVE === "1";

describe("MEM-4 live end-to-end semantic search (opt-in)", () => {
  it.skipIf(!LIVE)("ranks a semantic match above a lexical-overlap decoy under mode:semantic", async () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "chimera-mem4-models-"));
    const homeDir = mkdtempSync(join(tmpdir(), "chimera-mem4-home-"));

    const index = new MemoryVectorIndex(join(homeDir, "memory-index"), () =>
      resolveEmbeddingProvider((process.env.CHIMERA_MEMORY_EMBEDDER as any) ?? "transformers", {
        modelsDir, ollamaHost: "http://127.0.0.1:11434", ollamaModel: "nomic-embed-text",
      }));
    const store = new MemoryStore(homeDir, undefined, undefined, index);

    // Query shares zero content words with the semantic match, but the lexical decoy shares two
    // ("recovery", "credential") while being about an unrelated topic (first-aid training, not
    // account access) — a pure BM25 ranking would put the decoy first.
    const query = "account credential recovery";
    const semanticMatch = store.add({ author: "test", text: "how do I reset my forgotten login and get back into my profile" });
    const lexicalDecoy = store.add({ author: "test", text: "the recovery position is a standard first aid credential training topic" });
    const neutral = store.add({ author: "test", text: "the cat sat on the warm windowsill all afternoon" });

    await index.flush();   // drain background embedding synchronously (test-only escape hatch)

    const lexicalResults = store.search({ query, limit: 10 });
    expect(lexicalResults[0].record.id).toBe(lexicalDecoy.id);   // sanity: BM25 alone gets fooled

    const semanticResults = await store.searchHybrid({ query, mode: "semantic", limit: 10 });
    const rank = new Map(semanticResults.map((r, i) => [r.record.id, i]));
    expect(rank.get(semanticMatch.id)!).toBeLessThan(rank.get(lexicalDecoy.id)!);
    expect(rank.get(semanticMatch.id)!).toBeLessThan(rank.get(neutral.id)!);
  }, 60_000);
});
