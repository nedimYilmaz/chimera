import type { CodexContextLimits } from "@chimera/protocol";
// SDK-MODEL-LISTS: `codex debug models` is the Codex CLI's own documented catalog dump —
// the exact model ids a subscription-only account (no OPENAI_API_KEY, so the generic
// /v1/models HTTP probe in models.ts never runs at all) can actually select, refreshed by
// the CLI itself in the background (~/.codex/models_cache.json) rather than hardcoded here.
// There is no @openai/codex-sdk surface for this (Thread/Codex only take a model STRING,
// no listing call) — the CLI subcommand is the most reliable source. Bounded + best-effort:
// any failure (binary missing, timeout, malformed JSON) resolves null so the caller
// (engine.ts providers.models) falls back one layer to the HTTP probe, then the catalog.
import { execFile, type ExecFileException } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCodexBinary } from "./codex-cli-path.js";
export { resolveCodexBinary } from "./codex-cli-path.js";

export type CodexCliModel = { value: string; displayName: string; description?: string; supportsToolSearch?: boolean; reasoningEfforts?: string[]; inputModalities?: string[]; contextLimits?: CodexContextLimits };

type RawCodexModel = {
  context_window?: number;
  max_context_window?: number;
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supports_search_tool?: boolean;
  supported_reasoning_levels?: Array<{ effort: string }>;
  input_modalities?: string[];
};

// `reason` is an already-sanitized one-liner (see describeExecFailure) — never raw stderr or an
// Error.message, which can carry paths, argv or credentials.
export type CodexModelsExecFn = (
  cmd: string, args: string[], env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; code: number; reason?: string }>;

const PROBE_TIMEOUT_MS = 15_000;

// Built only from fixed phrases plus an errno/exit code/signal token validated against a strict
// charset, so the text is safe to put in an error that reaches logs and the UI.
function describeExecFailure(err: ExecFileException): string {
  const token = /^[A-Z0-9_]{1,40}$/;
  if (err.killed && err.signal) return `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`;
  if (typeof err.code === "number") return `probe exited with code ${err.code}`;
  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "probe output exceeded the buffer limit";
  if (typeof err.code === "string" && token.test(err.code)) return `probe failed to start (${err.code})`;
  if (typeof err.signal === "string" && token.test(err.signal)) return `probe killed by ${err.signal}`;
  return "probe failed";
}

const realExec: CodexModelsExecFn = (cmd, args, env) =>
  new Promise((resolve) => {
    // maxBuffer pinned well above the ~280 KB this actually emits (each model carries its full
    // instructions template) so a vendor adding models can't silently trip execFile's 1 MB
    // default and turn a working probe back into a static-catalog fallback.
    // execFile can also throw synchronously (e.g. ENOEXEC for a non-executable file); that must
    // surface with the same sanitized reason rather than as an opaque rejection.
    try {
      execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout) =>
        resolve({ stdout: stdout ?? "", code: err ? 1 : 0, ...(err ? { reason: describeExecFailure(err) } : {}) }));
    } catch (err) { resolve({ stdout: "", code: 1, reason: describeExecFailure(err as ExecFileException) }); }
  });

export async function fetchCodexCliModels(
  opts: { env?: NodeJS.ProcessEnv; exec?: CodexModelsExecFn } = {},
): Promise<CodexCliModel[] | null> {
  const exec = opts.exec ?? realExec;
  const env = opts.env ?? process.env;
  try {
    const { stdout, code } = await exec(resolveCodexBinary(env), ["debug", "models"], env);
    if (code !== 0 || !stdout.trim()) return null;
    const parsed = JSON.parse(stdout) as { models?: RawCodexModel[] };
    // `visibility: "list"` is the CLI's own /model-picker filter (matches what a real
    // `codex` session's picker shows) — "hide" entries are deprecated/internal (e.g.
    // codex-auto-review) and would confuse the spawn form's dropdown.
    const models = (parsed.models ?? [])
      .filter((m): m is RawCodexModel & { slug: string } => m.visibility === "list" && typeof m.slug === "string")
      .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
      .map((m) => ({
        value: m.slug,
        ...(m.context_window || m.max_context_window ? { contextLimits: codexContextLimits(m) } : {}),
        displayName: m.display_name ?? m.slug,
        ...(m.description ? { description: m.description } : {}),
        ...(typeof m.supports_search_tool === "boolean" ? { supportsToolSearch: m.supports_search_tool } : {}),
        ...(Array.isArray(m.supported_reasoning_levels) ? { reasoningEfforts: m.supported_reasoning_levels.map((e) => e.effort) } : {}),
        ...(Array.isArray(m.input_modalities) ? { inputModalities: m.input_modalities } : {}),
      }));
    return models.length ? models : null;
  } catch {
    return null;
  }
}

