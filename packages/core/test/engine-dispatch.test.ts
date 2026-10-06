import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSpec, TaskRecord } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";

// CORE-SUITE-BASELINE: pure in-process scheduler coordination (fake backends only) can
// still exceed vitest's 5000ms default under this machine's concurrent-agent load
// (event-loop scheduling itself gets delayed); widened per existing precedent
// (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 15_000 });

// PLAN-PROJECT-CONDUCTOR-ROUTING D2/§3 (P2-T2): `dispatch` resolves a routing
// mechanism for the caller — queue-first → own-team role-match → global team →
// direct — over the EXISTING queue.push/assign/agent.spawn primitives. These
// tests cover all four `via` branches plus the two decision forks the plan
// calls out explicitly: an unbound role-matching team falls through (does not
// route "team"), and a live project conductor is messaged directly rather than
// spawning a fresh worker.

type QueueStatus = { spec: { name: string }; tasks: TaskRecord[] };

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-dispdir-")); }

const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "x" } }];

describe("dispatch — queue-first", () => {
  it("routes to the project's own bound queue (via:queue)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "q1" } });
    await e.handle("project.create", { name: "alpha", path, queue: "q1", autoConductor: false });

    const result = (await e.handle("dispatch", { projectName: "alpha", prompt: "do x" })) as { via: string; target: string; taskId?: string };
    expect(result.via).toBe("queue");
    expect(result.target).toBe("q1");
    expect(result.taskId).toBeTruthy();

    const st = (await e.handle("queue.status", { queue: "q1" })) as QueueStatus;
    expect(st.tasks.map((t) => t.prompt)).toEqual(["do x"]);
    expect(st.tasks[0]!.taskId).toBe(result.taskId);
  });

  it("falls back to a teamHint's bound queue when the project has none", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "hintq" } });
    await e.handle("team.create", { spec: { name: "hinted", roles: { dev: { role: "blank", overrides: { cwd: path } } }, queue: "hintq" } });

    const result = (await e.handle("dispatch", { prompt: "y", teamHint: "hinted" })) as { via: string; target: string; taskId?: string };
    expect(result.via).toBe("queue");
    expect(result.target).toBe("hintq");
    const st = (await e.handle("queue.status", { queue: "hintq" })) as QueueStatus;
    expect(st.tasks.map((t) => t.prompt)).toEqual(["y"]);
  });
});

describe("dispatch — own-team role-match", () => {
  it("routes to a project-assigned, queue-bound team whose role matches (via:team)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "crewq" } });
    await e.handle("team.create", { spec: { name: "crew", roles: { worker: { role: "blank", overrides: { cwd: path } } }, queue: "crewq" } });
    // no project-level queue — the project must fall through to its own team
    await e.handle("project.create", { name: "alpha", path, teams: ["crew"], autoConductor: false });

    const result = (await e.handle("dispatch", { projectName: "alpha", prompt: "z", role: "worker" })) as { via: string; target: string; taskId?: string };
    expect(result.via).toBe("team");
    expect(result.target).toBe("crew");
    expect(result.taskId).toBeTruthy();
    const st = (await e.handle("queue.status", { queue: "crewq" })) as QueueStatus;
    expect(st.tasks.map((t) => t.prompt)).toEqual(["z"]);
  });

  it("skips a role-matching team with NO bound queue (falls through, does not route via:team)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("team.create", { spec: { name: "unbound", roles: { worker: { role: "blank", overrides: { cwd: path } } } } });   // no queue
    await e.handle("project.create", { name: "alpha", path, teams: ["unbound"], autoConductor: false });

    const result = (await e.handle("dispatch", { projectName: "alpha", prompt: "w", role: "worker" })) as { via: string; target: string };
    expect(result.via).not.toBe("team");
    expect(result.via).toBe("direct");   // no global configured either — last resort
  });
});

