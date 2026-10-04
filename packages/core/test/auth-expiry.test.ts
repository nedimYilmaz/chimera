import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor, makeEngineHome } from "./helpers.js";

// Task AUTH-a: per-account auth-STATE tracking. Mirrors the existing CooldownTracker
// pattern (supervisor-failover.test.ts / engine-phase3.test.ts) but for auth expiry
// instead of rate-limit cooldowns.

const AUTH_ERROR_STEP: FakeStep = { emit: { kind: "status", data: { authError: "authentication_failed" } } };
const RATE_FAIL: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];

describe("AgentSupervisor: authExpiredAccounts (Task AUTH-a)", () => {
  it("a status{authError} event marks the agent's account authExpired", async () => {
    const { sup } = makeSupervisor([[AUTH_ERROR_STEP, { end: { resultText: "done" } }]]);
    expect(sup.authExpiredAccounts().has("main")).toBe(false);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.authExpiredAccounts().has("main")).toBe(true);
  });

  it("a subsequent agent_started for an agent on that account clears authExpired", async () => {
    const { sup } = makeSupervisor([
      [AUTH_ERROR_STEP, { end: { resultText: "done" } }],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done2" } }],
    ]);
    const rec1 = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec1.agentId, 1000);
    expect(sup.authExpiredAccounts().has("main")).toBe(true);

    const rec2 = await sup.spawn({ prompt: "y", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec2.agentId, 1000);
    expect(sup.authExpiredAccounts().has("main")).toBe(false);
  });

  // ---------- additional branch/edge coverage ----------

  it("authExpiredAccounts() starts empty for a fresh supervisor", () => {
    const { sup } = makeSupervisor([]);
    expect(sup.authExpiredAccounts().size).toBe(0);
  });

  it("an auth error on one account does not mark a different account expired", async () => {
    const { sup } = makeSupervisor([
      [AUTH_ERROR_STEP, { end: { resultText: "done" } }],
      [{ end: { resultText: "done2" } }],
    ]);
    const rec1 = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec1.agentId, 1000);
    const rec2 = await sup.spawn({ prompt: "y", cwd: "/tmp", isolation: "none", account: "second" });
    await sup.waitFor(rec2.agentId, 1000);
    expect(sup.authExpiredAccounts().has("main")).toBe(true);
    expect(sup.authExpiredAccounts().has("second")).toBe(false);
  });

  it("agent_started clearing authExpired on an account that was never expired is a harmless no-op", async () => {
    const { sup } = makeSupervisor([[{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await expect(sup.waitFor(rec.agentId, 1000)).resolves.toMatchObject({ state: "done" });
    expect(sup.authExpiredAccounts().has("main")).toBe(false);
  });

  it("a non-auth error (kind:'error', rate-limit classified) does NOT set authExpired (regression)", async () => {
    const { sup } = makeSupervisor([RATE_FAIL, RATE_FAIL]);   // every account rate-limits, no authError kind involved
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.authExpiredAccounts().size).toBe(0);
  });

  it("a status event with a non-string authError value does not mark the account expired", async () => {
    const { sup } = makeSupervisor([
      [{ emit: { kind: "status", data: { authError: 123 } } }, { end: { resultText: "done" } }],
    ]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.authExpiredAccounts().has("main")).toBe(false);
  });

  it("authExpiredAccounts() returns a live view — reflects state after it was previously read", async () => {
    const { sup } = makeSupervisor([[AUTH_ERROR_STEP, { end: { resultText: "done" } }]]);
    const view = sup.authExpiredAccounts();
    expect(view.has("main")).toBe(false);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await sup.waitFor(rec.agentId, 1000);
    expect(view.has("main")).toBe(true);   // same reference reflects the mutation (ReadonlySet, not a snapshot)
  });
});

describe("Engine daemon.status: accounts[].authExpired (Task AUTH-a)", () => {
  function engine(backend: AgentBackend) {
    return new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", backend]]) });
  }

  it("after an auth error on 'main', the accounts entry for 'main' has authExpired:true", async () => {
    const e = engine(new FakeAgentBackend([[AUTH_ERROR_STEP, { end: { resultText: "done" } }]]));
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const st = (await e.handle("daemon.status", {})) as {
      accounts: Array<{ name: string; authExpired: boolean }>;
    };
    const main = st.accounts.find((a) => a.name === "main")!;
    expect(main.authExpired).toBe(true);
  });

  it("baseline: with no auth error, daemon.status reports authExpired:false for every account (regression)", async () => {
    const e = engine(new FakeAgentBackend([]));
    const st = (await e.handle("daemon.status", {})) as {
      accounts: Array<{ name: string; authExpired: boolean; cooling: boolean }>;
    };
    expect(st.accounts).toEqual([{
      name: "main", provider: "claude", authType: "subscription", remoteControlCapable: true,
      cooling: false, coolingUntil: null, authExpired: false,
    }]);
  });

  it("a non-auth error (rate_limit style) does not flip authExpired in daemon.status (regression)", async () => {
    const e = engine(new FakeAgentBackend([RATE_FAIL]));
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none", account: "main" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const st = (await e.handle("daemon.status", {})) as {
      accounts: Array<{ name: string; authExpired: boolean }>;
    };
    expect(st.accounts.find((a) => a.name === "main")!.authExpired).toBe(false);
  });
});
