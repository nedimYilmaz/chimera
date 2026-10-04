import { describe, expect, it } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import type { UsageQueryResult } from "@chimera/protocol";
import { createUsageCommands } from "../src/state/commands.usage";

// W21 (F19 · coverage §B23/§C17) — the usage & cost card's store. The
// governing rule (F19's "no drift"): every number on the card traces back to
// ONE usage.query response per concern, and switching groupBy re-queries but
// the RANGE TOTAL never changes. These tests assert the wire shape of the
// three calls a refresh fires and that a groupBy switch never re-derives a
// number client-side.

type Call = { method: string; params: unknown };

function harness(resultFor: (params: { groupBy: string; bucket?: string }) => UsageQueryResult) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params: params ?? {} });
    if (method === "usage.query") return Promise.resolve(resultFor(params as { groupBy: string; bucket?: string }) as unknown as T);
    return Promise.reject(new Error(`unexpected method ${method}`));
  };
  const now = () => 1_700_000_000_000;
  const exports: Array<{ filename: string; content: string }> = [];
  const doExport = (filename: string, content: string): Promise<string> => {
    exports.push({ filename, content });
    return Promise.resolve(`/home/chimera/exports/${filename}`);
  };
  const cmds = createUsageCommands(store, request, doExport, now);
  return { cmds, calls, dispatched, exports };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const mainResult: UsageQueryResult = {
  totalCostUsd: 10,
  totalTokensIn: 1000,
  totalTokensOut: 500,
  count: 4,
  groups: [{ key: "core-team", costUsd: 7, tokensIn: 700, tokensOut: 300, count: 3 }],
  buckets: [
    { day: "2026-07-16", costUsd: 4, tokensIn: 400, tokensOut: 200, count: 2 },
    { day: "2026-07-17", costUsd: 6, tokensIn: 600, tokensOut: 300, count: 2 },
  ],
};
const agentResult: UsageQueryResult = {
  totalCostUsd: 10,
  totalTokensIn: 1000,
  totalTokensOut: 500,
  count: 4,
  groups: [
    { key: "agent-a", costUsd: 6, tokensIn: 600, tokensOut: 300, count: 2 },
    { key: "agent-b", costUsd: 4, tokensIn: 400, tokensOut: 200, count: 2 },
  ],
};
const jobResult: UsageQueryResult = {
  totalCostUsd: 10,
  totalTokensIn: 1000,
  totalTokensOut: 500,
  count: 4,
  groups: [
    { key: "none", costUsd: 5, tokensIn: 500, tokensOut: 250, count: 2 },
    { key: "nightly-build", costUsd: 5, tokensIn: 500, tokensOut: 250, count: 2 },
  ],
};

function stubResultFor(params: { groupBy: string }): UsageQueryResult {
  if (params.groupBy === "agent") return agentResult;
  if (params.groupBy === "job") return jobResult;
  return mainResult;
}

describe("toggle / refresh", () => {
  it("open fires exactly 3 usage.query calls (main+trend, agent, job) over the SAME range", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();

    const queries = h.calls.filter((c) => c.method === "usage.query");
    expect(queries).toHaveLength(3);
    const ranges = queries.map((c) => {
      const p = c.params as { from: number; to: number };
      return `${p.from}-${p.to}`;
    });
    expect(new Set(ranges).size).toBe(1); // identical [from,to) across all three

    const groupBys = queries.map((c) => (c.params as { groupBy: string }).groupBy).sort();
    expect(groupBys).toEqual(["agent", "job", "team"]);

    const mainCall = queries.find((c) => (c.params as { groupBy: string }).groupBy === "team")!;
    expect((mainCall.params as { bucket?: string }).bucket).toBe("day");
  });

  it("shapes state from the three responses without re-deriving any total", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();
    const s = h.cmds.getState();
    expect(s.totalCostUsd).toBe(mainResult.totalCostUsd);
    expect(s.groups).toEqual(mainResult.groups);
    expect(s.trend).toEqual([
      { day: "2026-07-16", costUsd: 4 },
      { day: "2026-07-17", costUsd: 6 },
    ]);
    expect(s.topRuns.map((r) => r.key)).toEqual(["agent-a", "agent-b"]);
    expect(s.jobs.map((j) => j.key)).toEqual(["nightly-build"]); // "none" filtered
  });

  it("toggle closes without re-querying", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();
    const before = h.calls.length;
    h.cmds.toggle();
    expect(h.cmds.getState().open).toBe(false);
    expect(h.calls.length).toBe(before);
  });
});

describe("setGroupBy — no-drift across a groupBy switch", () => {
  it("re-queries but the range total is identical to before the switch", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();
    const totalBefore = h.cmds.getState().totalCostUsd;

    h.cmds.setGroupBy("account");
    await settle();
    const totalAfter = h.cmds.getState().totalCostUsd;

    expect(totalAfter).toBe(totalBefore);
    const teamOrAccountQueries = h.calls.filter(
      (c) => c.method === "usage.query" && ["team", "account"].includes((c.params as { groupBy: string }).groupBy),
    );
    expect(teamOrAccountQueries).toHaveLength(2); // once per open, once per switch — no extra re-fetch
  });

  it("is a no-op when the groupBy is already selected", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();
    const before = h.calls.length;
    h.cmds.setGroupBy("team");
    expect(h.calls.length).toBe(before);
  });
});

describe("x — exportSelectedCsv", () => {
  it("writes exactly the currently-displayed groups and toasts the resulting path", async () => {
    const h = harness(stubResultFor);
    h.cmds.toggle();
    await settle();
    await h.cmds.exportSelectedCsv();

    expect(h.exports).toHaveLength(1);
    expect(h.exports[0]!.filename).toBe("usage-team-1700000000000.csv");
    expect(h.exports[0]!.content).toContain("core-team,7.00,700,300,3");

    const notice = h.dispatched.find((d) => (d as { type: string }).type === "notice") as
      | { type: "notice"; message: string }
      | undefined;
    expect(notice?.message).toBe("csv exported: /home/chimera/exports/usage-team-1700000000000.csv");
  });
});

describe("error handling", () => {
  it("a rejected usage.query dispatches commandError and clears loading", async () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("daemon down"));
    const cmds = createUsageCommands(store, request as never, () => Promise.resolve("/x"), () => 0);
    cmds.toggle();
    await settle();
    expect(cmds.getState().loading).toBe(false);
    expect(cmds.getState().error).toBe("daemon down");
    expect(dispatched).toContainEqual({ type: "commandError", message: "daemon down" });
  });
});
