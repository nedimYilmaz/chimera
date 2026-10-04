// F23-0D (D3): turns the provider catalog into the `Map<string, AgentBackend>` the daemon
// hands to Engine. "Adding a provider = 1 catalog entry" holds because every openai-compat
// profile goes through the exact same path here — GenericAgentBackend (F23-0C) driven by
// one shared OpenAICompatChatClient (F23-0B) per provider.
//
// PROVIDER-ADAPTER-SDK: buildBackends() used to be a branchy if/else keyed on
// `profile.kind`/`profile.id` (agentic-sdk -> claude/codex, native -> gemini-native, else
// openai-compat). registerBackend() below replaces that with two lookup tables — an id-level
// one (checked first) and a kind-level fallback — resolved by resolveBackendFactory(). Nothing
// about the RESOLUTION semantics changed: an id/kind combo with no registered factory still
// silently yields no backend for that provider (same as the old "deliberately skipped" branches),
// and buildBackends()'s own signature/behavior is unchanged for every existing caller.
import type { AgentBackend, ChimeraEngineAccessor } from "../backend.js";
import type { ProviderProfile, ModelMetadataLookup } from "@chimera/protocol";
import type { CodexFactory } from "../backends/codex.js";
import type { KimiFactory } from "../backends/kimi.js";
import { GenericAgentBackend, type ChatClient as GenericChatClient } from "../backends/generic.js";
import { OpenAICompatChatClient } from "./openai-compat.js";
import { adaptToGenericChatClient } from "./chat-client-adapter.js";
import { OpenAIResponsesClient } from "./responses.js";
import { geminiNativeClient } from "./gemini-native.js";

export type BuildBackendsDeps = {
  // TERMINAL-RUNTIME: paths the terminal backend needs ($CHIMERA_HOME for its per-agent MCP
  // config, and chimera-mcp.js so a terminal agent reaches the same tools an SDK one does).
  // Absent ⇒ no terminal backend is registered at all.
  terminal?: { home: string; mcpBin: string; nodeBin?: string };
  // Only construct backends for these provider ids (default: every catalog entry). The
  // daemon passes the SET of providers actually referenced by configured accounts, exactly
  // like main.ts's pre-F23-0D `providers = [...new Set(cfg.accounts.map(a => a.provider))]`.
  providers?: string[];
  codexFactory?: CodexFactory;     // test seam, forwarded to CodexAgentBackend
  kimiFactory?: KimiFactory;       // test seam, forwarded to KimiAgentBackend
  fetchFn?: typeof fetch;          // test seam, forwarded to every OpenAICompatChatClient
  env?: NodeJS.ProcessEnv;         // where an openai-compat provider's API key is read from (default process.env)
  // INPROC-CHIMERA-BRIDGE: threaded into every GenericAgentBackend so its chimera MCP grant
  // (orchestration.allow) calls engine.handle() directly instead of shelling out to
  // bin/chimera-mcp.js. Absent ⇒ GenericAgentBackend's own NO_ENGINE_ACCESSOR default (a test
  // building backends without a daemon around them, and never granting orchestration.allow).
  engine?: ChimeraEngineAccessor;
  // DYNAMIC-MODEL-METADATA: lazy accessor for the model-metadata service, forwarded to the
  // claude/codex backends so their authoritative result-event cost uses catalog pricing. Lazy
  // because backends are built BEFORE the Engine that owns the service (main.ts) — resolved at
  // cost time, not construction. Absent ⇒ hardcoded-map-only pricing (every existing test unaffected).
  modelCatalog?: () => ModelMetadataLookup | undefined;
};

