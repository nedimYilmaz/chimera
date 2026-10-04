import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { effectiveEmbedder, embedQueryVector, resolveEmbeddingProvider, type EmbedderSetting } from "../src/memory-embed.js";

// MEM-4: HERMETIC unit coverage for the embedder resolution layer — the byte-identical companion to
// the opt-in memory-embed-live.test.ts. Nothing here downloads a model or touches a live network:
// - effectiveEmbedder is a pure env-precedence function.
// - resolveEmbeddingProvider is only exercised on paths that resolve to null WITHOUT any remote call
//   ("off" short-circuits before any I/O; "ollama" against a closed localhost port fails the 300ms
//   reachability probe with an immediate connection-refused). The transformers path is measured by
//   the live test instead — forcing it here could trigger a one-time public model download.

// A localhost port that is (practically) always closed → fetch rejects with ECONNREFUSED at once, so
// loadOllama's reachability probe returns null with no external traffic.
const OPTS = { modelsDir: "/nonexistent/models", ollamaHost: "http://127.0.0.1:1", ollamaModel: "nomic-embed-text" };

describe("MEM-4 effectiveEmbedder (env precedence)", () => {
  const saved = process.env.CHIMERA_MEMORY_EMBEDDER;
  beforeEach(() => { delete process.env.CHIMERA_MEMORY_EMBEDDER; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHIMERA_MEMORY_EMBEDDER;
    else process.env.CHIMERA_MEMORY_EMBEDDER = saved;
  });

  it("returns the configured setting when the env override is unset", () => {
    expect(effectiveEmbedder("auto")).toBe("auto");
    expect(effectiveEmbedder("transformers")).toBe("transformers");
  });

  it("lets a valid env override win over config", () => {
    for (const env of ["auto", "off", "transformers", "ollama"] as const) {
      process.env.CHIMERA_MEMORY_EMBEDDER = env;
      // Configured is the opposite intent; the env must override it in every case.
      expect(effectiveEmbedder("auto")).toBe(env);
    }
  });

  it("forces off via the env override even when config says auto", () => {
    process.env.CHIMERA_MEMORY_EMBEDDER = "off";
    expect(effectiveEmbedder("auto")).toBe("off");
  });

  it("ignores an unrecognized env value and falls back to config", () => {
    process.env.CHIMERA_MEMORY_EMBEDDER = "openai";
    expect(effectiveEmbedder("ollama")).toBe("ollama");
  });

  it("treats an empty env value as unset (config wins)", () => {
    process.env.CHIMERA_MEMORY_EMBEDDER = "";
    expect(effectiveEmbedder("transformers")).toBe("transformers");
  });
});

describe("MEM-4 resolveEmbeddingProvider (hermetic paths)", () => {
  const saved = process.env.CHIMERA_MEMORY_EMBEDDER;
  beforeEach(() => { delete process.env.CHIMERA_MEMORY_EMBEDDER; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHIMERA_MEMORY_EMBEDDER;
    else process.env.CHIMERA_MEMORY_EMBEDDER = saved;
  });

  it("returns null for the off setting without any I/O", async () => {
    // "off" short-circuits before probing anything — search stays lexical, byte-identical to today.
    expect(await resolveEmbeddingProvider("off", OPTS)).toBeNull();
  });

  it("returns null when the env override forces off, regardless of the configured setting", async () => {
    process.env.CHIMERA_MEMORY_EMBEDDER = "off";
    expect(await resolveEmbeddingProvider("auto", OPTS)).toBeNull();
  });

  it("returns null on the forced ollama path when the host is unreachable", async () => {
    // The 300ms reachability probe against a closed localhost port fails fast → provider unavailable,
    // never throws. This is the degrade-to-lexical contract for a missing local Ollama.
    expect(await resolveEmbeddingProvider("ollama", OPTS)).toBeNull();
  });

  // 2026-09-02 harness triage: "auto" walks BOTH the transformers dynamic-import resolution
  // and the ollama reachability probe (own 300ms timeout, via a real AbortController timer)
  // before landing on null — under concurrent-agent CPU contention that chain can exceed
  // vitest's 5000ms default even though it never leaves localhost/the filesystem. Bumped, not
  // weakened — same hermetic assertion, more wall-clock allowance.
  it("degrades auto to null when neither the in-process embedder nor a local Ollama is present", async () => {
    // In the hermetic core test env transformers.js is not resolvable from packages/core and Ollama is
    // down, so auto walks the whole chain and lands on lexical (null) without a single remote call.
    const provider = await resolveEmbeddingProvider("auto" as EmbedderSetting, OPTS);
    expect(provider).toBeNull();
  }, 20_000);
});

// ASYMMETRIC-EMBEDDING — hermetic coverage for the query-vs-passage split. The e5 family is TRAINED
// with distinct "query:"/"passage:" prefixes; encoding a query as a passage is a silent retrieval
// quality loss, not an error, so nothing at runtime would ever surface it. These use a stub
// provider — no model, no download.
describe("embedQueryVector (query vs passage encoding)", () => {
  const vec = (n: number): Float32Array => Float32Array.from([n, 0, 0]);

  it("uses the provider's asymmetric query path when it has one", async () => {
    const seen: string[] = [];
    const provider = {
      id: "stub", model: "stub", dim: 3,
      embed: async (texts: string[]) => { seen.push(`passage:${texts.join("|")}`); return texts.map(() => vec(1)); },
      embedQuery: async (text: string) => { seen.push(`query:${text}`); return vec(2); },
    };
    expect([...(await embedQueryVector(provider, "kuyruk"))]).toEqual([2, 0, 0]);
    // the PASSAGE path must not have been touched — that is the whole bug this prevents
    expect(seen).toEqual(["query:kuyruk"]);
  });

  it("falls back to the symmetric path for a provider without one (Ollama, stubs)", async () => {
    const provider = {
      id: "stub", model: "stub", dim: 3,
      embed: async (texts: string[]) => texts.map(() => vec(7)),
    };
    expect([...(await embedQueryVector(provider, "kuyruk"))]).toEqual([7, 0, 0]);
  });
});
