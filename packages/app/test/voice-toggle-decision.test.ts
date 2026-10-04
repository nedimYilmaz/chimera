import { describe, expect, it } from "vitest";
import { voiceToggleDecision } from "../src/components/Composer";

// VOICE-STOP-ALWAYS: ⌥Space is the ONLY way to end a voice conversation — there is no stop button
// anywhere in the UI. The handler used to resolve the composer's target FIRST and bail on
// `if (!agentId) return`, which is right for starting (never open a mic with nowhere to send the
// transcript) and wrong for stopping. An operator whose target stopped resolving mid-conversation
// — the agent finished, or the composer chip moved to something with no live agents — pressed the
// chord and nothing happened: an open microphone with no way to close it short of restarting.
//
// Reported exactly that way: "speaking'i açtım kapatamıyorum".

describe("what ⌥Space does", () => {
  it("STOPS an active conversation even when no target resolves — the reported bug", () => {
    expect(voiceToggleDecision(true, null)).toBe("stop");
  });

  it("stops an active conversation when a target does resolve", () => {
    // Stopping ignores the target either way: stopConversation() acts on the agentId it captured
    // at START, so the current one is not merely unnecessary, it is the wrong thing to consult.
    expect(voiceToggleDecision(true, "agent-1")).toBe("stop");
  });

  it("starts when nothing is running and a target resolves", () => {
    expect(voiceToggleDecision(false, "agent-1")).toBe("start");
  });

  it("does NOTHING when nothing is running and there is nowhere to send", () => {
    // The guard's real job, preserved: opening a mic whose transcript has no destination would
    // record the operator with nothing to show for it.
    expect(voiceToggleDecision(false, null)).toBe("none");
  });
});
