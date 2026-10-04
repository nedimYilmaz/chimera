// EFFORT-ONE-SOURCE — the single place that knows what reasoning-effort levels exist, which of
// them a given provider/model accepts, and what a human-typed alias resolves to.
//
// Its own module, not a section of index.ts, for a concrete reason: index.ts re-exports
// mcp-tools.ts, and mcp-tools.ts derives its agent_set_effort schema from the enum here. Importing
// that through the barrel is a cycle, and because the enum is used while the tool table is being
// BUILT, it fails at module-evaluation time with "Cannot access 'EffortLevelSchema' before
// initialization" — not at a call site, and not with a stack that points here.

import { z } from "zod";

// Provider-neutral effort levels — deliberately a literal SUBSET of every backend's own native
// enum (Claude Agent SDK: low|medium|high|xhigh|max; Codex SDK: minimal|low|medium|high|xhigh;
// OpenAI Chat Completions: none|minimal|low|medium|high|xhigh) so every backend maps it via a
// DIRECT passthrough — never a translation/clamp table, mirrors `model`'s own contract.
// SDK-ADOPTION #1: widened to the union of both backends' one extra tier each — "minimal"
// (Codex's cheapest, below "low"; codex.ts already passthroughs unmapped) and "max" (Claude's
// ceiling above "xhigh"; claude.ts already passthroughs unmapped). Still a direct passthrough,
// never a translation/clamp table — a backend that doesn't recognize a given tier is that
// backend SDK's own behavior to define, not chimera's to intercept.
export const EffortLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// EFFORT-ONE-SOURCE. The enum above is the WIRE vocabulary — the union of every backend's tiers,
// so a value always survives a round trip. It is NOT the list to offer someone: no provider
// accepts all six.
//
// This block used to be a comment two files away claiming "effort is a CLOSED, provider-neutral
// vocabulary owned by EffortLevelSchema, not something a provider publishes"
// (app/state/commands.agents.ts). That is measurably false, and the cost of believing it was six
// hand-written copies of the list across app/tui/core, one of which had silently lost BOTH ends —
// the agent settings dropdown offered low/medium/high/xhigh, so `minimal` and `max` were
// unreachable from the UI that exists to change effort.
//
// What the providers actually publish, verified against the installed SDKs:
//   claude — sdk.d.ts EffortLevel is low|medium|high|xhigh|max (NO "minimal"), and ModelInfo
//     carries `supportedEffortLevels` PER MODEL, delivered on the initialize handshake chimera
//     already consumes (backends/claude.ts's supportedModels() call).
//   codex  — minimal|low|medium|high|xhigh (NO "max"); its CLI rejects an unsupported one per
//     model ("Reasoning effort ... is not supported for model ...").
//   kimi   — nothing static; the agent advertises its levels over ACP as the configOptions entry
//     with category "thought_level", the same channel its model list already comes from.
//
// So the per-provider lists below are a FALLBACK for "no live session has told us yet", never the
// authority. effortLevelsFor() prefers what the provider said.
export const PROVIDER_EFFORT_LEVELS: Readonly<Record<string, readonly EffortLevel[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  // Advertised at runtime or not at all — an empty list here means "ask the session", and
  // effortLevelsFor falls through to the full vocabulary rather than offering nothing.
  kimi: [],
};

// Names a provider accepts that are not tiers of their own. `ultracode` is the one people ask for
// by name: the CLI maps it to xhigh (`var O={ultracode:"xhigh"}`) and bundles session-scoped
// workflow orchestration with it — the EFFORT half is exactly xhigh, so it resolves here rather
// than becoming a seventh level that would mean the same as one we already have.
export const EFFORT_ALIASES: Readonly<Record<string, EffortLevel>> = {
  ultracode: "xhigh",
  med: "medium",
};

/** Normalize an effort a human or another system typed. Returns undefined for anything that is
 *  neither a level nor a known alias — callers refuse rather than guess. */
export function resolveEffortAlias(raw: string | undefined | null): EffortLevel | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return undefined;
  const aliased = EFFORT_ALIASES[key];
  if (aliased) return aliased;
  const parsed = EffortLevelSchema.safeParse(key);
  return parsed.success ? parsed.data : undefined;
}

/** THE list to offer, for one provider/model. Every picker and cycler goes through here — that is
 *  the whole point, and the drift test pins it.
 *
 *  Returns plain strings, NOT EffortLevel, and that is deliberate. What a provider advertises is
 *  authoritative even when chimera's own enum has not caught up: hiding a tier the backend
 *  actually accepts, because a literal union here has not been updated, is a worse failure than
 *  showing one. EffortLevelSchema stays the prescriptive check for what may cross the WIRE;
 *  this is the descriptive answer to "what can be picked".
 *
 *  Order of authority: what the provider said about THIS MODEL, then what that provider's SDK
 *  declares, then the full wire vocabulary. The last fallback is deliberately permissive: an
 *  unknown provider offering nothing would be a dead dropdown, while offering a tier the backend
 *  ignores is that backend's own documented passthrough behaviour. */
export function effortLevelsFor(opts: {
  provider?: string | undefined;
  model?: string | undefined;
  /** Per-model levels a live session advertised, keyed by model id. */
  advertised?: Readonly<Record<string, readonly string[]>> | undefined;
}): readonly string[] {
  const perModel = opts.model ? opts.advertised?.[opts.model] : undefined;
  if (perModel && perModel.length > 0) return perModel;
  const perProvider = opts.provider ? PROVIDER_EFFORT_LEVELS[opts.provider] : undefined;
  if (perProvider && perProvider.length > 0) return perProvider;
  return EffortLevelSchema.options;
}

/** Ascending rank, for "is this stronger than that" — the same order the enum declares, so a
 *  comparison and a picker can never disagree about which way is up. */
export function effortRank(level: EffortLevel): number {
  return EffortLevelSchema.options.indexOf(level);
}