describe("dispatch — global team", () => {
  it("falls back to config.globalTeam when nothing project-scoped applies (via:global)", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("queue.create", { spec: { name: "gq" } });
    await e.handle("team.create", { spec: { name: "pool", roles: { worker: { role: "blank", overrides: { cwd: path } } }, queue: "gq" } });
    await e.handle("config.patch", { patch: { globalTeam: "pool" } });

    // fully project-less dispatch — item 3 of the user's intent: work not tied
    // to a project/conductor goes to the global pool.
    const result = (await e.handle("dispatch", { prompt: "v" })) as { via: string; target: string; taskId?: string };
    expect(result.via).toBe("global");
    expect(result.target).toBe("pool");
    const st = (await e.handle("queue.status", { queue: "gq" })) as QueueStatus;
    expect(st.tasks.map((t) => t.prompt)).toEqual(["v"]);
  });

  it("ignores a globalTeam name that does not (yet) exist and falls through to direct", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("config.patch", { patch: { globalTeam: "ghost-team" } });
    const result = (await e.handle("dispatch", { prompt: "u" })) as { via: string; target: string };
    expect(result.via).toBe("direct");
  });
});

describe("dispatch — direct", () => {
  it("with no project, no team, no global: spawns a fresh agent at the daemon home (via:direct)", async () => {
    const home = makeEngineHome();
    const e = engineOn(home);
    const result = (await e.handle("dispatch", { prompt: "hello" })) as { via: string; target: string };
    expect(result.via).toBe("direct");
    const rec = e.supervisor.status(result.target) as AgentRecord;
    expect(rec.spec.cwd).toBe(home);
    expect(rec.spec.prompt).toBe("hello");
  });

  it("with a project and NO live conductor: spawns a fresh agent at the project path", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path, autoConductor: false });
    const result = (await e.handle("dispatch", { projectName: "alpha", prompt: "hi" })) as { via: string; target: string };
    expect(result.via).toBe("direct");
    const rec = e.supervisor.status(result.target) as AgentRecord;
    expect(rec.spec.cwd).toBe(path);
  });

  it("with a project's conductor already running: messages it directly instead of spawning a new agent", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const path = makeDir();
    await e.handle("project.create", { name: "alpha", path });   // autoConductor:true (default)
    const st = (await e.handle("project.status", { name: "alpha" })) as { spec: ProjectSpec; conductor: { agentId: string } | null };
    const conductorId = st.conductor!.agentId;

    const before = e.supervisor.list().length;
    const result = (await e.handle("dispatch", { projectName: "alpha", prompt: "route to me" })) as { via: string; target: string };
    expect(result.via).toBe("direct");
    expect(result.target).toBe(conductorId);
    expect(e.supervisor.list()).toHaveLength(before);   // no new agent spawned — the existing conductor was messaged
  });
});

it("preserves the actual sender through queued dispatch and direct assignment", async () => {
  const fake = new FakeAgentBackend([RUNNING, RUNNING]);
  const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
  const sender = await e.supervisor.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main" });
  const receiver = await e.supervisor.spawn({ prompt: "wait", cwd: "/tmp", isolation: "none", account: "main" });
  await e.handle("queue.create", { spec: { name: "q1" } });
  await e.handle("project.create", { name: "alpha", path: makeDir(), queue: "q1", autoConductor: false });
  await e.handle("dispatch", { projectName: "alpha", prompt: "queued task", callerAgentId: sender.agentId });
  const state = await e.handle("queue.status", { queue: "q1" }) as QueueStatus;
  expect(state.tasks[0]!.pushedBy).toBe(sender.agentId);
  expect(state.tasks[0]!.author).toMatchObject({ from: sender.agentId, source: "agent" });
  expect(state.tasks[0]!.prompt).toBe("queued task");
  await e.handle("assign", { target: { agentId: receiver.agentId }, prompt: "direct task", callerAgentId: sender.agentId });
  await vi.waitFor(() => expect(fake.deliveries).toHaveLength(1));
  expect(fake.deliveries[0]).toMatchObject({ text: "direct task", delivery: { messages: [{ author: { from: sender.agentId, source: "agent" } }] } });
  await e.supervisor.kill(sender.agentId);
});

it("keeps operator authorship on queued tasks", async () => {
  const e = engineOn(makeEngineHome());
  await e.handle("queue.create", { spec: { name: "q1" } });
  await e.handle("project.create", { name: "alpha", path: makeDir(), queue: "q1", autoConductor: false });
  await e.handle("dispatch", { projectName: "alpha", prompt: "queued task" });
  const state = await e.handle("queue.status", { queue: "q1" }) as QueueStatus;
  expect(state.tasks[0]!.author).toMatchObject({ source: "operator" });
});
