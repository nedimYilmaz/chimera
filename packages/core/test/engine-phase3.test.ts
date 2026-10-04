import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { CooldownTracker } from "@chimera/core/failover";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

describe("CooldownTracker.snapshot", () => {
  it("lists only currently-cooling accounts with their until timestamps", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    expect(c.snapshot()).toEqual([]);
    c.stamp("second");
    expect(c.snapshot()).toEqual([{ account: "second", until: 61_000 }]);
    t += 60_001;
    expect(c.snapshot()).toEqual([]);
  });

  // ---------- additional coverage: boundary + multi-account branches ----------

  it("excludes an account exactly AT its cooldown boundary (exclusive, mirrors isCooling)", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    c.stamp("acct");
    t = 1000 + 60_000;                          // now() === until — the only point that distinguishes '>' from '>='
    expect(c.snapshot()).toEqual([]);           // released exactly at the boundary, not one tick later
  });

  it("lists only the currently-cooling subset when accounts are mixed (some cooling, some not)", () => {
    let t = 1000;
    const c = new CooldownTracker(60_000, () => t);
    c.stamp("main");
    t += 100;
    c.stamp("second");                          // stamped later -> different `until`
    expect(c.snapshot().sort((a, b) => a.account.localeCompare(b.account))).toEqual([
      { account: "main", until: 61_000 },
      { account: "second", until: 61_100 },
    ]);
  });
});

describe("Engine Phase 3 surface", () => {
  const engine = () => new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });

  it("daemon.status reports per-account cooldown info", async () => {
    const st = (await engine().handle("daemon.status", {})) as {
      protocolVersion: number;
      agents: { running: number };
      accounts: Array<{ name: string; provider: string; authType: string; cooling: boolean; coolingUntil: number | null; authExpired: boolean }>;
    };
    expect(st.protocolVersion).toBe(1);
    expect(st.accounts).toEqual([
      // Task AUTH-a: additive authExpired field alongside cooling/coolingUntil.
      { name: "main", provider: "claude", authType: "subscription", remoteControlCapable: true, cooling: false, coolingUntil: null, authExpired: false },
    ]);
  });

  // DAEMON-RUNS-FROM-DELETED-WORKTREE: daemon.status must surface enough provenance (code root +
  // its live on-disk existence + process start time) that an operator never has to shell out to
  // `ps`/`ls` to tell how stale a running daemon is.
  it("daemon.status reports codeRoot/codeRootExists/processStartedAtMs", async () => {
    const st = (await engine().handle("daemon.status", {})) as {
      codeRoot: string; codeRootExists: boolean; processStartedAtMs: number;
    };
    expect(typeof st.codeRoot).toBe("string");
    expect(st.codeRoot.length).toBeGreaterThan(0);
    // Default (no opts.codeRoot passed, mirrors every other Engine test in this suite): falls
    // back to engine.ts's own on-disk location, which is real, so this must read true.
    expect(st.codeRootExists).toBe(true);
    expect(typeof st.processStartedAtMs).toBe("number");
    expect(st.processStartedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it("daemon.status reports codeRootExists:false when the passed-in code root no longer exists on disk", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
      codeRoot: "/tmp/chimera-does-not-exist-" + Date.now(),
    });
    const st = (await e.handle("daemon.status", {})) as { codeRootExists: boolean };
    expect(st.codeRootExists).toBe(false);
  });

  it("agent.close resolves for known agents and rejects unknown ids", async () => {
    const e = engine();
    await expect(e.handle("agent.close", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } })) as { agentId: string };
    expect(await e.handle("agent.close", { agentId: rec.agentId })).toEqual({ ok: true });
  });

  // ---------- additional coverage: malformed params + mixed cooling accounts ----------

  it("agent.close rejects malformed params (missing agentId) with {code:'protocol'} instead of throwing raw", async () => {
    const e = engine();
    await expect(e.handle("agent.close", {})).rejects.toMatchObject({ code: "protocol" });
  });

  it("daemon.status reflects an account actually cooling after a real rate-limit failover (not just the zero-cooldown default)", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-home-cool-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "second", provider: "claude", auth: { type: "subscription" } },
      ],
      autoOrder: ["main", "second"],
    }));
    const RATE_FAIL: FakeStep[] = [{ emit: { kind: "error", data: { message: "HTTP 429 Too Many Requests" } } }];
    const HAPPY: FakeStep[] = [{ end: { resultText: "recovered" } }];
    const e = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([RATE_FAIL, HAPPY])]]) });
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const st = (await e.handle("daemon.status", {})) as {
      accounts: Array<{ name: string; cooling: boolean; coolingUntil: number | null }>;
    };
    const main = st.accounts.find((a) => a.name === "main")!;
    const second = st.accounts.find((a) => a.name === "second")!;
    expect(main.cooling).toBe(true);
    expect(typeof main.coolingUntil).toBe("number");
    expect(second.cooling).toBe(false);
    expect(second.coolingUntil).toBeNull();
  });

  it("daemon.status orders accounts by autoOrder (failover priority), not config/registry insertion order", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-home-order-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [
        { name: "a", provider: "claude", auth: { type: "subscription" } },
        { name: "b", provider: "claude", auth: { type: "subscription" } },
        { name: "c", provider: "claude", auth: { type: "subscription" } },
      ],
      // Deliberately reordered vs. config.accounts, and "b" omitted -- it must be
      // appended last, after the autoOrder entries, not dropped.
      autoOrder: ["c", "a"],
    }));
    const e = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    const st = (await e.handle("daemon.status", {})) as { accounts: Array<{ name: string }> };
    expect(st.accounts.map((a) => a.name)).toEqual(["c", "a", "b"]);
  });
});
