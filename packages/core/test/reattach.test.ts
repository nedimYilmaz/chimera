import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { AgentSpecSchema, ChimeraConfigSchema, isAgentUnseen, type NormalizedEvent, type TaskStepCheckpoint } from "@chimera/protocol";
import type { AgentRecord } from "@chimera/core/supervisor";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker, type CrashLoopPolicy } from "@chimera/core/failover";
import { replayAgentsAsOf } from "@chimera/core/replay";
import { reattachConductors, reattachFromState, reconstructAgentsFromLog, resumeNoticeFor, type ReattachEngine } from "@chimera/core/reattach";
import { makeEngineHome, fakeExec } from "./helpers.js";

function engineWithFake(fake: FakeAgentBackend): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", fake]]),
  });
}

// builds a valid AgentRecord for a prior daemon run (state.json shape), with sane defaults
// callers can override.
function priorAgent(over: Partial<AgentRecord> & { conductor?: boolean } = {}): AgentRecord {
  const { conductor, ...rest } = over;
  const spec = AgentSpecSchema.parse({ prompt: "hello", cwd: "/tmp", isolation: "none", conductor: conductor ?? false });
  return {
    agentId: "agent-1", spec, accountName: "main", provider: "claude",
    state: "running", depth: 0, treeId: "agent-1", createdAt: Date.now(),
    principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null,
    ...rest,
  };
}

