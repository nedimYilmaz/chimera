// F23-0D: the provider catalog — one ProviderProfile entry per LLM provider chimera can
// drive. Adding a new provider is meant to be exactly this: one entry here, nothing else
// (registry.ts turns every "openai-compat" entry into a GenericAgentBackend automatically).
//
// Sourced from docs/superpowers/design-plans/F23-provider-research.md (verified 2026-07-18)
// + its §F "FINAL PM DECISIONS": 17 providers ship (2 agentic-sdk existing + 15
// openai-compat/native-via-compat). meta-llama is DEAD (service sunset 2026-07-06) and is
// deliberately NOT listed. Every `models` list is a FALLBACK ONLY — model IDs churned
// within days during that research; a live `modelsEndpoint` probe is the source of truth
// once FAZ-1/2B wires it. Re-verify against the research doc before trusting an ID here.
import type { ChimeraConfig, CustomProvider, ProviderProfile } from "@chimera/protocol";

export const PROVIDERS: ProviderProfile[] = [
  // ---------- agentic-sdk (existing drivers, untouched) ----------
  {
    id: "claude", label: "Claude", kind: "agentic-sdk",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-4-8",
    // SPAWN-FORM-ACCOUNTS: fallback only — modelsEndpoint below is the source of truth
    // whenever an account's key resolves (any auth type, not just apiKey/keychain; see
    // engine.ts providers.models). A subscription-only setup with no resolvable key never
    // reaches the live probe and stays on this list, so it can't be a single-model stub.
    models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    modelsEndpoint: "https://api.anthropic.com/v1/models",
    // Anthropic's /v1/models returns the same `{data:[{id}]}` shape fetchProviderModels
    // already parses for openai-compat — only the auth header differs (x-api-key, raw
    // value, no "Bearer " scheme; fetchProviderModels's `scheme` picks that up from
    // `headerName !== "Authorization"`) plus the required anthropic-version header.
    authHeader: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    authModes: ["apiKey", "oauth"],
    capabilities: { tools: true, vision: true, streaming: true, realtime: false },
    envVar: "ANTHROPIC_API_KEY",
    tosNote: "Claude Pro/Max subscription access rides the official Claude Agent SDK login "
      + "(this app's existing `claude` backend, subscription/CLAUDE_CONFIG_DIR) — chimera "
      + "does not spoof or proxy Anthropic's subscription OAuth (explicitly ToS-prohibited "
      + "and actively enforced). A user-supplied CLAUDE_CODE_OAUTH_TOKEN is accepted at the "
      + "user's own risk.",
  },
  // KIMI-BACKEND S1 (spec docs/superpowers/specs/2026-07-28-kimi-backend.md §5): a NEW entry,
  // distinct from the existing `kimi-code` openai-compat/apiKey entry below (§5 FALLBACK
  // REQUIREMENT -- kimi-code is untouched by this addition, zero shared code path). This is
  // what makes `accounts.add_subscription`'s agentic-sdk guard (engine.ts:2714-2738) honestly
  // available for Kimi; `authModes: ["oauth"]` (not apiKey) matches credentials.ts's
  // `case "subscription": return null`, correct here because the CLI owns the secret, not
  // chimera. baseUrl is decorative for agentic-sdk kind, same as claude/codex above -- the
  // CLI resolves the real endpoint itself.
  // KIMI-CLI-PROTOCOL: S0/S2's `@moonshot-ai/kimi-agent-sdk@0.1.8` path (protocol mismatch,
  // "unknown option '--work-dir'") is GONE -- kimi.ts now speaks the real installed CLI's
  // Agent Client Protocol server (`kimi acp`) directly, verified end-to-end (real spawn, real
  // "pong" reply, real follow-up turn on the same session). See kimi.ts's header comment for
  // the transport-choice evidence and known gaps (no token-usage telemetry over ACP; MCP-server
  // passthrough deferred).
  {
    id: "kimi", label: "Kimi (ACP)", kind: "agentic-sdk",
    baseUrl: "https://api.kimi.com",
    defaultModel: "kimi-k3", models: ["kimi-k3"],
    authModes: ["oauth"],
    capabilities: { tools: true, vision: true, streaming: true, realtime: false },
    tosNote: "Kimi Code subscription access rides the operator's own installed `kimi` CLI login "
      + "(this app's `kimi` backend spawns `kimi acp` directly, subscription auth) — chimera "
      + "does not spoof or proxy Moonshot's subscription auth.",
  },
  {
    id: "codex", label: "Codex (OpenAI)", kind: "agentic-sdk",
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-5.6-sol",
    // SPAWN-FORM-ACCOUNTS: fallback only — SDK-MODEL-LISTS wires a live source ahead of
    // this (providers/codex-cli-models.ts's `codex debug models`, engine.ts providers.models)
    // for the common no-API-key subscription case, where modelsEndpoint below can't run at
    // all. Re-verify against `codex debug models` before trusting this list — Codex model
    // ids churn fast (this replaced a gpt-5.1-codex/5.1/5.1-mini/o4-mini list within days).
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    modelsEndpoint: "https://api.openai.com/v1/models",
    authModes: ["apiKey", "oauth"],
    // Native voice is available through app-server, subject to CLI/account
    // support. voice.native.check enforces the live agent's transport/state.
    capabilities: { tools: true, vision: true, streaming: true, realtime: true },
    envVar: "OPENAI_API_KEY",
    tosNote: "ChatGPT Plus/Pro subscription access rides the official Codex SDK login "
      + "(this app's existing `codex` backend, subscription/CODEX_HOME) — tolerated for "
      + "personal use per OpenAI's public guidance.",
  },

  // ---------- openai-compat: pay-per-token (research doc §A/§D) ----------
  {
    // PROVIDER-CATALOG-REFRESH-2026-08: gpt-5.1/gpt-5.1-mini/o4-mini are RETIRED — OpenAI's own
    // deprecations page (developers.openai.com/api/docs/deprecations, checked 2026-08-11) lists
    // gpt-5.1 shut down 2026-07-23 (a spawn against it 404s) and o4-mini shutting down
    // 2026-10-23; neither appears on the current models page any longer. Replaced with the
    // gpt-5.6 family — the SAME lineup the `codex` agentic-sdk entry above already uses (that
    // entry was updated, this openai-compat twin was not, until now).
    id: "openai", label: "OpenAI", kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    modelsEndpoint: "https://api.openai.com/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "OPENAI_API_KEY",
  },
  {
    id: "xai", label: "xAI (Grok)", kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.5",
    models: ["grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"],
    modelsEndpoint: "https://api.x.ai/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "XAI_API_KEY",
  },
  {
    // Dots in model IDs are load-bearing (research doc §A: `grok-4-5` 404s). DeepSeek's
    // legacy `deepseek-chat`/`deepseek-reasoner` IDs are deprecated (expire 2026-07-24) and
    // are deliberately NOT listed here. Text-only API (vision:false) — GenericAgentBackend's
    // spawn-time guard (registry.ts threads capabilities.vision through) rejects image content
    // with a clean error instead of sending it upstream to a provider that can't accept it.
    id: "deepseek", label: "DeepSeek", kind: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    modelsEndpoint: "https://api.deepseek.com/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "DEEPSEEK_API_KEY",
  },
  {
    id: "moonshot", label: "Moonshot (Kimi)", kind: "openai-compat",
    baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k3",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
    modelsEndpoint: "https://api.moonshot.ai/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "MOONSHOT_API_KEY",
    // F23-1B (research doc §A): moonshot documents a 2h request timeout for long agentic
    // turns -- the fetch transport has no implicit timeout of its own, but this keeps the
    // catalog's intent explicit and gives a future stricter default something to override.
    timeoutMs: 7_200_000,
  },
  {
    id: "mistral", label: "Mistral", kind: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-medium-2604",
    models: ["mistral-medium-2604", "mistral-large-2512", "mistral-small-2603"],
    modelsEndpoint: "https://api.mistral.ai/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "MISTRAL_API_KEY",
  },
  {
    id: "qwen", label: "Qwen (DashScope)", kind: "openai-compat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.7-max",
    models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"],
    modelsEndpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    // qwen-code's device OAuth was discontinued 2026-04-15 (research doc §G) — apiKey only.
    // Keys are REGION-SCOPED (an intl key 401s against the cn/us base and vice versa) --
    // this entry is the intl base; a `us`/`cn` account override swaps baseUrl+modelsEndpoint
    // to https://dashscope-us.aliyuncs.com/compatible-mode/v1 or
    // https://dashscope.aliyuncs.com/compatible-mode/v1 respectively (see docs/providers/qwen.md).
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "DASHSCOPE_API_KEY",
  },
  {
    // baseUrl includes `/openai` (research doc §D gotcha) — easy to drop by accident when
    // copy-pasting from api.groq.com docs that show the bare host. No vision.
    // PROVIDER-CATALOG-REFRESH-2026-08: console.groq.com/docs/deprecations (checked 2026-08-11)
    // discontinues llama-3.3-70b-versatile AND llama-3.1-8b-instant for free/developer-tier keys
    // on 2026-08-16 (5 days out at the time of this check) — moved defaultModel to Groq's own
    // documented migration target, openai/gpt-oss-120b; added the other official target
    // (qwen/qwen3.6-27b) to the fallback list. The two deprecating ids are kept in `models` since
    // they still work today and enterprise committed-spend keys are exempt.
    id: "groq", label: "Groq", kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "groq/compound", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    modelsEndpoint: "https://api.groq.com/openai/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "GROQ_API_KEY",
  },
  {
    id: "together", label: "Together AI", kind: "openai-compat",
    baseUrl: "https://api.together.ai/v1", defaultModel: "moonshotai/Kimi-K2.7-Code",
    models: ["moonshotai/Kimi-K2.7-Code", "zai-org/GLM-5.2", "deepseek-ai/DeepSeek-V4-Pro", "Qwen/Qwen3.7-Plus"],
    modelsEndpoint: "https://api.together.ai/v1/models",
    // HF-style `org/Model` ids (case-sensitive). Not every hosted model supports function
    // calling -- `GET /models` reports this per-model (research doc §D); the catalog-level
    // `capabilities.tools: true` is an aggregate ceiling, not a per-model guarantee. A
    // per-model capability table is a fast-follow once F23-2B's providers.list RPC consumes
    // modelsEndpoint responses (docs/providers/together.md tracks the caveat until then).
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "TOGETHER_API_KEY",
  },
  {
    id: "nvidia-nim", label: "NVIDIA NIM", kind: "openai-compat",
    baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b",
    models: [
      "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-v4-pro",
    ],
    modelsEndpoint: "https://integrate.api.nvidia.com/v1/models",
    // `org/model` ids throughout (this is where the dead meta-llama provider's models are
    // actually reachable, per research doc §D/§F.4). Billing is dev-credits, not token price.
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "NVIDIA_API_KEY",
  },
  {
    id: "openrouter", label: "OpenRouter", kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto",
    models: ["openrouter/auto"],
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    // Aggregator quirks (research doc §D/§F.4), none requiring ChatClient changes: optional
    // `HTTP-Referer` / `X-OpenRouter-Title` attribution headers via a per-account
    // `extraHeaders` override (Settings, F23-2B); `vendor/model[:free|:nitro|:floor|:online]`
    // slugs pick routing tier; tool/vision support varies per model -- read
    // `supported_parameters` off `GET /models` rather than assuming the aggregate
    // `capabilities.tools` below applies to every model.
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "OPENROUTER_API_KEY",
  },
  {
    id: "cerebras", label: "Cerebras", kind: "openai-compat",
    baseUrl: "https://api.cerebras.ai/v1", defaultModel: "gpt-oss-120b",
    // small, volatile menu (research doc §D) -- modelsEndpoint is the source of truth here
    // more than for most providers; this fallback list is likely to drift fastest.
    models: ["gpt-oss-120b", "gemma-4-31b"],
    modelsEndpoint: "https://api.cerebras.ai/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "CEREBRAS_API_KEY",
  },
  {
    // PROVIDER-CATALOG-REFRESH-2026-08: Fireworks encodes version dots as `p`, not `.` — the
    // prior "kimi-k2.6"/"glm-5.1" ids do not exist (fireworks.ai/models/fireworks/<id> 404s for
    // both); confirmed live against fireworks.ai's own model pages and cross-checked in
    // LiteLLM's model_prices_and_context_window.json, which lists the real ids below verbatim.
    // glm-5p1 is additionally a dead end even spelled correctly — Fireworks pulled it from
    // serverless (pay-per-token) access on 2026-08-07; glm-5p2 is the live serverless successor.
    id: "fireworks", label: "Fireworks AI", kind: "openai-compat",
    baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/kimi-k2p6",
    models: [
      "accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/deepseek-v4-pro", "accounts/fireworks/models/gpt-oss-120b",
    ],
    modelsEndpoint: "https://api.fireworks.ai/inference/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "FIREWORKS_API_KEY",
  },
  {
    // PROVIDER-CATALOG-REFRESH-2026-08: docs.z.ai/release-notes/new-released (checked
    // 2026-08-11) shows glm-5 (2026-02-12) superseded by glm-5.1 (2026-04-07) and glm-5.2
    // (2026-06-16, current flagship — 1M lossless context per docs.z.ai/guides/llm/glm-5.2).
    // Also corrected `vision`: docs.z.ai's API reference shows glm-5/5.1/5.2 use a text-only
    // ChatCompletionTextRequest schema — image input needs the separate glm-5v-turbo model id,
    // not a flag on this one. Pricing verified live: $1.40 input / $4.40 output / $0.26 cached
    // per MTok (docs.z.ai/guides/overview/pricing; cross-checked openrouter.ai/z-ai/glm-5.2 and
    // models.dev/models/zhipuai/glm-5.2), added to protocol pricing.ts.
    id: "zai", label: "Z.ai (GLM)", kind: "openai-compat",
    // pay-per-token; GLM-5.x itself is gated to a GLM Coding Plan Pro/Max subscription (research
    // doc §D) -- see the `zai-coding` entry below for the plan-scoped subscription path.
    baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-5.2", models: ["glm-5.2", "glm-5.1", "glm-5"],
    modelsEndpoint: "https://api.z.ai/api/paas/v4/models", // best-effort: OpenAI-compat convention, not explicitly confirmed in research doc
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "ZAI_API_KEY",
  },
  {
    id: "cohere", label: "Cohere", kind: "openai-compat",
    baseUrl: "https://api.cohere.ai/compatibility/v1", defaultModel: "command-a-plus-05-2026",
    models: ["command-a-plus-05-2026", "command-a-03-2025", "command-a-reasoning-08-2025"],
    modelsEndpoint: "https://api.cohere.ai/compatibility/v1/models",
    // The compat layer (research doc §D) silently DROPS native RAG/citations/connectors,
    // `parallel_tool_calls`, `n`, and `logit_bias` -- none of which OpenAICompatChatClient
    // ever sends (F23-0B's ChatRequest has no fields for them), so this needs no ChatClient
    // change, only caller awareness: don't add those params via `extraBody` for cohere.
    // `reasoning_effort` is restricted to `"none"|"high"` (no `"low"`/`"medium"`) if a future
    // caller sets it via extraBody. Vision is undocumented on the compat layer -- left `false`
    // until verified; native v2 (`api.cohere.com/v2/chat`) is the fast-follow if RAG/vision
    // are needed.
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "COHERE_API_KEY",
  },
  // gemini: research doc §D recommends the openai-compat layer as the cheapest v1 default
  // (F23-1D). A native v1beta ChatClient (gemini-native.ts: roles user/model,
  // systemInstruction, SSE via ?alt=sse) has landed alongside it as a selectable
  // kind:"native" variant below — compat stays the default, native is opt-in per D2's "fast
  // follow if compat proves lossy" plan, now available rather than deferred.
  {
    id: "gemini", label: "Gemini", kind: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    // Google Code Assist subscription OAuth is DEFERRED (research doc §G: live-status risk,
    // ToS-disallowed for third parties) — apiKey only until a live test + flag lands it.
    // Reasoning can't be disabled on the 3.x model family (research doc §D quirk).
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "GEMINI_API_KEY",
  },
  {
    id: "gemini-native", label: "Gemini (native)", kind: "native",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    // Alternate driver (packages/core/src/providers/gemini-native.ts) hitting
    // :generateContent / :streamGenerateContent?alt=sse directly with x-goog-api-key auth,
    // instead of the openai-compat layer above. Same account env var as `gemini` since it's
    // the same underlying API key.
    modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    // Same x-goog-api-key auth as the chat client above (not Authorization/Bearer). Response
    // shape also differs from the openai-compat `{data:[{id}]}` convention -- it's
    // `{models:[{name:"models/gemini-..."}]}`, which fetchProviderModels (models.ts) strips
    // the "models/" prefix from as its second recognized shape.
    authHeader: "x-goog-api-key",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "GEMINI_API_KEY",
  },

  // ---------- zero-OAuth subscription wins (research doc §G: "fold into F23-0D") ----------
  // Plan-scoped API keys against a coding-plan endpoint — no OAuth engineering needed at
  // all, just a distinct catalog entry + base URL. Highest ROI item in the whole research
  // addendum for the user's "subscription tokens must work" requirement.
  {
    // PROVIDER-CATALOG-REFRESH-2026-08: www.kimi.com/code/docs/en/kimi-code/models (checked
    // 2026-08-11, corroborated by .../third-party-tools/opencode.html) is explicit that this
    // coding-plan endpoint does NOT accept "kimi-k3" as a model id -- valid ids are k3/k3-256k
    // (Kimi K3) and kimi-for-coding/kimi-for-coding-highspeed (K2.7 Code tiers); the doc warns
    // "entering a model version name like `Kimi K3`... will cause the call to fail." The
    // pay-per-token `moonshot` entry below correctly keeps "kimi-k3" -- that IS the right id on
    // api.moonshot.ai/v1, a different host with its own naming. NOT verified against a live
    // authenticated call to this endpoint (no credential available in this pass) -- PLAUSIBLE
    // per two independent official doc pages, not CONFIRMED by a real request; re-check on the
    // next refresh if this turns out wrong.
    id: "kimi-code", label: "Kimi Code (Moonshot coding plan)", kind: "openai-compat",
    baseUrl: "https://api.kimi.com/coding/v1", defaultModel: "k3",
    models: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
    modelsEndpoint: "https://api.kimi.com/coding/v1/models",
    authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    envVar: "KIMI_CODE_API_KEY",
    tosNote: "Plan-scoped key from a Kimi Code subscription — explicitly documented as third-party/Claude-Code-agent sanctioned.",
    // Same underlying Moonshot infra as the pay-per-token `moonshot` entry -- long agentic
    // turns are expected here too (research doc §A/§G).
    timeoutMs: 7_200_000,
  },
  {
    // F23-1C: the highest-ROI entry in the whole research addendum -- a GLM Coding Plan
    // subscription authenticates with a plain plan-scoped key against this coding-only base
    // URL, no OAuth engineering required (research doc §G "2A-now"). auth = ZAI_CODING_PLAN_API_KEY.
    // PROVIDER-CATALOG-REFRESH-2026-08: docs.z.ai/devpack/latest-model (checked 2026-08-11) --
    // "The GLM Coding Plan now supports the latest GLM-5.2 model for all users (Max, Pro, and
    // Lite)". Same text-only-vision correction as the `zai` entry above.
    id: "zai-coding", label: "Z.ai GLM Coding Plan", kind: "openai-compat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4", defaultModel: "glm-5.2", models: ["glm-5.2", "glm-5.1", "glm-5"],
    modelsEndpoint: "https://api.z.ai/api/coding/paas/v4/models", // best-effort: OpenAI-compat convention, not explicitly confirmed in research doc
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    envVar: "ZAI_CODING_PLAN_API_KEY",
    tosNote: "GLM Coding Plan; coding-tools only, no prod workloads. Plan-scoped key from a GLM Coding Plan subscription — sanctioned for coding-tool use.",
  },

  // ---------- experimental: real OAuth (research doc §G), gated by config providers.experimental ----------
  // Declared here (catalog is the single source of "providers the UI can list"). `experimental:
  // true` lets Settings (F23-2B) gate it behind a flag/warning; the daemon-side gate (engine.ts
  // accountsOAuthStart) additionally refuses to start an experimental provider's flow unless
  // config.providers.experimental is set. F23-2A wired the actual device-code exchange
  // (packages/core/src/providers/oauth-flows.ts CopilotOAuthFlow/CopilotTokenRefresher).
  {
    id: "copilot", label: "GitHub Copilot", kind: "openai-compat",
    baseUrl: "https://api.githubcopilot.com", chatPath: "/chat/completions",
    modelsEndpoint: "https://api.githubcopilot.com/models",
    defaultModel: "gpt-5.1", models: [],
    extraHeaders: { "copilot-integration-id": "vscode-chat", "x-github-api-version": "2025-04-01" },
    authModes: ["oauth"],
    oauth: { deviceCodeUrl: "https://github.com/login/device/code", scopes: ["read:user"], clientId: "Iv1.b507a08c87ecfe98" },
    capabilities: { tools: true, vision: true, streaming: true },
    envVar: "COPILOT_API_KEY",
    tosNote: "Gray area for reverse-engineered clients (abuse-detection reports exist), but GitHub now "
      + "officially sanctions some third-party agent integrations.",
    experimental: true,
  },
  // F23-2A: SuperGrok Heavy's "Grok Build" subscription. xAI has not published a client_id
  // or token endpoint for third parties (research doc §E/§G), so there is no OAuth exchange
  // chimera can drive itself — this rides the credentials the OFFICIAL Grok CLI already
  // wrote to ~/.grok/auth.json after its own login (packages/core/src/providers/
  // oauth-flows.ts GrokCliOAuthFlow). `oauth: {}` (no authorizeUrl/deviceCodeUrl/clientId) is
  // deliberate: this is not a flow the UI can render a URL/device-code for, only a "connect"
  // action that succeeds or fails based on whether the official CLI is logged in.
  {
    id: "grok-build", label: "xAI Grok Build (SuperGrok Heavy)", kind: "openai-compat",
    baseUrl: "https://cli-chat-proxy.grok.com/v1", defaultModel: "grok-4.5", models: ["grok-4.5"],
    // Best-effort: xAI hasn't documented this proxy's surface for third parties (see the
    // tosNote below), so this assumes the standard openai-compat `/models` convention this
    // proxy's baseUrl otherwise follows. A 404/error here is silently absorbed by
    // fetchProviderModels's fallback -- never surfaces as an error to the caller.
    modelsEndpoint: "https://cli-chat-proxy.grok.com/v1/models",
    authModes: ["oauth"], oauth: { scopes: [] },
    capabilities: { tools: true, vision: true, streaming: true },
    envVar: "GROK_BUILD_API_KEY",
    tosNote: "SuperGrok Heavy subscription only. Credentials come from the official Grok CLI's "
      + "~/.grok/auth.json (install it and log in there first) — chimera does not implement its "
      + "own OAuth exchange for this provider (xAI has not published one for third parties). "
      + "Third-party reuse of this token is gray-area and tier-gated (403s below Heavy).",
    experimental: true,
  },
];

