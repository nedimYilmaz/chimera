import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { AgentSpecSchema, ChimeraConfigSchema, type AgentSpec } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import {
  GuardrailError, UnknownAgentError, AgentNotRunningError, AgentSupervisor, autoDecision, type AgentState,
} from "@chimera/core/supervisor";
import { CFG, fakeExec, makeSupervisor } from "./helpers.js";

const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok", costUsd: 0.01 } }];

// Local rig (not exported from helpers.ts, which is a fixed shared shape per
// the brief) that additionally exposes the CooldownTracker instance so tests
// can drive an account into cooldown directly — makeSupervisor() intentionally
// does not expose it.
function makeSupervisorWithCooldowns(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-cd-"));
  const fake = new FakeAgentBackend(scenarios);
  const cooldowns = new CooldownTracker(60_000);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns,
  });
  return { sup, fake, cooldowns };
}

describe("AgentSupervisor spawn lifecycle", () => {
  it("spawns on an explicit account, injects env, reaches done", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "do X", cwd: "/tmp", account: "second", isolation: "none" });
    expect(rec.state).toBe("running");
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("ok");
    expect(final.costUsd).toBeCloseTo(0.01);
    const resolved = fake.spawns[0]!;
    expect(resolved.accountName).toBe("second");
    expect(resolved.env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-second");
    expect(resolved.env["CHIMERA_AGENT_ID"]).toBe(rec.agentId);
    expect(resolved.env["CHIMERA_DEPTH"]).toBe("0");
  });

  it("subscription injects no credential env", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(Object.keys(fake.spawns[0]!.env).sort()).toEqual(["CHIMERA_AGENT_ID", "CHIMERA_DEPTH", "CHIMERA_TREE_ID"]);
  });

  it("auto routing picks the first non-cooling account in autoOrder", async () => {
    const { sup, fake } = makeSupervisor([HAPPY, HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });          // account defaults to "auto"
    expect(fake.spawns[0]!.accountName).toBe("main");
  });

  it("enforces per-account and global caps as guardrail errors", async () => {
    const wait: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "-" } }];
    const { sup } = makeSupervisor([wait, wait, wait]);
    await sup.spawn({ prompt: "1", cwd: "/tmp", account: "main", isolation: "none" });
    await expect(sup.spawn({ prompt: "2", cwd: "/tmp", account: "main", isolation: "none" }))
      .rejects.toBeInstanceOf(GuardrailError);                                  // perAccount.main = 1
    await sup.spawn({ prompt: "3", cwd: "/tmp", account: "second", isolation: "none" });
    await expect(sup.spawn({ prompt: "4", cwd: "/tmp", account: "second", isolation: "none" }))
      .rejects.toBeInstanceOf(GuardrailError);                                  // maxAgentsTotal = 2
  });

  it("rejects spawns beyond orchestration.maxDepth", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 3 }))
      .rejects.toBeInstanceOf(GuardrailError);
  });

  it("kill stops a running agent", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.kill(rec.agentId);
    expect(sup.status(rec.agentId).state).toBe("killed");
  });

  it("a waitFor() pending when kill() runs resolves with killed instead of timing out", async () => {
    // the agent never emits a terminal event on its own (parked at awaitSend),
    // so waitFor can only observe the transition if kill() publishes an event
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    const waiting = sup.waitFor(rec.agentId, 5000);   // pending, not awaited yet
    await sup.kill(rec.agentId);
    const final = await waiting;                        // must resolve, not reject with a timeout
    expect(final.state).toBe("killed");
  });
});

describe("AgentSupervisor spawn: explicit agentId (CR1)", () => {
  it("spawn(input, { agentId }) reuses the given id for the record, treeId default, and its emitted events", async () => {
    const { sup, fake, events } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "fixed-id" });
    expect(rec.agentId).toBe("fixed-id");
    expect(rec.treeId).toBe("fixed-id");                 // unchanged default: treeId falls back to agentId
    expect(fake.spawns[0]!.agentId).toBe("fixed-id");     // the backend saw the fixed id too
    const final = await sup.waitFor("fixed-id", 1000);    // fake backend events are deferred via setTimeout
    expect(final.state).toBe("done");
    const tail = events.tail("fixed-id", 10);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((e) => e.agentId === "fixed-id")).toBe(true);
  });

  it("a spawn without opts.agentId still gets a fresh uuid (no regression)", async () => {
    const { sup } = makeSupervisor([HAPPY, HAPPY]);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rec1 = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const rec2 = await sup.spawn({ prompt: "y", cwd: "/tmp", account: "second", isolation: "none" });
    expect(rec1.agentId).toMatch(UUID_RE);
    expect(rec2.agentId).toMatch(UUID_RE);
    expect(rec1.agentId).not.toBe(rec2.agentId);
  });

  it("an explicit opts.agentId still respects the treeId override when both are given", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none" },
      { agentId: "fixed-id-2", treeId: "some-other-tree" },
    );
    expect(rec.agentId).toBe("fixed-id-2");
    expect(rec.treeId).toBe("some-other-tree");
  });
});

