import { EffortLevelSchema, type EffortLevel } from "@chimera/protocol";

// W2-8 EFFORT-POLICY. Evidence: chimera/tokenopt memory "effort-ab-powered" — a 36-cell
// powered A/B (4 fixtures, 2 deliberately adversarial, x low/medium/xhigh x 3 reps) found
// LOW effort matched medium/xhigh's correctness on every bounded, mechanically-gated
// (tsc+vitest) fix-it task tried (12/12 low-effort runs passed, including both adversarial
// fixtures), at 22-37% of xhigh's token cost. That reading is scoped to small (<10 file),
// mechanically-gated, single-seeded-defect tasks — it says nothing about open-ended
// design/architecture work or large multi-file reasoning, which keep the backend's own
// default below.
//
// WHAT "the backend's own default" IS: 'high'. The Claude Agent SDK documents it on EffortLevel
// itself — "'high' — Deep reasoning (default)" (sdk.d.ts, verified against the installed 0.3.246).
// Comments here and in scheduler.ts/supervisor.ts used to call it "effectively max", which was
// never true of this SDK and mattered: escalatedEffort below declines to escalate an
// effort-less agent on the grounds that it is "already at max", when it is actually at high with
// xhigh and max still above it.

// EFFORT-ONE-SOURCE: DERIVED from EffortLevelSchema, not mirrored. The old comment already said
// "never a separate source of truth" — and it was one, because a copy is a source no matter what
// the comment beside it says.
const TIERS: readonly EffortLevel[] = EffortLevelSchema.options;

// There is no fixed role-kind catalog in this codebase (TeamSpecSchema.roles is a free-form
// z.record keyed by caller-chosen strings — see claude-agents.ts for the same name-based
// heuristic precedent applied to permissionProfile). Matches this deployment's own "eng"
// role and the common bug-fixer/hotfix naming for bounded, gated fix-it work.
const LOW_EFFORT_ROLE_PATTERN = /\b(eng|engineer|fix(?:er)?|hotfix|patch|implement(?:er)?)\b/i;

// Per-role static default (spawn-time). Guarded by presence-check at every call site
// (mirrors WS-OPT's model-tiering precedent in supervisor.ts): an explicit spec.effort
// always wins, and any role that doesn't match stays undefined — i.e. today's
// backend-default ('high', see above) behavior, byte-identical.
export function defaultEffortForRole(roleKey: string): EffortLevel | undefined {
  return LOW_EFFORT_ROLE_PATTERN.test(roleKey) ? "low" : undefined;
}

// ESCALATE-ON-EVIDENCE: bump exactly one tier above a role's own configured baseline.
// Accepted failure mode: a task that needs MORE than one tier of headroom to recover
// (e.g. a role starting at "low" that fails twice) still only reaches "medium" on the
// next attempt, since each retry recomputes from the template's static baseline rather
// than compounding — chosen over unbounded compounding to keep a runaway retry loop's
// spend bounded. A role with no explicit baseline effort (already at backend
// default/max) has nothing to escalate and is left untouched.
export function escalatedEffort(baseEffort: EffortLevel | undefined): EffortLevel | undefined {
  if (baseEffort === undefined) return undefined;
  const idx = TIERS.indexOf(baseEffort);
  return TIERS[Math.min(idx + 1, TIERS.length - 1)];
}
