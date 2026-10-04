import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ChimeraConfigSchema, isConfigPatchNull, type ChimeraConfig } from "@chimera/protocol";
import { ConfigError } from "./accounts.js";

// D7 (config management, coverage C9/C10 · B16). The effective config is
// `config.json` (USER-OWNED, read-only to the daemon) overlaid by every
// `${home}/config.d/*.json` file, JSON-merge-patch semantics (RFC 7396: null
// deletes a key), overlays sorted lexically so ordering is deterministic and
// `ui.json` (the daemon's OWN write target) lands where its name sorts. Precedence
// is therefore overlay > config. All daemon-side writes go to `config.d/ui.json`;
// `config.json` is never touched.

const CONFIG_D = "config.d";
const UI_OVERLAY = "ui.json";

// RFC 7396 JSON Merge Patch. A non-object patch (scalar/array/null) REPLACES the
// target; null at a key DELETES it; nested objects recurse. Arrays are values, so a
// patched array wholly replaces (never element-merges) — callers that "add" to an
// array write the full new array.
//
// One deviation from RFC 7396, protocol's CONFIG_PATCH_NULL: the string "$null" at a key
// SETS that key to null. Under the plain RFC there is no way to express an explicit null in
// an overlay at all (it would delete itself), yet some keys are meaningfully null —
// providerOverrides.<id>.compactionThreshold = null means "native backend compaction". The
// escape is resolved HERE, at load time, because ui.json is re-applied as a merge patch on
// every reload; a null materialised at write time would not survive the next read.
export function jsonMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (isConfigPatchNull(v)) base[k] = null;
    else if (v === null) delete base[k];
    else base[k] = jsonMergePatch(base[k], v);
  }
  return base;
}

// Compose an incoming merge-patch ONTO the stored overlay document (config.d/ui.json),
// PRESERVING null deletion markers. The overlay is itself a merge-patch applied over
// config.json at load, so a `null` must survive INTO ui.json to keep deleting the base
// key (plain jsonMergePatch would instead strip the key from the overlay and the base
// value would resurface). Non-null values overwrite; nested objects recurse. This is the
// write-time composition; jsonMergePatch remains the load-time application.
// The CONFIG_PATCH_NULL escape needs no case here on purpose: it is an ordinary non-null
// scalar, so it overwrites and persists into ui.json like any value, and a later real value
// (or a later real null, i.e. "stop overriding") correctly supersedes it.
export function composeOverlay(existing: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) base[k] = null; // keep the deletion marker in the overlay
    else base[k] = composeOverlay(base[k], v);
  }
  return base;
}

// Credential-value redaction for `config.get`. We redact by KEY NAME (SUBSTRING,
// case-insensitive) so only fields that hold a secret VALUE are blanked — presence
// stays visible. The word list is the SAME strategy the federation guard uses
// (packages/protocol RESERVED_CREDENTIAL_WORD) so the D0 "secrets never leave the
// daemon" invariant has ONE matcher, not two divergent ones: a future field named
// e.g. refreshToken / clientSecret / privateKey is caught here just as it would be at
// the federation boundary (the prior anchored exact-match list would have let it
// through). `run` (a command-auth's inline secret) carries no credential word, so it
// is listed explicitly; `password` extends the shared word list for config's sake.
const SECRET_KEY_RE = /auth|token|key|secret|credential|password|^run$/i;
// Reference-shaped keys that TRIP SECRET_KEY_RE yet hold no secret VALUE stay readable
// so the UI can render account/key status — mirrors protocol's SAFE_PROVIDER_OPTION_KEYS
// carve-out. `publicKey` (a peer's base64 ed25519 key) and `credentialType`
// (OAUTH-TOKEN-ACCOUNTS: a classification TAG — "apiKey"/"oauthToken"/"adminKey" — never
// a secret value) both qualify. Other reference fields (auth.service, auth.var,
// auth.injectAs, socketPath, ...) contain no credential word and are never matched.
const SAFE_REFERENCE_KEY_RE = /^(publicKey|credentialType)$/i;

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isSecret = SECRET_KEY_RE.test(k) && !SAFE_REFERENCE_KEY_RE.test(k);
      out[k] = isSecret && typeof v === "string" ? "REDACTED" : redactConfig(v);
    }
    return out;
  }
  return value;
}