// ---------- additional coverage: edges and branches beyond the brief's examples ----------

describe("AgentSupervisor: depth guardrail boundaries", () => {
  it("allows depth exactly equal to effectiveMax (boundary is inclusive)", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    // default orchestration.maxDepth is 2 (schema default); depth===maxDepth must pass
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 2 });
    expect(rec.state).toBe("running");
  });

  it("a child cannot escape the parent's maxDepthCap by claiming a higher orchestration.maxDepth", async () => {
    const { sup } = makeSupervisor([HAPPY, HAPPY]);
    // spec claims maxDepth: 10, but the parent caps recursion at 1
    const atCap = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", orchestration: { maxDepth: 10 } },
      { depth: 1, maxDepthCap: 1 },
    );
    expect(atCap.state).toBe("running");
    await expect(sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", orchestration: { maxDepth: 10 } },
      { depth: 2, maxDepthCap: 1 },
    )).rejects.toBeInstanceOf(GuardrailError);
  });

  it("opts.maxDepthCap undefined falls back to Infinity (spec's own maxDepth governs)", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", orchestration: { maxDepth: 5 } },
      { depth: 5 },
    );
    expect(rec.state).toBe("running");
  });
});

describe("AgentSupervisor: routing", () => {
  it("throws when an explicit account name is unknown", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", account: "ghost", isolation: "none" }))
      .rejects.toThrow();
  });

  it("auto routing skips an account that is cooling down", async () => {
    const { sup, fake, cooldowns } = makeSupervisorWithCooldowns([HAPPY]);
    cooldowns.stamp("main");
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.accountName).toBe("second");
  });

  it("throws GuardrailError when every autoOrder account is cooling down", async () => {
    expect.assertions(1);
    const { sup, cooldowns } = makeSupervisorWithCooldowns([]);
    cooldowns.stamp("main");
    cooldowns.stamp("second");
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }))
      .rejects.toBeInstanceOf(GuardrailError);
  });

  // P4.8: routeAccount dropped its Phase-1 `requiredProvider?` param — spec §7
  // confinement now comes from `spec.provider` itself (no account in this CFG
  // is "codex", so no autoOrder entry can match it).
  it("routeAccount (protected) throws when spec.provider matches no autoOrder account", () => {
    const { sup } = makeSupervisor([]);
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", provider: "codex" });
    expect(() => (sup as unknown as { routeAccount(s: AgentSpec): string })
      .routeAccount(spec)).toThrow(GuardrailError);
  });

  it("routeAccount (protected) returns a match when spec.provider agrees with an autoOrder account's provider", () => {
    const { sup } = makeSupervisor([]);
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", provider: "claude" });
    const name = (sup as unknown as { routeAccount(s: AgentSpec): string })
      .routeAccount(spec);
    expect(name).toBe("main");
  });
});

