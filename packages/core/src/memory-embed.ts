// MEM-4 (PLAN-MEMORY.md §6): local-only text embeddings for hybrid memory search.
//
// HARD CONSTRAINT (§6.1, docs/RELEASE-BUNDLING.md): the daemon ships as a single
// `bun build --compile` binary, and that only works because NO native module is a hard
// dependency anywhere in `packages/*`. `@huggingface/transformers` pulls onnxruntime (native),
// so it must NEVER be a static import of core/daemon. It is an OPTIONAL dependency of
// `packages/core` (this package — NOT packages/daemon: pnpm's non-hoisted node_modules resolves a
// bare specifier relative to the physical location of the file performing the import, so
// declaring it only on a sibling package leaves THIS package's node_modules without the symlink
// and the import below fails every time), reached through a COMPUTED-specifier dynamic import
// below — computed so neither `tsc` nor bun's compile-time resolver ever tries to bundle it (bun
// resolves even unreachable *literal* dynamic imports; a specifier built at runtime is invisible
// to it). If the package is absent (the compiled binary, or a minimal install), the import throws
// and we degrade.
//
// Resolution order (config.memory.embedder, or the CHIMERA_MEMORY_EMBEDDER env override):
//   auto → transformers.js → Ollama probe → off (lexical)
//   off  → no provider (search stays byte-identical to today's lexical behavior)
//   transformers / ollama → force that one path (still null on failure — never throws)
// NOTHING here contacts a third-party inference API: transformers.js downloads a public model ONCE
// to a local dir; Ollama is a local process. Both are skippable — degrading to lexical is always safe.

export interface EmbeddingProvider {
  readonly id: string;      // "transformers" | "ollama"
  readonly model: string;   // human model name, surfaced in memory.index status
  readonly dim: number;     // vector dimension
  /** Embed DOCUMENTS (passages). */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** ASYMMETRIC-EMBEDDING: embed a QUERY. Optional — absent means the model is
   *  symmetric and a query is encoded exactly like a document. Present for the
   *  e5 family, which is TRAINED with distinct "query:"/"passage:" prefixes and
   *  measurably loses retrieval quality when both sides get the same one. */
  embedQuery?(text: string): Promise<Float32Array>;
}

/** Encode `q` as a query, using the provider's asymmetric path when it has one.
 *  Every search path must go through this rather than calling embed([q]) — that
 *  is what silently encodes a query as a passage. */
export async function embedQueryVector(provider: EmbeddingProvider, q: string): Promise<Float32Array> {
  if (provider.embedQuery) return provider.embedQuery(q);
  const [vec] = await provider.embed([q]);
  return vec!;
}

export type EmbedderSetting = "auto" | "off" | "transformers" | "ollama";

export type ResolveEmbedderOpts = {
  modelsDir: string;      // transformers.js model cache ($CHIMERA_HOME/models)
  ollamaHost: string;     // e.g. http://127.0.0.1:11434
  ollamaModel: string;    // e.g. nomic-embed-text
};

// MULTILINGUAL-EMBEDDER: the first entry that loads wins. bge-small-en is
// English-ONLY, and the transcripts this index has to search are largely not
// English — an English encoder on Turkish text collapses toward noise and
// quietly hands the whole ranking back to BM25, which is the one failure mode
// that looks like "semantic search works, it's just not very good".
//
// Both are 384-dim, so switching does NOT trip the sidecar's dim check — it is
// the `model` NAME that invalidates it (see MemoryVectorIndex.ensureProvider).
// Mixing vectors from two models inside one index silently degrades cosine, so
// a switch is always a full re-embed, never a flag.
//
// The English model stays as a fallback rather than being deleted: it is the
// one already cached on existing installs, so a machine that is offline (or
// that can't fetch the new weights) keeps semantic search instead of silently
// degrading to lexical.
type TransformerModel = { repo: string; name: string; queryPrefix: string; passagePrefix: string };
const TRANSFORMERS_MODELS: readonly TransformerModel[] = [
  // e5 is trained with these exact prefixes; omitting them is a real quality loss, not a nicety.
  { repo: "Xenova/multilingual-e5-small", name: "multilingual-e5-small", queryPrefix: "query: ", passagePrefix: "passage: " },
  // bge's asymmetry is query-side only — passages are embedded bare.
  { repo: "Xenova/bge-small-en-v1.5", name: "bge-small-en-v1.5", queryPrefix: "Represent this sentence for searching relevant passages: ", passagePrefix: "" },
];
const TRANSFORMERS_DIM = 384;
const TRANSFORMERS_MAX_CHARS = 1500;   // §6.2: median note ~1.1k chars; no chunking, just a guard truncate

// The effective setting: an explicit env override wins over config so an operator (or CI) can force
// "off" without editing config.json — used to keep unit runs fully network-free.
export function effectiveEmbedder(configured: EmbedderSetting): EmbedderSetting {
  const env = process.env.CHIMERA_MEMORY_EMBEDDER;
  if (env === "auto" || env === "off" || env === "transformers" || env === "ollama") return env;
  return configured;
}

export async function resolveEmbeddingProvider(
  setting: EmbedderSetting,
  opts: ResolveEmbedderOpts,
): Promise<EmbeddingProvider | null> {
  const eff = effectiveEmbedder(setting);
  if (eff === "off") return null;
  if (eff === "transformers") return loadTransformers(opts.modelsDir);
  if (eff === "ollama") return loadOllama(opts.ollamaHost, opts.ollamaModel);
  // auto: prefer the in-process embedder, fall back to a local Ollama, else lexical.
  return (await loadTransformers(opts.modelsDir)) ?? (await loadOllama(opts.ollamaHost, opts.ollamaModel));
}