// Strip secret-SHAPED substrings from a free-text string (config_error messages) so a
// validation error derived from bad config content can never carry a live key into the
// event log (D0). Targets the well-known key prefixes; leaves ordinary words untouched.
export function scrubSecretShapes(text: string): string {
  return text.replace(/\b(?:sk|tskey)-[A-Za-z0-9._-]{6,}/g, "[REDACTED]");
}

function overlayFiles(home: string): string[] {
  const dir = join(home, CONFIG_D);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

function readBaseRaw(home: string): unknown {
  const file = join(home, "config.json");
  // ONBOARDING-PROVIDER: a brand-new $CHIMERA_HOME has no config.json yet — treat that as
  // "everything defaults" (accounts: [], autoOrder: [], ...) rather than a boot-time crash,
  // so the daemon comes up and the app can walk the operator through connecting a provider.
  // config.json stays user-owned either way: the daemon never writes one on its behalf.
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`cannot parse ${file}: ${(e as Error).message}`);
  }
}

// Merge base + every overlay (in sorted order); `overrideUi` substitutes a candidate
// ui.json content (used by patch() to validate BEFORE writing) — appended last when no
// ui.json exists yet, so a first-ever write still takes highest precedence among peers.
function mergeEffectiveRaw(home: string, overrideUi?: { content: unknown }): unknown {
  let merged = readBaseRaw(home);
  let sawUi = false;
  for (const f of overlayFiles(home)) {
    let patch: unknown;
    try {
      patch = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      throw new ConfigError(`cannot parse overlay ${basename(f)}: ${(e as Error).message}`);
    }
    if (overrideUi && basename(f) === UI_OVERLAY) {
      merged = jsonMergePatch(merged, overrideUi.content);
      sawUi = true;
    } else {
      merged = jsonMergePatch(merged, patch);
    }
  }
  if (overrideUi && !sawUi) merged = jsonMergePatch(merged, overrideUi.content);
  return merged;
}