describe("AgentSupervisor: onEvent commit-before-append ordering", () => {
  it("commits done state (with resultText/costUsd) before the terminal 'result' event is appended", async () => {
    const { sup, events } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const seen: AgentState[] = [];
    events.subscribe((e) => {
      if (e.agentId === rec.agentId && e.kind === "result") seen.push(sup.status(rec.agentId).state);
    });
    await sup.waitFor(rec.agentId, 1000);
    expect(seen).toEqual(["done"]);
  });

  it("commits failed state (via onError) before the 'error' event is appended", async () => {
    const { sup, events } = makeSupervisor([[{ fail: { message: "boom" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const seen: AgentState[] = [];
    events.subscribe((e) => {
      if (e.agentId === rec.agentId && e.kind === "error") seen.push(sup.status(rec.agentId).state);
    });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(seen).toEqual(["failed"]);
    expect(final.state).toBe("failed");
  });
});

describe("AgentSupervisor: event data defaults and coercion", () => {
  it("defaults resultText to empty string and costUsd to 0 when a result event omits them", async () => {
    const scenario: FakeStep[] = [{ emit: { kind: "result", data: {} } }];
    const { sup } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.resultText).toBe("");
    expect(final.costUsd).toBe(0);
  });

  it("handles an error event with no message without throwing, and still marks failed", async () => {
    const scenario: FakeStep[] = [{ emit: { kind: "error", data: {} } }];
    const { sup } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
  });

  it("captures sessionId from an agent_started event", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-123" } } },
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(rec.sessionId).toBeUndefined();      // event hasn't fired yet (deferred via setTimeout in the fake)
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.sessionId).toBe("sess-123");
  });

  it("ignores a non-string sessionId on agent_started", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: 12345 } } },
      { end: { resultText: "ok" } },
    ];
    const { sup } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.sessionId).toBeUndefined();
  });
});

describe("AgentSupervisor: secret redaction (spec §6)", () => {
  it("redacts a resolved credential value out of event data before appending", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "status", data: { note: "leaked tok-second value", count: 3 } } },
      { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    // PROJECT-CONDUCTOR-VISIBILITY: spawn() now appends its OWN leading status event
    // (registration marker) before any backend event — .at(-1) picks the LAST status
    // event (this test's crafted one), not that registration marker.
    const statusEvent = events.tail(rec.agentId, 10).filter((e) => e.kind === "status").at(-1);
    expect(statusEvent?.data["note"]).toBe("leaked [REDACTED] value");
    expect(statusEvent?.data["count"]).toBe(3);          // non-string values pass through untouched
  });

  it("does not alter event data when no credential has been resolved (subscription, no secrets)", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "status", data: { note: "nothing sensitive here", count: 7 } } },
      { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    // PROJECT-CONDUCTOR-VISIBILITY: spawn() now appends its OWN leading status event
    // (registration marker) before any backend event — .at(-1) picks the LAST status
    // event (this test's crafted one), not that registration marker.
    const statusEvent = events.tail(rec.agentId, 10).filter((e) => e.kind === "status").at(-1);
    expect(statusEvent?.data).toEqual({ note: "nothing sensitive here", count: 7 });
  });

  it("redacts a secret NESTED inside event data (object nested under a key) before persisting", async () => {
    expect.assertions(2);
    const scenario: FakeStep[] = [
      { emit: { kind: "status", data: { outer: { token: "tok-second" } } } },
      { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    // PROJECT-CONDUCTOR-VISIBILITY: spawn() now appends its OWN leading status event
    // (registration marker) before any backend event — .at(-1) picks the LAST status
    // event (this test's crafted one), not that registration marker.
    const statusEvent = events.tail(rec.agentId, 10).filter((e) => e.kind === "status").at(-1);
    const persisted = JSON.stringify(statusEvent?.data);
    expect(persisted).not.toContain("tok-second");
    expect(persisted).toContain("[REDACTED]");
  });

  it("redacts a secret echoed in the backend event's raw payload before persisting", async () => {
    expect.assertions(2);
    const scenario: FakeStep[] = [
      { emit: { kind: "status", data: {}, raw: { echoed: "tok-second" } } },
      { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    // PROJECT-CONDUCTOR-VISIBILITY: spawn() now appends its OWN leading status event
    // (registration marker) before any backend event — .at(-1) picks the LAST status
    // event (this test's crafted one), not that registration marker.
    const statusEvent = events.tail(rec.agentId, 10).filter((e) => e.kind === "status").at(-1);
    const persisted = JSON.stringify(statusEvent?.raw);
    expect(persisted).not.toContain("tok-second");
    expect(persisted).toContain("[REDACTED]");
  });

  it("deep-redacts a secret inside an ARRAY element of raw (SDK content-block shape) before persisting", async () => {
    expect.assertions(2);
    // SDK assistant payloads carry arrays (message.content: [...]); scrubValue's
    // Array.isArray recursion must reach a token echoed inside an array element,
    // not just object-nested ones — this is the shape real Claude raw payloads have.
    const scenario: FakeStep[] = [
      { emit: { kind: "status", data: {}, raw: { content: [{ type: "text", text: "token is tok-second here" }] } } },
      { end: { resultText: "ok" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    // PROJECT-CONDUCTOR-VISIBILITY: spawn() now appends its OWN leading status event
    // (registration marker) before any backend event — .at(-1) picks the LAST status
    // event (this test's crafted one), not that registration marker.
    const statusEvent = events.tail(rec.agentId, 10).filter((e) => e.kind === "status").at(-1);
    const persisted = JSON.stringify(statusEvent?.raw);
    expect(persisted).not.toContain("tok-second");   // array recursion reached the element
    expect(persisted).toContain("[REDACTED]");
  });
});

describe("AgentSupervisor: waitFor", () => {
  it("resolves immediately (pre-subscribe check) when the agent is already terminal", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);                // drive it to "done"
    const again = await sup.waitFor(rec.agentId, 1000);  // should return immediately, no hang
    expect(again.state).toBe("done");
  });

  it("rejects with a timeout error when the agent does not finish in time", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "late" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await expect(sup.waitFor(rec.agentId, 20)).rejects.toThrow(/timed out after 20ms/);
  });

  it("throws UnknownAgentError for an unknown agent id", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([]);
    await expect(sup.waitFor("nope", 100)).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("filters by agentId: another agent's events don't resolve or corrupt an unrelated waitFor", async () => {
    const doneA: FakeStep[] = [{ end: { resultText: "A" } }];
    const doneB: FakeStep[] = [{ end: { resultText: "B" } }];
    const { sup } = makeSupervisor([doneA, doneB]);
    const a = await sup.spawn({ prompt: "a", cwd: "/tmp", account: "main", isolation: "none" });
    const b = await sup.spawn({ prompt: "b", cwd: "/tmp", account: "second", isolation: "none" });
    const [finalA, finalB] = await Promise.all([
      sup.waitFor(a.agentId, 1000),
      sup.waitFor(b.agentId, 1000),
    ]);
    expect(finalA.resultText).toBe("A");
    expect(finalB.resultText).toBe("B");
  });
});

describe("AgentSupervisor: status/result/list", () => {
  it("status throws UnknownAgentError for an unknown id", () => {
    const { sup } = makeSupervisor([]);
    expect(() => sup.status("nope")).toThrow(UnknownAgentError);
  });

  it("result returns state/text/costUsd for a finished agent", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.result(rec.agentId)).toEqual({ state: "done", text: "ok", costUsd: 0.01 });
  });

  it("result throws UnknownAgentError for an unknown id", () => {
    const { sup } = makeSupervisor([]);
    expect(() => sup.result("nope")).toThrow(UnknownAgentError);
  });

  it("list returns every spawned agent record", async () => {
    const { sup } = makeSupervisor([HAPPY, HAPPY]);
    const a = await sup.spawn({ prompt: "a", cwd: "/tmp", account: "main", isolation: "none" });
    const b = await sup.spawn({ prompt: "b", cwd: "/tmp", account: "second", isolation: "none" });
    const ids = sup.list().map((r) => r.agentId).sort();
    expect(ids).toEqual([a.agentId, b.agentId].sort());
  });

  it("every record defaults principal to 'local'", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(rec.principal).toBe("local");
  });
});