export function findProvider(id: string): ProviderProfile | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providerIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

// CUSTOM-OPENAI-COMPAT: turns one cfg.customProviders entry into a real ProviderProfile so it
// can flow through the EXACT SAME registry.ts `{kind:"openai-compat"}` factory as a built-in —
// no new backend code needed. modelsEndpoint reuses fetchProviderModels (providers/models.ts)
// unchanged; authModes always includes "apiKey" even when requiresKey is false, since a boot-
// time envVar fallback key is meaningless here (no envVar) but the type requires a non-empty
// array and apiKey is the only mode a keychain-backed custom account can ever use.
export function customProviderProfile(id: string, cp: CustomProvider): ProviderProfile {
  return {
    id, label: cp.label, kind: "openai-compat",
    baseUrl: cp.baseUrl, defaultModel: cp.defaultModel,
    models: [cp.defaultModel], modelsEndpoint: `${cp.baseUrl.replace(/\/$/, "")}/models`,
    authModes: ["apiKey"], capabilities: { tools: true, vision: false, streaming: true },
    requiresKey: cp.requiresKey, custom: true,
    // GENERIC-SPAWN-CREDENTIAL: generic.ts reads this spawn's key from spec.env[envVar] — a
    // custom provider has no natural conventional env var (it's not a real vendor SDK), so
    // synthesize a stable, collision-free one from its id.
    envVar: `CUSTOM_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
  };
}

// CUSTOM-OPENAI-COMPAT: the ONE effective-resolution helper every call site (daemon boot,
// live hot-reload, engine RPC handlers, the prober) must share — PROVIDERS with providerOverrides
// applied, PLUS a synthesized profile per cfg.customProviders entry (a custom id can never
// collide with a built-in id: accounts.add/config-write enforces that, so simple concatenation
// is safe and built-ins always win a same-id lookup via Array.find's first-match order).
export function effectiveCatalog(cfg: Pick<ChimeraConfig, "providerOverrides" | "customProviders">): ProviderProfile[] {
  const builtins = cfg.providerOverrides
    ? PROVIDERS.map((p) => {
        const ov = cfg.providerOverrides![p.id];
        return ov ? { ...p, ...(ov.baseUrl ? { baseUrl: ov.baseUrl } : {}), ...(ov.defaultModel ? { defaultModel: ov.defaultModel } : {}) } : p;
      })
    : PROVIDERS;
  const custom = Object.entries(cfg.customProviders ?? {}).map(([id, cp]) => customProviderProfile(id, cp));
  return [...builtins, ...custom];
}

export function findEffectiveProvider(id: string, cfg: Pick<ChimeraConfig, "providerOverrides" | "customProviders">): ProviderProfile | undefined {
  return effectiveCatalog(cfg).find((p) => p.id === id);
}
