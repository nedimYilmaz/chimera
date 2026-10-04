import { describe, it, expect } from "vitest";
import { evaluateTrigger, renderTriggerPrompt, triggerPromptWarnings, describeDispatch } from "../src/job-trigger.js";
import type { JobTrigger } from "@chimera/protocol";

// JOB-OUTPUT-TRIGGER — the part an operator writes by hand and gets wrong. Pure, so it is tested
// without a scheduler, a process, or a clock.

const input = (output: string, over: Partial<{ exitCode: number | null; previousOutput: string | null }> = {}) =>
  ({ output, exitCode: 0, previousOutput: null, ...over });

describe("evaluateTrigger", () => {
  it("matches a literal substring", () => {
    expect(evaluateTrigger({ contains: "CrashLoopBackOff" }, input("pod x is CrashLoopBackOff now"))?.match).toBe("CrashLoopBackOff");
    expect(evaluateTrigger({ contains: "CrashLoopBackOff" }, input("all healthy"))).toBeNull();
  });

  it("matches a regex and exposes its capture groups to the prompt", () => {
    const m = evaluateTrigger({ matches: "pod (?<pod>\\S+) restarted (\\d+) times" }, input("pod api-7f9 restarted 12 times"));
    expect(m?.groups).toEqual({ "1": "api-7f9", "2": "12", pod: "api-7f9" });
    expect(m?.match).toBe("pod api-7f9 restarted 12 times");
  });

  it("treats an invalid regex as never firing, rather than throwing into the scheduler", () => {
    // An operator's typo must disable ONE trigger, not take down the loop evaluating every job's.
    expect(evaluateTrigger({ matches: "unclosed (group" }, input("anything"))).toBeNull();
  });

  it("strips /g and /y — a stateful regex makes matching intermittent on a reused pattern", () => {
    const when = { matches: "ERROR", flags: "gi" } as const;
    // Same input twice must give the same answer; with `g` honoured, lastIndex would make the
    // second call miss.
    expect(evaluateTrigger(when, input("error here"))).not.toBeNull();
    expect(evaluateTrigger(when, input("error here"))).not.toBeNull();
  });

  it("fires on an exact exit code", () => {
    expect(evaluateTrigger({ exitCode: 2 }, input("x", { exitCode: 2 }))).not.toBeNull();
    expect(evaluateTrigger({ exitCode: 2 }, input("x", { exitCode: 0 }))).toBeNull();
    // a watch process has no exit code — it must not fire on "null happens to equal nothing"
    expect(evaluateTrigger({ exitCode: 0 }, input("x", { exitCode: null }))).toBeNull();
  });

  describe("changed", () => {
    it("fires only when the output differs from last time", () => {
      expect(evaluateTrigger({ changed: true }, input("b", { previousOutput: "a" }))).not.toBeNull();
      expect(evaluateTrigger({ changed: true }, input("a", { previousOutput: "a" }))).toBeNull();
    });

    it("does NOT fire on the very first run", () => {
      // Otherwise every `changed` watcher alerts once on daemon boot, which reads as a phantom
      // incident and is the fastest way to make people mute the alert.
      expect(evaluateTrigger({ changed: true }, input("a", { previousOutput: null }))).toBeNull();
    });
  });
});

describe("renderTriggerPrompt", () => {
  const vars = { job: "k8s-watch", ts: 1_700_000_000_000, output: "pod api-7f9 restarted 12 times", exitCode: 1,
    match: { match: "restarted 12 times", groups: { "1": "api-7f9", pod: "api-7f9", count: "12" } } };

  it("substitutes the run's values, including named capture groups", () => {
    expect(renderTriggerPrompt("{{pod}} restarted {{count}}x (job {{job}}, exit {{exitCode}})", vars))
      .toBe("api-7f9 restarted 12x (job k8s-watch, exit 1)");
  });

  it("passes the whole output and the matched text", () => {
    expect(renderTriggerPrompt("out=[{{output}}] match=[{{match}}]", vars))
      .toBe("out=[pod api-7f9 restarted 12 times] match=[restarted 12 times]");
  });

  it("LEAVES an unknown placeholder as written instead of blanking it", () => {
    // A prompt that silently loses the value it was built around looks fine and is useless; a
    // visible {{typo}} tells the reading agent AND the operator exactly what went wrong.
    expect(renderTriggerPrompt("check {{poddd}} now", vars)).toBe("check {{poddd}} now");
  });

  it("keeps the TAIL of an oversized output — what it said last is what says why", () => {
    const long = "x".repeat(5_000) + "THE-REASON";
    const out = renderTriggerPrompt("{{output}}", { ...vars, output: long });
    expect(out).toContain("THE-REASON");
    expect(out).toContain("earlier chars dropped");
    expect(out.length).toBeLessThan(2_200);
  });

  it("renders an exit-code-less watch line as 'none', not 'null'", () => {
    expect(renderTriggerPrompt("{{exitCode}}", { ...vars, exitCode: null })).toBe("none");
  });
});

describe("triggerPromptWarnings", () => {
  const base = { dispatch: { team: "t" }, maxBudgetUsd: null, minIntervalMs: 60_000 } as const;

  it("warns when the prompt uses none of what fired it", () => {
    const t = { ...base, when: { contains: "x" }, prompt: "look into it" } as JobTrigger;
    expect(triggerPromptWarnings(t)[0]).toMatch(/no \{\{placeholder\}\}/);
  });

  it("warns about a regex that can never compile — before it is ever needed", () => {
    const t = { ...base, when: { matches: "unclosed (" }, prompt: "{{output}}" } as JobTrigger;
    expect(triggerPromptWarnings(t)[0]).toMatch(/never fire/);
  });

  it("says nothing about a well-formed trigger", () => {
    expect(triggerPromptWarnings({ ...base, when: { matches: "ERROR" }, prompt: "{{match}}" } as JobTrigger)).toEqual([]);
  });
});

describe("describeDispatch", () => {
  it("names each target shape", () => {
    expect(describeDispatch({ team: "infra" })).toBe("team infra");
    expect(describeDispatch({ team: "infra", role: "fixer" })).toBe("team infra/fixer");
    expect(describeDispatch({ role: "auditor", overrides: {} })).toBe("role auditor");
    expect(describeDispatch({ agentSpec: {} as never })).toBe("inline agent");
  });
});