// LAZY-REATTACH: reattachConductors' DEFAULT is now "lazy" (a prior running agent comes back
// paused, with no process — see reattach-lazy.test.ts). The cases below predate that and
// describe the EAGER contract, which is still supported and still the thing a
// `reattach: "eager"` config gets, so they pin the mode explicitly rather than silently
// testing whichever default happens to be current.
describe("reattachConductors (Task CR2) — eager mode", () => {
  it("re-spawns a prior running conductor under its original agentId, resumed+resumeOnly", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "cond-1", treeId: "cond-1", conductor: true, sessionId: "s1" });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget spawn() settle

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.resume).toBe("s1");
    expect(fake.spawns[0]?.resumeOnly).toBe(true);

    const rec = e.supervisor.status("cond-1");
    expect(rec.agentId).toBe("cond-1");
    expect(rec.state).toBe("running");
  });

  it("PROJECT-CONDUCTOR-VISIBILITY: the reattach re-spawn appends exactly one registration event (no real agent_started, since the fake scenario never emits one)", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);   // no agent_started scripted — mirrors resumeOnly's idle-forever contract
    const e = engineWithFake(fake);
    // NOTE: reattachConductors's own spawn() call passes no explicit opts.projectId (see
    // reattach.ts) — it derives via engine.projectFor(cwd), unconfigured in this bare test
    // Engine, so the registration event's data has no projectId here (byte-identical to a
    // plain non-project reattach; the real project-conductor path's cwd IS the project path,
    // which projectFor resolves in production).
    const prior = priorAgent({ agentId: "cond-1", treeId: "cond-1", conductor: true, sessionId: "s1" });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    const tail = e.events.tail("cond-1", 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.kind).toBe("status");
    expect(tail[0]?.data).toEqual({
      state: "running", registered: true, conductor: true, treeId: "cond-1", depth: 0,
      // AGENT-IDENTITY-INVISIBLE-IN-APP: a reattached conductor is the exact case that needs these —
      // it is idle-forever by contract, so this marker is the only event that will ever tell an
      // event-sourced client which account/permission scope it came back up under.
      accountName: "main", provider: "claude", permissionProfile: "acceptEdits", permissionRequest: "auto",
      // JOB-FLEET-GROUPING: rides the same registration marker, always present (AgentRecord.createdAt
      // is never optional) — see supervisor.ts's stamp.
      createdAt: expect.any(Number),
    });
  });

  it("respawns a conductor with no prior sessionId using resume:null (fresh, still resumeOnly/idle)", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "cond-2", treeId: "cond-2", conductor: true }); // no sessionId

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.resume).toBeNull();
    expect(fake.spawns[0]?.resumeOnly).toBe(true);
    expect(e.supervisor.status("cond-2").state).toBe("running");
  });

  it("RESTART-RESUME: re-spawns a prior running NON-conductor with a sessionId, resumed under its original id", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "plain-1", treeId: "plain-1", conductor: false, sessionId: "sess-42" });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);
    const rec = e.supervisor.status("plain-1");
    expect(rec.agentId).toBe("plain-1");
    expect((rec.spec as { resume?: string | null }).resume).toBe("sess-42");
    expect((rec.spec as { resumeOnly?: boolean }).resumeOnly).toBe(true);
  });

  it("preserves persisted conductor ownership when a resumable agent is reattached", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWithFake(fake);
    const prior = priorAgent({
      agentId: "owned-1", treeId: "owned-1", conductor: false,
      sessionId: "sess-owned", originConductorId: "conductor-1",
    });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(e.supervisor.status("owned-1").originConductorId).toBe("conductor-1");
  });

  it("a running non-conductor with NO sessionId is not resumable — interrupted status event instead", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "worker-1", treeId: "worker-1", conductor: false });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(0);
    expect(() => e.supervisor.status("worker-1")).toThrow(); // never registered with the supervisor
    const tail = e.events.tail("worker-1", 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.kind).toBe("status");
    expect(tail[0]?.data).toEqual({ state: "interrupted" });
  });

  it("a running SCHEDULER-owned worker (membership set) is never resumed even with a sessionId — its task re-dispatches", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "tw-1", treeId: "tw-1", conductor: false, sessionId: "sess-7", membership: { team: "t", role: "r" } as never });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(0);
    expect(e.events.tail("tw-1", 10)[0]?.data).toEqual({ state: "interrupted" });
  });

  it("a shadow row is skipped entirely — no re-spawn, no interrupted event", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "shadow:p:1", treeId: "p", conductor: false, sessionId: "s", shadow: true });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(0);
    expect(e.events.tail("shadow:p:1", 10)).toHaveLength(0);
  });

  it("REATTACH-TERMINAL-RECORDS: rehydrates terminal prior agents (done/failed/killed) for display — no re-spawn, no interrupted event, no process", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const priors = [
      priorAgent({ agentId: "done-1", treeId: "done-1", conductor: true, state: "done" }),
      priorAgent({ agentId: "failed-1", treeId: "failed-1", conductor: false, state: "failed" }),
      priorAgent({ agentId: "killed-1", treeId: "killed-1", conductor: true, state: "killed" }),
    ];

    reattachConductors(e, priors, "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(0); // never re-spawned/resumed — terminal, display-only
    for (const id of ["done-1", "failed-1", "killed-1"]) {
      const rec = e.supervisor.status(id);
      expect(rec.state).toBe(id.startsWith("done") ? "done" : id.startsWith("failed") ? "failed" : "killed");
      expect(e.events.tail(id, 10)).toHaveLength(0); // no interrupted event for terminal rows
    }
    expect(e.supervisor.list().map((a) => a.agentId)).toEqual(expect.arrayContaining(["done-1", "failed-1", "killed-1"]));
  });

  it("REATTACH-TERMINAL-RECORDS: a shadow row stays skipped even though shadow ≠ a real state", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const prior = priorAgent({ agentId: "shadow:done:1", treeId: "p", conductor: false, state: "done", shadow: true });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(() => e.supervisor.status("shadow:done:1")).toThrow();
  });

  it("MEMORY-BOUNDED-DISK-COMPLETE: reattach re-registers EVERY prior terminal record, no cap (state.json is disk-complete; the hot-set cap only bounds what stays FULL in memory, via snapshotAgents' own archive-then-lighten sweep, not what's visible)", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const now = Date.now();
    const priors = Array.from({ length: 201 }, (_, i) =>
      priorAgent({ agentId: `done-${i}`, treeId: `done-${i}`, conductor: false, state: "done", createdAt: now + i }),
    );

    reattachConductors(e, priors, "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(e.supervisor.status("done-0").state).toBe("done"); // oldest — still visible, no cap at reattach time
    expect(e.supervisor.status("done-200").state).toBe("done"); // newest
    const rehydrated = e.supervisor.list().filter((a) => a.agentId.startsWith("done-"));
    expect(rehydrated).toHaveLength(201);
  });

  it("is failure-tolerant: a conductor whose re-spawn rejects does not throw, and other conductors still re-attach", async () => {
    let calls = 0;
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async (input: unknown, opts?: { agentId?: string }) => {
          calls++;
          if (opts?.agentId === "cond-bad") throw new Error("boom: account gone");
          return { agentId: opts?.agentId } as AgentRecord;
        }) as unknown as ReattachEngine["supervisor"]["spawn"],
      },
      events: { append: () => { throw new Error("should not be called for conductors"); } },
    };
    const priors = [
      priorAgent({ agentId: "cond-bad", treeId: "cond-bad", conductor: true, sessionId: "sX" }),
      priorAgent({ agentId: "cond-good", treeId: "cond-good", conductor: true, sessionId: "sY" }),
    ];

    expect(() => reattachConductors(stubEngine, priors, "eager")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // let both fire-and-forget promises settle
    expect(calls).toBe(2); // the rejection of cond-bad did not stop cond-good from being attempted
  });

  it("R2: a failed re-spawn routes into recoverFromFailedReattach instead of just console.error (recoverFromFailedReattach ABSENT — a lightweight stub — is still tolerated, mirrors reattachPaused?/reattachTerminal? optionality)", async () => {
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("boom: account gone"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        // recoverFromFailedReattach deliberately OMITTED — must not throw when called via `?.`
      },
      events: { append: () => { throw new Error("should not be called for conductors"); } },
    };
    const prior = priorAgent({ agentId: "cond-bad", treeId: "cond-bad", conductor: true, sessionId: "sX" });

    expect(() => reattachConductors(stubEngine, [prior], "eager")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("R2: a failed re-spawn calls recoverFromFailedReattach with the prior record and the rejection message", async () => {
    const seen: Array<{ prior: AgentRecord; message: string }> = [];
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("boom: account gone"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        recoverFromFailedReattach: (prior: AgentRecord, message: string) => { seen.push({ prior, message }); },
      },
      events: { append: () => { throw new Error("should not be called for conductors"); } },
    };
    const prior = priorAgent({ agentId: "cond-bad", treeId: "cond-bad", conductor: true, sessionId: "sX" });

    reattachConductors(stubEngine, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prior.agentId).toBe("cond-bad");
    expect(seen[0]?.message).toContain("boom: account gone");
  });

  it("R2: a real AgentSupervisor's recoverFromFailedReattach re-registers the vanished record as paused/crashCount:1, instead of leaving it invisible", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    // spec.account "ghost" is not a configured account — AccountRegistry.get() throws inside
    // spawn()'s routeAccount, synchronously, BEFORE any record is created (the exact "silent
    // death" scenario: previously nothing was ever visible for this agentId again).
    const prior = priorAgent({ agentId: "cond-ghost", treeId: "cond-ghost", conductor: true, sessionId: "sX" });
    prior.spec = { ...prior.spec, account: "ghost" };

    expect(() => e.supervisor.status("cond-ghost")).toThrow();   // sanity: not registered yet

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    const rec = e.supervisor.status("cond-ghost");   // no longer throws — recovered, not vanished
    expect(rec.state).toBe("paused");
    expect(rec.crashCount).toBe(1);
    expect(rec.pauseReason).toBe("reattach-recovery");
    expect(rec.resumeAt).toBeGreaterThan(Date.now());

    const paused = e.events.tail("cond-ghost", 10).find((ev) => ev.data["paused"] === true);
    expect(paused?.data).toMatchObject({ state: "paused", reason: "reattach-recovery", crashCount: 1 });
  });

  it("routes a prior PAUSED agent to supervisor.reattachPaused (session-limit restart-survival)", () => {
    const seen: AgentRecord[] = [];
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("spawn must not be called for a paused agent"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        reattachPaused: (rec: AgentRecord) => { seen.push(rec); },
      },
      events: { append: () => { throw new Error("no interrupted event for a paused agent"); } },
    };
    const held = priorAgent({ agentId: "held-1", treeId: "held-1", state: "paused", resumeAt: Date.now() + 1000 });

    expect(() => reattachConductors(stubEngine, [held], "eager")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agentId).toBe("held-1");
  });

  it("does NOT resume a paused SCHEDULER-owned worker (membership set) — its task re-dispatches instead", () => {
    const seen: AgentRecord[] = [];
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("spawn must not be called"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        reattachPaused: (rec: AgentRecord) => { seen.push(rec); },
      },
      events: { append: () => { throw new Error("no event expected for a dropped team worker"); } },
    };
    const teamWorker = { ...priorAgent({ agentId: "tw-1", treeId: "tw-1", state: "paused", resumeAt: Date.now() + 1000 }), membership: { team: "crew", role: "dev" } };

    expect(() => reattachConductors(stubEngine, [teamWorker], "eager")).not.toThrow();
    expect(seen).toHaveLength(0);   // membership-bearing paused worker is skipped, not resumed
  });

  it("no-ops on an empty prior-agents list", () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    expect(() => reattachConductors(e, [], "eager")).not.toThrow();
    expect(fake.spawns).toHaveLength(0);
  });

  it("routes a prior DONE agent to supervisor.reattachTerminal, never to spawn", () => {
    const seen: AgentRecord[] = [];
    const stubEngine: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("spawn must not be called for a terminal agent"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        reattachTerminal: (rec: AgentRecord) => { seen.push(rec); },
      },
      events: { append: () => { throw new Error("no event expected for a terminal agent"); } },
    };
    const done = priorAgent({ agentId: "done-1", treeId: "done-1", state: "done" });

    expect(() => reattachConductors(stubEngine, [done], "eager")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agentId).toBe("done-1");
  });
});

