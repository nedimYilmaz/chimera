import { describe, expect, it } from "vitest";
import { TopicSchema } from "@chimera/protocol";
import { HOOK_TOPICS, topicLabel } from "../src/state/selectors.hooks";

// F09.QA. HOOK_TOPICS is a hand-maintained SECOND copy of the topic vocabulary, and it is
// load-bearing, not cosmetic: commands.hooks.ts validates a draft against it ("a valid topic is
// required") and HookRuleFormCard renders the <select> from it. F09 added "agent.promptStalled"
// to TopicSchema but not here, so the app silently could not subscribe a hook to the very signal
// the feature exists to emit. This test is the lockstep guard.
describe("app hook topics track the protocol vocabulary", () => {
  it("offers every TopicSchema member", () => {
    expect([...HOOK_TOPICS].sort()).toEqual([...TopicSchema.options].sort());
  });

  it("gives every topic a human label rather than the dotted id", () => {
    for (const t of HOOK_TOPICS) expect(topicLabel(t)).not.toContain(".");
  });
});