describe("AgentSupervisor: kill", () => {
  it("throws UnknownAgentError for an unknown id", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([]);
    await expect(sup.kill("nope")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("is a no-op on state when the agent already finished (does not clobber 'done' with 'killed')", async () => {
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    await sup.kill(rec.agentId);
    expect(sup.status(rec.agentId).state).toBe("done");
  });
});

// NOTE: the Task-8 placeholder test asserting `send()` rejected with
// /Task 10/ for a running agent was removed here — Task 10 replaced that
// stub with the real mailbox-delivery implementation (see
// supervisor-mailbox.test.ts for "send() enqueues and delivers to a live
// agent"), so that assertion is no longer a valid contract.
describe("AgentSupervisor: send guards / respondPermission stub (extended by Task 11)", () => {
  it("send throws AgentNotRunningError for a killed agent", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.kill(rec.agentId);
    await expect(sup.send(rec.agentId, "hi")).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("send throws AgentNotRunningError for a done agent", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    await expect(sup.send(rec.agentId, "hi")).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("respondPermission always returns false in Task 8", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.respondPermission("req-1", true)).toBe(false);
    expect(sup.respondPermission("req-1", false)).toBe(false);
  });
});

describe("AgentSupervisor: input validation", () => {
  it("propagates a schema validation error for malformed input (missing required prompt)", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([]);
    await expect(sup.spawn({ cwd: "/tmp" })).rejects.toThrow();
  });
});

// WORKFLOW-FIX-READONLY-ISOLATION: a readOnly spawn never mutates the checkout, so
// defaulting it into a worktree (AgentSpecSchema's own default) just orphans one per
// spawn. resolveAgentSpec (supervisor.ts) special-cases this at spawn-resolve time —
// only when the caller left isolation unset entirely, so an explicit choice still wins.
describe("AgentSupervisor: readOnly isolation default (WORKFLOW-FIX-READONLY-ISOLATION)", () => {
  it("readOnly + isolation unset resolves to \"none\" (no worktree)", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", permissionProfile: "readOnly" });
    expect(fake.spawns[0]!.isolation).toBe("none");
  });

  it("readOnly + isolation explicitly \"worktree\" still gets a worktree", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", permissionProfile: "readOnly", isolation: "worktree" });
    expect(fake.spawns[0]!.isolation).toBe("worktree");
  });

  it("readOnly + isolation explicitly \"none\" stays \"none\"", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", permissionProfile: "readOnly", isolation: "none" });
    expect(fake.spawns[0]!.isolation).toBe("none");
  });

  it("acceptEdits (default profile) + isolation unset is unchanged: still defaults to \"worktree\"", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second" });   // permissionProfile omitted -> defaults "acceptEdits"
    expect(fake.spawns[0]!.isolation).toBe("worktree");
  });

  it("full + isolation unset is unchanged: still defaults to \"worktree\"", async () => {
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "second", permissionProfile: "full" });
    expect(fake.spawns[0]!.isolation).toBe("worktree");
  });
});