describe("suspendForShutdown (RESTART-RESUME: graceful shutdown keeps a resumable set)", () => {
  it("terminates the process but keeps the record 'running' — no killed transition, no terminal event", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(e.supervisor.status(rec.agentId).state).toBe("running");

    await e.supervisor.suspendForShutdown();

    const after = e.supervisor.status(rec.agentId);
    expect(after.state).toBe("running"); // the snapshot after this persists a RESUMABLE record
    const killedEvents = e.events.tail(rec.agentId, 20).filter(
      (ev) => ev.kind === "status" && (ev.data as { state?: string }).state === "killed",
    );
    expect(killedEvents).toHaveLength(0);
  });

  it("kill() stays the user-initiated terminal path: state flips to killed and IS excluded from reattach", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await e.supervisor.kill(rec.agentId);
    expect(e.supervisor.status(rec.agentId).state).toBe("killed");
  });
});

describe("reattachFromState (Task REATTACHTEST: daemon boot glue)", () => {
  it("happy path: reads state.json, re-attaches a prior running conductor and interrupts a non-conductor", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWithFake(fake);
    const conductor = priorAgent({ agentId: "cond-1", treeId: "cond-1", conductor: true, sessionId: "s1", depth: 0 });
    const worker = priorAgent({ agentId: "worker-1", treeId: "worker-1", conductor: false });
    const state = { agents: [conductor, worker] };

    let readCalls = 0;
    const fakeRead = (() => { readCalls++; return JSON.stringify(state); }) as unknown as typeof import("node:fs").readFileSync;
    const fakeExists = () => true;

    reattachFromState(e, "/fake/state.json", fakeRead, fakeExists, "eager");
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget spawn() settle

    expect(readCalls).toBe(1);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.resume).toBe("s1");
    expect(fake.spawns[0]?.resumeOnly).toBe(true);

    const rec = e.supervisor.status("cond-1");
    expect(rec.agentId).toBe("cond-1");
    expect(rec.state).toBe("running");

    expect(() => e.supervisor.status("worker-1")).toThrow(); // non-conductor never re-spawned
    const tail = e.events.tail("worker-1", 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.data).toEqual({ state: "interrupted" });
  });

  it("missing state.json is a no-op: does not throw and never calls readFile", () => {
    expect.assertions(2);
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    let readCalls = 0;
    const fakeRead = (() => { readCalls++; return "{}"; }) as unknown as typeof import("node:fs").readFileSync;

    expect(() => reattachFromState(e, "/fake/missing.json", fakeRead, () => false)).not.toThrow();
    expect(readCalls).toBe(0); // exists() was false — must short-circuit before ever reading
  });

  it("torn/partial JSON is tolerated: no-op, no throw", () => {
    expect.assertions(2);
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const fakeRead = (() => "{bad") as unknown as typeof import("node:fs").readFileSync;

    expect(() => reattachFromState(e, "/fake/torn.json", fakeRead, () => true)).not.toThrow();
    expect(fake.spawns).toHaveLength(0);
  });

  it("well-formed JSON with no 'agents' key defaults to an empty list — no-op, no throw", () => {
    expect.assertions(2);
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const fakeRead = (() => "{}") as unknown as typeof import("node:fs").readFileSync;

    expect(() => reattachFromState(e, "/fake/empty.json", fakeRead, () => true)).not.toThrow();
    expect(fake.spawns).toHaveLength(0);
  });

  // R2-DURABLE-LOG: reattachFromState surfaces a boot-time event-log recovery report (if the
  // event log's own constructor-time integrity scan found something) alongside its existing
  // torn-state.json warning — both are console.error'd at this same boot-recovery moment.
  it("console.errors a summary when the event log reports quarantined segments/seq gaps", () => {
    const stub: ReattachEngine = {
      supervisor: { spawn: (async () => { throw new Error("no agents in this state"); }) as unknown as ReattachEngine["supervisor"]["spawn"] },
      events: {
        append: (() => { throw new Error("must not be called"); }) as unknown as ReattachEngine["events"]["append"],
        recoveryReport: () => ({ quarantined: [{ file: "events.1-5.jsonl", reason: "checksum mismatch" }], seqGaps: [] }),
      },
    };
    const fakeRead = (() => JSON.stringify({ agents: [] })) as unknown as typeof import("node:fs").readFileSync;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reattachFromState(stub, "/fake/state.json", fakeRead, () => true);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 segment(s) quarantined"));
    spy.mockRestore();
  });

  it("stays silent about recovery when the report is empty (or recoveryReport is absent — a lightweight test-stub events object)", () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);   // a real Engine's EventLog has an empty report on a fresh home
    const fakeRead = (() => JSON.stringify({ agents: [] })) as unknown as typeof import("node:fs").readFileSync;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reattachFromState(e, "/fake/state.json", fakeRead, () => true);

    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("event log recovery"));
    spy.mockRestore();
  });
});

