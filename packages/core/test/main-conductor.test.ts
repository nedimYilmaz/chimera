import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import { HealthMonitor } from "@chimera/core/health";
import { reattachConductors } from "@chimera/core/reattach";
import { makeEngineHome } from "./helpers.js";

// FEATURE MAIN-CONDUCTOR-PERSISTENT: the daemon-owned MAIN conductor — the ONE persistent,
// no-project orchestrator seat that (unlike the per-project conductor) is never lazily
// declared by a client; it exists once onboarding is done (an account configured) and is
// re-ensured (with SDK session resume) by every trigger point that reaches for it —
// mirrors ensureProjectConductor's TOCTOU/replacement/reattach discipline exactly, just for
// a single global seat with no projectId.

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

// No config.json at all ⇒ ChimeraConfigSchema's default accounts:[] (ONBOARDING-PROVIDER:
// a fresh install boots with zero accounts) — simulates the pre-onboarding boot state.
function noAccountsHome(): string {
  return mkdtempSync(join(tmpdir(), "chimera-main-conductor-noacct-"));
}

const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "x" } }];

type MainStatus = { agentId: string; state: string } | null;

describe("ensureMainConductor — spawn shape + boot semantics", () => {
  it("spawns exactly one persistent conductor at the project-import base dir, with no projectId; a second call reuses it", async () => {
    const home = makeEngineHome();
    const e = engineOn(home, [RUNNING]);
    const rec = await e.ensureMainConductor();
    expect(rec.state).toBe("running");
    expect(rec.spec.cwd).toBe(join(home, "projects"));   // resolveProjectBaseDir default (no config.projectImportDir set)
    expect((rec.spec as { conductor?: boolean }).conductor).toBe(true);
    expect((rec.spec as { persistent?: boolean }).persistent).toBe(true);
    expect((rec.spec as { isolation?: string }).isolation).toBe("none");
    expect(rec.projectId).toBeNull();
    expect(existsSync(join(home, "projects"))).toBe(true);

    const status = (await e.handle("main.conductor.status", {})) as MainStatus;
    expect(status).toEqual({ agentId: rec.agentId, state: "running" });

    const rec2 = await e.ensureMainConductor();
    expect(rec2.agentId).toBe(rec.agentId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("main.conductor.status is null before anything has ever ensured the seat", async () => {
    const e = engineOn(makeEngineHome());
    expect(await e.handle("main.conductor.status", {})).toBeNull();
  });

  // CONDUCTOR-FULL-ACCESS Part A: the main conductor is born "full" by default so that under
  // on.permissionRequest "auto" it can actually run Bash / foreign MCP tools in the real repo.
  it("is born with permissionProfile 'full' by default", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const rec = await e.ensureMainConductor();
    expect(rec.spec.permissionProfile).toBe("full");
  });

  it("honors config.conductorPermissionProfile override at spawn time", async () => {
    const home = makeEngineHome();
    const e = engineOn(home, [RUNNING]);
    const res = (await e.handle("config.patch", { patch: { conductorPermissionProfile: "acceptEdits" } })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const rec = await e.ensureMainConductor();
    expect(rec.spec.permissionProfile).toBe("acceptEdits");
  });

  // Deliberate non-migration (reattach.ts): a persisted conductor keeps its STORED profile on a
  // daemon-restart reattach even after the configured default changes — reattach's contract is
  // "continue exactly as before"; an existing conductor is re-scoped live via agent.setPermission.
  it("a reattached conductor keeps its stored profile, NOT the new configured default", async () => {
    const home = makeEngineHome();
    const e1 = engineOn(home, [RUNNING]);
    await e1.handle("config.patch", { patch: { conductorPermissionProfile: "acceptEdits" } });
    const rec1 = await e1.ensureMainConductor();
    expect(rec1.spec.permissionProfile).toBe("acceptEdits");

    // Restart with a DIFFERENT configured default; the reattached record must ignore it.
    const priorAgents = e1.supervisor.list();
    const e2 = engineOn(home, [[{ awaitSend: true }]]);
    await e2.handle("config.patch", { patch: { conductorPermissionProfile: "full" } });
    reattachConductors(e2, priorAgents);
    await new Promise((r) => setTimeout(r, 20));
    expect(e2.supervisor.status(rec1.agentId).spec.permissionProfile).toBe("acceptEdits");
  });

  it("with zero accounts configured, ensureMainConductor refuses (routeAccount's guard) — this is exactly what a boot/account-count check must gate on before ever calling it", async () => {
    const e = engineOn(noAccountsHome());
    await expect(e.ensureMainConductor()).rejects.toMatchObject({ code: "protocol" });
    expect(e.supervisor.list()).toHaveLength(0);
  });

  it("two concurrent ensureMainConductor calls race-free: only ONE conductor spawns (TOCTOU guard, mirrors ensureProjectConductor)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const [r1, r2] = await Promise.all([e.ensureMainConductor(), e.ensureMainConductor()]);
    expect(r1.agentId).toBe(r2.agentId);
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("emits the standard spawn registration event (status/registered:true) — the SAME visibility signal ensureProjectConductor's resumeOnly spawn relies on", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const seen: NormalizedEvent[] = [];
    e.events.subscribe((ev) => seen.push(ev));
    const rec = await e.ensureMainConductor();
    const reg = seen.find((ev) => ev.agentId === rec.agentId && ev.kind === "status" && ev.data["registered"] === true);
    expect(reg).toBeTruthy();
  });
});

describe("ensureMainConductor — never lost (replacement resumes prior session, reattach is a no-op)", () => {
  it("a restart resurrects the main conductor under its ORIGINAL agentId; ensureMainConductor after reattach is a no-op (no duplicate spawn)", async () => {
    const home = makeEngineHome();
    const e1 = engineOn(home, [RUNNING]);
    const rec1 = await e1.ensureMainConductor();

    // Simulate a daemon restart: a fresh Engine on the SAME home (main-conductor.json —
    // the persisted pointer — reloads from disk) fed the prior supervisor snapshot via
    // reattachConductors, the same boot-glue reattachFromState uses.
    const priorAgents = e1.supervisor.list();
    const e2 = engineOn(home, [[{ awaitSend: true }]]);
    reattachConductors(e2, priorAgents);
    await new Promise((r) => setTimeout(r, 20));   // let the fire-and-forget re-spawn settle

    // LAZY-REATTACH: the seat comes back PAUSED with its session held, not re-spawned — and
    // that is still "live" for ownership purposes, which is the property this test guards:
    // ensureMainConductor must resolve to the SAME record instead of spawning a second one.
    expect(e2.supervisor.status(rec1.agentId).state).toBe("paused");
    expect(e2.supervisor.status(rec1.agentId).pauseReason).toBe("daemon-restart");
    const rec2 = await e2.ensureMainConductor();
    expect(rec2.agentId).toBe(rec1.agentId);
    // still exactly one conductor — ensureMainConductor's live-check did NOT spawn a second one
    expect(e2.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);

    // ...and the held seat is genuinely usable: the operator's first message revives it.
    await e2.supervisor.send(rec1.agentId, "hello again");
    await new Promise((r) => setTimeout(r, 20));
    expect(e2.supervisor.status(rec1.agentId).state).toBe("running");
  });

  it("a main conductor that crash-loops into the circuit breaker (state 'failed') is REPLACED on the next ensure call, resuming its prior SDK session", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([
        [{ emit: { kind: "agent_started", data: { sessionId: "s-456" } } }, { fail: { message: "process exited" } }],
        RUNNING,
      ])]]),
      crashLoopPolicy: { maxRestarts: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const first = await e.ensureMainConductor();
    await new Promise((r) => setTimeout(r, 10));   // let the crash settle into "failed"
    expect(e.supervisor.status(first.agentId).state).toBe("failed");
    expect(e.supervisor.status(first.agentId).circuitOpen).toBe(true);

    const second = await e.ensureMainConductor();
    expect(second.agentId).not.toBe(first.agentId);
    expect(second.spec.resume).toBe("s-456");
    expect(e.supervisor.status(second.agentId).state).toBe("running");
  });
});