// A capability probe is a ~280 KB `codex debug models` subprocess with a 15s timeout, and it runs
// on EVERY turn of EVERY codex agent. Three bounds keep one flaky probe from either killing
// healthy long-lived sessions or becoming a probe storm:
//  - FRESH: a successful catalog is reused for 60s (the original cache TTL).
//  - RETRY: a FAILED probe is remembered only briefly — long enough that a burst of turns shares
//    one failure instead of each spawning the CLI, short enough that recovery is picked up fast.
//    It used to be cached for the full 60s, so one blip failed every agent that turned in that
//    window rather than retrying a recovered probe.
//  - STALE_MAX: when a refresh fails, the last catalog that DID verify for the same context may
//    still gate the turn, but only this long — a sustained outage must still surface eventually.
export const CODEX_CAPABILITY_CACHE_MS = { fresh: 60_000, retry: 5_000, staleMax: 30 * 60_000 } as const;

type ProbeOutcome = { models: RawCodexModel[] } | { reason: string };
type CapabilityEntry = {
  verified?: { models: RawCodexModel[]; at: number };
  failure?: { at: number; reason: string };
  inflight?: Promise<ProbeOutcome>;
};

const boundedReason = (reason: string): string => reason.replace(/[^\x20-\x7e]/g, "").slice(0, 120) || "probe failed";

