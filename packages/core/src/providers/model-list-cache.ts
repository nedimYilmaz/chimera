import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// DYNAMIC-MODEL-LISTS: the daemon-wide, DISK-BACKED store of "which models can this provider
// actually select right now". Replaces the former process-lifetime, claude-only singleton
// (providers/claude-models-cache.ts), which had two holes an operator saw directly in every model
// picker: it forgot everything on restart, and it covered exactly one provider.
//
// Why a cache at all: the authoritative list for the agentic-SDK providers is only observable
// from a LIVE session -- claude's is a by-product of the SDK initialize handshake
// (Query.supportedModels()), kimi's rides the ACP `session/new` response as a `configOptions`
// model select. Both are free while an agent is running and cost a whole session otherwise, so
// what a session teaches us has to outlive it, and outlive the daemon.
//
// This is a CACHE, never a source of truth: a miss falls through to a live probe, and a live
// probe's failure falls through to the static provider catalog. Nothing here can make a model
// selectable that the provider would reject -- the backend remains the authority on validity.
export type ModelOption = {
  value: string;
  displayName: string;
  description?: string;
  // EFFORT-ONE-SOURCE: the effort tiers the PROVIDER says this model accepts. Claude delivers
  // these on the initialize handshake (ModelInfo.supportedEffortLevels) that the model list itself
  // already rides on — they were being dropped one line into the map that built this type, so a
  // picker had nothing to go on and every client hardcoded its own list instead.
  //
  // Absent means "this provider has not told us", NOT "no efforts" — effortLevelsFor() falls back
  // to the provider's declared set. Deliberately NOT narrowed to EffortLevel: a provider naming a
  // tier chimera has never heard of should reach the operator, not be silently dropped by a parse.
  supportedEfforts?: string[];
  // False when the provider says this model takes no effort parameter at all (a picker should be
  // disabled, not empty). Absent = unknown.
  supportsEffort?: boolean;
};

type Entry = { models: ModelOption[]; fetchedAt: number };
type Persisted = { version: 1; providers: Record<string, Entry> };

// Long by design: a provider's model list changes on the order of weeks, and the cost of a stale
// entry is one extra name in a picker (free-text is always accepted anyway), while the cost of
// re-probing is a whole CLI session. Any live session refreshes its own provider for free, so in
// practice an actively-used provider is never anywhere near this old.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FILE = "model-lists.json";

export class ModelListCache {
  private file: string;
  private ttlMs: number;
  private entries: Record<string, Entry> = {};

  constructor(homeDir: string, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.file = join(homeDir, FILE);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }
  private now: () => number;

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === "object") {
        for (const [provider, e] of Object.entries(parsed.providers)) {
          if (Array.isArray(e?.models) && e.models.every((m) => typeof m?.value === "string")) {
            this.entries[provider] = { models: e.models, fetchedAt: Number(e.fetchedAt) || 0 };
          }
        }
      }
    } catch {
      // absent/corrupt: an empty cache is always a valid state — every read path already has a
      // probe and a catalog fallback behind it, so there is nothing to recover or report here.
    }
  }

  private persist(): void {
    const doc: Persisted = { version: 1, providers: this.entries };
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2));
      renameSync(tmp, this.file);   // atomic — a concurrent reader never sees a half-written file
    } catch {
      // a read-only/full CHIMERA_HOME must degrade to in-memory caching, never break a probe.
    }
  }

  /** Cached list for `provider`, regardless of age. null when nothing has ever been learned. */
  get(provider: string): ModelOption[] | null {
    const e = this.entries[provider];
    return e && e.models.length ? e.models : null;
  }

  /** True when there is no entry, or the entry is older than the TTL — i.e. worth re-probing. */
  isStale(provider: string): boolean {
    const e = this.entries[provider];
    if (!e || !e.models.length) return true;
    return this.now() - e.fetchedAt > this.ttlMs;
  }

  /** Records a freshly-observed list. Empty input is ignored: a probe that learned nothing must
   *  never overwrite a good entry with a blank one (that is a failed probe, not an empty list). */
  set(provider: string, models: ModelOption[]): void {
    if (!models.length) return;
    this.entries[provider] = { models, fetchedAt: this.now() };
    this.persist();
  }
}

// Module-level handle so a BACKEND (claude.ts / kimi.ts), which observes the list mid-session and
// has no reference to the Engine, can record it without threading the cache through every spawn
// path. Engine's constructor installs it; absent (a bare unit test constructing a backend alone)
// ⇒ record() is a silent no-op, exactly as the previous singleton behaved.
let shared: ModelListCache | null = null;

export function installModelListCache(cache: ModelListCache): void {
  shared = cache;
}

export function recordProviderModels(provider: string, models: ModelOption[]): void {
  shared?.set(provider, models);
}

export function cachedProviderModels(provider: string): ModelOption[] | null {
  return shared?.get(provider) ?? null;
}
