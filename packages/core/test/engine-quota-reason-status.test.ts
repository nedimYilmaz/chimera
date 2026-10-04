import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AccountQuotaReason } from "@chimera/protocol";

// QUOTA-ABSENCE-IS-INVISIBLE: the seam that makes the feature visible — whatever the poller
// records on the engine's QuotaTracker must reach daemon.status per-account, since that
// projection is the ONLY path by which the UI's quotaReasonLabel ever sees a reason.

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      { name: "second", provider: "claude", auth: { type: "subscription" } },
    ],
    autoOrder: ["main", "second"],
  }));
  return home;
}

function makeEngine(): Engine {
  return new Engine({ home: makeHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

type StatusAccount = { name: string; quotaReason?: AccountQuotaReason; quota?: unknown };

async function statusAccounts(e: Engine): Promise<StatusAccount[]> {
  const status = (await e.handle("daemon.status", {})) as { accounts: StatusAccount[] };
  return status.accounts;
}

describe("Engine daemon.status — quotaReason pass-through", () => {
  it("omits quotaReason for an account that has never been polled", async () => {
    const accounts = await statusAccounts(makeEngine());
    expect(accounts.find((a) => a.name === "main")!.quotaReason).toBeUndefined();
  });

  it("surfaces a recorded reason on the matching account", async () => {
    const e = makeEngine();
    e.quotas.recordReason("main", { kind: "unsupported", at: 1234 });
    const accounts = await statusAccounts(e);
    expect(accounts.find((a) => a.name === "main")!.quotaReason).toEqual({ kind: "unsupported", at: 1234 });
  });

  it("does not attach one account's reason to another", async () => {
    const e = makeEngine();
    e.quotas.recordReason("main", { kind: "http_error", httpStatus: 401, at: 1234 });
    const accounts = await statusAccounts(e);
    expect(accounts.find((a) => a.name === "second")!.quotaReason).toBeUndefined();
  });

  it("carries httpStatus through unchanged for an http_error", async () => {
    const e = makeEngine();
    e.quotas.recordReason("main", { kind: "http_error", httpStatus: 403, at: 999 });
    const accounts = await statusAccounts(e);
    expect(accounts.find((a) => a.name === "main")!.quotaReason).toEqual({ kind: "http_error", httpStatus: 403, at: 999 });
  });

  it("reports a reason even when the account has no quota windows at all", async () => {
    const e = makeEngine();
    e.quotas.recordReason("main", { kind: "rate_limited", httpStatus: 429, at: 42 });
    const a = (await statusAccounts(e)).find((x) => x.name === "main")!;
    expect(a.quota).toBeUndefined();
    expect(a.quotaReason).toEqual({ kind: "rate_limited", httpStatus: 429, at: 42 });
  });

  it("reflects the latest reason on a subsequent status call", async () => {
    const e = makeEngine();
    e.quotas.recordReason("main", { kind: "network_error", detail: "ETIMEDOUT", at: 1 });
    e.quotas.recordReason("main", { kind: "ok", at: 2 });
    const accounts = await statusAccounts(e);
    expect(accounts.find((a) => a.name === "main")!.quotaReason).toEqual({ kind: "ok", at: 2 });
  });
});