// F23-0C's GenericAgentBackend and F23-0B's OpenAICompatChatClient were built in parallel
// against slightly different ChatClient shapes (0C: one AsyncIterable `stream(req)`; 0B: a
// Promise-returning `stream(req, onDelta, signal)` callback). adaptToGenericChatClient
// (F23-1D, extracted from this function) is the seam that reconciles them, per D2/D3
// ("others via GenericAgentBackend(profile, openAiCompatClient(profile))") — bridges 0B's
// callback deltas onto 0C's event stream via a small async pull queue. It's also reused by
// gemini-native.ts, the first "native" (non-openai-compat-wire) ChatClient, since both
// implement the same Promise/onDelta ChatClient interface from openai-compat.ts.
//
// The API key resolved here, at backend construction time (daemon boot / config reload) from
// `env[profile.envVar]`, is only the FALLBACK key now (GENERIC-SPAWN-CREDENTIAL): it's used
// when a spawn carries no per-spawn credential of its own (e.g. env-var-configured providers
// with no keychain/oauth account). The real per-account key path is
// GenericAgentBackend reading spec.env[profile.envVar] (threaded via the `envVar` opt below)
// and passing it as this request's ChatRequest.apiKey override — see generic.ts,
// chat-client-adapter.ts, openai-compat.ts/gemini-native.ts's `stream()`. That's what lets two
// accounts of the same openai-compat/native provider each use their own key.
export function openAiCompatClient(profile: ProviderProfile, deps: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): GenericChatClient {
  const env = deps.env ?? process.env;
  const apiKey = (profile.envVar ? env[profile.envVar] : undefined) ?? "";
  const client = new OpenAICompatChatClient({
    baseUrl: profile.baseUrl,
    apiKey,
    chatPath: profile.chatPath,
    authHeader: profile.authHeader,
    extraHeaders: profile.extraHeaders,
    fetchFn: deps.fetchFn,
    timeoutMs: profile.timeoutMs,
    ...(profile.id === "openai" ? { maxTokensField: "max_completion_tokens" as const } : {}),
  });
  return adaptToGenericChatClient(profile, client);
}

// PROVIDER-ADAPTER-SDK: every factory sees `env` already resolved (deps.env ?? process.env) so
// it never has to repeat that fallback itself.
type ResolvedBuildDeps = BuildBackendsDeps & { env: NodeJS.ProcessEnv };
export type BackendFactory = (profile: ProviderProfile, deps: ResolvedBuildDeps) => AgentBackend | Promise<AgentBackend>;

const idFactories = new Map<string, BackendFactory>();
const kindFactories = new Map<ProviderProfile["kind"], BackendFactory>();

// `selector` is either an exact provider id (checked first) or `{ kind }` — a fallback applied
// to every catalog entry of that kind with no more specific id registration. Both maps are
// independently optional per (id, kind) pair: an id/kind combo that matches neither is silently
// skipped by buildBackends() below, exactly like the old hardcoded branches' "deliberately
// skipped" unmatched-id fallthrough.
export function registerBackend(selector: string | { kind: ProviderProfile["kind"] }, factory: BackendFactory): void {
  if (typeof selector === "string") idFactories.set(selector, factory);
  else kindFactories.set(selector.kind, factory);
}

// capabilities.vision is threaded into every GenericAgentBackend so text-only APIs (deepseek,
// groq, ...) get the D5 spawn-time guard. envVar is threaded too (GENERIC-SPAWN-CREDENTIAL) so
// the backend can find this spawn's per-account credential at spec.env[envVar] — see generic.ts's
// constructor comment.
function genericOptsFor(profile: ProviderProfile): { vision?: boolean; envVar?: string } {
  return { vision: profile.capabilities.vision, envVar: profile.envVar };
}

// The dynamic import()s below MUST stay inside the factory closure, not hoisted to this module's
// top level: registerBackend() only stores the function reference, so @anthropic-ai/claude-agent-sdk
// / @openai/codex-sdk are loaded ONLY when buildBackends() actually resolves and calls that
// specific factory — any caller of registry.ts that never touches claude/codex still never pays
// for either SDK's import cost.
registerBackend("claude", async (_profile, deps) => {
  const { ClaudeAgentBackend } = await import("../backends/claude.js");
  return new ClaudeAgentBackend(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {});
});

registerBackend("codex", async (_profile, deps) => {
  const { CodexAgentBackend } = await import("../backends/codex.js");
  return new CodexAgentBackend({
    ...(deps.codexFactory ? { codexFactory: deps.codexFactory } : {}),
    ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
  });
});

