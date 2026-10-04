import { describe, it, expect } from "vitest";
import { AgentSpecSchema, ChimeraConfigSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import type { FakeStep } from "@chimera/core/backends/fake";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { classifyError, parseSessionLimit } from "@chimera/core/failover";
import { makeSupervisor } from "./helpers.js";

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  // Mirrors the real SDK: it reads the initial prompt off the streaming input AsyncQueue, so
  // that item must actually drain here too, or AsyncQueue.isEmpty() stays permanently false and
  // the backend's one-shot input.close() branch never fires in the test.
  const fn = ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) break;
        for (const m of messages) yield m;
      },
      interrupt: async () => {},
    };
  }) as never;
  return { fn };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

const ERROR_RESULT: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m1" },
  {
    type: "result", subtype: "success", is_error: true,
    result: "You've hit your session limit · resets 11:30am (Europe/Istanbul)",
    total_cost_usd: 0.01,
  },
];

async function runResultEvents(over: Record<string, unknown>): Promise<BackendEvent[]> {
  const { fn } = fakeQuery(ERROR_RESULT);
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(over), (e) => evs.push(e), async () => true);
  await settle();
  return evs;
}
async function runResultMessage(over: Record<string, unknown>): Promise<string[]> {
  const evs = await runResultEvents(over);
  return evs.map((e) => e.kind);
}

// A result message carrying is_error must become an `error` event when the agent keeps its
// input open (conductor/persistent) — the SDK stream never terminates there, so nothing else
// will ever surface it. It must NOT be emitted for a one-shot agent, where the SDK throws.
describe("claude backend: is_error result", () => {
  it("emits an error event for a persistent agent", async () => {
    const kinds = await runResultMessage({ persistent: true, conductor: false });
    expect(kinds).toContain("error");
  });

  it("does not emit an error event for a one-shot agent", async () => {
    const kinds = await runResultMessage({ persistent: false, conductor: false });
    expect(kinds).not.toContain("error");
  });

  it("tags turn_complete so the supervisor can tell a failed turn from a clean one", async () => {
    const events = await runResultEvents({ persistent: true, conductor: false });
    const tc = events.find((e) => e.kind === "turn_complete");
    expect(tc?.data["errorResult"]).toBe(true);
  });
});

// Poll a predicate to a deadline, mirroring the same helper used throughout
// supervisor-session-limit.test.ts for the same class of real-timer state transitions.
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met before deadline");
}

function accountsConfig(names: string[]) {
  return ChimeraConfigSchema.parse({
    accounts: names.map((n, i) =>
      i === 0
        ? { name: n, provider: "claude", auth: { type: "subscription" } }
        : { name: n, provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
    ),
    autoOrder: names,
  });
}

// A rate-limit failure that fires only after receiving the mailbox message via `send()` —
// awaitSend blocks the fake's run loop until the supervisor actually delivers, so the
// message is guaranteed to be recorded as in-flight before the turn dies.
const RATE_LIMIT_AFTER_SEND: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { fail: { message: `You've hit your session limit · resets at ${new Date(Date.now() + 3600_000).toISOString()}` } },
];
const HAPPY_AFTER_SEND: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { awaitSend: true },
  { end: { resultText: "recovered" } },
];