describe("snapshotAgents (MEMORY-BOUNDED-DISK-COMPLETE: archive-then-lighten, not truncate)", () => {
  it("never caps running/paused rows; terminal rows beyond MAX_TERMINAL_AGENTS_PERSISTED stay in the snapshot but are LIGHTENED (archived, prompt stripped) instead of evicted", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    const running = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });

    // rehydrate 201 terminal records directly via the supervisor (bypassing reattach.ts, so
    // this test isolates snapshotAgents' independent hot-set bound).
    for (let i = 0; i < 201; i++) {
      e.supervisor.reattachTerminal(
        priorAgent({ agentId: `done-${i}`, treeId: `done-${i}`, state: "done", createdAt: Date.now() + i }),
      );
    }

    const snap = e.supervisor.snapshotAgents();
    expect(snap.some((a) => a.agentId === running.agentId)).toBe(true); // running never capped
    const terminalRows = snap.filter((a) => a.agentId.startsWith("done-"));
    expect(terminalRows).toHaveLength(201); // disk-complete: nothing evicted from the snapshot

    const oldest = terminalRows.find((a) => a.agentId === "done-0")!;
    expect(oldest.archived).toBe(true); // beyond the hot cap — lightened
    expect(oldest.spec.prompt).toBe(""); // heavy field stripped from the in-memory/on-disk shell
    expect(oldest.state).toBe("done"); // identity/status fields survive lightening intact

    const newest = terminalRows.find((a) => a.agentId === "done-200")!;
    expect(newest.archived).toBeUndefined(); // within the hot cap — stays full
    expect(newest.spec.prompt).toBe("hello"); // priorAgent()'s default prompt, untouched

    // and the full record is still readable straight off the archive AgentArchiveStore wrote to.
    expect(e.agentArchive.read("done-0")?.spec.prompt).toBe("hello");
  });
});