// P4.8: routeAccount now rejects an explicit account whose OWN provider
// mismatches spec.provider with a GuardrailError before launch() ever runs —
// so the old "account: main, provider: codex" trick (mismatch used purely to
// reach launch()'s missing-backend guard) no longer gets there. This rig adds
// a "cx" account whose OWN provider is codex (no spec.provider override, so
// no mismatch trips in routeAccount) while `backends` still registers only
// "claude" — launch() must still reject for a genuinely unregistered provider.
function makeSupervisorWithUnbackedCodexAccount(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-nobackend-"));
  const cfg = ChimeraConfigSchema.parse({
    accounts: [...CFG.accounts, { name: "cx", provider: "codex", auth: { type: "env", var: "CHIMERA_TEST_UNUSED_VAR", injectAs: "OPENAI_API_KEY" } }],
    autoOrder: CFG.autoOrder,
    caps: CFG.caps,
  });
  const fake = new FakeAgentBackend(scenarios);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),   // no "codex" entry — launch() must reject
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
  });
  return { sup, fake };
}

describe("AgentSupervisor: launch guardrails", () => {
  it("throws UnknownAgentError when no backend is registered for the resolved provider", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisorWithUnbackedCodexAccount([]);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx", isolation: "none" }))
      .rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("does not leak a running record into the agent map when launch() fails", async () => {
    const { sup } = makeSupervisorWithUnbackedCodexAccount([]);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx", isolation: "none" }))
      .rejects.toBeInstanceOf(UnknownAgentError);
    expect(sup.list()).toEqual([]);
  });

  it("a subsequent valid spawn still succeeds after a failed launch (no cap slot consumed)", async () => {
    const { sup } = makeSupervisorWithUnbackedCodexAccount([HAPPY]);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx", isolation: "none" }))
      .rejects.toBeInstanceOf(UnknownAgentError);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(rec.state).toBe("running");
    expect(sup.list()).toHaveLength(1);
  });
});

describe("AgentSupervisor: permission decision wiring (base = profile autoDecision)", () => {
  it("auto-allows edit tools and denies others under the default 'acceptEdits' profile", async () => {
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash" } },
      { askPermission: { toolName: "Edit" } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 10);
    // PROJECT-CONDUCTOR-VISIBILITY: skip the leading registration status event (spawn()
    // now appends one for every record) — the denial is the LAST status event.
    const denied = tail.filter((e) => e.kind === "status").at(-1);
    const allowed = tail.find((e) => e.kind === "tool_call");
    expect(denied?.data).toEqual({ denied: true, toolName: "Bash" });
    expect(allowed?.data).toEqual({ toolName: "Edit" });
  });
});

describe("AgentSupervisor: typed error names (log readability)", () => {
  it("GuardrailError reports its own name (not 'Error')", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([]);
    try {
      await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 99 });
    } catch (e) {
      expect((e as Error).name).toBe("GuardrailError");
    }
  });

  it("UnknownAgentError reports its own name (not 'Error')", () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([]);
    try {
      sup.status("nope");
    } catch (e) {
      expect((e as Error).name).toBe("UnknownAgentError");
    }
  });

  it("AgentNotRunningError reports its own name (not 'Error')", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    try {
      await sup.send(rec.agentId, "hi");
    } catch (e) {
      expect((e as Error).name).toBe("AgentNotRunningError");
    }
  });
});

