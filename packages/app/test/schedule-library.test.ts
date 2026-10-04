import { describe, it, expect } from "vitest";
import { exportSchedule, importSchedule, portableSchedule, upcomingScheduleRuns, filterScheduleRuns } from "../src/state/schedule-library";
import { defaultScheduleFormValues, type JobRunView } from "../src/state/selectors.jobs";

const raw = { name: "nightly", prompt: "review", target: { existingAgentId: "exact-id" }, schedule: { every: { unit: "hours", n: 1 } }, enabled: true, lastRuns: [{ result: "ok" }], nextRunTs: 123 };
describe("schedule library and operations", () => {
  it("exports only spec fields and imports disabled, preserving the exact pin", () => {
    const spec = importSchedule(exportSchedule(raw));
    expect(spec.enabled).toBe(false);
    expect(spec.target).toEqual(raw.target);
    expect(spec).not.toHaveProperty("lastRuns");
    expect(spec).not.toHaveProperty("nextRunTs");
    expect(raw.enabled).toBe(true);
    expect(portableSchedule({ ...raw, snoozedUntil: 99999 })).not.toHaveProperty("snoozedUntil");
  });
  it("refuses malformed, unsupported and oversized imports", () => {
    for (const text of ["null", "[]", "{}", "x".repeat(256001)]) expect(() => importSchedule(text)).toThrow();
    expect(() => portableSchedule({ ...raw, target: { unknown: "x" } })).toThrow();
  });
  it("previews five distinct interval occurrences and only one one-shot", () => {
    const now = Date.UTC(2026, 0, 1);
    const v = { ...defaultScheduleFormValues(), scheduleKind: "every" as const, everyUnit: "hours" as const, everyN: "1" };
    expect(upcomingScheduleRuns(v, now)).toEqual([1, 2, 3, 4, 5].map(n => now + n * 3600000));
    expect(upcomingScheduleRuns({ ...v, scheduleKind: "at", at: new Date(now + 3600000).toISOString() }, now)).toEqual([now + 3600000]);
  });
  it("combines outcome and text filters without mutating history", () => {
    const rows = [{ result: "failed", error: "Rate limit", agentId: "a" }, { result: "ok", agentId: "b" }] as JobRunView[];
    expect(filterScheduleRuns(rows, "failed", "RATE")).toEqual([rows[0]]);
    expect(filterScheduleRuns(rows, "ok", "rate")).toHaveLength(0);
    expect(rows).toHaveLength(2);
  });
});
