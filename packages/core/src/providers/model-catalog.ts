import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMetadataLookup, ModelPricing, ModelCatalogConfig } from "@chimera/protocol";

// DYNAMIC-MODEL-METADATA: the layered per-model context-window + pricing resolver.
//
// Resolution order (first hit wins), realized jointly by this service and protocol's pure
// pricing.ts functions:
//   1. config.json `modelCatalog.overrides`  — user-pinned, held here (read live per lookup).
//   2. cached remote catalog                 — LiteLLM's model_prices_and_context_window.json,
//                                               fetched on boot + refreshed on a TTL, persisted in
//                                               CHIMERA_HOME (atomic write; stale cache served on
//                                               fetch failure, so offline never breaks anything).
//   3. provider API metadata                 — SEAM ONLY (no-op today): the providers.models path
//                                               (claude CLI cache / codex `debug models` / OpenAI &
//                                               Anthropic /v1/models) exposes model IDs + display
//                                               names but NOT context length or pricing, so there
//                                               is nothing to read yet. Kept as a documented hook
//                                               (providerLayer below) for when a provider API does.
//   4. hardcoded map (protocol MODEL_CONTEXT_WINDOWS/MODEL_PRICING) — the last-resort fallback,
//                                               applied by protocol's contextWindowFor/pricingFor
//                                               AFTER this lookup returns undefined.
//
// This class implements ModelMetadataLookup (layers 1-3); it deliberately does NOT re-implement
// layer 4 — returning `undefined` lets protocol apply the hardcoded map then DEFAULT, keeping one
// source of truth for the fallback figures. Unknown model ⇒ every layer misses ⇒ protocol's
// DEFAULT_CONTEXT_WINDOW / null-pricing behavior is preserved exactly.

export type CatalogEntry = { contextWindow?: number; pricing?: ModelPricing; maxOutputTokens?: number };
type PersistedCatalog = { fetchedAt: number; url: string; entries: Record<string, CatalogEntry> };

const CATALOG_FILE = "model-catalog.json";
// A single fetch must never hang boot — the refresh is fire-and-forget, but bound it anyway so a
// stuck socket doesn't leak a pending request for the whole daemon lifetime.
const FETCH_TIMEOUT_MS = 15_000;

