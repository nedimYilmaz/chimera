import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// Bounded conditional loops (iterate-until gate): deterministic full-boot blackbox — real RPC
// over the real daemon socket (packages/daemon/src/server.ts), driven with a FakeAgentBackend,
// mirroring self-heal-blackbox.test.ts's/restart-recovery.test.ts's shape (every driving AND
// observing call goes through c.request(...), never reaching into engine internals).
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
  const request = async (method: string, params: unknown = {}): Promise<RpcResponse> => {
    sock.write(encodeFrame({ id: String(++id), type: "request", method, params }));
    let f = await next();
    while (f.type !== "response") f = await next();
    return f as RpcResponse;
  };
  return { request, end: () => sock.end() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error("condition not met before deadline");
    await sleep(20);
  }
}

describe("bounded conditional loops: daemon-level blackbox", () => {
  it("a loopBack edge with no fallback-defeating condition loops until its cap, then falls through the fallback edge — observable purely via RPC", async () => {
    // head -> work (unconditionally loops back to head — no `when`, so it always matches —
    // capped at maxIterations:2) -> falls through to done once the cap is exhausted.
    // 7 step-executions total: head, work×3 (2 loop-backs + the cap-discovery pass), head×2
    // more (one per loop-back), done. Same role throughout — one conductor session end to end.
    const steps: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }];
    for (let i = 0; i < 6; i++) { steps.push({ turn: {} }); steps.push({ awaitSend: true }); }
    steps.push({ end: { resultText: "loop finished over rpc" } });
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([steps])]]) });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);

    const wfCreate = await c.request("workflow.create", {
      spec: {
        name: "loop-wf",
        steps: [
          { id: "head", title: "head", gate: { kind: "none" }, role: "dev" },
          {
            id: "work", title: "work", gate: { kind: "none" }, role: "dev",
            next: [{ to: "head", loopBack: { maxIterations: 2 } }, { to: "done" }],
          },
          { id: "done", title: "done", gate: { kind: "none" }, role: "dev", next: [] },
        ],
      },
    });
    expect(wfCreate).toMatchObject({ ok: true });

    const qCreate = await c.request("queue.create", { spec: { name: "loop-q", workflow: "loop-wf" } });
    expect(qCreate).toMatchObject({ ok: true });
    const teamCreate = await c.request("team.create", {
      spec: { name: "loop-team", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "loop-q" },
    });
    expect(teamCreate).toMatchObject({ ok: true });

    const pushed = await c.request("queue.push", { queue: "loop-q", prompt: "converge over rpc" });
    expect(pushed).toMatchObject({ ok: true });
    const taskId = (pushed.result as { taskId: string }).taskId;

    type Task = { taskId: string; state: string; resultText: string | null; loopIterations: Record<string, number>; stepHistory: Array<{ stepId: string }> };
    const final = await until(
      async () => {
        const st = await c.request("queue.status", { queue: "loop-q" });
        return (st.result as { tasks: Task[] }).tasks.find((t) => t.taskId === taskId);
      },
      (t) => t !== undefined && t.state !== "pending" && t.state !== "in_progress" && t.state !== "blocked",
    );

    expect(final!.state).toBe("done");
    expect(final!.resultText).toBe("loop finished over rpc");
    expect(final!.loopIterations).toEqual({ work: 2 });
    expect(final!.stepHistory.filter((h) => h.stepId === "work")).toHaveLength(3);
    expect(final!.stepHistory.filter((h) => h.stepId === "head")).toHaveLength(3);
    expect(final!.stepHistory.filter((h) => h.stepId === "done")).toHaveLength(1);

    c.end();
    await server.close();
  }, 15_000);
});
