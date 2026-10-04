import { describe, it, expect } from "vitest";
import {
  isContentTopic,
  signalHeadline,
  watchFilterLabel,
} from "../src/state/selectors.hooks";
import { draftFromRule, ruleFromDraft, type HookFormDraft } from "../src/state/commands.hooks";

const ACTIONS: HookFormDraft["actions"] = [
  { type: "notify", to: "", text: "", queue: "", prompt: "", role: "", command: "", timeoutSec: "60", channel: "toast", webhookUrl: "" },
];

describe("F46.UI — content topics + watch labels", () => {
  it("agent.output is a content topic, task.state is not", () => {
    expect(isContentTopic("agent.output")).toBe(true);
    expect(isContentTopic("task.state")).toBe(false);
  });




  it("watchFilterLabel leads with the needle", () => {
    expect(watchFilterLabel({ agentId: "a1", contains: "ERROR" })).toBe('contains "ERROR" · agentId=a1');
    expect(watchFilterLabel(undefined)).toBeNull();
    expect(watchFilterLabel({})).toBeNull();
  });
});

describe("F46.UI — hook form round-trip", () => {
  it("an agent-installed {agentId, contains} rule survives draft→rule unchanged", () => {
    const rule = {
      id: "r1", name: "watch", on: "agent.output" as const, enabled: true,
      filter: { agentId: "a1", contains: "ERROR" },
      actions: [{ type: "notify" as const, to: "a1", text: "hit" }],
    };
    const draft = draftFromRule(rule as never);
    // the pair shows the needle; agentId rides along read-only so save is an identity
    expect(draft.filterKey).toBe("contains");
    expect(draft.filterValue).toBe("ERROR");
    expect(draft.extraFilter).toEqual({ agentId: "a1" });
    const back = ruleFromDraft(draft);
    expect("error" in back ? back.error : back.filter).toEqual({ agentId: "a1", contains: "ERROR" });
  });

  it("saving an agent.output rule with no needle is refused with operator wording", () => {
    const draft: HookFormDraft = { name: "w", topic: "agent.output", filterKey: "", filterValue: "", actions: [{ ...ACTIONS[0]!, to: "a1", text: "hit" }], enabled: true };
    const out = ruleFromDraft(draft);
    expect("error" in out && out.error).toMatch(/requires filter\.contains/);
  });

  it("a non-content topic with an empty pair saves no filter", () => {
    const draft: HookFormDraft = { name: "w", topic: "task.state", filterKey: "", filterValue: "", actions: [{ ...ACTIONS[0]!, to: "a1", text: "hit" }], enabled: true };
    const out = ruleFromDraft(draft);
    expect("error" in out).toBe(false);
    expect((out as { filter?: unknown }).filter).toBeUndefined();
  });
});

describe("F46.UI — signal headline in the transcript", () => {
  it("names the match and shows the matched line for an agent.output signal", () => {
    const text = '[signal:agent.output] · seq 7\n{"agentId":"a1","source":"assistant","match":"ERROR","text":"ERROR: build failed"}';
    const h = signalHeadline(text);
    expect(h?.label).toBe('output matched "ERROR"');
    expect(h?.detail).toBe("ERROR: build failed");
  });

  it("says `tool output` when the match came from a tool result", () => {
    const text = '[signal:agent.output] · seq 8\n{"source":"tool","match":"ERROR","text":"x"}';
    expect(signalHeadline(text)?.label).toBe('tool output matched "ERROR"');
  });

  it("falls back to the topic label when the 600-char cap truncated the JSON", () => {
    const h = signalHeadline('[signal:agent.output] · seq 9\n{"match":"ERR');
    expect(h?.topic).toBe("agent.output");
    expect(h?.detail).toBeNull();
  });

  it("returns null for a non-signal delivery", () => {
    expect(signalHeadline("hello from @a1")).toBeNull();
  });
});
