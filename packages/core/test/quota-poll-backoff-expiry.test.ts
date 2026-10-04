import { describe, it, expect, vi } from "vitest";
import { QuotaPoller } from "@chimera/core/quota-poll";
import { CredentialResolver } from "@chimera/core/credentials";
import type { AccountConfig } from "@chimera/protocol";
import type { ExecFn } from "@chimera/core/credentials";

// QUOTA-ABSENCE-IS-INVISIBLE (backoff lifecycle): quota-poll.test.ts covers the HOLD side of
// the 429 backoff (a poll inside the window doesn't re-fetch). This file covers the two other
// halves of the same state machine: the backoff EXPIRING at max(intervalMs*6, 30m), and
// rateLimitedUntil being CLEARED on a later success so a subsequent 429 starts a fresh window.

const SAMPLE = {
  five_hour: { utilization: 1.0, resets_at: "2026-07-25T04:00:00.000Z" },
  seven_day: { utilization: 20.0, resets_at: "2026-07-30T10:00:00.000Z" },
};

function fakeExec(map: Record<string, { stdout: string; code: number }>): ExecFn {
  return async (cmd: string, args: string[]) => map[[cmd, ...args].join(" ")] ?? { stdout: "", code: 1 };
}

function makeBase() {
  const account: AccountConfig = {
    name: "claude-pers", provider: "claude",
    auth: { type: "keychain", service: "chimera:claude-pers", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" },
  } as unknown as AccountConfig;
  const registry = { list: () => [{ name: "claude-pers", provider: "claude" }], get: () => account };
  const credentials = new CredentialResolver(fakeExec({
    "security find-generic-password -s chimera:claude-pers -w": { stdout: "sk-ant-oat01-xyz\n", code: 0 },
  }));
  return { registry, credentials };
}

describe("QuotaPoller — 429 backoff expiry", () => {
  it("resumes polling once the backoff window (floored at 30 minutes) has elapsed", async () => {
    const { registry, credentials } = makeBase();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const quotas = { record: vi.fn(), recordReason: vi.fn() };
    // intervalMs*6 == 6 min < the 30 min floor, so the floor is what governs.
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });

    // Each 429 now costs 2 fetchImpl calls: the usage-endpoint poll plus its header-probe
    // fallback (QUOTA-FROM-RESPONSE-HEADERS in quota-poll.ts) — both 429 here via the same mock.
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 29 * 60_000;   // still inside the 30-minute floor
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 2 * 60_000;    // now past it
    await poller.pollAccount("claude-pers", { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("uses intervalMs*6 when that exceeds the 30-minute floor", async () => {
    const { registry, credentials } = makeBase();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const quotas = { record: vi.fn(), recordReason: vi.fn() };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60 * 60_000 });

    await poller.pollAccount("claude-pers", { force: true });
    now += 5 * 60 * 60_000 + 59 * 60_000;   // just under 6 hours
    await poller.pollAccount("claude-pers", { force: true });
    // Still backed off — no further requests (2 == the one 429 round's usage+probe pair).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("clears the backoff on a later success, so a fresh 429 starts a new window", async () => {
    const { registry, credentials } = makeBase();
    let status = 429;
    const fetchImpl = vi.fn(async () => (status === 200
      ? { ok: true, status: 200, json: async () => SAMPLE }
      : { ok: false, status, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const quotas = { record: vi.fn(), recordReason: vi.fn() };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });

    await poller.pollAccount("claude-pers", { force: true });        // 429 -> backoff armed (usage+probe = 2 calls)
    now += 31 * 60_000;
    status = 200;
    await poller.pollAccount("claude-pers", { force: true });        // success -> backoff cleared (1 call, no probe)
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(quotas.record).toHaveBeenCalledTimes(2);                  // both windows recorded

    now += 1_000;
    await poller.pollAccount("claude-pers", { force: true });        // no stale hold left over
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("a success after a 429 records windows rather than leaving the account silent", async () => {
    const { registry, credentials } = makeBase();
    let status = 429;
    const fetchImpl = vi.fn(async () => (status === 200
      ? { ok: true, status: 200, json: async () => SAMPLE }
      : { ok: false, status, json: async () => ({}) }) as Response);
    let now = 1_000_000;
    const reasons: Array<{ kind: string }> = [];
    const quotas = { record: vi.fn(), recordReason: vi.fn((_a: string, r: { kind: string }) => reasons.push(r)) };
    const poller = new QuotaPoller({ registry, credentials, quotas, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 60_000 });

    await poller.pollAccount("claude-pers", { force: true });
    now += 31 * 60_000;
    status = 200;
    await poller.pollAccount("claude-pers", { force: true });
    expect(reasons.map((r) => r.kind)).toEqual(["rate_limited", "ok"]);
  });
});
