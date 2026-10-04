import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend, normalizeClaudeRateLimit } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

// ACCOUNT-QUOTA-METERS: the Claude Agent SDK's rate_limit_event (SDKRateLimitEvent,
// rate_limit_info: SDKRateLimitInfo) is the only real quota source found in Phase 0 — see
// normalizeClaudeRateLimit's doc comment in claude.ts. Codex has no equivalent on the
// exec-JSON path; its independent app-server pull source is covered in quota-poll.test.ts.
//
// QUOTA-METER-WRONG-BY-100X: this suite previously asserted the OPPOSITE (wrong) convention —
// utilization as 0..100 percent, resetsAt as epoch milliseconds — which is what actually shipped
// the 100x-understated usedFraction and the 1970 resetsAt for a real "keychain"/oauthToken
// account. See claude.ts's normalizeClaudeRateLimit doc comment for the live root-cause evidence.
// The correct convention (asserted below) mirrors normalizeMessagesRateLimitHeaders's
// (quota-poll.ts): utilization already a 0..1 fraction, resetsAt in epoch SECONDS.

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const fn = ((_args: unknown) => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: vi.fn(async () => {}),
  })) as never;
  return fn;
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

async function run(messages: Msg[]): Promise<BackendEvent[]> {
  const fn = fakeQuery(messages);
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
  await settle();
  return evs;
}

describe("normalizeClaudeRateLimit (pure)", () => {
  it("maps five_hour -> session, derives windowStartedAt from resetsAt - 5h, resetsAt in seconds -> ms", () => {
    // utilization is already a 0..1 FRACTION on this event path — 0.42 means 42% used.
    const w = normalizeClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_000_000_000 });
    const resetsAtMs = 1_000_000_000 * 1000;
    expect(w).toEqual({ kind: "session", usedFraction: 0.42, windowStartedAt: resetsAtMs - 5 * 60 * 60 * 1000, resetsAt: resetsAtMs });
  });

  it("maps seven_day/seven_day_opus/seven_day_sonnet -> weekly, derives windowStartedAt from resetsAt - 7d", () => {
    for (const rateLimitType of ["seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]) {
      const w = normalizeClaudeRateLimit({ rateLimitType, utilization: 0.1, resetsAt: 1_800_000_000 });
      const resetsAtMs = 1_800_000_000 * 1000;
      expect(w).toEqual({ kind: "weekly", usedFraction: 0.1, windowStartedAt: resetsAtMs - 7 * 24 * 60 * 60 * 1000, resetsAt: resetsAtMs });
    }
  });

  it("drops 'overage' — not a session/weekly rolling window", () => {
    expect(normalizeClaudeRateLimit({ rateLimitType: "overage", utilization: 0.9, resetsAt: 123 })).toBeNull();
  });

  it("drops an unrecognized rateLimitType instead of guessing", () => {
    expect(normalizeClaudeRateLimit({ rateLimitType: "some_future_window", utilization: 0.5, resetsAt: 123 })).toBeNull();
  });

  it("drops when resetsAt is missing — never fabricates a window", () => {
    expect(normalizeClaudeRateLimit({ rateLimitType: "five_hour", utilization: 0.5 })).toBeNull();
  });

  it("drops when utilization is missing — never fabricates a fill", () => {
    expect(normalizeClaudeRateLimit({ rateLimitType: "five_hour", resetsAt: 123 })).toBeNull();
  });

  it("drops on undefined info", () => {
    expect(normalizeClaudeRateLimit(undefined)).toBeNull();
  });

  it("does NOT divide a 0..1 fraction by 100 — the QUOTA-METER-WRONG-BY-100X regression", () => {
    const w = normalizeClaudeRateLimit({ rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_000_000_000 });
    expect(w!.usedFraction).toBeCloseTo(0.42);
  });

  it("clamps an out-of-range utilization into [0,1]", () => {
    expect(normalizeClaudeRateLimit({ rateLimitType: "five_hour", utilization: 1.5, resetsAt: 1 })!.usedFraction).toBe(1);
    expect(normalizeClaudeRateLimit({ rateLimitType: "five_hour", utilization: -0.5, resetsAt: 1 })!.usedFraction).toBe(0);
  });

  // QUOTA-METER-WRONG-BY-100X live-incident reproduction: claude-pers's real observed
  // rate_limit_event-shaped payload at the time the provider's own usage UI showed "96% used,
  // resets in 2hr37min" (2026-08-18, ~01:33 Europe/Istanbul). Under the OLD (wrong) convention
  // this decoded to usedFraction 0.0094 and a resetsAt in 1970. Under the corrected convention it
  // must decode to ~0.94 fraction and a resetsAt of 2026-08-18T04:10:00 Istanbul.
  it("reproduces the live INFRA session-limit incident: seconds resetsAt + fractional utilization decode correctly", () => {
    const w = normalizeClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.94, resetsAt: 1_787_015_400 });
    expect(w!.usedFraction).toBeCloseTo(0.94);
    expect(w!.resetsAt).toBe(1_787_015_400_000);
    expect(new Date(w!.resetsAt).toISOString()).toBe("2026-08-18T01:10:00.000Z"); // 04:10 Europe/Istanbul (UTC+3)
    expect(w!.windowStartedAt).toBe(1_787_015_400_000 - 5 * 60 * 60 * 1000);
  });
});

describe("ClaudeAgentBackend: rate_limit_event -> quota BackendEvent", () => {
  it("sinks a quota event carrying the normalized window", async () => {
    const evs = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1_700_000_000 }, uuid: "u1", session_id: "s1" },
    ]);
    const quota = evs.find((e) => e.kind === "quota");
    expect(quota).toBeDefined();
    const resetsAtMs = 1_700_000_000 * 1000;
    expect(quota!.data["window"]).toEqual({ kind: "session", usedFraction: 0.3, windowStartedAt: resetsAtMs - 5 * 60 * 60 * 1000, resetsAt: resetsAtMs });
  });

  // EXTRA-USAGE-VISIBILITY: this used to assert that an overage-only event sinks NOTHING, on the
  // grounds that overage is a spend budget and not a renderable time window. The first half is
  // right and still holds (`window` stays absent); the conclusion was the gap. Dropping the event
  // entirely meant chimera held an agent until reset while unable to say whether the account could
  // have continued at all, and the operator had no view of the allowance the provider's own UI
  // shows them. It now sinks the overage payload WITHOUT a window.
  it("sinks the overage payload for an overage-only rate_limit_info — but still no window", async () => {
    const evs = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage", isUsingOverage: true }, uuid: "u1", session_id: "s1" },
    ]);
    const quotas = evs.filter((e) => e.kind === "quota");
    expect(quotas.some((e) => e.data["window"] !== undefined)).toBe(false);
    expect(quotas.find((e) => e.data["overage"] !== undefined)?.data["overage"]).toMatchObject({ inUse: true });
  });

  it("sinks NOTHING for an event that mentions neither a window nor overage", async () => {
    // The genuine no-op case the old assertion was reaching for: nothing recognizable at all.
    const evs = await run([
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "something_new" }, uuid: "u1", session_id: "s1" },
    ]);
    expect(evs.find((e) => e.kind === "quota")).toBeUndefined();
  });
});
