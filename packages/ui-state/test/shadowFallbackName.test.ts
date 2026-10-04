import { describe, expect, it } from "vitest";
import { shadowFallbackName } from "../src/reducer.js";

// SHADOW-NAME-FALLBACK — a shadow row with no label yet fell back to shortId(agentId), i.e. the
// first 8 characters of `shadow:<parentAgentId>:<taskId>`. That is the literal "shadow:" plus ONE
// character of the PARENT's id, so a row under parent 4666ef81-… rendered as "shadow:4" — a name
// that identifies nothing and reads like a task number it has nothing to do with.

describe("shadowFallbackName", () => {
  it("returns the task id — the only part of a shadow id that identifies THAT row", () => {
    expect(shadowFallbackName("shadow:4666ef81-9656-4f7d-918e-ba51f7f6087c:bioaq4zgv")).toBe("bioaq4zgv");
  });

  it("never reproduces the 'shadow:<one char of the parent>' string it replaces", () => {
    const id = "shadow:4666ef81-9656-4f7d-918e-ba51f7f6087c:bioaq4zgv";
    expect(id.slice(0, 8)).toBe("shadow:4");            // what the old fallback produced
    expect(shadowFallbackName(id)).not.toBe("shadow:4");
  });

  it("splits on the LAST colon, so a parent id containing one survives", () => {
    // A federated/remote-minted parent id is not constrained to be colon-free; cutting on the
    // first colon would hand back a fragment of the PARENT as this row's name.
    expect(shadowFallbackName("shadow:engine-a:agent-7:tsk1")).toBe("tsk1");
  });

  it("returns null for anything that is not a shadow id, leaving the caller's own fallback", () => {
    expect(shadowFallbackName("4666ef81-9656-4f7d-918e-ba51f7f6087c")).toBeNull();
    expect(shadowFallbackName("shadow:nocolonafterprefix")).toBeNull();
    expect(shadowFallbackName("")).toBeNull();
  });
});
