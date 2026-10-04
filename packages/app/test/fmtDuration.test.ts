import { describe, expect, it } from "vitest";
import { fmtDuration } from "../src/state/selectors";

describe("fmtDuration", () => {
  it("formats sub-second, second, minute, and hour durations", () => {
    expect(fmtDuration(null)).toBe("");
    expect(fmtDuration(500)).toBe("0s");
    expect(fmtDuration(41_000)).toBe("41s");
    expect(fmtDuration(120_000)).toBe("2m");
    expect(fmtDuration(135_000)).toBe("2m 15s");
    expect(fmtDuration(3_720_000)).toBe("1h 2m");
  });

  it("omits non-finite and undefined durations", () => {
    expect(fmtDuration(Number.NaN)).toBe("");
    expect(fmtDuration(undefined as any)).toBe("");
  });
});
