import { describe, it, expect, vi } from "vitest";
import { QuotaPoller, type CooldownRelief } from "@chimera/core/quota-poll";
import { CredentialResolver } from "@chimera/core/credentials";
import type { AccountConfig } from "@chimera/protocol";
import type { ExecFn } from "@chimera/core/credentials";

// EVIDENCE-DRIVEN-UN-COOL (poller half). The live incident these tests encode: at 16:19 the
// poller fetched a FRESH reading for account "claude" — session window 15% used, started 16:10,
// resets 21:10 — while the daemon still reported the account cooling until 17:10 (a deadline
// parsed out of a 429's "resets 5:10pm" text) and refused every spawn onto it. The reading and
// the decision had no way to meet. All timestamps below are that incident's real numbers.

const H = 60 * 60_000;
const T_1610 = Date.UTC(2026, 8, 2, 16, 10);
const T_1612 = Date.UTC(2026, 8, 2, 16, 12);   // when the 429 stamped the hold
const T_1619 = Date.UTC(2026, 8, 2, 16, 19);   // when the fresh poll landed
const T_1710 = Date.UTC(2026, 8, 2, 17, 10);   // the parsed (wrong) reset the hold used

/** The usage endpoint's own shape: utilization is a 0..100 PERCENT, resets_at an ISO string. */
const usageBody = (utilizationPercent: number, resetsAt: number) => ({
  five_hour: { utilization: utilizationPercent, resets_at: new Date(resetsAt).toISOString() },
  seven_day: { utilization: 20.0, resets_at: new Date(resetsAt + 6 * 24 * H).toISOString() },
});

function fakeExec(map: Record<string, { stdout: string; code: number }>): ExecFn {
  return async (cmd: string, args: string[]) => map[[cmd, ...args].join(" ")] ?? { stdout: "", code: 1 };
}

function makeBase(names = ["claude"]) {
  const account: AccountConfig = {
    name: "claude", provider: "claude",
    auth: { type: "keychain", service: "chimera:claude", injectAs: "CLAUDE_CODE_OAUTH_TOKEN", credentialType: "oauthToken" },
  } as unknown as AccountConfig;
  const registry = {
    list: () => names.map((name) => ({ name, provider: "claude" })),
    get: (name: string) => ({ ...account, name, auth: { ...account.auth, service: `chimera:${name}` } }) as AccountConfig,
  };
  const credentials = new CredentialResolver(fakeExec(Object.fromEntries(
    names.map((n) => [`security find-generic-password -s chimera:${n} -w`, { stdout: "sk-ant-oat01-xyz\n", code: 0 }]),
  )));
  return { registry, credentials };
}

/** A relief seam that reports one held account and records what it was asked to clear. */
function heldRelief(
  account: string,
  state: { since: number | null; sessionLimit: boolean } | null,
): CooldownRelief & { cleared: Array<{ account: string; evidence: unknown }> } {
  const cleared: Array<{ account: string; evidence: unknown }> = [];
  return {
    cleared,
    heldState: (a) => (a === account ? state : null),
    clear: (a, evidence) => { cleared.push({ account: a, evidence }); },
  };
}

const okFetch = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);