describe("autoDecision", () => {
  it("full profile allows any tool", () => {
    expect(autoDecision("full", "Bash")).toBe(true);
    expect(autoDecision("full", "Read")).toBe(true);
  });

  it("read-only tools are always allowed regardless of profile", () => {
    expect(autoDecision("readOnly", "Read")).toBe(true);
    expect(autoDecision("readOnly", "Grep")).toBe(true);
    expect(autoDecision("readOnly", "Glob")).toBe(true);
    expect(autoDecision("readOnly", "WebFetch")).toBe(true);
    expect(autoDecision("readOnly", "WebSearch")).toBe(true);
    expect(autoDecision("acceptEdits", "Read")).toBe(true);
  });

  it("readOnly profile denies edit tools and other tools", () => {
    expect(autoDecision("readOnly", "Edit")).toBe(false);
    expect(autoDecision("readOnly", "Bash")).toBe(false);
  });

  it("acceptEdits profile allows edit tools but denies everything else", () => {
    expect(autoDecision("acceptEdits", "Edit")).toBe(true);
    expect(autoDecision("acceptEdits", "Write")).toBe(true);
    expect(autoDecision("acceptEdits", "MultiEdit")).toBe(true);
    expect(autoDecision("acceptEdits", "NotebookEdit")).toBe(true);
    expect(autoDecision("acceptEdits", "Bash")).toBe(false);
  });

  it("chimera coordination MCP tools are allowed under every profile (the injected coordination substrate)", () => {
    for (const profile of ["readOnly", "acceptEdits", "full"] as const) {
      expect(autoDecision(profile, "mcp__chimera__memory_search")).toBe(true);
      expect(autoDecision(profile, "mcp__chimera__memory_add")).toBe(true);
      expect(autoDecision(profile, "mcp__chimera__my_team")).toBe(true);
      expect(autoDecision(profile, "mcp__chimera__ask_agent")).toBe(true);
      expect(autoDecision(profile, "mcp__chimera__team_update")).toBe(true);
    }
  });

  it("non-chimera MCP tools remain gated by profile (only the chimera prefix is auto-allowed)", () => {
    expect(autoDecision("readOnly", "mcp__other__do_thing")).toBe(false);
    expect(autoDecision("acceptEdits", "mcp__github__create_pr")).toBe(false);
  });

  // READONLY-BASH-NO-PROMPT / PERM-READONLY-FALSE-PROMPTS: isReadOnlyBash is consulted
  // ONLY when a command string is actually passed — every call above with no third
  // argument stays byte-identical (still denies Bash outright), proving this is purely
  // additive.
  it("acceptEdits auto-allows a Bash call only when the command is provably read-only", () => {
    expect(autoDecision("acceptEdits", "Bash", "grep -rn foo src/")).toBe(true);
    expect(autoDecision("acceptEdits", "Bash", "rm -rf build")).toBe(false);
    expect(autoDecision("acceptEdits", "Bash")).toBe(false);          // no command → unchanged from before
  });

  it("full ignores the command — already allows unconditionally, unaffected", () => {
    expect(autoDecision("full", "Bash", "rm -rf build")).toBe(true);
  });

  // PERM-READONLY-FALSE-PROMPTS: explicit operator override of the earlier "readOnly must
  // keep denying every shell call by design" contract — a provably read-only Bash command
  // (isReadOnlyBash fails closed on anything it can't prove) now auto-allows under
  // "readOnly" too, same as "acceptEdits". A non-provably-read-only command still denies.
  it("readOnly auto-allows a Bash call only when the command is provably read-only", () => {
    expect(autoDecision("readOnly", "Bash", "grep -rn foo src/")).toBe(true);
    expect(autoDecision("readOnly", "Bash", "rm -rf build")).toBe(false);
    expect(autoDecision("readOnly", "Bash")).toBe(false);             // no command → still denies
  });
});
