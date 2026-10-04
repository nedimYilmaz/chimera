import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddingProvider } from "../src/memory-embed.js";

// MEM-4 (§6.2): OPT-IN live embedder measurement. SKIPPED by default — CI never downloads a model or
// probes a network. Run with `CHIMERA_MEM4_LIVE=1` (transformers.js installed, or a local Ollama up)
// to measure real cold-start / per-embed cost against the §6.2 estimates (cold load ~1-2.5s; ~5-20ms
// /note on Apple silicon). Prints the numbers so they can be pasted into the landing report.
const LIVE = process.env.CHIMERA_MEM4_LIVE === "1";

describe("MEM-4 live embedder (opt-in)", () => {
  it.skipIf(!LIVE)("resolves a real provider and measures cold-start + embed latency", async () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "chimera-mem4-models-"));
    const t0 = Date.now();
    const provider = await resolveEmbeddingProvider(
      (process.env.CHIMERA_MEMORY_EMBEDDER as any) ?? "auto",
      { modelsDir, ollamaHost: "http://127.0.0.1:11434", ollamaModel: "nomic-embed-text" },
    );
    const coldMs = Date.now() - t0;
    if (!provider) {
      // Explicit, honest signal: no embedder was available in this environment (expected on a bare
      // dev box with neither transformers.js installed nor Ollama running).
      console.log(`[MEM4-LIVE] no embedder available (cold-resolve ${coldMs}ms) — transformers.js absent and Ollama unreachable`);
      expect(provider).toBeNull();
      return;
    }
    const samples = ["the daemon supervises agents in git worktrees", "reciprocal rank fusion of BM25 and cosine"];
    const e0 = Date.now();
    const vecs = await provider.embed(samples);
    const embedMs = (Date.now() - e0) / samples.length;
    console.log(`[MEM4-LIVE] provider=${provider.id} model=${provider.model} dim=${provider.dim} coldMs=${coldMs} embedMsPerNote=${embedMs.toFixed(1)}`);
    expect(vecs.length).toBe(samples.length);
    expect(vecs[0].length).toBe(provider.dim);
  }, 60_000);
});