// KIMI-CLI-PROTOCOL (was KIMI-BACKEND S2): dynamic import, same rationale as claude/codex above --
// kimi.ts pulls in @agentclientprotocol/sdk, so a caller that never touches the kimi
// provider should never pay its import cost.
registerBackend("kimi", async (_profile, deps) => {
  const { KimiAgentBackend } = await import("../backends/kimi.js");
  return new KimiAgentBackend({
    ...(deps.kimiFactory ? { kimiFactory: deps.kimiFactory } : {}),
    ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
    // F49: the same accessor the generic backends already take -- kimi needs it to mint a loopback
    // HTTP MCP grant, since its CLI has no usable stdio MCP transport. Absent (embedders/tests)
    // means no grant and today's withheld-with-a-reason behaviour, never a crash.
    ...(deps.engine ? { engine: deps.engine } : {}),
  });
});

// Only gemini-native exists today (F23-1D) — an unrecognized future "native" id has no
// kind-level fallback registered, so it stays silently skipped, same as before.
registerBackend("gemini-native", (profile, deps) =>
  new GenericAgentBackend(profile.id, geminiNativeClient(profile, { fetchFn: deps.fetchFn, env: deps.env }), genericOptsFor(profile), deps.engine, deps.modelCatalog));

// "openai-compat" drives through GenericAgentBackend + the shared compat ChatClient — this is
// the one true KIND-level registration (every current and future openai-compat catalog entry
// needs zero code beyond its own catalog.ts entry, per this module's own header comment).
registerBackend({ kind: "openai-compat" }, (profile, deps) =>
  new GenericAgentBackend(profile.id, openAiCompatClient(profile, { fetchFn: deps.fetchFn, env: deps.env }), genericOptsFor(profile), deps.engine, deps.modelCatalog));

registerBackend("openai", (profile, deps) => {
  const responses = new OpenAIResponsesClient({ baseUrl: profile.baseUrl, model: profile.defaultModel, apiKey: deps.env[profile.envVar ?? "OPENAI_API_KEY"], fetchFn: deps.fetchFn, timeoutMs: profile.timeoutMs, extraHeaders: profile.extraHeaders, authHeader: profile.authHeader });
  const chat = openAiCompatClient(profile, deps);
  const client: GenericChatClient = { stream(req) {
    if (req.openaiApi !== undefined && req.openaiApi !== "responses" && req.openaiApi !== "chat-completions") throw new Error("openaiApi must be responses or chat-completions");
    return (req.openaiApi === "chat-completions" ? chat : responses).stream(req);
  } };
  return new GenericAgentBackend(profile.id, client, genericOptsFor(profile), deps.engine, deps.modelCatalog);
});

export async function buildBackends(catalog: ProviderProfile[], deps: BuildBackendsDeps = {}): Promise<Map<string, AgentBackend>> {
  const resolvedDeps: ResolvedBuildDeps = { ...deps, env: deps.env ?? process.env };
  const wanted = deps.providers ? new Set(deps.providers) : null;
  const backends = new Map<string, AgentBackend>();

  for (const profile of catalog) {
    if (wanted && !wanted.has(profile.id)) continue;
    const factory = idFactories.get(profile.id) ?? kindFactories.get(profile.kind);
    if (!factory) continue;   // no id/kind registration matches — same silent skip as before
    backends.set(profile.id, await factory(profile, resolvedDeps));
  }

  // TERMINAL-RUNTIME: registered by RUNTIME, not by provider — it is not in the provider catalog
  // and has no account of its own. A terminal agent's provider is still claude/codex/kimi; this
  // backend only changes the surface that provider's CLI runs on, and the supervisor reaches it
  // via `spec.runtime === "terminal"` rather than through a provider lookup.
  //
  // Registered only when the caller supplies the paths it needs (the daemon does; a unit test
  // building backends for a chat provider does not), so its absence is a clean
  // "terminal-runtime agents are unavailable" rather than a half-built backend.
  if (deps.terminal) {
    const { TerminalAgentBackend } = await import("../backends/terminal.js");
    backends.set("terminal", new TerminalAgentBackend(deps.terminal));
  }

  return backends;
}
