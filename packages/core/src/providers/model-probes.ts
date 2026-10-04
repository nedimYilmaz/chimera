import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { kimiModelOptions } from "../backends/kimi.js";
import type { ModelOption } from "./model-list-cache.js";

// DYNAMIC-MODEL-LISTS (probes): for the two agentic-SDK providers the live model list is a
// BY-PRODUCT of a session -- claude's rides the SDK initialize handshake, kimi's rides the ACP
// newSession response. Recording what a running agent teaches us (backends/claude.ts,
// backends/kimi.ts) is free but leaves a real hole: right after a daemon restart, before anyone
// has spawned that provider, every model picker in the TUI and the app falls back to the STATIC
// catalog -- which for kimi meant ONE model while the CLI offered four, and for a codex spawn
// meant being shown claude's names. These probes close that hole: one deliberate, short-lived,
// prompt-less session whose only purpose is to read the list, cached to disk afterwards so the
// cost is paid at most once per TTL per provider.
//
// Every probe is best-effort by contract: any failure (binary absent, not logged in, timeout,
// unexpected shape) resolves [] and the caller falls through to its next layer. A probe must
// never throw into an RPC and never block a spawn.

const PROBE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new Error("model probe timed out")); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Mirrors backends/kimi.ts's own well-known lookup so the probe and the agents describe the SAME
// CLI. Deliberately NOT PATH-based — see codex-cli-models.ts's CODEX-MODELS-PATH-DEPENDENT note
// for what a GUI-launched daemon's PATH actually contains.
export function resolveKimiBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env["CHIMERA_KIMI_CLI_PATH"];
  if (override) return existsSync(override) ? override : null;
  const wellKnown = join(homedir(), ".kimi-code", "bin", "kimi");
  return existsSync(wellKnown) ? wellKnown : null;
}

/** Opens one throwaway `kimi acp` session purely to read its `configOptions` model select. */
export async function probeKimiModels(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<ModelOption[]> {
  const cli = resolveKimiBinary(opts.env ?? process.env);
  if (!cli) return [];
  const proc = spawnProcess(cli, ["acp"], { cwd: opts.cwd ?? tmpdir(), env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  // stderr is drained but ignored: an unconsumed pipe fills and stalls the child, and a probe
  // has no business surfacing a CLI's diagnostics.
  proc.stderr?.resume();
  try {
    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    // No client handler: this connection issues two requests and receives no agent-initiated
    // ones (no prompt is ever sent, so there are no permission/tool round trips to answer).
    const conn = new ClientSideConnection(() => ({}) as never, stream);
    const models = await withTimeout((async () => {
      await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const sess = await conn.newSession({ cwd: opts.cwd ?? tmpdir(), mcpServers: [] });
      return kimiModelOptions(sess.configOptions);
    })(), opts.timeoutMs ?? PROBE_TIMEOUT_MS, () => proc.kill("SIGKILL"));
    return models;
  } catch {
    return [];
  } finally {
    proc.kill("SIGKILL");
  }
}

// The claude probe's one dependency, injected so the engine can hand in the SAME `query` its
// backend uses (and so tests can stub it without the 300 MB CLI).
export type ClaudeQueryLike = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
  supportedModels?: () => Promise<Array<{ value: string; displayName: string; description?: string }>>;
  interrupt?: () => Promise<void>;
  return?: (v?: unknown) => Promise<unknown>;
};

/** Starts an SDK query WITHOUT ever sending a turn, purely to await supportedModels(). */
export async function probeClaudeModels(
  queryFn: ClaudeQueryLike,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ModelOption[]> {
  // A prompt stream that never yields: supportedModels() only awaits the initialize handshake
  // the Query constructor already kicked off, so no user turn is needed — and never yielding
  // guarantees this probe cannot spend a single token.
  const idlePrompt = (async function* () { await new Promise(() => {}); })();
  let stream: ReturnType<ClaudeQueryLike>;
  try {
    stream = queryFn({
      prompt: idlePrompt,
      options: { cwd: opts.cwd ?? tmpdir(), permissionMode: "default", ...(opts.env ? { env: opts.env } : {}) },
    });
  } catch {
    return [];
  }
  try {
    const models = await withTimeout(
      Promise.resolve(stream.supportedModels?.() ?? []),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      () => { void stream.interrupt?.().catch(() => {}); },
    );
    return models.map((m) => ({ value: m.value, displayName: m.displayName, ...(m.description ? { description: m.description } : {}) }));
  } catch {
    return [];
  } finally {
    // Both are best-effort: the SDK exposes no single "dispose", and a probe that fails to tear
    // down cleanly must still not surface an error to the RPC that called it.
    void stream.return?.().catch(() => {});
    void stream.interrupt?.().catch(() => {});
  }
}

/** The default claude probe: lazily pulls `query` from the SDK the claude backend already uses,
 *  so engine.ts needs no static import of it (and a build without the SDK degrades to []). */
export async function probeClaudeModelsDefault(opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ModelOption[]> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    return await probeClaudeModels(query as unknown as ClaudeQueryLike, opts);
  } catch {
    return [];
  }
}
