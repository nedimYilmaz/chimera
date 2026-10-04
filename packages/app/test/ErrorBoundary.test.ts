import { describe, expect, it } from "vitest";
import { nextBoundaryStateFromError } from "../src/components/ErrorBoundary";

// The class-component render/commit path is not unit-tested here (repo
// convention: node-env pure tests only). The one branch with real logic is the
// derived-state reducer — it must normalize an arbitrary thrown value into a
// real Error so the fallback always has a readable `.message`.
describe("nextBoundaryStateFromError", () => {
  it("passes an Error instance through untouched (same reference)", () => {
    const err = new Error("boom");
    const state = nextBoundaryStateFromError(err);
    expect(state.error).toBe(err);
    expect(state.error.message).toBe("boom");
  });

  it("wraps a thrown string into an Error carrying that message", () => {
    const state = nextBoundaryStateFromError("kaboom");
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error.message).toBe("kaboom");
  });

  it("wraps a non-Error object via String() so message is never empty", () => {
    const state = nextBoundaryStateFromError({ code: 42 });
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error.message).toBe("[object Object]");
  });

  it("wraps null/undefined without throwing", () => {
    expect(nextBoundaryStateFromError(null).error.message).toBe("null");
    expect(nextBoundaryStateFromError(undefined).error.message).toBe("undefined");
  });
});