function ev(over: Partial<NormalizedEvent> & Pick<NormalizedEvent, "agentId" | "kind">): NormalizedEvent {
  return { ts: 1000, seq: 1, engineId: "local", data: {}, ...over };
}

describe("reconstructAgentsFromLog (FEATURE-4: boot-time replay reducer)", () => {
  it("a 'result' event flips a snapshotted 'running' record to 'done', with resultText/costUsd", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running" })];
    reconstructAgentsFromLog(agents, [
      ev({ agentId: "a1", kind: "result", seq: 2, ts: 5000, data: { text: "hi", costUsd: 0.5 } }),
    ]);
    expect(agents[0]?.state).toBe("done");
    expect(agents[0]?.resultText).toBe("hi");
    expect(agents[0]?.costUsd).toBe(0.5);
  });

  it("a 'status'{state:'failed'} event marks the record failed (the new supervisor.ts pairing for the plain-fail path)", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running" })];
    reconstructAgentsFromLog(agents, [ev({ agentId: "a1", kind: "status", data: { state: "failed" } })]);
    expect(agents[0]?.state).toBe("failed");
  });

  it("an 'agent_started' event updates sessionId and sets state to running", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running", sessionId: "stale-session" })];
    reconstructAgentsFromLog(agents, [ev({ agentId: "a1", kind: "agent_started", data: { sessionId: "fresh-session" } })]);
    expect(agents[0]?.sessionId).toBe("fresh-session");
    expect(agents[0]?.state).toBe("running");
  });

  it("a 'failover' event immediately followed by a bare 'error' passthrough (the actual onEvent order) leaves the record running, not failed", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running" })];
    reconstructAgentsFromLog(agents, [
      ev({ agentId: "a1", kind: "failover", seq: 2, data: { from: "main", to: "second" } }),
      ev({ agentId: "a1", kind: "error", seq: 3, data: { message: "429" } }),
    ]);
    expect(agents[0]?.state).toBe("running");
  });

  it("a 'status'{state:'paused'} event sets resumeAt from resumeScheduledAt", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running" })];
    reconstructAgentsFromLog(agents, [
      ev({ agentId: "a1", kind: "status", data: { state: "paused", resumeScheduledAt: 99999 } }),
    ]);
    expect(agents[0]?.state).toBe("paused");
    expect(agents[0]?.resumeAt).toBe(99999);
  });

  it("an event for an agentId absent from the snapshot is a no-op — no throw, no fabricated record", () => {
    const agents = [priorAgent({ agentId: "a1", state: "running" })];
    expect(() => reconstructAgentsFromLog(agents, [ev({ agentId: "never-snapshotted", kind: "result", data: {} })])).not.toThrow();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.state).toBe("running");   // untouched
  });
});

