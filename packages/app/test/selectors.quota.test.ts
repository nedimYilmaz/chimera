// ACCOUNT-QUOTA-METERS — pure geometry/formatting/staleness math. NODE env (no DOM); every
// countdown/elapsed helper takes `now` explicitly so these are deterministic regardless of
// wall-clock. Covers the boundaries the task brief calls out: 0%, 100%, past reset, zero-length
// window, day-boundary countdown formatting, the stale/unknown state, and the
// missing-window-start (never-arrived-window) degradation path.
import { describe, expect, it } from "vitest";
import type { AccountQuota, AccountQuotaWindow } from "@chimera/protocol";
import {
  quotaAbsoluteReset,
  quotaElapsedFraction,
  quotaFillFraction,
  quotaOverPace,
  quotaRelativeCountdown,
  quotaTone,
  quotaWindow,
  quotaWindowState,
} from "../src/state/selectors";

function win(over: Partial<AccountQuotaWindow> = {}): AccountQuotaWindow {
  return { kind: "session", usedFraction: 0.5, windowStartedAt: 0, resetsAt: 100, ...over };
}

describe("quotaWindow (lookup)", () => {
  const q: AccountQuota = { account: "a", fetchedAt: 0, windows: [win({ kind: "session" })] };
  it("finds the window of the requested kind", () => {
    expect(quotaWindow(q, "session")).toEqual(win({ kind: "session" }));
  });
  it("returns undefined for a kind not present (missing-window-start degradation path: weekly never arrived)", () => {
    expect(quotaWindow(q, "weekly")).toBeUndefined();
  });
  it("returns undefined for an absent AccountQuota entirely", () => {
    expect(quotaWindow(undefined, "session")).toBeUndefined();
  });
});

describe("quotaWindowState (unknown/stale/live)", () => {
  it("unknown when no window was ever recorded", () => {
    expect(quotaWindowState(undefined, 50)).toBe("unknown");
  });
  it("live while now is before resetsAt", () => {
    expect(quotaWindowState(win({ resetsAt: 100 }), 99)).toBe("live");
  });
  it("stale exactly AT resetsAt (past reset, boundary) — never a plausible-looking fill", () => {
    expect(quotaWindowState(win({ resetsAt: 100 }), 100)).toBe("stale");
  });
  it("stale well past resetsAt", () => {
    expect(quotaWindowState(win({ resetsAt: 100 }), 999)).toBe("stale");
  });
});

describe("quotaFillFraction (boundaries: 0%, 100%, clamped)", () => {
  it("0% used", () => expect(quotaFillFraction(win({ usedFraction: 0 }))).toBe(0));
  it("100% used", () => expect(quotaFillFraction(win({ usedFraction: 1 }))).toBe(1));
  it("clamps a defensively out-of-range fraction into [0,1]", () => {
    expect(quotaFillFraction(win({ usedFraction: 1.4 }))).toBe(1);
    expect(quotaFillFraction(win({ usedFraction: -0.2 }))).toBe(0);
  });
});

describe("quotaElapsedFraction (pace marker position, incl. zero-length window)", () => {
  it("0 at window start", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 0, resetsAt: 100 }), 0)).toBe(0);
  });
  it("1 exactly at reset", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 0, resetsAt: 100 }), 100)).toBe(1);
  });
  it("clamps to 1 past reset (never >1)", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 0, resetsAt: 100 }), 500)).toBe(1);
  });
  it("clamps to 0 before window start (never negative)", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 100, resetsAt: 200 }), 0)).toBe(0);
  });
  it("midpoint reads 0.5", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 0, resetsAt: 100 }), 50)).toBe(0.5);
  });
  it("zero-length window (windowStartedAt === resetsAt) reads fully elapsed, no divide-by-zero NaN", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 100, resetsAt: 100 }), 50)).toBe(1);
  });
  it("negative-length (degenerate) window also reads fully elapsed, not Infinity/NaN", () => {
    expect(quotaElapsedFraction(win({ windowStartedAt: 200, resetsAt: 100 }), 50)).toBe(1);
  });
});