// Account identity inside a CODEX_HOME, so logging in as someone else without changing the path
// can't be served the previous account's catalog. Only identity fields — never mtime/size, which
// a routine token refresh rewrites — and the result is only ever fed to a hash, never returned.
function authIdentity(env: NodeJS.ProcessEnv): string {
  try {
    const file = join(env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex"), "auth.json");
    if (statSync(file).size > 256 * 1024) return "";
    const auth = JSON.parse(readFileSync(file, "utf8")) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { account_id?: unknown; id_token?: unknown } };
    let subject = "";
    try {
      const payload = typeof auth.tokens?.id_token === "string" ? auth.tokens.id_token.split(".")[1] : undefined;
      if (payload) subject = String((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub ?? "");
    } catch { /* an opaque id_token just contributes no subject */ }
    return JSON.stringify([auth.auth_mode, auth.OPENAI_API_KEY, auth.tokens?.account_id, subject]);
  } catch { return ""; }
}

function capabilityKey(binary: string, env: NodeJS.ProcessEnv): string {
  let stamp = "";
  try { const stat = statSync(binary); stamp = `${stat.size}:${stat.mtimeMs}`; } catch { /* PATH resolution; TTL still bounds cache age. */ }
  return createHash("sha256").update(JSON.stringify([binary, stamp, env.CODEX_HOME, env.CODEX_API_KEY, env.OPENAI_API_KEY, authIdentity(env)])).digest("hex");
}

export type CodexModelValidator = (
  model: string | undefined, effort: string | undefined, hasImages: boolean, env: NodeJS.ProcessEnv,
) => Promise<CodexContextLimits | void>;

// The production cache logic as a factory so tests (and any caller) can drive the real thing with
// an injected exec/clock — the `exec` parameter of validateCodexModel deliberately builds a
// throwaway instance instead, to keep every call there an independent probe.
// The default clock is a lambda, not `Date.now` itself: the bare function would be captured at
// module load and keep ticking real time under fake timers.
export function createCodexModelValidator(exec: CodexModelsExecFn, now: () => number = () => Date.now()): CodexModelValidator {
  const entries = new Map<string, CapabilityEntry>();

  const probe = async (binary: string, env: NodeJS.ProcessEnv): Promise<ProbeOutcome> => {
    try {
      const { stdout, code, reason } = await exec(binary, ["debug", "models"], env);
      if (code !== 0) return { reason: boundedReason(reason ?? `probe exited with code ${code}`) };
      let parsed: { models?: RawCodexModel[] };
      try { parsed = JSON.parse(stdout) as typeof parsed; } catch { return { reason: "probe returned invalid JSON" }; }
      if (!Array.isArray(parsed.models)) return { reason: "probe returned no models array" };
      // An empty catalog can't be told apart from a degraded refresh, and accepting it would let
      // it replace a good verified catalog — same shape as the failure this exists to absorb.
      if (!parsed.models.length) return { reason: "probe returned an empty model list" };
      return { models: parsed.models };
    } catch { return { reason: "probe could not run" }; }
  };

  const refresh = (entry: CapabilityEntry, binary: string, env: NodeJS.ProcessEnv): Promise<ProbeOutcome> => {
    const t = now();
    if (entry.verified && t - entry.verified.at < CODEX_CAPABILITY_CACHE_MS.fresh) return Promise.resolve({ models: entry.verified.models });
    if (entry.inflight) return entry.inflight;   // concurrent turns share one subprocess
    if (entry.failure && t - entry.failure.at < CODEX_CAPABILITY_CACHE_MS.retry) return Promise.resolve({ reason: entry.failure.reason });
    const inflight = probe(binary, env).then((outcome) => {
      entry.inflight = undefined;
      if ("models" in outcome) { entry.verified = { models: outcome.models, at: now() }; entry.failure = undefined; }
      else entry.failure = { at: now(), reason: outcome.reason };
      return outcome;
    });
    entry.inflight = inflight;
    return inflight;
  };

  return async (model, effort, hasImages, env) => {
    if (typeof model !== "string" || !model.trim()) throw new Error("Codex model must be a non-empty string; select a model in the agent settings");
    const binary = resolveCodexBinary(env);
    const key = capabilityKey(binary, env);
    let entry = entries.get(key);
    if (entry) entries.delete(key);   // re-insert below: Map order doubles as LRU
    else {
      entry = {};
      if (entries.size >= 64) entries.delete(entries.keys().next().value!);
    }
    entries.set(key, entry);

    const outcome = await refresh(entry, binary, env);
    const unavailable = (detail: string) => new Error(`Codex model capabilities unavailable: ${"reason" in outcome ? outcome.reason : "unknown"}; ${detail}`);
    let models: RawCodexModel[];
    let staleMs: number | undefined;
    if ("models" in outcome) models = outcome.models;
    else {
      const verified = entry.verified;
      staleMs = verified ? now() - verified.at : undefined;
      if (!verified || staleMs === undefined || staleMs > CODEX_CAPABILITY_CACHE_MS.staleMax) {
        throw unavailable(verified ? `last verified catalog is ${Math.round(staleMs! / 60_000)}m old (limit ${CODEX_CAPABILITY_CACHE_MS.staleMax / 60_000}m)` : "no verified catalog yet for this Codex CLI and account");
      }
      models = verified.models;
    }
    const match = models.filter((m) => typeof m.slug === "string" && (model === m.slug || model.startsWith(`${m.slug}-`)))
      .sort((a, b) => b.slug!.length - a.slug!.length)[0];
    // A model absent from an OUTDATED catalog isn't proven unsupported — it may be newer than the
    // catalog — so it reports as unavailable rather than as a capability mismatch.
    if (!match && staleMs !== undefined) throw unavailable(`last verified catalog (${Math.round(staleMs / 1000)}s old) does not list ${model}`);
    if (!match?.supports_search_tool) throw new Error(`Codex tool-schema deferral is inactive: model ${model} does not advertise tool search`);
    if (effort && match.supported_reasoning_levels?.length && !match.supported_reasoning_levels.some((e) => e.effort === effort)) throw new Error(`Codex model ${model} does not support reasoning effort ${effort}`);
    if (hasImages && match.input_modalities && !match.input_modalities.includes("image")) throw new Error(`Codex model ${model} does not support image input`);
    return codexContextLimits(match);
  };
}

const productionValidator = createCodexModelValidator(realExec);

export async function validateCodexModel(
  model: string | undefined, effort: string | undefined, hasImages: boolean,
  env: NodeJS.ProcessEnv, exec?: CodexModelsExecFn,
): Promise<CodexContextLimits | void> {
  return (exec ? createCodexModelValidator(exec) : productionValidator)(model, effort, hasImages, env);
}


function codexContextLimits(model: RawCodexModel): CodexContextLimits {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  return { source: "codex",
    ...(positive(model.context_window) ? { defaultWindow: model.context_window } : {}),
    ...(positive(model.max_context_window) ? { maxWindow: model.max_context_window } : {}),
  };
}