describe("reattachFromState with lastSeq (FEATURE-4: debounced snapshot + replay)", () => {
  it("replays events after lastSeq before deciding reattach: a stale 'running' snapshot whose agent actually finished is routed to reattachTerminal, not resumed", async () => {
    const fake = new FakeAgentBackend([]);
    const e = engineWithFake(fake);
    // seed the event log with what "happened after the stale snapshot": the agent finished.
    e.events.append({ agentId: "a1", kind: "result", data: { text: "done!", costUsd: 0.1 } });   // seq 1

    const seen: AgentRecord[] = [];
    const stub: ReattachEngine = {
      supervisor: {
        spawn: (async () => { throw new Error("must not resume — the replayed state is 'done', terminal"); }) as unknown as ReattachEngine["supervisor"]["spawn"],
        reattachTerminal: (rec: AgentRecord) => { seen.push(rec); },
      },
      events: e.events,
    };
    const stale = priorAgent({ agentId: "a1", treeId: "a1", state: "running", sessionId: "s1" });
    const state = { agents: [stale], lastSeq: 0 };   // lastSeq:0 — the result event (seq 1) is in the gap
    const fakeRead = (() => JSON.stringify(state)) as unknown as typeof import("node:fs").readFileSync;

    reattachFromState(stub, "/fake/state.json", fakeRead, () => true);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.state).toBe("done");
    expect(seen[0]?.resultText).toBe("done!");
  });

  it("a state.json with no lastSeq (pre-feature format) skips replay entirely and reattaches straight from the snapshot", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = engineWithFake(fake);
    e.events.append({ agentId: "cond-1", kind: "result", data: { text: "should be ignored — no lastSeq means no replay" } });
    const conductor = priorAgent({ agentId: "cond-1", treeId: "cond-1", conductor: true, sessionId: "s1" });

    reattachFromState(e, "/fake/state.json", (() => JSON.stringify({ agents: [conductor] })) as unknown as typeof import("node:fs").readFileSync, () => true, "eager");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);   // resumed AS RUNNING (from the stale snapshot), unaffected by the later "result" event
  });
});

