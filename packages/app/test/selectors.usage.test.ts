import { describe, expect, it } from "vitest";
import type { UsageQueryGroup } from "@chimera/protocol";
import {
  buildUsageCsv,
  jobsFrom,
  last7DaysRange,
  topRunsFrom,
  usageCsvFilename,
  usageRowValueLabel,
} from "../src/state/selectors.usage";

const group = (over: Partial<UsageQueryGroup> = {}): UsageQueryGroup => ({
  key: "main",
  costUsd: 1.5,
  tokensIn: 100,
  tokensOut: 50,
  count: 3,
  ...over,
});

describe("last7DaysRange", () => {
  it("spans exactly 7 days back with an inclusive-of-now upper bound", () => {
    const now = 1_700_000_000_000;
    const { from, to } = last7DaysRange(now);
    expect(to).toBe(now + 1);
    expect(now - from).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("usageRowValueLabel — F19 codex-as-tokens rule", () => {
  it("shows the cost for a normal (priced) row", () => {
    expect(usageRowValueLabel(group({ costUsd: 2.5 }))).toBe("$2.50");
  });

  it("shows tokens with $0 for a codex-shaped row (costUsd 0, tokens > 0)", () => {
    const label = usageRowValueLabel(group({ costUsd: 0, tokensIn: 900, tokensOut: 100 }));
    expect(label).toContain("$0.00");
    expect(label).toContain("tok");
  });

  it("shows plain $0.00 when there is truly no usage at all", () => {
    expect(usageRowValueLabel(group({ costUsd: 0, tokensIn: 0, tokensOut: 0 }))).toBe("$0.00");
  });
});

describe("topRunsFrom", () => {
  it("takes the first 5 WITHOUT re-sorting (trusts the daemon's own cost-desc order)", () => {
    const groups = [
      group({ key: "a", costUsd: 9 }),
      group({ key: "b", costUsd: 1 }), // deliberately "out of order" — must NOT be re-sorted
      group({ key: "c", costUsd: 5 }),
      group({ key: "d" }),
      group({ key: "e" }),
      group({ key: "f" }),
    ];
    const top = topRunsFrom(groups);
    expect(top).toHaveLength(5);
    expect(top.map((g) => g.key)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("jobsFrom", () => {
  it("drops the 'none' (no-job) group and keeps everything else", () => {
    const groups = [group({ key: "none" }), group({ key: "nightly-build" }), group({ key: "backfill" })];
    expect(jobsFrom(groups).map((g) => g.key)).toEqual(["nightly-build", "backfill"]);
  });
});

describe("buildUsageCsv — F19 'the csv contains the same rows' rule", () => {
  it("has a header plus one line per row, values matching the group exactly", () => {
    const groups = [group({ key: "main", costUsd: 1.5, tokensIn: 100, tokensOut: 50, count: 3 })];
    const csv = buildUsageCsv("team", groups);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("team,costUsd,tokensIn,tokensOut,count");
    expect(lines[1]).toBe("main,1.50,100,50,3");
  });

  it("quotes a key containing a comma", () => {
    const csv = buildUsageCsv("job", [group({ key: "release, hotfix" })]);
    expect(csv).toContain('"release, hotfix"');
  });

  it("emits only the header for an empty row set", () => {
    expect(buildUsageCsv("model", []).trim()).toBe("model,costUsd,tokensIn,tokensOut,count");
  });
});

describe("usageCsvFilename", () => {
  it("embeds the groupBy and timestamp so repeated exports never collide", () => {
    expect(usageCsvFilename("account", 123)).toBe("usage-account-123.csv");
  });
});