export class ModelCatalogService implements ModelMetadataLookup {
  private remote = new Map<string, CatalogEntry>();
  private remoteFetchedAt = 0;
  private remoteUrl = "";
  private inflight: Promise<void> | null = null;
  private readonly path: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  // `config` is an accessor (not a snapshot) so `overrides` reflect the live config on every
  // lookup — a config.patch to modelCatalog.overrides applies immediately, without a restart. The
  // `remote` fetch policy is only consulted at init()/refresh() time (boot-time-only, documented on
  // the config schema), so reading it fresh here is harmless.
  constructor(private readonly config: () => ModelCatalogConfig, opts: {
    home: string;
    now?: () => number;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
  }) {
    this.path = join(opts.home, CATALOG_FILE);
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  // ---- ModelMetadataLookup (layers 1-3) ----

  contextWindow(model: string): number | undefined {
    return this.config().overrides[model]?.contextWindow
      ?? this.remoteContextWindow(model)
      ?? this.providerLayer(model)?.contextWindow;
  }

  // CTX-METER-DENOM (measured 2026-07-25, see chimera/tokenopt memory ad6c48c0 + this
  // commit's landing report): LiteLLM's cached catalog reports each Claude model's MAXIMUM
  // capability — 1,000,000 for claude-opus-4-8/claude-opus-5/claude-sonnet-5 — which is only
  // reachable with the `context-1m-2025-08-07` beta (Options.betas, sdk.d.ts's SdkBeta union).
  // claude.ts never sets `betas` anywhere (grepped), so every chimera Claude spawn runs the
  // real Anthropic STANDARD tier: 200,000. Trusting remote's number here silently rendered the
  // ctx meter ~5x too generous (a live 83,405-token ledger max showed as 8% instead of the
  // correct 42%). Remote is fine for every non-Claude model (e.g. gpt-5.6-sol's 1.05M, which
  // OpenAI doesn't beta-gate) — this is an Anthropic-specific carve-out, not a general remote
  // distrust. protocol's hardcoded MODEL_CONTEXT_WINDOWS (layer 4, already 200_000 for every
  // Claude id here) takes over once this returns undefined. Revisit if claude.ts ever starts
  // requesting the beta.
  //
  // CONTEXT-WINDOW-TRAP-UNVERIFIED (re-checked 2026-07-28, now that 55ae9ac's generic backend
  // uses this number to DECIDE WHEN TO COMPACT, not just to render a meter): does the same
  // max-vs-default split apply to openai-compat.ts / gemini-native.ts models? No — grepped both
  // clients plus registry.ts and neither ever sends a request-level opt-in (no `betas`-equivalent
  // param/header) that would unlock a bigger window on the SAME model id. Anthropic's trap is
  // specifically that claude-opus-4-8 answers to two different windows depending on an unset
  // request flag; OpenAI and Google instead publish distinct model ids per tier (e.g.
  // gpt-5.6-sol vs -terra vs -luna are separate MODEL_CONTEXT_WINDOWS rows here, not one id with
  // a hidden ceiling), so whatever LiteLLM reports for a given id is that id's real, always-on
  // window. gpt-5.6-sol's remote 1.05M was independently re-verified against OpenAI's own docs
  // (see pricing.ts's P0-3 comment) and matches. No Gemini id has a hardcoded row yet, so it
  // resolves via remote or DEFAULT_CONTEXT_WINDOW today — also fine, same reasoning. Conclusion:
  // this carve-out does not need to extend to other providers unless one of them grows an
  // Anthropic-style same-id opt-in beta.
  private remoteContextWindow(model: string): number | undefined {
    if (model.startsWith("claude-") || model.startsWith("anthropic.") || model.startsWith("anthropic/")) return undefined;
    return this.remote.get(model)?.contextWindow;
  }

  pricing(model: string): ModelPricing | undefined {
    return this.config().overrides[model]?.pricing
      ?? this.remote.get(model)?.pricing
      ?? this.providerLayer(model)?.pricing;
  }

  // TRUNCATION-SURFACE: same 3-layer order as contextWindow/pricing. LiteLLM's
  // `max_output_tokens` is a genuinely distinct field from the `max_input_tokens`/`max_tokens`
  // pair contextWindow reads (see parseLiteLlmCatalog) — no Anthropic-style same-id carve-out
  // needed here since output ceilings aren't beta-gated the way the 1M context window is.
  maxOutputTokens(model: string): number | undefined {
    return this.config().overrides[model]?.maxOutputTokens
      ?? this.remote.get(model)?.maxOutputTokens
      ?? this.providerLayer(model)?.maxOutputTokens;
  }

  // Layer 3 hook — no provider API carries context/pricing today (see class header). Returns
  // undefined so lookups fall straight to protocol's hardcoded fallback. Wire a real source here
  // when one appears; nothing else changes.
  private providerLayer(_model: string): CatalogEntry | undefined {
    return undefined;
  }

  // ---- lifecycle ----

  // Loads the persisted cache (fast, local), then — if remote is enabled and the cache is
  // stale/absent — kicks a background refresh. NEVER blocks boot on the network: the returned
  // promise resolves as soon as the local load completes; the fetch (if any) runs detached.
  async init(): Promise<void> {
    await this.loadPersisted();
    const { remote } = this.config();
    if (remote.enabled && this.isStale()) void this.refresh();
  }

  private isStale(): boolean {
    // A never-fetched cache (remoteFetchedAt === 0, i.e. no persisted file or a file with no
    // timestamp) is ALWAYS stale — independent of the wall clock — so first boot always refreshes.
    if (this.remoteFetchedAt === 0) return true;
    const ttlMs = this.config().remote.ttlHours * 60 * 60 * 1000;
    return this.now() - this.remoteFetchedAt >= ttlMs;
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as PersistedCatalog;
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        this.remote = new Map(Object.entries(parsed.entries));
        this.remoteFetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
        this.remoteUrl = typeof parsed.url === "string" ? parsed.url : "";
      }
    } catch {
      // No cache yet (first boot) or a corrupt/unreadable file — start empty; a successful
      // refresh will (re)write it. Offline + no cache ⇒ layers 1/4 still fully functional.
    }
  }

  // Fetch → parse → atomic persist → one status line. On ANY failure keeps the current (stale or
  // empty) cache and logs a single fallback line — an offline or rate-limited daemon degrades
  // silently to layer 4, never crashes. De-duped: concurrent callers share one in-flight fetch.
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const { remote } = this.config();
    const url = remote.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      const entries = parseLiteLlmCatalog(json);
      if (Object.keys(entries).length === 0) throw new Error("catalog parsed to 0 usable entries");
      this.remote = new Map(Object.entries(entries));
      this.remoteFetchedAt = this.now();
      this.remoteUrl = url;
      await this.persist({ fetchedAt: this.remoteFetchedAt, url, entries });
      this.log(`chimerad: model catalog refreshed from ${url} — ${this.remote.size} models`);
    } catch (err) {
      const detail = (err as Error).message;
      const served = this.remote.size > 0
        ? `serving stale cache (${this.remote.size} models${this.remoteUrl ? `, from ${this.remoteUrl}` : ""})`
        : "falling back to the hardcoded model map";
      this.log(`chimerad: model catalog fetch failed (${detail}) — ${served}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(data: PersistedCatalog): Promise<void> {
    // Atomic write: tmp + rename, so a crash mid-write can never leave a half-written cache that
    // loadPersisted would choke on. Best-effort — a persist failure only costs a re-fetch next boot.
    const tmp = `${this.path}.tmp.${process.pid}`;
    try {
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await rename(tmp, this.path);
    } catch {
      // disk full / read-only CHIMERA_HOME — the in-memory catalog is still live this run.
    }
  }
}

// LiteLLM schema → CatalogEntry. LiteLLM is a flat {modelId: {...}} map with per-TOKEN costs and
// max_input_tokens/max_tokens context. We convert per-token → per-MTok (×1e6) to match ModelPricing.
// A model contributes a pricing entry only when it has BOTH input and output token costs (a
// context-only entry still contributes its window). cache-read cost defaults to the repo's
// established 90%-discount convention (10% of input) when LiteLLM omits it. Non-object values (the
// "sample_spec" doc key) and entries with neither a usable window nor pricing are skipped.
//
// PERMANENT COVERAGE GAP — GLM/Kimi/Fireworks (PROVIDER-CATALOG-REFRESH-2026-08, memory
// 02eaf120): this map's keys are LiteLLM's OWN routing-prefixed ids (e.g. "zai/glm-5.2",
// "fireworks_ai/accounts/fireworks/models/kimi-k2p6") — a proxy-library convention, not the
// vendor's native API model-id string. Chimera sends the bare vendor id ("glm-5.2", "kimi-k3")
// straight to each vendor's own endpoint, which never matches a prefixed key here. This is
// STRUCTURAL, not staleness: no future LiteLLM refresh will self-heal it, because the mismatch
// is in the key shape, not the data. protocol's hardcoded MODEL_PRICING/MODEL_CONTEXT_WINDOWS
// table is therefore the PERMANENT, only source of truth for GLM/Kimi/Fireworks-routed pricing —
// treat it as authoritative for those providers, not as a stopgap pending a catalog refresh.
export function parseLiteLlmCatalog(json: Record<string, unknown>): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  for (const [model, raw] of Object.entries(json)) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const window = num(m["max_input_tokens"]) ?? num(m["max_tokens"]);
    // TRUNCATION-SURFACE: `max_output_tokens` is LiteLLM's own distinct output-cap field — NOT
    // the same key `window` falls back to (`max_tokens` there means "no max_input_tokens row,
    // treat the model's single reported cap as the context window", the same ambiguity LiteLLM's
    // schema itself carries for older entries). When a row has both, they're independent.
    const outputCap = num(m["max_output_tokens"]);
    const inTok = num(m["input_cost_per_token"]);
    const outTok = num(m["output_cost_per_token"]);
    const entry: CatalogEntry = {};
    if (window !== undefined && window > 0) entry.contextWindow = Math.round(window);
    if (outputCap !== undefined && outputCap > 0) entry.maxOutputTokens = Math.round(outputCap);
    if (inTok !== undefined && outTok !== undefined) {
      const inputPerMTok = inTok * 1_000_000;
      const cacheTok = num(m["cache_read_input_token_cost"]);
      // W2-2 CACHE-WRITE-TTL: LiteLLM's real schema carries these two DISTINCT per-token costs
      // for a cache write — `cache_creation_input_token_cost` (Anthropic's 5m/base tier, and
      // GPT-5.6's only tier) and `cache_creation_input_token_cost_above_1hr` (Anthropic's 1h
      // tier), verified via https://github.com/BerriAI/litellm/pull/14620 and
      // model_prices_and_context_window.json. Left unset (not defaulted) when LiteLLM omits
      // them — unlike cachedInputPerMTok above, there's no single safe repo-wide default to
      // fabricate here; pricing.ts's computeCostUsd already has a documented, model-aware
      // fallback (unresolvedTtlCacheWriteRate) for exactly this "unset" case.
      const cacheWrite5mTok = num(m["cache_creation_input_token_cost"]);
      const cacheWrite1hTok = num(m["cache_creation_input_token_cost_above_1hr"]);
      entry.pricing = {
        inputPerMTok,
        outputPerMTok: outTok * 1_000_000,
        cachedInputPerMTok: cacheTok !== undefined ? cacheTok * 1_000_000 : inputPerMTok * 0.1,
        ...(cacheWrite5mTok !== undefined ? { cacheWrite5mPerMTok: cacheWrite5mTok * 1_000_000 } : {}),
        ...(cacheWrite1hTok !== undefined ? { cacheWrite1hPerMTok: cacheWrite1hTok * 1_000_000 } : {}),
      };
    }
    if (entry.contextWindow !== undefined || entry.pricing !== undefined || entry.maxOutputTokens !== undefined) out[model] = entry;
  }
  return out;
}