async function runFailoverScenario(opts: {
  persistent: boolean;
  accounts: string[];
  allCooling?: boolean;
}): Promise<{ events: BackendEvent[]; mailboxDepth: number }> {
  const cfg = accountsConfig(opts.accounts);
  const scenarios = opts.accounts.length > 1 ? [RATE_LIMIT_AFTER_SEND, HAPPY_AFTER_SEND] : [RATE_LIMIT_AFTER_SEND];
  const { sup, dir, cooldowns } = makeSupervisor(scenarios as never, cfg);

  const rec = await sup.spawn({ prompt: "task", cwd: "/tmp", isolation: "none", persistent: opts.persistent, account: "auto" });
  await until(() => sup.status(rec.agentId).state === "running");
  // stamp cooling AFTER the initial spawn succeeds — spawn() itself calls routeAccount and
  // would throw "no account available" if every account were already cooling at spawn time.
  if (opts.allCooling) for (const a of opts.accounts) cooldowns.stamp(a);
  await sup.send(rec.agentId, "the prompt");
  // let the rate-limit failure, failover decision, and (if any) relaunch settle.
  await new Promise((r) => setTimeout(r, 80));

  const events = new EventLog(dir).tail(rec.agentId, 200);
  const mailboxDepth = new MailboxStore(dir).pending(rec.agentId).length;
  return { events, mailboxDepth };
}

async function runCleanTurnThenUnrelatedError(opts: { persistent: boolean }): Promise<{ events: BackendEvent[] }> {
  const cfg = accountsConfig(["A"]);
  const CLEAN_THEN_FAIL: FakeStep[] = [
    { emit: { kind: "agent_started", data: {} } },
    { awaitSend: true },
    { turn: {} },
    { fail: { message: "boom: unrelated crash, not a rate limit" } },
  ];
  const { sup, dir } = makeSupervisor([CLEAN_THEN_FAIL] as never, cfg);
  const rec = await sup.spawn({ prompt: "task", cwd: "/tmp", isolation: "none", persistent: opts.persistent, account: "auto" });
  await until(() => sup.status(rec.agentId).state === "running");
  await sup.send(rec.agentId, "clean turn message");
  // give the clean turn_complete time to fire and clear inFlight before the unrelated error.
  await until(() => sup.status(rec.agentId).state === "failed", 3000);

  const events = new EventLog(dir).tail(rec.agentId, 200);
  return { events };
}

describe("in-flight prompt survives an account switch", () => {
  it("re-delivers the prompt on the new account after a rate-limit failover", async () => {
    const { events } = await runFailoverScenario({ persistent: true, accounts: ["A", "B"] });
    expect(events.filter((e) => e.kind === "failover")).toHaveLength(1);
    const delivered = events.filter((e) => e.kind === "status" && e.data["delivered"] === true);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.data["text"]).toBe(delivered[0]!.data["text"]);
  });

  it("fails over exactly once for a one-shot agent (no double onError)", async () => {
    const { events } = await runFailoverScenario({ persistent: false, accounts: ["A", "B"] });
    expect(events.filter((e) => e.kind === "failover")).toHaveLength(1);
  });

  it("retains the message when every eligible account is cooling", async () => {
    const { mailboxDepth } = await runFailoverScenario({ persistent: true, accounts: ["A"], allCooling: true });
    expect(mailboxDepth).toBe(1);
  });

  it("clears in-flight on a clean turn so no phantom redelivery occurs", async () => {
    const { events } = await runCleanTurnThenUnrelatedError({ persistent: true });
    const delivered = events.filter((e) => e.kind === "status" && e.data["delivered"] === true);
    expect(delivered).toHaveLength(1);
  });
});

// REGRESSION GUARD (account-autoswitch Task 3): pins the EXACT production payload — a
// conductor's session-limit result arriving as `{ subtype: "success", is_error: true, result:
// "You've hit your session limit · resets 11:30am (Europe/Istanbul)" }` — to the failover path.
// The fix emits this raw text (no SDK "Claude Code returned an error result: " prefix) as the
// `error` event's message, so classifyError/parseSessionLimit must recognize the CONTENT, not a
// prefix that no longer exists on this path. If a future edit to the RATE/SESSION_LIMIT patterns
// silently broke that recognition, this message would surface as an error and then HARD-FAIL the
// persistent agent — strictly worse than the silent idle the fix replaces.
const REAL_SESSION_LIMIT_MESSAGE = "You've hit your session limit · resets 11:30am (Europe/Istanbul)";