// transformers.js (@huggingface/transformers). Computed specifier (see file header) so the compiled
// daemon — which does NOT carry the package — degrades instead of failing to build/boot.
async function loadTransformers(modelsDir: string): Promise<EmbeddingProvider | null> {
  const spec = ["@huggingface", "transformers"].join("/");
  let pipeline: any;
  try {
    const mod: any = await import(spec);
    pipeline = mod.pipeline;
    if (mod.env) {
      // Cache the one-time public model download under $CHIMERA_HOME/models (loud on first run).
      mod.env.cacheDir = modelsDir;
      mod.env.allowRemoteModels = true;
    }
  } catch {
    return null;   // package absent (compiled binary) → next provider
  }
  // MULTILINGUAL-EMBEDDER: try each candidate in order; a repo that can't be fetched (offline,
  // renamed) falls through to the next rather than dropping the whole tier to lexical.
  for (const model of TRANSFORMERS_MODELS) {
    const provider = await loadOneTransformerModel(pipeline, model);
    if (provider) return provider;
  }
  return null;
}

async function loadOneTransformerModel(pipeline: any, model: TransformerModel): Promise<EmbeddingProvider | null> {
  try {
    // TRANSFORMERS-DTYPE: `quantized: true` was transformers.js v2 vocabulary — v3 replaced it with
    // `dtype` and v4 dropped it entirely, so the option had silently been a NO-OP here (the cached
    // model on disk is the fp32 model.onnx, not model_quantized.onnx, which is the proof). Kept at
    // fp32: mixing dtypes inside ONE index degrades cosine between old and new vectors, so dtype is
    // as much a re-embed decision as the model itself, and there is no reason to spend one here.
    const extractor = await pipeline("feature-extraction", model.repo, {
      dtype: "fp32",
      // EMBEDDER-THREAD-CAP: onnxruntime's thread pool defaults to ONE THREAD PER CORE, and it runs
      // inside the daemon process — the same process whose single JS thread answers every RPC. On a
      // 12-core machine that is a dozen inference threads competing with it for CPU. Measured on an
      // operator's machine: the daemon held 25 threads, its main-thread profile was dominated by
      // onnxruntime kernels (MlasGemmBatch, LayerNorm, Softmax, Erf), and a 0.6 KB accounts.list
      // took p50 1481 ms and up to 9 s. The thread was not busy — it was not being SCHEDULED,
      // because background indexing had taken the machine.
      //
      // This encodes the priority the daemon actually has: answering the operator is interactive
      // and must never wait behind index maintenance, which nobody is watching and which has all
      // the time in the world. Measured A/B on one embed of four records: unbounded added 5 threads
      // and stalled the event loop 33 ms; capped adds none and stalls it 6 ms, for the SAME output
      // vectors and, at this batch size, no extra wall-clock.
      //
      // Both knobs on purpose: intraOp parallelises WITHIN one operator (the GEMMs the profile
      // showed), interOp across independent operators. Leaving either unset leaves a pool sized to
      // the machine rather than to this process's job.
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    const encode = async (text: string): Promise<Float32Array> => {
      const res = await extractor(text.slice(0, TRANSFORMERS_MAX_CHARS), { pooling: "mean", normalize: true });
      return Float32Array.from(res.data as ArrayLike<number>);
    };
    return {
      id: "transformers",
      model: model.name,
      dim: TRANSFORMERS_DIM,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        // The prefix is applied BEFORE the length guard on purpose: a truncated passage is still a
        // passage, but a passage missing its prefix is encoded into the wrong region of the space.
        for (const t of texts) out.push(await encode(model.passagePrefix + t));
        return out;
      },
      embedQuery: (text: string): Promise<Float32Array> => encode(model.queryPrefix + text),
    };
  } catch {
    return null;   // model fetch/load failed → caller tries the next candidate
  }
}

// Ollama: reachable-within-300ms probe, then a one-shot dim probe. Local process only (§6.1).
async function loadOllama(host: string, model: string): Promise<EmbeddingProvider | null> {
  const base = host.replace(/\/+$/, "");
  try {
    const reachable = await fetchWithTimeout(`${base}/api/tags`, {}, 300);
    if (!reachable || !reachable.ok) return null;
  } catch {
    return null;
  }
  const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
    const res = await fetchWithTimeout(
      `${base}/api/embed`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }) },
      20_000,
    );
    if (!res || !res.ok) throw new Error(`ollama /api/embed ${res ? res.status : "unreachable"}`);
    const json = (await res.json()) as { embeddings?: number[][] };
    if (!json.embeddings || json.embeddings.length !== texts.length) throw new Error("ollama /api/embed malformed response");
    return json.embeddings.map((v) => Float32Array.from(v));
  };
  // Learn the dim once so the sidecar meta is fixed up front (nomic-embed-text = 768).
  let dim: number;
  try {
    const [probe] = await embedBatch(["dimension probe"]);
    dim = probe.length;
    if (dim === 0) return null;
  } catch {
    return null;
  }
  return { id: "ollama", model, dim, embed: embedBatch };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;   // connection refused / abort / DNS — treated as "provider unavailable"
  } finally {
    clearTimeout(timer);
  }
}