describe("debounced-cadence + replay reconstructs identical state (FEATURE-4)", () => {
  it("folding events after an EARLY snapshot onto that snapshot matches the ALWAYS-FRESH live supervisor state", async () => {
    const fake = new FakeAgentBackend([
      [{ emit: { kind: "agent_started", data: { sessionId: "s-a" } } }, { end: { resultText: "a-done", costUsd: 0.2 } }],
    ]);
    const e = engineWithFake(fake);
    await e.supervisor.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-a" });

    // "snapshot EARLY" — captured right after spawn() registers the record, simulating a low
    // cadence that missed the agent_started/result events entirely. Whatever state happens to
    // be captured here (agent_started may or may not have landed yet — spawn()'s promise
    // resolves independently of it), replaying everything AFTER this point must still
    // reconstruct the exact same final state as the always-fresh live supervisor.
    const earlySnapshot = e.supervisor.snapshotAgents().map((r) => ({ ...r, attempts: r.attempts.map((a) => ({ ...a })) }));
    const earlySeq = e.events.currentSeq();

    await e.supervisor.waitFor("agent-a", 1000);

    const gap = e.events.replay({ fromSeq: earlySeq + 1, limit: Number.MAX_SAFE_INTEGER });
    reconstructAgentsFromLog(earlySnapshot, gap);

    const live = e.supervisor.status("agent-a");
    const reconstructed = earlySnapshot.find((r) => r.agentId === "agent-a");
    expect(reconstructed?.state).toBe(live.state);
    expect(reconstructed?.state).toBe("done");
    expect(reconstructed?.sessionId).toBe(live.sessionId);
    expect(reconstructed?.resultText).toBe(live.resultText);
    expect(reconstructed?.costUsd).toBe(live.costUsd);
  });

  // R2 (self-healing supervision): the same divergence property as the happy-path test above,
  // but exercised through the ACTUAL crash-loop-backoff-then-recover machinery for real (a tiny
  // injected crashLoopPolicy so the real setTimeout resolves fast) — proving replayAgentsAsOf
  // doesn't just fold consistently for a plain result, but also matches whatever the live
  // scheduleCrashRestart/resumePaused dance actually did on a genuine crash+recovery.
  it("a real crash-loop-backoff-then-recover run: an independent replayAgentsAsOf matches the live supervisor field-for-field", async () => {
    const SOLO = ChimeraConfigSchema.parse({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    });
    const dir = mkdtempSync(join(tmpdir(), "chimera-divergence-"));
    const scenarios: FakeStep[] = [{ fail: { message: "process exited with code 1" } }];
    const happy: FakeStep[] = [{ emit: { kind: "agent_started", data: { sessionId: "s-recovered" } } }, { end: { resultText: "recovered!", costUsd: 0.05 } }];
    const fake = new FakeAgentBackend([[...scenarios], happy]);
    const events = new EventLog(dir);
    const crashLoopPolicy: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 15, maxDelayMs: 200 };
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(SOLO),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake]]),
      events,
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
      crashLoopPolicy,
    });

    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-c" });

    // "snapshot EARLY" — right after the initial spawn, mirroring the happy-path test above:
    // before the crash, the backoff pause, or the eventual recovery have landed.
    const earlySnapshot = { agents: sup.snapshotAgents().map((r) => ({ ...r, attempts: r.attempts.map((a) => ({ ...a })) })), lastSeq: events.currentSeq() };

    const until = async (fn: () => boolean, ms = 8000) => {
      const start = Date.now();
      while (Date.now() - start < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
      throw new Error("condition not met before deadline");
    };
    await until(() => sup.status("agent-c").state === "done");

    const live = sup.status("agent-c");
    expect(live.resultText).toBe("recovered!");   // sanity: the crash+recovery actually happened
    expect(live.crashCount).toBe(0);              // reset by the successful post-recovery agent_started

    const reconstructed = replayAgentsAsOf(earlySnapshot, events).find((r) => r.agentId === "agent-c");
    expect(reconstructed?.state).toBe(live.state);
    expect(reconstructed?.state).toBe("done");
    expect(reconstructed?.sessionId).toBe(live.sessionId);
    expect(reconstructed?.sessionId).toBe("s-recovered");
    expect(reconstructed?.resultText).toBe(live.resultText);
    expect(reconstructed?.costUsd).toBe(live.costUsd);
    expect(reconstructed?.crashCount).toBe(live.crashCount);
  });
});