describe("real session-limit payload (account-autoswitch regression guard)", () => {
  it("classifyError/parseSessionLimit recognize the exact production phrasing (no SDK prefix)", () => {
    expect(classifyError(REAL_SESSION_LIMIT_MESSAGE)).toBe("rate-limit");
    expect(parseSessionLimit(REAL_SESSION_LIMIT_MESSAGE)).not.toBeNull();
  });

  it("routes a persistent agent's real session-limit error through failover, not hold-only or hard-fail", async () => {
    const cfg = accountsConfig(["A", "B"]);
    const REAL_LIMIT_AFTER_SEND: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { awaitSend: true },
      { fail: { message: REAL_SESSION_LIMIT_MESSAGE } },
    ];
    const { sup, dir } = makeSupervisor([REAL_LIMIT_AFTER_SEND, HAPPY_AFTER_SEND] as never, cfg);
    const rec = await sup.spawn({ prompt: "task", cwd: "/tmp", isolation: "none", persistent: true, account: "auto" });
    await until(() => sup.status(rec.agentId).state === "running");
    await sup.send(rec.agentId, "the prompt");
    await new Promise((r) => setTimeout(r, 80));

    const events = new EventLog(dir).tail(rec.agentId, 200);
    // point 1: an `error` event is emitted for the raw result text.
    expect(events.some((e) => e.kind === "error" && e.data["message"] === REAL_SESSION_LIMIT_MESSAGE)).toBe(true);
    // point 4: the branch actually taken is failover — not hold-only, not hard-fail.
    const failoverEvents = events.filter((e) => e.kind === "failover");
    expect(failoverEvents).toHaveLength(1);
    expect(failoverEvents[0]!.data["reason"]).toBe(REAL_SESSION_LIMIT_MESSAGE);
    expect(events.some((e) => e.kind === "status" && e.data["state"] === "paused")).toBe(false);
    expect(events.some((e) => e.kind === "status" && e.data["state"] === "failed")).toBe(false);
  });
});

// CONDUCTOR-FAIL-REGRESSION: a persistent agent must NOT be killed by an ordinary failed turn.
// `is_error` is true for any failed turn, not just a limit. Emitting an `error` event for all of
// them routed every class into onError, which hard-fails whatever it cannot dispose of
// (state="failed") — so the FIRST unremarkable turn error killed a long-lived conductor that
// previously just idled. Observed in production: agent dc267a57 died on a result carrying
// is_error with no text at all, classified "unknown". Only a rate-limit-class result is
// actionable here, because only it has a failover disposition.
const NON_LIMIT_ERROR: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m1" },
  { type: "result", subtype: "success", is_error: true, total_cost_usd: 0.01 },
];
const TOOL_ERROR: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m1" },
  { type: "result", subtype: "success", is_error: true, result: "Tool execution failed", total_cost_usd: 0.01 },
];

async function kindsFor(messages: Msg[], over: Record<string, unknown>): Promise<string[]> {
  const { fn } = fakeQuery(messages);
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(over), (e) => evs.push(e), async () => true);
  await settle();
  return evs.map((e) => e.kind);
}

describe("claude backend: a non-limit error must not kill a persistent agent", () => {
  it("emits NO error event for an is_error result with no text", async () => {
    expect(await kindsFor(NON_LIMIT_ERROR, { persistent: true })).not.toContain("error");
  });

  it("emits NO error event for a non-limit failure message", async () => {
    expect(await kindsFor(TOOL_ERROR, { persistent: true })).not.toContain("error");
  });

  it("still emits an error event for a real session limit", async () => {
    expect(await kindsFor(ERROR_RESULT, { persistent: true })).toContain("error");
  });

  it("still tags turn_complete with errorResult regardless of class", async () => {
    const { fn } = fakeQuery(NON_LIMIT_ERROR);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ persistent: true }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.find((e) => e.kind === "turn_complete")?.data["errorResult"]).toBe(true);
  });
});
