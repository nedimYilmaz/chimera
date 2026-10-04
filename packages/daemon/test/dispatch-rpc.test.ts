import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { encodeFrame, decodeFrames, type RpcFrame } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// PLAN-PROJECT-CONDUCTOR-ROUTING P2-T2 acceptance ("Live: dispatch into 'chimera'
// (has q-chimera-bugs) pushes a task that drains"): the REAL socket RPC server
// (packages/daemon/src/server.ts) + real wire framing, not just Engine.handle()
// in-process. Mirrors the shared team-chimera project's shape (a team bound to a
// queue) in an ISOLATED temp home — never touches the live shared daemon/project.

function rpcClient(socketPath: string) {
  const sock = createConnection(socketPath);
  let buf = ""; const waiters: Array<(f: RpcFrame) => void> = []; const inbox: RpcFrame[] = [];
  sock.on("data", (d) => {
    buf += d.toString();
    const { frames, rest } = decodeFrames(buf); buf = rest;
    for (const f of frames) { const w = waiters.shift(); w ? w(f) : inbox.push(f); }
  });
  const next = () => new Promise<RpcFrame>((r) => { const f = inbox.shift(); f ? r(f) : waiters.push(r); });
  let id = 0;
  const request = async (method: string, params: unknown = {}) => {
    sock.write(encodeFrame({ id: String(++id), type: "request", method, params }));
    let frame = await next();
    while (frame.type === "event") frame = await next();   // skip pushed events, return the response
    return frame;
  };
  return { request, end: () => sock.end() };
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-dispdaemon-")); }

describe("dispatch — real socket RPC server", () => {
  it("dispatch into a project (team bound to a queue, mirroring team-chimera/q-chimera-bugs) pushes a task that DRAINS to done", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    // one worker turn that completes immediately — proves the scheduler actually
    // drained the pushed task, not just that dispatch returned a taskId.
    const scenarios: FakeStep[][] = [[{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "verified" } }]];
    const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend(scenarios)]]) });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);

    const path = makeDir();
    const qCreate = await c.request("queue.create", { spec: { name: "q-verify-bugs" } });
    expect(qCreate).toMatchObject({ ok: true });
    const teamCreate = await c.request("team.create", {
      spec: { name: "verify-team", roles: { "staff-engineer-1": { role: "blank", overrides: { cwd: path } } }, queue: "q-verify-bugs" },
    });
    expect(teamCreate).toMatchObject({ ok: true });
    const projectCreate = await c.request("project.create", {
      name: "verify-project", path, teams: ["verify-team"], queue: "q-verify-bugs", autoConductor: false,
    });
    expect(projectCreate).toMatchObject({ ok: true });

    const dispatched = await c.request("dispatch", { projectName: "verify-project", prompt: "verify dispatch drains", role: "staff-engineer-1" });
    expect(dispatched).toMatchObject({ ok: true, result: { via: "queue", target: "q-verify-bugs" } });
    const taskId = (dispatched as { result: { taskId: string } }).result.taskId;
    expect(taskId).toBeTruthy();

    // poll queue.status until the ephemeral worker (spawned by the scheduler's
    // own tick, triggered inside dispatch's queue.push) finishes the task
    const deadline = Date.now() + 5000;
    let state = "pending";
    while (state !== "done" && Date.now() < deadline) {
      const st = (await c.request("queue.status", { queue: "q-verify-bugs" })) as { result: { tasks: Array<{ taskId: string; state: string }> } };
      const task = st.result.tasks.find((t) => t.taskId === taskId);
      state = task?.state ?? "pending";
      if (state !== "done") await new Promise((r) => setTimeout(r, 20));
    }
    expect(state).toBe("done");

    c.end();
    await server.close();
  }, 15_000);
});