describe("QuotaPoller — evidence-driven un-cool", () => {
  it("clears a session-limit hold when the fresh reading shows headroom (the observed incident)", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: true });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: okFetch(usageBody(15.0, T_1610 + 5 * H)) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });

    expect(relief.cleared).toHaveLength(1);
    expect(relief.cleared[0]!.account).toBe("claude");
    // 0.15 is well under the 0.90 threshold. The window's DERIVED start (resetsAt - 5h) is 16:10,
    // which is NOT after the 16:12 stamp — so the roll rule does not fire and headroom is what
    // actually carries this case, exactly as it did live.
    expect(relief.cleared[0]!.evidence).toMatchObject({ usedFraction: 0.15, rolled: false });
  });

  it("clears when the window ROLLED even though usage is high", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: true });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      // resetsAt 5h after 16:30 ⇒ the window STARTED at 16:30, after the 16:12 stamp.
      fetchImpl: okFetch(usageBody(97.0, Date.UTC(2026, 8, 2, 16, 30) + 5 * H)) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });

    expect(relief.cleared).toHaveLength(1);
    expect(relief.cleared[0]!.evidence).toMatchObject({ rolled: true, usedFraction: 0.97 });
  });

  it("leaves the hold alone when the account is still near its limit", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: true });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: okFetch(usageBody(95.0, T_1710)) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });
    expect(relief.cleared).toEqual([]);
  });

  it("never relieves a plain failover cooldown — quota headroom says nothing about a 503/RPM 429", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: false });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: okFetch(usageBody(1.0, T_1610 + 5 * H)) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });
    expect(relief.cleared).toEqual([]);
  });

  // QUOTA-SANITY-GUARD: the tracker silently REFUSES to store an implausible window, so without
  // repeating the check here a unit bug (epoch seconds read as ms — the QUOTA-METER-WRONG-BY-100X
  // incident) would arrive with a believable usedFraction and release a genuinely capped account.
  it("refuses to un-cool on a window QuotaTracker itself would reject as implausible", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: true });
    const record = vi.fn();
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record, recordReason: vi.fn() },
      // resets_at in 1970: the signature of a seconds value read as milliseconds.
      fetchImpl: okFetch({ five_hour: { utilization: 3.0, resets_at: new Date(1_787_015_400).toISOString() } }) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });
    expect(relief.cleared).toEqual([]);
  });

  // The hold is on the account, not on one window: holdUntilReset is reached by "You've hit your
  // weekly limit" too, and un-cooling on 5h headroom there would resume the agent straight back
  // into the weekly rejection once a minute, forever.
  it("refuses to un-cool while a WEEKLY window is at its cap, however much session headroom there is", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: T_1612, sessionLimit: true });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: okFetch({
        five_hour: { utilization: 15.0, resets_at: new Date(T_1610 + 5 * H).toISOString() },
        seven_day: { utilization: 100.0, resets_at: new Date(T_1610 + 3 * 24 * H).toISOString() },
      }) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });
    expect(relief.cleared).toEqual([]);
  });

  it("un-cools with no live stamp (post-restart: the parked agents outlived the cooldown map)", async () => {
    const { registry, credentials } = makeBase();
    const relief = heldRelief("claude", { since: null, sessionLimit: true });
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: okFetch(usageBody(15.0, T_1610 + 5 * H)) as unknown as typeof fetch,
      now: () => T_1619, cooldownRelief: relief,
    });

    await poller.pollAccount("claude", { force: true });
    // `rolled` is undecidable with no stamp to compare against — headroom alone must carry it.
    expect(relief.cleared[0]!.evidence).toMatchObject({ rolled: false, usedFraction: 0.15 });
  });
});

describe("QuotaPoller — tighter cadence while an account is held", () => {
  it("polls a held account every 60s and a healthy one only every intervalMs", async () => {
    const { registry, credentials } = makeBase(["claude", "spare"]);
    let now = T_1612;
    const fetchImpl = okFetch(usageBody(95.0, T_1710));
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now,
      intervalMs: 10 * 60_000, coolingIntervalMs: 60_000,
      cooldownRelief: heldRelief("claude", { since: T_1612, sessionLimit: true }),
    });

    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);      // both accounts, first tick

    // Five tight ticks later: the held account has been polled each time, the healthy one never.
    for (let i = 0; i < 5; i++) { now += 60_000; await poller.pollAll(); }
    expect(fetchImpl).toHaveBeenCalledTimes(2 + 5);

    now += 5 * 60_000;                               // now past intervalMs since the first tick
    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2 + 5 + 2);   // held one AND the healthy one
  });

  it("backs the held account's cadence off to 5 minutes after two consecutive poll failures", async () => {
    const { registry, credentials } = makeBase();
    let now = T_1612;
    // A non-429 HTTP error: counted as a failure, and (unlike 429) does not arm rateLimitedUntil,
    // so this isolates the cooling-cadence backoff from the pre-existing 30-minute 429 floor.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response);
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now,
      intervalMs: 10 * 60_000, coolingIntervalMs: 60_000,
      cooldownRelief: heldRelief("claude", { since: T_1612, sessionLimit: true }),
    });

    await poller.pollAll();                          // failure 1
    now += 60_000; await poller.pollAll();           // failure 2 — still on the tight cadence
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 60_000; await poller.pollAll();           // backed off now: 60s is not enough
    now += 60_000; await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 3 * 60_000;                               // 5 minutes since the last attempt
    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps the original force-every-account cadence when no relief seam is wired", async () => {
    const { registry, credentials } = makeBase(["claude", "spare"]);
    let now = T_1612;
    const fetchImpl = okFetch(usageBody(10.0, T_1710));
    const poller = new QuotaPoller({
      registry, credentials, quotas: { record: vi.fn(), recordReason: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now, intervalMs: 10 * 60_000,
    });

    await poller.pollAll();
    now += 1_000;              // far inside every gap — force:true must still poll
    await poller.pollAll();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