// FEATURE-2 (durable checkpoint-resume)
function checkpoint(over: Partial<TaskStepCheckpoint> = {}): TaskStepCheckpoint {
  return {
    stepIndex: 0, idempotencyKey: "t1:step-0", workdirKey: "task-t1",
    branch: "chimera/task-t1", commitSha: "abcdef1234567890", gateAttempts: 0, capturedAt: 1000,
    ...over,
  };
}

describe("resumeNoticeFor", () => {
  it("includes the idempotency key and a branch@shortSha marker for a full checkpoint", () => {
    const notice = resumeNoticeFor(checkpoint());
    expect(notice).toContain("t1:step-0");
    expect(notice).toContain("chimera/task-t1@abcdef12");
  });

  it("renders a fallback instead of a literal null/undefined when commitSha is missing", () => {
    const notice = resumeNoticeFor(checkpoint({ commitSha: null }));
    expect(notice).toContain("no prior commit recorded");
    expect(notice).not.toContain("null");
    expect(notice).not.toContain("undefined");
  });
});

describe("F47 seen-state persistence (A7)", () => {
  it("attentionAt/reviewedAt round-trip snapshot -> state.json -> reattachTerminal", () => {
    const e = engineWithFake(new FakeAgentBackend([]));
    e.supervisor.reattachTerminal(priorAgent({
      agentId: "seen-1", treeId: "seen-1", state: "done", attentionAt: 1700, reviewedAt: 1500,
    }));

    // the real chain: snapshotAgents -> JSON (what SnapshotScheduler writes) -> parse -> rehydrate.
    // Neither leg validates through zod, so the two new AgentRecord fields persist with no extra
    // code — this test is what keeps that free ride from silently breaking.
    const onDisk = JSON.parse(JSON.stringify({ agents: e.supervisor.snapshotAgents() })) as { agents: AgentRecord[] };
    const row = onDisk.agents.find((a) => a.agentId === "seen-1")!;
    expect(row.attentionAt).toBe(1700);
    expect(row.reviewedAt).toBe(1500);

    const e2 = engineWithFake(new FakeAgentBackend([]));
    e2.supervisor.reattachTerminal(row);
    const rehydrated = e2.supervisor.status("seen-1");
    expect(rehydrated.attentionAt).toBe(1700);
    expect(rehydrated.reviewedAt).toBe(1500);
  });

  it("a pre-F47 record rehydrates with both stamps absent — no backfill, no fleet-wide false alarm", () => {
    const e = engineWithFake(new FakeAgentBackend([]));
    e.supervisor.reattachTerminal(priorAgent({ agentId: "old-1", treeId: "old-1", state: "done" }));

    const row = JSON.parse(JSON.stringify(e.supervisor.snapshotAgents()))[0] as AgentRecord;
    expect(row.attentionAt).toBeUndefined();
    expect(row.reviewedAt).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("attentionAt");
  });
});

// F47.FIX L-1: eager reattach re-spawns through supervisor.spawn(), which builds a FRESH record —
// so without an explicit carry the seen stamps died at every daemon restart and the whole fleet
// came back reading SEEN, silently discarding exactly the attention the operator had not handled.
// The lazy paths never had this (reattachDormant/Paused/Terminal spread `...prior`).
describe("reattachConductors — seen stamps survive (F47.FIX L-1)", () => {
  it("eager: attentionAt and reviewedAt are carried onto the re-spawned record", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }]]));
    const prior = priorAgent({ agentId: "cond-1", treeId: "cond-1", conductor: true, sessionId: "s1",
      attentionAt: 5_000, reviewedAt: 4_000 });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    const rec = e.supervisor.status("cond-1");
    expect(rec.attentionAt).toBe(5_000);
    expect(rec.reviewedAt).toBe(4_000);
    expect(isAgentUnseen(rec)).toBe(true);                  // still demands attention, as before the restart
  });

  it("eager: an agent with NO stamps stays unstamped (no phantom 'seen' invented by the carry)", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }]]));
    const prior = priorAgent({ agentId: "cond-2", treeId: "cond-2", conductor: true, sessionId: "s2" });

    reattachConductors(e, [prior], "eager");
    await new Promise((r) => setTimeout(r, 20));

    const rec = e.supervisor.status("cond-2");
    expect(rec.attentionAt).toBeUndefined();
    expect(rec.reviewedAt).toBeUndefined();
  });
});