describe("quotaOverPace (fill vs elapsed)", () => {
  it("false when consuming slower than the window replenishes", () => {
    expect(quotaOverPace(win({ usedFraction: 0.2, windowStartedAt: 0, resetsAt: 100 }), 50)).toBe(false);
  });
  it("true when burning faster than pace", () => {
    expect(quotaOverPace(win({ usedFraction: 0.8, windowStartedAt: 0, resetsAt: 100 }), 50)).toBe(true);
  });
  it("false at exact pace (fill === elapsed is not over-pace)", () => {
    expect(quotaOverPace(win({ usedFraction: 0.5, windowStartedAt: 0, resetsAt: 100 }), 50)).toBe(false);
  });
});

describe("quotaTone (reuses spendTone's 70/90 threshold; exhaustion beats over-pace)", () => {
  it("success under 70% and at/under pace", () => {
    expect(quotaTone(win({ usedFraction: 0.3, windowStartedAt: 0, resetsAt: 100 }), 30)).toBe("success");
  });
  it("warn at >=70% used (spendTone threshold), even at/under pace", () => {
    expect(quotaTone(win({ usedFraction: 0.75, windowStartedAt: 0, resetsAt: 100 }), 80)).toBe("warn");
  });
  it("warn when merely over-pace, below the 70% exhaustion threshold", () => {
    expect(quotaTone(win({ usedFraction: 0.4, windowStartedAt: 0, resetsAt: 100 }), 20)).toBe("warn");
  });
  it("danger at >=90% used", () => {
    expect(quotaTone(win({ usedFraction: 0.95, windowStartedAt: 0, resetsAt: 100 }), 10)).toBe("danger");
  });
  it("danger (exhaustion) wins even when technically under pace too", () => {
    expect(quotaTone(win({ usedFraction: 0.95, windowStartedAt: 0, resetsAt: 100 }), 99)).toBe("danger");
  });
});

describe("quotaRelativeCountdown (day-boundary formatting)", () => {
  it("seconds only, under a minute", () => {
    expect(quotaRelativeCountdown(10_000, 3_000)).toBe("7s");
  });
  it("minutes + seconds, under an hour", () => {
    expect(quotaRelativeCountdown(125_000, 0)).toBe("2m 5s");
  });
  it("hours + minutes, under a day", () => {
    expect(quotaRelativeCountdown(0, -((1 * 3_600_000) + 47 * 60_000))).toBe("1h 47m");
  });
  it("days + hours, crossing a day boundary", () => {
    expect(quotaRelativeCountdown(0, -((2 * 86_400_000) + 6 * 3_600_000))).toBe("2d 6h");
  });
  it("clamps to 0s exactly at reset", () => {
    expect(quotaRelativeCountdown(1000, 1000)).toBe("0s");
  });
  it("clamps to 0s past reset — never a negative duration", () => {
    expect(quotaRelativeCountdown(1000, 5000)).toBe("0s");
  });
});

describe("quotaAbsoluteReset (kind picks the format)", () => {
  it("session -> HH:MM only", () => {
    const d = new Date(2026, 6, 14, 14, 32, 0);
    expect(quotaAbsoluteReset(d.getTime(), "session")).toBe("14:32");
  });
  it("weekly -> weekday + HH:MM", () => {
    const d = new Date(2026, 6, 13, 3, 0, 0);   // 2026-07-13 is a Monday
    expect(d.getDay()).toBe(1);
    expect(quotaAbsoluteReset(d.getTime(), "weekly")).toBe("Mon 03:00");
  });
  it("pads single-digit minutes/hours", () => {
    const d = new Date(2026, 6, 14, 9, 5, 0);
    expect(quotaAbsoluteReset(d.getTime(), "session")).toBe("09:05");
  });
});