describe("accounts 0→1 triggers ensureMainConductor (FIRST-PROVIDER TRIGGER)", () => {
  it("accounts.add_subscription on a fresh (zero-account) engine best-effort spawns the main conductor", async () => {
    const home = noAccountsHome();
    const e = engineOn(home, [RUNNING]);
    expect((await e.handle("config.get", {})) as { accounts: unknown[] }).toMatchObject({ accounts: [] });

    await e.handle("accounts.add_subscription", { provider: "claude" });
    await new Promise((r) => setTimeout(r, 20));   // let the fire-and-forget ensure settle

    const status = (await e.handle("main.conductor.status", {})) as MainStatus;
    expect(status?.state).toBe("running");
    expect(e.supervisor.list().filter((a) => (a.spec as { conductor?: boolean }).conductor === true)).toHaveLength(1);
  });

  it("a SECOND accounts.add on an engine that already has one account does NOT re-trigger (no conductor spawned by the 2nd add alone)", async () => {
    // makeEngineHome already seeds one "main" account — accounts.add here is a 1→2
    // transition, not 0→1, so it must NOT be the thing that spawns a conductor.
    const e = engineOn(makeEngineHome(), [RUNNING]);
    await e.handle("accounts.add", { name: "extra", provider: "claude" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await e.handle("main.conductor.status", {})).toBeNull();
    expect(e.supervisor.list()).toHaveLength(0);
  });

  // ONBOARDING-GATE fix: the 0→1 trigger fires from the SAME synchronous call
  // (applyConfig) that also kicks off HOT-RELOAD-BACKENDS' own fire-and-forget
  // buildBackends() for the new account's provider. Every OTHER test in this
  // file preloads its backend synchronously via `backends:` at Engine
  // construction, so `reconcileBackends`'s `missing` list is always empty and
  // this race never gets exercised. A real daemon build the backend on demand
  // (a genuinely async dynamic import()) — engineOn(home, [RUNNING]) alone
  // can't reproduce that gap, so this test wires an artificially-delayed
  // backendBuilder to prove the trigger now WAITS for it instead of spawning
  // (and permanently failing with "no backend registered") too early.
  it("the 0→1 trigger awaits HOT-RELOAD-BACKENDS' own async backend registration before spawning (no premature 'no backend registered' failure)", async () => {
    const home = noAccountsHome();
    let resolveBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => { resolveBuild = resolve; });
    const e = new Engine({
      home,
      backends: new Map(), // starts with NO backends — forces the HOT-RELOAD-BACKENDS async path
      backendBuilder: async () => {
        await buildGate; // simulates the real dynamic import()'s latency
        return new Map<string, AgentBackend>([["claude", new FakeAgentBackend([RUNNING])]]);
      },
    });
    await e.handle("accounts.add_subscription", { provider: "claude" });
    // the backend build is still pending — the trigger must be WAITING, not
    // having already failed-and-given-up (the pre-fix behavior).
    await new Promise((r) => setTimeout(r, 20));
    expect(await e.handle("main.conductor.status", {})).toBeNull();
    resolveBuild();
    await new Promise((r) => setTimeout(r, 20)); // let the now-unblocked reconcile + spawn settle
    const status = (await e.handle("main.conductor.status", {})) as MainStatus;
    expect(status?.state).toBe("running");
  });
});

describe("HealthMonitor leaves an idle main conductor alone", () => {
  it("a resumeOnly main conductor (registration marker only, no turn ever opened) is NOT reported unresponsive past staleMs", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const rec = await e.ensureMainConductor();

    let t = 0;
    const reported: string[] = [];
    const mon = new HealthMonitor({
      supervisor: {
        list: () => e.supervisor.list(),
        reportUnresponsive: (agentId) => reported.push(agentId),
      },
      events: { subscribe: (fn) => e.events.subscribe(fn) },
      now: () => t,
      staleMs: 1000,
    });
    mon.start();
    t += 5000;   // far past staleMs
    mon.tick();
    expect(reported).not.toContain(rec.agentId);
  });
});
