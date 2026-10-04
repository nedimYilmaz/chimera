// JOB-OUTPUT-TRIGGER / JOB-WATCH — deciding whether a command's output is worth waking an agent
// for, and building the prompt that agent receives.
//
// Kept OUT of jobs.ts and pure: this is the part an operator gets wrong (a regex that matches
// everything, a placeholder that silently vanishes), so it has to be directly testable without a
// scheduler, a process, or a clock.

import type { JobDispatch, JobTrigger, JobTriggerWhen } from "@chimera/protocol";

/** What a run produced, as the trigger sees it. `previousOutput` is what the SAME job produced last
 *  time — the only input `changed` needs, and the reason evaluation is not a function of one run. */
export type TriggerInput = {
  output: string;
  exitCode: number | null;
  previousOutput: string | null;
};

/** Fired, plus what matched — the values that make the spawned agent's prompt concrete. */
export type TriggerMatch = {
  /** The matched text (whole output for `always`/`changed`/`exitCode`, the match for the others). */
  match: string;
  /** Regex capture groups, positional ("1".."9") and named, ready for placeholder substitution. */
  groups: Record<string, string>;
};

export function evaluateTrigger(when: JobTriggerWhen, input: TriggerInput): TriggerMatch | null {
  if ("always" in when) return { match: input.output, groups: {} };
  if ("changed" in when) {
    // First run has nothing to differ FROM. Treating "no previous output" as changed would make
    // every watch job fire once on daemon boot, which reads as a phantom alert.
    if (input.previousOutput === null) return null;
    return input.output === input.previousOutput ? null : { match: input.output, groups: {} };
  }
  if ("exitCode" in when) return input.exitCode === when.exitCode ? { match: input.output, groups: {} } : null;
  if ("contains" in when) return input.output.includes(when.contains) ? { match: when.contains, groups: {} } : null;

  // `matches`: a regex an OPERATOR wrote. A bad pattern must disable this one trigger, never take
  // down the scheduler that evaluates it.
  let re: RegExp;
  try {
    re = new RegExp(when.matches, stripGlobal(when.flags));
  } catch {
    return null;
  }
  const m = re.exec(input.output);
  if (!m) return null;
  const groups: Record<string, string> = {};
  m.forEach((g, i) => { if (i > 0 && g !== undefined) groups[String(i)] = g; });
  for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) groups[k] = v;
  return { match: m[0] ?? "", groups };
}

/** `g` makes exec() stateful across calls via lastIndex — on a reused RegExp that turns "does this
 *  line match" into "does this line match, sometimes". Dropped rather than honoured. */
function stripGlobal(flags: string | undefined): string {
  return (flags ?? "").replace(/[gy]/g, "");
}

/** How much of a command's output is worth pasting into a prompt. The whole thing can be megabytes;
 *  a prompt that opens with 8 KB of log has spent the agent's attention before the instruction. */
const PROMPT_OUTPUT_MAX = 2_000;

export type PromptVars = {
  job: string;
  ts: number;
  output: string;
  exitCode: number | null;
  match: TriggerMatch;
};

/** Substitute {{...}} placeholders. An UNKNOWN placeholder is left exactly as written — a prompt
 *  that silently loses the value it was built around looks fine and is useless, while a visible
 *  {{typo}} tells both the reading agent and the operator what went wrong. */
export function renderTriggerPrompt(template: string, vars: PromptVars): string {
  const table: Record<string, string> = {
    job: vars.job,
    ts: new Date(vars.ts).toISOString(),
    output: clipForPrompt(vars.output),
    line: clipForPrompt(vars.output),
    exitCode: vars.exitCode === null ? "none" : String(vars.exitCode),
    match: clipForPrompt(vars.match.match),
    ...vars.match.groups,
  };
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : whole);
}

function clipForPrompt(s: string): string {
  if (s.length <= PROMPT_OUTPUT_MAX) return s;
  // The TAIL, for the same reason job run history keeps the tail: when something went wrong, what
  // it said last is what says why.
  return `… [${s.length - PROMPT_OUTPUT_MAX} earlier chars dropped]\n${s.slice(-PROMPT_OUTPUT_MAX)}`;
}

/** A trigger's prompt must actually USE what fired it, or the agent is woken with no evidence and
 *  starts by asking what happened. Advisory: returned to the caller at create/update time. */
export function triggerPromptWarnings(trigger: JobTrigger): string[] {
  const warnings: string[] = [];
  if (!/\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(trigger.prompt)) {
    warnings.push("prompt carries no {{placeholder}} — the agent will be spawned with no idea what fired it; consider {{output}} or {{match}}");
  }
  if ("matches" in trigger.when) {
    try { new RegExp(trigger.when.matches, stripGlobal(trigger.when.flags)); }
    catch (e) { warnings.push(`when.matches is not a valid regex (${(e as Error).message}) — this trigger can never fire`); }
  }
  return warnings;
}

/** Human-readable one-liner for a dispatch target, for events and run history. */
export function describeDispatch(d: JobDispatch): string {
  if ("team" in d) return `team ${d.team}${d.role ? `/${d.role}` : ""}`;
  if ("agentSpec" in d) return "inline agent";
  return `role ${d.role}`;
}