// Zod parse + the same cross-field checks loadConfig applies (duplicate account names,
// autoOrder references a known account). Kept here (not shared with loadConfig) so the
// Phase-1 loadConfig stays byte-for-byte untouched (D0 additive-only).
export function validateConfig(raw: unknown): ChimeraConfig {
  const parsed = ChimeraConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(`invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const names = new Set(parsed.data.accounts.map((a) => a.name));
  if (names.size !== parsed.data.accounts.length)
    throw new ConfigError(`duplicate account name in config (account names must be unique)`);
  for (const n of parsed.data.autoOrder)
    if (!names.has(n)) throw new ConfigError(`autoOrder references unknown account "${n}"`);
  return parsed.data;
}

export function loadEffectiveConfig(home: string): ChimeraConfig {
  return validateConfig(mergeEffectiveRaw(home));
}

// Top-level keys whose serialized value differs between two configs. Both are
// zod-parsed ChimeraConfig objects, so key sets match and JSON.stringify ordering is
// stable per schema field order.
export function diffTopKeys(a: ChimeraConfig, b: ChimeraConfig): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) changed.push(k);
  }
  return changed;
}

// The authoritative in-memory effective config, plus the daemon's overlay writer.
// Holds the last-good ChimeraConfig; reload()/patch() recompute it from disk and, on
// success, swap it and return the changed top-level keys for the engine to diff-apply.
export class ConfigStore {
  private cfg: ChimeraConfig;

  constructor(private home: string) {
    this.cfg = loadEffectiveConfig(home);
    this.migrateLegacyAccountAuth();
  }

  // SUBSCRIPTION-CONNECT: AccountAuthSchema's preprocess step already migrates the legacy
  // "default-login" literal to "subscription" IN MEMORY on every load (this.cfg always
  // reads "subscription"), but config.json/overlay files written before this change still
  // say "default-login" ON DISK. Self-heal once at boot: if the raw merged JSON still
  // contains the old literal anywhere in accounts, write the already-migrated
  // `this.cfg.accounts` (validated, all "subscription") into the ui.json overlay — which
  // takes precedence over config.json — so every load after this one reads "subscription"
  // straight off disk. Reuses patch()'s own compose/validate/write path rather than
  // duplicating it; a no-op when nothing is stale.
  private migrateLegacyAccountAuth(): void {
    const raw = mergeEffectiveRaw(this.home) as { accounts?: unknown };
    const stale = Array.isArray(raw.accounts)
      && raw.accounts.some((a) => (a as { auth?: { type?: unknown } } | null)?.auth?.type === "default-login");
    if (!stale) return;
    this.patch({ accounts: this.cfg.accounts });
  }

  current(): ChimeraConfig {
    return this.cfg;
  }

  // config.get: the EFFECTIVE merged config with every credential-bearing value
  // REDACTED (presence still visible). Returns a fresh redacted copy — never the live
  // object — so no caller can mutate the store's state.
  redacted(): unknown {
    return redactConfig(this.cfg);
  }

  private uiPath(): string {
    return join(this.home, CONFIG_D, UI_OVERLAY);
  }

  private readUiRaw(): Record<string, unknown> {
    const p = this.uiPath();
    if (!existsSync(p)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new ConfigError(`cannot parse overlay ${UI_OVERLAY}: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new ConfigError(`overlay ${UI_OVERLAY} must be a JSON object`);
    return parsed as Record<string, unknown>;
  }

  private writeUi(content: Record<string, unknown>): void {
    const dir = join(this.home, CONFIG_D);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.uiPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(content, null, 2));
    renameSync(tmp, this.uiPath()); // atomic: no torn overlay
  }

  // config.patch: JSON-merge-patch onto config.d/ui.json, re-validated (zod + cross-field)
  // as part of the FULL effective config BEFORE anything is written. Invalid → throw,
  // nothing written, old config stays. Valid → write ui.json, swap current, return the
  // changed top-level keys.
  patch(patch: unknown): { config: ChimeraConfig; changed: string[] } {
    // Null deletion markers must PERSIST into ui.json (see composeOverlay) so they keep
    // deleting the base key at load time.
    const newUi = composeOverlay(this.readUiRaw(), patch);
    const uiContent: Record<string, unknown> =
      newUi !== null && typeof newUi === "object" && !Array.isArray(newUi) ? (newUi as Record<string, unknown>) : {};
    const candidate = mergeEffectiveRaw(this.home, { content: uiContent });
    const config = validateConfig(candidate); // throws → nothing written
    const changed = diffTopKeys(this.cfg, config);
    this.writeUi(uiContent);
    this.cfg = config;
    return { config, changed };
  }

  // Hot-reload: recompute the effective config from disk and validate. Throws on a broken
  // config.json / overlay (caller keeps the old config and emits config_error). Valid →
  // swap current, return changed top-level keys ([] when nothing effectively changed).
  reload(): { config: ChimeraConfig; changed: string[] } {
    const config = loadEffectiveConfig(this.home);
    const changed = diffTopKeys(this.cfg, config);
    this.cfg = config;
    return { config, changed };
  }
}

// The debounced filesystem watcher. Watches config.json AND the config.d directory; any
// event schedules a single onReload after `debounceMs` (a burst of writes coalesces into
// one reload). Timer functions are injectable so tests drive the debounce with a fake
// clock and never touch real fs.watch.
export type WatchHandle = { close(): void };
export type WatchFn = (path: string, listener: () => void) => WatchHandle;

export class ConfigWatcher {
  private handles: WatchHandle[] = [];
  private timer: unknown = null;
  private debounceMs: number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  private watchFn: WatchFn;

  constructor(
    private opts: {
      home: string;
      onReload: () => void;
      debounceMs?: number;
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (h: unknown) => void;
      watch?: WatchFn;
    },
  ) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.watchFn = opts.watch ?? ((p, l) => watch(p, l));
  }

  start(): void {
    const dir = join(this.opts.home, CONFIG_D);
    mkdirSync(dir, { recursive: true }); // so watching the overlay dir never throws on a fresh home
    // A failing watch (e.g. missing config.json) must never crash the daemon — the config
    // still loaded once at boot; live reload is best-effort.
    try { this.handles.push(this.watchFn(join(this.opts.home, "config.json"), () => this.trigger())); } catch { /* best-effort */ }
    try { this.handles.push(this.watchFn(dir, () => this.trigger())); } catch { /* best-effort */ }
  }

  // A change signal: (re)arm the single debounce timer.
  private trigger(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.opts.onReload();
    }, this.debounceMs);
  }

  // Test hook: simulate a filesystem change without a real fs event.
  poke(): void {
    this.trigger();
  }

  stop(): void {
    for (const h of this.handles) {
      try { h.close(); } catch { /* already closed */ }
    }
    this.handles = [];
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
